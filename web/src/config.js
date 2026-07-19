(function () {
  var TOKEN_PLACEHOLDER = '__' + 'MAPBOX_TOKEN' + '__';
  var accessToken = '__MAPBOX_TOKEN__';
  var hasMapboxToken = !!accessToken && accessToken !== TOKEN_PLACEHOLDER;
  var OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  var ESRI_ATTRIBUTION = 'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics';
  var OPENTOPO_ATTRIBUTION = 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Tiles: &copy; <a href="https://opentopomap.org/">OpenTopoMap</a> (CC-BY-SA)';
  var GLYPHS_URL = 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf';

  // Generic raster basemap style: one raster source + one raster layer. Themes
  // that share the same `tiles` (e.g. the OSM family) are switched in place via
  // raster paint only (see mapSetup.applyTheme); themes with different tiles
  // (satellite, topo) trigger a full style reload, which is expected.
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
          tileSize: opts.tileSize || 256,
          attribution: opts.attribution || OSM_ATTRIBUTION
        }
      },
      layers: [
        {
          id: id + '-tiles',
          type: 'raster',
          source: sourceId,
          minzoom: 0,
          maxzoom: Number.isFinite(opts.maxzoom) ? opts.maxzoom : 19,
          paint: opts.paint || {}
        }
      ]
    };
  }

  function osmRasterStyle(id, paint) {
    return rasterStyle(id, { paint: paint });
  }

  const CONFIG = {
    // Injected at serve time by the backend from token.txt (gitignored). In
    // static mode this remains a placeholder; the app then stays on OSM tiles.
    accessToken: accessToken,
    useMapboxServices: hasMapboxToken,
    renderer: 'maplibre',
    attributionControl: true,
    style: osmRasterStyle('osm-streets'),
    center: [2.2085, 48.7116],
    zoom: 16,
    pitch: 0,
    bearing: 0,
    markerSettings: null,
    themeCycle: ['streets', 'satellite', 'topo'],
    styles: {
      // Single OSM street basemap.
      streets: {
        style: osmRasterStyle('osm-streets'),
        useBuiltIn3D: true
      },
      // Esri World Imagery — aerial/satellite, no API token required.
      satellite: {
        style: rasterStyle('esri-satellite', {
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          attribution: ESRI_ATTRIBUTION,
          maxzoom: 19
        }),
        useBuiltIn3D: true
      },
      // OpenTopoMap — topographic basemap (contours + hillshade), no token.
      // Caps at z17 (the service does not serve deeper tiles).
      topo: {
        style: rasterStyle('opentopo', {
          tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
          attribution: OPENTOPO_ATTRIBUTION,
          maxzoom: 17
        }),
        useBuiltIn3D: true
      },
      // Indoor "Telecom" floorplan: a plain white base. The actual plan lines
      // (and a white mask over the bounds) are added as custom layers from
      // /api/floorplan after the style loads — see ensureFloorplanBasemap in
      // script.js. No basemap tiles, so it shows the plan cleanly.
      floorplan: {
        style: {
          version: 8,
          glyphs: GLYPHS_URL,
          sources: {},
          layers: [
            { id: 'floorplan-white-bg', type: 'background', paint: { 'background-color': '#f8f7f2' } }
          ]
        },
        useBuiltIn3D: false
      }
    }
  };

  window.CompactMapConfig = {
    CONFIG: CONFIG
  };
})();
