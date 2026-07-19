(function () {
  var NETWORK_SOURCE_ID = 'osmnx-network-source';
  var NETWORK_LAYER_ID = 'osmnx-network-layer';

  function createOsmnxNetwork(options) {
    var map = options.map;
    var hasNet = false;
    var bbox = null;
    var visible = false;
    var fetchInFlight = false;
    var networkData = null;      // last GeoJSON shown, re-applied after style reloads
    var cachedCallbacks = null;  // pending showCached() callbacks while the file loads

    function ensureLayer() {
      if (!map) return;
      if (!map.getSource(NETWORK_SOURCE_ID)) {
        map.addSource(NETWORK_SOURCE_ID, {
          type: 'geojson',
          data: networkData || { type: 'FeatureCollection', features: [] }
        });
      }
      if (!map.getLayer(NETWORK_LAYER_ID)) {
        map.addLayer({
          id: NETWORK_LAYER_ID,
          type: 'line',
          source: NETWORK_SOURCE_ID,
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
            visibility: visible ? 'visible' : 'none'
          },
          paint: {
            'line-color': '#a855f7',
            'line-width': 2,
            'line-opacity': 0.55
          }
        });
      }
    }

    function setData(geojson) {
      networkData = geojson || null;
      ensureLayer();
      var src = map && map.getSource(NETWORK_SOURCE_ID);
      if (src) src.setData(geojson || { type: 'FeatureCollection', features: [] });
    }

    function setVisible(show) {
      visible = !!show;
      ensureLayer();
      if (map && map.getLayer(NETWORK_LAYER_ID)) {
        map.setLayoutProperty(NETWORK_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
      }
    }

    function hasNetwork() {
      return hasNet;
    }

    function getBbox() {
      return bbox;
    }

    function isFetching() {
      return fetchInFlight;
    }

    // Load the network GeoJSON from the bundled data/osmnx_network.geojson (the
    // same cache the server loads for routing). Reuses whatever is already
    // loaded (cached file or a live fetch). Does NOT touch visibility — callers
    // decide that once the load lands (so a slow load can't force the layer on
    // after the caller changed its mind). callback(err, geojson).
    function loadCached(callback) {
      if (typeof callback !== 'function') callback = function () {};
      if (networkData) { callback(null, networkData); return; }
      if (cachedCallbacks) { cachedCallbacks.push(callback); return; }
      cachedCallbacks = [callback];
      fetch('data/osmnx_network.geojson')
        .then(function (res) {
          if (!res.ok) throw new Error('http_' + res.status);
          return res.json();
        })
        .then(function (geojson) {
          setData(geojson);
          var cbs = cachedCallbacks; cachedCallbacks = null;
          cbs.forEach(function (cb) { cb(null, geojson); });
        })
        .catch(function (err) {
          var cbs = cachedCallbacks; cachedCallbacks = null;
          cbs.forEach(function (cb) { cb(err, null); });
        });
    }

    // Fetch road network for the current map viewport and cache it on the server.
    function fetchForCurrentView(callback) {
      if (!map || fetchInFlight) {
        if (typeof callback === 'function') callback(new Error('busy_or_no_map'), null);
        return;
      }
      var b = map.getBounds();
      var payload = {
        minLng: b.getWest(),
        minLat: b.getSouth(),
        maxLng: b.getEast(),
        maxLat: b.getNorth(),
        networkType: 'walk'
      };

      fetchInFlight = true;
      fetch('/api/osmnx-fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          return res.json().then(function (body) { return { status: res.status, body: body }; });
        })
        .then(function (r) {
          if (r.status !== 200 || !r.body || !r.body.ok) {
            throw new Error((r.body && r.body.error) || ('http_' + r.status));
          }
          hasNet = true;
          bbox = r.body.bbox || [payload.minLng, payload.minLat, payload.maxLng, payload.maxLat];
          setData(r.body.geojson);
          setVisible(true);
          if (typeof callback === 'function') callback(null, r.body);
        })
        .catch(function (err) {
          if (typeof callback === 'function') callback(err, null);
        })
        .finally(function () {
          fetchInFlight = false;
        });
    }

    return {
      fetchForCurrentView: fetchForCurrentView,
      hasNetwork: hasNetwork,
      getBbox: getBbox,
      isFetching: isFetching,
      setVisible: setVisible,
      loadCached: loadCached
    };
  }

  window.CompactOsmnx = null; // populated by script.js after map is ready
  window.CompactOsmnxModule = { createOsmnxNetwork: createOsmnxNetwork };
})();
