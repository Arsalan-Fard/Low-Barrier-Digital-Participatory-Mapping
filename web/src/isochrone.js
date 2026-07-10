(function () {
  var ISOCHRONE_SOURCE_ID = 'isochrone-source';
  var ISOCHRONE_FILL_LAYER_ID = 'isochrone-fill';
  var ISOCHRONE_OUTLINE_LAYER_ID = 'isochrone-outline';
  var ISOCHRONE_MARKER_ID = 'isochrone-marker';

  var HOLD_MS = 2000;          // tag must be still for 2 s before triggering
  var MOVE_THRESHOLD_PX = 16;  // px movement that resets the hold timer
  var DEBOUNCE_MS = 500;       // minimum ms between consecutive API calls
  var DEFAULT_MINUTES = 15;

  function normalizeMinutes(raw) {
    var n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.min(180, Math.max(1, n)) : DEFAULT_MINUTES;
  }

  function createIsochrone(options) {
    var map = options.map;
    var getAccessToken = options.getAccessToken;
    var projectLngLatToPx = typeof options.projectLngLatToPx === 'function'
      ? options.projectLngLatToPx : null;

    // Runtime state
    var holdSinceMs = 0;
    var holdPoint = null;       // { x, y } viewport px
    var lastCallMs = 0;
    var lastFetchedLngLat = null;
    var visible = true;
    var fetchInFlight = false;
    var pinMarker = null;
    var activeMinutes = DEFAULT_MINUTES;

    // ---- Map layer management ----

    function ensureLayers() {
      if (!map) return;
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
      if (!map || !map.getSource(ISOCHRONE_SOURCE_ID)) return;
      map.getSource(ISOCHRONE_SOURCE_ID).setData(geojson || { type: 'FeatureCollection', features: [] });
    }

    function setLayersVisible(show) {
      if (!map) return;
      var v = show ? 'visible' : 'none';
      if (map.getLayer(ISOCHRONE_FILL_LAYER_ID)) map.setLayoutProperty(ISOCHRONE_FILL_LAYER_ID, 'visibility', v);
      if (map.getLayer(ISOCHRONE_OUTLINE_LAYER_ID)) map.setLayoutProperty(ISOCHRONE_OUTLINE_LAYER_ID, 'visibility', v);
    }

    // ---- Pin marker (shows the origin point) ----

    function updatePinMarker(lng, lat) {
      if (!map) return;
      if (!pinMarker) {
        var el = document.createElement('div');
        el.id = ISOCHRONE_MARKER_ID;
        el.style.cssText = [
          'width:14px', 'height:14px', 'border-radius:50%',
          'background:#00aaff', 'border:2.5px solid #fff',
          'box-shadow:0 0 0 2px #00aaff', 'cursor:default'
        ].join(';');
        pinMarker = new mapboxgl.Marker({ element: el, anchor: 'center' })
          .setLngLat([lng, lat])
          .addTo(map);
      } else {
        pinMarker.setLngLat([lng, lat]);
      }
      var pel = pinMarker.getElement();
      pel.style.display = visible ? '' : 'none';
    }

    function setPinScale(progress) {
      if (!pinMarker) return;
      var s = Math.min(1, Math.max(0, Number(progress) || 0));
      pinMarker.getElement().style.transform = 'scale(' + s + ')';
    }

    function removePinMarker() {
      if (pinMarker) {
        pinMarker.remove();
        pinMarker = null;
      }
    }

    // ---- Isochrone API fetch ----

    function applyIsochroneResult(lng, lat, geojson) {
      ensureLayers();
      setGeoJSON(geojson);
      setLayersVisible(visible);
      updatePinMarker(lng, lat);
    }

    function fetchIsochroneViaMapbox(lng, lat, minutes) {
      var token = typeof getAccessToken === 'function' ? getAccessToken() : '';
      if (!token) {
        fetchInFlight = false;
        return;
      }
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
        })
        .catch(function (err) {
          console.warn('[isochrone] Mapbox fetch failed:', err);
        })
        .finally(function () {
          fetchInFlight = false;
        });
    }

    function fetchIsochrone(lng, lat, minutes) {
      if (fetchInFlight) return;
      fetchInFlight = true;
      lastCallMs = Date.now();
      lastFetchedLngLat = { lng: lng, lat: lat };

      var localAvailable = !!(window.CompactOsmnx && window.CompactOsmnx.hasNetwork && window.CompactOsmnx.hasNetwork());
      if (!localAvailable) {
        fetchIsochroneViaMapbox(lng, lat, minutes);
        return;
      }

      fetch('/api/osmnx-isochrone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: { lng: lng, lat: lat }, minutes: minutes })
      })
        .then(function (res) {
          if (res.status === 404 || res.status === 409) {
            return res.json().then(function (body) {
              throw { fallback: true, body: body };
            });
          }
          if (!res.ok) throw new Error('osmnx-isochrone ' + res.status);
          return res.json();
        })
        .then(function (data) {
          if (!data || !data.ok || !data.geojson) {
            throw { fallback: true };
          }
          applyIsochroneResult(lng, lat, data.geojson);
          fetchInFlight = false;
        })
        .catch(function (err) {
          if (!(err && err.fallback)) {
            console.warn('[isochrone] local reach failed, falling back:', err);
          }
          fetchIsochroneViaMapbox(lng, lat, minutes);
        });
    }

    // ---- Main update (called every poll frame) ----
    // tagPoint: { x, y } in viewport px, or null if tag 37 not visible

    function update(tagPoint, nowMs, minutes) {
      var nextMinutes = normalizeMinutes(minutes);
      if (nextMinutes !== activeMinutes) {
        activeMinutes = nextMinutes;
        lastFetchedLngLat = null;
      }
      if (!tagPoint) {
        holdSinceMs = 0;
        holdPoint = null;
        setPinScale(1); // keep pin at full size after placement
        return;
      }

      if (!holdPoint) {
        holdPoint = { x: tagPoint.x, y: tagPoint.y };
        holdSinceMs = nowMs;
        setPinScale(0);
        return;
      }

      var dx = tagPoint.x - holdPoint.x;
      var dy = tagPoint.y - holdPoint.y;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD_PX) {
        holdPoint = { x: tagPoint.x, y: tagPoint.y };
        holdSinceMs = nowMs;
        setPinScale(0);
        return;
      }

      var elapsed = nowMs - holdSinceMs;
      var progress = Math.min(1, elapsed / HOLD_MS);
      setPinScale(progress);

      if (elapsed < HOLD_MS) return;
      if ((nowMs - lastCallMs) < DEBOUNCE_MS) return;

      var geo = map.unproject([tagPoint.x, tagPoint.y]);
      var lng = geo.lng;
      var lat = geo.lat;

      if (lastFetchedLngLat) {
        var dlng = Math.abs(lng - lastFetchedLngLat.lng);
        var dlat = Math.abs(lat - lastFetchedLngLat.lat);
        if (dlng < 0.00005 && dlat < 0.00005) return;
      }

      fetchIsochrone(lng, lat, activeMinutes);
    }

    // ---- Visibility toggle (respects the N key) ----

    function setVisible(show) {
      visible = !!show;
      setLayersVisible(visible);
      if (pinMarker) {
        pinMarker.getElement().style.display = visible ? '' : 'none';
      }
    }

    // ---- Clear ----

    function clear() {
      setGeoJSON(null);
      removePinMarker();
      holdSinceMs = 0;
      holdPoint = null;
      lastFetchedLngLat = null;
    }

    return {
      ensureLayers: ensureLayers,
      update: update,
      setVisible: setVisible,
      clear: clear
    };
  }

  window.CompactIsochrone = { createIsochrone: createIsochrone };
})();
