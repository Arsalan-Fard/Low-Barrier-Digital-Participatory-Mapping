// Map page startup, loaded last: creates the map and the modules drawn on it,
// publishes window.CompactMapApp, wires the page flow, mouse and keyboard, and
// starts polling /api/tags once the map has loaded. Creating the map here, in one
// run with its 'load' handler, means no map event can fire before a handler exists.
const mapRuntime = window.CompactMapSetup.initMap({
  config: mapConfig,
  themeStyles: mapThemeStyles,
  initialTheme: INITIAL_MAP_THEME,
  onStyleLoad: handleMapStyleLoad
});
const map = mapRuntime.map;
const floorplanIsovist = window.CompactFloorplanIsovist.createFloorplanIsovist({
  containerEl: mapView,
  maxRadiusPx: 2880,
  toViewportPoint: floorplanAnalysisToViewport,
  cellSize: 140
});
const mapWarpController = window.CompactMapWarp.createMapWarp({ mapViewEl: mapView });
map.on('moveend', rebuildFloorplanWallSegments);
map.on('zoomend', rebuildFloorplanWallSegments);
map.on('resize', rebuildFloorplanWallSegments);
const calibration = window.CompactCalibration.createCalibration({
  overlayEl: document.getElementById('calibOverlay')
});
const overlays = window.CompactOverlays.createOverlays({
  map,
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
  projectLngLatToPx: lngLatToPx
});
const customMapObjects = window.CompactCustomMapObjects.createCustomMapObjects({
  map,
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
  projectLngLatToPx: lngLatToPx
});
const roadSnapping = window.CompactRoadSnapping.createRoadSnapping({ map });
const dataExport = window.CompactDataExport.createDataExport({
  drawing,
  stickerPlacement,
  annotationPlacement,
  getBasemap: function () { return isFloorplanMode ? 'floorplan' : 'mapbox'; },
  getWorkshopMeta: function () { return activeWorkshopMeta; }
});
const isochrone = window.CompactIsochrone.createIsochrone({ map, getAccessToken: mapboxAccessToken });
const routing = window.CompactRouting.createRouting({ map, getAccessToken: mapboxAccessToken });
const osmnxNetwork = window.CompactOsmnxModule.createOsmnxNetwork({ map });
window.CompactOsmnx = osmnxNetwork;
const customGeoLayers = window.CompactCustomGeojsonLayers.createCustomGeojsonLayers({ map });
// The workshop editor's upload/delete UI shares this registry.
window.CompactCustomGeoLayers = customGeoLayers;
window.CompactMapApp = mapAppApi;

setHudVisible(false);
window.addEventListener('pageshow', function () {
  setHudVisible(false);
});
const streetViewScreen = window.CompactStreetViewScreen.createStreetViewScreen({
  insetEl: streetViewInset,
  containerEl: mapView,
  onModeChange: handleStreetScreenModeChange
});

stickerPlacement.setEnabled(true);
annotationPlacement.setEnabled(true);
mapWarpController.initIfNeeded();
refreshHud();
window.CompactPageFlow.createPageFlow({
  onBackToCamera: function () {
    setUiNote('');
    refreshHud();
  }
});

mapView.addEventListener('mousedown', beginCursorTagGesture, true);
mapView.addEventListener('mousemove', function (e) {
  updateCursorTagFromEvent(e);
  if (floorplanIsovistKeyboardMode) {
    setFloorplanIsovistPointerFromClient(e.clientX, e.clientY);
    updateFloorplanKeyboardIsovist();
  }
}, true);
// Leaving the map ends a stroke, like a tag leaving the table.
mapView.addEventListener('mouseleave', endCursorTagGesture);
window.addEventListener('mouseup', endCursorTagGesture, true);
window.addEventListener('resize', updateFloorplanKeyboardIsovist);

watchViewFilterSlider(viewBrightness, 'View brightness', formatFilterValue);
watchViewFilterSlider(viewSaturation, 'View saturation', formatFilterValue);
watchViewFilterSlider(viewContrast, 'View contrast', formatFilterValue);
watchViewFilterSlider(viewInvert, 'View invert', formatPercentValue);
watchViewFilterSlider(viewSepia, 'View sepia', formatPercentValue);
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

function shortcutInputBlocked(target) {
  if (!target) return false;
  const name = String(target.tagName || '').toUpperCase();
  if (name === 'TEXTAREA' || name === 'SELECT' || !!target.isContentEditable) return true;
  if (name !== 'INPUT') return false;
  const type = String(target.type || '').toLowerCase();
  return type !== 'range' && type !== 'button' && type !== 'checkbox' && type !== 'radio';
}

