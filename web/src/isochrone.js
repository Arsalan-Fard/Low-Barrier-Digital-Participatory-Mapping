(function () {
  var ISOCHRONE_SOURCE_ID = 'isochrone-source';
  var ISOCHRONE_FILL_LAYER_ID = 'isochrone-fill';
  var ISOCHRONE_OUTLINE_LAYER_ID = 'isochrone-outline';
  var ISOCHRONE_MARKER_ID = 'isochrone-marker';

  var HOLD_MS = 2000; // a tag held still this long asks for its isochrone
  var MOVE_THRESHOLD_PX = 16;
  var DEBOUNCE_MS = 500;
  var DEFAULT_MINUTES = 15;

  function normalizeMinutes(raw) {
    var n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.min(180, Math.max(1, n)) : DEFAULT_MINUTES;
  }

  function createIsochrone(options) {
    var map = options.map;
    var getAccessToken = options.getAccessToken;

    var holdSinceMs = 0;
    var holdPoint = null; // viewport px
    var lastCallMs = 0;
    var lastFetchedLngLat = null;
    var visible = true;
    var fetchInFlight = false;
    var pinMarker = null;
    var activeMinutes = DEFAULT_MINUTES;
    var queued = null; // a mouse request made while a fetch was out: { lng, lat, minutes, done }

    function ensureLayers() {
      if (!map.getSource(ISOCHRONE_SOURCE_ID)) {
        map.addSource(ISOCHRONE_SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
      }
      if (!map.getLayer(ISOCHRONE_FILL_LAYER_ID)) {
        map.addLayer({
          id: ISOCHRONE_FILL_LAYER_ID,
          type: 'fill',
          source: ISOCHRONE_SOURCE_ID,
          paint: {
            'fill-color': '#00aaff',
            'fill-opacity': 0.18
          }
        });
      }
      if (!map.getLayer(ISOCHRONE_OUTLINE_LAYER_ID)) {
        map.addLayer({
          id: ISOCHRONE_OUTLINE_LAYER_ID,
          type: 'line',
          source: ISOCHRONE_SOURCE_ID,
          paint: {
            'line-color': '#00aaff',
            'line-width': 2.5,
            'line-opacity': 0.85
          }
        });
      }
    }

    function setGeoJSON(geojson) {
      var src = map.getSource(ISOCHRONE_SOURCE_ID);
      if (src) src.setData(geojson || { type: 'FeatureCollection', features: [] });
    }

    function setLayersVisible(show) {
      var v = show ? 'visible' : 'none';
      if (map.getLayer(ISOCHRONE_FILL_LAYER_ID)) map.setLayoutProperty(ISOCHRONE_FILL_LAYER_ID, 'visibility', v);
      if (map.getLayer(ISOCHRONE_OUTLINE_LAYER_ID)) map.setLayoutProperty(ISOCHRONE_OUTLINE_LAYER_ID, 'visibility', v);
    }

    // The pin marks where the isochrone starts.
    function updatePinMarker(lng, lat) {
      if (!pinMarker) {
        // The marker places its element with a transform, so the pin's grow-in scale goes on a child.
        var el = document.createElement('div');
        el.id = ISOCHRONE_MARKER_ID;
        var dot = document.createElement('div');
        dot.style.cssText = [
          'width:14px', 'height:14px', 'border-radius:50%',
          'background:#00aaff', 'border:2.5px solid #fff',
          'box-shadow:0 0 0 2px #00aaff', 'cursor:default'
        ].join(';');
        el.appendChild(dot);
        pinMarker = new mapboxgl.Marker({ element: el, anchor: 'center' })
          .setLngLat([lng, lat])
          .addTo(map);
      } else {
        pinMarker.setLngLat([lng, lat]);
      }
      pinMarker.getElement().style.display = visible ? '' : 'none';
    }

    function setPinScale(progress) {
      if (!pinMarker) return;
      var s = Math.min(1, Math.max(0, Number(progress) || 0));
      pinMarker.getElement().firstChild.style.transform = 'scale(' + s + ')';
    }

    function applyIsochroneResult(lng, lat, geojson) {
      ensureLayers();
      setGeoJSON(geojson);
      setLayersVisible(visible);
      updatePinMarker(lng, lat);
    }

    // done(ok), when given, hears whether this fetch drew a reach; a queued mouse request goes next.
    function finishFetch(done, ok) {
      fetchInFlight = false;
      if (typeof done === 'function') done(!!ok);
      if (queued) {
        var next = queued;
        queued = null;
        fetchIsochrone(next.lng, next.lat, next.minutes, next.done);
      }
    }

    function fetchIsochroneViaMapbox(lng, lat, minutes, done) {
      var token = getAccessToken();
      if (!token) {
        finishFetch(done, false);
        return;
      }
      var ok = false;
      var url = 'https://api.mapbox.com/isochrone/v1/mapbox/walking/'
        + lng.toFixed(6) + ',' + lat.toFixed(6)
        + '?contours_minutes=' + encodeURIComponent(String(minutes))
        + '&polygons=true'
        + '&access_token=' + encodeURIComponent(token);

      fetch(url)
        .then(function (res) {
          if (!res.ok) throw new Error('Isochrone API error: ' + res.status);
          return res.json();
        })
        .then(function (geojson) {
          applyIsochroneResult(lng, lat, geojson);
          ok = true;
        })
        .catch(function (err) {
          console.warn('[isochrone] Mapbox fetch failed:', err);
        })
        .finally(function () {
          finishFetch(done, ok);
        });
    }

    function fetchIsochrone(lng, lat, minutes, done) {
      if (fetchInFlight) return;
      fetchInFlight = true;
      lastCallMs = Date.now();
      lastFetchedLngLat = { lng: lng, lat: lat };

      // The server's saved walking network first; Mapbox when it has none or the point is outside it.
      fetch('/api/osmnx-isochrone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: { lng: lng, lat: lat }, minutes: minutes })
      })
        .then(function (res) {
          // 404/409: the origin is outside the cached graph, or there is no graph yet.
          if (res.status === 404 || res.status === 409) throw { fallback: true };
          if (!res.ok) throw new Error('osmnx-isochrone ' + res.status);
          return res.json();
        })
        .then(function (data) {
          if (!data || !data.ok || !data.geojson) throw { fallback: true };
          applyIsochroneResult(lng, lat, data.geojson);
          finishFetch(done, true);
        })
        .catch(function (err) {
          if (!(err && err.fallback)) console.warn('[isochrone] local reach failed, falling back:', err);
          fetchIsochroneViaMapbox(lng, lat, minutes, done);
        });
    }

    // The mouse: the reach from a clicked point, asked for at once (or right after the fetch already
    // out). The old reach goes and the pin moves straight away. done(ok) hears whether it worked.
    function showAt(lng, lat, minutes, done) {
      lng = Number(lng);
      lat = Number(lat);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
      activeMinutes = normalizeMinutes(minutes);
      holdSinceMs = 0;
      holdPoint = null;
      // No ensureLayers here: it throws while a basemap is still loading; the result adds them.
      setGeoJSON(null);
      updatePinMarker(lng, lat);
      setPinScale(1);
      if (fetchInFlight) {
        queued = { lng: lng, lat: lat, minutes: activeMinutes, done: done };
        return;
      }
      fetchIsochrone(lng, lat, activeMinutes, done);
    }

    // tagPoint: viewport px, or null when no isochrone tag is seen.
    function update(tagPoint, nowMs, minutes) {
      var nextMinutes = normalizeMinutes(minutes);
      if (nextMinutes !== activeMinutes) {
        activeMinutes = nextMinutes;
        lastFetchedLngLat = null;
      }
      if (!tagPoint) {
        holdSinceMs = 0;
        holdPoint = null;
        setPinScale(1);
        return;
      }

      var moved = !holdPoint;
      if (holdPoint) {
        var dx = tagPoint.x - holdPoint.x;
        var dy = tagPoint.y - holdPoint.y;
        moved = Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD_PX;
      }
      if (moved) {
        holdPoint = { x: tagPoint.x, y: tagPoint.y };
        holdSinceMs = nowMs;
        setPinScale(0);
        return;
      }

      var elapsed = nowMs - holdSinceMs;
      setPinScale(Math.min(1, elapsed / HOLD_MS));
      if (elapsed < HOLD_MS) return;
      if ((nowMs - lastCallMs) < DEBOUNCE_MS) return;

      var geo = map.unproject([tagPoint.x, tagPoint.y]);
      if (lastFetchedLngLat
          && Math.abs(geo.lng - lastFetchedLngLat.lng) < 0.00005
          && Math.abs(geo.lat - lastFetchedLngLat.lat) < 0.00005) return;
      fetchIsochrone(geo.lng, geo.lat, activeMinutes);
    }

    function setVisible(show) {
      visible = !!show;
      setLayersVisible(visible);
      if (pinMarker) pinMarker.getElement().style.display = visible ? '' : 'none';
    }

    function clear() {
      setGeoJSON(null);
      if (pinMarker) {
        pinMarker.remove();
        pinMarker = null;
      }
      holdSinceMs = 0;
      holdPoint = null;
      lastFetchedLngLat = null;
      queued = null;
    }

    return {
      ensureLayers: ensureLayers,
      update: update,
      showAt: showAt,
      setVisible: setVisible,
      clear: clear
    };
  }

  window.CompactIsochrone = { createIsochrone: createIsochrone };
})();
