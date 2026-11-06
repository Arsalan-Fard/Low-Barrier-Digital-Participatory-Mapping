// Map page: basemap switching, the custom layers every style load needs, the
// floorplans (the /floorplan page and the indoor workshop basemap), workshop data
// layers, and the API mapStartup.js publishes as window.CompactMapApp.
let activeMapTheme = INITIAL_MAP_THEME;
let mapStyleReadyCallbacks = [];
// Set from setStyle() until its 'style.load': isStyleLoaded() can still report the outgoing style as loaded.
let styleReloadPending = false;
let mapStyleEverLoaded = false;

function handleMapStyleLoad() {
  styleReloadPending = false;
  mapStyleEverLoaded = true;
  ensureCustomLayers();
  flushMapStyleReadyCallbacks();
}

function flushMapStyleReadyCallbacks() {
  var callbacks = mapStyleReadyCallbacks.slice();
  mapStyleReadyCallbacks = [];
  for (var i = 0; i < callbacks.length; i++) {
    try {
      callbacks[i]();
    } catch (err) {
      console.error('Map style-ready callback failed:', err);
    }
  }
}

// Waits only for a setStyle() reload or the first load. isStyleLoaded() also goes
// false while tiles load, and no 'style.load' follows that to flush the queue.
function whenMapStyleReady(callback) {
  if (typeof callback !== 'function') return;
  if (!styleReloadPending && mapStyleEverLoaded) {
    ensureCustomLayers();
    callback();
    return;
  }
  mapStyleReadyCallbacks.push(callback);
}

function ensureCustomLayers() {
  ensureFloorplanLayer();
  ensureFloorplanBasemap();
  drawing.ensureLayer();
  roadSnapping.ensureRoadsLayer();
  isochrone.ensureLayers();
  routing.ensureLayers();
  ensureFoldPenLayer();
}

function setMapTheme(theme) {
  // Entering the indoor basemap re-fits the plan unless the step's saved view (applyStepView) says otherwise.
  if (String(theme) === MAP_THEME_FLOORPLAN && activeMapTheme !== MAP_THEME_FLOORPLAN) {
    workshopFloorplanFitDone = false;
    workshopSuppressFloorplanFit = false;
  }
  var result = mapRuntime.applyTheme(theme);
  activeMapTheme = result.theme;
  if (result.reloaded) styleReloadPending = true;
  return activeMapTheme;
}

const BLANK_SHEET_LAYER = 'blank-sheet-bg';
const DEFAULT_BLANK_SHEET_COLOR = '#ffffff';

function blankSheetColor(raw) {
  return /^#[0-9a-f]{6}$/i.test(String(raw || '')) ? String(raw) : DEFAULT_BLANK_SHEET_COLOR;
}

// The empty sheet's colour: written into its style for the next load, and onto the map if it shows it.
function setBlankSheetColor(raw) {
  var color = blankSheetColor(raw);
  var style = mapThemeStyles[MAP_THEME_BLANK];
  if (style && Array.isArray(style.layers) && style.layers[0]) style.layers[0].paint['background-color'] = color;
  whenMapStyleReady(function () {
    if (activeMapTheme === MAP_THEME_BLANK && map.getLayer(BLANK_SHEET_LAYER)) {
      map.setPaintProperty(BLANK_SHEET_LAYER, 'background-color', color);
    }
  });
}

// A workshop step's basemap. Older steps say indoor: true instead of theme 'floorplan'.
function stepBasemapTheme(step) {
  if (!step) return MAP_THEME_STREETS;
  if (step.indoor || step.theme === MAP_THEME_FLOORPLAN) return MAP_THEME_FLOORPLAN;
  return mapThemeStyles[step.theme] ? String(step.theme) : MAP_THEME_STREETS;
}

