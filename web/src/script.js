const hud = document.getElementById('hud');
const calibOverlay = document.getElementById('calibOverlay');
const cameraStage = document.getElementById('cameraStage');
const cameraFeed = document.getElementById('cameraFeed');
const cameraOverlay = document.getElementById('cameraOverlay');
const cameraPage = document.getElementById('cameraPage');
const mapPage = document.getElementById('mapPage');
const mapView = document.getElementById('main_container');
const streetViewInset = document.getElementById('streetViewInset');
const streetViewFrame = document.getElementById('streetViewFrame');
const workspace = document.getElementById('workspace');
const nextBtn = document.getElementById('nextBtn');
const viewFilterPanel = document.getElementById('viewFilterPanel');
const viewBrightness = document.getElementById('viewBrightness');
const viewSaturation = document.getElementById('viewSaturation');
const viewContrast = document.getElementById('viewContrast');
const viewInvert = document.getElementById('viewInvert');
const viewSepia = document.getElementById('viewSepia');
const viewBrightnessValue = document.getElementById('viewBrightnessValue');
const viewSaturationValue = document.getElementById('viewSaturationValue');
const viewContrastValue = document.getElementById('viewContrastValue');
const viewInvertValue = document.getElementById('viewInvertValue');
const viewSepiaValue = document.getElementById('viewSepiaValue');
const viewFilterClose = document.getElementById('viewFilterClose');
const viewFilterReset = document.getElementById('viewFilterReset');
const customObjectModal = document.getElementById('customObjectModal');
const customObjectForm = document.getElementById('customObjectForm');
const customObjectText = document.getElementById('customObjectText');
const customObjectMode = document.getElementById('customObjectMode');
const customObjectColor = document.getElementById('customObjectColor');
const customObjectCancel = document.getElementById('customObjectCancel');
const tagAssignments = window.CompactTagAssignments;
const CAMERA_FEED_SRC = '/video_feed?q=70';
const CAMERA_FEED_IDLE_SRC = 'data:,';
const ERASER_RADIUS_PX = 32;
// --- Fold/open drawing -------------------------------------------------------
// Each "draw" marker slot defines a PAIR of tags (slot.tagId + slot.tagId2). When
// both are seen and the pair is "opened" past the threshold (compare.py hinge
// angle), the midpoint of their offset points (Geometry/opencv_16h5_live.py
// edge_offset_points, ratio*side) is fed to the real drawing module as a pen — so
// it gets the same interpolation / speed / distance tolerances as a normal stroke.
const DEFAULT_FOLD_OFFSET_CM = 3;         // fallback pen offset past each hinge-edge centre (radial)
const FOLD_TAG_SIZE_CM = (tagAssignments && typeof tagAssignments.getMarkerSettings === 'function')
  ? (Number(tagAssignments.getMarkerSettings().tagSizeCm) || 3) : 3;
const FOLD_EDGE_INDEX = 2;                // FIXED tag-local edge (corners 2→3 = decoded bottom edge) we offset — matches app.py tag anchor & compare.py default; NOT the hinge edge
const FOLD_PEN_OPEN_ANGLE_DEG = 10;       // start drawing when hinge angle >= this
const FOLD_PEN_CLOSE_ANGLE_DEG = 8;       // stop below this (hysteresis, anti-flicker)
const FOLD_PEN_COLOR = '#ff3b3b';         // fallback if a slot has no color
const FOLD_PEN_SOURCE_ID = 'foldpen-debug-source';
const FOLD_PEN_FILL_LAYER_ID = 'foldpen-debug-fill';   // legacy triangle (removed)
const FOLD_PEN_LINE_LAYER_ID = 'foldpen-debug-line';   // legacy triangle (removed)
const FOLD_PEN_POINT_LAYER_ID = 'foldpen-laser-core';  // crisp laser dot
const FOLD_PEN_GLOW_LAYER_ID = 'foldpen-laser-glow';   // blurred glow under the dot
// Laser trail: recent pen positions per pair, fading by age.
const FOLD_LASER_TRAIL_MS = 380;          // how long a trail point lingers
const FOLD_LASER_MAX_POINTS = 14;         // cap per pair
const foldLaserTrails = {};               // pair key -> [{lng,lat,at}]
const DRAW_PAIRS = (tagAssignments && typeof tagAssignments.getDrawPairs === 'function')
  ? tagAssignments.getDrawPairs() : [];
const ERASER_PAIRS = (tagAssignments && typeof tagAssignments.getEraserPairs === 'function')
  ? tagAssignments.getEraserPairs() : [];
// Eraser fold-pen overlay uses a neutral color so it reads as "erase", not "draw".
const FOLD_ERASER_COLOR = '#e5e7eb';
// Draw + eraser pairs share the same fold/open driver; pair.tool selects the action.
const FOLD_PAIRS = DRAW_PAIRS.concat(ERASER_PAIRS);
const KEYBOARD_ANNOTATION_SLOTS = (tagAssignments && typeof tagAssignments.getKeyboardAnnotationSlots === 'function')
  ? tagAssignments.getKeyboardAnnotationSlots() : [];
const KEYBOARD_ANNOTATION_TAG_IDS = new Set();
KEYBOARD_ANNOTATION_SLOTS.forEach(function (slot) {
  if (!slot) return;
  if (slot.annotationTagId != null) KEYBOARD_ANNOTATION_TAG_IDS.add(String(slot.annotationTagId));
  if (slot.keyboardTagId != null) KEYBOARD_ANNOTATION_TAG_IDS.add(String(slot.keyboardTagId));
});
const foldPairLatch = {};   // per-pair open-state hysteresis: pair key -> bool
const foldPairVisual = {};  // per-pair smoothed visual state for fold triangle

// Per-tag corner smoothing for the fold-pen pairs. The camera reports a still
// tag's corners with a few px of frame-to-frame shimmer; left raw it makes the
// drawn pen point (and the fold angle) jitter while the tag is held still. We
// low-pass each of the 4 corners in px space (EMA) BEFORE any edge/angle math,
// so both the angle and the pen position are de-noised. Lower alpha = smoother
// (more lag while moving); 1 = no smoothing.
const FOLD_CORNER_SMOOTH_ALPHA = 0.35;
const foldCornerEma = {};   // tag id -> [{x,y} x4] smoothed corners
function smoothFoldCorners(tagId, corners) {
  const key = String(tagId);
  const prev = foldCornerEma[key];
  if (!prev || prev.length !== corners.length) {
    const init = corners.map(function (c) { return { x: c.x, y: c.y }; });
    foldCornerEma[key] = init;
    return init;
  }
  const a = FOLD_CORNER_SMOOTH_ALPHA;
  for (let i = 0; i < corners.length; i++) {
    prev[i].x = a * corners[i].x + (1 - a) * prev[i].x;
    prev[i].y = a * corners[i].y + (1 - a) * prev[i].y;
  }
  return prev;
}
const MAP_THEME_STREETS = 'streets';
const MAP_THEME_SATELLITE = 'satellite';
const MAP_THEME_TOPO = 'topo';
const MAP_THEME_FLOORPLAN = 'floorplan';
const mapConfig = (window.CompactMapConfig && window.CompactMapConfig.CONFIG) || {};
const urlParams = new URLSearchParams(window.location.search || '');
const isFloorplanMode = window.location.pathname === '/floorplan' || urlParams.get('view') === 'floorplan';
const FLOORPLAN_SOURCE_ID = 'floorplan-source';
const FLOORPLAN_LAYER_ID = 'floorplan-lines';
const FLOORPLAN_ANALYSIS_HEIGHT = 4096;
const floorplanBlankStyle = {
  version: 8,
  sources: {},
  layers: [
    { id: 'floorplan-bg', type: 'background', paint: { 'background-color': '#f8f7f2' } }
  ]
};
const MAP_THEMES_CYCLE = isFloorplanMode
  ? [MAP_THEME_FLOORPLAN]
  : (Array.isArray(mapConfig.themeCycle) && mapConfig.themeCycle.length
    ? mapConfig.themeCycle.slice()
    : [MAP_THEME_STREETS, MAP_THEME_SATELLITE, MAP_THEME_TOPO]);
const THEME_TAG_MAP = { 31: MAP_THEME_STREETS, 32: MAP_THEME_SATELLITE, 33: MAP_THEME_TOPO };
function assignmentTagMap(tool, fallback, limit) {
  var map = tagAssignments && typeof tagAssignments.getToolTagMap === 'function'
    ? tagAssignments.getToolTagMap(tool, limit)
    : null;
  return map && Object.keys(map).length ? map : fallback;
}

function assignmentTagIds(tool, fallback) {
  var ids = tagAssignments && typeof tagAssignments.getToolTagIds === 'function'
    ? tagAssignments.getToolTagIds(tool)
    : null;
  return ids && ids.length ? ids : fallback;
}

function invertTagMap(map) {
  var out = {};
  for (var key in map) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
    out[Number(map[key])] = String(key);
  }
  return out;
}

function drawToolSelectorMap(drawTagMap) {
  var selectorIds = [5, 6, 7, 8];
  var out = {};
  for (var i = 0; i < selectorIds.length; i++) {
    var paired = drawTagMap[String(i + 1)] || drawTagMap[i + 1];
    if (paired != null) out[selectorIds[i]] = Number(paired);
  }
  return out;
}

const DRAW_TOOL_TAG_IDS = assignmentTagIds('draw', [11, 12, 13, 14]);
const PHONE_CONTROLLER_ID_TO_TAG = assignmentTagMap('draw', { 1: 11, 2: 12, 3: 13, 4: 14 }, 4);
const TAG_TO_PHONE_CONTROLLER_ID = invertTagMap(PHONE_CONTROLLER_ID_TO_TAG);
const COMMENT_CONTROLLER_ID_TO_TAG = assignmentTagMap('sticker', { 1: 15, 2: 16, 3: 17, 4: 18 }, 4);
const TAG_TO_COMMENT_CONTROLLER_ID = invertTagMap(COMMENT_CONTROLLER_ID_TO_TAG);
const DRAW_TOOL_SELECTOR_TO_TAG = drawToolSelectorMap(PHONE_CONTROLLER_ID_TO_TAG);
const DRAW_TOOL_DEFAULT_COLOR = '#ff5b5b';
// The mouse cursor acts as a stand-in for a draw-tool tag on the map page.
// It mirrors the globally last-activated phone-controller mode (draw /
// comment / erase / select) and borrows that controller's paired tag id
// (1->11, 2->12, 3->13, 4->14), so its color and the phone<->map annotation
// sync behave exactly as that controller's physical tag would.
const cursorTag = {
  // Cursor position in mapView-local viewport pixels.
  x: 0,
  y: 0,
  insideMap: false,
  // Mouse button held — gates continuous gestures (draw / erase). Comment and
  // select fire on the entry being present, matching the physical tag flow.
  pressed: false,
  // Globally last-activated controller mode, e.g. 'draw' | 'comment' |
  // 'erase' | 'select'. Defaults to draw so static/no-backend mode still
  // supports mouse drawing with the Ctrl/Cmd gesture.
  mode: 'draw',
  // Paired draw-tool tag id (11-14) of the controller that won `mode`. The
  // cursor borrows this id so color resolution (getDrawColor), the annotation
  // accent, and the phone<->map annotation sync all behave exactly as they do
  // for that controller's physical tag. Defaults to tag 11 in static mode.
  tagId: 11,
  // updatedAt of the controller that last set `mode`, so a newer activation
  // on any id supersedes an older one.
  modeStampMs: 0,
  // Set on a fresh mousedown, consumed by the next poll. Lets comment fire
  // once per click instead of chasing the moving cursor every frame.
  pressEdge: false,
  // Frozen click position + a short hold window. For comment mode the entry
  // is presented at this fixed point for commentHoldUntilMs so the annotation
  // textarea spawns and survives annotationPlacement's lostHoldMs grace
  // without the box chasing the moving cursor.
  pressX: 0,
  pressY: 0,
  commentHoldUntilMs: 0,
  // Whether map.dragPan was enabled when the Ctrl gesture began, so it can be
  // restored on release. null = no gesture active / nothing to restore.
  dragPanWasEnabled: null
};
// How long the comment cursor stays "present" at the click point after a
// click. Must exceed annotationPlacement's lostHoldMs (500) so the freshly
// spawned textarea isn't auto-expired before the user can type.
const CURSOR_COMMENT_HOLD_MS = 900;
const DRAW_TOOL_MENU_RADIUS_PX = 74;
const DRAW_TOOL_MENU_DEAD_ZONE_PX = 22;
const DRAW_TOOL_MENU_OPTIONS = [
  { key: 'draw', label: 'Draw', angleDeg: -90, accent: '#ff6b6b' },
  { key: 'erase', label: 'Erase', angleDeg: 0, accent: '#f8fafc' },
  { key: 'comment', label: 'Comment', angleDeg: 90, accent: '#facc15' },
  { key: 'select', label: 'Select', angleDeg: 180, accent: '#7dd3fc' }
];
const CURSOR_TOOL_MODE_CYCLE = ['draw', 'comment', 'erase', 'select'];
// Tool-selection fold pair (the "Tool selection" slot, ex-eraser): while the
// pair rests unfolded, a 180° arc of tool buttons floats above it; folding
// (pressing) with the pen tip aimed at a button selects that tool, folding
// anywhere else applies the selected tool at the tip.
const TOOL_PAIR_MENU_RADIUS_PX = 96;
const TOOL_PAIR_MENU_OPTIONS = [
  { key: 'draw', label: 'Draw', angleDeg: -157.5, accent: '#ff6b6b' },
  { key: 'erase', label: 'Erase', angleDeg: -112.5, accent: '#f8fafc' },
  { key: 'comment', label: 'Comment', angleDeg: -67.5, accent: '#facc15' },
  { key: 'select', label: 'Select', angleDeg: -22.5, accent: '#7dd3fc' }
];
const TOOL_PAIR_MENU_MAX_ANGLE_DEG = 34;
const TOOL_PAIR_DRAW_COLOR = '#ff5b5b';
const mapThemeStyles = isFloorplanMode ? {
  floorplan: { style: floorplanBlankStyle, useBuiltIn3D: true }
} : {
  streets: mapConfig.styles && mapConfig.styles.streets ? mapConfig.styles.streets : {
    style: mapConfig.style,
    useBuiltIn3D: true
  },
  satellite: mapConfig.styles && mapConfig.styles.satellite ? mapConfig.styles.satellite : { style: mapConfig.style, useBuiltIn3D: true },
  topo: mapConfig.styles && mapConfig.styles.topo ? mapConfig.styles.topo : { style: mapConfig.style, useBuiltIn3D: true },
  // Indoor "Telecom" floorplan as a workshop basemap (white plan, no tiles).
  floorplan: mapConfig.styles && mapConfig.styles.floorplan ? mapConfig.styles.floorplan : { style: floorplanBlankStyle, useBuiltIn3D: false }
};
let onMapStyleLoad = function () {};
const mapRuntime = window.CompactMapSetup.initMap({
  config: mapConfig,
  themeStyles: mapThemeStyles,
  initialTheme: isFloorplanMode ? MAP_THEME_FLOORPLAN : MAP_THEME_STREETS,
  onStyleLoad: function () {
    onMapStyleLoad();
  }
});
const map = mapRuntime.map;
let floorplanGeoJSON = null;
// Multi-face VGA model: each face is its own polygon. New points go to the
// "active" face (last in the list). Pressing F (or "Finish face") commits the
// active face and starts a new empty one. On generate, every face is convex-
// decomposed (Hertel-Mehlhorn) and each piece is rasterized for VGA cells.
const floorplanIsovist = window.CompactFloorplanIsovist
  ? window.CompactFloorplanIsovist.createFloorplanIsovist({
      containerEl: mapView,
      maxRadiusPx: 2880,
      toViewportPoint: floorplanAnalysisToViewport,
      cellSize: 140
    })
  : null;

const mapWarpController = window.CompactMapWarp.createMapWarp({
  mapViewEl: mapView,
  mapWarpEl: mapView
});
if (map && typeof map.on === 'function') {
  map.on('moveend', rebuildFloorplanWallSegments);
  map.on('zoomend', rebuildFloorplanWallSegments);
  map.on('resize', rebuildFloorplanWallSegments);
}

const drawToolModeByTagId = { 11: 'draw', 12: 'draw', 13: 'draw', 14: 'draw' };
const drawToolMenuRuntimeBySelectorId = {};
let drawToolMenuRoot = null;
// Tool-selection pair state: mode currently assigned to the pair, its arc-menu
// runtime, and per-frame data published by applyFoldPairs().
let toolPairMode = 'erase';
let toolPairMenuRuntime = null;
let toolPairWasOpen = false;
let toolPairPressConsumed = false;
let toolPairFrame = null;

const markers = new Map();
let debugMarkersVisible = true;
const calibration = window.CompactCalibration.createCalibration({
  overlayEl: calibOverlay
});

const overlays = window.CompactOverlays.createOverlays({
  map,
  cameraStage,
  cameraOverlay,
  maskSourceId: 'tag-mask-source',
  maskLayerId: 'tag-mask-layer',
  maskHoldMs: 500
});
const drawing = window.CompactDrawing.createDrawing({
  map,
  sourceId: 'draw-source',
  layerId: 'draw-layer',
  strokeStopMs: 120,
  minMovePx: 3,
  eraserRadiusPx: ERASER_RADIUS_PX,
  projectLngLatToPx: lngLatToPx,
  unprojectPxToLngLat: pxToLngLat
});
const annotationPlacement = window.CompactAnnotationPlacement.createAnnotationPlacement({
  map,
  moveThresholdPx: 14,
  lostHoldMs: 500,
  gapPx: 24,
  projectLngLatToPx: lngLatToPx,
  unprojectPxToLngLat: pxToLngLat,
  // When an annotation is finalized on the map (e.g. Enter on the cursor's
  // on-map textarea), clear the paired phone controller so its textarea
  // closes too. Mirrors the clear in applyPhoneControllerAnnotationState;
  // it's a no-op for non-controller tag ids. We don't touch placeToken here
  // so this can't re-trigger the phone->map commit path.
  onPlaced: function (sourceTagId) {
    var tid = Number(sourceTagId);
    if (!TAG_TO_PHONE_CONTROLLER_ID[tid]) return;
    lastSyncedPhoneAnnotationTextByTagId[tid] = '';
    syncPhoneControllerStateFromMap(tid, { mode: '', annotationText: '' });
  }
});
const generalAnnotationPlacement = window.CompactGeneralAnnotationPlacement.createGeneralAnnotationPlacement({
  containerEl: mapView,
  lostHoldMs: 500
});
const keyboardAnnotationPlacement = window.CompactKeyboardAnnotationPlacement.createKeyboardAnnotationPlacement({
  containerEl: mapView,
  lostHoldMs: 500,
  tagSizeCm: FOLD_TAG_SIZE_CM,
  unprojectPxToLngLat: pxToLngLat
});
const customMapObjects = window.CompactCustomMapObjects.createCustomMapObjects({
  map,
  modalEl: customObjectModal,
  formEl: customObjectForm,
  textInputEl: customObjectText,
  modeSelectEl: customObjectMode,
  colorInputEl: customObjectColor,
  cancelBtnEl: customObjectCancel,
  projectLngLatToPx: lngLatToPx,
  activationRadiusPx: 28,
  onStatusChange: function (note) {
    setUiNote(note);
    refreshHud();
  }
});
const stickerPlacement = window.CompactStickerPlacement.createStickerPlacement({
  map,
  holdMs: 2000,
  lostHoldMs: 2500,
  moveThresholdPx: 14,
  rearmThresholdPx: 22,
  suppressPlaceNearPlacedPx: 48,
  commentDraftVisibleMs: 0,
  commentDraftFadeMs: 2000,
  projectLngLatToPx: lngLatToPx
});
const roadSnapping = window.CompactRoadSnapping.createRoadSnapping({
  map,
  drawSourceId: 'draw-source',
  roadsUrl: 'data/roads.geojson'
});
const dataExport = window.CompactDataExport.createDataExport({
  map,
  drawing,
  stickerPlacement,
  annotationPlacement,
  keyboardAnnotationPlacement,
  generalAnnotationPlacement,
  roadSnapping,
  getBasemap: function () { return isFloorplanMode ? 'floorplan' : 'mapbox'; },
  getWorkshopMeta: function () { return activeWorkshopMeta; }
});
const isochrone = window.CompactIsochrone.createIsochrone({
  map,
  getAccessToken: function () { return mapConfig.useMapboxServices ? (mapConfig.accessToken || '') : ''; }
});
const routing = window.CompactRouting.createRouting({
  map,
  getAccessToken: function () { return mapConfig.useMapboxServices ? (mapConfig.accessToken || '') : ''; }
});
const osmnxNetwork = window.CompactOsmnxModule.createOsmnxNetwork({ map });
window.CompactOsmnx = osmnxNetwork;

// Active workshop run metadata. Set by the workshop runtime so saved sessions
// (collectAll in dataExport.js) can be grouped by workshop in the results view.
let activeWorkshopMeta = null;
// Filename of the session created for the current workshop run, so each step
// transition (and the final exit save) updates the SAME results file instead
// of creating duplicates. Reset when a workshop starts; cleared on exit.
let workshopSessionFile = '';
let mapStyleReadyCallbacks = [];
// True between a setStyle() call (in setMapTheme) and the 'style.load' that
// finishes the reload. While set, whenMapStyleReady must NOT trust
// isStyleLoaded() — Mapbox can still report the outgoing style as loaded right
// after setStyle(), which would run layer setup against the dying style and
// skip the real reload's flush.
let styleReloadPending = false;

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

