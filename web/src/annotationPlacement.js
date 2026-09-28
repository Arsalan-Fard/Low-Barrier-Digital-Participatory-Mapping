(function () {
  function createAnnotationPlacement(options) {
    var map = options.map;
    var moveThresholdPx = Number(options.moveThresholdPx || 14);
    var lostHoldMs = Number(options.lostHoldMs || 500);
    var rearmThresholdPx = Number(options.rearmThresholdPx || Math.max(moveThresholdPx, 18));
    var projectLngLatToPx = options.projectLngLatToPx;
    var distanceSq = window.CompactUtil.distanceSq;

    var enabled = false;
    var activeByTagId = {}; // tagId -> the open textbox of that tag
    var placed = [];
    var lastPlacedPxByTag = {};
    var currentStep = 0;
    var visibleSteps = null;

    function parsePoint(raw) {
      var lng = Number(raw.lng);
      var lat = Number(raw.lat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
      var angleDeg = Number(raw.angleDeg);
      return { lng: lng, lat: lat, angleDeg: Number.isFinite(angleDeg) ? angleDeg : 0 };
    }

    function setBoxRotation(boxEl, angleDeg) {
      boxEl.style.transform = 'rotate(' + (angleDeg + 180) + 'deg)';
    }

    function tagAccentColor(tagId) {
      return window.CompactTagAssignments.getDrawColor(tagId);
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

    function removeActiveForTag(tagId) {
      var key = String(tagId);
      var entry = activeByTagId[key];
      if (!entry) return;
      entry.marker.remove();
      delete activeByTagId[key];
    }

    function removeAllActive() {
      Object.keys(activeByTagId).forEach(removeActiveForTag);
    }

    function resizeAnnotationInput(inputEl) {
      var text = String(inputEl.value || inputEl.placeholder || '');
      var px = Math.max(160, Math.min(520, (text.length + 2) * 12 + 32));
      inputEl.style.width = px + 'px';
    }

    // Bucketed, so a chip does not jitter in size while its text is edited live.
    function fontSizePxForAnnotation(text) {
      var len = text.length;
      if (len <= 30) return 20;
      if (len <= 60) return 16;
      if (len <= 120) return 14;
      return 12;
    }

    function applyAnnotationTextStyling(el, text) {
      el.querySelector('.tag-annotation-chip__text').textContent = text;
      el.querySelector('.tag-annotation-chip__rotor').style.fontSize = fontSizePxForAnnotation(text) + 'px';
      el.title = text;
    }

    function updatePlacedMarker(item) {
      item.marker.setLngLat([item.lng, item.lat]);
      var el = item.marker.getElement();
      applyAnnotationTextStyling(el, item.text);
      setBoxRotation(el.querySelector('.tag-annotation-chip__rotor'), item.angleDeg);
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
      var text = String(entry.inputEl.value || '').trim().slice(0, 220);
      if (!text) return false;

      if (entry.editIndex !== null) {
        var existing = placed[entry.editIndex];
        if (!existing) return false;
        existing.text = text;
        existing.angleDeg = Number(entry.angleDeg || existing.angleDeg || 0);
        updatePlacedMarker(existing);
      } else {
        // Like the live textbox, the chip's bottom centre sits on the tag.
        var el = createPlacedAnnotationEl(text);
        setBoxRotation(el.querySelector('.tag-annotation-chip__rotor'), entry.angleDeg);
        var marker = new mapboxgl.Marker({ element: el, anchor: 'bottom', offset: [0, 0] })
          .setLngLat([entry.lng, entry.lat])
          .addTo(map);
        var sourcePx = projectLngLatToPx(entry.lng, entry.lat);
        lastPlacedPxByTag[entry.sourceTagId] = { x: sourcePx.x, y: sourcePx.y };
        var item = {
          tagId: entry.sourceTagId,
          text: text,
          lng: entry.lng,
          lat: entry.lat,
          angleDeg: entry.angleDeg,
          marker: marker,
          step: currentStep
        };
        applyItemAppearance(item);
        placed.push(item);
      }
      removeActiveForTag(key);
      return true;
    }

    function shouldArm(key, point) {
      var last = lastPlacedPxByTag[key];
      if (!last) return true;
      return distanceSq(last, projectLngLatToPx(point.lng, point.lat)) >= (rearmThresholdPx * rearmThresholdPx);
    }

    function createActive(tagId, point, nowMs, initialText, editIndex) {
      var key = String(tagId);
      removeActiveForTag(key);

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
      setBoxRotation(box, point.angleDeg);

      // The textbox's bottom centre sits on the tag.
      var marker = new mapboxgl.Marker({ element: wrap, anchor: 'bottom', offset: [0, 0] })
        .setLngLat([point.lng, point.lat])
        .addTo(map);

      activeByTagId[key] = {
        sourceTagId: key,
        marker: marker,
        lng: point.lng,
        lat: point.lat,
        inputEl: input,
        boxEl: box,
        editIndex: Number.isInteger(editIndex) ? editIndex : null,
        angleDeg: point.angleDeg,
        lastSeenMs: nowMs
      };

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
        // Keep the page's keyboard shortcuts from firing while typing.
        e.stopPropagation();
      });

      // Focus the newest textbox, unless another has replaced it meanwhile.
      setTimeout(function () {
        if (activeByTagId[key] && activeByTagId[key].inputEl === input) input.focus({ preventScroll: true });
      }, 0);
    }

    function beginEditPlaced(index, sourceTagId, nowMs) {
      var item = placed[index];
      if (!item) return null;
      var key = String(sourceTagId);
      var entry = activeByTagId[key];
      if (entry && entry.editIndex === index) {
        entry.lastSeenMs = Number(nowMs) || Date.now();
        entry.lng = item.lng;
        entry.lat = item.lat;
        entry.angleDeg = Number(item.angleDeg || 0);
        entry.marker.setLngLat([item.lng, item.lat]);
        setBoxRotation(entry.boxEl, entry.angleDeg);
      } else {
        createActive(key, { lng: item.lng, lat: item.lat, angleDeg: Number(item.angleDeg || 0) }, nowMs, item.text, index);
      }
      return { index: index, tagId: item.tagId, text: item.text, lng: item.lng, lat: item.lat };
    }

    // Saving places every textbox that holds text, so notes not yet confirmed are kept.
    function commitAllActive() {
      Object.keys(activeByTagId).forEach(placeActiveForTag);
    }

    function setEnabled(nextEnabled) {
      enabled = !!nextEnabled;
      if (!enabled) removeAllActive();
    }

    function update(pointsByTagId, nowMs, maybeEnabled) {
      if (typeof maybeEnabled === 'boolean') setEnabled(maybeEnabled);
      if (!enabled) return;

      var seen = {};
      for (var key in pointsByTagId) {
        var parsed = parsePoint(pointsByTagId[key]);
        if (!parsed) continue;
        seen[key] = true;
        var entry = activeByTagId[key];
        if (!entry) {
          if (shouldArm(key, parsed)) createActive(key, parsed, nowMs);
          continue;
        }
        entry.lastSeenMs = nowMs;
        // A textbox editing a placed chip stays on the chip.
        if (entry.editIndex !== null) continue;
        entry.lng = parsed.lng;
        entry.lat = parsed.lat;
        entry.angleDeg = parsed.angleDeg;
        setBoxRotation(entry.boxEl, entry.angleDeg);
        entry.marker.setLngLat([parsed.lng, parsed.lat]);
      }

      // An unseen textbox closes after lostHoldMs, unless it holds text or edits a chip.
      for (var openKey in activeByTagId) {
        var open = activeByTagId[openKey];
        if (seen[openKey] || open.editIndex !== null || open.inputEl.value.trim()) continue;
        if ((nowMs - open.lastSeenMs) > lostHoldMs) removeActiveForTag(openKey);
      }
    }

    function applyChipAccent(el, accent) {
      el.style.color = accent || '';
      el.style.background = accent ? 'transparent' : '';
      el.querySelector('.tag-annotation-chip__text').style.color = accent || '';
    }

    function isItemVisible(item) {
      if (!item) return false;
      return !visibleSteps || visibleSteps.has(item.step);
    }

    function applyItemAppearance(item) {
      var el = item.marker.getElement();
      el.style.display = isItemVisible(item) ? '' : 'none';
      applyChipAccent(el, tagAccentColor(item.tagId));
    }

    function setCurrentStep(stepNumber) {
      currentStep = Number(stepNumber) || 0;
    }

    // steps: a Set of step numbers, or null for all.
    function setVisibleSteps(steps) {
      visibleSteps = steps || null;
      placed.forEach(applyItemAppearance);
    }

    function getPlacedGeoJSON() {
      return {
        type: 'FeatureCollection',
        features: placed.map(function (p) {
          return {
            type: 'Feature',
            properties: { sourceType: 'annotation', tagId: p.tagId, text: p.text, step: p.step },
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] }
          };
        })
      };
    }

    function clearAll() {
      removeAllActive();
      placed.forEach(function (item) { item.marker.remove(); });
      placed = [];
      lastPlacedPxByTag = {};
    }

    function isPlacedVisible(index) {
      return isItemVisible(placed[index]);
    }

    function findNearestPlaced(lng, lat, maxDistancePx) {
      var selectorPx = projectLngLatToPx(lng, lat);
      var maxDistSq = maxDistancePx * maxDistancePx;
      var best = null;
      placed.forEach(function (item, index) {
        if (!isItemVisible(item)) return;
        var distSq = distanceSq(selectorPx, projectLngLatToPx(item.lng, item.lat));
        if (!Number.isFinite(distSq) || distSq > maxDistSq) return;
        if (!best || distSq < best.distanceSq) best = { index: index, distanceSq: distSq };
      });
      return best;
    }

    function movePlaced(index, lng, lat) {
      var item = placed[index];
      if (!item) return false;
      item.lng = Number(lng);
      item.lat = Number(lat);
      updatePlacedMarker(item);
      // A textbox editing this chip moves with it.
      for (var key in activeByTagId) {
        var entry = activeByTagId[key];
        if (entry.editIndex === index) {
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
      commitAllActive: commitAllActive,
      setCurrentStep: setCurrentStep,
      setVisibleSteps: setVisibleSteps,
      isPlacedVisible: isPlacedVisible
    };
  }

  window.CompactAnnotationPlacement = { createAnnotationPlacement: createAnnotationPlacement };
})();
