(function () {
  // The progress ring is larger than the 28px dot so the arc reads outside the sticker's border.
  var RING_RADIUS = 22;
  var RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  var RING_FILL_START_MS = 500; // the ring shows once a tag has been held this long

  function createStickerPlacement(options) {
    var map = options.map;
    var holdMs = Number(options.holdMs || 2000);
    var lostHoldMs = Number(options.lostHoldMs || 500);
    var moveThresholdPx = Number(options.moveThresholdPx || 14);
    var rearmThresholdPx = Number(options.rearmThresholdPx || Math.max(moveThresholdPx + 6, 20));
    var suppressPlaceNearPlacedPx = Number(options.suppressPlaceNearPlacedPx || 0);
    var toPx = options.projectLngLatToPx;
    var distanceSq = window.CompactUtil.distanceSq;

    var enabled = false;
    var runtimeByTag = {}; // tagId -> the live dot of a tag being held
    var placed = [];
    var lastPlacedPxByTag = {};
    var currentStep = 0;
    var visibleSteps = null;

    function parsePoint(raw) {
      var lng = Number(raw.lng);
      var lat = Number(raw.lat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
      var pointHoldMs = Number(raw.holdMs);
      if (!Number.isFinite(pointHoldMs)) pointHoldMs = holdMs;
      return {
        lng: lng,
        lat: lat,
        color: String(raw.color || '#ff5b5b'),
        holdMs: Math.max(250, Math.min(10000, pointHoldMs)),
        continuousHold: !!raw.continuousHold
      };
    }

    function setStickerColor(el, color) {
      el.style.setProperty('--sticker-color', color);
    }

    function removeRuntime(key) {
      runtimeByTag[key].marker.remove();
      delete runtimeByTag[key];
    }

    function clearRuntime() {
      Object.keys(runtimeByTag).forEach(removeRuntime);
    }

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

    function hideProgressRing(runtime) {
      runtime.ringSvg.style.opacity = '0';
      runtime.ringArc.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
    }

    function setProgressRing(runtime, elapsedMs, targetHoldMs) {
      var fillStartMs = Math.min(RING_FILL_START_MS, targetHoldMs * 0.5);
      var progress = (elapsedMs - fillStartMs) / Math.max(1, targetHoldMs - fillStartMs);
      if (!Number.isFinite(progress) || progress <= 0) {
        hideProgressRing(runtime);
        return;
      }
      runtime.ringSvg.style.opacity = '1';
      runtime.ringArc.setAttribute('stroke', runtime.color);
      runtime.ringArc.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE * (1 - Math.min(1, progress))));
    }

    function ensureRuntime(key, point, nowMs) {
      var runtime = runtimeByTag[key];
      if (!runtime) {
        var wrap = document.createElement('div');
        wrap.className = 'tag-sticker-anchor';
        var ring = buildProgressRingSvg();
        wrap.appendChild(ring.svg);
        var dot = document.createElement('div');
        dot.className = 'tag-sticker-live tag-sticker-dot';
        wrap.appendChild(dot);
        // The ring is the dot's sibling, so the wrapper carries the colour variable too.
        setStickerColor(wrap, point.color);
        setStickerColor(dot, point.color);
        ring.arc.setAttribute('stroke', point.color);
        var marker = new mapboxgl.Marker({ element: wrap, anchor: 'center', offset: [0, 0] })
          .setLngLat([point.lng, point.lat])
          .addTo(map);
        runtime = {
          marker: marker,
          el: wrap,
          dotEl: dot,
          ringSvg: ring.svg,
          ringArc: ring.arc,
          dwellStartMs: nowMs,
          lastSeenMs: nowMs,
          anchorPx: toPx(point.lng, point.lat),
          color: point.color,
          continuousHold: point.continuousHold
        };
        runtimeByTag[key] = runtime;
        return runtime;
      }

      runtime.lastSeenMs = nowMs;
      runtime.continuousHold = point.continuousHold;
      runtime.marker.setLngLat([point.lng, point.lat]);
      if (runtime.color !== point.color) {
        runtime.color = point.color;
        setStickerColor(runtime.el, point.color);
        setStickerColor(runtime.dotEl, point.color);
        runtime.ringArc.setAttribute('stroke', point.color);
      }
      return runtime;
    }

    function shouldArm(key, currentPx) {
      var last = lastPlacedPxByTag[key];
      if (!last) return true;
      return distanceSq(last, currentPx) >= (rearmThresholdPx * rearmThresholdPx);
    }

    // input: what placed it when not a tag ('mouse').
    function addPlaced(key, point, input) {
      var wrap = document.createElement('div');
      wrap.className = 'tag-sticker-anchor';
      var dot = document.createElement('div');
      dot.className = 'tag-sticker tag-sticker-dot';
      wrap.appendChild(dot);

      var item = {
        tagId: key,
        lng: point.lng,
        lat: point.lat,
        color: point.color,
        step: currentStep,
        marker: null,
        el: wrap,
        dotEl: dot
      };
      if (input) item.input = String(input);
      applyItemAppearance(item);
      item.marker = new mapboxgl.Marker({ element: wrap, anchor: 'center', offset: [0, 0] })
        .setLngLat([point.lng, point.lat])
        .addTo(map);
      placed.push(item);
    }

    function placeSticker(key, point, currentPx) {
      addPlaced(key, point);
      lastPlacedPxByTag[key] = { x: currentPx.x, y: currentPx.y };
    }

    // The mouse: a sticker placed at once, with no hold. raw: { lng, lat, color, tagId, input }.
    function placeAt(raw) {
      var point = parsePoint(raw || {});
      if (!point) return false;
      addPlaced(String(raw.tagId || 'mouse'), point, raw.input);
      return true;
    }

    function isItemVisible(item) {
      return !visibleSteps || visibleSteps.has(item.step);
    }

    function applyItemAppearance(item) {
      setStickerColor(item.dotEl, item.color);
      item.el.style.display = isItemVisible(item) ? '' : 'none';
    }

    function setEnabled(nextEnabled) {
      enabled = !!nextEnabled;
      if (!enabled) clearRuntime();
    }

    function update(pointsByTagId, nowMs, maybeEnabled) {
      if (typeof maybeEnabled === 'boolean') setEnabled(maybeEnabled);
      if (!enabled) return;

      var seen = {};
      for (var key in pointsByTagId) {
        var point = parsePoint(pointsByTagId[key]);
        if (!point) continue;
        seen[key] = true;
        var runtime = ensureRuntime(key, point, nowMs);
        var currentPx = toPx(point.lng, point.lat);
        if (distanceSq(runtime.anchorPx, currentPx) > (moveThresholdPx * moveThresholdPx)) {
          runtime.anchorPx = currentPx;
          runtime.dwellStartMs = nowMs;
        }

        var armed = shouldArm(key, currentPx);
        if (suppressPlaceNearPlacedPx > 0 && findNearestPlaced(point.lng, point.lat, suppressPlaceNearPlacedPx)) {
          armed = false;
        }
        runtime.dotEl.classList.toggle('armed', armed);
        if (!armed) {
          runtime.dwellStartMs = nowMs;
          runtime.anchorPx = currentPx;
          hideProgressRing(runtime);
          continue;
        }

        var elapsed = nowMs - runtime.dwellStartMs;
        setProgressRing(runtime, elapsed, point.holdMs);
        if (elapsed >= point.holdMs) {
          placeSticker(key, point, currentPx);
          runtime.dwellStartMs = nowMs;
          runtime.anchorPx = currentPx;
          hideProgressRing(runtime);
        }
      }

      for (var heldKey in runtimeByTag) {
        if (seen[heldKey]) continue;
        var held = runtimeByTag[heldKey];
        if (held.continuousHold || (nowMs - held.lastSeenMs) > lostHoldMs) removeRuntime(heldKey);
      }
    }

    function getPlacedGeoJSON() {
      return {
        type: 'FeatureCollection',
        features: placed.map(function (p) {
          var properties = {
            sourceType: 'sticker',
            tagId: p.tagId,
            color: p.color,
            step: p.step
          };
          if (p.input) properties.input = p.input;
          return {
            type: 'Feature',
            properties: properties,
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] }
          };
        })
      };
    }

    // [{ lng, lat }] of the stickers the current part filter shows.
    function getVisiblePoints() {
      return placed.filter(isItemVisible).map(function (p) { return { lng: p.lng, lat: p.lat }; });
    }

    function clearAll() {
      clearRuntime();
      placed.forEach(function (item) {
        item.marker.remove();
      });
      placed = [];
      lastPlacedPxByTag = {};
    }

    function findNearestPlaced(lng, lat, maxDistancePx) {
      var selectorPx = toPx(lng, lat);
      var maxDistSq = maxDistancePx * maxDistancePx;
      var best = null;
      placed.forEach(function (item, index) {
        if (!isItemVisible(item)) return;
        var distSq = distanceSq(selectorPx, toPx(item.lng, item.lat));
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
      item.marker.setLngLat([item.lng, item.lat]);
      return true;
    }

    function eraseAtPoint(lng, lat, radiusPxValue) {
      var centerLng = Number(lng);
      var centerLat = Number(lat);
      if (!Number.isFinite(centerLng) || !Number.isFinite(centerLat)) return false;
      var centerPx = toPx(centerLng, centerLat);
      var radius = Math.max(2, Number.isFinite(radiusPxValue) ? Number(radiusPxValue) : 16);
      var nextPlaced = [];
      placed.forEach(function (item) {
        // Stickers filtered out of view cannot be erased.
        if (isItemVisible(item) && distanceSq(centerPx, toPx(item.lng, item.lat)) <= radius * radius) {
          item.marker.remove();
        } else {
          nextPlaced.push(item);
        }
      });
      if (nextPlaced.length === placed.length) return false;
      placed = nextPlaced;
      return true;
    }

    function setCurrentStep(stepNumber) {
      currentStep = Number(stepNumber) || 0;
    }

    // steps: a Set of step numbers, or null for all.
    function setVisibleSteps(steps) {
      visibleSteps = steps || null;
      placed.forEach(applyItemAppearance);
    }

    return {
      setEnabled: setEnabled,
      update: update,
      placeAt: placeAt,
      getPlacedGeoJSON: getPlacedGeoJSON,
      getVisiblePoints: getVisiblePoints,
      clearAll: clearAll,
      findNearestPlaced: findNearestPlaced,
      movePlaced: movePlaced,
      eraseAtPoint: eraseAtPoint,
      setCurrentStep: setCurrentStep,
      setVisibleSteps: setVisibleSteps
    };
  }

  window.CompactStickerPlacement = { createStickerPlacement: createStickerPlacement };
})();
