(function () {
  var NETWORK_SOURCE_ID = 'osmnx-network-source';
  var NETWORK_LAYER_ID = 'osmnx-network-layer';

  function createOsmnxNetwork(options) {
    var map = options.map;
    var hasNet = false;
    var bbox = null;
    var visible = false;
    var fetchInFlight = false;

    function ensureLayer() {
      if (!map) return;
      if (!map.getSource(NETWORK_SOURCE_ID)) {
        map.addSource(NETWORK_SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
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
      setVisible: setVisible
    };
  }

  window.CompactOsmnx = null; // populated by script.js after map is ready
  window.CompactOsmnxModule = { createOsmnxNetwork: createOsmnxNetwork };
})();