onMapStyleLoad = function () {
  styleReloadPending = false;
  ensureCustomLayers();
  flushMapStyleReadyCallbacks();
};

function whenMapStyleReady(callback) {
  if (typeof callback !== 'function') return;
  // If a setStyle() reload is in flight, always defer: isStyleLoaded() may lie
  // about the outgoing style. The callback runs from onMapStyleLoad once the
  // new style's layers exist.
  if (!styleReloadPending && map && typeof map.isStyleLoaded === 'function' && map.isStyleLoaded()) {
    ensureCustomLayers();
    callback();
    return;
  }
  mapStyleReadyCallbacks.push(callback);
}

// Integration surface for the workshop runtime (src/workshopRuntime.js). It
// drives the latent per-step machinery already present in the placement modules
// and applies a step's saved map view / theme / overlay visibility.
window.CompactMapApp = {
  getMap: function () { return map; },
  // Snapshot of the live camera, in the shape the workshop editor/runtime store
  // per step (used by the in-map "Capture view" action).
  getMapView: function () {
    if (!map) return null;
    var c = map.getCenter();
    return { center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  },
  setMapTheme: function (theme) { return setMapTheme(theme); },
  getActiveTheme: function () { return activeMapTheme; },
  // Selectable basemaps for the map-page Layers picker, in cycle order.
  getThemeCycle: function () { return MAP_THEMES_CYCLE.slice(); },
  // Toggle the Light (view brightness/saturation/contrast) panel. Used by the
  // corner Light button; mirrors the 'v' key.
  toggleLightSettings: function () {
    var visible = toggleViewFilterPanelVisible();
    setUiNote(visible ? 'Light settings ON' : 'Light settings OFF');
    refreshHud();
    return visible;
  },
  // Toggle between the indoor Telecom floorplan and the last outdoor basemap.
  // Used by the corner Indoor/Outdoor button.
  toggleIndoorOutdoor: function () {
    var goingIndoor = activeMapTheme !== MAP_THEME_FLOORPLAN;
    if (goingIndoor) {
      setMapTheme(MAP_THEME_FLOORPLAN);
      setUiNote('Indoor (Telecom)');
    } else {
      setMapTheme(lastOutdoorTheme || MAP_THEME_STREETS);
      setUiNote('Outdoor');
    }
    refreshHud();
    return goingIndoor ? 'indoor' : 'outdoor';
  },
  isIndoor: function () { return activeMapTheme === MAP_THEME_FLOORPLAN; },
  // Timeline recording control for the corner Record button (mirrors the 'y'
  // key). Returns the new recording state.
  toggleRecording: function () {
    toggleTimelineRecording();
    return !!timelineRecording;
  },
  isRecording: function () { return !!timelineRecording; },
  // Choose which uploaded indoor floorplan the indoor basemap shows ('' = the
  // default Télécom plan). If it changes, drop the rendered layers so they
  // rebuild with the new plan's geometry and re-fit on the next render.
  setIndoorFloorplan: function (id) {
    var next = String(id || '');
    if (next === workshopIndoorId) return;
    workshopIndoorId = next;
    workshopFloorplanFitDone = false;
    workshopSuppressFloorplanFit = false;
    [WORKSHOP_FP_LINE_LAYER, WORKSHOP_FP_BG_LAYER].forEach(function (lid) {
      if (map && map.getLayer(lid)) map.removeLayer(lid);
    });
    [WORKSHOP_FP_LINE_SOURCE, WORKSHOP_FP_BG_SOURCE].forEach(function (sid) {
      if (map && map.getSource(sid)) map.removeSource(sid);
    });
    if (activeMapTheme === MAP_THEME_FLOORPLAN) ensureFloorplanBasemap();
  },
  // Begin a new workshop session save target. Call when a workshop starts so
  // the first persist creates a fresh file (rather than updating a stale one).
  beginWorkshopSession: function () { workshopSessionFile = ''; },
  // Persist the current map state (drawings/stickers/annotations + workshop
  // meta) to the results page. The FIRST call in a run creates a session file
  // and remembers it; later calls UPDATE that same file — so per-step autosaves
  // and the final exit save all land in one session, not duplicates.
  // opts.quiet suppresses the UI note (used for background per-step autosaves).
  // callback(err, result).
  persistWorkshopSession: function (opts, callback) {
    if (typeof opts === 'function') { callback = opts; opts = null; }
    var quiet = !!(opts && opts.quiet);
    var done = function (err, result) {
      if (!quiet) {
        if (err) setUiNote('Failed to save session');
        else setUiNote('Session saved' + (result && result.filename ? ': ' + result.filename : ''));
        refreshHud();
      }
      if (typeof callback === 'function') callback(err, result);
    };
    if (workshopSessionFile && typeof dataExport.updateSession === 'function') {
      dataExport.updateSession(workshopSessionFile, null, function (err, result) {
        // If the file vanished (e.g. deleted), fall back to creating a new one.
        if (err) { workshopSessionFile = ''; window.CompactMapApp.persistWorkshopSession(opts, callback); return; }
        done(err, result);
      });
    } else {
      dataExport.saveToBackend(function (err, result) {
        if (!err && result && result.filename) workshopSessionFile = String(result.filename);
        done(err, result);
      });
    }
  },
  // Back-compat alias used by the exit flow.
  saveSession: function (callback) {
    return window.CompactMapApp.persistWorkshopSession(null, callback);
  },
  whenStyleReady: whenMapStyleReady,
  applyStepView: function (view) {
    if (!map || !view || typeof map.easeTo !== 'function') return;
    var opts = {};
    if (Array.isArray(view.center) && view.center.length >= 2) opts.center = [Number(view.center[0]), Number(view.center[1])];
    if (Number.isFinite(Number(view.zoom))) opts.zoom = Number(view.zoom);
    if (Number.isFinite(Number(view.bearing))) opts.bearing = Number(view.bearing);
    if (Number.isFinite(Number(view.pitch))) opts.pitch = Number(view.pitch);
    if (Object.keys(opts).length) {
      // A saved view was applied — don't let the floorplan basemap auto-fit
      // override it (keeps an indoor step's rotation/zoom/pan).
      if (opts.center) workshopSuppressFloorplanFit = true;
      map.easeTo(Object.assign({ duration: 600 }, opts));
    }
  },
  setWorkshopStep: function (n) {
    var s = Number(n) || 0;
    if (annotationPlacement && annotationPlacement.setCurrentStep) annotationPlacement.setCurrentStep(s);
    if (keyboardAnnotationPlacement && keyboardAnnotationPlacement.setCurrentStep) keyboardAnnotationPlacement.setCurrentStep(s);
    if (stickerPlacement && stickerPlacement.setCurrentStep) stickerPlacement.setCurrentStep(s);
    if (drawing && drawing.setCurrentStep) drawing.setCurrentStep(s);
  },
  setWorkshopContext: function (workshopId) {
    if (drawing && typeof drawing.setWorkshopContext === 'function') {
      drawing.setWorkshopContext(workshopId || '');
    }
  },
  setVisibleWorkshopStep: function (stepNumber, workshopId) {
    var hasStep = stepNumber != null && stepNumber !== '';
    var steps = hasStep ? new Set([Number(stepNumber) || 0]) : null;
    if (drawing && typeof drawing.setVisibleSteps === 'function') drawing.setVisibleSteps(steps);
    if (drawing && typeof drawing.setVisibleWorkshop === 'function') drawing.setVisibleWorkshop(hasStep ? (workshopId || '') : '');
    if (stickerPlacement && typeof stickerPlacement.setVisibleSteps === 'function') stickerPlacement.setVisibleSteps(steps);
    if (annotationPlacement && typeof annotationPlacement.setVisibleSteps === 'function') annotationPlacement.setVisibleSteps(steps);
    if (keyboardAnnotationPlacement && typeof keyboardAnnotationPlacement.setVisibleSteps === 'function') keyboardAnnotationPlacement.setVisibleSteps(steps);
  },
  // Like setVisibleWorkshopStep but for an explicit SET of steps — used by the
  // workshop bar's per-step show/hide toggles so the facilitator can reveal
  // several steps' inputs at once. stepNumbers: array of step numbers (empty =
  // show none); workshopId scopes drawings to the active workshop.
  setVisibleWorkshopSteps: function (stepNumbers, workshopId) {
    var list = Array.isArray(stepNumbers) ? stepNumbers.map(function (n) { return Number(n) || 0; }) : [];
    var steps = new Set(list);
    if (drawing && typeof drawing.setVisibleSteps === 'function') drawing.setVisibleSteps(steps);
    if (drawing && typeof drawing.setVisibleWorkshop === 'function') drawing.setVisibleWorkshop(workshopId || '');
    if (stickerPlacement && typeof stickerPlacement.setVisibleSteps === 'function') stickerPlacement.setVisibleSteps(steps);
    if (annotationPlacement && typeof annotationPlacement.setVisibleSteps === 'function') annotationPlacement.setVisibleSteps(steps);
    if (keyboardAnnotationPlacement && typeof keyboardAnnotationPlacement.setVisibleSteps === 'function') keyboardAnnotationPlacement.setVisibleSteps(steps);
  },
  setWorkshopMeta: function (meta) {
    activeWorkshopMeta = (meta && typeof meta === 'object') ? meta : null;
  },
  setOverlayVisibility: function (ov) {
    if (!ov || typeof ov !== 'object') return;
    if (ov.roads != null && roadSnapping && typeof roadSnapping.isRoadsVisible === 'function') {
      if (roadSnapping.isRoadsVisible() !== !!ov.roads && typeof roadSnapping.toggleRoads === 'function') {
        roadSnapping.toggleRoads();
      }
    }
    if (ov.drawings != null && map && typeof map.getLayer === 'function') {
      ['draw-layer-glow', 'draw-layer', 'draw-layer-live'].forEach(function (layerId) {
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, 'visibility', ov.drawings ? 'visible' : 'none');
        }
      });
    }
    if (ov.stickers != null && stickerPlacement && typeof stickerPlacement.setVisibleSteps === 'function') {
      stickerPlacement.setVisibleSteps(ov.stickers ? null : new Set());
    }
    if (ov.annotations != null && annotationPlacement && typeof annotationPlacement.setVisibleSteps === 'function') {
      annotationPlacement.setVisibleSteps(ov.annotations ? null : new Set());
    }
    if (ov.annotations != null && keyboardAnnotationPlacement && typeof keyboardAnnotationPlacement.setVisibleSteps === 'function') {
      keyboardAnnotationPlacement.setVisibleSteps(ov.annotations ? null : new Set());
    }
  }
};

let lastTags = [];
let lastSource = 'unknown';
let lastFrame = { width: 0, height: 0, seq: 0 };
let lastCorners = [null, null, null, null];
let lastPhoneControllers = {};
let lastCommentControllers = {};
let drawTagDefaultsApplied = false;
let uiNote = '';
let hudVisible = true;
let activeMapTheme = mapRuntime.getCurrentTheme();
// Last non-floorplan basemap, restored by the Indoor/Outdoor toggle.
let lastOutdoorTheme = activeMapTheme === MAP_THEME_FLOORPLAN ? MAP_THEME_STREETS : activeMapTheme;
const PAN_TAG_IDS = [21, 22];
const PAN_TAG_MIN_UPDATE_MS = 45;
const PAN_TAG_MISSING_HOLD_MS = 850;
const PAN_TAG_SLOW_PX = 2;
const PAN_TAG_FAST_PX = 6;
const MOVE_TAG_SNAP_PX = 48;
const STREET_VIEW_TRIGGER_TAG_ID = 23;
const STREET_VIEW_FOV = 80;
const STREET_VIEW_HEADING = 0;
const STREET_VIEW_PITCH = 0;
const STREET_VIEW_REQUEST_DISTANCE_M = 15;
const STREET_VIEW_REQUEST_DEBOUNCE_MS = 400;
const STREET_VIEW_REQUEST_COOLDOWN_MS = 1000;
const STREET_VIEW_COORD_DECIMALS = 4;
const STREET_VIEW_MISSING_HOLD_MS = 3000;
let defaultZoom = 16;
const panTagRuntime = {
  lastApplyMs: 0,
  missingSinceMs: 0,
  active: false
};

// --- Tag-21 position-relative zoom state ---
// Baseline is captured the first frame tag 21 appears (or after a long
// disappearance). Zoom snaps to baseline ±1 step depending on horizontal
// displacement; flip the sign of dx21 below if your camera is mirrored.
let tag21BaselineRawX = null;
let tag21BaselineZoom = null;
let tag21AppliedStep = 0;
let tag21MissingSinceMs = 0;
const TAG21_ZOOM_DX_PX = 60;
const TAG21_ZOOM_STEP_DELTA = 1.0;
const TAG21_MISSING_RESET_MS = 1500;
let moveTagTarget = null;       // { type, index }
let moveTagSelectorKey = '';
let lastHandledPhonePlaceTokenByTagId = {};
let lastSyncedPhoneAnnotationTextByTagId = {};
let lastHandledCommentPlaceTokenByTagId = {};
let lastShownCommentDraftKeyByTagId = {};
let suppressedCommentPrefillKeyByTagId = {};
// For tags 15-18: index of the sticker the active comment draft is locked to.
// Set when a draft is first shown near a sticker; used as the placement target
// so the comment can't drift to a neighbouring sticker between draft and place.
let lockedCommentTargetIndexByTagId = {};
// Last text we prefilled into the comment controller from an existing sticker.
// Used to detect "user hasn't edited the prefill yet" so we can clear it when
// the tag moves off that sticker.
let prefilledCommentTextByTagId = {};
let googleMapsKeyCached = '';
let googleMapsKeyPromise = null;
let streetViewVisible = false;
let streetViewLastUrl = '';
let streetViewHideTimer = 0;
let streetViewRequestTimer = 0;
let streetViewPendingRequestKey = '';
let streetViewLastAnchorPoint = null;
let streetViewLastLngLat = null;
let streetViewLastRequestedLngLat = null;
let streetViewLastRequestAtMs = 0;
let streetViewDesiredState = 'hidden';
// JS Street View API state. When the maps SDK loads we instantiate a single
// StreetViewPanorama and update its position/POV in place — never reloading
// the iframe — so the user can rotate tag 23 freely without a page reload.
let streetViewPanorama = null;
let streetViewSdkPromise = null;
let streetViewLastHeading = 0;
let streetViewLastPosition = null; // { lat, lng }
// Offset added to the tag's screen-space angle before using it as a Street
// View heading. Adjust if "tag pointing up" should map to a different bearing.
const STREET_VIEW_HEADING_OFFSET_DEG = 0;
function shortcutInputBlocked(target) {
  if (!target) return false;
  const name = String(target.tagName || '').toUpperCase();
  if (name === 'TEXTAREA' || name === 'SELECT' || !!target.isContentEditable) return true;
  if (name !== 'INPUT') return false;
  const type = String(target.type || '').toLowerCase();
  return type !== 'range' && type !== 'button' && type !== 'checkbox' && type !== 'radio';
}

function normalizeAngle(a) {
  // Normalize angle to [-180, 180)
  a = a % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

function angleDelta(newA, oldA) {
  // Shortest signed rotation from oldA to newA
  return normalizeAngle(newA - oldA);
}

function normalizeDrawToolMode(raw) {
  var key = String(raw || '').toLowerCase();
  if (key === 'drag') return 'select';
  if (key === 'sticker') return 'comment';
  if (key === 'none' || key === '') return 'none';
  return key === 'erase' || key === 'select' || key === 'comment' || key === 'draw' ? key : 'draw';
}

function normalizePhoneControllerMode(raw) {
  var key = String(raw || '').toLowerCase();
  if (!key) return 'none';
  return normalizeDrawToolMode(key);
}

function isDrawToolTagId(tagId) {
  return DRAW_TOOL_TAG_IDS.indexOf(Number(tagId)) !== -1;
}

function currentDrawToolMode(tagId) {
  if (!isDrawToolTagId(tagId)) return 'draw';
  var override = phoneControllerModeForTag(tagId);
  if (override) return override;
  return normalizeDrawToolMode(drawToolModeByTagId[Number(tagId)]);
}

function setDrawToolMode(tagId, mode) {
  if (!isDrawToolTagId(tagId)) return 'draw';
  var next = normalizeDrawToolMode(mode);
  drawToolModeByTagId[Number(tagId)] = next;
  return next;
}

function baseDrawTagAssignment(tagId, baseAssignment) {
  var id = Number(tagId);
  var base = baseAssignment && typeof baseAssignment === 'object' ? baseAssignment : null;
  return {
    tagId: id,
    tool: base && base.tool ? String(base.tool) : 'draw',
    colorName: base && base.colorName ? String(base.colorName) : 'red',
    color: base && base.color ? String(base.color) : DRAW_TOOL_DEFAULT_COLOR,
    image: base && base.image ? String(base.image) : ''
  };
}

function effectiveAssignmentForTag(tagId, baseAssignment) {
  if (!isDrawToolTagId(tagId)) return baseAssignment;

  var base = baseDrawTagAssignment(tagId, baseAssignment);
  var mode = currentDrawToolMode(tagId);
  if (mode === 'erase') {
    return {
      tagId: base.tagId,
      tool: 'eraser',
      colorName: 'white',
      color: '#ffffff',
      image: ''
    };
  }
  if (mode === 'comment') {
    return {
      tagId: base.tagId,
      tool: 'annotation',
      colorName: 'white',
      color: '#ffffff',
      image: base.image
    };
  }
  if (mode === 'select') {
    return {
      tagId: base.tagId,
      tool: 'drag',
      colorName: 'blue',
      color: '#7dd3fc',
      image: ''
    };
  }
  if (mode === 'none') {
    return null;
  }
  return {
    tagId: base.tagId,
    tool: 'draw',
    colorName: base.colorName,
    color: base.color,
    image: base.image
  };
}

// Scan the four phone controllers and remember the mode of whichever one was
// activated most recently. "Activated" = it has a usable mode and an
// updatedAt newer than the one we last recorded. This is what makes the
// cursor follow ID3→draw then ID4→comment: each new activation wins.
function refreshGlobalCursorMode() {
  for (var controllerId in PHONE_CONTROLLER_ID_TO_TAG) {
    if (!Object.prototype.hasOwnProperty.call(PHONE_CONTROLLER_ID_TO_TAG, controllerId)) continue;
    var state = lastPhoneControllers && lastPhoneControllers[String(controllerId)];
    if (!state || typeof state !== 'object') continue;
    var stampMs = Date.parse(String(state.updatedAt || '')) || 0;
    if (stampMs <= cursorTag.modeStampMs) continue;
    var mode = normalizeDrawToolMode(state.mode);
    if (mode === 'none') continue;
    cursorTag.mode = mode;
    cursorTag.modeStampMs = stampMs;
    cursorTag.tagId = Number(PHONE_CONTROLLER_ID_TO_TAG[controllerId]) || 0;
  }
}

// Assignment for the cursor tag. We borrow the active controller's paired
// draw-tool tag id (11-14) and run it through the exact same
// effectiveAssignmentForTag() path a physical tag uses, so the cursor's
// color (e.g. ID 1 -> tag 11 -> red) and tool match that controller 1:1.
// Returns { assignment, tagId } or null when no mode is active yet.
function cursorTagAssignment() {
  var tagId = Number(cursorTag.tagId) || 0;
  if (!isDrawToolTagId(tagId)) return null;
  var baseAssignment = tagAssignments ? tagAssignments.getAssignment(tagId) : null;
  var assignment = effectiveAssignmentForTag(tagId, baseAssignment);
  if (!assignment) return null;
  return { assignment: assignment, tagId: tagId };
}

function setCursorToolMode(mode) {
  var normalized = normalizeDrawToolMode(mode);
  if (normalized === 'none') normalized = 'draw';
  cursorTag.mode = normalized;
  cursorTag.tagId = isDrawToolTagId(cursorTag.tagId) ? cursorTag.tagId : 11;
  cursorTag.modeStampMs = Date.now();
  syncPhoneControllerStateFromMap(cursorTag.tagId, { mode: normalized });
  return normalized;
}

function cycleCursorToolMode() {
  var idx = CURSOR_TOOL_MODE_CYCLE.indexOf(normalizeDrawToolMode(cursorTag.mode));
  var next = CURSOR_TOOL_MODE_CYCLE[(idx + 1) % CURSOR_TOOL_MODE_CYCLE.length];
  return setCursorToolMode(next);
}

function ensureDrawToolMenuRoot() {
  if (drawToolMenuRoot) return drawToolMenuRoot;
  drawToolMenuRoot = document.createElement('div');
  drawToolMenuRoot.style.position = 'absolute';
  drawToolMenuRoot.style.inset = '0';
  drawToolMenuRoot.style.pointerEvents = 'none';
  drawToolMenuRoot.style.zIndex = '11';
  mapView.appendChild(drawToolMenuRoot);
  return drawToolMenuRoot;
}

function polarPoint(center, radius, angleDeg) {
  var angleRad = angleDeg * Math.PI / 180;
  return {
    x: center.x + Math.cos(angleRad) * radius,
    y: center.y + Math.sin(angleRad) * radius
  };
}

function styleDrawToolMenuSelection(runtime) {
  if (!runtime || !runtime.optionElsByKey) return;
  var menuOptions = runtime.options || DRAW_TOOL_MENU_OPTIONS;
  for (var i = 0; i < menuOptions.length; i++) {
    var option = menuOptions[i];
    var el = runtime.optionElsByKey[option.key];
    if (!el) continue;
    var active = option.key === runtime.selectedMode;
    el.style.background = active
      ? 'rgba(255, 255, 255, 0.20)'
      : 'rgba(8, 10, 16, 0.76)';
    el.style.borderColor = active ? option.accent : 'rgba(255, 255, 255, 0.16)';
    el.style.color = active && option.key === 'erase' ? '#111827' : '#f8fafc';
    el.style.transform = 'translate(-50%, -50%) scale(' + (active ? '1.08' : '1') + ')';
    el.style.boxShadow = active
      ? '0 0 0 1px rgba(255,255,255,0.08), 0 10px 24px rgba(0,0,0,0.26), 0 0 24px ' + option.accent
      : '0 8px 18px rgba(0,0,0,0.22)';
    el.style.opacity = option.key === 'select' ? (active ? '0.92' : '0.72') : '1';
  }
}

function createDrawToolMenuRuntime(selectorTagId, pairedTagId, anchorPoint, config) {
  var menuOptions = (config && config.options) || DRAW_TOOL_MENU_OPTIONS;
  var menuRadius = (config && Number(config.radius)) || DRAW_TOOL_MENU_RADIUS_PX;
  var root = ensureDrawToolMenuRoot();
  var container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = String(anchorPoint.x) + 'px';
  container.style.top = String(anchorPoint.y) + 'px';
  container.style.width = '0';
  container.style.height = '0';
  container.style.transform = 'translate(-50%, -50%)';

  var ring = document.createElement('div');
  ring.style.position = 'absolute';
  ring.style.left = '0';
  ring.style.top = '0';
  ring.style.width = String(menuRadius * 2 + 78) + 'px';
  ring.style.height = String(menuRadius * 2 + 78) + 'px';
  ring.style.transform = 'translate(-50%, -50%)';
  ring.style.borderRadius = '999px';
  ring.style.border = '1px solid rgba(255, 255, 255, 0.14)';
  ring.style.background = 'radial-gradient(circle, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 42%, rgba(0,0,0,0) 68%)';
  ring.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.03), inset 0 0 28px rgba(255,255,255,0.03)';
  container.appendChild(ring);

  var centerDot = document.createElement('div');
  centerDot.style.position = 'absolute';
  centerDot.style.left = '0';
  centerDot.style.top = '0';
  centerDot.style.width = '18px';
  centerDot.style.height = '18px';
  centerDot.style.transform = 'translate(-50%, -50%)';
  centerDot.style.borderRadius = '999px';
  centerDot.style.background = 'rgba(255,255,255,0.94)';
  centerDot.style.boxShadow = '0 0 0 2px rgba(0,0,0,0.45), 0 0 24px rgba(255,255,255,0.32)';
  container.appendChild(centerDot);

  var label = document.createElement('div');
  label.style.position = 'absolute';
  label.style.left = '0';
  label.style.top = String(-(menuRadius + 48)) + 'px';
  label.style.transform = 'translate(-50%, -50%)';
  label.style.padding = '6px 10px';
  label.style.borderRadius = '999px';
  label.style.background = 'rgba(6, 8, 14, 0.86)';
  label.style.border = '1px solid rgba(255,255,255,0.12)';
  label.style.color = '#f8fafc';
  label.style.fontSize = '12px';
  label.style.fontWeight = '700';
  label.style.letterSpacing = '0.06em';
  label.style.textTransform = 'uppercase';
  label.style.whiteSpace = 'nowrap';
  label.textContent = config && config.label != null ? String(config.label) : ('Tag ' + String(pairedTagId));
  container.appendChild(label);

  var runtime = {
    selectorTagId: String(selectorTagId),
    pairedTagId: Number(pairedTagId),
    anchorPoint: { x: Number(anchorPoint.x), y: Number(anchorPoint.y) },
    selectedMode: config && config.selectedMode ? config.selectedMode : currentDrawToolMode(pairedTagId),
    container: container,
    options: menuOptions,
    optionElsByKey: {}
  };

  for (var i = 0; i < menuOptions.length; i++) {
    var option = menuOptions[i];
    var optionEl = document.createElement('div');
    optionEl.style.position = 'absolute';
    optionEl.style.left = '0';
    optionEl.style.top = '0';
    optionEl.style.width = '74px';
    optionEl.style.minHeight = '74px';
    optionEl.style.padding = '10px 8px';
    optionEl.style.transform = 'translate(-50%, -50%)';
    optionEl.style.borderRadius = '999px';
    optionEl.style.border = '1px solid rgba(255,255,255,0.16)';
    optionEl.style.display = 'flex';
    optionEl.style.alignItems = 'center';
    optionEl.style.justifyContent = 'center';
    optionEl.style.textAlign = 'center';
    optionEl.style.fontSize = '12px';
    optionEl.style.fontWeight = '700';
    optionEl.style.letterSpacing = '0.04em';
    optionEl.style.color = '#f8fafc';
    optionEl.style.transition = 'transform 110ms ease, border-color 110ms ease, box-shadow 110ms ease, background 110ms ease, opacity 110ms ease';
    optionEl.textContent = option.label;

    var pos = polarPoint({ x: 0, y: 0 }, menuRadius, option.angleDeg);
    optionEl.style.left = String(pos.x) + 'px';
    optionEl.style.top = String(pos.y) + 'px';

    runtime.optionElsByKey[option.key] = optionEl;
    container.appendChild(optionEl);
  }

  styleDrawToolMenuSelection(runtime);
  root.appendChild(container);
  if (!config || config.register !== false) {
    drawToolMenuRuntimeBySelectorId[String(selectorTagId)] = runtime;
  }
  return runtime;
}

