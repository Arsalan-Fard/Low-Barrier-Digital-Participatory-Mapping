(function () {
  // app.py fills in the token (from token.txt) and markerSettings when it serves this
  // file; the placeholder is split so that substitution leaves this copy alone.
  var TOKEN_PLACEHOLDER = '__' + 'MAPBOX_TOKEN' + '__';
  var accessToken = '__MAPBOX_TOKEN__';
  var hasMapboxToken = !!accessToken && accessToken !== TOKEN_PLACEHOLDER;
  var OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  var ESRI_ATTRIBUTION = 'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics';
  var OPENTOPO_ATTRIBUTION = 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Tiles: &copy; <a href="https://opentopomap.org/">OpenTopoMap</a> (CC-BY-SA)';
  var GLYPHS_URL = 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf';

  function rasterStyle(id, opts) {
    opts = opts || {};
    var sourceId = id + '-source';
    return {
      version: 8,
      glyphs: GLYPHS_URL,
      sources: {
        [sourceId]: {
          type: 'raster',
          tiles: opts.tiles || ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: opts.attribution || OSM_ATTRIBUTION
        }
      },
      layers: [
        {
          id: id + '-tiles',
          type: 'raster',
          source: sourceId,
          minzoom: 0,
          maxzoom: opts.maxzoom || 19,
          paint: {}
        }
      ]
    };
  }

  const CONFIG = {
    accessToken: accessToken,
    useMapboxServices: hasMapboxToken,
    attributionControl: true,
    style: rasterStyle('osm-streets'),
    center: [2.2085, 48.7116],
    zoom: 16,
    pitch: 0,
    bearing: 0,
    markerSettings: null,
    themeCycle: ['streets', 'satellite', 'topo', 'paper'],
    styles: {
      streets: rasterStyle('osm-streets'),
      satellite: rasterStyle('esri-satellite', {
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        attribution: ESRI_ATTRIBUTION,
        maxzoom: 19
      }),
      // OpenTopoMap serves no tiles past z17.
      topo: rasterStyle('opentopo', {
        tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
        attribution: OPENTOPO_ATTRIBUTION,
        maxzoom: 17
      }),
      // A plain base; the map page draws the plan from /api/floorplan on top.
      floorplan: {
        version: 8,
        glyphs: GLYPHS_URL,
        sources: {},
        layers: [
          { id: 'floorplan-white-bg', type: 'background', paint: { 'background-color': '#f8f7f2' } }
        ]
      }
    }
  };

  window.CompactMapConfig = {
    CONFIG: CONFIG
  };
})();
