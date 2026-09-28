(function () {
  var ROUTE_SOURCE_ID = 'routing-source';
  var ROUTE_LINE_LAYER_ID = 'routing-line';
  var ROUTE_CASING_LAYER_ID = 'routing-casing';
  var ROUTE_LABEL_SOURCE_ID = 'routing-label-source';
  var ROUTE_LABEL_LAYER_ID = 'routing-label';

  var PENDING_SOURCE_ID = 'routing-pending-source';
  var PENDING_LINE_LAYER_ID = 'routing-pending-line';

  var HOLD_MS = 2000; // a tag held still this long sets its end of the route
  var MOVE_THRESHOLD_PX = 16;
  var DEBOUNCE_MS = 500;
  // MapLibre has no line-dash-offset, so the dashes are made to travel by cycling the pattern.
  var DASH_SEQUENCE = [
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

  function emptyCollection() {
    return { type: 'FeatureCollection', features: [] };
  }

  function makeTagState() {
    return { holdPoint: null, holdSinceMs: 0, lngLat: null, marker: null };
  }

  function createRouting(options) {
    var map = options.map;
    var getAccessToken = options.getAccessToken;

    var tagA = makeTagState();
    var tagB = makeTagState();
    var lastCallMs = 0;
    var lastRouteKey = '';
    var drawnRouteKey = ''; // the endpoints of the route on the map
    var fetchInFlight = false;
    var visible = true;
    var dashAnimFrame = 0;
    var dashAnimStart = 0;

    function ensureLayers() {
      if (!map.getSource(ROUTE_SOURCE_ID)) {
        map.addSource(ROUTE_SOURCE_ID, { type: 'geojson', data: emptyCollection() });
      }
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
      var src = map.getSource(ROUTE_SOURCE_ID);
      if (src) src.setData(geojson || emptyCollection());
    }

    function ensurePendingLayer() {
      if (!map.getSource(PENDING_SOURCE_ID)) {
        map.addSource(PENDING_SOURCE_ID, { type: 'geojson', data: emptyCollection() });
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
    }

    // The dashes travel along the pending line while the route is on its way.
    function startDashAnimation() {
      if (dashAnimFrame) return;
      dashAnimStart = performance.now();
      var step = function () {
        dashAnimFrame = 0;
        if (!map.getLayer(PENDING_LINE_LAYER_ID)) return;
        if (map.getLayoutProperty(PENDING_LINE_LAYER_ID, 'visibility') === 'none') return;
        var idx = Math.floor((performance.now() - dashAnimStart) / 60) % DASH_SEQUENCE.length;
        map.setPaintProperty(PENDING_LINE_LAYER_ID, 'line-dasharray', DASH_SEQUENCE[idx]);
        dashAnimFrame = requestAnimationFrame(step);
      };
      dashAnimFrame = requestAnimationFrame(step);
    }

    function stopDashAnimation() {
      if (!dashAnimFrame) return;
      cancelAnimationFrame(dashAnimFrame);
      dashAnimFrame = 0;
    }

    function ensureLabelLayer() {
      if (!map.getSource(ROUTE_LABEL_SOURCE_ID)) {
        map.addSource(ROUTE_LABEL_SOURCE_ID, { type: 'geojson', data: emptyCollection() });
      }
      if (!map.getLayer(ROUTE_LABEL_LAYER_ID)) {
        map.addLayer({
          id: ROUTE_LABEL_LAYER_ID,
          type: 'symbol',
          source: ROUTE_LABEL_SOURCE_ID,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 13,
            'text-font': window.CompactMapSetup.labelFont(map, ['Open Sans Bold', 'Arial Unicode MS Bold']),
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
      ensurePendingLayer();
      var src = map.getSource(PENDING_SOURCE_ID);
      if (!ptA || !ptB) {
        src.setData(emptyCollection());
        stopDashAnimation();
        return;
      }
      var gA = map.unproject([ptA.x, ptA.y]);
      var gB = map.unproject([ptB.x, ptB.y]);
      src.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[gA.lng, gA.lat], [gB.lng, gB.lat]] },
          properties: {}
        }]
      });
      map.setLayoutProperty(PENDING_LINE_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
      startDashAnimation();
    }

    function setLayersVisible(show) {
      var v = show ? 'visible' : 'none';
      if (map.getLayer(ROUTE_LINE_LAYER_ID)) map.setLayoutProperty(ROUTE_LINE_LAYER_ID, 'visibility', v);
      if (map.getLayer(ROUTE_CASING_LAYER_ID)) map.setLayoutProperty(ROUTE_CASING_LAYER_ID, 'visibility', v);
    }

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
      if (!state.marker) {
        state.marker = new mapboxgl.Marker({ element: makePinEl(label, color), anchor: 'center' })
          .setLngLat([lng, lat])
          .addTo(map);
      } else {
        state.marker.setLngLat([lng, lat]);
      }
      state.marker.getElement().style.display = visible ? '' : 'none';
    }

    function removePin(state) {
      if (!state.marker) return;
      state.marker.remove();
      state.marker = null;
    }

    function routeKey(a, b) {
      return a.lng.toFixed(5) + ',' + a.lat.toFixed(5) + '|' + b.lng.toFixed(5) + ',' + b.lat.toFixed(5);
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
      var src = map.getSource(ROUTE_LABEL_SOURCE_ID);
      var mid = midpointAtHalfLength(coords);
      if (!mid) {
        src.setData(emptyCollection());
        return;
      }
      var hasDistance = typeof distanceMeters === 'number' && isFinite(distanceMeters);
      src.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: mid },
          properties: { label: formatDistance(hasDistance ? distanceMeters : lineLengthMeters(coords)) }
        }]
      });
      map.setLayoutProperty(ROUTE_LABEL_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
    }

    function clearDistanceLabel() {
      var src = map.getSource(ROUTE_LABEL_SOURCE_ID);
      if (src) src.setData(emptyCollection());
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
      var token = getAccessToken();
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

      if (!window.CompactOsmnx.hasNetwork()) {
        fetchRouteViaMapbox(a, b);
        return;
      }
      fetch('/api/osmnx-shortest-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: a, b: b })
      })
        .then(function (res) {
          // 404/409: the ends are outside the cached graph, or there is no graph yet.
          if (res.status === 404 || res.status === 409) throw { fallback: true };
          if (!res.ok) throw new Error('osmnx ' + res.status);
          return res.json();
        })
        .then(function (data) {
          if (!data || !data.ok || !data.geometry) throw { fallback: true };
          drawRouteGeometry(data.geometry, data.distanceMeters);
          fetchInFlight = false;
        })
        .catch(function (err) {
          if (!(err && err.fallback)) console.warn('[routing] local path failed, falling back:', err);
          fetchRouteViaMapbox(a, b);
        });
    }

    // The progress 0..1 of a tag's hold (1 sets its end), or -1 when the tag is gone.
    function updateTagDwell(state, tagPoint, nowMs) {
      if (!tagPoint) {
        state.holdPoint = null;
        state.holdSinceMs = 0;
        return -1;
      }
      if (state.holdPoint) {
        var dx = tagPoint.x - state.holdPoint.x;
        var dy = tagPoint.y - state.holdPoint.y;
        if (Math.sqrt(dx * dx + dy * dy) <= MOVE_THRESHOLD_PX) {
          return Math.min(1, (nowMs - state.holdSinceMs) / HOLD_MS);
        }
      }
      state.holdPoint = { x: tagPoint.x, y: tagPoint.y };
      state.holdSinceMs = nowMs;
      return 0;
    }

    function update(tagAPoint, tagBPoint, nowMs) {
      var progressA = updateTagDwell(tagA, tagAPoint, nowMs);
      var progressB = updateTagDwell(tagB, tagBPoint, nowMs);
      // A lifted tag leaves its pin at full size.
      setPinScale(tagA, progressA < 0 ? 1 : progressA);
      setPinScale(tagB, progressB < 0 ? 1 : progressB);

      if (progressA >= 1) {
        var geoA = map.unproject([tagAPoint.x, tagAPoint.y]);
        tagA.lngLat = { lng: geoA.lng, lat: geoA.lat };
        updatePin(tagA, geoA.lng, geoA.lat, 'A', '#22cc66');
      }
      if (progressB >= 1) {
        var geoB = map.unproject([tagBPoint.x, tagBPoint.y]);
        tagB.lngLat = { lng: geoB.lng, lat: geoB.lat };
        updatePin(tagB, geoB.lng, geoB.lat, 'B', '#ff5555');
      }

      // The dashed line shows while both tags are down and the drawn route is not yet theirs.
      var liveKey = (tagA.lngLat && tagB.lngLat) ? routeKey(tagA.lngLat, tagB.lngLat) : '';
      var showPending = !!(tagAPoint && tagBPoint) && !(liveKey && drawnRouteKey === liveKey);
      setPendingLine(showPending ? tagAPoint : null, showPending ? tagBPoint : null);

      if (tagA.lngLat && tagB.lngLat) fetchRoute(tagA.lngLat, tagB.lngLat);
    }

    function setVisible(show) {
      visible = !!show;
      var v = visible ? 'visible' : 'none';
      setLayersVisible(visible);
      if (map.getLayer(PENDING_LINE_LAYER_ID)) map.setLayoutProperty(PENDING_LINE_LAYER_ID, 'visibility', v);
      if (map.getLayer(ROUTE_LABEL_LAYER_ID)) map.setLayoutProperty(ROUTE_LABEL_LAYER_ID, 'visibility', v);
      if (tagA.marker) tagA.marker.getElement().style.display = visible ? '' : 'none';
      if (tagB.marker) tagB.marker.getElement().style.display = visible ? '' : 'none';
    }

    function clear() {
      setGeoJSON(null);
      setPendingLine(null, null);
      clearDistanceLabel();
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