function clearAllInputs() {
  drawing.clearAll();
  stickerPlacement.clearAll();
  annotationPlacement.clearAll();
  floorplanIsovistKeyboardMode = false;
  floorplanIsovist.clear();
}

function fetchOsmnxForView() {
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
}

function saveSessionFromKey() {
  dataExport.saveToBackend(function (err, result) {
    setUiNote(err ? 'Failed to save session' : 'Session saved: ' + (result && result.filename));
    refreshHud();
  });
  setUiNote('Saving session...');
  refreshHud();
}

// Keys whose only work is a toggle and a note. B and W live in pageFlow.js.
const SHORTCUT_TOGGLES = {
  v: function () {
    return toggleViewFilterPanelVisible() ? 'Light settings ON' : 'Light settings OFF';
  },
  t: function () {
    return overlays.toggleMaskEnabled() ? 'Tag mask ON' : 'Tag mask OFF';
  },
  q: function () {
    const labels = { draw: 'Draw', comment: 'Comment', erase: 'Erase', select: 'Select' };
    return 'Cursor tool: ' + labels[cycleCursorToolMode()];
  },
  d: function () {
    return toggleDebugMarkersVisible() ? 'Tag debug markers ON' : 'Tag debug markers OFF';
  },
  o: function () {
    roadSnapping.toggleRoads();
    return roadSnapping.isRoadsVisible() ? 'Roads layer ON' : 'Roads layer OFF';
  },
  n: function () {
    const visible = customMapObjects.getPresentationMode() !== 'hidden';
    customMapObjects.setPresentationMode(visible ? 'hidden' : 'expanded');
    isochrone.setVisible(!visible);
    routing.setVisible(!visible);
    return visible ? 'Custom objects hidden' : 'Custom objects visible';
  },
  l: function () {
    if (!mapConfig.useMapboxServices) return 'Mapbox views unavailable: add a token to token.txt';
    const themeLabels = { streets: 'Streets view', satellite: 'Satellite view', topo: 'Topographic view' };
    const nextTheme = toggleMapTheme();
    return (themeLabels[nextTheme] || nextTheme) + ' ON';
  },
  x: function () {
    clearAllInputs();
    return 'All inputs cleared';
  }
};
const CUSTOM_OBJECT_MODES = ['transportation', 'landmark', 'amenities'];
const CUSTOM_OBJECT_MODE_LABELS = ['Transportation', 'Landmark', 'Amenities'];

async function handleMapShortcut(e) {
  if (e.repeat) return;
  if (shortcutInputBlocked(e.target)) return;
  if (await calibration.handleKeyDown(e)) {
    refreshHud();
    return;
  }
  const key = String(e.key || '').toLowerCase();
  if (SHORTCUT_TOGGLES[key]) {
    e.preventDefault();
    setUiNote(SHORTCUT_TOGGLES[key]());
    refreshHud();
    return;
  }
  if (key === 'h') {
    e.preventDefault();
    if (toggleHudVisible()) {
      setUiNote('HUD ON');
      refreshHud();
    }
    return;
  }
  if (key === 'g') {
    e.preventDefault();
    fetchOsmnxForView();
    return;
  }
  if (key === 'i' && isFloorplanMode) {
    e.preventDefault();
    setUiNote(toggleFloorplanKeyboardIsovistMode() ? 'Isovist ON' : 'Isovist OFF');
    refreshHud();
    return;
  }
  if (key === 'y') {
    e.preventDefault();
    toggleTimelineRecording();
    return;
  }
  if (key === 's') {
    e.preventDefault();
    saveSessionFromKey();
    return;
  }
  if (key >= '1' && key <= '3') {
    e.preventDefault();
    const idx = parseInt(key, 10) - 1;
    const visible = customMapObjects.toggleMode(CUSTOM_OBJECT_MODES[idx]);
    setUiNote(CUSTOM_OBJECT_MODE_LABELS[idx] + ' ' + (visible ? 'ON' : 'OFF'));
    refreshHud();
  }
}
window.addEventListener('keydown', handleMapShortcut);

map.on('load', function () {
  defaultZoom = map.getZoom();
  activeMapTheme = mapRuntime.getCurrentTheme();
  resetViewFilters();
  setViewFilterPanelVisible(false);
  overlays.ensureTagMaskLayer();
  drawing.ensureLayer();
  roadSnapping.ensureRoadsLayer();
  stickerPlacement.setEnabled(false);
  annotationPlacement.setEnabled(false);
  customMapObjects.loadFromBackend().catch(function () {});
  customGeoLayers.refresh();
  calibration.renderOverlay();
  refreshHud();
  poll();
  setInterval(poll, 35);
});