function ensureDrawToolMenuRuntime(selectorTagId, pairedTagId, anchorPoint) {
  var key = String(selectorTagId);
  var runtime = drawToolMenuRuntimeBySelectorId[key];
  if (runtime) return runtime;
  return createDrawToolMenuRuntime(selectorTagId, pairedTagId, anchorPoint);
}

function removeDrawToolMenuRuntime(selectorTagId) {
  var key = String(selectorTagId);
  var runtime = drawToolMenuRuntimeBySelectorId[key];
  if (!runtime) return;
  if (runtime.container && runtime.container.parentNode) {
    runtime.container.parentNode.removeChild(runtime.container);
  }
  delete drawToolMenuRuntimeBySelectorId[key];
}

function hideAllDrawToolMenus() {
  for (var key in drawToolMenuRuntimeBySelectorId) {
    if (!Object.prototype.hasOwnProperty.call(drawToolMenuRuntimeBySelectorId, key)) continue;
    removeDrawToolMenuRuntime(key);
  }
}

function angleDistanceDeg(a, b) {
  var delta = normalizeAngle(a - b);
  return Math.abs(delta);
}

function selectDrawToolModeFromPoint(anchorPoint, currentPoint, fallbackMode) {
  if (!anchorPoint || !currentPoint) return normalizeDrawToolMode(fallbackMode);
  var dx = Number(currentPoint.x) - Number(anchorPoint.x);
  var dy = Number(currentPoint.y) - Number(anchorPoint.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return normalizeDrawToolMode(fallbackMode);
  if (Math.sqrt(dx * dx + dy * dy) < DRAW_TOOL_MENU_DEAD_ZONE_PX) {
    return normalizeDrawToolMode(fallbackMode);
  }
  var angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
  var best = DRAW_TOOL_MENU_OPTIONS[0];
  var bestDistance = Infinity;
  for (var i = 0; i < DRAW_TOOL_MENU_OPTIONS.length; i++) {
    var option = DRAW_TOOL_MENU_OPTIONS[i];
    var distance = angleDistanceDeg(angleDeg, option.angleDeg);
    if (distance < bestDistance) {
      best = option;
      bestDistance = distance;
    }
  }
  return best.key;
}

function syncDrawToolMenus(canShowMenus, selectorViewportPoints, visibleDrawTagMap) {
  if (!canShowMenus) {
    hideAllDrawToolMenus();
    return;
  }

  for (var selectorId in DRAW_TOOL_SELECTOR_TO_TAG) {
    if (!Object.prototype.hasOwnProperty.call(DRAW_TOOL_SELECTOR_TO_TAG, selectorId)) continue;
    var pairedTagId = DRAW_TOOL_SELECTOR_TO_TAG[selectorId];
    if (visibleDrawTagMap[pairedTagId]) {
      removeDrawToolMenuRuntime(selectorId);
      continue;
    }

    var runtime = drawToolMenuRuntimeBySelectorId[String(selectorId)] || null;
    var selectorPoint = selectorViewportPoints[String(selectorId)] || null;
    if (selectorPoint) {
      runtime = ensureDrawToolMenuRuntime(selectorId, pairedTagId, selectorPoint);
      var prevMode = currentDrawToolMode(pairedTagId);
      var selectedMode = selectDrawToolModeFromPoint(runtime.anchorPoint, selectorPoint, prevMode);
      runtime.selectedMode = setDrawToolMode(pairedTagId, selectedMode);
      if (selectedMode !== prevMode) {
        syncPhoneControllerStateFromMap(pairedTagId, { mode: selectedMode });
      }
      styleDrawToolMenuSelection(runtime);
    } else if (runtime) {
      // Selector tag is no longer visible: drop the runtime so its anchor is
      // re-picked next time the tag reappears (otherwise the ring stays anchored
      // at the first-seen position and the gesture never resolves correctly).
      removeDrawToolMenuRuntime(selectorId);
    }
  }
}

// ── Tool-selection fold pair (renamed eraser) ────────────────────────────────
function toolPairOptionByKey(key) {
  for (var i = 0; i < TOOL_PAIR_MENU_OPTIONS.length; i++) {
    if (TOOL_PAIR_MENU_OPTIONS[i].key === key) return TOOL_PAIR_MENU_OPTIONS[i];
  }
  return null;
}

// Laser/ghost overlay color for the pair follows the selected tool, so the
// pen tip itself tells you what the next press will do.
function toolPairLaserColor() {
  if (toolPairMode === 'draw') return TOOL_PAIR_DRAW_COLOR;
  if (toolPairMode === 'erase') return FOLD_ERASER_COLOR;
  var option = toolPairOptionByKey(toolPairMode);
  return option ? option.accent : FOLD_ERASER_COLOR;
}

function removeToolPairMenu() {
  if (toolPairMenuRuntime && toolPairMenuRuntime.container && toolPairMenuRuntime.container.parentNode) {
    toolPairMenuRuntime.container.parentNode.removeChild(toolPairMenuRuntime.container);
  }
  toolPairMenuRuntime = null;
}

function syncToolPairMenu(frame, canShowMenu) {
  if (!frame || !canShowMenu) {
    removeToolPairMenu();
    return;
  }
  if (!toolPairMenuRuntime) {
    toolPairMenuRuntime = createDrawToolMenuRuntime('toolpair', 0, frame.anchorPx, {
      options: TOOL_PAIR_MENU_OPTIONS,
      radius: TOOL_PAIR_MENU_RADIUS_PX,
      label: 'Tools',
      selectedMode: toolPairMode,
      register: false
    });
  }
  // Follow the tag while it rests unfolded; freeze while pressed so the
  // buttons don't chase the pointer mid-press.
  if (!frame.open) {
    toolPairMenuRuntime.anchorPoint = { x: frame.anchorPx.x, y: frame.anchorPx.y };
    toolPairMenuRuntime.container.style.left = String(frame.anchorPx.x) + 'px';
    toolPairMenuRuntime.container.style.top = String(frame.anchorPx.y) + 'px';
  }
  toolPairMenuRuntime.selectedMode = toolPairMode;
  styleDrawToolMenuSelection(toolPairMenuRuntime);
}

// The buttons live on the top 180° only, so a press aimed downward can never
// hit one — that's what keeps "select a tool" and "use the tool" apart.
function toolPairMenuOptionAt(anchor, tip) {
  if (!anchor || !tip) return null;
  var dx = Number(tip.x) - Number(anchor.x);
  var dy = Number(tip.y) - Number(anchor.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (dy >= 0) return null;
  if (Math.sqrt(dx * dx + dy * dy) < DRAW_TOOL_MENU_DEAD_ZONE_PX) return null;
  var angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
  var best = null;
  var bestDistance = Infinity;
  for (var i = 0; i < TOOL_PAIR_MENU_OPTIONS.length; i++) {
    var option = TOOL_PAIR_MENU_OPTIONS[i];
    var distance = angleDistanceDeg(angleDeg, option.angleDeg);
    if (distance < bestDistance) {
      best = option;
      bestDistance = distance;
    }
  }
  return bestDistance <= TOOL_PAIR_MENU_MAX_ANGLE_DEG ? best : null;
}

// Runs once per frame after applyFoldPairs(). Manages the arc menu, resolves
// press-to-select on the fold edge, and (when the press is a tool USE, not a
// selection) routes the pen tip into the selected tool's pipeline. Returns a
// moveSelectorPoint candidate when the pair is in select mode.
function applyToolPairFrame(erasePoints, drawPoints, annotationPoints, canDrawNow) {
  var frame = toolPairFrame;
  syncToolPairMenu(frame, canDrawNow);
  if (!frame) {
    toolPairWasOpen = false;
    toolPairPressConsumed = false;
    return null;
  }
  var pressEdge = frame.open && !toolPairWasOpen;
  toolPairWasOpen = frame.open;
  if (!frame.open) {
    toolPairPressConsumed = false;
    return null;
  }
  if (pressEdge && toolPairMenuRuntime) {
    var picked = toolPairMenuOptionAt(toolPairMenuRuntime.anchorPoint, frame.tipPx);
    if (picked) {
      toolPairMode = picked.key;
      // This press selected a tool; suppress the tool action until release.
      toolPairPressConsumed = true;
      toolPairMenuRuntime.selectedMode = toolPairMode;
      styleDrawToolMenuSelection(toolPairMenuRuntime);
    }
  }
  if (toolPairPressConsumed || !canDrawNow) return null;

  if (toolPairMode === 'erase') {
    erasePoints.push({ lng: frame.tipLL.lng, lat: frame.tipLL.lat });
  } else if (toolPairMode === 'draw') {
    drawPoints['pair:' + frame.pairKey] = {
      lng: frame.tipLL.lng,
      lat: frame.tipLL.lat,
      color: TOOL_PAIR_DRAW_COLOR
    };
  } else if (toolPairMode === 'comment') {
    annotationPoints['toolpair'] = {
      lng: frame.tipLL.lng,
      lat: frame.tipLL.lat,
      angleDeg: 0,
      tagSizePx: frame.tagSizePx
    };
  } else if (toolPairMode === 'select') {
    return {
      lng: frame.tipLL.lng,
      lat: frame.tipLL.lat,
      tagId: 9999,   // lowest priority: any physical drag tag wins
      selectorKey: 'toolpair'
    };
  }
  return null;
}

let mouseInsideCamera = false;
let mouseClientX = 0;
let mouseClientY = 0;
let floorplanIsovistKeyboardMode = false;
let floorplanIsovistPointerPoint = null;
let pollInFlight = false;
let pageFlow = null;
let viewFilterPanelVisible = false;
let driftMonitor = null;
const DRIFT_MONITOR_ENABLED = false;
let timelineRecording = null;
const TIMELINE_SAMPLE_MS = 1000;
const TIMELINE_MAX_FRAMES = 3600;
// Autosave the in-progress timeline every N ms so a forgotten "off" press
// (or a crash) doesn't lose the recording.
const TIMELINE_AUTOSAVE_MS = 5000;

function setUiNote(text) {
  uiNote = String(text || '');
}

function collectTimelineState(commitActive) {
  var state = dataExport && typeof dataExport.collectAll === 'function'
    ? dataExport.collectAll({ commitActive: !!commitActive })
    : {};
  if (!state || typeof state !== 'object') state = {};
  state.mode = 'timeline_frame';
  state.mapView = {
    center: map && typeof map.getCenter === 'function' ? [map.getCenter().lng, map.getCenter().lat] : null,
    zoom: map && typeof map.getZoom === 'function' ? map.getZoom() : null,
    bearing: map && typeof map.getBearing === 'function' ? map.getBearing() : null,
    pitch: map && typeof map.getPitch === 'function' ? map.getPitch() : null
  };
  return state;
}

function addTimelineFrame(reason) {
  if (!timelineRecording) return false;
  var nowMs = Date.now();
  var state = collectTimelineState(reason === 'stop');
  var hash = '';
  try {
    hash = JSON.stringify({
      drawings: state.drawings || null,
      stickers: state.stickers || null,
      annotations: state.annotations || null,
      keyboardAnnotations: state.keyboardAnnotations || null,
      generalAnnotations: state.generalAnnotations || null
    });
  } catch (_err) {
    hash = String(nowMs);
  }
  if (hash === timelineRecording.lastHash && reason !== 'stop') return false;
  timelineRecording.lastHash = hash;
  timelineRecording.frames.push({
    at: new Date(nowMs).toISOString(),
    elapsedMs: nowMs - timelineRecording.startedAtMs,
    reason: String(reason || 'sample'),
    state: state
  });
  if (timelineRecording.frames.length > TIMELINE_MAX_FRAMES) {
    timelineRecording.frames.shift();
  }
  return true;
}

function buildTimelinePayload(recorder, finalised) {
  return {
    mode: 'timeline',
    timelineVersion: 1,
    sessionId: recorder.sessionId,
    startedAt: recorder.startedAt,
    stoppedAt: finalised ? new Date().toISOString() : '',
    inProgress: !finalised,
    sampleMs: TIMELINE_SAMPLE_MS,
    basemap: isFloorplanMode ? 'floorplan' : 'mapbox',
    frameCount: recorder.frames.length,
    frames: recorder.frames
  };
}

function autosaveTimelineRecording() {
  if (!timelineRecording) return;
  var payload = buildTimelinePayload(timelineRecording, false);
  dataExport.saveTimelineToBackend(payload, function () {});
}

// Always-visible confirmation banner for recording (independent of the HUD,
// which can be hidden with H). kind: 'rec' = recording (persists), 'done' /
// 'err' = transient.
function showRecordToast(html, kind) {
  var el = document.getElementById('recordToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'recordToast';
    el.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;'
      + 'background:rgba(17,22,29,.96);color:#fff;border:2px solid #2a323d;border-radius:11px;'
      + 'padding:10px 18px;font:600 14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;'
      + 'box-shadow:0 8px 30px rgba(0,0,0,.5);max-width:80vw;text-align:center;'
      + 'transition:opacity .25s;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.innerHTML = html;
  el.style.borderColor = kind === 'rec' ? '#e11d2f' : (kind === 'err' ? '#e0a13a' : '#28d17c');
  el.style.opacity = '1';
  if (el._t) { clearTimeout(el._t); el._t = 0; }
  if (kind !== 'rec') el._t = setTimeout(function () { el.style.opacity = '0'; }, 4500);
}

// Drive the backend camera+mic recorder (the same one Ctrl+Shift+R uses).
function recordCamera(action, cb) {
  fetch('/api/record', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: action })
  }).then(function (r) { return r.json(); })
    .then(function (j) { if (cb) cb(null, j); })
    .catch(function (e) { if (cb) cb(e, null); });
}

function startTimelineRecording() {
  if (timelineRecording) return;
  // Stable session id so every autosave overwrites the same file rather than
  // accumulating one snapshot per save.
  var sessionId = (new Date()).toISOString().replace(/[^0-9]/g, '').slice(0, 14)
    + '_' + Math.random().toString(36).slice(2, 8);
  timelineRecording = {
    sessionId: sessionId,
    startedAtMs: Date.now(),
    startedAt: new Date().toISOString(),
    timer: 0,
    autosaveTimer: 0,
    lastHash: '',
    frames: []
  };
  addTimelineFrame('start');
  timelineRecording.timer = window.setInterval(function () {
    addTimelineFrame('sample');
  }, TIMELINE_SAMPLE_MS);
  // Persist immediately so the file exists even if the recording is
  // interrupted right after start, then keep autosaving on a timer.
  autosaveTimelineRecording();
  timelineRecording.autosaveTimer = window.setInterval(
    autosaveTimelineRecording,
    TIMELINE_AUTOSAVE_MS
  );
  setUiNote('Timeline recording ON');
  refreshHud();
  // Also start the backend camera + mic video recording.
  showRecordToast('&#9679; Starting&hellip;', 'rec');
  recordCamera('start', function (err, j) {
    if (!err && j && (j.ok || j.error === 'already_recording')) {
      showRecordToast('&#9679; REC &mdash; camera + screen + map', 'rec');
    } else {
      var why = (j && j.error) || 'camera unavailable';
      if (why === 'no_camera_frame') why = 'camera not connected';
      showRecordToast('&#9679; REC &mdash; map only<br><span style="font-weight:400;font-size:12px;opacity:.85">camera: ' + why + '</span>', 'err');
    }
  });
}

