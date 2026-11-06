// Map page startup, loaded last: creates the map and the modules drawn on it,
// publishes window.CompactMapApp, wires the page flow, and
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
const customMapObjects = window.CompactCustomMapObjects.createCustomMapObjects({ map });
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

// The tag tools for the mouse; the Project panel and the running workshop's bar show their buttons,
// so they must exist before createPageFlow mounts the panel.
window.CompactMouseTools = window.CompactMouseToolsModule.createMouseTools({
  map,
  mapView,
  drawing,
  stickerPlacement,
  annotationPlacement,
  isochrone,
  routing,
  eraserRadiusPx: ERASER_RADIUS_PX,
  clientToMapPx: function (x, y) { return mapWarpController.screenToMap(x, y); },
  mapPxToLngLat: pxToLngLat,
  colors: tagAssignments.getMarkerSettings().slots
    .filter(function (slot) { return slot.tool === 'draw'; })
    .map(function (slot) { return { key: slot.key, label: slot.label, color: slot.color }; })
});

const streetViewScreen = window.CompactPrintedScreen.createPrintedScreen({
  frameUrl: '/api/street-screen/frame',
  noteText: 'Place the street view pointer on the map',
  insetEl: streetViewInset,
  containerEl: mapView,
  onModeChange: handleStreetScreenModeChange
});
// One printed screen and inset per map view sheet (mapViewInset.js).
createMapViewSheets();

stickerPlacement.setEnabled(true);
annotationPlacement.setEnabled(true);
mapWarpController.initIfNeeded();
window.CompactPageFlow.createPageFlow();

map.on('load', function () {
  defaultZoom = map.getZoom();
  activeMapTheme = mapRuntime.getCurrentTheme();
  drawing.ensureLayer();
  roadSnapping.ensureRoadsLayer();
  stickerPlacement.setEnabled(false);
  annotationPlacement.setEnabled(false);
  customMapObjects.loadFromBackend();
  customGeoLayers.refresh();
  poll();
  setInterval(poll, 35);
});