// The /floorplan page: the plan's walls, and an isovist from the isovist tag.
// Analysis runs in a fixed-size plan space.
const FLOORPLAN_SOURCE_ID = 'floorplan-source';
const FLOORPLAN_LAYER_ID = 'floorplan-lines';
const FLOORPLAN_ANALYSIS_HEIGHT = 4096;
let floorplanGeoJSON = null;

function floorplanBounds() {
  var bounds = floorplanGeoJSON && Array.isArray(floorplanGeoJSON.bounds) ? floorplanGeoJSON.bounds : null;
  if (!bounds || !Array.isArray(bounds[0]) || !Array.isArray(bounds[1])) return null;
  var west = Number(bounds[0][0]);
  var south = Number(bounds[0][1]);
  var east = Number(bounds[1][0]);
  var north = Number(bounds[1][1]);
  if (![west, south, east, north].every(Number.isFinite) || east === west || north === south) return null;
  var midLat = (north + south) * 0.5;
  var cosLat = Math.max(0.2, Math.cos(midLat * Math.PI / 180));
  var width = FLOORPLAN_ANALYSIS_HEIGHT * Math.abs(((east - west) * cosLat) / (north - south));
  return { west: west, south: south, east: east, north: north, width: width, height: FLOORPLAN_ANALYSIS_HEIGHT };
}

function lngLatToFloorplanAnalysis(lng, lat) {
  var b = floorplanBounds();
  if (!b) return null;
  var x = ((Number(lng) - b.west) / (b.east - b.west)) * b.width;
  var y = ((Number(lat) - b.south) / (b.north - b.south)) * b.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: x, y: y };
}

function floorplanAnalysisToLngLat(point) {
  var b = floorplanBounds();
  if (!b || !point) return null;
  var lng = b.west + (Number(point.x) / b.width) * (b.east - b.west);
  var lat = b.south + (Number(point.y) / b.height) * (b.north - b.south);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng: lng, lat: lat };
}

function floorplanAnalysisToViewport(point) {
  var lngLat = floorplanAnalysisToLngLat(point);
  if (!lngLat) return { x: -9999, y: -9999 };
  return lngLatToPx(lngLat.lng, lngLat.lat);
}

function rebuildFloorplanWallSegments() {
  if (!isFloorplanMode || !floorplanGeoJSON) return;
  var features = Array.isArray(floorplanGeoJSON.features) ? floorplanGeoJSON.features : [];
  var segments = [];
  for (var i = 0; i < features.length; i++) {
    var geom = features[i] && features[i].geometry;
    if (!geom || geom.type !== 'LineString' || !Array.isArray(geom.coordinates)) continue;
    var prev = null;
    for (var j = 0; j < geom.coordinates.length; j++) {
      var coord = geom.coordinates[j];
      var p = Array.isArray(coord) && coord.length >= 2
        ? lngLatToFloorplanAnalysis(Number(coord[0]), Number(coord[1]))
        : null;
      if (!p) {
        prev = null;
        continue;
      }
      if (prev) {
        var dx = p.x - prev.x;
        var dy = p.y - prev.y;
        if ((dx * dx + dy * dy) > 1) {
          segments.push({ x1: prev.x, y1: prev.y, x2: p.x, y2: p.y });
        }
      }
      prev = p;
    }
  }
  floorplanIsovist.setSegments(segments);
}

// Once per poll on the /floorplan page.
function updateFloorplanIsovist(tagPoint) {
  if (tagPoint) {
    var lngLat = pxToLngLat(tagPoint.x, tagPoint.y);
    var analysisPoint = lngLatToFloorplanAnalysis(lngLat[0], lngLat[1]);
    if (analysisPoint) floorplanIsovist.update(analysisPoint);
    else floorplanIsovist.clear();
  } else {
    floorplanIsovist.clear();
  }
}

