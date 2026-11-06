// The walking network the server routes on (data/osmnx_network.geojson), shown as a data layer.
(function () {
  var NETWORK_SOURCE_ID = 'osmnx-network-source';
  var NETWORK_LAYER_ID = 'osmnx-network-layer';

  function createOsmnxNetwork(options) {
    var map = options.map;
    var visible = false;
    var networkData = null; // the GeoJSON on the map, put back after a basemap reload
    var cachedCallbacks = null; // loadCached callbacks waiting for the file

    function ensureLayer() {
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
      map.getSource(NETWORK_SOURCE_ID).setData(geojson || { type: 'FeatureCollection', features: [] });
    }

    function setVisible(show) {
      visible = !!show;
      ensureLayer();
      map.setLayoutProperty(NETWORK_LAYER_ID, 'visibility', visible ? 'visible' : 'none');
    }

    // Loads data/osmnx_network.geojson, the network the server routes on, once. Visibility is
    // left to the caller, so a slow load cannot turn the layer on after the caller changed its mind.
    function loadCached(callback) {
      if (networkData) {
        callback(null, networkData);
        return;
      }
      if (cachedCallbacks) {
        cachedCallbacks.push(callback);
        return;
      }
      cachedCallbacks = [callback];
      function finish(err, geojson) {
        var callbacks = cachedCallbacks;
        cachedCallbacks = null;
        callbacks.forEach(function (cb) { cb(err, geojson); });
      }
      fetch('data/osmnx_network.geojson')
        .then(function (res) {
          if (!res.ok) throw new Error('http_' + res.status);
          return res.json();
        })
        .then(function (geojson) {
          setData(geojson);
          finish(null, geojson);
        })
        .catch(function (err) {
          finish(err, null);
        });
    }

    return {
      setVisible: setVisible,
      loadCached: loadCached
    };
  }

  window.CompactOsmnxModule = { createOsmnxNetwork: createOsmnxNetwork };
})();
