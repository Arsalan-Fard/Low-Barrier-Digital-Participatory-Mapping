(function () {
  var DEFAULT_STROKE_COLOR = '#ff5b5b';

  function createDrawing(options) {
    var map = options.map;
    var sourceId = options.sourceId || 'draw-source';
    var layerId = options.layerId || 'draw-layer';
    var strokeStopMs = Number(options.strokeStopMs || 120);
    var minMovePx = Number(options.minMovePx || 3);
    var eraserRadiusPx = Number(options.eraserRadiusPx || 16);
    var projectLngLatToPx = options.projectLngLatToPx;
    var unprojectPxToLngLat = options.unprojectPxToLngLat;

    // Finished strokes and strokes being drawn sit in separate sources, so the
    // per-frame setData only re-uploads the few live ones.
    var committedSourceId = sourceId + '-committed';
    var liveSourceId = sourceId + '-live';
    var committedLineLayerId = layerId;
    var liveLineLayerId = layerId + '-live';

    var committedFeatures = [];
    var liveFeatures = [];
    var strokeIndex = Object.create(null); // strokeId -> { source: 'committed' | 'live', feature }
    var runtimeByTag = {}; // tagId -> { activeStrokeId, lastSeenMs, lastPx }
    var nextStrokeId = 1;
    var currentStep = 0;
    var currentWorkshopId = '';
    var visibleSteps = null;
    var visibleWorkshopId = '';

    function visibilityFilter() {
      if (!visibleSteps && !visibleWorkshopId) return null;
      var filters = ['all'];
      if (visibleSteps) {
        var allowed = [];
        visibleSteps.forEach(function (n) { allowed.push(Number(n) || 0); });
        if (!allowed.length) return ['==', ['literal', false], true];
        filters.push(['match', ['to-number', ['coalesce', ['get', 'step'], 0]], allowed, true, false]);
      }
      if (visibleWorkshopId) {
        filters.push(['==', ['to-string', ['coalesce', ['get', 'workshopId'], '']], visibleWorkshopId]);
      }
      return filters;
    }

    function applyFilter() {
      var filter = visibilityFilter();
      [committedLineLayerId, liveLineLayerId].forEach(function (id) {
        if (map.getLayer(id)) map.setFilter(id, filter);
      });
    }

    function ensureSourcesAndLayers() {
      [committedSourceId, liveSourceId].forEach(function (id) {
        if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      });
      [[committedLineLayerId, committedSourceId], [liveLineLayerId, liveSourceId]].forEach(function (ids) {
        if (map.getLayer(ids[0])) return;
        map.addLayer({
          id: ids[0],
          type: 'line',
          source: ids[1],
          paint: {
            'line-color': ['coalesce', ['get', 'color'], DEFAULT_STROKE_COLOR],
            'line-width': 5,
            'line-opacity': 0.95
          },
          layout: {
            'line-cap': 'round',
            'line-join': 'round'
          }
        });
      });
    }

    // Runs after every style load: a basemap switch drops the custom sources and layers.
    function ensureLayer() {
      ensureSourcesAndLayers();
      setAllData();
      applyFilter();
    }

    function setCommittedData() {
      var src = map.getSource(committedSourceId);
      if (src) src.setData({ type: 'FeatureCollection', features: committedFeatures });
    }

    function setLiveData() {
      var src = map.getSource(liveSourceId);
      if (src) src.setData({ type: 'FeatureCollection', features: liveFeatures });
    }

    function setAllData() {
      setCommittedData();
      setLiveData();
    }

    function getFeatureStrokeId(feature) {
      return feature.properties.strokeId ? String(feature.properties.strokeId) : '';
    }

    function rebuildStrokeIndex() {
      strokeIndex = Object.create(null);
      committedFeatures.forEach(function (feature) {
        var sid = getFeatureStrokeId(feature);
        if (sid) strokeIndex[sid] = { source: 'committed', feature: feature };
      });
      liveFeatures.forEach(function (feature) {
        var sid = getFeatureStrokeId(feature);
        if (sid) strokeIndex[sid] = { source: 'live', feature: feature };
      });
    }

    function moveStrokeToCommitted(strokeId) {
      var entry = strokeIndex[strokeId];
      if (!entry || entry.source === 'committed') return false;
      var idx = liveFeatures.indexOf(entry.feature);
      if (idx < 0) return false;
      liveFeatures.splice(idx, 1);
      committedFeatures.push(entry.feature);
      entry.source = 'committed';
      return true;
    }

    function finishRuntime(runtime) {
      var graduated = !!runtime.activeStrokeId && moveStrokeToCommitted(runtime.activeStrokeId);
      runtime.activeStrokeId = '';
      runtime.lastPx = null;
      return graduated;
    }

    function finishActiveStrokes() {
      var graduated = false;
      for (var key in runtimeByTag) {
        if (finishRuntime(runtimeByTag[key])) graduated = true;
      }
      if (graduated) {
        setLiveData();
        setCommittedData();
      }
    }

    function makeStrokeId() {
      return String(nextStrokeId++);
    }

    function ensureRuntime(tagId, nowMs) {
      var key = String(tagId);
      if (!runtimeByTag[key]) runtimeByTag[key] = { activeStrokeId: '', lastSeenMs: nowMs, lastPx: null };
      return runtimeByTag[key];
    }

    // New strokes start live and move to the committed source once they stop.
    function startStroke(runtime, tagId, lng, lat, color, nowMs, px) {
      var strokeId = makeStrokeId();
      var props = {
        strokeId: strokeId,
        tagId: String(tagId),
        color: String(color || DEFAULT_STROKE_COLOR),
        step: currentStep
      };
      if (currentWorkshopId) props.workshopId = currentWorkshopId;
      var feature = {
        type: 'Feature',
        properties: props,
        geometry: { type: 'LineString', coordinates: [[lng, lat], [lng, lat]] }
      };
      liveFeatures.push(feature);
      strokeIndex[strokeId] = { source: 'live', feature: feature };
      runtime.activeStrokeId = strokeId;
      runtime.lastSeenMs = nowMs;
      runtime.lastPx = px;
    }

    function appendToStroke(runtime, entry, lng, lat, px, nowMs) {
      runtime.lastSeenMs = nowMs;
      if (runtime.lastPx) {
        var dx = px.x - runtime.lastPx.x;
        var dy = px.y - runtime.lastPx.y;
        if ((dx * dx + dy * dy) < (minMovePx * minMovePx)) return false;
      }
      entry.feature.geometry.coordinates.push([lng, lat]);
      runtime.lastPx = px;
      return true;
    }

    // Returns whether a stroke moved from live to committed.
    function stopExpired(nowMs, activeById) {
      var graduated = false;
      for (var key in runtimeByTag) {
        if (activeById[key]) continue;
        var runtime = runtimeByTag[key];
        if ((nowMs - (runtime.lastSeenMs || 0)) >= strokeStopMs && finishRuntime(runtime)) graduated = true;
      }
      return graduated;
    }

    function distanceSqPoints(a, b) {
      var dx = a.x - b.x;
      var dy = a.y - b.y;
      return dx * dx + dy * dy;
    }

    function interpolatePoint(a, b, t) {
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }

    function coordsEqualish(a, b) {
      return Math.abs(a[0] - b[0]) <= 1e-9 && Math.abs(a[1] - b[1]) <= 1e-9;
    }

    function projectCoordsToPoints(coords) {
      return coords.map(function (coord) { return projectLngLatToPx(coord[0], coord[1]); });
    }

    // Parameters t in (0, 1), ascending, where segment AB crosses the circle.
    function solveSegmentCircleIntersections(ptA, ptB, centerPt, radiusPx) {
      var dx = ptB.x - ptA.x;
      var dy = ptB.y - ptA.y;
      var fx = ptA.x - centerPt.x;
      var fy = ptA.y - centerPt.y;
      var A = dx * dx + dy * dy;
      if (A <= 1e-9) return [];
      var B = 2 * (fx * dx + fy * dy);
      var C = fx * fx + fy * fy - radiusPx * radiusPx;
      var disc = B * B - 4 * A * C;
      if (disc < 0) return [];
      var sqrtDisc = Math.sqrt(disc);
      var t1 = (-B - sqrtDisc) / (2 * A);
      var t2 = (-B + sqrtDisc) / (2 * A);
      var out = [];
      if (t1 > 1e-6 && t1 < 1 - 1e-6) out.push(t1);
      if (t2 > 1e-6 && t2 < 1 - 1e-6) out.push(t2);
      if (out.length === 2 && Math.abs(out[0] - out[1]) < 1e-6) out.pop();
      return out;
    }

    function coordAtSegmentT(coordA, coordB, ptA, ptB, t) {
      if (t <= 1e-6) return [coordA[0], coordA[1]];
      if (t >= 1 - 1e-6) return [coordB[0], coordB[1]];
      var point = interpolatePoint(ptA, ptB, t);
      return unprojectPxToLngLat(point.x, point.y);
    }

    // Removes only the part of a stroke inside the eraser circle.
    function clipStrokeCoordsByCircle(coords, pts, centerPt, radiusPx) {
      var radiusSq = radiusPx * radiusPx;
      if (coords.length === 1) {
        if (distanceSqPoints(pts[0], centerPt) <= radiusSq) return { changed: true, segments: [] };
        return { changed: false, segments: [coords.slice()] };
      }

      var pieces = [];
      var changed = false;
      for (var i = 1; i < coords.length; i++) {
        var coordA = coords[i - 1];
        var coordB = coords[i];
        var ptA = pts[i - 1];
        var ptB = pts[i];
        var bounds = [0].concat(solveSegmentCircleIntersections(ptA, ptB, centerPt, radiusPx), [1]);
        for (var bi = 0; bi < bounds.length - 1; bi++) {
          var tStart = bounds[bi];
          var tEnd = bounds[bi + 1];
          if ((tEnd - tStart) <= 1e-6) continue;
          var midPt = interpolatePoint(ptA, ptB, (tStart + tEnd) * 0.5);
          if (distanceSqPoints(midPt, centerPt) <= radiusSq) {
            changed = true;
            continue;
          }
          pieces.push([
            coordAtSegmentT(coordA, coordB, ptA, ptB, tStart),
            coordAtSegmentT(coordA, coordB, ptA, ptB, tEnd)
          ]);
        }
      }
      if (!changed) return { changed: false, segments: [coords.slice()] };

      var merged = [];
      pieces.forEach(function (piece) {
        var p0 = piece[0];
        var p1 = piece[1];
        if (coordsEqualish(p0, p1)) return;
        var last = merged[merged.length - 1];
        if (!last || !coordsEqualish(last[last.length - 1], p0)) {
          merged.push([[p0[0], p0[1]], [p1[0], p1[1]]]);
        } else if (!coordsEqualish(last[last.length - 1], p1)) {
          last.push([p1[0], p1[1]]);
        }
      });
      return { changed: true, segments: merged };
    }

    function isStrokeActive(strokeId) {
      if (!strokeId) return false;
      for (var key in runtimeByTag) {
        if (runtimeByTag[key].activeStrokeId === strokeId) return true;
      }
      return false;
    }

    function update(activeDrawPointsByTagId, nowMs) {
      var liveChanged = false;
      var graduated = stopExpired(nowMs, activeDrawPointsByTagId);
      for (var key in activeDrawPointsByTagId) {
        var entry = activeDrawPointsByTagId[key];
        var lng = Number(entry.lng);
        var lat = Number(entry.lat);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        var px = projectLngLatToPx(lng, lat);
        var runtime = ensureRuntime(key, nowMs);
        var existing = strokeIndex[runtime.activeStrokeId];
        if (!existing) {
          startStroke(runtime, key, lng, lat, entry.color, nowMs, px);
          liveChanged = true;
        } else if (appendToStroke(runtime, existing, lng, lat, px, nowMs)) {
          liveChanged = true;
        }
      }
      if (liveChanged || graduated) setLiveData();
      if (graduated) setCommittedData();
    }

    function eraseAtPoint(lng, lat, radiusPxValue) {
      var eraseLng = Number(lng);
      var eraseLat = Number(lat);
      if (!Number.isFinite(eraseLng) || !Number.isFinite(eraseLat)) return false;
      var centerPt = projectLngLatToPx(eraseLng, eraseLat);
      var radius = Math.max(2, Number.isFinite(radiusPxValue) ? Number(radiusPxValue) : eraserRadiusPx);

      function eraseFromList(list) {
        var changed = false;
        var next = [];
        list.forEach(function (feature) {
          // Strokes being drawn, and strokes of steps filtered out of view, are left alone.
          var hidden = visibleSteps && !visibleSteps.has(Number(feature.properties.step) || 0);
          if (hidden || isStrokeActive(getFeatureStrokeId(feature))) {
            next.push(feature);
            return;
          }
          var coords = feature.geometry.coordinates;
          var clipped = clipStrokeCoordsByCircle(coords, projectCoordsToPoints(coords), centerPt, radius);
          if (!clipped.changed) {
            next.push(feature);
            return;
          }
          changed = true;
          clipped.segments.forEach(function (segment, i) {
            var properties = Object.assign({}, feature.properties);
            if (i > 0) properties.strokeId = makeStrokeId();
            next.push({ type: 'Feature', properties: properties, geometry: { type: 'LineString', coordinates: segment } });
          });
        });
        return { changed: changed, list: next };
      }

      var committedRes = eraseFromList(committedFeatures);
      var liveRes = eraseFromList(liveFeatures);
      if (!committedRes.changed && !liveRes.changed) return false;
      if (committedRes.changed) committedFeatures = committedRes.list;
      if (liveRes.changed) liveFeatures = liveRes.list;
      rebuildStrokeIndex();
      if (committedRes.changed) setCommittedData();
      if (liveRes.changed) setLiveData();
      return true;
    }

    // Saved sessions include the strokes still being drawn.
    function getDrawnGeoJSON() {
      return { type: 'FeatureCollection', features: committedFeatures.concat(liveFeatures) };
    }

    function clearAll() {
      committedFeatures = [];
      liveFeatures = [];
      strokeIndex = Object.create(null);
      runtimeByTag = {};
      setAllData();
    }

    function setCurrentStep(stepNumber) {
      var next = Number(stepNumber) || 0;
      if (next !== currentStep) finishActiveStrokes();
      currentStep = next;
    }

    function setWorkshopContext(workshopId) {
      var next = String(workshopId || '');
      if (next !== currentWorkshopId) finishActiveStrokes();
      currentWorkshopId = next;
    }

    // steps: a Set of step numbers, or null for all.
    function setVisibleSteps(steps) {
      visibleSteps = steps || null;
      applyFilter();
    }

    function setVisibleWorkshop(workshopId) {
      visibleWorkshopId = String(workshopId || '');
      applyFilter();
    }

    return {
      ensureLayer: ensureLayer,
      update: update,
      eraseAtPoint: eraseAtPoint,
      getDrawnGeoJSON: getDrawnGeoJSON,
      clearAll: clearAll,
      setCurrentStep: setCurrentStep,
      setWorkshopContext: setWorkshopContext,
      setVisibleSteps: setVisibleSteps,
      setVisibleWorkshop: setVisibleWorkshop
    };
  }

  window.CompactDrawing = { createDrawing: createDrawing };
})();
