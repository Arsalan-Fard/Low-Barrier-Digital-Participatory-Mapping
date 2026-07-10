(function () {
  function createAnnotationPlacement(options) {
    var map = options.map;
    // Fired when an annotation is finalized (Enter / Place / external commit)
    // with the source tag id. Lets the caller propagate the placement back to
    // a paired phone controller so its textarea closes in sync.
    var onPlaced = typeof options.onPlaced === 'function' ? options.onPlaced : function () {};
    var moveThresholdPx = Number(options.moveThresholdPx || 14);
    var lostHoldMs = Number(options.lostHoldMs || 500);
    var rearmThresholdPx = Number(options.rearmThresholdPx || Math.max(moveThresholdPx, 18));
    var projectLngLatToPx = typeof options.projectLngLatToPx === 'function'
      ? options.projectLngLatToPx
      : function (lng, lat) {
        var point = map.project([lng, lat]);
        return { x: Number(point.x), y: Number(point.y) };
      };

    var enabled = false;
    // Map of tagId → active entry. Each entry: { sourceTagId, editIndex, inputEl,
    // marker, boxEl, angleDeg, lng, lat, tagSizePx, lastSeenMs }.
    var activeByTagId = {};
    var placed = []; // [{ tagId, text, lng, lat, angleDeg, marker, step }]
    var lastPlacedPxByTag = {};
    var currentStep = 0;
    var visibleSteps = null;
    var recolorByStep = null;

    var distanceSq = window.CompactUtil.distanceSq;   // shared helper (src/util.js)

    function parsePoint(raw) {
      if (!raw) return null;
      var lng = Number(raw.lng);
      var lat = Number(raw.lat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
      var angleDeg = Number(raw.angleDeg);
      if (!Number.isFinite(angleDeg)) angleDeg = 0;
      var tagSizePx = Number(raw.tagSizePx) || 28;
      return {
        lng: lng,
        lat: lat,
        angleDeg: angleDeg,
        tagSizePx: tagSizePx
      };
    }

    function setBoxRotation(boxEl, angleDeg) {
      if (!boxEl || !boxEl.style) return;
      boxEl.style.transform = 'rotate(' + String(Number(angleDeg) + 180) + 'deg)';
    }

    function tagAccentColor(tagId) {
      var assignments = window.CompactTagAssignments;
      if (!assignments || typeof assignments.getDrawColor !== 'function') return null;
      var color = assignments.getDrawColor(tagId);
      return color ? String(color) : null;
    }

    function textColorForBackground(hex) {
      var s = String(hex || '').trim();
      if (s.charAt(0) === '#') s = s.slice(1);
      if (s.length === 3) s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
      if (s.length !== 6) return '#ffffff';
      var r = parseInt(s.slice(0, 2), 16);
      var g = parseInt(s.slice(2, 4), 16);
      var b = parseInt(s.slice(4, 6), 16);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return '#ffffff';
      var luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      return luma < 0.5 ? '#ffffff' : '#111111';
    }

    function focusInput(inputEl) {
      if (!inputEl) return;
      try {
        inputEl.focus({ preventScroll: true });
      } catch (_err) {
        try { inputEl.focus(); } catch (_err2) {}
      }
    }

    function activeKeysSnapshot() {
      var keys = [];
      for (var k in activeByTagId) {
        if (Object.prototype.hasOwnProperty.call(activeByTagId, k)) keys.push(k);
      }
      return keys;
    }

    function removeActiveForTag(tagId) {
      var key = String(tagId);
      var entry = activeByTagId[key];
      if (!entry) return;
      if (entry.marker) entry.marker.remove();
      delete activeByTagId[key];
    }

    function removeAllActive() {
      var keys = activeKeysSnapshot();
      for (var i = 0; i < keys.length; i++) removeActiveForTag(keys[i]);
    }

    function setInputValue(inputEl, nextValue) {
      if (!inputEl) return;
      var value = String(nextValue || '');
      if (inputEl.value === value) return;
      var selectionStart = inputEl.selectionStart;
      var selectionEnd = inputEl.selectionEnd;
      inputEl.value = value;
      if (typeof inputEl.setSelectionRange === 'function' &&
          Number.isFinite(selectionStart) && Number.isFinite(selectionEnd)) {
        try {
          var maxLen = inputEl.value.length;
          inputEl.setSelectionRange(
            Math.min(selectionStart, maxLen),
            Math.min(selectionEnd, maxLen)
          );
        } catch (_err) {}
      }
      resizeAnnotationInput(inputEl);
    }

    function resizeAnnotationInput(inputEl) {
      if (!inputEl || !inputEl.style) return;
      var text = String(inputEl.value || inputEl.placeholder || '');
      var px = Math.max(160, Math.min(520, (text.length + 2) * 12 + 32));
      inputEl.style.width = String(px) + 'px';
    }

    // Drop the font size as text gets longer so the chip stays compact on a
    // transparent map background. Bucketed (not continuous) so chips don't
    // visually jitter while the user is editing the text live.
    function fontSizePxForAnnotation(rawText) {
      var len = String(rawText || '').length;
      if (len <= 30) return 20;
      if (len <= 60) return 16;
      if (len <= 120) return 14;
      return 12;
    }

    function applyAnnotationTextStyling(el, text) {
      if (!el) return;
      var rotor = el.querySelector('.tag-annotation-chip__rotor');
      var textEl = el.querySelector('.tag-annotation-chip__text');
      if (textEl) textEl.textContent = String(text || '');
      if (rotor) rotor.style.fontSize = String(fontSizePxForAnnotation(text)) + 'px';
      el.title = String(text || '');
    }

    function updatePlacedMarker(item) {
      if (!item || !item.marker) return;
      item.marker.setLngLat([item.lng, item.lat]);
      var el = item.marker.getElement ? item.marker.getElement() : null;
      if (el) {
        applyAnnotationTextStyling(el, String(item.text || ''));
        var rotor = el.querySelector('.tag-annotation-chip__rotor');
        setBoxRotation(rotor || el, Number(item.angleDeg || 0));
      }
    }

    function createPlacedAnnotationEl(text) {
      var el = document.createElement('div');
      el.className = 'tag-annotation-chip';
      var rotor = document.createElement('div');
      rotor.className = 'tag-annotation-chip__rotor';
      var textEl = document.createElement('span');
      textEl.className = 'tag-annotation-chip__text';
      rotor.appendChild(textEl);
      el.appendChild(rotor);
      applyAnnotationTextStyling(el, text);
      return el;
    }

    function placeActiveForTag(tagId) {
      var key = String(tagId);
      var entry = activeByTagId[key];
      if (!entry) return false;
      var text = String(entry.inputEl.value || '').trim();
      if (!text) return false;
      if (text.length > 220) text = text.slice(0, 220);

      if (Number.isInteger(entry.editIndex) && entry.editIndex >= 0) {
        var existing = placed[entry.editIndex];
        if (!existing) return false;
        existing.text = text;
        existing.angleDeg = Number(entry.angleDeg || existing.angleDeg || 0);
        updatePlacedMarker(existing);
        var editSourceTagId = entry.sourceTagId;
        removeActiveForTag(key);
        onPlaced(editSourceTagId);
        return true;
      }

      var lng = Number(entry.lng);
      var lat = Number(entry.lat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        var markerLngLat = entry.marker.getLngLat();
        lng = Number(markerLngLat.lng);
        lat = Number(markerLngLat.lat);
      }
      // Placed chip shares the same anchor rule as the live textbox:
      // center-bottom of the element sits on the detected tag point.
      var placedLngLat = [lng, lat];
      var el = createPlacedAnnotationEl(text);
      var rotor = el.querySelector('.tag-annotation-chip__rotor');
      setBoxRotation(rotor || el, Number(entry.angleDeg || 0));

      var placedMarker = new mapboxgl.Marker({ element: el, anchor: 'bottom', offset: [0, 0] })
        .setLngLat(placedLngLat)
        .addTo(map);

      var sourcePx = projectLngLatToPx(lng, lat);
      lastPlacedPxByTag[String(entry.sourceTagId)] = { x: sourcePx.x, y: sourcePx.y };
      var stepForItem = Number(currentStep) || 0;
      var item = {
        tagId: String(entry.sourceTagId),
        text: text,
        lng: Number(placedLngLat[0]),
        lat: Number(placedLngLat[1]),
        angleDeg: Number(entry.angleDeg || 0),
        marker: placedMarker,
        step: stepForItem
      };
      applyItemAppearance(item);
      placed.push(item);

      var newSourceTagId = entry.sourceTagId;
      removeActiveForTag(key);
      onPlaced(newSourceTagId);
      return true;
    }

    function shouldArm(tagId, point) {
      var last = lastPlacedPxByTag[String(tagId)];
      if (!last) return true;
      var px = projectLngLatToPx(point.lng, point.lat);
      return distanceSq(last, px) >= (rearmThresholdPx * rearmThresholdPx);
    }

    function createActive(tagId, point, nowMs, initialText, editIndex, markerLngLatOverride) {
      var key = String(tagId);
      // If one already exists for this tag, remove it first.
      if (activeByTagId[key]) removeActiveForTag(key);

      var wrap = document.createElement('div');
      wrap.className = 'tag-annotation-live';
      var box = document.createElement('div');
      box.className = 'tag-annotation-live__box';
      wrap.appendChild(box);

      var input = document.createElement('textarea');
      input.className = 'tag-annotation-input';
      input.placeholder = 'Enter your note...';
      input.maxLength = 220;
      input.rows = 1;
      input.wrap = 'off';
      input.value = String(initialText || '');
      var accent = tagAccentColor(tagId);
      if (accent) {
        var fg = textColorForBackground(accent);
        input.style.background = accent;
        input.style.color = fg;
        input.style.setProperty('--annotation-placeholder', fg === '#ffffff' ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)');
      }
      resizeAnnotationInput(input);
      box.appendChild(input);
      setBoxRotation(box, Number(point.angleDeg || 0));
      // Center-bottom of the textbox sits on the detected tag point.
      // No sideways offset — the tag is visually under the textarea's bottom edge.
      var markerLngLat = markerLngLatOverride || [Number(point.lng), Number(point.lat)];

      var marker = new mapboxgl.Marker({ element: wrap, anchor: 'bottom', offset: [0, 0] })
        .setLngLat(markerLngLat)
        .addTo(map);

      var entry = {
        sourceTagId: key,
        marker: marker,
        lng: point.lng,
        lat: point.lat,
        inputEl: input,
        boxEl: box,
        editIndex: Number.isInteger(editIndex) ? editIndex : null,
        angleDeg: Number(point.angleDeg || 0),
        tagSizePx: Number(point.tagSizePx || 28),
        lastSeenMs: nowMs
      };
      activeByTagId[key] = entry;

      input.addEventListener('input', function () {
        resizeAnnotationInput(input);
      });

      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          placeActiveForTag(key);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          removeActiveForTag(key);
          return;
        }
        // Don't let global shortcuts fire while typing.
        e.stopPropagation();
      });

      // Focus the most recently created input. Other inputs retain their own
      // state — if the user had focus elsewhere, they keep it (we don't steal).
      setTimeout(function () {
        if (activeByTagId[key] && activeByTagId[key].inputEl === input) {
          focusInput(input);
        }
      }, 0);
    }

    function beginEditPlaced(index, sourceTagId, nowMs) {
      var item = placed[index];
      if (!item) return null;
      var key = String(sourceTagId);
      var existingEntry = activeByTagId[key];

      if (existingEntry &&
          Number.isInteger(existingEntry.editIndex) &&
          existingEntry.editIndex === index) {
        existingEntry.lastSeenMs = Number(nowMs) || Date.now();
        existingEntry.lng = Number(item.lng);
        existingEntry.lat = Number(item.lat);
        existingEntry.angleDeg = Number(item.angleDeg || 0);
        existingEntry.marker.setLngLat([item.lng, item.lat]);
        setBoxRotation(existingEntry.boxEl, existingEntry.angleDeg);
        return {
          index: index,
          tagId: String(item.tagId || sourceTagId),
          text: String(item.text || ''),
          lng: Number(item.lng),
          lat: Number(item.lat)
        };
      }

      // Replace only this tag's active entry (others keep typing).
      removeActiveForTag(key);
      createActive(
        sourceTagId,
        {
          lng: Number(item.lng),
          lat: Number(item.lat),
          angleDeg: Number(item.angleDeg || 0),
          tagSizePx: 28
        },
        nowMs,
        item.text || '',
        index,
        [Number(item.lng), Number(item.lat)]
      );
      return {
        index: index,
        tagId: String(item.tagId || sourceTagId),
        text: String(item.text || ''),
        lng: Number(item.lng),
        lat: Number(item.lat)
      };
    }

    function syncExternalText(sourceTagId, text) {
      var entry = activeByTagId[String(sourceTagId)];
      if (!entry) return false;
      setInputValue(entry.inputEl, String(text || ''));
      return true;
    }

    function commitExternal(sourceTagId) {
      var key = String(sourceTagId);
      if (!activeByTagId[key]) return false;
      return placeActiveForTag(key);
    }

    // Commit every active textarea that has text. Used before saving so
    // in-progress annotations (not yet confirmed with Enter / Place) still
    // land in the exported GeoJSON.
    function commitAllActive() {
      var keys = activeKeysSnapshot();
      var placedCount = 0;
      for (var i = 0; i < keys.length; i++) {
        if (placeActiveForTag(keys[i])) placedCount++;
      }
      return placedCount;
    }

    function setEnabled(nextEnabled) {
      enabled = !!nextEnabled;
      if (!enabled) removeAllActive();
    }

    function update(pointsByTagId, nowMs, maybeEnabled) {
      if (typeof maybeEnabled === 'boolean') setEnabled(maybeEnabled);
      if (!enabled) return;

      var points = pointsByTagId || {};

      // Per-tag: track each tag independently. Spawn an active for any tag
      // whose point we see (and it's armed + not already active). Refresh
      // position for any already-active tag we see this frame.
      var seenThisFrame = {};
      for (var key in points) {
        if (!Object.prototype.hasOwnProperty.call(points, key)) continue;
        var parsed = parsePoint(points[key]);
        if (!parsed) continue;
        seenThisFrame[String(key)] = parsed;

        var entry = activeByTagId[String(key)];
        if (entry) {
          // Don't move in edit mode (we're editing an existing placed marker).
          if (Number.isInteger(entry.editIndex) && entry.editIndex >= 0) {
            entry.lastSeenMs = nowMs;
            continue;
          }
          entry.lastSeenMs = nowMs;
          entry.lng = parsed.lng;
          entry.lat = parsed.lat;
          entry.angleDeg = Number(parsed.angleDeg || 0);
          entry.tagSizePx = Number(parsed.tagSizePx || 28);
          setBoxRotation(entry.boxEl, entry.angleDeg);
          entry.marker.setLngLat([parsed.lng, parsed.lat]);
          continue;
        }

        if (!shouldArm(key, parsed)) continue;
        createActive(key, parsed, nowMs);
      }

      // Expire entries whose tag hasn't been seen this frame AND input is empty
      // AND lostHoldMs elapsed. Tags in edit mode persist indefinitely.
      var keys = activeKeysSnapshot();
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (seenThisFrame[k]) continue;
        var e = activeByTagId[k];
        if (!e) continue;
        if (Number.isInteger(e.editIndex) && e.editIndex >= 0) continue;
        var hasText = String(e.inputEl.value || '').trim().length > 0;
        if (hasText) continue;
        if ((nowMs - Number(e.lastSeenMs || 0)) > lostHoldMs) {
          removeActiveForTag(k);
        }
      }
    }

    function effectiveAccentForItem(item) {
      if (!item) return null;
      if (recolorByStep) {
        var key = String(Number(item.step) || 0);
        if (Object.prototype.hasOwnProperty.call(recolorByStep, key)) {
          return String(recolorByStep[key]);
        }
      }
      return tagAccentColor(item.tagId);
    }

    function applyChipAccent(el, accent) {
      if (!el) return;
      var icon = el.querySelector('.tag-annotation-chip__icon');
      var textEl = el.querySelector('.tag-annotation-chip__text');
      if (accent) {
        el.style.color = accent;
        el.style.background = 'transparent';
        if (textEl) textEl.style.color = accent;
        if (icon) {
          icon.style.background = accent;
          icon.style.borderColor = textColorForBackground(accent);
          icon.style.color = textColorForBackground(accent);
        }
      } else {
        el.style.color = '';
        el.style.background = '';
        if (textEl) textEl.style.color = '';
        if (icon) {
          icon.style.background = '';
          icon.style.borderColor = '';
          icon.style.color = '';
        }
      }
    }

    function applyItemAppearance(item) {
      if (!item || !item.marker) return;
      var el = item.marker.getElement ? item.marker.getElement() : null;
      if (!el) return;
      var shouldShow = !visibleSteps || visibleSteps.has(Number(item.step) || 0);
      el.style.display = shouldShow ? '' : 'none';
      applyChipAccent(el, effectiveAccentForItem(item));
    }

    function refreshAllVisibility() {
      for (var i = 0; i < placed.length; i++) applyItemAppearance(placed[i]);
    }

    function setCurrentStep(stepNumber) {
      currentStep = Number(stepNumber) || 0;
    }

    function setVisibleSteps(steps) {
      if (!steps) {
        visibleSteps = null;
      } else if (steps instanceof Set) {
        visibleSteps = steps;
      } else if (Array.isArray(steps)) {
        visibleSteps = new Set(steps.map(function (n) { return Number(n) || 0; }));
      } else {
        visibleSteps = null;
      }
      refreshAllVisibility();
    }

    function setRecolorByStep(stepColorMap) {
      if (!stepColorMap || typeof stepColorMap !== 'object') {
        recolorByStep = null;
      } else {
        var clean = {};
        for (var key in stepColorMap) {
          if (!Object.prototype.hasOwnProperty.call(stepColorMap, key)) continue;
          var stepNum = Number(key);
          if (!Number.isFinite(stepNum)) continue;
          clean[String(stepNum)] = String(stepColorMap[key]);
        }
        recolorByStep = clean;
      }
      refreshAllVisibility();
    }

    function setPlacedVisible(visible) {
      if (visible) {
        visibleSteps = null;
      } else {
        visibleSteps = new Set();
      }
      refreshAllVisibility();
    }

    function getPlacedByStep(stepNumber) {
      var target = Number(stepNumber) || 0;
      var results = [];
      for (var i = 0; i < placed.length; i++) {
        var p = placed[i];
        if (!p) continue;
        if ((Number(p.step) || 0) === target) {
          results.push({
            tagId: String(p.tagId),
            text: String(p.text || ''),
            lng: Number(p.lng),
            lat: Number(p.lat),
            step: Number(p.step) || 0
          });
        }
      }
      return results;
    }

    function getPlacedGeoJSON() {
      var features = [];
      for (var i = 0; i < placed.length; i++) {
        var p = placed[i];
        features.push({
          type: 'Feature',
          properties: {
            sourceType: 'annotation',
            tagId: p.tagId,
            text: p.text,
            step: Number(p.step) || 0
          },
          geometry: {
            type: 'Point',
            coordinates: [p.lng, p.lat]
          }
        });
      }
      return { type: 'FeatureCollection', features: features };
    }

    function clearAll() {
      removeAllActive();
      for (var i = 0; i < placed.length; i++) {
        if (placed[i] && placed[i].marker) placed[i].marker.remove();
      }
      placed = [];
      lastPlacedPxByTag = {};
    }

    // Rehydrate placed annotations from a GeoJSON FeatureCollection produced by
    // getPlacedGeoJSON() (or compatible shape). Replaces any existing placed
    // markers. Used when resuming a workshop from a saved session.
    function loadPlacedAnnotations(fc) {
      // Tear down anything currently on the map first.
      for (var i = 0; i < placed.length; i++) {
        if (placed[i] && placed[i].marker) placed[i].marker.remove();
      }
      placed = [];
      lastPlacedPxByTag = {};

      var features = (fc && Array.isArray(fc.features)) ? fc.features : [];
      for (var j = 0; j < features.length; j++) {
        var feat = features[j];
        if (!feat || !feat.geometry) continue;
        if (feat.geometry.type !== 'Point') continue;
        var coords = feat.geometry.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) continue;
        var lng = Number(coords[0]);
        var lat = Number(coords[1]);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        var props = feat.properties || {};
        var text = String(props.text || '');
        var tagId = String(props.tagId || '');
        var step = Number(props.step) || 0;
        var angleDeg = Number(props.angleDeg) || 0;

        var el = createPlacedAnnotationEl(text);
        var rotor = el.querySelector('.tag-annotation-chip__rotor');
        setBoxRotation(rotor || el, angleDeg);

        var marker = new mapboxgl.Marker({ element: el, anchor: 'bottom', offset: [0, 0] })
          .setLngLat([lng, lat])
          .addTo(map);

        var item = {
          tagId: tagId,
          text: text,
          lng: lng,
          lat: lat,
          angleDeg: angleDeg,
          marker: marker,
          step: step
        };
        applyItemAppearance(item);
        placed.push(item);
      }
      return placed.length;
    }

    function isItemVisible(item) {
      if (!item) return false;
      return !visibleSteps || visibleSteps.has(Number(item.step) || 0);
    }

    function isPlacedVisible(index) {
      return isItemVisible(placed[index]);
    }

    function findNearestPlaced(lng, lat, maxDistancePx) {
      var selectorPx = projectLngLatToPx(lng, lat);
      var maxDistSq = Number(maxDistancePx) * Number(maxDistancePx);
      var best = null;

      for (var i = 0; i < placed.length; i++) {
        var item = placed[i];
        if (!item) continue;
        if (!isItemVisible(item)) continue;
        var itemPx = projectLngLatToPx(item.lng, item.lat);
        var distSq = distanceSq(selectorPx, itemPx);
        if (!Number.isFinite(distSq) || distSq > maxDistSq) continue;
        if (!best || distSq < best.distanceSq) {
          best = { index: i, distanceSq: distSq };
        }
      }

      return best;
    }

    function movePlaced(index, lng, lat) {
      var item = placed[index];
      if (!item || !item.marker) return false;
      item.lng = Number(lng);
      item.lat = Number(lat);
      updatePlacedMarker(item);
      // If any active entry is editing this placed index, keep its marker in sync.
      for (var key in activeByTagId) {
        if (!Object.prototype.hasOwnProperty.call(activeByTagId, key)) continue;
        var entry = activeByTagId[key];
        if (Number.isInteger(entry.editIndex) && entry.editIndex === index && entry.marker) {
          entry.lng = item.lng;
          entry.lat = item.lat;
          entry.marker.setLngLat([item.lng, item.lat]);
        }
      }
      return true;
    }

    return {
      setEnabled: setEnabled,
      update: update,
      getPlacedGeoJSON: getPlacedGeoJSON,
      clearAll: clearAll,
      findNearestPlaced: findNearestPlaced,
      movePlaced: movePlaced,
      beginEditPlaced: beginEditPlaced,
      syncExternalText: syncExternalText,
      commitExternal: commitExternal,
      commitAllActive: commitAllActive,
      clearActiveForTag: function (tagId) { removeActiveForTag(tagId); },
      setCurrentStep: setCurrentStep,
      setVisibleSteps: setVisibleSteps,
      setRecolorByStep: setRecolorByStep,
      setPlacedVisible: setPlacedVisible,
      getPlacedByStep: getPlacedByStep,
      isPlacedVisible: isPlacedVisible,
      loadPlacedAnnotations: loadPlacedAnnotations
    };
  }

  window.CompactAnnotationPlacement = { createAnnotationPlacement: createAnnotationPlacement };
})();