function stopTimelineRecording() {
  if (!timelineRecording) return;
  var recorder = timelineRecording;
  timelineRecording = null;
  if (recorder.timer) window.clearInterval(recorder.timer);
  if (recorder.autosaveTimer) window.clearInterval(recorder.autosaveTimer);
  timelineRecording = recorder;
  addTimelineFrame('stop');
  timelineRecording = null;

  var payload = buildTimelinePayload(recorder, true);
  setUiNote('Saving timeline...');
  showRecordToast('Saving&hellip;', 'done');
  refreshHud();

  // Stop both recorders; report once both have come back.
  var res = { tl: null, cam: null };
  function maybeReport() {
    if (res.tl === null || res.cam === null) return;
    var bad = /FAILED/.test(res.tl + res.cam);
    showRecordToast((bad ? 'Stopped' : 'Saved &#10003;')
      + '<br><span style="font-weight:400;font-size:12px;opacity:.85">' + res.cam + ' &middot; ' + res.tl + '</span>',
      bad ? 'err' : 'done');
  }
  dataExport.saveTimelineToBackend(payload, function (err, result) {
    var ok = !(err || !result || result.ok !== true);
    setUiNote(ok ? ('Timeline saved: ' + result.filename) : 'Timeline save failed');
    res.tl = ok ? 'map timeline saved' : 'map timeline FAILED';
    refreshHud();
    maybeReport();
  });
  recordCamera('stop', function (err, j) {
    if (!err && j && j.ok) res.cam = 'camera video saved';
    else if (j && j.error === 'not_recording') res.cam = 'no camera video';
    else res.cam = 'camera stop FAILED';
    maybeReport();
  });
}

function toggleTimelineRecording() {
  if (timelineRecording) stopTimelineRecording();
  else startTimelineRecording();
}

function phoneControllerStateForTag(tagId) {
  var id = Number(tagId);
  for (var controllerId in PHONE_CONTROLLER_ID_TO_TAG) {
    if (!Object.prototype.hasOwnProperty.call(PHONE_CONTROLLER_ID_TO_TAG, controllerId)) continue;
    if (Number(PHONE_CONTROLLER_ID_TO_TAG[controllerId]) !== id) continue;
    var state = lastPhoneControllers && lastPhoneControllers[String(controllerId)];
    return state && typeof state === 'object' ? state : null;
  }
  return null;
}

function commentControllerStateForTag(tagId) {
  var id = Number(tagId);
  for (var controllerId in COMMENT_CONTROLLER_ID_TO_TAG) {
    if (!Object.prototype.hasOwnProperty.call(COMMENT_CONTROLLER_ID_TO_TAG, controllerId)) continue;
    if (Number(COMMENT_CONTROLLER_ID_TO_TAG[controllerId]) !== id) continue;
    var state = lastCommentControllers && lastCommentControllers[String(controllerId)];
    return state && typeof state === 'object' ? state : null;
  }
  return null;
}

function phoneControllerModeForTag(tagId) {
  var state = phoneControllerStateForTag(tagId);
  if (!state) return '';
  var hasTouchedController = !!String(state.updatedAt || '').trim()
    || Number(state.placeToken || 0) > 0
    || String(state.annotationText || '').length > 0;
  if (!hasTouchedController && !state.active) return '';
  return normalizePhoneControllerMode(state.mode);
}

function padTwoDigits(value) {
  var n = Math.max(0, Math.floor(Number(value) || 0));
  return n < 10 ? ('0' + n) : String(n);
}


function setHudVisible(visible) {
  hudVisible = !!visible;
  if (hud) hud.classList.toggle('hidden', !hudVisible);
  return hudVisible;
}

function toggleHudVisible() {
  return setHudVisible(!hudVisible);
}

setHudVisible(false);
window.addEventListener('pageshow', function () {
  setHudVisible(false);
});

function formatFilterValue(value) {
  return Number(value).toFixed(2) + 'x';
}

function formatPercentValue(value) {
  return Math.round(Number(value) * 100) + '%';
}

function applyViewFilters() {
  const brightness = Number(viewBrightness.value || 1);
  const saturation = Number(viewSaturation.value || 1);
  const contrast = Number(viewContrast.value || 1);
  const invert = Number(viewInvert.value || 0);
  const sepia = Number(viewSepia.value || 0);
  const isDefault = brightness === 1 && saturation === 1 && contrast === 1 && invert === 0 && sepia === 0;
  // Apply filter to #map only, never to #main_container (the Maptastic target).
  // Setting filter on the Maptastic target creates a stacking context that can
  // interfere with Maptastic's position:fixed and trigger Mapbox resize loops.
  const mapEl = document.getElementById('map');
  if (mapEl) {
    mapEl.style.filter = isDefault ? '' : `brightness(${brightness}) saturate(${saturation}) contrast(${contrast}) invert(${invert}) sepia(${sepia})`;
  }
  viewBrightnessValue.textContent = formatFilterValue(brightness);
  viewSaturationValue.textContent = formatFilterValue(saturation);
  viewContrastValue.textContent = formatFilterValue(contrast);
  viewInvertValue.textContent = formatPercentValue(invert);
  viewSepiaValue.textContent = formatPercentValue(sepia);
}

function setViewFilterPanelVisible(visible) {
  viewFilterPanelVisible = !!visible;
  viewFilterPanel.classList.toggle('hidden', !viewFilterPanelVisible);
  return viewFilterPanelVisible;
}

function toggleViewFilterPanelVisible() {
  return setViewFilterPanelVisible(!viewFilterPanelVisible);
}

function resetViewFilters() {
  viewBrightness.value = '1';
  viewSaturation.value = '1';
  viewContrast.value = '1';
  viewInvert.value = '0';
  viewSepia.value = '0';
  applyViewFilters();
}

function clearAllInputs() {
  drawing.clearAll();
  stickerPlacement.clearAll();
  annotationPlacement.clearAll();
  keyboardAnnotationPlacement.clearAll();
  generalAnnotationPlacement.clearAll();
  floorplanIsovistKeyboardMode = false;
  if (floorplanIsovist) floorplanIsovist.clear();
}

function applyDebugMarkerVisibility(marker) {
  if (!marker || typeof marker.getElement !== 'function') return;
  var el = marker.getElement();
  if (!el || !el.style) return;
  if (el.dataset && el.dataset.keyboardAnnotationMarker === '1') {
    el.style.display = 'none';
    return;
  }
  el.style.display = debugMarkersVisible ? '' : 'none';
}

function syncDebugMarkerVisibility() {
  for (const marker of markers.values()) {
    applyDebugMarkerVisibility(marker);
  }
}

function setDebugMarkersVisible(visible) {
  debugMarkersVisible = !!visible;
  syncDebugMarkerVisibility();
  return debugMarkersVisible;
}

function toggleDebugMarkersVisible() {
  return setDebugMarkersVisible(!debugMarkersVisible);
}

function resetPanTagRuntime() {
  panTagRuntime.lastApplyMs = 0;
  panTagRuntime.missingSinceMs = 0;
  panTagRuntime.active = false;
}

function resetMoveTagTarget() {
  moveTagTarget = null;
  moveTagSelectorKey = '';
}

function syncPhoneControllerStateFromMap(tagId, patch) {
  var controllerId = TAG_TO_PHONE_CONTROLLER_ID[Number(tagId)];
  if (!controllerId) return;

  var existing = phoneControllerStateForTag(tagId) || {};
  var payload = {
    controllerId: controllerId,
    mode: Object.prototype.hasOwnProperty.call(patch || {}, 'mode')
      ? String(patch.mode || '')
      : String(existing.mode || ''),
    annotationText: Object.prototype.hasOwnProperty.call(patch || {}, 'annotationText')
      ? String(patch.annotationText || '')
      : String(existing.annotationText || ''),
    placeToken: Object.prototype.hasOwnProperty.call(patch || {}, 'placeToken')
      ? Number(patch.placeToken || 0)
      : Number(existing.placeToken || 0)
  };

  fetch('/api/phone-controller', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(function () {});

  lastPhoneControllers[String(controllerId)] = {
    controllerId: String(controllerId),
    pairedTagId: Number(tagId),
    active: !!payload.mode,
    mode: payload.mode,
    annotationText: payload.annotationText,
    placeToken: payload.placeToken
  };
}

function syncCommentControllerStateFromMap(tagId, patch) {
  var controllerId = TAG_TO_COMMENT_CONTROLLER_ID[Number(tagId)];
  if (!controllerId) return;

  var existing = commentControllerStateForTag(tagId) || {};
  var payload = {
    controllerId: controllerId,
    annotationText: Object.prototype.hasOwnProperty.call(patch || {}, 'annotationText')
      ? String(patch.annotationText || '')
      : String(existing.annotationText || ''),
    placeToken: Object.prototype.hasOwnProperty.call(patch || {}, 'placeToken')
      ? Number(patch.placeToken || 0)
      : Number(existing.placeToken || 0)
  };

  fetch('/api/comment-controller', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(function () {});

  lastCommentControllers[String(controllerId)] = {
    controllerId: String(controllerId),
    pairedTagId: Number(tagId),
    annotationText: payload.annotationText,
    placeToken: payload.placeToken
  };
}

function applyCommentControllerState(stickerPointsByTagId) {
  var points = stickerPointsByTagId || {};
  for (var controllerId in COMMENT_CONTROLLER_ID_TO_TAG) {
    if (!Object.prototype.hasOwnProperty.call(COMMENT_CONTROLLER_ID_TO_TAG, controllerId)) continue;
    var tagId = Number(COMMENT_CONTROLLER_ID_TO_TAG[controllerId]);
    var state = commentControllerStateForTag(tagId);
    if (!state) continue;

    var point = points[String(tagId)] || points[tagId];
    var draftText = String(state.annotationText || '');
    var commentInfo = point && typeof stickerPlacement.getCommentInfoNear === 'function'
      ? stickerPlacement.getCommentInfoNear(point.lng, point.lat, MOVE_TAG_SNAP_PX)
      : null;
    var commentKey = commentInfo
      ? String(commentInfo.index) + '|' + String(commentInfo.text || '')
      : '';

    if (!commentInfo) {
      suppressedCommentPrefillKeyByTagId[tagId] = '';
    } else if (suppressedCommentPrefillKeyByTagId[tagId] &&
        suppressedCommentPrefillKeyByTagId[tagId] !== commentKey) {
      suppressedCommentPrefillKeyByTagId[tagId] = '';
    }

    // Release the lock when the tag has clearly moved off the locked sticker:
    // either it's nowhere near any sticker (no commentInfo) or it's now near a
    // different sticker. If the controller still holds a prefilled text the
    // user never edited, clear it so the new location starts fresh.
    var prevLocked = lockedCommentTargetIndexByTagId[tagId];
    if (Number.isInteger(prevLocked)) {
      var movedAway = !commentInfo || commentInfo.index !== prevLocked;
      if (movedAway) {
        delete lockedCommentTargetIndexByTagId[tagId];
        var prefilled = prefilledCommentTextByTagId[tagId];
        if (prefilled && draftText === prefilled) {
          syncCommentControllerStateFromMap(tagId, {
            annotationText: '',
            placeToken: Number(state.placeToken || 0)
          });
          draftText = '';
          delete prefilledCommentTextByTagId[tagId];
        }
      }
    }

    if (!draftText) {
      if (lastShownCommentDraftKeyByTagId[tagId] && commentInfo && commentKey) {
        suppressedCommentPrefillKeyByTagId[tagId] = commentKey;
      }
      lastShownCommentDraftKeyByTagId[tagId] = '';
      // Phone tag has moved off any sticker and there's no pending draft —
      // release the lock so a future approach can attach to a new sticker.
      if (!commentInfo) {
        delete lockedCommentTargetIndexByTagId[tagId];
      }
      if (commentInfo && commentInfo.commented && String(commentInfo.text || '').trim() &&
          suppressedCommentPrefillKeyByTagId[tagId] !== commentKey) {
        // Lock to this sticker so the prefilled text can be edited and placed
        // back onto the same sticker even if the phone tag drifts.
        lockedCommentTargetIndexByTagId[tagId] = commentInfo.index;
        var prefillText = String(commentInfo.text || '');
        // Also surface the existing text in the live draft on the map so the
        // user can see what they're editing.
        if (typeof stickerPlacement.syncExternalTextByIndex === 'function') {
          stickerPlacement.syncExternalTextByIndex(commentInfo.index, prefillText);
        }
        prefilledCommentTextByTagId[tagId] = prefillText;
        syncCommentControllerStateFromMap(tagId, {
          annotationText: prefillText,
          placeToken: Number(state.placeToken || 0)
        });
      }
    } else {
      // User has draft text. Lock to the first nearby sticker the draft attaches
      // to and keep showing the draft on that locked sticker — don't follow the
      // phone tag if it drifts to a different sticker.
      if (!Number.isInteger(lockedCommentTargetIndexByTagId[tagId]) && commentInfo) {
        lockedCommentTargetIndexByTagId[tagId] = commentInfo.index;
      }
      var lockedForDraft = lockedCommentTargetIndexByTagId[tagId];
      if (Number.isInteger(lockedForDraft) &&
          typeof stickerPlacement.syncExternalTextByIndex === 'function') {
        if (stickerPlacement.syncExternalTextByIndex(lockedForDraft, draftText)) {
          lastShownCommentDraftKeyByTagId[tagId] = String(state.updatedAt || '') + '|' + draftText;
        }
      } else if (point && typeof stickerPlacement.syncExternalTextNear === 'function') {
        // No locked target yet (no sticker in range): fall back to nearest, and
        // lock to it so the upcoming Place lands on the same sticker.
        if (stickerPlacement.syncExternalTextNear(point.lng, point.lat, MOVE_TAG_SNAP_PX, draftText)) {
          lastShownCommentDraftKeyByTagId[tagId] = String(state.updatedAt || '') + '|' + draftText;
          if (commentInfo) {
            lockedCommentTargetIndexByTagId[tagId] = commentInfo.index;
          }
        }
      }
    }

    var placeToken = Number(state.placeToken || 0);
    var lastHandled = Number(lastHandledCommentPlaceTokenByTagId[tagId] || 0);
    if (placeToken <= lastHandled) continue;

    var text = String(state.annotationText || '').trim();
    if (!text) {
      lastHandledCommentPlaceTokenByTagId[tagId] = placeToken;
      continue;
    }

    // Prefer the locked sticker (the one the draft was attached to). Fall back
    // to nearest only if no lock was established.
    var targetIndex = lockedCommentTargetIndexByTagId[tagId];
    var placedOk = false;
    if (Number.isInteger(targetIndex) &&
        typeof stickerPlacement.commentByIndex === 'function') {
      placedOk = stickerPlacement.commentByIndex(targetIndex, text, tagId);
    } else if (point) {
      placedOk = stickerPlacement.commentNearest(point.lng, point.lat, MOVE_TAG_SNAP_PX, text, tagId);
    }

    if (placedOk) {
      var placedKey = Number.isInteger(targetIndex)
        ? String(targetIndex) + '|' + text
        : '';
      if (!placedKey && point && typeof stickerPlacement.getCommentInfoNear === 'function') {
        var placedInfo = stickerPlacement.getCommentInfoNear(point.lng, point.lat, MOVE_TAG_SNAP_PX);
        placedKey = placedInfo
          ? String(placedInfo.index) + '|' + String(placedInfo.text || '')
          : '';
      }
      suppressedCommentPrefillKeyByTagId[tagId] = placedKey;
      lastHandledCommentPlaceTokenByTagId[tagId] = placeToken;
      delete lockedCommentTargetIndexByTagId[tagId];
      delete prefilledCommentTextByTagId[tagId];
      syncCommentControllerStateFromMap(tagId, {
        annotationText: '',
        placeToken: placeToken
      });
      setUiNote('Comment placed');
      refreshHud();
    }
  }
}

function applyPhoneControllerAnnotationState(nowMs) {
  for (var controllerId in PHONE_CONTROLLER_ID_TO_TAG) {
    if (!Object.prototype.hasOwnProperty.call(PHONE_CONTROLLER_ID_TO_TAG, controllerId)) continue;
    var tagId = Number(PHONE_CONTROLLER_ID_TO_TAG[controllerId]);
    var state = phoneControllerStateForTag(tagId);
    if (!state) continue;

    var mode = normalizePhoneControllerMode(state.mode);
    if (mode && isDrawToolTagId(tagId)) {
      setDrawToolMode(tagId, mode);
    }
    if (mode === 'comment' || mode === 'select') {
      annotationPlacement.syncExternalText(tagId, state.annotationText || '');
    }

    var placeToken = Number(state.placeToken || 0);
    var lastHandled = Number(lastHandledPhonePlaceTokenByTagId[tagId] || 0);
    if (placeToken > lastHandled) {
      if (annotationPlacement.commitExternal(tagId)) {
        lastHandledPhonePlaceTokenByTagId[tagId] = placeToken;
        lastSyncedPhoneAnnotationTextByTagId[tagId] = '';
        syncPhoneControllerStateFromMap(tagId, {
          mode: '',
          annotationText: '',
          placeToken: placeToken
        });
      }
    }
  }
}

function findMoveTagTarget(selectorPoint) {
  if (!selectorPoint) return null;
  var candidates = [];
  var stickerCandidate = stickerPlacement.findNearestPlaced(selectorPoint.lng, selectorPoint.lat, MOVE_TAG_SNAP_PX);
  if (stickerCandidate) {
    candidates.push({
      type: 'sticker',
      index: stickerCandidate.index,
      distanceSq: stickerCandidate.distanceSq
    });
  }
  var annotationCandidate = annotationPlacement.findNearestPlaced(selectorPoint.lng, selectorPoint.lat, MOVE_TAG_SNAP_PX);
  if (annotationCandidate) {
    candidates.push({
      type: 'annotation',
      index: annotationCandidate.index,
      distanceSq: annotationCandidate.distanceSq
    });
  }
  if (!candidates.length) return null;
  candidates.sort(function (a, b) { return a.distanceSq - b.distanceSq; });
  return candidates[0];
}

function moveTagTargetTo(selectorPoint, selectorKey) {
  if (!selectorPoint) return false;
  var key = String(selectorKey || '');
  if (key && moveTagSelectorKey && key !== moveTagSelectorKey) {
    moveTagTarget = null;
  }
  moveTagSelectorKey = key;
  if (!moveTagTarget) {
    moveTagTarget = findMoveTagTarget(selectorPoint);
  }
  if (!moveTagTarget) return false;

  if (moveTagTarget.type === 'sticker') {
    if (stickerPlacement.movePlaced(moveTagTarget.index, selectorPoint.lng, selectorPoint.lat)) return true;
  }
  if (moveTagTarget.type === 'annotation') {
    if (typeof annotationPlacement.isPlacedVisible === 'function' &&
        !annotationPlacement.isPlacedVisible(moveTagTarget.index)) {
      moveTagTarget = null;
      return false;
    }
    var editInfo = annotationPlacement.beginEditPlaced(moveTagTarget.index, selectorPoint.tagId, Date.now());
    if (editInfo) {
      var selectedText = String(editInfo.text || '');
      if (lastSyncedPhoneAnnotationTextByTagId[selectorPoint.tagId] !== selectedText) {
        lastSyncedPhoneAnnotationTextByTagId[selectorPoint.tagId] = selectedText;
        syncPhoneControllerStateFromMap(selectorPoint.tagId, {
          mode: currentDrawToolMode(selectorPoint.tagId),
          annotationText: selectedText
        });
      }
    }
    if (annotationPlacement.movePlaced(moveTagTarget.index, selectorPoint.lng, selectorPoint.lat)) return true;
  }

  moveTagTarget = null;
  return false;
}

function panGridCell(viewportX, viewportY) {
  var viewport = mapWarpController.getViewportSize();
  var w = viewport.width;
  var h = viewport.height;
  if (!w || !h) return null;

  var col = Math.floor((viewportX / w) * 5);
  var row = Math.floor((viewportY / h) * 5);
  col = Math.max(0, Math.min(4, col));
  row = Math.max(0, Math.min(4, row));
  return { dx: col - 2, dy: row - 2 };
}

function panGridVelocity(cell) {
  if (!cell || (cell.dx === 0 && cell.dy === 0)) return null;
  var sx = cell.dx === 0 ? 0 : (Math.abs(cell.dx) === 1 ? Math.sign(cell.dx) * PAN_TAG_SLOW_PX : Math.sign(cell.dx) * PAN_TAG_FAST_PX);
  var sy = cell.dy === 0 ? 0 : (Math.abs(cell.dy) === 1 ? Math.sign(cell.dy) * PAN_TAG_SLOW_PX : Math.sign(cell.dy) * PAN_TAG_FAST_PX);
  return { x: sx, y: sy };
}


function cornersSetCount(corners) {
  if (!Array.isArray(corners)) return 0;
  let n = 0;
  for (let i = 0; i < corners.length; i++) {
    if (overlays.isFinitePoint(corners[i])) n++;
  }
  return n;
}

function currentPage() {
  return pageFlow ? pageFlow.getPage() : 'camera';
}

function setCameraFeedActive(active) {
  if (!cameraFeed) return;
  const nextSrc = active ? CAMERA_FEED_SRC : CAMERA_FEED_IDLE_SRC;
  const currentSrcAttr = cameraFeed.getAttribute('src') || '';
  if (currentSrcAttr === nextSrc) return;
  cameraFeed.setAttribute('src', nextSrc);
}


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

function floorplanClientToAnalysis(clientX, clientY) {
  var lngLat = floorplanLngLatFromClient(clientX, clientY);
  if (!lngLat) return null;
  return lngLatToFloorplanAnalysis(lngLat.lng, lngLat.lat);
}

function rebuildFloorplanWallSegments() {
  if (!isFloorplanMode || !floorplanIsovist || !floorplanGeoJSON) return;
  var features = Array.isArray(floorplanGeoJSON.features) ? floorplanGeoJSON.features : [];
  var segments = [];
  for (var i = 0; i < features.length; i++) {
    var geom = features[i] && features[i].geometry;
    if (!geom || geom.type !== 'LineString' || !Array.isArray(geom.coordinates)) continue;
    var prev = null;
    for (var j = 0; j < geom.coordinates.length; j++) {
      var coord = geom.coordinates[j];
      if (!Array.isArray(coord) || coord.length < 2) {
        prev = null;
        continue;
      }
      var p = lngLatToFloorplanAnalysis(Number(coord[0]), Number(coord[1]));
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
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
  updateFloorplanKeyboardIsovist();
}

function floorplanIsovistDefaultPoint() {
  if (!mapWarpController || typeof mapWarpController.getViewportSize !== 'function') return null;
  var viewport = mapWarpController.getViewportSize();
  var width = Number(viewport && viewport.width);
  var height = Number(viewport && viewport.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return floorplanClientToAnalysis(width / 2, height / 2);
}

function setFloorplanIsovistPointerFromClient(clientX, clientY) {
  if (!isFloorplanMode) return null;
  floorplanIsovistPointerPoint = floorplanClientToAnalysis(clientX, clientY);
  return floorplanIsovistPointerPoint;
}

function updateFloorplanKeyboardIsovist() {
  if (!isFloorplanMode || !floorplanIsovist || !floorplanIsovistKeyboardMode) return false;
  var point = floorplanIsovistPointerPoint || floorplanIsovistDefaultPoint();
  if (!point) {
    floorplanIsovist.clear();
    return false;
  }
  if (!floorplanIsovist.hasSegments()) {
    rebuildFloorplanWallSegments();
  }
  floorplanIsovist.update(point);
  return true;
}

function setFloorplanKeyboardIsovistMode(enabled) {
  if (!isFloorplanMode || !floorplanIsovist) return false;
  floorplanIsovistKeyboardMode = !!enabled;
  if (!floorplanIsovistKeyboardMode) {
    floorplanIsovist.clear();
    return false;
  }
  if (!floorplanIsovistPointerPoint) {
    floorplanIsovistPointerPoint = floorplanIsovistDefaultPoint();
  }
  updateFloorplanKeyboardIsovist();
  return true;
}

function toggleFloorplanKeyboardIsovistMode() {
  return setFloorplanKeyboardIsovistMode(!floorplanIsovistKeyboardMode);
}

function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}


// Build a Polygon feature for a single face. Returns null if face has < 3
// vertices.

// Decompose a face (in lng/lat) into convex pieces using stable floorplan
// analysis coordinates, then convert each piece back to lng/lat. Returns an array of
// arrays of {lng, lat}.


function floorplanClientPoint(clientX, clientY, clampToViewport) {
  var rect = mapView ? mapView.getBoundingClientRect() : { left: 0, top: 0 };
  var x = Number(clientX) - Number(rect.left || 0);
  var y = Number(clientY) - Number(rect.top || 0);
  if (clampToViewport) {
    var viewport = mapWarpController.getViewportSize();
    x = Math.max(0, Math.min(Number(viewport.width) || 0, x));
    y = Math.max(0, Math.min(Number(viewport.height) || 0, y));
  }
  return { x: x, y: y };
}

function floorplanLngLatFromClient(clientX, clientY) {
  var point = floorplanClientPoint(clientX, clientY, true);
  var lngLat = pxToLngLat(point.x, point.y);
  if (!Array.isArray(lngLat) || !Number.isFinite(lngLat[0]) || !Number.isFinite(lngLat[1])) return null;
  return { lng: lngLat[0], lat: lngLat[1] };
}


// Commit the active face: if it has >= 3 vertices, leave it in place and start
// a new empty active face. If it has < 3 vertices, do nothing.


function pointInViewportPolygon(point, polygon) {
  if (!point || !Array.isArray(polygon) || polygon.length < 3) return false;
  var inside = false;
  for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    var xi = polygon[i].x;
    var yi = polygon[i].y;
    var xj = polygon[j].x;
    var yj = polygon[j].y;
    var intersects = ((yi > point.y) !== (yj > point.y))
      && (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-9) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonAreaPx(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  var sum = 0;
  for (var i = 0; i < points.length; i++) {
    var a = points[i];
    var b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) * 0.5;
}


function ensureFloorplanLayer() {
  if (!isFloorplanMode || !map) return;
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
        map.addSource(FLOORPLAN_SOURCE_ID, {
          type: 'geojson',
          data: payload
        });
      } else {
        map.getSource(FLOORPLAN_SOURCE_ID).setData(payload);
      }
      if (!map.getLayer(FLOORPLAN_LAYER_ID)) {
        var beforeId = map.getLayer('draw-layer-glow') ? 'draw-layer-glow' : undefined;
        map.addLayer({
          id: FLOORPLAN_LAYER_ID,
          type: 'line',
          source: FLOORPLAN_SOURCE_ID,
          paint: {
            'line-color': '#202020',
            'line-width': [
              'interpolate', ['linear'], ['zoom'],
              12, 0.35,
              16, 0.8,
              20, 1.8
            ],
            'line-opacity': 0.88
          },
          layout: {
            'line-cap': 'round',
            'line-join': 'round'
          }
        }, beforeId);
      }
      if (Array.isArray(payload.bounds) && payload.bounds.length === 2) {
        map.fitBounds(payload.bounds, { padding: 48, duration: 0 });
      }
      rebuildFloorplanWallSegments();
      setUiNote('Floorplan loaded: ' + String(payload.properties && payload.properties.entityCount || 0) + ' entities');
    })
    .catch(function (err) {
      console.error('Failed to load floorplan:', err);
      setUiNote('Failed to load floorplan');
    });
}

// Indoor "Telecom" floorplan shown as a workshop BASEMAP on the regular map
// page (distinct from full floorplan mode, which has VGA/wall tooling). When
// the active theme is 'floorplan', render a white mask over the plan bounds and
// the plan's black wall lines — the same clean white-plan look as the results
// page — so participants can draw/place inputs over it. No VGA, no editing.
var WORKSHOP_FP_BG_SOURCE = 'ws-floorplan-bg-source';
var WORKSHOP_FP_BG_LAYER = 'ws-floorplan-bg';
var WORKSHOP_FP_LINE_SOURCE = 'ws-floorplan-line-source';
var WORKSHOP_FP_LINE_LAYER = 'ws-floorplan-lines';
var workshopFloorplanFitDone = false;
// When an indoor step has a saved camera, the runtime applies it via
// applyStepView, which sets this so the auto-fit doesn't overwrite it. Reset to
// false each time we (re)enter the floorplan basemap so a step with no saved
// view still auto-fits to the plan.
var workshopSuppressFloorplanFit = false;
var workshopIndoorId = '';                 // which uploaded floorplan to show ('' = default)
var workshopFloorplanCache = {};           // id -> parsed payload

function ensureFloorplanBasemap() {
  if (isFloorplanMode || !map) return; // real floorplan mode handles its own
  var active = activeMapTheme === MAP_THEME_FLOORPLAN;
  if (!active) {
    [WORKSHOP_FP_LINE_LAYER, WORKSHOP_FP_BG_LAYER].forEach(function (id) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    });
    return;
  }
  var render = function (payload) {
    if (!payload || activeMapTheme !== MAP_THEME_FLOORPLAN) return;
    // The style may not be fully applied yet (a setStyle() reload is async and,
    // in MapLibre, isStyleLoaded() can lie just after it). 'idle' fires once the
    // style + sources are loaded and rendering settled — the reliable signal.
    // 'style.load' is NOT safe to wait on here because it may have already fired
    // (we're often called from inside it) and won't fire again.
    if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) {
      map.once('idle', function () {
        if (activeMapTheme === MAP_THEME_FLOORPLAN) render(payload);
      });
      return;
    }
    // Stacking order must be: white mask (bottom) → plan lines → draw layers.
    // The draw layers sit at draw-layer-glow; insert both floorplan layers
    // BEFORE it so drawings stay on top. The mask is inserted before the lines
    // so the opaque fill never covers the lines or the drawings. (Adding the
    // mask with no beforeId previously pushed it to the very top → all-white.)
    var drawBeforeId = map.getLayer('draw-layer-glow') ? 'draw-layer-glow' : undefined;

    // Plan lines first (just below the draw layers).
    if (!map.getSource(WORKSHOP_FP_LINE_SOURCE)) {
      map.addSource(WORKSHOP_FP_LINE_SOURCE, { type: 'geojson', data: payload });
    } else {
      map.getSource(WORKSHOP_FP_LINE_SOURCE).setData(payload);
    }
    if (!map.getLayer(WORKSHOP_FP_LINE_LAYER)) {
      map.addLayer({
        id: WORKSHOP_FP_LINE_LAYER, type: 'line', source: WORKSHOP_FP_LINE_SOURCE,
        paint: {
          'line-color': '#202020',
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.35, 16, 0.8, 20, 1.8],
          'line-opacity': 0.9
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' }
      }, drawBeforeId);
    }
    // White mask over the plan bounds, inserted BELOW the lines layer.
    if (Array.isArray(payload.bounds) && payload.bounds.length === 2) {
      var b = payload.bounds;
      var bgFc = {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature', properties: {},
          geometry: { type: 'Polygon', coordinates: [[
            [b[0][0], b[0][1]], [b[1][0], b[0][1]],
            [b[1][0], b[1][1]], [b[0][0], b[1][1]], [b[0][0], b[0][1]]
          ]] }
        }]
      };
      if (!map.getSource(WORKSHOP_FP_BG_SOURCE)) {
        map.addSource(WORKSHOP_FP_BG_SOURCE, { type: 'geojson', data: bgFc });
      } else {
        map.getSource(WORKSHOP_FP_BG_SOURCE).setData(bgFc);
      }
      if (!map.getLayer(WORKSHOP_FP_BG_LAYER)) {
        var maskBeforeId = map.getLayer(WORKSHOP_FP_LINE_LAYER) ? WORKSHOP_FP_LINE_LAYER : drawBeforeId;
        map.addLayer({
          id: WORKSHOP_FP_BG_LAYER, type: 'fill', source: WORKSHOP_FP_BG_SOURCE,
          paint: { 'fill-color': '#f8f7f2', 'fill-opacity': 1 }
        }, maskBeforeId);
      }
    }
    [WORKSHOP_FP_BG_LAYER, WORKSHOP_FP_LINE_LAYER].forEach(function (id) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
    });
    // Fit to the plan once per entry into indoor (don't fight the user's pan on
    // every style settle). Reset the pitch/bearing so the synthetic plan box
    // frames cleanly, and resize first so the fit uses the current container
    // size (a prior zoom+pan + style swap can leave a stale transform → the fit
    // misframes and the plan reads as blank white). Skipped when the step has a
    // saved view (workshopSuppressFloorplanFit) so its rotation/zoom persist.
    if (!workshopFloorplanFitDone && !workshopSuppressFloorplanFit
        && Array.isArray(payload.bounds) && payload.bounds.length === 2) {
      workshopFloorplanFitDone = true;
      if (typeof map.resize === 'function') map.resize();
      if (typeof map.setBearing === 'function') map.setBearing(0);
      if (typeof map.setPitch === 'function') map.setPitch(0);
      map.fitBounds(payload.bounds, { padding: 48, duration: 0 });
    }
  };
  var id = workshopIndoorId || '';
  if (workshopFloorplanCache[id]) { render(workshopFloorplanCache[id]); return; }
  var url = '/api/floorplan' + (id ? ('?id=' + encodeURIComponent(id)) : '');
  fetch(url, { cache: 'no-store' })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var payload = data && data.floorplan;
      if (!data || data.ok !== true || !payload) throw new Error((data && data.error) || 'floorplan_load_failed');
      workshopFloorplanCache[id] = payload;
      render(payload);
    })
    .catch(function (err) { console.error('Workshop floorplan load failed:', err); });
}

