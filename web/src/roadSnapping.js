// The roads layer: data/roads.geojson drawn over the basemap (O key, workshop data layer 'roads').
(function () {
  var roadsGeoJSON = null;
  var roadsVisible = false;
  var roadsSourceId = 'roads-source';
  var roadsLayerId = 'roads-layer';
  var ROADS_URL = 'data/roads.geojson';

  function createRoadSnapping(options) {
    var map = options.map;

    function loadRoads(callback) {
      if (roadsGeoJSON) {
        callback(null, roadsGeoJSON);
        return;
      }
      fetch(ROADS_URL)
        .then(function (res) { return res.json(); })
        .then(function (data) {
          roadsGeoJSON = data;
          callback(null, data);
        })
        .catch(function (err) { callback(err, null); });
    }

    function ensureRoadsLayer() {
      if (!map.getSource(roadsSourceId)) {
        map.addSource(roadsSourceId, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
      }
      if (!map.getLayer(roadsLayerId)) {
        map.addLayer({
          id: roadsLayerId,
          type: 'line',
          source: roadsSourceId,
          paint: {
            'line-color': '#0066ff',
            'line-width': 2,
            'line-opacity': 0.5
          },
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            visibility: 'none'
          }
        });
      }
    }

    function toggleRoads() {
      loadRoads(function (err, data) {
        if (err) {
          console.error('Failed to load roads:', err);
          return;
        }
        ensureRoadsLayer();
        roadsVisible = !roadsVisible;
        if (roadsVisible) map.getSource(roadsSourceId).setData(data);
        map.setLayoutProperty(roadsLayerId, 'visibility', roadsVisible ? 'visible' : 'none');
      });
    }

    function isRoadsVisible() {
      return roadsVisible;
    }

    // Unlike toggleRoads, showing always re-sets the data, so the layer recovers after a basemap reload.
    function setRoadsVisible(show) {
      if (!show) {
        roadsVisible = false;
        if (map.getLayer(roadsLayerId)) map.setLayoutProperty(roadsLayerId, 'visibility', 'none');
        return;
      }
      loadRoads(function (err, data) {
        if (err) {
          console.error('Failed to load roads:', err);
          return;
        }
        ensureRoadsLayer();
        map.getSource(roadsSourceId).setData(data);
        map.setLayoutProperty(roadsLayerId, 'visibility', 'visible');
        roadsVisible = true;
      });
    }

    return {
      ensureRoadsLayer: ensureRoadsLayer,
      toggleRoads: toggleRoads,
      isRoadsVisible: isRoadsVisible,
      setRoadsVisible: setRoadsVisible,
      loadRoads: loadRoads
    };
  }

  window.CompactRoadSnapping = { createRoadSnapping: createRoadSnapping };
})();
