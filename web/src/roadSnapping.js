(function () {
  var roadsGeoJSON = null;
  var roadsVisible = false;
  var roadsSourceId = 'roads-source';
  var roadsLayerId = 'roads-layer';
  var snappedSourceId = 'snapped-source';
  var snappedGlowLayerId = 'snapped-glow-layer';
  var snappedLayerId = 'snapped-layer';

  function createRoadSnapping(options) {
    var map = options.map;
    var drawSourceId = options.drawSourceId || 'draw-source';
    var roadsUrl = options.roadsUrl || 'data/roads.geojson';

    // Load roads GeoJSON once
    function loadRoads(callback) {
      if (roadsGeoJSON) { callback(null, roadsGeoJSON); return; }
      fetch(roadsUrl)
        .then(function (res) { return res.json(); })
        .then(function (data) {
          roadsGeoJSON = data;
          callback(null, data);
        })
        .catch(function (err) { callback(err, null); });
    }

    // Ensure map layers for road display
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

    // Ensure snapped drawings layer
    function ensureSnappedLayer() {
      if (!map.getSource(snappedSourceId)) {
        map.addSource(snappedSourceId, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
      }
      if (!map.getLayer(snappedLayerId)) {
        map.addLayer({
          id: snappedLayerId,
          type: 'line',
          source: snappedSourceId,
          paint: {
            'line-color': ['coalesce', ['get', 'color'], '#ff5b5b'],
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

    // Toggle road visibility (O key)
    function toggleRoads() {
      loadRoads(function (err, data) {
        if (err) { console.error('Failed to load roads:', err); return; }
        ensureRoadsLayer();
        roadsVisible = !roadsVisible;
        if (roadsVisible) {
          map.getSource(roadsSourceId).setData(data);
          map.setLayoutProperty(roadsLayerId, 'visibility', 'visible');
        } else {
          map.setLayoutProperty(roadsLayerId, 'visibility', 'none');
        }
      });
      return roadsVisible;
    }

    function isRoadsVisible() {
      return roadsVisible;
    }

    // Deterministic show/hide (used by the workshop per-step data layers).
    // Unlike toggleRoads, showing always re-sets the source data so the layer
    // also recovers after a basemap style reload wiped it.
    function setRoadsVisible(show, callback) {
      if (!show) {
        roadsVisible = false;
        if (map.getLayer(roadsLayerId)) {
          map.setLayoutProperty(roadsLayerId, 'visibility', 'none');
        }
        if (typeof callback === 'function') callback(null, false);
        return;
      }
      loadRoads(function (err, data) {
        if (err) {
          console.error('Failed to load roads:', err);
          if (typeof callback === 'function') callback(err, roadsVisible);
          return;
        }
        ensureRoadsLayer();
        map.getSource(roadsSourceId).setData(data);
        map.setLayoutProperty(roadsLayerId, 'visibility', 'visible');
        roadsVisible = true;
        if (typeof callback === 'function') callback(null, true);
      });
    }

    // --- Snapping logic (no Turf dependency) ---

    // Snap geometry (vertex-snap + follow-road) is shared via src/roadSnapGeometry.js.
    var snapLineString = window.CompactRoadSnapGeometry.snapLineString;

    // Snap all current drawings (M key)
    function snapAllDrawings() {
      loadRoads(function (err, roads) {
        if (err) { console.error('Failed to load roads:', err); return; }

        var drawSource = map.getSource(drawSourceId);
        if (!drawSource) return;

        // Get current draw data via internal _data
        var drawData = drawSource._data;
        if (!drawData || !drawData.features || drawData.features.length === 0) return;

        ensureSnappedLayer();

        // Max snap distance in degrees (~200m at this latitude)
        var maxSnapDeg = 0.002;

        var snappedFeatures = [];
        for (var i = 0; i < drawData.features.length; i++) {
          var feature = drawData.features[i];
          if (feature.geometry.type !== 'LineString') continue;

          var snappedCoords = snapLineString(feature.geometry.coordinates, roads, maxSnapDeg);
          snappedFeatures.push({
            type: 'Feature',
            properties: {
              tagId: feature.properties.tagId,
              color: feature.properties.color,
              snapped: true
            },
            geometry: {
              type: 'LineString',
              coordinates: snappedCoords
            }
          });
        }

        map.getSource(snappedSourceId).setData({
          type: 'FeatureCollection',
          features: snappedFeatures
        });
      });

      return true;
    }

    return {
      ensureRoadsLayer: ensureRoadsLayer,
      ensureSnappedLayer: ensureSnappedLayer,
      toggleRoads: toggleRoads,
      isRoadsVisible: isRoadsVisible,
      setRoadsVisible: setRoadsVisible,
      snapAllDrawings: snapAllDrawings,
      loadRoads: loadRoads
    };
  }

  window.CompactRoadSnapping = { createRoadSnapping: createRoadSnapping };
})();