// ── fold/open test overlay (tags 13 & 14) ────────────────────────────────────
// Geometry ported from D:\IP2\Spacious\Artifacts (compare.py hinge angle +
// Geometry/opencv_16h5_live.py edge_offset_points). Works in map-canvas pixels
// (uvToPx), so the pen point unprojects straight to a map lng/lat.
// Laser-pointer overlay: a soft glowing dot at the pen tip plus a short trail of
// recent positions that fade out — like a laser dot moving on the surface.
// Replaces the old fold "triangle". Two circle layers per point: a blurred glow
// underneath + a crisp core on top.
function ensureFoldPenLayer() {
  // Drop the legacy triangle fill/outline layers if a previous build left them.
  if (map.getLayer(FOLD_PEN_FILL_LAYER_ID)) map.removeLayer(FOLD_PEN_FILL_LAYER_ID);
  if (map.getLayer(FOLD_PEN_LINE_LAYER_ID)) map.removeLayer(FOLD_PEN_LINE_LAYER_ID);
  if (!map.getSource(FOLD_PEN_SOURCE_ID)) {
    map.addSource(FOLD_PEN_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }
  if (!map.getLayer(FOLD_PEN_GLOW_LAYER_ID)) {
    map.addLayer({
      id: FOLD_PEN_GLOW_LAYER_ID, type: 'circle', source: FOLD_PEN_SOURCE_ID,
      paint: {
        'circle-color': ['coalesce', ['get', 'color'], FOLD_PEN_COLOR],
        'circle-radius': ['coalesce', ['get', 'glow'], 18],
        'circle-blur': 1,
        'circle-opacity': ['coalesce', ['get', 'glowOpacity'], 0.35],
        'circle-pitch-alignment': 'map'
      }
    });
  }
  if (!map.getLayer(FOLD_PEN_POINT_LAYER_ID)) {
    map.addLayer({
      id: FOLD_PEN_POINT_LAYER_ID, type: 'circle', source: FOLD_PEN_SOURCE_ID,
      paint: {
        'circle-color': ['coalesce', ['get', 'color'], FOLD_PEN_COLOR],
        'circle-radius': ['coalesce', ['get', 'core'], 5],
        'circle-blur': 0.35,
        'circle-opacity': ['coalesce', ['get', 'coreOpacity'], 0.95],
        'circle-pitch-alignment': 'map'
      }
    });
  }
}

// Fold-pen hinge geometry now lives in src/foldGeometry.js (shared with the expos).
const foldTagEdgesPx = window.CompactFoldGeometry.tagEdges;
const foldMeanSidePx = window.CompactFoldGeometry.meanSide;

function foldTagCenterPx(corners) {
  let x = 0, y = 0;
  for (const p of corners) { x += p.x; y += p.y; }
  const n = Math.max(1, corners.length);
  return { x: x / n, y: y / n };
}

function foldClamp01(value) {
  value = Number(value);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function foldMix(a, b, t) {
  return Number(a) + ((Number(b) - Number(a)) * foldClamp01(t));
}

function foldMixPoint(a, b, t) {
  return { x: foldMix(a.x, b.x, t), y: foldMix(a.y, b.y, t) };
}

function foldPulledTriangleBaseVertices(a, b, tip, pull) {
  const t = foldClamp01(pull);
  return {
    a: foldMixPoint(a, tip, t),
    b: foldMixPoint(b, tip, t)
  };
}

function foldHexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return { r: 0, g: 229, b: 255 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function foldRgbToHex(rgb) {
  const c = function (v) {
    const s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
    return s.length === 1 ? '0' + s : s;
  };
  return '#' + c(rgb.r) + c(rgb.g) + c(rgb.b);
}

function foldMixHex(a, b, t) {
  const ca = foldHexToRgb(a);
  const cb = foldHexToRgb(b);
  return foldRgbToHex({
    r: foldMix(ca.r, cb.r, t),
    g: foldMix(ca.g, cb.g, t),
    b: foldMix(ca.b, cb.b, t)
  });
}

function foldTriangleColor(depth, openAmount) {
  const d = foldClamp01(depth);
  const o = foldClamp01(openAmount);
  const idle = foldMixHex('#082f49', '#00e5ff', d);
  const active = foldMixHex('#00e5ff', '#39ff14', d);
  return foldMixHex(idle, active, o);
}

function foldLngLatFromPx(point) {
  const ll = pxToLngLat(point.x, point.y);
  if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return null;
  return ll;
}

// Laser overlay for one pair: push the current pen position (lng/lat) onto the
// pair's trail, drop stale points, and emit a point feature per trail entry that
// fades (opacity + radius) by age. The newest point is the bright laser dot; the
// rest form a short fading tail behind the pen. `visualOpen` (0..1) modulates the
// overall intensity so the laser brightens as the pair opens.
function foldLaserFeatures(penLL, color, visualOpen, key, now) {
  const features = [];
  let trail = foldLaserTrails[key];
  if (!trail) trail = foldLaserTrails[key] = [];
  if (penLL) {
    trail.push({ lng: penLL[0], lat: penLL[1], at: now });
    if (trail.length > FOLD_LASER_MAX_POINTS) trail.splice(0, trail.length - FOLD_LASER_MAX_POINTS);
  }
  // drop expired points
  while (trail.length && (now - trail[0].at) > FOLD_LASER_TRAIL_MS) trail.shift();
  if (!trail.length) { delete foldLaserTrails[key]; return features; }

  const intensity = 0.35 + 0.65 * foldClamp01(visualOpen);
  for (let i = 0; i < trail.length; i++) {
    const pt = trail[i];
    const age = (now - pt.at) / FOLD_LASER_TRAIL_MS;       // 0 newest → 1 oldest
    const life = foldClamp01(1 - age);
    const isTip = i === trail.length - 1;
    const k = isTip ? 1 : life * life;                     // tip is brightest; tail eases out
    features.push({
      type: 'Feature',
      properties: {
        role: 'fold-laser',
        key: key,
        color: color || FOLD_PEN_COLOR,
        core: (isTip ? 6 : 3.5) * (0.6 + 0.4 * life),
        coreOpacity: (isTip ? 0.98 : 0.55) * k * intensity,
        glow: (isTip ? 22 : 12) * (0.6 + 0.4 * life),
        glowOpacity: (isTip ? 0.4 : 0.22) * k * intensity
      },
      geometry: { type: 'Point', coordinates: [pt.lng, pt.lat] }
    });
  }
  return features;
}

// Ghost preview: a faint, small dot at the prospective pen point shown while a
// draw pair is DETECTED but NOT yet open — so the user sees where the line will
// start before they fold to draw. It brightens slightly as the fold approaches
// the open threshold (visualOpen 0→1).
function foldGhostFeature(penLL, color, visualOpen, key) {
  if (!penLL) return null;
  const t = foldClamp01(visualOpen);
  return {
    type: 'Feature',
    properties: {
      role: 'fold-ghost',
      key: key,
      color: color || FOLD_PEN_COLOR,
      core: 3 + 1.5 * t,
      coreOpacity: 0.22 + 0.33 * t,   // faint, a bit brighter as it nears opening
      glow: 12 + 6 * t,
      glowOpacity: 0.10 + 0.12 * t
    },
    geometry: { type: 'Point', coordinates: [penLL[0], penLL[1]] }
  };
}

// Hinge / fixed-edge / edge-offset are shared from src/foldGeometry.js.
const foldHingePx = window.CompactFoldGeometry.hinge;
const foldFixedEdge = window.CompactFoldGeometry.fixedEdge;
const foldEdgeOffsetPx = window.CompactFoldGeometry.edgeOffset;

// Drives every configured fold pair (drawing AND erasing share the same fold/open
// mechanism). For each pair whose two tags are both visible and "opened", the
// offset-midpoint pen is either fed into `drawPoints` (draw pairs) or pushed into
// `erasePoints` (eraser pairs). Also draws a debug/laser overlay so the geometry is
// verifiable. Per-pair hysteresis. Effective point (per compare.py): each tag's
// FIXED edge (corners 2→3, the decoded bottom edge) centre pushed by the pair's
// offsetCm along edge's NORMAL; the hinge edge is used only for the open/close angle.
function applyFoldPairs(tags, drawPoints, erasePoints, nowMs) {
  const byId = {};
  for (const t of (tags || [])) {
    if (t && Number.isFinite(Number(t.id))) byId[Number(t.id)] = t;
  }
  const ok2 = function (ll) { return ll && Number.isFinite(ll[0]) && Number.isFinite(ll[1]); };
  const feats = [];
  const now = Number(nowMs) || Date.now();
  toolPairFrame = null;   // republished below while the tool-selection pair is visible
  for (const pair of FOLD_PAIRS) {
    const isEraser = pair.tool === 'eraser';
    const pairColor = isEraser ? toolPairLaserColor() : (pair.color || FOLD_PEN_COLOR);
    const ta = byId[Number(pair.a)], tb = byId[Number(pair.b)];
    const ready = ta && tb &&
      Array.isArray(ta.uvCorners) && ta.uvCorners.length >= 4 &&
      Array.isArray(tb.uvCorners) && tb.uvCorners.length >= 4;
    if (!ready) {
      foldPairLatch[pair.key] = false; delete foldPairVisual[pair.key];
      delete foldCornerEma[String(pair.a)]; delete foldCornerEma[String(pair.b)];
      continue;
    }
    const cornersA = smoothFoldCorners(pair.a, ta.uvCorners.map(function (c) { return uvToPx(c.u, c.v); }));
    const cornersB = smoothFoldCorners(pair.b, tb.uvCorners.map(function (c) { return uvToPx(c.u, c.v); }));
    const edgesA = foldTagEdgesPx(cornersA);
    const edgesB = foldTagEdgesPx(cornersB);
    const hinge = foldHingePx(edgesA, edgesB);           // hinge → open/close angle ONLY
    if (!hinge) { foldPairLatch[pair.key] = false; delete foldPairVisual[pair.key]; continue; }
    // Effective point: offset the FIXED tag-local edge (corners 2→3) along its normal.
    const ea = foldFixedEdge(edgesA, FOLD_EDGE_INDEX);
    const eb = foldFixedEdge(edgesB, FOLD_EDGE_INDEX);
    if (!ea || !eb) { foldPairLatch[pair.key] = false; delete foldPairVisual[pair.key]; continue; }
    const pairOffsetCm = Math.max(0, Math.min(20, Number(pair.offsetCm)));
    const offsetCm = Number.isFinite(pairOffsetCm) ? pairOffsetCm : DEFAULT_FOLD_OFFSET_CM;
    const offPxA = (offsetCm / FOLD_TAG_SIZE_CM) * foldMeanSidePx(cornersA);
    const offPxB = (offsetCm / FOLD_TAG_SIZE_CM) * foldMeanSidePx(cornersB);
    const oa = foldEdgeOffsetPx(ea, offPxA);
    const ob = foldEdgeOffsetPx(eb, offPxB);
    const effectivePoint = { x: (oa.x + ob.x) / 2, y: (oa.y + ob.y) / 2 };
    const penLL = pxToLngLat(effectivePoint.x, effectivePoint.y);
    if (!ok2(penLL)) continue;
    // Hysteresis: open once past OPEN, stay open until it drops below CLOSE.
    const open = foldPairLatch[pair.key] ? (hinge.angle > FOLD_PEN_CLOSE_ANGLE_DEG)
                                         : (hinge.angle >= FOLD_PEN_OPEN_ANGLE_DEG);
    foldPairLatch[pair.key] = open;
    const targetOpen = foldClamp01((hinge.angle - FOLD_PEN_CLOSE_ANGLE_DEG) /
      Math.max(1e-6, FOLD_PEN_OPEN_ANGLE_DEG - FOLD_PEN_CLOSE_ANGLE_DEG));
    const visual = foldPairVisual[pair.key] || { value: targetOpen, at: now };
    const dt = Math.max(0, Math.min(160, now - Number(visual.at || now)));
    const ease = 1 - Math.exp(-dt / 180);
    const visualOpen = foldMix(Number(visual.value) || 0, targetOpen, ease);
    foldPairVisual[pair.key] = { value: visualOpen, at: now };

    // Laser overlay: trail the pen tip only while the pair is open (drawing/erasing).
    // When closed, feed null so the existing trail just fades out and clears.
    feats.push.apply(feats, foldLaserFeatures(
      open ? penLL : null, pairColor, visualOpen, pair.key, now));
    // Not open yet → show the faint ghost preview at the prospective pen point.
    if (!open) {
      const ghost = foldGhostFeature(penLL, pairColor, visualOpen, pair.key);
      if (ghost) feats.push(ghost);
    }

    if (isEraser) {
      // Tool-selection pair: publish its per-frame state; the actual action
      // (erase / draw / comment / select — per the arc menu) is routed by
      // applyToolPairFrame() right after this function.
      toolPairFrame = {
        pairKey: String(pair.key),
        open: open,
        tipPx: { x: effectivePoint.x, y: effectivePoint.y },
        tipLL: { lng: penLL[0], lat: penLL[1] },
        anchorPx: {
          x: (foldTagCenterPx(cornersA).x + foldTagCenterPx(cornersB).x) / 2,
          y: (foldTagCenterPx(cornersA).y + foldTagCenterPx(cornersB).y) / 2
        },
        tagSizePx: (foldMeanSidePx(cornersA) + foldMeanSidePx(cornersB)) / 2
      };
    } else if (open) {
      // feed the real drawing module → same interpolation / speed / distance tolerances
      drawPoints['pair:' + pair.key] = { lng: penLL[0], lat: penLL[1], color: pair.color || FOLD_PEN_COLOR };
    }
  }
  const src = map.getSource(FOLD_PEN_SOURCE_ID);
  if (src) {
    // Skip the setData() (and the Mapbox re-tessellate + GPU re-upload it
    // triggers) when the overlay geometry is unchanged from last frame. When
    // no fold pairs are active, feats is empty — only push the one empty
    // collection needed to clear a previously drawn triangle.
    const sig = feats.length
      ? JSON.stringify(feats)
      : '';
    if (sig !== foldOverlaySig) {
      foldOverlaySig = sig;
      src.setData({ type: 'FeatureCollection', features: feats });
    }
  }
}
let foldOverlaySig = null;

function ensureCustomLayers() {
  ensureFloorplanLayer();
  ensureFloorplanBasemap();
  overlays.ensureTagMaskLayer();
  drawing.ensureLayer();
  roadSnapping.ensureRoadsLayer();
  roadSnapping.ensureSnappedLayer();
  isochrone.ensureLayers();
  routing.ensureLayers();
  ensureFoldPenLayer();
}

function setMapTheme(theme) {
  // Re-fit the floorplan to the viewport each time we (re)enter the indoor
  // basemap, so an indoor step always frames the plan. Clear the fit-suppress
  // flag too; the runtime sets it again (via applyStepView) only if the step
  // has a saved camera.
  if (String(theme) === MAP_THEME_FLOORPLAN && activeMapTheme !== MAP_THEME_FLOORPLAN) {
    workshopFloorplanFitDone = false;
    workshopSuppressFloorplanFit = false;
  }
  var result = mapRuntime.applyTheme(theme);
  activeMapTheme = result && typeof result === 'object' ? result.theme : result;
  // Remember the last outdoor basemap so the Indoor/Outdoor toggle can restore
  // it when leaving the floorplan.
  if (activeMapTheme !== MAP_THEME_FLOORPLAN) lastOutdoorTheme = activeMapTheme;
  // A real setStyle() reload wipes every source/layer and reloads async. Until
  // the next 'style.load' fires, isStyleLoaded() can still report the OUTGOING
  // style as loaded — so anything that touches draw layers must wait for the
  // flush in onMapStyleLoad rather than trusting whenMapStyleReady's sync path.
  if (result && typeof result === 'object' && result.reloaded) {
    styleReloadPending = true;
  }
  var ensure3DBuildings = function () {
    if (window.CompactMapSetup && typeof window.CompactMapSetup.add3DBuildings === 'function') {
      window.CompactMapSetup.add3DBuildings(map);
    }
  };
  if (map && typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) {
    if (typeof map.once === 'function') {
      map.once('style.load', ensure3DBuildings);
    }
  } else {
    ensure3DBuildings();
  }
  return activeMapTheme;
}

function ensureStreetsThemeWithBuildings() {
  if (activeMapTheme !== MAP_THEME_STREETS) {
    return setMapTheme(MAP_THEME_STREETS);
  }
  if (window.CompactMapSetup && typeof window.CompactMapSetup.add3DBuildings === 'function') {
    window.CompactMapSetup.add3DBuildings(map);
  }
  return activeMapTheme;
}

function toggleMapTheme() {
  const idx = MAP_THEMES_CYCLE.indexOf(activeMapTheme);
  const next = MAP_THEMES_CYCLE[(idx + 1) % MAP_THEMES_CYCLE.length];
  return setMapTheme(next);
}

function canAccessMapboxViews() {
  return !!(mapConfig && mapConfig.useMapboxServices);
}

function fetchGoogleMapsKey() {
  if (googleMapsKeyCached) return Promise.resolve(googleMapsKeyCached);
  if (googleMapsKeyPromise) return googleMapsKeyPromise;
  googleMapsKeyPromise = fetch('/api/google-maps-key', { cache: 'no-store' })
    .then(function (response) { return response.json(); })
    .then(function (data) {
      googleMapsKeyCached = data && data.ok && data.key ? String(data.key).trim() : '';
      return googleMapsKeyCached;
    })
    .catch(function () {
      googleMapsKeyCached = '';
      return '';
    })
    .finally(function () {
      googleMapsKeyPromise = null;
    });
  return googleMapsKeyPromise;
}

function buildStreetViewUrl(lngLat, key, heading) {
  if (!lngLat || !key) return '';
  var lng = Number(lngLat.lng);
  var lat = Number(lngLat.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return '';
  var url = new URL('https://www.google.com/maps/embed/v1/streetview');
  url.searchParams.set('key', key);
  url.searchParams.set('location', String(lat) + ',' + String(lng));
  var headingNum = Number(heading);
  url.searchParams.set('heading', String(Number.isFinite(headingNum) ? headingNum : STREET_VIEW_HEADING));
  url.searchParams.set('pitch', String(STREET_VIEW_PITCH));
  url.searchParams.set('fov', String(STREET_VIEW_FOV));
  return url.toString();
}

// Lazy-load the Google Maps JS SDK once, then resolve. Subsequent calls
// reuse the same promise. The SDK is the only way to update heading without
// reloading the iframe — the embed API rebuilds on every src change.
function ensureStreetViewSdk() {
  if (window.google && window.google.maps && window.google.maps.StreetViewPanorama) {
    return Promise.resolve(window.google.maps);
  }
  if (streetViewSdkPromise) return streetViewSdkPromise;
  streetViewSdkPromise = fetchGoogleMapsKey().then(function (key) {
    if (!key) throw new Error('no_google_maps_key');
    return new Promise(function (resolve, reject) {
      var existing = document.getElementById('googleMapsSdkScript');
      if (existing) {
        existing.addEventListener('load', function () { resolve(window.google && window.google.maps); });
        existing.addEventListener('error', function () { reject(new Error('sdk_load_failed')); });
        return;
      }
      var s = document.createElement('script');
      s.id = 'googleMapsSdkScript';
      s.async = true;
      s.defer = true;
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key);
      s.addEventListener('load', function () { resolve(window.google && window.google.maps); });
      s.addEventListener('error', function () { reject(new Error('sdk_load_failed')); });
      document.head.appendChild(s);
    });
  });
  streetViewSdkPromise.catch(function () {
    // Allow a future retry after a transient failure.
    streetViewSdkPromise = null;
  });
  return streetViewSdkPromise;
}

function ensureStreetViewPanorama(lngLat, heading) {
  return ensureStreetViewSdk().then(function (maps) {
    if (!maps || !maps.StreetViewPanorama) return null;
    if (streetViewPanorama) return streetViewPanorama;
    var host = document.getElementById('streetViewPanorama');
    if (!host) return null;
    streetViewPanorama = new maps.StreetViewPanorama(host, {
      position: { lat: Number(lngLat.lat), lng: Number(lngLat.lng) },
      pov: { heading: Number(heading) || 0, pitch: STREET_VIEW_PITCH },
      zoom: 0,
      addressControl: false,
      fullscreenControl: false,
      linksControl: false,
      panControl: false,
      enableCloseButton: false,
      motionTracking: false,
      motionTrackingControl: false,
      showRoadLabels: false,
      visible: true
    });
    streetViewLastPosition = { lat: Number(lngLat.lat), lng: Number(lngLat.lng) };
    streetViewLastHeading = Number(heading) || 0;
    if (streetViewInset) streetViewInset.classList.add('pano-ready');
    return streetViewPanorama;
  }).catch(function () { return null; });
}

function streetViewPositionsDifferEnough(a, b) {
  if (!a || !b) return true;
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lng)) return true;
  if (!Number.isFinite(b.lat) || !Number.isFinite(b.lng)) return true;
  return streetViewDistanceMeters(a, b) >= STREET_VIEW_REQUEST_DISTANCE_M;
}

function applyStreetViewPanoramaState(lngLat, heading) {
  if (!streetViewPanorama) return false;
  var pos = { lat: Number(lngLat.lat), lng: Number(lngLat.lng) };
  if (Number.isFinite(pos.lat) && Number.isFinite(pos.lng)) {
    if (streetViewPositionsDifferEnough(streetViewLastPosition, pos)) {
      try { streetViewPanorama.setPosition(pos); } catch (_err) {}
      streetViewLastPosition = pos;
    }
  }
  var headingNum = Number(heading);
  if (Number.isFinite(headingNum)) {
    // Heading update is purely client-side — never reloads the panorama.
    if (Math.abs(headingNum - streetViewLastHeading) > 0.5) {
      try { streetViewPanorama.setPov({ heading: headingNum, pitch: STREET_VIEW_PITCH }); } catch (_err) {}
      streetViewLastHeading = headingNum;
    }
  }
  return true;
}

function setStreetViewVisible(visible) {
  if (!streetViewInset) return;
  streetViewVisible = !!visible;
  streetViewInset.classList.toggle('visible', streetViewVisible);
  streetViewInset.setAttribute('aria-hidden', streetViewVisible ? 'false' : 'true');
}

function hasFiniteStreetViewLngLat(lngLat) {
  return !!(lngLat && Number.isFinite(Number(lngLat.lng)) && Number.isFinite(Number(lngLat.lat)));
}

function quantizeStreetViewLngLat(lngLat) {
  if (!hasFiniteStreetViewLngLat(lngLat)) return null;
  var scale = Math.pow(10, STREET_VIEW_COORD_DECIMALS);
  return {
    lng: Math.round(Number(lngLat.lng) * scale) / scale,
    lat: Math.round(Number(lngLat.lat) * scale) / scale
  };
}

function streetViewLngLatKey(lngLat) {
  if (!hasFiniteStreetViewLngLat(lngLat)) return '';
  return Number(lngLat.lat).toFixed(STREET_VIEW_COORD_DECIMALS) + ',' + Number(lngLat.lng).toFixed(STREET_VIEW_COORD_DECIMALS);
}

function streetViewDistanceMeters(a, b) {
  if (!hasFiniteStreetViewLngLat(a) || !hasFiniteStreetViewLngLat(b)) return Infinity;
  var lat1 = Number(a.lat) * Math.PI / 180;
  var lat2 = Number(b.lat) * Math.PI / 180;
  var dLat = lat2 - lat1;
  var dLng = (Number(b.lng) - Number(a.lng)) * Math.PI / 180;
  var sinLat = Math.sin(dLat / 2);
  var sinLng = Math.sin(dLng / 2);
  var h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function clearStreetViewHideTimer() {
  if (!streetViewHideTimer) return;
  window.clearTimeout(streetViewHideTimer);
  streetViewHideTimer = 0;
}

function clearStreetViewRequestTimer() {
  if (!streetViewRequestTimer) return;
  window.clearTimeout(streetViewRequestTimer);
  streetViewRequestTimer = 0;
  streetViewPendingRequestKey = '';
}

function scheduleStreetViewHide() {
  if (streetViewHideTimer) return;
  streetViewHideTimer = window.setTimeout(function () {
    streetViewHideTimer = 0;
    clearStreetViewRequestTimer();
    setStreetViewVisible(false);
  }, STREET_VIEW_MISSING_HOLD_MS);
}

function commitStreetViewRequest(requestLngLat, heading) {
  if (streetViewDesiredState !== 'inside' || !pageFlow || !pageFlow.isMapPage()) return;
  var effectiveLngLat = quantizeStreetViewLngLat(requestLngLat);
  if (!effectiveLngLat) return;
  // Prefer the JS panorama: position changes don't reload, heading changes
  // are purely client-side.
  ensureStreetViewPanorama(effectiveLngLat, heading).then(function (pano) {
    if (streetViewDesiredState !== 'inside' || !pageFlow || !pageFlow.isMapPage()) return;
    if (pano) {
      applyStreetViewPanoramaState(effectiveLngLat, heading);
      streetViewLastRequestedLngLat = effectiveLngLat;
      streetViewLastRequestAtMs = Date.now();
      if (streetViewLastAnchorPoint) positionStreetViewInset(streetViewLastAnchorPoint);
      setStreetViewVisible(true);
      return;
    }
    // Fallback path: the SDK didn't load. Use the embed iframe (slower —
    // every heading change reloads it, but at least Street View still works).
    if (!streetViewFrame) return;
    fetchGoogleMapsKey().then(function (key) {
      if (!streetViewFrame || streetViewDesiredState !== 'inside' || !pageFlow || !pageFlow.isMapPage()) return;
      var url = buildStreetViewUrl(effectiveLngLat, key, heading);
      if (!url) {
        setStreetViewVisible(false);
        return;
      }
      if (streetViewLastUrl !== url) {
        streetViewFrame.src = url;
        streetViewLastUrl = url;
      }
      streetViewLastRequestedLngLat = effectiveLngLat;
      streetViewLastRequestAtMs = Date.now();
      if (streetViewLastAnchorPoint) positionStreetViewInset(streetViewLastAnchorPoint);
      setStreetViewVisible(true);
    });
  });
}

function shouldRequestNewStreetView(rawLngLat) {
  if (!hasFiniteStreetViewLngLat(rawLngLat)) return false;
  var quantized = quantizeStreetViewLngLat(rawLngLat);
  if (!quantized) return false;
  if (!streetViewLastRequestedLngLat || !streetViewLastUrl) return true;
  return streetViewDistanceMeters(quantized, streetViewLastRequestedLngLat) >= STREET_VIEW_REQUEST_DISTANCE_M;
}

function scheduleStreetViewRequest(rawLngLat, heading) {
  var quantized = quantizeStreetViewLngLat(rawLngLat);
  if (!quantized) return;
  var requestKey = streetViewLngLatKey(quantized);
  if (!requestKey) return;
  if (streetViewRequestTimer && streetViewPendingRequestKey === requestKey) return;
  clearStreetViewRequestTimer();
  streetViewPendingRequestKey = requestKey;
  var remainingCooldown = Math.max(0, STREET_VIEW_REQUEST_COOLDOWN_MS - (Date.now() - streetViewLastRequestAtMs));
  var delay = Math.max(STREET_VIEW_REQUEST_DEBOUNCE_MS, remainingCooldown);
  streetViewRequestTimer = window.setTimeout(function () {
    streetViewRequestTimer = 0;
    streetViewPendingRequestKey = '';
    commitStreetViewRequest(quantized, heading);
  }, delay);
}

function positionStreetViewInset(anchorPoint) {
  if (!streetViewInset || !anchorPoint) return;
  var x = Number(anchorPoint.x);
  var y = Number(anchorPoint.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  streetViewInset.style.left = String(x) + 'px';
  streetViewInset.style.top = String(y) + 'px';
}

function refreshStreetViewInset(state, anchorPoint, lngLat, heading) {
  streetViewDesiredState = String(state || 'hidden');
  if (!streetViewInset || !pageFlow || !pageFlow.isMapPage()) {
    clearStreetViewHideTimer();
    clearStreetViewRequestTimer();
    streetViewDesiredState = 'hidden';
    setStreetViewVisible(false);
    return;
  }
  var hasAnchorPoint = !!(anchorPoint && Number.isFinite(anchorPoint.x) && Number.isFinite(anchorPoint.y));
  if (hasAnchorPoint) {
    streetViewLastAnchorPoint = { x: Number(anchorPoint.x), y: Number(anchorPoint.y) };
    positionStreetViewInset(streetViewLastAnchorPoint);
    if (hasFiniteStreetViewLngLat(lngLat)) {
      streetViewLastLngLat = {
        lng: Number(lngLat.lng),
        lat: Number(lngLat.lat)
      };
    }
  } else if (streetViewLastAnchorPoint) {
    positionStreetViewInset(streetViewLastAnchorPoint);
  }
  if (state === 'outside') {
    clearStreetViewHideTimer();
    clearStreetViewRequestTimer();
    streetViewDesiredState = 'hidden';
    setStreetViewVisible(false);
    return;
  }
  if (state === 'missing') {
    clearStreetViewRequestTimer();
    scheduleStreetViewHide();
    return;
  }
  clearStreetViewHideTimer();
  if (!hasFiniteStreetViewLngLat(streetViewLastLngLat)) {
    return;
  }
  // If the JS panorama is live, every frame can update it cheaply: setPosition
  // when the location moved enough (tile fetch only, no reload), setPov for
  // heading changes (purely client-side, no network).
  if (streetViewPanorama) {
    applyStreetViewPanoramaState(streetViewLastLngLat, heading);
    if (streetViewLastAnchorPoint) positionStreetViewInset(streetViewLastAnchorPoint);
    setStreetViewVisible(true);
    return;
  }
  var currentQuantizedLngLat = quantizeStreetViewLngLat(streetViewLastLngLat);
  if (!streetViewVisible && streetViewLastUrl && currentQuantizedLngLat
      && streetViewLastRequestedLngLat
      && streetViewDistanceMeters(currentQuantizedLngLat, streetViewLastRequestedLngLat) < STREET_VIEW_REQUEST_DISTANCE_M) {
    clearStreetViewRequestTimer();
    if (streetViewLastAnchorPoint) positionStreetViewInset(streetViewLastAnchorPoint);
    setStreetViewVisible(true);
    return;
  }
  if (shouldRequestNewStreetView(streetViewLastLngLat)) {
    scheduleStreetViewRequest(streetViewLastLngLat, heading);
  } else if (streetViewVisible && streetViewLastAnchorPoint) {
    clearStreetViewRequestTimer();
    positionStreetViewInset(streetViewLastAnchorPoint);
  }
}

function mapViewportPolygon() {
  const size = mapWarpController.getViewportSize();
  const w = Number(size.width) || 0;
  const h = Number(size.height) || 0;
  return [
    mapWarpController.localToViewport(0, 0),
    mapWarpController.localToViewport(w, 0),
    mapWarpController.localToViewport(w, h),
    mapWarpController.localToViewport(0, h)
  ];
}

function pointInPolygon(point, polygon) {
  if (!point || !Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i] && polygon[i].x);
    const yi = Number(polygon[i] && polygon[i].y);
    const xj = Number(polygon[j] && polygon[j].x);
    const yj = Number(polygon[j] && polygon[j].y);
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) continue;
    const intersects = ((yi > point.y) !== (yj > point.y))
      && (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-9) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function drawCameraOverlay() {
  overlays.drawCameraOverlay({
    page: currentPage(),
    frame: lastFrame,
    tags: lastTags,
    corners: lastCorners,
    mouseInsideCamera,
    mouseClientX,
    mouseClientY
  });
}

function refreshHud() {
  const mode = calibration.isActive() ? 'ON' : 'OFF';
  const mask = overlays.isMaskEnabled() ? 'ON' : 'OFF';
  const cornerCount = cornersSetCount(lastCorners);
  const theme = activeMapTheme.toUpperCase();
  const base = `Source: ${lastSource} | frame: ${lastFrame.width}x${lastFrame.height} | corners: ${cornerCount}/4 | tags: ${lastTags.length} | theme: ${theme} | C: ${mode}`;
  const note = uiNote || calibration.getNote();
  const roads = roadSnapping.isRoadsVisible() ? 'ON' : 'OFF';
  const debug = debugMarkersVisible ? 'ON' : 'OFF';
  const transport = customMapObjects.isModeVisible('transportation') ? 'ON' : 'OFF';
  const landmark = customMapObjects.isModeVisible('landmark') ? 'ON' : 'OFF';
  const amenities = customMapObjects.isModeVisible('amenities') ? 'ON' : 'OFF';
  const isovistHint = isFloorplanMode ? ' | I: isovist' : '';
  const timeline = timelineRecording ? 'ON' : 'OFF';
  hud.textContent = `${base} | mask(T): ${mask} | roads(O): ${roads} | tags(D): ${debug} | timeline(Y): ${timeline} | N: object | 1 transport: ${transport} | 2 landmark: ${landmark} | 3 amenities: ${amenities} | L: theme | V: view filters | H: HUD | X: clear | M: snap | S: save${isovistHint} | ${calibration.getHint()} | B: main menu${note ? ` | ${note}` : ''}`;
}

function makeMarker(id) {
  const el = document.createElement('div');
  el.className = 'dot';
  if (KEYBOARD_ANNOTATION_TAG_IDS.has(String(id))) {
    el.dataset.keyboardAnnotationMarker = '1';
  }
  const assignment = tagAssignments ? tagAssignments.getAssignment(id) : null;
  if (assignment && assignment.color) el.style.background = assignment.color;
  el.title = assignment
    ? `Tag ${id} (${assignment.tool} ${assignment.colorName})`
    : `Tag ${id}`;
  const marker = new mapboxgl.Marker({ element: el }).setLngLat([0, 0]).addTo(map);
  applyDebugMarkerVisibility(marker);
  return marker;
}

function uvToPx(u, v) {
  const viewport = mapWarpController.getViewportSize();
  const w = viewport.width;
  const h = viewport.height;
  // uv is normalized over the whole screen (the calibrated surface). Turn it into a
  // screen pixel, then invert the page warp to get the map-canvas pixel the tag sits
  // over: the map is displayed warped via the #projectionWarp CSS transform, and its
  // canvas pixels are the un-warped space MapLibre projects/unprojects in.
  const screenX = u * w;
  const screenY = v * h;
  if (mapWarpController && typeof mapWarpController.screenToMap === 'function') {
    const local = mapWarpController.screenToMap(screenX, screenY);
    return { x: Number(local.x), y: Number(local.y) };
  }
  return { x: screenX, y: screenY };
}

function pxToLngLat(x, y) {
  const local = mapWarpController.viewportToLocal(x, y);
  const ll = map.unproject([local.x, local.y]);
  return [ll.lng, ll.lat];
}

function lngLatToPx(lng, lat) {
  const point = map.project([lng, lat]);
  const viewportPoint = mapWarpController.localToViewport(point.x, point.y);
  return { x: Number(viewportPoint.x), y: Number(viewportPoint.y) };
}

function uvToLngLat(u, v) {
  const px = uvToPx(u, v);
  return pxToLngLat(px.x, px.y);
}

function tagAngleDeg(tag) {
  if (!tag || !Array.isArray(tag.uvCorners) || tag.uvCorners.length < 2) return 0;
  const c0 = tag.uvCorners[0];
  const c1 = tag.uvCorners[1];
  if (!c0 || !c1 || !Number.isFinite(c0.u) || !Number.isFinite(c0.v) || !Number.isFinite(c1.u) || !Number.isFinite(c1.v)) return 0;
  const p0 = uvToPx(c0.u, c0.v);
  const p1 = uvToPx(c1.u, c1.v);
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  if ((dx * dx + dy * dy) < 0.0001) return 0;
  return Math.atan2(dy, dx) * (180 / Math.PI);
}

function tagSizePx(tag) {
  if (!tag || !Array.isArray(tag.uvCorners) || tag.uvCorners.length < 4) return 28;
  const corners = tag.uvCorners;
  let totalLen = 0;
  let count = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    if (!a || !b || !Number.isFinite(a.u) || !Number.isFinite(a.v) || !Number.isFinite(b.u) || !Number.isFinite(b.v)) continue;
    const pa = uvToPx(a.u, a.v);
    const pb = uvToPx(b.u, b.v);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    totalLen += Math.sqrt(dx * dx + dy * dy);
    count++;
  }
  return count > 0 ? totalLen / count : 28;
}

async function setCorner(index, point) {
  const res = await fetch('/api/corners', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index, x: point.x, y: point.y })
  });
  const data = await res.json();
  if (!res.ok || !data || data.ok !== true) {
    throw new Error('corner_set_failed');
  }
  lastCorners = Array.isArray(data.corners) ? data.corners : lastCorners;
}