function ensureFloorplanLayer() {
  if (!isFloorplanMode) return;
  fetch('/api/floorplan', { cache: 'no-store' })
    .then(function (res) {
      return res.json().then(function (data) {
        return { ok: res.ok, data: data };
      });
    })
    .then(function (result) {
      var payload = result.data && result.data.floorplan;
      if (!result.ok || !result.data || result.data.ok !== true || !payload) {
        throw new Error((result.data && result.data.error) || 'floorplan_load_failed');
      }
      floorplanGeoJSON = payload;
      if (!map.getSource(FLOORPLAN_SOURCE_ID)) {
        map.addSource(FLOORPLAN_SOURCE_ID, { type: 'geojson', data: payload });
      } else {
        map.getSource(FLOORPLAN_SOURCE_ID).setData(payload);
      }
      if (!map.getLayer(FLOORPLAN_LAYER_ID)) {
        map.addLayer({
          id: FLOORPLAN_LAYER_ID,
          type: 'line',
          source: FLOORPLAN_SOURCE_ID,
          paint: {
            'line-color': '#202020',
            'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.35, 16, 0.8, 20, 1.8],
            'line-opacity': 0.88
          },
          layout: { 'line-cap': 'round', 'line-join': 'round' }
        });
      }
      if (Array.isArray(payload.bounds) && payload.bounds.length === 2) {
        map.fitBounds(payload.bounds, { padding: 48, duration: 0 });
      }
      rebuildFloorplanWallSegments();
    })
    .catch(function (err) {
      console.error('Failed to load floorplan:', err);
    });
}

// The indoor workshop basemap on /map: a white mask over the plan's bounds under
// its wall lines, with nothing to edit.
var WORKSHOP_FP_BG_SOURCE = 'ws-floorplan-bg-source';
var WORKSHOP_FP_BG_LAYER = 'ws-floorplan-bg';
var WORKSHOP_FP_LINE_SOURCE = 'ws-floorplan-line-source';
var WORKSHOP_FP_LINE_LAYER = 'ws-floorplan-lines';
var workshopFloorplanFitDone = false;
// Set by applyStepView when an indoor step has a saved camera, so the auto-fit leaves it alone.
var workshopSuppressFloorplanFit = false;
var workshopIndoorId = '';
var workshopFloorplanCache = {};

function renderFloorplanBasemap(payload) {
  if (!payload || activeMapTheme !== MAP_THEME_FLOORPLAN) return;
  // Right after setStyle() the style may not be applied yet and isStyleLoaded() can lie; 'idle' is
  // the reliable signal, while 'style.load' may already have fired (this often runs inside it).
  if (!map.isStyleLoaded()) {
    map.once('idle', function () {
      if (activeMapTheme === MAP_THEME_FLOORPLAN) renderFloorplanBasemap(payload);
    });
    return;
  }
  if (!map.getSource(WORKSHOP_FP_LINE_SOURCE)) {
    map.addSource(WORKSHOP_FP_LINE_SOURCE, { type: 'geojson', data: payload });
  } else {
    map.getSource(WORKSHOP_FP_LINE_SOURCE).setData(payload);
  }
  if (!map.getLayer(WORKSHOP_FP_LINE_LAYER)) {
    map.addLayer({
      id: WORKSHOP_FP_LINE_LAYER,
      type: 'line',
      source: WORKSHOP_FP_LINE_SOURCE,
      paint: {
        'line-color': '#202020',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.35, 16, 0.8, 20, 1.8],
        'line-opacity': 0.9
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' }
    });
  }
  var hasBounds = Array.isArray(payload.bounds) && payload.bounds.length === 2;
  if (hasBounds) {
    var b = payload.bounds;
    var mask = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [b[0][0], b[0][1]], [b[1][0], b[0][1]],
            [b[1][0], b[1][1]], [b[0][0], b[1][1]], [b[0][0], b[0][1]]
          ]]
        }
      }]
    };
    if (!map.getSource(WORKSHOP_FP_BG_SOURCE)) {
      map.addSource(WORKSHOP_FP_BG_SOURCE, { type: 'geojson', data: mask });
    } else {
      map.getSource(WORKSHOP_FP_BG_SOURCE).setData(mask);
    }
    if (!map.getLayer(WORKSHOP_FP_BG_LAYER)) {
      map.addLayer({
        id: WORKSHOP_FP_BG_LAYER,
        type: 'fill',
        source: WORKSHOP_FP_BG_SOURCE,
        paint: { 'fill-color': '#f8f7f2', 'fill-opacity': 1 }
      }, WORKSHOP_FP_LINE_LAYER);
    }
  }
  [WORKSHOP_FP_BG_LAYER, WORKSHOP_FP_LINE_LAYER].forEach(function (id) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
  });
  // Fit once per entry into indoor, after a resize so the fit uses the current container size.
  if (!workshopFloorplanFitDone && !workshopSuppressFloorplanFit && hasBounds) {
    workshopFloorplanFitDone = true;
    map.resize();
    map.setBearing(0);
    map.setPitch(0);
    map.fitBounds(payload.bounds, { padding: 48, duration: 0 });
  }
}

