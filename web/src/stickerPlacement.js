(function () {
  function createStickerPlacement(options) {
    var map = options.map;
    var holdMs = Number(options.holdMs || 2000);
    var lostHoldMs = Number(options.lostHoldMs || 500);
    var moveThresholdPx = Number(options.moveThresholdPx || 14);
    var rearmThresholdPx = Number(options.rearmThresholdPx || Math.max(moveThresholdPx + 6, 20));
    var suppressPlaceNearPlacedPx = Number(options.suppressPlaceNearPlacedPx || 0);
    var commentDraftVisibleMs = Number(options.commentDraftVisibleMs || 2000);
    var commentDraftFadeMs = Number(options.commentDraftFadeMs || 3000);
    var projectLngLatToPx = typeof options.projectLngLatToPx === 'function'
      ? options.projectLngLatToPx
      : function (lng, lat) {
        var point = map.project([lng, lat]);
        return { x: Number(point.x), y: Number(point.y) };
      };

    var enabled = false;
    var runtimeByTag = {}; // tagId -> { marker, el, dwellStartMs, lastSeenMs, anchorPx, color }
    var placed = []; // [{ tagId, lng, lat, color, step, marker }]
    var lastPlacedPxByTag = {};
    var currentStep = 0;
    var visibleSteps = null;     // null = all visible
    var recolorByStep = null;    // null = original colors

    var distanceSq = window.CompactUtil.distanceSq;   // shared helper (src/util.js)

    function parsePoint(raw) {
      if (!raw) return null;
      var lng = Number(raw.lng);
      var lat = Number(raw.lat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
      var color = String(raw.color || '#ff5b5b');
      var tagSizePx = Number(raw.tagSizePx) || 28;
      return { lng: lng, lat: lat, color: color, tagSizePx: tagSizePx };
    }

    function toPx(lng, lat) {
      return projectLngLatToPx(lng, lat);
    }

    function setStickerColor(el, color) {
      if (!el || !el.style) return;
      el.style.setProperty('--sticker-color', String(color || '#ff5b5b'));
    }

    function textColorForBackground(hex) {
      var raw = String(hex || '').replace('#', '').trim();
      if (raw.length === 3) {
        raw = raw.split('').map(function (ch) { return ch + ch; }).join('');
      }
      if (!/^[0-9a-f]{6}$/i.test(raw)) return '#111111';
      var r = parseInt(raw.slice(0, 2), 16);
      var g = parseInt(raw.slice(2, 4), 16);
      var b = parseInt(raw.slice(4, 6), 16);
      var luminance = ((r * 299) + (g * 587) + (b * 114)) / 1000;
      return luminance >= 150 ? '#111111' : '#ffffff';
    }

    function ensureCommentDraft(item) {
      if (!item || !item.el) return null;
      var draft = item.el.querySelector('.sticker-comment-editor');
      if (draft) return draft;

      draft = document.createElement('div');
      draft.className = 'sticker-comment-editor tag-annotation-live';
      var box = document.createElement('div');
      box.className = 'tag-annotation-live__box';
      var input = document.createElement('textarea');
      input.className = 'tag-annotation-input sticker-comment-editor__field';
      input.placeholder = 'Comment...';
      input.maxLength = 220;
      input.rows = 1;
      input.wrap = 'off';
      input.readOnly = true;
      box.appendChild(input);
      draft.appendChild(box);
      item.el.appendChild(draft);
      return draft;
    }

    function ensurePlacedCommentText(item) {
      if (!item || !item.el) return null;
      var chip = item.el.querySelector('.sticker-comment-placed');
      if (chip) return chip;

      chip = document.createElement('div');
      chip.className = 'sticker-comment-placed tag-annotation-chip';
      var rotor = document.createElement('div');
      rotor.className = 'tag-annotation-chip__rotor';
      var text = document.createElement('span');
      text.className = 'tag-annotation-chip__text';
      rotor.appendChild(text);
      chip.appendChild(rotor);
      item.el.appendChild(chip);
      return chip;
    }

    function clearCommentDraftTimers(item) {
      if (!item) return;
      if (item.commentDraftFadeTimer) {
        window.clearTimeout(item.commentDraftFadeTimer);
        item.commentDraftFadeTimer = 0;
      }
      if (item.commentDraftRemoveTimer) {
        window.clearTimeout(item.commentDraftRemoveTimer);
        item.commentDraftRemoveTimer = 0;
      }
    }

    function resizeCommentDraft(draft) {
      if (!draft) return;
      var textEl = draft.querySelector('.sticker-comment-editor__field');
      if (!textEl || !textEl.style) return;
      var text = String(textEl.value || textEl.placeholder || 'Comment...');
      var px = Math.max(160, Math.min(520, (text.length + 2) * 12 + 32));
      textEl.style.width = String(px) + 'px';
    }

    function isCommentDraftVisible(item) {
      if (!item || !item.el) return false;
      var draft = item.el.querySelector('.sticker-comment-editor');
      return !!(draft && draft.classList.contains('visible'));
    }

    function fontSizePxForComment(rawText) {
      var len = String(rawText || '').length;
      if (len <= 30) return 20;
      if (len <= 60) return 16;
      if (len <= 120) return 14;
      return 12;
    }

    function updatePlacedCommentText(item) {
      if (!item || !item.el) return;
      var clean = String(item.commentText || '').trim();
      var existing = item.el.querySelector('.sticker-comment-placed');
      if (!item.commented || !clean) {
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        return;
      }

      var chip = ensurePlacedCommentText(item);
      if (!chip) return;
      var textEl = chip.querySelector('.tag-annotation-chip__text');
      var rotor = chip.querySelector('.tag-annotation-chip__rotor');
      if (textEl) textEl.textContent = clean;
      if (rotor) rotor.style.fontSize = String(fontSizePxForComment(clean)) + 'px';
      var color = effectiveColorForItem(item) || item.color || '#ff5b5b';
      chip.style.color = color;
      chip.title = clean;
      chip.style.display = isCommentDraftVisible(item) ? 'none' : '';
    }

    function setCommentDraftText(item, text) {
      var draft = ensureCommentDraft(item);
      if (!draft) return null;
      var textEl = draft.querySelector('.sticker-comment-editor__field');
      var clean = String(text || '').trim();
      if (textEl && textEl.value !== clean) textEl.value = clean;
      draft.classList.toggle('is-empty', !clean);
      var color = effectiveColorForItem(item) || item.color || '#ff5b5b';
      if (textEl && textEl.style) {
        var fg = textColorForBackground(color);
        textEl.style.background = color;
        textEl.style.color = fg;
        textEl.style.borderColor = fg === '#ffffff' ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.28)';
        textEl.style.setProperty('--annotation-placeholder', fg === '#ffffff' ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)');
      }
      resizeCommentDraft(draft);
      return draft;
    }

    function showCommentDraft(item, text) {
      var draft = setCommentDraftText(item, text);
      if (!draft) return false;
      clearCommentDraftTimers(item);
      draft.classList.remove('fading');
      draft.classList.add('visible');
      updatePlacedCommentText(item);
      item.commentDraftFadeTimer = window.setTimeout(function () {
        draft.classList.add('fading');
      }, commentDraftVisibleMs);
      item.commentDraftRemoveTimer = window.setTimeout(function () {
        draft.classList.remove('visible');
        draft.classList.remove('fading');
        updatePlacedCommentText(item);
      }, commentDraftVisibleMs + commentDraftFadeMs);
      return true;
    }

    function hideCommentDraft(item) {
      if (!item || !item.el) return false;
      clearCommentDraftTimers(item);
      var draft = item.el.querySelector('.sticker-comment-editor');
      if (draft) {
        draft.classList.remove('visible');
        draft.classList.remove('fading');
      }
      updatePlacedCommentText(item);
      return true;
    }

    function removeRuntime(tagId) {
      var key = String(tagId);
      var r = runtimeByTag[key];
      if (!r) return;
      if (r.marker) r.marker.remove();
      delete runtimeByTag[key];
    }

    function clearRuntime() {
      for (var key in runtimeByTag) {
        if (!Object.prototype.hasOwnProperty.call(runtimeByTag, key)) continue;
        removeRuntime(key);
      }
    }

    // Ring geometry — larger than the 28px dot so the progress arc reads
    // clearly outside the sticker's border.
    var RING_RADIUS = 22;
    var RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
    var RING_FILL_START_MS = 500; // start showing the ring once the user has held this long
    var RING_FILL_END_MS = 2000;  // ring is full when this much hold has passed (matches holdMs)

    function buildProgressRingSvg() {
      var svgNs = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(svgNs, 'svg');
      svg.setAttribute('class', 'tag-sticker-progress');
      svg.setAttribute('width', '52');
      svg.setAttribute('height', '52');
      svg.setAttribute('viewBox', '-26 -26 52 52');

      var bg = document.createElementNS(svgNs, 'circle');
      bg.setAttribute('class', 'tag-sticker-progress__bg');
      bg.setAttribute('r', String(RING_RADIUS));
      bg.setAttribute('cx', '0');
      bg.setAttribute('cy', '0');
      svg.appendChild(bg);

      var arc = document.createElementNS(svgNs, 'circle');
      arc.setAttribute('class', 'tag-sticker-progress__arc');
      arc.setAttribute('r', String(RING_RADIUS));
      arc.setAttribute('cx', '0');
      arc.setAttribute('cy', '0');
      // Start at 12 o'clock and fill clockwise.
      arc.setAttribute('transform', 'rotate(-90)');
      arc.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
      arc.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
      svg.appendChild(arc);
      return { svg: svg, arc: arc };
    }

    function setProgressRing(runtime, elapsedMs) {
      if (!runtime || !runtime.ringArc || !runtime.ringSvg) return;
      var progress = (Number(elapsedMs) - RING_FILL_START_MS) / (RING_FILL_END_MS - RING_FILL_START_MS);
      if (!Number.isFinite(progress) || progress <= 0) {
        runtime.ringSvg.style.opacity = '0';
        runtime.ringArc.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
        return;
      }
      if (progress > 1) progress = 1;
      runtime.ringSvg.style.opacity = '1';
      // Color the arc to match the sticker's accent so it's visually tied.
      if (runtime.color) {
        runtime.ringArc.setAttribute('stroke', String(runtime.color));
      }
      runtime.ringArc.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE * (1 - progress)));
    }

    function hideProgressRing(runtime) {
      if (!runtime || !runtime.ringSvg) return;
      runtime.ringSvg.style.opacity = '0';
      if (runtime.ringArc) {
        runtime.ringArc.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
      }
    }

    function ensureRuntime(tagId, point, nowMs) {
      var key = String(tagId);
      var r = runtimeByTag[key];
      if (!r) {
        var wrap = document.createElement('div');
        wrap.className = 'tag-sticker-anchor';
        var ring = buildProgressRingSvg();
        wrap.appendChild(ring.svg);
        var dot = document.createElement('div');
        dot.className = 'tag-sticker-live tag-sticker-dot';
        wrap.appendChild(dot);
        // Set the color on both the wrapper and the dot so the SVG ring
        // (which is a sibling of the dot, not a descendant) inherits the
        // CSS variable too.
        setStickerColor(wrap, point.color);
        setStickerColor(dot, point.color);
        if (ring.arc) ring.arc.setAttribute('stroke', String(point.color || '#ff5b5b'));

        var marker = new mapboxgl.Marker({ element: wrap, anchor: 'center', offset: [0, 0] })
          .setLngLat([point.lng, point.lat])
          .addTo(map);

        var currentPx = toPx(point.lng, point.lat);
        r = {
          marker: marker,
          el: wrap,
          dotEl: dot,
          ringSvg: ring.svg,
          ringArc: ring.arc,
          dwellStartMs: nowMs,
          lastSeenMs: nowMs,
          anchorPx: currentPx,
          color: point.color
        };
        runtimeByTag[key] = r;
        return r;
      }

      r.lastSeenMs = nowMs;
      r.marker.setLngLat([point.lng, point.lat]);
      if (r.color !== point.color) {
        r.color = point.color;
        setStickerColor(r.el, point.color);
        setStickerColor(r.dotEl || r.el, point.color);
        if (r.ringArc) r.ringArc.setAttribute('stroke', String(point.color || '#ff5b5b'));
      }
      return r;
    }

    function shouldArm(tagId, currentPx) {
      var last = lastPlacedPxByTag[String(tagId)];
      if (!last) return true;
      return distanceSq(last, currentPx) >= (rearmThresholdPx * rearmThresholdPx);
    }

    function placeSticker(tagId, point, currentPx) {
      var wrap = document.createElement('div');
      wrap.className = 'tag-sticker-anchor';
      var dot = document.createElement('div');
      dot.className = 'tag-sticker tag-sticker-dot';
      wrap.appendChild(dot);

      var stepForItem = Number(currentStep) || 0;
      var item = {
        tagId: String(tagId),
        lng: point.lng,
        lat: point.lat,
        color: point.color,
        step: stepForItem,
        marker: null,
        el: wrap,
        dotEl: dot
      };
      applyItemAppearance(item);
      var placedMarker = new mapboxgl.Marker({ element: wrap, anchor: 'center', offset: [0, 0] })
        .setLngLat([point.lng, point.lat])
        .addTo(map);
      item.marker = placedMarker;

      lastPlacedPxByTag[String(tagId)] = { x: currentPx.x, y: currentPx.y };
      placed.push(item);
      showCommentDraft(item, '');
    }

    function effectiveColorForItem(item) {
      if (!item) return null;
      if (recolorByStep) {
        var key = String(Number(item.step) || 0);
        if (Object.prototype.hasOwnProperty.call(recolorByStep, key)) {
          return recolorByStep[key];
        }
      }
      return item.color;
    }

    function isItemVisible(item) {
      if (!item) return false;
      if (!visibleSteps) return true;
      return visibleSteps.has(Number(item.step) || 0);
    }

    function applyItemAppearance(item) {
      if (!item || !item.el) return;
      var color = effectiveColorForItem(item);
      var dot = item.dotEl || item.el;
      setStickerColor(dot, color);
      item.el.style.display = isItemVisible(item) ? '' : 'none';
      dot.classList.toggle('commented', !!item.commented);
      if (item.commented) {
        dot.style.color = textColorForBackground(color);
        item.el.title = String(item.commentText || '');
      } else {
        dot.style.color = '';
        item.el.removeAttribute('title');
      }
      updatePlacedCommentText(item);
    }

    function refreshAllAppearance() {
      for (var i = 0; i < placed.length; i++) applyItemAppearance(placed[i]);
    }

    function setEnabled(nextEnabled) {
      enabled = !!nextEnabled;
      if (!enabled) clearRuntime();
    }

    function update(pointsByTagId, nowMs, maybeEnabled) {
      if (typeof maybeEnabled === 'boolean') setEnabled(maybeEnabled);
      if (!enabled) return;

      var points = pointsByTagId || {};
      var seen = {};
      for (var key in points) {
        if (!Object.prototype.hasOwnProperty.call(points, key)) continue;
        var point = parsePoint(points[key]);
        if (!point) continue;

        var runtime = ensureRuntime(key, point, nowMs);
        var currentPx = toPx(point.lng, point.lat);

        if (!runtime.anchorPx) runtime.anchorPx = currentPx;
        if (distanceSq(runtime.anchorPx, currentPx) > (moveThresholdPx * moveThresholdPx)) {
          runtime.anchorPx = currentPx;
          runtime.dwellStartMs = nowMs;
        }

        var armed = shouldArm(key, currentPx);
        var nearPlaced = suppressPlaceNearPlacedPx > 0
          ? findNearestPlaced(point.lng, point.lat, suppressPlaceNearPlacedPx)
          : null;
        if (nearPlaced) {
          armed = false;
        }
        (runtime.dotEl || runtime.el).classList.toggle('armed', armed);
        if (!armed) {
          runtime.dwellStartMs = nowMs;
          runtime.anchorPx = currentPx;
          hideProgressRing(runtime);
          seen[String(key)] = true;
          continue;
        }

        var elapsed = nowMs - Number(runtime.dwellStartMs || nowMs);
        setProgressRing(runtime, elapsed);

        if (elapsed >= holdMs) {
          placeSticker(key, point, currentPx);
          runtime.dwellStartMs = nowMs;
          runtime.anchorPx = currentPx;
          hideProgressRing(runtime);
        }

        seen[String(key)] = true;
      }

      for (var runtimeKey in runtimeByTag) {
        if (!Object.prototype.hasOwnProperty.call(runtimeByTag, runtimeKey)) continue;
        if (seen[runtimeKey]) continue;
        var r = runtimeByTag[runtimeKey];
        if ((nowMs - Number(r.lastSeenMs || 0)) > lostHoldMs) removeRuntime(runtimeKey);
      }
    }

    function getPlacedGeoJSON() {
      var features = [];
      for (var i = 0; i < placed.length; i++) {
        var p = placed[i];
        features.push({
          type: 'Feature',
          properties: {
            sourceType: 'sticker',
            tagId: p.tagId,
            color: p.color,
            step: Number(p.step) || 0,
            commented: !!p.commented,
            commentText: String(p.commentText || ''),
            commentSourceTagId: p.commentSourceTagId == null ? null : Number(p.commentSourceTagId)
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
      clearRuntime();
      for (var i = 0; i < placed.length; i++) {
        if (placed[i]) {
          clearCommentDraftTimers(placed[i]);
          if (placed[i].marker) placed[i].marker.remove();
        }
      }
      placed = [];
      lastPlacedPxByTag = {};
    }

    // Rehydrate placed stickers from a GeoJSON FeatureCollection produced by
    // getPlacedGeoJSON() (or compatible shape). Replaces any existing placed
    // stickers. Used when resuming a workshop from a saved session.
    function loadPlacedStickers(fc) {
      // Tear down anything currently on the map first.
      for (var i = 0; i < placed.length; i++) {
        if (placed[i]) {
          clearCommentDraftTimers(placed[i]);
          if (placed[i].marker) placed[i].marker.remove();
        }
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
        var tagId = String(props.tagId || '');
        var color = String(props.color || '#ff5b5b');
        var step = Number(props.step) || 0;
        var commented = !!props.commented;
        var commentText = String(props.commentText || '');
        var commentSourceTagId = props.commentSourceTagId == null
          ? null
          : Number(props.commentSourceTagId);

        var wrap = document.createElement('div');
        wrap.className = 'tag-sticker-anchor';
        var dot = document.createElement('div');
        dot.className = 'tag-sticker tag-sticker-dot';
        wrap.appendChild(dot);

        var item = {
          tagId: tagId,
          lng: lng,
          lat: lat,
          color: color,
          step: step,
          commented: commented,
          commentText: commentText,
          commentSourceTagId: commentSourceTagId,
          marker: null,
          el: wrap,
          dotEl: dot
        };
        applyItemAppearance(item);
        item.marker = new mapboxgl.Marker({ element: wrap, anchor: 'center', offset: [0, 0] })
          .setLngLat([lng, lat])
          .addTo(map);
        placed.push(item);
      }
      return placed.length;
    }

    function findNearestPlaced(lng, lat, maxDistancePx) {
      var selectorPx = toPx(lng, lat);
      var maxDistSq = Number(maxDistancePx) * Number(maxDistancePx);
      var best = null;

      for (var i = 0; i < placed.length; i++) {
        var item = placed[i];
        if (!item) continue;
        if (!isItemVisible(item)) continue;
        var itemPx = toPx(item.lng, item.lat);
        var distSq = distanceSq(selectorPx, itemPx);
        if (!Number.isFinite(distSq) || distSq > maxDistSq) continue;
        if (!best || distSq < best.distanceSq) {
          best = { index: i, distanceSq: distSq };
        }
      }

      return best;
    }

    function commentNearest(lng, lat, maxDistancePx, text, sourceTagId) {
      var nearest = findNearestPlaced(lng, lat, maxDistancePx);
      if (!nearest) return false;
      return commentByIndex(nearest.index, text, sourceTagId);
    }

    function commentByIndex(index, text, sourceTagId) {
      var item = placed[Number(index)];
      if (!item) return false;
      var cleanText = String(text || '').trim();
      if (!cleanText) return false;
      if (cleanText.length > 220) cleanText = cleanText.slice(0, 220);
      item.commented = true;
      item.commentText = cleanText;
      item.commentSourceTagId = Number(sourceTagId);
      applyItemAppearance(item);
      hideCommentDraft(item);
      return true;
    }

    function syncExternalTextByIndex(index, text) {
      var item = placed[Number(index)];
      if (!item) return false;
      return showCommentDraft(item, text);
    }

    function getCommentInfoNear(lng, lat, maxDistancePx) {
      var nearest = findNearestPlaced(lng, lat, maxDistancePx);
      if (!nearest) return null;
      var item = placed[nearest.index];
      if (!item) return null;
      return {
        index: nearest.index,
        distanceSq: nearest.distanceSq,
        commented: !!item.commented,
        text: String(item.commentText || ''),
        tagId: String(item.tagId || ''),
        commentSourceTagId: item.commentSourceTagId == null ? null : Number(item.commentSourceTagId)
      };
    }

    function syncExternalTextNear(lng, lat, maxDistancePx, text) {
      var nearest = findNearestPlaced(lng, lat, maxDistancePx);
      if (!nearest) return false;
      var item = placed[nearest.index];
      if (!item) return false;
      return showCommentDraft(item, text);
    }

    function showCommentDraftNear(lng, lat, maxDistancePx, text) {
      return syncExternalTextNear(lng, lat, maxDistancePx, text);
    }

    function movePlaced(index, lng, lat) {
      var item = placed[index];
      if (!item || !item.marker) return false;
      item.lng = Number(lng);
      item.lat = Number(lat);
      item.marker.setLngLat([item.lng, item.lat]);
      return true;
    }

    function eraseAtPoint(lng, lat, radiusPxValue) {
      var centerLng = Number(lng);
      var centerLat = Number(lat);
      if (!Number.isFinite(centerLng) || !Number.isFinite(centerLat)) return false;

      var centerPx = toPx(centerLng, centerLat);
      if (!centerPx || !Number.isFinite(centerPx.x) || !Number.isFinite(centerPx.y)) return false;

      var radius = Math.max(2, Number.isFinite(radiusPxValue) ? Number(radiusPxValue) : 16);
      var radiusSq = radius * radius;
      var nextPlaced = [];
      var changed = false;

      for (var i = 0; i < placed.length; i++) {
        var item = placed[i];
        if (!item) continue;
        // Don't erase items that are filtered out — the user can't see them.
        if (!isItemVisible(item)) {
          nextPlaced.push(item);
          continue;
        }
        var itemPx = toPx(item.lng, item.lat);
        if (!itemPx || !Number.isFinite(itemPx.x) || !Number.isFinite(itemPx.y)) {
          nextPlaced.push(item);
          continue;
        }
        var distSq = distanceSq(centerPx, itemPx);
        if (Number.isFinite(distSq) && distSq <= radiusSq) {
          clearCommentDraftTimers(item);
          if (item.marker) item.marker.remove();
          changed = true;
          continue;
        }
        nextPlaced.push(item);
      }

      if (!changed) return false;
      placed = nextPlaced;
      return true;
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
      refreshAllAppearance();
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
      refreshAllAppearance();
    }

    return {
      setEnabled: setEnabled,
      update: update,
      getPlacedGeoJSON: getPlacedGeoJSON,
      loadPlacedStickers: loadPlacedStickers,
      clearAll: clearAll,
      findNearestPlaced: findNearestPlaced,
      commentNearest: commentNearest,
      commentByIndex: commentByIndex,
      syncExternalTextByIndex: syncExternalTextByIndex,
      getCommentInfoNear: getCommentInfoNear,
      syncExternalTextNear: syncExternalTextNear,
      showCommentDraftNear: showCommentDraftNear,
      movePlaced: movePlaced,
      eraseAtPoint: eraseAtPoint,
      setCurrentStep: setCurrentStep,
      setVisibleSteps: setVisibleSteps,
      setRecolorByStep: setRecolorByStep
    };
  }

  window.CompactStickerPlacement = { createStickerPlacement: createStickerPlacement };
})();
