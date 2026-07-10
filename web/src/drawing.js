(function () {
  function emptyFeatureCollection() {
    return { type: 'FeatureCollection', features: [] };
  }

  function createDrawing(options) {
    var map = options.map;
    var sourceId = options.sourceId || 'draw-source';
    var layerId = options.layerId || 'draw-layer';
    var strokeStopMs = Number(options.strokeStopMs || 120);
    var minMovePx = Number(options.minMovePx || 3);
    var eraserRadiusPx = Number(options.eraserRadiusPx || 16);
    var projectLngLatToPx = typeof options.projectLngLatToPx === 'function'
      ? options.projectLngLatToPx
      : function (lng, lat) {
        var point = map.project([lng, lat]);
        return { x: Number(point.x), y: Number(point.y) };
      };
    var unprojectPxToLngLat = typeof options.unprojectPxToLngLat === 'function'
      ? options.unprojectPxToLngLat
      : function (x, y) {
        var lngLat = map.unproject([x, y]);
        return [lngLat.lng, lngLat.lat];
      };

    // Strokes are split into two GeoJSON sources for performance:
    //   - committed: every finalised stroke. Mostly static; only changes when
    //     a stroke stops, when something is erased, or when load/clear runs.
    //     This source carries the expensive glow layer.
    //   - live:      strokes currently being drawn (one per active draw tag).
    //     Updated every move. The glow layer is intentionally skipped here so
    //     the per-frame cost is just the thin line layer.
    var committedSourceId = sourceId + '-committed';
    var liveSourceId = sourceId + '-live';
    var committedLineLayerId = layerId;
    var liveLineLayerId = layerId + '-live';

    var committedFeatures = [];
    var liveFeatures = [];
    // strokeId -> { source: 'committed' | 'live', feature: <Feature> }.
    // Constant-time lookup replaces the O(N) findFeatureIndexByStrokeId.
    var strokeIndex = Object.create(null);
    var runtimeByTag = {}; // tagId -> { activeStrokeId, lastSeenMs, lastPx }
    var nextStrokeId = 1;
    var currentStep = 0;
    var currentWorkshopId = '';
    var visibleSteps = null;        // null = all visible
    var visibleWorkshopId = '';     // empty = any workshop/non-workshop
    var recolorByStep = null;       // null = use feature color; else { step: color }
    var DEFAULT_STROKE_COLOR = '#ff5b5b';

    function colorExpression() {
      if (recolorByStep) {
        var cases = ['case'];
        for (var key in recolorByStep) {
          if (!Object.prototype.hasOwnProperty.call(recolorByStep, key)) continue;
          var stepNum = Number(key);
          if (!Number.isFinite(stepNum)) continue;
          cases.push(['==', ['to-number', ['get', 'step']], stepNum]);
          cases.push(String(recolorByStep[key]));
        }
        cases.push(['coalesce', ['get', 'color'], DEFAULT_STROKE_COLOR]);
        return cases;
      }
      return ['coalesce', ['get', 'color'], DEFAULT_STROKE_COLOR];
    }

    function visibilityFilter() {
      if (!visibleSteps && !visibleWorkshopId) return null;
      var filters = ['all'];
      if (visibleSteps) {
        var allowed = [];
        visibleSteps.forEach(function (n) { allowed.push(Number(n) || 0); });
        if (!allowed.length) return ['==', ['literal', false], true]; // hide everything
        // Match the feature's step (default 0) against the allowed list.
        var match = ['match', ['to-number', ['coalesce', ['get', 'step'], 0]]];
        match.push(allowed);
        match.push(true);
        match.push(false);
        filters.push(match);
      }
      if (visibleWorkshopId) {
        filters.push(['==', ['to-string', ['coalesce', ['get', 'workshopId'], '']], visibleWorkshopId]);
      }
      return filters.length > 1 ? filters : null;
    }

    function applyPaintExpressions() {
      var expr = colorExpression();
      var filt = visibilityFilter();
      var ids = [committedLineLayerId, liveLineLayerId];
      for (var i = 0; i < ids.length; i++) {
        if (map.getLayer(ids[i])) {
          map.setPaintProperty(ids[i], 'line-color', expr);
          map.setFilter(ids[i], filt);
        }
      }
    }

    // Create the draw sources/layers if missing. Idempotent and safe to call
    // repeatedly (e.g. on every style settle).
    function ensureSourcesAndLayers() {
      if (!map.getSource(committedSourceId)) {
        map.addSource(committedSourceId, {
          type: 'geojson',
          data: emptyFeatureCollection()
        });
      }
      if (!map.getSource(liveSourceId)) {
        map.addSource(liveSourceId, {
          type: 'geojson',
          data: emptyFeatureCollection()
        });
      }
      if (!map.getLayer(committedLineLayerId)) {
        map.addLayer({
          id: committedLineLayerId,
          type: 'line',
          source: committedSourceId,
          paint: {
            'line-color': colorExpression(),
            'line-width': 5,
            'line-opacity': 0.95
          },
          layout: {
            'line-cap': 'round',
            'line-join': 'round'
          }
        });
      }
      // Live layer: thin line only, no glow. Cheap to repaint per frame.
      if (!map.getLayer(liveLineLayerId)) {
        map.addLayer({
          id: liveLineLayerId,
          type: 'line',
          source: liveSourceId,
          paint: {
            'line-color': colorExpression(),
            'line-width': 5,
            'line-opacity': 0.95
          },
          layout: {
            'line-cap': 'round',
            'line-join': 'round'
          }
        });
      }
    }

    // Called on every style settle (initial load + each basemap switch, which
    // now re-fires 'style.load' thanks to setStyle({diff:false}) in mapSetup).
    // Recreates the sources/layers if the style swap wiped them, then re-pushes
    // the stroke data and filter so drawings survive the switch.
    function ensureLayer() {
      ensureSourcesAndLayers();
      setAllData();
      applyPaintExpressions();
    }

    function setCommittedData() {
      var src = map.getSource(committedSourceId);
      if (!src) return;
      src.setData({ type: 'FeatureCollection', features: committedFeatures });
    }

    function setLiveData() {
      var src = map.getSource(liveSourceId);
      if (!src) return;
      src.setData({ type: 'FeatureCollection', features: liveFeatures });
    }

    function setAllData() {
      setCommittedData();
      setLiveData();
    }

    function rebuildStrokeIndex() {
      strokeIndex = Object.create(null);
      for (var i = 0; i < committedFeatures.length; i++) {
        var sid = getFeatureStrokeId(committedFeatures[i]);
        if (sid) strokeIndex[sid] = { source: 'committed', feature: committedFeatures[i] };
      }
      for (var j = 0; j < liveFeatures.length; j++) {
        var sid2 = getFeatureStrokeId(liveFeatures[j]);
        if (sid2) strokeIndex[sid2] = { source: 'live', feature: liveFeatures[j] };
      }
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

    function finishActiveStrokes() {
      var graduated = false;
      for (var key in runtimeByTag) {
        if (!Object.prototype.hasOwnProperty.call(runtimeByTag, key)) continue;
        var runtime = runtimeByTag[key];
        if (!runtime) continue;
        if (runtime.activeStrokeId && moveStrokeToCommitted(runtime.activeStrokeId)) graduated = true;
        runtime.activeStrokeId = '';
        runtime.lastPx = null;
      }
      if (graduated) {
        setLiveData();
        setCommittedData();
      }
      return graduated;
    }

    function makeStrokeId() {
      var strokeId = String(nextStrokeId++);
      return strokeId;
    }

    function getFeatureStrokeId(feature) {
      return feature && feature.properties && feature.properties.strokeId
        ? String(feature.properties.strokeId)
        : '';
    }

    function getStrokeEntry(strokeId) {
      var wanted = String(strokeId || '');
      if (!wanted) return null;
      return strokeIndex[wanted] || null;
    }

    function ensureRuntime(tagId, nowMs) {
      var key = String(tagId);
      if (!runtimeByTag[key]) {
        runtimeByTag[key] = {
          activeStrokeId: '', lastSeenMs: nowMs, lastPx: null
        };
      }
      return runtimeByTag[key];
    }

    function startStroke(tagId, lng, lat, color, nowMs, px) {
      var runtime = ensureRuntime(tagId, nowMs);
      var strokeId = makeStrokeId();
      var props = {
        strokeId: strokeId,
        tagId: String(tagId),
        color: String(color || DEFAULT_STROKE_COLOR),
        step: Number(currentStep) || 0
      };
      if (currentWorkshopId) props.workshopId = currentWorkshopId;
      var feature = {
        type: 'Feature',
        properties: props,
        geometry: {
          type: 'LineString',
          coordinates: [[lng, lat], [lng, lat]]
        }
      };
      // New strokes start in the "live" source so per-frame updates only
      // touch a tiny FeatureCollection. They graduate to "committed" when
      // the stroke stops (see stopExpired).
      liveFeatures.push(feature);
      strokeIndex[strokeId] = { source: 'live', feature: feature };
      runtime.activeStrokeId = strokeId;
      runtime.lastSeenMs = nowMs;
      runtime.lastPx = px;
      return true;
    }

    function appendToStroke(runtime, lng, lat, px, nowMs) {
      var entry = getStrokeEntry(runtime.activeStrokeId);
      if (!entry) return false;
      if (!runtime.lastPx) {
        runtime.lastPx = px;
      } else {
        var dx = px.x - runtime.lastPx.x;
        var dy = px.y - runtime.lastPx.y;
        if ((dx * dx + dy * dy) < (minMovePx * minMovePx)) {
          runtime.lastSeenMs = nowMs;
          return false;
        }
      }

      var feature = entry.feature;
      if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) return false;
      feature.geometry.coordinates.push([lng, lat]);
      runtime.lastSeenMs = nowMs;
      runtime.lastPx = px;
      return true;
    }

    // Returns whether any stroke graduated from live → committed this tick.
    function stopExpired(nowMs, activeById) {
      var graduated = false;
      for (var key in runtimeByTag) {
        if (!Object.prototype.hasOwnProperty.call(runtimeByTag, key)) continue;
        if (activeById[key]) continue;
        var r = runtimeByTag[key];
        if (!r) continue;
        if ((nowMs - (r.lastSeenMs || 0)) >= strokeStopMs) {
          if (r.activeStrokeId && moveStrokeToCommitted(r.activeStrokeId)) {
            graduated = true;
          }
          r.activeStrokeId = '';
          r.lastPx = null;
        }
      }
      return graduated;
    }

    function distanceSqPoints(a, b) {
      if (!a || !b) return Infinity;
      var dx = Number(a.x) - Number(b.x);
      var dy = Number(a.y) - Number(b.y);
      return dx * dx + dy * dy;
    }

    function interpolatePoint(a, b, t) {
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t
      };
    }

    function addCoordToPolyline(polyline, coord) {
      if (!polyline || !coord || coord.length < 2) return;
      if (!polyline.length) {
        polyline.push([coord[0], coord[1]]);
        return;
      }
      var last = polyline[polyline.length - 1];
      if (Math.abs(last[0] - coord[0]) <= 1e-9 && Math.abs(last[1] - coord[1]) <= 1e-9) return;
      polyline.push([coord[0], coord[1]]);
    }

    function coordsEqualish(a, b) {
      if (!a || !b || a.length < 2 || b.length < 2) return false;
      return Math.abs(a[0] - b[0]) <= 1e-9 && Math.abs(a[1] - b[1]) <= 1e-9;
    }

    function projectCoordsToPoints(coords) {
      if (!Array.isArray(coords)) return null;
      var out = [];
      for (var i = 0; i < coords.length; i++) {
        var coord = coords[i];
        if (!coord || coord.length < 2) return null;
        out.push(projectLngLatToPx(coord[0], coord[1]));
      }
      return out;
    }

    function solveSegmentCircleIntersections(ptA, ptB, centerPt, radiusPxValue) {
      var dx = ptB.x - ptA.x;
      var dy = ptB.y - ptA.y;
      var fx = ptA.x - centerPt.x;
      var fy = ptA.y - centerPt.y;

      var A = dx * dx + dy * dy;
      if (A <= 1e-9) return [];
      var B = 2 * (fx * dx + fy * dy);
      var C = fx * fx + fy * fy - radiusPxValue * radiusPxValue;
      var disc = B * B - 4 * A * C;
      if (disc < 0) return [];
      var sqrtDisc = Math.sqrt(disc);
      var t1 = (-B - sqrtDisc) / (2 * A);
      var t2 = (-B + sqrtDisc) / (2 * A);
      var out = [];
      if (t1 > 1e-6 && t1 < 1 - 1e-6) out.push(t1);
      if (t2 > 1e-6 && t2 < 1 - 1e-6) out.push(t2);
      if (out.length === 2 && Math.abs(out[0] - out[1]) < 1e-6) out.pop();
      if (out.length === 2 && out[0] > out[1]) {
        var tmp = out[0];
        out[0] = out[1];
        out[1] = tmp;
      }
      return out;
    }

    function coordAtSegmentT(coordA, coordB, ptA, ptB, t) {
      if (t <= 1e-6) return [coordA[0], coordA[1]];
      if (t >= 1 - 1e-6) return [coordB[0], coordB[1]];
      var point = interpolatePoint(ptA, ptB, t);
      return unprojectPxToLngLat(point.x, point.y);
    }

    // Remove only the stroke portion that falls inside the eraser circle.
    function clipStrokeCoordsByCircle(coords, pts, centerPt, radiusPxValue) {
      if (!Array.isArray(coords) || coords.length < 1) return { changed: false, segments: [] };
      if (!Array.isArray(pts) || pts.length !== coords.length) return { changed: false, segments: [] };
      if (coords.length === 1) {
        if (distanceSqPoints(pts[0], centerPt) <= radiusPxValue * radiusPxValue) {
          return { changed: true, segments: [] };
        }
        return { changed: false, segments: [coords.slice()] };
      }

      var radiusSq = radiusPxValue * radiusPxValue;
      var pieces = [];
      var changed = false;

      for (var i = 1; i < coords.length; i++) {
        var coordA = coords[i - 1];
        var coordB = coords[i];
        var ptA = pts[i - 1];
        var ptB = pts[i];
        if (!ptA || !ptB) continue;

        var ts = solveSegmentCircleIntersections(ptA, ptB, centerPt, radiusPxValue);
        var bounds = [0];
        for (var ti = 0; ti < ts.length; ti++) bounds.push(ts[ti]);
        bounds.push(1);

        for (var bi = 0; bi < bounds.length - 1; bi++) {
          var tStart = bounds[bi];
          var tEnd = bounds[bi + 1];
          if ((tEnd - tStart) <= 1e-6) continue;

          var mid = (tStart + tEnd) * 0.5;
          var midPt = interpolatePoint(ptA, ptB, mid);
          if (distanceSqPoints(midPt, centerPt) <= radiusSq) {
            changed = true;
            continue;
          }

          var cStart = coordAtSegmentT(coordA, coordB, ptA, ptB, tStart);
          var cEnd = coordAtSegmentT(coordA, coordB, ptA, ptB, tEnd);
          if (!cStart || !cEnd) continue;
          pieces.push([cStart, cEnd]);
        }
      }

      if (!changed) return { changed: false, segments: [coords.slice()] };

      var merged = [];
      for (var pi = 0; pi < pieces.length; pi++) {
        var piece = pieces[pi];
        if (!piece || piece.length < 2) continue;

        var p0 = piece[0];
        var p1 = piece[1];
        if (!p0 || !p1 || coordsEqualish(p0, p1)) continue;

        var last = merged.length ? merged[merged.length - 1] : null;
        if (last && coordsEqualish(last[last.length - 1], p0)) {
          addCoordToPolyline(last, p1);
          continue;
        }

        var polyline = [];
        addCoordToPolyline(polyline, p0);
        addCoordToPolyline(polyline, p1);
        if (polyline.length >= 2) merged.push(polyline);
      }

      return { changed: true, segments: merged };
    }

    function isStrokeActive(strokeId) {
      var wanted = String(strokeId || '');
      if (!wanted) return false;
      for (var key in runtimeByTag) {
        if (!Object.prototype.hasOwnProperty.call(runtimeByTag, key)) continue;
        var runtime = runtimeByTag[key];
        if (runtime && runtime.activeStrokeId === wanted) return true;
      }
      return false;
    }

    function update(activeDrawPointsByTagId, nowMs) {
      var active = activeDrawPointsByTagId || {};
      var liveChanged = false;

      // stopExpired returns true when at least one stroke graduated from
      // live → committed; in that case we need to refresh both sources.
      var graduated = stopExpired(nowMs, active);

      for (var key in active) {
        if (!Object.prototype.hasOwnProperty.call(active, key)) continue;
        var entry = active[key];
        if (!entry) continue;
        var lng = Number(entry.lng);
        var lat = Number(entry.lat);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        var px = projectLngLatToPx(lng, lat);
        var runtime = ensureRuntime(key, nowMs);
        var existing = getStrokeEntry(runtime.activeStrokeId);

        if (!existing) {
          if (startStroke(key, lng, lat, entry.color, nowMs, px)) liveChanged = true;
        } else {
          if (appendToStroke(runtime, lng, lat, px, nowMs)) liveChanged = true;
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
      if (!centerPt || !Number.isFinite(centerPt.x) || !Number.isFinite(centerPt.y)) return false;

      var radius = Math.max(2, Number.isFinite(radiusPxValue) ? Number(radiusPxValue) : eraserRadiusPx);

      function eraseFromList(list) {
        var changed = false;
        var next = [];
        for (var i = 0; i < list.length; i++) {
          var feature = list[i];
          var coords = feature && feature.geometry && Array.isArray(feature.geometry.coordinates)
            ? feature.geometry.coordinates
            : null;
          if (!feature || !coords || coords.length < 1) continue;

          if (isStrokeActive(getFeatureStrokeId(feature))) {
            next.push(feature);
            continue;
          }

          // Don't erase strokes that are currently filtered out (belong to a
          // different step than what's visible) — the user can't see them.
          if (visibleSteps) {
            var featStep = Number((feature.properties || {}).step) || 0;
            if (!visibleSteps.has(featStep)) {
              next.push(feature);
              continue;
            }
          }

          var pts = projectCoordsToPoints(coords);
          if (!pts || pts.length !== coords.length) {
            next.push(feature);
            continue;
          }

          var clipped = clipStrokeCoordsByCircle(coords, pts, centerPt, radius);
          if (!clipped.changed) {
            next.push(feature);
            continue;
          }

          changed = true;
          if (!clipped.segments || !clipped.segments.length) {
            continue;
          }

          var first = {
            type: 'Feature',
            properties: Object.assign({}, feature.properties),
            geometry: {
              type: 'LineString',
              coordinates: clipped.segments[0]
            }
          };
          next.push(first);

          for (var si = 1; si < clipped.segments.length; si++) {
            next.push({
              type: 'Feature',
              properties: Object.assign({}, feature.properties, {
                strokeId: makeStrokeId()
              }),
              geometry: {
                type: 'LineString',
                coordinates: clipped.segments[si]
              }
            });
          }
        }
        return { changed: changed, list: next };
      }

      var committedRes = eraseFromList(committedFeatures);
      var liveRes = eraseFromList(liveFeatures);
      if (!committedRes.changed && !liveRes.changed) return false;
      if (committedRes.changed) committedFeatures = committedRes.list;
      if (liveRes.changed) liveFeatures = liveRes.list;
      // Stroke list mutated (plus possibly new split-strokeIds) — rebuild index.
      rebuildStrokeIndex();
      if (committedRes.changed) setCommittedData();
      if (liveRes.changed) setLiveData();
      return true;
    }

    function getDrawnGeoJSON() {
      // Persisted exports include both committed and live (in-progress) strokes.
      return {
        type: 'FeatureCollection',
        features: committedFeatures.concat(liveFeatures)
      };
    }

    function clearAll() {
      committedFeatures = [];
      liveFeatures = [];
      strokeIndex = Object.create(null);
      runtimeByTag = {};
      setAllData();
    }

    // Rehydrate drawn strokes from a GeoJSON FeatureCollection produced by
    // getDrawnGeoJSON() (or compatible shape). Replaces any existing strokes.
    // Used when resuming a workshop from a saved session.
    function loadDrawings(fc) {
      runtimeByTag = {};
      var src = (fc && Array.isArray(fc.features)) ? fc.features : [];
      var clean = [];
      for (var i = 0; i < src.length; i++) {
        var f = src[i];
        if (!f || !f.geometry) continue;
        if (f.geometry.type !== 'LineString') continue;
        var coords = f.geometry.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) continue;
        clean.push({
          type: 'Feature',
          properties: Object.assign({}, f.properties || {}),
          geometry: { type: 'LineString', coordinates: coords.slice() }
        });
      }
      // Loaded strokes are all finalised → committed.
      committedFeatures = clean;
      liveFeatures = [];
      rebuildStrokeIndex();
      setAllData();
      applyPaintExpressions();
      return committedFeatures.length;
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
      applyPaintExpressions();
    }

    function setVisibleWorkshop(workshopId) {
      visibleWorkshopId = String(workshopId || '');
      applyPaintExpressions();
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
      applyPaintExpressions();
    }

    return {
      ensureLayer: ensureLayer,
      update: update,
      eraseAtPoint: eraseAtPoint,
      getDrawnGeoJSON: getDrawnGeoJSON,
      loadDrawings: loadDrawings,
      clearAll: clearAll,
      setCurrentStep: setCurrentStep,
      setWorkshopContext: setWorkshopContext,
      setVisibleSteps: setVisibleSteps,
      setVisibleWorkshop: setVisibleWorkshop,
      setRecolorByStep: setRecolorByStep
    };
  }

  window.CompactDrawing = { createDrawing: createDrawing };
})();