async function resetCorners() {
  const res = await fetch('/api/corners', { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok || !data || data.ok !== true) {
    throw new Error('corner_reset_failed');
  }
  lastCorners = Array.isArray(data.corners) ? data.corners : [null, null, null, null];
}

pageFlow = window.CompactPageFlow.createPageFlow({
  cameraPage,
  mapPage,
  nextBtn,
  storageKey: 'compact-workshop-page',
  onNextToMap: function () {
    setUiNote('');
  },
  onBackToCamera: function () {
    setUiNote('');
    refreshHud();
  },
  onPageChange: function (page) {
    setCameraFeedActive(page === 'camera');
    stickerPlacement.setEnabled(page === 'map');
    annotationPlacement.setEnabled(page === 'map');
    generalAnnotationPlacement.setEnabled(page === 'map');
    if (page !== 'map') {
      resetPanTagRuntime();
      resetMoveTagTarget();
    }
    if (page === 'map') {
      mapWarpController.initIfNeeded();
    }
    refreshHud();
    drawCameraOverlay();
  }
});

if (cameraStage) {
  cameraStage.addEventListener('mousemove', function (e) {
    mouseInsideCamera = true;
    mouseClientX = e.clientX;
    mouseClientY = e.clientY;
    drawCameraOverlay();
  });

  cameraStage.addEventListener('mouseleave', function () {
    mouseInsideCamera = false;
    drawCameraOverlay();
  });
}

// Is the mouse currently usable as the synthetic cursor tag? Disabled while
function cursorTagInteractionEnabled() {
  if (!pageFlow || !pageFlow.isMapPage()) return false;
  return true;
}

function updateCursorTagFromEvent(e) {
  if (!mapView) return;
  var rect = mapView.getBoundingClientRect();
  cursorTag.x = e.clientX - rect.left;
  cursorTag.y = e.clientY - rect.top;
}

// End an active Ctrl cursor gesture and restore map panning. Safe to call
// repeatedly (no-op if no gesture is active).
function endCursorTagGesture() {
  cursorTag.pressed = false;
  if (cursorTag.dragPanWasEnabled !== null) {
    if (cursorTag.dragPanWasEnabled && map && map.dragPan
        && typeof map.dragPan.enable === 'function') {
      map.dragPan.enable();
    }
    cursorTag.dragPanWasEnabled = null;
  }
}

if (mapView) {
  mapView.addEventListener('mousedown', function (e) {
    // Ctrl+Click (⌘+Click on macOS) engages the cursor tag. A plain click is
    // left alone so it still pans the map via Mapbox. Stop propagation so the
    // map doesn't start a pan-drag underneath the cursor gesture.
    if (cursorTagInteractionEnabled() && (e.ctrlKey || e.metaKey) && e.button === 0) {
      e.preventDefault();
      e.stopPropagation();
      updateCursorTagFromEvent(e);
      cursorTag.pressed = true;
      cursorTag.pressEdge = true;
      cursorTag.pressX = cursorTag.x;
      cursorTag.pressY = cursorTag.y;
      cursorTag.commentHoldUntilMs = Date.now() + CURSOR_COMMENT_HOLD_MS;
      // Suppress map panning for the duration of the gesture (restored in
      // endCursorTagGesture), mirroring the floorplan VGA drag pattern.
      if (cursorTag.dragPanWasEnabled === null) {
        cursorTag.dragPanWasEnabled = !!(map && map.dragPan
          && typeof map.dragPan.isEnabled === 'function' && map.dragPan.isEnabled());
      }
      if (map && map.dragPan && typeof map.dragPan.disable === 'function') {
        map.dragPan.disable();
      }
    }
  }, true);

  mapView.addEventListener('mousemove', function (e) {
    if (cursorTagInteractionEnabled()) updateCursorTagFromEvent(e);
    if (floorplanIsovistKeyboardMode) {
      setFloorplanIsovistPointerFromClient(e.clientX, e.clientY);
      updateFloorplanKeyboardIsovist();
    }
  }, true);

  mapView.addEventListener('mouseleave', function () {
    // Cursor left the map: end the gesture (and restore panning) so an
    // in-progress draw / erase ends, like a physical tag leaving the frame.
    endCursorTagGesture();
    cursorTag.insideMap = false;
  });

}

window.addEventListener('mouseup', function (e) {
  // Release the cursor-tag gesture (and restore panning) wherever the button
  // comes up, even outside the map.
  endCursorTagGesture();
}, true);

if (cameraFeed) cameraFeed.addEventListener('load', drawCameraOverlay);
window.addEventListener('resize', function () {
  drawCameraOverlay();
  updateFloorplanKeyboardIsovist();
});

viewBrightness.addEventListener('input', function () {
  applyViewFilters();
  setUiNote('View brightness ' + formatFilterValue(viewBrightness.value));
  refreshHud();
});

viewSaturation.addEventListener('input', function () {
  applyViewFilters();
  setUiNote('View saturation ' + formatFilterValue(viewSaturation.value));
  refreshHud();
});

viewContrast.addEventListener('input', function () {
  applyViewFilters();
  setUiNote('View contrast ' + formatFilterValue(viewContrast.value));
  refreshHud();
});

viewInvert.addEventListener('input', function () {
  applyViewFilters();
  setUiNote('View invert ' + formatPercentValue(viewInvert.value));
  refreshHud();
});

viewSepia.addEventListener('input', function () {
  applyViewFilters();
  setUiNote('View sepia ' + formatPercentValue(viewSepia.value));
  refreshHud();
});

viewFilterReset.addEventListener('click', function () {
  resetViewFilters();
  setUiNote('View filters reset');
  refreshHud();
});

viewFilterClose.addEventListener('click', function () {
  setViewFilterPanelVisible(false);
  setUiNote('View filters OFF');
  refreshHud();
});

window.addEventListener('keydown', function (e) {
  if (keyboardAnnotationPlacement &&
      typeof keyboardAnnotationPlacement.handleKeyDown === 'function') {
    keyboardAnnotationPlacement.handleKeyDown(e);
  }
}, true);

window.addEventListener('keydown', async function (e) {
  if (keyboardAnnotationPlacement &&
      typeof keyboardAnnotationPlacement.handleKeyDown === 'function' &&
      keyboardAnnotationPlacement.handleKeyDown(e)) {
    return;
  }

  if (e.repeat) return;

  const t = e.target;
  if (shortcutInputBlocked(t)) return;

  if (await calibration.handleKeyDown(e, lastTags, uvToPx)) {
    refreshHud();
    return;
  }

  const key = String(e.key || '').toLowerCase();
  if (key === 'h') {
    e.preventDefault();
    const visible = toggleHudVisible();
    if (visible) {
      setUiNote('HUD ON');
      refreshHud();
    }
    return;
  }

  if (key === 'v') {
    e.preventDefault();
    const visible = toggleViewFilterPanelVisible();
    setUiNote(visible ? 'Light settings ON' : 'Light settings OFF');
    refreshHud();
    return;
  }

  if (key === 't') {
    e.preventDefault();
    const enabled = overlays.toggleMaskEnabled();
    setUiNote(enabled ? 'Tag mask ON' : 'Tag mask OFF');
    refreshHud();
    return;
  }

  if (key === 'q' && pageFlow.isMapPage()) {
    e.preventDefault();
    const mode = cycleCursorToolMode();
    const labels = { draw: 'Draw', comment: 'Comment', erase: 'Erase', select: 'Select' };
    setUiNote('Cursor tool: ' + (labels[mode] || mode));
    refreshHud();
    return;
  }

  if (key === 'd') {
    e.preventDefault();
    const visible = toggleDebugMarkersVisible();
    setUiNote(visible ? 'Tag debug markers ON' : 'Tag debug markers OFF');
    refreshHud();
    return;
  }

  if (key === 'o') {
    e.preventDefault();
    roadSnapping.toggleRoads();
    setUiNote(roadSnapping.isRoadsVisible() ? 'Roads layer ON' : 'Roads layer OFF');
    refreshHud();
    return;
  }

  if (key === 'g') {
    e.preventDefault();
    if (osmnxNetwork.isFetching()) {
      setUiNote('OSMnx fetch already in progress...');
      refreshHud();
      return;
    }
    setUiNote('Fetching OSMnx road network for current view...');
    refreshHud();
    osmnxNetwork.fetchForCurrentView(function (err, result) {
      if (err) {
        setUiNote('OSMnx fetch failed: ' + (err.message || err));
      } else {
        setUiNote('OSMnx network loaded (' + result.nodes + ' nodes, ' + result.edges + ' edges)');
      }
      refreshHud();
    });
    return;
  }

  if (key === 'n') {
    e.preventDefault();
    var customObjectsVisible = customMapObjects.getPresentationMode() !== 'hidden';
    customMapObjects.setPresentationMode(customObjectsVisible ? 'hidden' : 'expanded');
    isochrone.setVisible(!customObjectsVisible);
    routing.setVisible(!customObjectsVisible);
    setUiNote(customObjectsVisible ? 'Custom objects hidden' : 'Custom objects visible');
    refreshHud();
    return;
  }

  if (key === 'l' && pageFlow.isMapPage()) {
    e.preventDefault();
    if (!canAccessMapboxViews()) {
      setUiNote('Mapbox views unavailable: add a token to token.txt');
      refreshHud();
      return;
    }
    const nextTheme = toggleMapTheme();
    const themeLabels = { streets: 'Streets view', satellite: 'Satellite view', topo: 'Topographic view' };
    setUiNote((themeLabels[nextTheme] || nextTheme) + ' ON');
    refreshHud();
    return;
  }

  if (key === 'i' && isFloorplanMode && pageFlow.isMapPage()) {
    e.preventDefault();
    var isovistOn = toggleFloorplanKeyboardIsovistMode();
    setUiNote(isovistOn ? 'Isovist ON' : 'Isovist OFF');
    refreshHud();
    return;
  }

  if (key === 'm') {
    e.preventDefault();
    roadSnapping.snapAllDrawings();
    setUiNote('Snapping drawings to roads...');
    refreshHud();
    return;
  }

  if (key === 'x') {
    e.preventDefault();
    clearAllInputs();
    setUiNote('All inputs cleared');
    refreshHud();
    return;
  }

  if (key === 'y' && pageFlow.isMapPage()) {
    e.preventDefault();
    toggleTimelineRecording();
    return;
  }

  if (key === 's') {
    e.preventDefault();
    dataExport.saveToBackend(function (err, result) {
      if (err) { setUiNote('Failed to save session'); }
      else { setUiNote('Session saved: ' + (result && result.filename)); }
      refreshHud();
    });
    setUiNote('Saving session...');
    refreshHud();
    return;
  }

  if (pageFlow.isMapPage()) {
    if (key === 'n') {
      e.preventDefault();
      if (customMapObjects.openCreateModal()) {
        setUiNote('Add object');
        refreshHud();
      }
      return;
    }

    if (key >= '1' && key <= '3') {
      e.preventDefault();
      const modes = ['transportation', 'landmark', 'amenities'];
      const labels = ['Transportation', 'Landmark', 'Amenities'];
      const idx = parseInt(key, 10) - 1;
      const visible = customMapObjects.toggleMode(modes[idx]);
      setUiNote(labels[idx] + ' ' + (visible ? 'ON' : 'OFF'));
      refreshHud();
      return;
    }
  }

  if (!pageFlow.isCameraPage()) return;

  if (key === 'r') {
    e.preventDefault();
    try {
      await resetCorners();
      setUiNote('Corners reset');
    } catch (_err) {
      setUiNote('Failed to reset corners');
    }
    refreshHud();
    drawCameraOverlay();
    return;
  }

  if (key < '1' || key > '4') return;
  e.preventDefault();

  if (!mouseInsideCamera) {
    setUiNote('Move mouse over camera feed first');
    refreshHud();
    return;
  }

  const p = overlays.clientToFrame(mouseClientX, mouseClientY, lastFrame);
  if (!p) {
    setUiNote('Mouse is outside active camera image');
    refreshHud();
    return;
  }

  const idx = parseInt(key, 10) - 1;
  try {
    await setCorner(idx, p);
    setUiNote(`Corner ${key} set`);
  } catch (_err) {
    setUiNote(`Failed to set corner ${key}`);
  }
  refreshHud();
  drawCameraOverlay();
});

// Lightweight per-frame timing, off unless `window.PERF = true` in the console.
// perfMark accumulates per-stage ms; perfReport logs the rolling averages every
// ~2s. Zero cost when PERF is falsy.
const _perfAcc = {};
let _perfFrames = 0;
let _perfLastReport = 0;
function perfNow() { return (typeof window !== 'undefined' && window.PERF) ? performance.now() : 0; }
function perfMark(label, startedAt) {
  if (!(typeof window !== 'undefined' && window.PERF)) return;
  _perfAcc[label] = (_perfAcc[label] || 0) + (performance.now() - startedAt);
}
function perfReport() {
  if (!(typeof window !== 'undefined' && window.PERF)) return;
  _perfFrames++;
  const now = performance.now();
  if (now - _perfLastReport < 2000 || _perfFrames === 0) return;
  const out = {};
  for (const k of Object.keys(_perfAcc)) out[k] = +(_perfAcc[k] / _perfFrames).toFixed(2);
  out.frames = _perfFrames;
  console.log('[PERF avg ms/frame]', out);
  for (const k of Object.keys(_perfAcc)) _perfAcc[k] = 0;
  _perfFrames = 0;
  _perfLastReport = now;
}

async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;
  const _tPoll = perfNow();
  try {
    let data = null;
    try {
      const res = await fetch('/api/tags', { cache: 'no-store' });
      if (!res.ok) throw new Error('tags ' + res.status);
      data = await res.json();
    } catch (_fetchErr) {
      data = {
        tags: [],
        corners: [null, null, null, null],
        source: 'static',
        frame: { width: 0, height: 0, seq: 0 },
        phoneControllers: {},
        commentControllers: {}
      };
    }

    lastTags = Array.isArray(data.tags) ? data.tags : [];
    lastCorners = Array.isArray(data.corners) ? data.corners : [null, null, null, null];
    lastSource = data.source || 'unknown';
    lastFrame = data.frame || { width: 0, height: 0, seq: 0 };
    lastPhoneControllers = data && data.phoneControllers && typeof data.phoneControllers === 'object'
      ? data.phoneControllers
      : {};
    lastCommentControllers = data && data.commentControllers && typeof data.commentControllers === 'object'
      ? data.commentControllers
      : {};

    // On the first successful poll after page load, force draw-tool tags
    // (11-14) back to 'draw' mode. Mode changes during the session (from
    // phone or menu) still take effect — but a hard refresh always
    // starts the draw tags in draw mode.
    if (!drawTagDefaultsApplied) {
      drawTagDefaultsApplied = true;
      for (var _dti = 0; _dti < DRAW_TOOL_TAG_IDS.length; _dti++) {
        var _drawTagId = DRAW_TOOL_TAG_IDS[_dti];
        setDrawToolMode(_drawTagId, 'draw');
        syncPhoneControllerStateFromMap(_drawTagId, { mode: 'draw', annotationText: '' });
      }
    }

    refreshHud();
    drawCameraOverlay();

    const seen = new Set();
    const currentMapPolygon = mapViewportPolygon();
    const drawPointsByTagId = {};
    const drawTagStatesById = {};
    const stickerPointsByTagId = {};
    const annotationPointsByTagId = {};
    const generalAnnotationPointsByTagId = {};
    const tagPointsById = {};
    const eraserPoints = [];
    let panPoint = null;
    let moveSelectorPoint = null;
    let isochroneTagPoint = null;
    let isochroneMinutes = 15;
    let isovistTagPoint = null;
    let routeOriginTagPoint = null;
    let routeDestTagPoint = null;
    let isochroneTagOutsideMap = false;
    let isovistTagOutsideMap = false;
    let routeTagOutsideMap = false;
    let visibleThemeTagSet = new Set(); // theme tag IDs seen this frame
    const customObjectInteractionTagPoints = [];
    const canDrawNow = pageFlow.isMapPage();
    const questionTwoActive = false;
    const visibleTagEntries = [];
    const drawToolSelectorPoints = {};
    const visibleDrawTagMap = {};
    let streetViewStateNow = 'missing';
    let streetViewAnchorPointNow = null;
    let streetViewLngLatNow = null;
    let streetViewHeadingNow = null;
    for (const tag of lastTags) {
      if (!tag || !tag.uv) continue;
      const id = String(tag.id);
      if (!markers.has(id)) markers.set(id, makeMarker(id));
      seen.add(id);
      const raw = uvToPx(tag.uv.u, tag.uv.v);
      const fixed = calibration.applyTagOffset(tag, raw.x, raw.y, uvToPx);
      const baseAssignment = tagAssignments ? tagAssignments.getAssignment(tag.id) : null;
      const assignment = effectiveAssignmentForTag(tag.id, baseAssignment);
      visibleTagEntries.push({
        tag: tag,
        id: id,
        raw: raw,
        fixed: fixed,
        assignment: assignment
      });
      if (!questionTwoActive && Number(tag.id) === 36) {
        customObjectInteractionTagPoints.push({ x: fixed.x, y: fixed.y });
      }
      if (Object.prototype.hasOwnProperty.call(DRAW_TOOL_SELECTOR_TO_TAG, Number(tag.id))
          && (!baseAssignment || baseAssignment.tool === 'selector')) {
        drawToolSelectorPoints[id] = { x: raw.x, y: raw.y };
      }
      if (assignment && assignment.tool === 'street-view') {
        streetViewAnchorPointNow = { x: fixed.x, y: fixed.y };
        var streetViewLngLatCandidate = pxToLngLat(fixed.x, fixed.y);
        streetViewLngLatNow = {
          lng: streetViewLngLatCandidate[0],
          lat: streetViewLngLatCandidate[1]
        };
        streetViewStateNow = pointInPolygon(fixed, currentMapPolygon) ? 'inside' : 'outside';
        // Derive a Street View heading (compass bearing) from the tag's
        // screen-space rotation. Updates every frame the tag is visible —
        // the panorama spins client-side without reloading.
        var rawAngle = tagAngleDeg(tag);
        var heading = (Number(rawAngle) + STREET_VIEW_HEADING_OFFSET_DEG) % 360;
        if (heading < 0) heading += 360;
        streetViewHeadingNow = heading;
      }
      if (isDrawToolTagId(tag.id)) {
        visibleDrawTagMap[Number(tag.id)] = true;
      }
      if (assignment && assignment.tool === 'pan' && PAN_TAG_IDS.indexOf(Number(tag.id)) !== -1) {
        var tid = Number(tag.id);
        // Only tag 22 drives panning
        if (tid === 22) {
          panPoint = { x: raw.x, y: raw.y, tagId: tid };
        }
      }
      if (assignment && assignment.tool === 'drag') {
        const selectorLngLat = pxToLngLat(fixed.x, fixed.y);
        const selectorCandidate = {
          lng: selectorLngLat[0],
          lat: selectorLngLat[1],
          tagId: Number(tag.id),
          selectorKey: 'tag:' + String(tag.id)
        };
        if (!moveSelectorPoint || selectorCandidate.tagId < moveSelectorPoint.tagId) {
          moveSelectorPoint = selectorCandidate;
        }
      }
    }

    // Cursor-as-tag: the mouse behaves like a 5th draw-tool tag using the
    // globally last-activated controller mode. Computed here, right after the
    // real tags, so `select` can feed moveSelectorPoint alongside physical
    // drag tags; draw / erase / comment are injected into visibleTagEntries
    // below for the existing tool routing.
    //
    // Gesture model, matching each mode's physical-tag feel:
    //  - draw / erase / select: active while the button is held (a press-drag
    //    = a tag continuously present) so strokes paint, erase, or a grabbed
    //    feature follows the cursor.
    //  - comment: active for the single poll right after a click, so the
    //    annotation textarea anchors where you clicked instead of chasing the
    //    moving cursor every frame.
    refreshGlobalCursorMode();
    cursorTag.pressEdge = false;
    if (canDrawNow && cursorTagInteractionEnabled() && cursorTag.mode) {
      var cMode = cursorTag.mode;
      // draw / erase / select track the live cursor while held. comment
      // freezes at the click point for a hold window so the textarea spawns
      // and survives without the box chasing the mouse.
      var cContinuous = (cMode === 'draw' || cMode === 'erase' || cMode === 'select');
      var cPresent;
      var cursorFixed;
      if (cContinuous) {
        cursorFixed = { x: cursorTag.x, y: cursorTag.y };
        cPresent = cursorTag.pressed;
      } else {
        cursorFixed = { x: cursorTag.pressX, y: cursorTag.pressY };
        cPresent = Date.now() < cursorTag.commentHoldUntilMs;
      }
      cursorTag.insideMap = pointInPolygon(cursorFixed, currentMapPolygon);
      if (cursorTag.insideMap && cPresent) {
        var cAssignInfo = cursorTagAssignment();
        // Borrow the active controller's paired tag id (11-14). If that
        // physical tag is also on the table this frame it already drives the
        // pipeline — yield to it so we don't double-write its runtime.
        var cTagId = cAssignInfo ? Number(cAssignInfo.tagId) : 0;
        var cAssign = cAssignInfo ? cAssignInfo.assignment : null;
        var physicalTagPresent = cTagId && !!visibleDrawTagMap[cTagId];
        if (cAssign && !physicalTagPresent) {
          if (cMode === 'select') {
            // Mirror the physical drag-tag path so move/select reuses the
            // same grab-and-follow logic.
            var cSelLngLat = pxToLngLat(cursorFixed.x, cursorFixed.y);
            var cSelCandidate = {
              lng: cSelLngLat[0],
              lat: cSelLngLat[1],
              tagId: cTagId,
              selectorKey: 'cursor'
            };
            if (!moveSelectorPoint || cSelCandidate.tagId < moveSelectorPoint.tagId) {
              moveSelectorPoint = cSelCandidate;
            }
          } else {
            var cursorIdStr = String(cTagId);
            if (!markers.has(cursorIdStr)) markers.set(cursorIdStr, makeMarker(cursorIdStr));
            visibleTagEntries.push({
              tag: { id: cTagId, uv: { u: 0, v: 0 } },
              id: cursorIdStr,
              raw: { x: cursorTag.x, y: cursorTag.y },
              fixed: cursorFixed,
              assignment: cAssign
            });
          }
        }
      }
    }

    refreshStreetViewInset(streetViewStateNow, streetViewAnchorPointNow, streetViewLngLatNow, streetViewHeadingNow);
    const nowMs = Date.now();
    syncDrawToolMenus(canDrawNow, drawToolSelectorPoints, visibleDrawTagMap);
    // --- Collect tag 21 raw position for position-based zoom ---
    var curTag21RawX = null;
    for (const entry of visibleTagEntries) {
      if (Number(entry.tag.id) === 21 && entry.raw && Number.isFinite(entry.raw.x)) {
        curTag21RawX = entry.raw.x;
        break;
      }
    }

    // --- Tag-21 position-based zoom (independent of tag 22) ---
    if (canDrawNow) {
      if (curTag21RawX !== null) {
        tag21MissingSinceMs = 0;
        if (tag21BaselineRawX === null) {
          tag21BaselineRawX = curTag21RawX;
          tag21BaselineZoom = defaultZoom;
          tag21AppliedStep = 0;
        } else {
          var dx21 = curTag21RawX - tag21BaselineRawX;
          var desiredStep = 0;
          if (dx21 > TAG21_ZOOM_DX_PX) desiredStep = 1;
          else if (dx21 < -TAG21_ZOOM_DX_PX) desiredStep = -1;
          if (desiredStep !== tag21AppliedStep) {
            var newZoom = Math.min(20, Math.max(1, tag21BaselineZoom + desiredStep * TAG21_ZOOM_STEP_DELTA));
            try { map.setZoom(newZoom); } catch (_err) {}
            defaultZoom = newZoom;
            tag21AppliedStep = desiredStep;
          }
        }
      } else if (tag21BaselineRawX !== null) {
        if (!tag21MissingSinceMs) tag21MissingSinceMs = nowMs;
        if ((nowMs - tag21MissingSinceMs) > TAG21_MISSING_RESET_MS) {
          tag21BaselineRawX = null;
          tag21BaselineZoom = null;
          tag21AppliedStep = 0;
          tag21MissingSinceMs = 0;
        }
      }
    }

    if (canDrawNow) {
      if (panPoint && Number.isFinite(panPoint.x) && Number.isFinite(panPoint.y)) {
        panTagRuntime.missingSinceMs = 0;
        panTagRuntime.active = true;

        // --- Pan from tag 22 position ---
        var cell = panGridCell(panPoint.x, panPoint.y);

        if ((nowMs - panTagRuntime.lastApplyMs) >= PAN_TAG_MIN_UPDATE_MS) {
          var vel = panGridVelocity(cell);
          if (vel) {
            try {
              map.panBy([vel.x, vel.y], { animate: false });
            } catch (_err) {}
          }
          panTagRuntime.lastApplyMs = nowMs;
        }
      } else if (panTagRuntime.active) {
        if (!panTagRuntime.missingSinceMs) {
          panTagRuntime.missingSinceMs = nowMs;
        }
        if ((nowMs - panTagRuntime.missingSinceMs) > PAN_TAG_MISSING_HOLD_MS) {
          resetPanTagRuntime();
        }
      }
    } else {
      resetPanTagRuntime();
      resetMoveTagTarget();
      updatePanArrows({ dx: 0, dy: 0 });
    }

    overlays.updateTagMasks(lastTags, uvToLngLat);

    for (const entry of visibleTagEntries) {
      const tag = entry.tag;
      const id = entry.id;
      const fixed = entry.fixed;
      const raw = entry.raw;
      const assignment = entry.assignment;
      const lngLat = pxToLngLat(fixed.x, fixed.y);
      const currentTagSizePx = tagSizePx(tag);
      tagPointsById[id] = {
        x: fixed.x,
        y: fixed.y,
        lng: lngLat[0],
        lat: lngLat[1],
        angleDeg: tagAngleDeg(tag),
        tagSizePx: currentTagSizePx,
        tagSizeCm: FOLD_TAG_SIZE_CM
      };
      markers.get(id).setLngLat(lngLat);

      if (canDrawNow && assignment) {
        // Drawing is fold-pair only: a single 'draw' tag no longer draws on its own.
        // applyFoldPairs() (below, before drawing.update) handles each configured pair.
        if (assignment.tool === 'sticker') {
          if (pointInPolygon(fixed, currentMapPolygon)) {
            stickerPointsByTagId[id] = {
              lng: lngLat[0],
              lat: lngLat[1],
              color: assignment.color || '#ff5b5b',
              tagSizePx: currentTagSizePx
            };
          }
        }
        if (assignment.tool === 'annotation') {
          annotationPointsByTagId[id] = {
            lng: lngLat[0],
            lat: lngLat[1],
            angleDeg: tagAngleDeg(tag),
            tagSizePx: currentTagSizePx
          };
        }
        if (assignment.tool === 'annotation-general') {
          generalAnnotationPointsByTagId[id] = {
            viewportX: raw.x,
            viewportY: raw.y
          };
        }
        if (assignment.tool === 'eraser') {
          // The physical eraser is now a fold PAIR (driven by applyFoldPairs).
          // The only single-tag eraser left is the on-screen cursor mode, where a
          // DRAW-tool tag is temporarily switched to 'erase' (effectiveAssignmentForTag).
          // Collect that point here; real eraser-pair tags (not draw tags) are skipped.
          if (isDrawToolTagId(tag.id) && pointInPolygon(fixed, currentMapPolygon)) {
            eraserPoints.push({ lng: lngLat[0], lat: lngLat[1] });
          }
        }
        if (assignment.tool === 'isochrone') {
          if (pointInPolygon(fixed, currentMapPolygon)) {
            isochroneTagPoint = { x: fixed.x, y: fixed.y };
            isochroneMinutes = Number(assignment.minutes) || 15;
          } else {
            isochroneTagOutsideMap = true;
          }
        }
        if (assignment.tool === 'isovist') {
          if (pointInPolygon(fixed, currentMapPolygon)) {
            isovistTagPoint = { x: fixed.x, y: fixed.y };
          } else {
            isovistTagOutsideMap = true;
          }
        }
        if (assignment.tool === 'route-origin') {
          if (pointInPolygon(fixed, currentMapPolygon)) {
            routeOriginTagPoint = { x: fixed.x, y: fixed.y };
          } else {
            routeTagOutsideMap = true;
          }
        }
        if (assignment.tool === 'route-dest') {
          if (pointInPolygon(fixed, currentMapPolygon)) {
            routeDestTagPoint = { x: fixed.x, y: fixed.y };
          } else {
            routeTagOutsideMap = true;
          }
        }
      }
      if (assignment && assignment.tool === 'theme' && Object.prototype.hasOwnProperty.call(THEME_TAG_MAP, Number(tag.id))) {
        visibleThemeTagSet.add(Number(tag.id));
      }
    }

    const keyboardAnnotationItems = [];
    // The annotation tag's effective point is the midpoint of its FAR edge (the side
    // opposite the printed top), not its centre — the callout card then hangs off the
    // correct side of the physical card. Rotation-aware: follows the tag's angle.
    function annotationEdgePoint(p) {
      var rad = (Number(p.angleDeg) || 0) * Math.PI / 180;
      var half = (Number(p.tagSizePx) || 0) / 2;
      var x = Number(p.x) - (Math.sin(rad) * half);
      var y = Number(p.y) + (Math.cos(rad) * half);
      var ll = pxToLngLat(x, y);
      return Object.assign({}, p, { x: x, y: y, lng: ll[0], lat: ll[1] });
    }
    if (canDrawNow && KEYBOARD_ANNOTATION_SLOTS.length) {
      for (var _kai = 0; _kai < KEYBOARD_ANNOTATION_SLOTS.length; _kai++) {
        var _kas = KEYBOARD_ANNOTATION_SLOTS[_kai];
        var _annPoint = tagPointsById[String(_kas.annotationTagId)];
        var _keyPoint = tagPointsById[String(_kas.keyboardTagId)];
        if (!_annPoint || !_keyPoint) continue;
        keyboardAnnotationItems.push({
          key: _kas.key,
          label: _kas.label,
          color: _kas.color || '#082f49',
          annotation: annotationEdgePoint(_annPoint),
          keyboard: _keyPoint
        });
      }
    }

    // Fold-pair drawing: each configured draw pair, when opened, feeds the real
    // drawing module (same interpolation / speed / distance tolerances as a stroke).
    const _tFold = perfNow();
    applyFoldPairs(lastTags, drawPointsByTagId, eraserPoints, nowMs);
    perfMark('applyFoldPairs', _tFold);
    var toolPairMoveCandidate = applyToolPairFrame(
      eraserPoints, drawPointsByTagId, annotationPointsByTagId, canDrawNow);
    if (toolPairMoveCandidate && (!moveSelectorPoint || toolPairMoveCandidate.tagId < moveSelectorPoint.tagId)) {
      moveSelectorPoint = toolPairMoveCandidate;
    }
    drawing.update(drawPointsByTagId, nowMs);
    if (canDrawNow && eraserPoints.length) {
      for (var _epi = 0; _epi < eraserPoints.length; _epi++) {
        drawing.eraseAtPoint(eraserPoints[_epi].lng, eraserPoints[_epi].lat, ERASER_RADIUS_PX);
        stickerPlacement.eraseAtPoint(eraserPoints[_epi].lng, eraserPoints[_epi].lat, ERASER_RADIUS_PX);
      }
    }
    stickerPlacement.update(stickerPointsByTagId, nowMs, pageFlow.isMapPage());
    applyCommentControllerState(stickerPointsByTagId);
    annotationPlacement.update(annotationPointsByTagId, nowMs, pageFlow.isMapPage());
    keyboardAnnotationPlacement.update(keyboardAnnotationItems, nowMs, pageFlow.isMapPage());
    if (canDrawNow && moveSelectorPoint) {
      moveTagTargetTo(moveSelectorPoint, moveSelectorPoint.selectorKey);
    } else {
      resetMoveTagTarget();
    }
    applyPhoneControllerAnnotationState(nowMs);
    {
      // Activate a theme by *covering* its tag while the other three remain
      // visible. Any other count (0, 2, 3, or 4 hidden) is a no-op.
      var themeTagIds = [31, 32, 33, 34];
      var hiddenThemeIds = themeTagIds.filter(function (id) {
        return !visibleThemeTagSet.has(id);
      });
      if (hiddenThemeIds.length === 1) {
        var requestedTheme = THEME_TAG_MAP[hiddenThemeIds[0]];
        if (requestedTheme && requestedTheme !== activeMapTheme) {
          setMapTheme(requestedTheme);
          refreshHud();
        }
      }
    }
    if (isFloorplanMode) {
      isochrone.clear();
      if (isovistTagPoint) {
        if (floorplanIsovist) {
          var isovistTagLngLat = pxToLngLat(isovistTagPoint.x, isovistTagPoint.y);
          var isovistAnalysisPoint = lngLatToFloorplanAnalysis(isovistTagLngLat[0], isovistTagLngLat[1]);
          if (isovistAnalysisPoint) floorplanIsovist.update(isovistAnalysisPoint);
          else floorplanIsovist.clear();
        }
      } else if (floorplanIsovistKeyboardMode) {
        updateFloorplanKeyboardIsovist();
      } else if (floorplanIsovist) {
        floorplanIsovist.clear();
      }
    } else if (isochroneTagOutsideMap && !isochroneTagPoint) {
      isochrone.clear();
    } else {
      isochrone.update(isochroneTagPoint, nowMs, isochroneMinutes);
    }
    if (routeTagOutsideMap && !routeOriginTagPoint && !routeDestTagPoint) {
      routing.clear();
    } else {
      routing.update(routeOriginTagPoint, routeDestTagPoint, nowMs);
    }
    customMapObjects.updateInteractionTags(customObjectInteractionTagPoints);
    generalAnnotationPlacement.update(generalAnnotationPointsByTagId, nowMs, pageFlow.isMapPage());

    for (const [id, marker] of markers) {
      if (!seen.has(id)) {
        marker.remove();
        markers.delete(id);
      }
    }
  } catch (_err) {
    hud.textContent = 'Backend not reachable';
    lastPhoneControllers = {};
    lastCommentControllers = {};
    overlays.updateTagMasks([], uvToLngLat);
    if (floorplanIsovist) floorplanIsovist.clear();
    stickerPlacement.update({}, Date.now(), false);
    annotationPlacement.update({}, Date.now(), false);
    keyboardAnnotationPlacement.update([], Date.now(), false);
    customMapObjects.updateInteractionTags([]);
    customMapObjects.setForcedActiveIds([]);
    generalAnnotationPlacement.update({}, Date.now(), false);
  } finally {
    pollInFlight = false;
    perfMark('poll-total', _tPoll);
    perfReport();
  }
}