function ensureFloorplanBasemap() {
  if (isFloorplanMode) return;
  if (activeMapTheme !== MAP_THEME_FLOORPLAN) {
    [WORKSHOP_FP_LINE_LAYER, WORKSHOP_FP_BG_LAYER].forEach(function (id) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    });
    return;
  }
  var id = workshopIndoorId;
  if (workshopFloorplanCache[id]) {
    renderFloorplanBasemap(workshopFloorplanCache[id]);
    return;
  }
  var url = '/api/floorplan' + (id ? ('?id=' + encodeURIComponent(id)) : '');
  fetch(url, { cache: 'no-store' })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var payload = data && data.floorplan;
      if (!data || data.ok !== true || !payload) throw new Error((data && data.error) || 'floorplan_load_failed');
      workshopFloorplanCache[id] = payload;
      renderFloorplanBasemap(payload);
    })
    .catch(function (err) { console.error('Workshop floorplan load failed:', err); });
}

// A step's data layers: 'roads', 'network' (OSMnx), 'objects' (custom objects), 'custom:<file id>'
// uploads named by the customGeoLayers registry, and 'result:<kind>:<filename>' saved results.
const BUILTIN_DATA_LAYERS = ['roads', 'network', 'objects'];
const CUSTOM_LAYER_PREFIX = 'custom:';
const RESULT_LAYER_PREFIX = 'result:';
// Bumped by every application, so a slow load finishing after a step change is dropped.
let dataLayerSeq = 0;
let activeDataLayerIds = [];
// The opacity of the layers coloured by a value (0-1), from the step; null = each layer's own.
let dataLayerOpacity = null;
let activeWorkshopMeta = null;
// The session file of the current workshop run, so later saves update it instead of adding files.
let workshopSessionFile = '';

function isCustomDataLayerId(id) {
  return String(id || '').indexOf(CUSTOM_LAYER_PREFIX) === 0;
}

function isResultDataLayerId(id) {
  return String(id || '').indexOf(RESULT_LAYER_PREFIX) === 0;
}

