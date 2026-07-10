(function () {
  var ROUTE_SOURCE_ID = 'routing-source';
  var ROUTE_LINE_LAYER_ID = 'routing-line';
  var ROUTE_CASING_LAYER_ID = 'routing-casing';
  var ROUTE_LABEL_SOURCE_ID = 'routing-label-source';
  var ROUTE_LABEL_LAYER_ID = 'routing-label';

  var PENDING_SOURCE_ID = 'routing-pending-source';
  var PENDING_LINE_LAYER_ID = 'routing-pending-line';

  var HOLD_MS = 2000;         // tag must be still for 2 s to set its waypoint
  var MOVE_THRESHOLD_PX = 16;
  var DEBOUNCE_MS = 500;

  // Internal state per tag
  function makeTagState() {
    return {
      holdPoint: null,   // { x, y } viewport px — current hold position
      holdSinceMs: 0,
      lngLat: null,      // { lng, lat } — confirmed waypoint
      marker: null       // mapboxgl.Marker pin
    };
  }

  function createRouting(options) {
    var map = options.map;
    var getAccessToken = options.getAccessToken;

    var tagA = makeTagState(); // tag 18 = origin
    var tagB = makeTagState(); // tag 19 = destination
    var lastCallMs = 0;
    var lastRouteKey = '';
    var drawnRouteKey = '';   // endpoints for which a route is currently drawn
    var fetchInFlight = false;
    var visible = true;
    var dashAnimFrame = 0;
    var dashAnimStart = 0;

    // ---- Map layer management ----

    function ensureLayers() {
      if (!map) return;
      if (!map.getSource(ROUTE_SOURCE_ID)) {
        map.addSource(ROUTE_SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
      }
      // Casing (thicker, dark outline for contrast)
      if (!map.getLayer(ROUTE_CASING_LAYER_ID)) {
        map.addLayer({
          id: ROUTE_CASING_LAYER_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#0055aa',
            'line-width': 8,
            'line-opacity': 0.6
          }
        });
      }
      // Main route line
      if (!map.getLayer(ROUTE_LINE_LAYER_ID)) {
        map.addLayer({
          id: ROUTE_LINE_LAYER_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#00aaff',
            'line-width': 4,
            'line-opacity': 0.95
          }
        });
      }
    }

    function setGeoJSON(geojson) {
      if (!map || !map.getSource(ROUTE_SOURCE_ID)) return;
      map.getSource(ROUTE_SOURCE_ID).setData(
        geojson || { type: 'FeatureCollection', features: [] }
      );
    }

    function ensurePendingLayer() {
      if (!map) return;
      if (!map.getSource(PENDING_SOURCE_ID)) {
        map.addSource(PENDING_SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
      }
      if (!map.getLayer(PENDING_LINE_LAYER_ID)) {
        map.addLayer({
          id: PENDING_LINE_LAYER_ID,
          type: 'line',
          source: PENDING_SOURCE_ID,
          layout: { 'line-join': 'round', 'line-cap': 'butt' },
          paint: {
            'line-color': '#00aaff',
            'line-width': 3,
            'line-opacity': 0.6,
            'line-dasharray': [2, 3]
          }
        });
      }
      startDashAnimation();
    }

    // Animate the dash pattern by cycling through phases so the dashes visibly
    // travel along the line while we wait for the route to arrive.
    function startDashAnimation() {
      if (dashAnimFrame) return;
      // Cycle through increasing "gap/dash" ratios; mapbox-gl doesn't support
      // line-dash-offset, so we shift the pattern by permuting the array.
      var sequence = [
        [0, 4, 3],
        [0.5, 4, 2.5],
        [1, 4, 2],
        [1.5, 4, 1.5],
        [2, 4, 1],
        [2.5, 4, 0.5],
        [3, 4, 0],
        [3.5, 3.5, 0],
        [4, 3, 0],
        [4, 2.5, 0.5],
        [4, 2, 1],
        [4, 1.5, 1.5],
        [4, 1, 2],
        [4, 0.5, 2.5]
      ];
      dashAnimStart = performance.now();
      var step = function () {
        dashAnimFrame = 0;
        if (!map || !map.getLayer(PENDING_LINE_LAYER_ID)) return;
        var vis = map.getLayoutProperty(PENDING_LINE_LAYER_ID, 'visibility');
        if (vis === 'none') return;
        var elapsed = performance.now() - dashAnimStart;
        var idx = Math.floor(elapsed / 60) % sequence.length;
        try {
          map.setPaintProperty(PENDING_LINE_LAYER_ID, 'line-dasharray', sequence[idx]);
        } catch (_e) { /* ignore if layer is gone */ }
        dashAnimFrame = requestAnimationFrame(step);
      };
      dashAnimFrame = requestAnimationFrame(step);
    }

    function stopDashAnimation() {
      if (dashAnimFrame) {
        cancelAnimationFrame(dashAnimFrame);
        dashAnimFrame = 0;
      }
    }

    function ensureLabelLayer() {
      if (!map) return;
      if (!map.getSource(ROUTE_LABEL_SOURCE_ID)) {
        map.addSource(ROUTE_LABEL_SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
      }
      if (!map.getLayer(ROUTE_LABEL_LAYER_ID)) {
        map.addLayer({
          id: ROUTE_LABEL_LAYER_ID,
          type: 'symbol',
          source: ROUTE_LABEL_SOURCE_ID,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 13,
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-anchor': 'center',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'symbol-placement': 'point'
          },
          paint: {
            'text-color': '#ffffff',
            'text-halo-color': '#003d66',
            'text-halo-width': 2
          }
        });
      }
    }

    function setPendingLine(ptA, ptB) {
      if (!map) return;
      ensurePendingLayer();
      var src = map.getSource(PENDING_SOURCE_ID);
      if (!src) return;
      if (ptA && ptB) {
        var gA = map.unproject([ptA.x, ptA.y]);
        var gB = map.unproject([ptB.x, ptB.y]);
        src.setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [gA.lng, gA.lat],
                [gB.lng, gB.lat]
              ]
            },
            properties: {}
          }]
        });
        if (map.getLayer(PENDING_LINE_LAYER_ID))
          map.setLayoutProperty(PENDING_LINE_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
      } else {
        src.setData({ type: 'FeatureCollection', features: [] });
        stopDashAnimation();
      }
    }

    function setLayersVisible(show) {
      if (!map) return;
      var v = show ? 'visible' : 'none';
      if (map.getLayer(ROUTE_LINE_LAYER_ID)) map.setLayoutProperty(ROUTE_LINE_LAYER_ID, 'visibility', v);
      if (map.getLayer(ROUTE_CASING_LAYER_ID)) map.setLayoutProperty(ROUTE_CASING_LAYER_ID, 'visibility', v);
    }

    // ---- Pin markers ----

    function makePinEl(label, color) {
      var el = document.createElement('div');
      el.style.cssText = [
        'width:18px', 'height:18px', 'border-radius:50%',
        'background:' + color, 'border:2px solid #fff',
        'display:flex', 'align-items:center', 'justify-content:center',
        'font:bold 10px/1 sans-serif', 'color:#fff', 'cursor:default',
        'transform:scale(0)'
      ].join(';');
      el.textContent = label;
      return el;
    }

    function setPinScale(state, progress) {
      if (!state.marker) return;
      var s = Math.min(1, Math.max(0, Number(progress) || 0));
      state.marker.getElement().style.transform = 'scale(' + s + ')';
    }

    function updatePin(state, lng, lat, label, color) {
      if (!map) return;
      if (!state.marker) {
        var el = makePinEl(label, color);
        state.marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
          .setLngLat([lng, lat])
          .addTo(map);
      } else {
        state.marker.setLngLat([lng, lat]);
      }
      state.marker.getElement().style.display = visible ? '' : 'none';
    }

    function removePin(state) {
      if (state.marker) { state.marker.remove(); state.marker = null; }
    }

    // ---- Directions API ----

    function routeKey(a, b) {
      return a.lng.toFixed(5) + ',' + a.lat.toFixed(5) + '|' +
             b.lng.toFixed(5) + ',' + b.lat.toFixed(5);
    }

    function haversineMeters(lng1, lat1, lng2, lat2) {
      var R = 6371000;
      var toRad = Math.PI / 180;
      var dLat = (lat2 - lat1) * toRad;
      var dLng = (lng2 - lng1) * toRad;
      var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
        + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad)
          * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    function lineLengthMeters(coords) {
      var total = 0;
      for (var i = 0; i < coords.length - 1; i++) {
        total += haversineMeters(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
      }
      return total;
    }

    function midpointAtHalfLength(coords) {
      if (!coords || coords.length < 2) return null;
      var total = lineLengthMeters(coords);
      if (!(total > 0)) return coords[0];
      var target = total / 2;
      var travelled = 0;
      for (var i = 0; i < coords.length - 1; i++) {
        var seg = haversineMeters(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
        if (travelled + seg >= target) {
          var t = seg > 0 ? (target - travelled) / seg : 0;
          return [
            coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
            coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t
          ];
        }
        travelled += seg;
      }
      return coords[coords.length - 1];
    }

    function formatDistance(meters) {
      if (!isFinite(meters) || meters < 0) return '';
      if (meters < 1000) return Math.round(meters) + ' m';
      return (meters / 1000).toFixed(meters < 10000 ? 2 : 1) + ' km';
    }

    function updateDistanceLabel(coords, distanceMeters) {
      ensureLabelLayer();
      var src = map && map.getSource(ROUTE_LABEL_SOURCE_ID);
      if (!src) return;
      var mid = midpointAtHalfLength(coords);
      if (!mid) {
        src.setData({ type: 'FeatureCollection', features: [] });
        return;
      }
      var dist = (typeof distanceMeters === 'number' && isFinite(distanceMeters))
        ? distanceMeters
        : lineLengthMeters(coords);
      src.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: mid },
          properties: { label: formatDistance(dist) }
        }]
      });
      if (map.getLayer(ROUTE_LABEL_LAYER_ID)) {
        map.setLayoutProperty(ROUTE_LABEL_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
      }
    }

    function clearDistanceLabel() {
      var src = map && map.getSource(ROUTE_LABEL_SOURCE_ID);
      if (src) src.setData({ type: 'FeatureCollection', features: [] });
    }

    function drawRouteGeometry(geom, distanceMeters) {
      ensureLayers();
      setGeoJSON({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: geom, properties: {} }]
      });
      setLayersVisible(visible);
      if (geom && geom.type === 'LineString') {
        updateDistanceLabel(geom.coordinates, distanceMeters);
      } else {
        clearDistanceLabel();
      }
      drawnRouteKey = lastRouteKey;
    }

    function fetchRouteViaMapbox(a, b) {
      var token = typeof getAccessToken === 'function' ? getAccessToken() : '';
      if (!token) {
        fetchInFlight = false;
        return;
      }
      var url = 'https://api.mapbox.com/directions/v5/mapbox/walking/'
        + a.lng.toFixed(6) + ',' + a.lat.toFixed(6) + ';'
        + b.lng.toFixed(6) + ',' + b.lat.toFixed(6)
        + '?geometries=geojson&overview=full'
        + '&access_token=' + encodeURIComponent(token);

      fetch(url)
        .then(function (res) {
          if (!res.ok) throw new Error('Directions API error: ' + res.status);
          return res.json();
        })
        .then(function (data) {
          var routes = data && data.routes;
          if (!routes || !routes.length) {
            setGeoJSON(null);
            clearDistanceLabel();
            return;
          }
          drawRouteGeometry(routes[0].geometry, routes[0].distance);
        })
        .catch(function (err) {
          console.warn('[routing] Mapbox fetch failed:', err);
        })
        .finally(function () {
          fetchInFlight = false;
        });
    }

    function fetchRoute(a, b) {
      if (fetchInFlight) return;

      var key = routeKey(a, b);
      if (key === lastRouteKey) return;
      if ((Date.now() - lastCallMs) < DEBOUNCE_MS) return;

      fetchInFlight = true;
      lastCallMs = Date.now();
      lastRouteKey = key;

      var localAvailable = !!(window.CompactOsmnx && window.CompactOsmnx.hasNetwork && window.CompactOsmnx.hasNetwork());
      if (!localAvailable) {
        fetchRouteViaMapbox(a, b);
        return;
      }

      fetch('/api/osmnx-shortest-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: a, b: b })
      })
        .then(function (res) {
          if (res.status === 404 || res.status === 409) {
            // out_of_bounds / no_graph_cached — fall back cleanly
            return res.json().then(function (body) {
              throw { fallback: true, body: body };
            });
          }
          if (!res.ok) throw new Error('osmnx ' + res.status);
          return res.json();
        })
        .then(function (data) {
          if (!data || !data.ok || !data.geometry) {
            throw { fallback: true };
          }
          drawRouteGeometry(data.geometry, data.distanceMeters);
          fetchInFlight = false;
        })
        .catch(function (err) {
          if (err && err.fallback) {
            fetchRouteViaMapbox(a, b);
          } else {
            console.warn('[routing] local path failed, falling back:', err);
            fetchRouteViaMapbox(a, b);
          }
        });
    }

    // ---- Dwell logic (shared for both tags) ----

    // Returns progress 0→1 (1 = confirmed). Negative = tag absent.
    function updateTagDwell(state, tagPoint, nowMs) {
      if (!tagPoint) {
        state.holdPoint = null;
        state.holdSinceMs = 0;
        return -1; // tag lifted
      }

      if (!state.holdPoint) {
        state.holdPoint = { x: tagPoint.x, y: tagPoint.y };
        state.holdSinceMs = nowMs;
        return 0;
      }

      var dx = tagPoint.x - state.holdPoint.x;
      var dy = tagPoint.y - state.holdPoint.y;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD_PX) {
        state.holdPoint = { x: tagPoint.x, y: tagPoint.y };
        state.holdSinceMs = nowMs;
        return 0;
      }

      return Math.min(1, (nowMs - state.holdSinceMs) / HOLD_MS);
    }

    // ---- Main update (called every poll frame) ----

    function update(tagAPoint, tagBPoint, nowMs) {
      var progressA = updateTagDwell(tagA, tagAPoint, nowMs);
      var progressB = updateTagDwell(tagB, tagBPoint, nowMs);

      // Animate pin scale while dwelling; keep at 1 after confirmed
      if (progressA < 0) {
        setPinScale(tagA, 1); // tag lifted — keep pin visible at full size
      } else {
        setPinScale(tagA, progressA);
      }
      if (progressB < 0) {
        setPinScale(tagB, 1);
      } else {
        setPinScale(tagB, progressB);
      }

      if (progressA >= 1 && tagAPoint) {
        var geo = map.unproject([tagAPoint.x, tagAPoint.y]);
        tagA.lngLat = { lng: geo.lng, lat: geo.lat };
        updatePin(tagA, geo.lng, geo.lat, 'A', '#22cc66');
      }
      if (progressB >= 1 && tagBPoint) {
        var geoB = map.unproject([tagBPoint.x, tagBPoint.y]);
        tagB.lngLat = { lng: geoB.lng, lat: geoB.lat };
        updatePin(tagB, geoB.lng, geoB.lat, 'B', '#ff5555');
      }

      // Show dashed pending line whenever both tags are visible but the
      // currently drawn route (if any) doesn't match the live endpoints yet.
      var bothPresent = (progressA >= 0 && tagAPoint) && (progressB >= 0 && tagBPoint);
      var liveKey = (tagA.lngLat && tagB.lngLat) ? routeKey(tagA.lngLat, tagB.lngLat) : '';
      var routeMatchesLive = !!liveKey && drawnRouteKey === liveKey;
      var showPending = bothPresent && !routeMatchesLive;
      setPendingLine(showPending ? tagAPoint : null,
                     showPending ? tagBPoint : null);
      if (!showPending) stopDashAnimation();

      if (tagA.lngLat && tagB.lngLat) {
        fetchRoute(tagA.lngLat, tagB.lngLat);
      }
    }

    // ---- Visibility toggle (N key) ----

    function setVisible(show) {
      visible = !!show;
      setLayersVisible(visible);
      if (map && map.getLayer(PENDING_LINE_LAYER_ID))
        map.setLayoutProperty(PENDING_LINE_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
      if (map && map.getLayer(ROUTE_LABEL_LAYER_ID))
        map.setLayoutProperty(ROUTE_LABEL_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
      if (tagA.marker) tagA.marker.getElement().style.display = visible ? '' : 'none';
      if (tagB.marker) tagB.marker.getElement().style.display = visible ? '' : 'none';
    }

    // ---- Clear ----

    function clear() {
      setGeoJSON(null);
      setPendingLine(null, null);
      clearDistanceLabel();
      stopDashAnimation();
      removePin(tagA);
      removePin(tagB);
      tagA = makeTagState();
      tagB = makeTagState();
      lastRouteKey = '';
      drawnRouteKey = '';
    }

    return {
      ensureLayers: ensureLayers,
      update: update,
      setVisible: setVisible,
      clear: clear
    };
  }

  window.CompactRouting = { createRouting: createRouting };
})();