let lastSurfaceLngLatPostMs = 0;
let surfaceLngLatPostTimer = 0;
function publishSurfaceLngLat() {
  if (!map || typeof map.unproject !== 'function') return;
  const size = mapWarpController.getViewportSize();
  const w = Number(size.width) || 0;
  const h = Number(size.height) || 0;
  if (!w || !h) return;
  const corners = [
    map.unproject([0, 0]),
    map.unproject([w, 0]),
    map.unproject([w, h]),
    map.unproject([0, h])
  ].map(function (ll) { return { lng: ll.lng, lat: ll.lat }; });
  fetch('/api/surface-lnglat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ corners: corners })
  }).catch(function () {});
  lastSurfaceLngLatPostMs = Date.now();
}
function scheduleSurfaceLngLatPublish() {
  if (surfaceLngLatPostTimer) return;
  const sinceLast = Date.now() - lastSurfaceLngLatPostMs;
  const delay = sinceLast >= 200 ? 0 : (200 - sinceLast);
  surfaceLngLatPostTimer = window.setTimeout(function () {
    surfaceLngLatPostTimer = 0;
    publishSurfaceLngLat();
  }, delay);
}

map.on('load', function () {
  defaultZoom = map.getZoom();
  activeMapTheme = mapRuntime.getCurrentTheme();
  resetViewFilters();
  setViewFilterPanelVisible(false);
  overlays.ensureTagMaskLayer();
  drawing.ensureLayer();
  roadSnapping.ensureRoadsLayer();
  roadSnapping.ensureSnappedLayer();
  stickerPlacement.setEnabled(false);
  annotationPlacement.setEnabled(false);
  keyboardAnnotationPlacement.setEnabled(false);
  generalAnnotationPlacement.setEnabled(false);
  customMapObjects.loadFromBackend().catch(function () {});
  calibration.renderOverlay();
  refreshHud();
  poll();
  setInterval(poll, 35);
  publishSurfaceLngLat();
  map.on('moveend', scheduleSurfaceLngLatPublish);
  map.on('zoomend', scheduleSurfaceLngLatPublish);
  map.on('rotateend', scheduleSurfaceLngLatPublish);
  map.on('pitchend', scheduleSurfaceLngLatPublish);
  map.on('styledata', scheduleSurfaceLngLatPublish);
  window.addEventListener('resize', scheduleSurfaceLngLatPublish);
  setInterval(publishSurfaceLngLat, 2500);

  // Optional camera/table drift check. Disabled by default because it briefly
  // projects corner tags over the map.
  if (DRIFT_MONITOR_ENABLED && window.CompactDriftMonitor && typeof window.CompactDriftMonitor.createDriftMonitor === 'function') {
    driftMonitor = window.CompactDriftMonitor.createDriftMonitor({
      checkIntervalMs: 20000,
      maxDetectMs: 2500,
      driftThresholdPx: 40
    });
    driftMonitor.start();
    window.CompactDrift = driftMonitor; // expose for manual testing
  }
});