// Deferred past a basemap reload: layer writes to a style being replaced are wiped.
function applyActiveDataLayers() {
  var want = {};
  var wantCustom = [];
  var wantResults = [];
  activeDataLayerIds.forEach(function (id) {
    if (isCustomDataLayerId(id)) wantCustom.push(id.slice(CUSTOM_LAYER_PREFIX.length));
    else if (isResultDataLayerId(id)) wantResults.push(id.slice(RESULT_LAYER_PREFIX.length));
    else want[id] = true;
  });
  var seq = ++dataLayerSeq;
  whenMapStyleReady(function () {
    if (seq !== dataLayerSeq) return;
    if (want.roads) {
      roadSnapping.loadRoads(function (err) {
        if (err || seq !== dataLayerSeq) return;
        roadSnapping.setRoadsVisible(true);
      });
    } else {
      roadSnapping.setRoadsVisible(false);
    }
    if (want.network) {
      osmnxNetwork.loadCached(function (err) {
        if (seq !== dataLayerSeq) return;
        if (err) {
          console.warn('[layers] no saved street network (data/osmnx_network.geojson):', err);
          return;
        }
        osmnxNetwork.setVisible(true);
      });
    } else {
      osmnxNetwork.setVisible(false);
    }
    customMapObjects.setPresentationMode(want.objects ? 'expanded' : 'hidden');
    customGeoLayers.setValueOpacity(dataLayerOpacity);
    customGeoLayers.hideAllExcept(wantCustom);
    wantCustom.forEach(function (cid) {
      customGeoLayers.loadLayer(cid, function (err) {
        if (err || seq !== dataLayerSeq) return;
        customGeoLayers.setLayerVisible(cid, true);
      });
    });
    window.CompactResultsLayer.setShown(wantResults);
  });
}

// The stickers shown on the table, counted into the cells of uploaded value layers. Polled while such
// a layer is active: placing, moving and erasing stickers and the parts shown all change them, and
// setLivePoints does nothing when they have not.
setInterval(function () {
  if (!activeDataLayerIds.some(isCustomDataLayerId)) return;
  customGeoLayers.setLivePoints(stickerPlacement.getVisiblePoints());
}, 1000);

