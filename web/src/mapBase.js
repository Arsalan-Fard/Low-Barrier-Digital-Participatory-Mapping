// Map page (index.html): config, basemap styles, and the conversions from camera
// surface uv to map pixels and lng/lat. The map and the modules drawn on it are
// created in mapStartup.js, which loads last.
const mapView = document.getElementById('main_container');
const tagAssignments = window.CompactTagAssignments;
const mapConfig = window.CompactMapConfig.CONFIG;
const isFloorplanMode = window.location.pathname === '/floorplan'
  || new URLSearchParams(window.location.search).get('view') === 'floorplan';

const MAP_THEME_STREETS = 'streets';
// The map generator's own style, the one the paper sheets are printed from; paperMap.js restyles it.
const MAP_THEME_PAPER = 'paper';
const MAP_THEME_FLOORPLAN = 'floorplan';
const INITIAL_MAP_THEME = isFloorplanMode ? MAP_THEME_FLOORPLAN : MAP_THEME_STREETS;
const MAP_THEMES_CYCLE = isFloorplanMode ? [MAP_THEME_FLOORPLAN] : mapConfig.themeCycle;
const mapThemeStyles = isFloorplanMode ? {
  floorplan: mapConfig.styles.floorplan
} : {
  streets: mapConfig.styles.streets,
  satellite: mapConfig.styles.satellite,
  topo: mapConfig.styles.topo,
  [MAP_THEME_PAPER]: window.CompactMapSetup.generatorStyle(),
  floorplan: mapConfig.styles.floorplan
};

function mapboxAccessToken() {
  return mapConfig.useMapboxServices ? (mapConfig.accessToken || '') : '';
}

// uv spans the whole calibrated screen; screenToMap undoes the page warp to reach
// the map-canvas pixel MapLibre projects in.
function uvToPx(u, v) {
  const viewport = mapWarpController.getViewportSize();
  const local = mapWarpController.screenToMap(u * viewport.width, v * viewport.height);
  return { x: Number(local.x), y: Number(local.y) };
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

function isFiniteUv(c) {
  return !!c && Number.isFinite(c.u) && Number.isFinite(c.v);
}

function tagAngleDeg(tag) {
  if (!tag || !Array.isArray(tag.uvCorners) || tag.uvCorners.length < 2) return 0;
  const c0 = tag.uvCorners[0];
  const c1 = tag.uvCorners[1];
  if (!isFiniteUv(c0) || !isFiniteUv(c1)) return 0;
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
    if (!isFiniteUv(a) || !isFiniteUv(b)) continue;
    const pa = uvToPx(a.u, a.v);
    const pb = uvToPx(b.u, b.v);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    totalLen += Math.sqrt(dx * dx + dy * dy);
    count++;
  }
  return count > 0 ? totalLen / count : 28;
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