// window.CompactMapApp: what the workshop runtime, the Project panel and paperMap.js
// use of this page.
const mapAppApi = {
  getMap: function () { return map; },
  // The live camera in the shape the workshop editor stores per step.
  getMapView: function () {
    var c = map.getCenter();
    return { center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  },
  setMapTheme: function (theme) { return setMapTheme(theme); },
  getActiveTheme: function () { return activeMapTheme; },
  // The basemap names and styles the Project panel draws its basemap buttons from.
  getThemeStyle: function (theme) { return mapThemeStyles[theme] || null; },
  stepBasemapTheme: stepBasemapTheme,
  setBlankSheetColor: setBlankSheetColor,
  // Shows a step's basemap: its theme, the plan an indoor step uses, the colour of an empty sheet.
  applyStepBasemap: function (step) {
    var theme = stepBasemapTheme(step);
    if (theme === MAP_THEME_FLOORPLAN) mapAppApi.setIndoorFloorplan((step && step.indoorId) || '');
    if (theme === MAP_THEME_BLANK) setBlankSheetColor(step && step.blankColor);
    return setMapTheme(theme);
  },
  toggleRecording: function () {
    toggleTimelineRecording();
    return !!timelineRecording;
  },
  isRecording: function () { return !!timelineRecording; },
  // Which uploaded plan the indoor basemap shows ('' = the default Télécom plan).
  setIndoorFloorplan: function (id) {
    var next = String(id || '');
    if (next === workshopIndoorId) return;
    workshopIndoorId = next;
    workshopFloorplanFitDone = false;
    workshopSuppressFloorplanFit = false;
    [WORKSHOP_FP_LINE_LAYER, WORKSHOP_FP_BG_LAYER].forEach(function (lid) {
      if (map.getLayer(lid)) map.removeLayer(lid);
    });
    [WORKSHOP_FP_LINE_SOURCE, WORKSHOP_FP_BG_SOURCE].forEach(function (sid) {
      if (map.getSource(sid)) map.removeSource(sid);
    });
    if (activeMapTheme === MAP_THEME_FLOORPLAN) ensureFloorplanBasemap();
  },
  beginWorkshopSession: function () { workshopSessionFile = ''; },
  // Saves the run's inputs: the first save creates the session file, later ones update it.
  persistWorkshopSession: function (callback) {
    var done = function (err, result) {
      if (err) console.warn('[workshop] session save failed:', err);
      if (typeof callback === 'function') callback(err, result);
    };
    if (workshopSessionFile) {
      dataExport.updateSession(workshopSessionFile, null, function (err, result) {
        // The file is gone: start a new one.
        if (err) {
          workshopSessionFile = '';
          window.CompactMapApp.persistWorkshopSession(callback);
          return;
        }
        done(null, result);
      });
    } else {
      dataExport.saveToBackend(function (err, result) {
        if (!err && result && result.filename) workshopSessionFile = String(result.filename);
        done(err, result);
      });
    }
  },
  whenStyleReady: whenMapStyleReady,
  applyStepView: function (view) {
    if (!view) return;
    var opts = {};
    if (Array.isArray(view.center) && view.center.length >= 2) opts.center = [Number(view.center[0]), Number(view.center[1])];
    if (Number.isFinite(Number(view.zoom))) opts.zoom = Number(view.zoom);
    if (Number.isFinite(Number(view.bearing))) opts.bearing = Number(view.bearing);
    if (Number.isFinite(Number(view.pitch))) opts.pitch = Number(view.pitch);
    if (!Object.keys(opts).length) return;
    // A saved view wins over the indoor basemap's auto-fit.
    if (opts.center) workshopSuppressFloorplanFit = true;
    map.easeTo(Object.assign({ duration: 600 }, opts));
  },
  setWorkshopStep: function (n) {
    var s = Number(n) || 0;
    annotationPlacement.setCurrentStep(s);
    stickerPlacement.setCurrentStep(s);
    drawing.setCurrentStep(s);
  },
  setWorkshopContext: function (workshopId) {
    drawing.setWorkshopContext(workshopId || '');
  },
  // The steps of one project whose input is shown, live and in its saved results; null shows every
  // step of every project.
  setVisibleWorkshopSteps: function (stepNumbers, workshopId) {
    var steps = Array.isArray(stepNumbers) ? stepNumbers.map(function (n) { return Number(n) || 0; }) : null;
    var set = steps ? new Set(steps) : null;
    drawing.setVisibleSteps(set);
    drawing.setVisibleWorkshop(set ? (workshopId || '') : '');
    stickerPlacement.setVisibleSteps(set);
    annotationPlacement.setVisibleSteps(set);
    window.CompactResultsLayer.setStepFilter(set ? workshopId : '', steps);
  },
  setWorkshopMeta: function (meta) {
    activeWorkshopMeta = (meta && typeof meta === 'object') ? meta : null;
  },
  setOverlayVisibility: function (ov) {
    if (!ov || typeof ov !== 'object') return;
    if (ov.roads != null && roadSnapping.isRoadsVisible() !== !!ov.roads) {
      roadSnapping.toggleRoads();
    }
    if (ov.drawings != null) {
      ['draw-layer', 'draw-layer-live', 'draw-layer-points'].forEach(function (layerId) {
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, 'visibility', ov.drawings ? 'visible' : 'none');
        }
      });
    }
    if (ov.stickers != null) {
      stickerPlacement.setVisibleSteps(ov.stickers ? null : new Set());
    }
    if (ov.annotations != null) {
      annotationPlacement.setVisibleSteps(ov.annotations ? null : new Set());
    }
  },
  // Shows exactly the listed layers, superseding the previous call; each step opens with them all visible.
  // opacity: the step's opacity (0-1) for the layers coloured by a value, or null for their own.
  setDataLayers: function (ids, opacity) {
    activeDataLayerIds = [];
    (Array.isArray(ids) ? ids : []).forEach(function (id) {
      id = String(id);
      var known = BUILTIN_DATA_LAYERS.indexOf(id) !== -1 || isCustomDataLayerId(id) || isResultDataLayerId(id);
      if (known && activeDataLayerIds.indexOf(id) === -1) activeDataLayerIds.push(id);
    });
    dataLayerOpacity = typeof opacity === 'number' && isFinite(opacity) ? opacity : null;
    applyActiveDataLayers();
  }
};
