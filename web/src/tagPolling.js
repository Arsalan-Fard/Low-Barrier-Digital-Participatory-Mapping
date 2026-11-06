// Map page: the /api/tags poll (every 35 ms once the map has loaded) and the
// dispatch of every tag it reports to the module its assignment names, plus the
// markers, pan/zoom tags and the select tool's grab-and-move.
const ERASER_RADIUS_PX = 32;
const MOVE_TAG_SNAP_PX = 48;
// Tag 22 pans toward the edge it sits near: the screen is a 5x5 grid, the outer ring pans faster.
const PAN_TAG_MIN_UPDATE_MS = 45;
const PAN_TAG_MISSING_HOLD_MS = 850;
const PAN_TAG_SLOW_PX = 2;
const PAN_TAG_FAST_PX = 6;
// Tag 21 zooms one step in or out as it moves right or left of where it appeared.
const TAG21_ZOOM_DX_PX = 60;
const TAG21_ZOOM_STEP_DELTA = 1.0;
const TAG21_MISSING_RESET_MS = 1500;
// A dot on the map for every tag the camera sees, in its assignment's colour.
const markers = new Map();
let lastTags = [];
let pollInFlight = false;
let defaultZoom = 16;
const panTagRuntime = {
  lastApplyMs: 0,
  missingSinceMs: 0,
  active: false
};
let tag21BaselineRawX = null;
let tag21BaselineZoom = null;
let tag21AppliedStep = 0;
let tag21MissingSinceMs = 0;
let moveTagTarget = null;
let moveTagSelectorKey = '';
// Per-frame timings, logged every ~2 s while window.PERF is set in the console.
const _perfAcc = {};
let _perfFrames = 0;
let _perfLastReport = 0;

function perfNow() {
  return window.PERF ? performance.now() : 0;
}

function perfMark(label, startedAt) {
  if (!window.PERF) return;
  _perfAcc[label] = (_perfAcc[label] || 0) + (performance.now() - startedAt);
}

function perfReport() {
  if (!window.PERF) return;
  _perfFrames++;
  const now = performance.now();
  if (now - _perfLastReport < 2000) return;
  const out = {};
  for (const k of Object.keys(_perfAcc)) out[k] = +(_perfAcc[k] / _perfFrames).toFixed(2);
  out.frames = _perfFrames;
  console.log('[PERF avg ms/frame]', out);
  for (const k of Object.keys(_perfAcc)) _perfAcc[k] = 0;
  _perfFrames = 0;
  _perfLastReport = now;
}

function makeMarker(id) {
  const el = document.createElement('div');
  el.className = 'dot';
  const assignment = tagAssignments.getAssignment(id);
  if (assignment && assignment.color) el.style.background = assignment.color;
  el.title = assignment
    ? `Tag ${id} (${assignment.tool} ${assignment.colorName})`
    : `Tag ${id}`;
  return new mapboxgl.Marker({ element: el }).setLngLat([0, 0]).addTo(map);
}

function applyZoomTag(entries, nowMs) {
  let rawX = null;
  for (const entry of entries) {
    if (Number(entry.tag.id) === 21 && Number.isFinite(entry.point.x)) {
      rawX = entry.point.x;
      break;
    }
  }
  if (rawX === null) {
    if (tag21BaselineRawX === null) return;
    if (!tag21MissingSinceMs) tag21MissingSinceMs = nowMs;
    if ((nowMs - tag21MissingSinceMs) > TAG21_MISSING_RESET_MS) {
      tag21BaselineRawX = null;
      tag21BaselineZoom = null;
      tag21AppliedStep = 0;
      tag21MissingSinceMs = 0;
    }
    return;
  }
  tag21MissingSinceMs = 0;
  if (tag21BaselineRawX === null) {
    tag21BaselineRawX = rawX;
    tag21BaselineZoom = defaultZoom;
    tag21AppliedStep = 0;
    return;
  }
  const dx = rawX - tag21BaselineRawX;
  let desiredStep = 0;
  if (dx > TAG21_ZOOM_DX_PX) desiredStep = 1;
  else if (dx < -TAG21_ZOOM_DX_PX) desiredStep = -1;
  if (desiredStep === tag21AppliedStep) return;
  const newZoom = Math.min(20, Math.max(1, tag21BaselineZoom + desiredStep * TAG21_ZOOM_STEP_DELTA));
  try {
    map.setZoom(newZoom);
  } catch (_err) {}
  defaultZoom = newZoom;
  tag21AppliedStep = desiredStep;
}

function panGridCell(viewportX, viewportY) {
  const viewport = mapWarpController.getViewportSize();
  const w = viewport.width;
  const h = viewport.height;
  if (!w || !h) return null;
  const col = Math.max(0, Math.min(4, Math.floor((viewportX / w) * 5)));
  const row = Math.max(0, Math.min(4, Math.floor((viewportY / h) * 5)));
  return { dx: col - 2, dy: row - 2 };
}

function panGridSpeed(step) {
  if (step === 0) return 0;
  const speed = Math.abs(step) === 1 ? PAN_TAG_SLOW_PX : PAN_TAG_FAST_PX;
  return Math.sign(step) * speed;
}

function applyPanTag(panPoint, nowMs) {
  if (panPoint && Number.isFinite(panPoint.x) && Number.isFinite(panPoint.y)) {
    panTagRuntime.missingSinceMs = 0;
    panTagRuntime.active = true;
    if ((nowMs - panTagRuntime.lastApplyMs) < PAN_TAG_MIN_UPDATE_MS) return;
    const cell = panGridCell(panPoint.x, panPoint.y);
    if (cell && (cell.dx !== 0 || cell.dy !== 0)) {
      try {
        map.panBy([panGridSpeed(cell.dx), panGridSpeed(cell.dy)], { animate: false });
      } catch (_err) {}
    }
    panTagRuntime.lastApplyMs = nowMs;
    return;
  }
  if (!panTagRuntime.active) return;
  if (!panTagRuntime.missingSinceMs) panTagRuntime.missingSinceMs = nowMs;
  if ((nowMs - panTagRuntime.missingSinceMs) > PAN_TAG_MISSING_HOLD_MS) {
    panTagRuntime.lastApplyMs = 0;
    panTagRuntime.missingSinceMs = 0;
    panTagRuntime.active = false;
  }
}

function resetMoveTagTarget() {
  moveTagTarget = null;
  moveTagSelectorKey = '';
}

function findMoveTagTarget(selectorPoint) {
  var candidates = [];
  var sticker = stickerPlacement.findNearestPlaced(selectorPoint.lng, selectorPoint.lat, MOVE_TAG_SNAP_PX);
  if (sticker) candidates.push({ type: 'sticker', index: sticker.index, distanceSq: sticker.distanceSq });
  var annotation = annotationPlacement.findNearestPlaced(selectorPoint.lng, selectorPoint.lat, MOVE_TAG_SNAP_PX);
  if (annotation) candidates.push({ type: 'annotation', index: annotation.index, distanceSq: annotation.distanceSq });
  if (!candidates.length) return null;
  candidates.sort(function (a, b) { return a.distanceSq - b.distanceSq; });
  return candidates[0];
}

// The select tool grabs the nearest placed sticker or annotation and keeps it
// until the selector (a tag or a fold pair) changes or lets go.
function moveTagTargetTo(selectorPoint) {
  var key = String(selectorPoint.selectorKey || '');
  if (key && moveTagSelectorKey && key !== moveTagSelectorKey) {
    moveTagTarget = null;
  }
  moveTagSelectorKey = key;
  if (!moveTagTarget) moveTagTarget = findMoveTagTarget(selectorPoint);
  if (!moveTagTarget) return;
  var index = moveTagTarget.index;
  if (moveTagTarget.type === 'sticker') {
    if (stickerPlacement.movePlaced(index, selectorPoint.lng, selectorPoint.lat)) return;
  } else if (moveTagTarget.type === 'annotation' && annotationPlacement.isPlacedVisible(index)) {
    annotationPlacement.beginEditPlaced(index, selectorPoint.tagId, Date.now());
    if (annotationPlacement.movePlaced(index, selectorPoint.lng, selectorPoint.lat)) return;
  }
  moveTagTarget = null;
}

async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;
  const pollStartedAt = perfNow();
  try {
    let data = null;
    try {
      const res = await fetch('/api/tags', { cache: 'no-store' });
      if (!res.ok) throw new Error('tags ' + res.status);
      data = await res.json();
    } catch (_fetchErr) {
      data = { tags: [] };
    }

    lastTags = Array.isArray(data.tags) ? data.tags : [];
    // Camera Tuning's jitter threshold for the printed sheets.
    if (data.screenJitterPx != null) window.CompactPrintedScreen.setJitterPx(data.screenJitterPx);

    const seen = new Set();
    const currentMapPolygon = mapViewportPolygon();
    const drawPointsByTagId = {};
    const stickerPointsByTagId = {};
    const annotationPointsByTagId = {};
    const eraserPoints = [];
    const visibleTagEntries = [];
    let panPoint = null;
    let moveSelectorPoint = null;
    let isochroneTagPoint = null;
    let isochroneMinutes = 15;
    let isochroneTagOutsideMap = false;
    let isovistTagPoint = null;
    let routeOriginTagPoint = null;
    let routeDestTagPoint = null;
    let routeTagOutsideMap = false;
    let streetViewStateNow = 'missing';
    let streetViewAnchorPointNow = null;
    let streetViewLngLatNow = null;
    let streetViewHeadingNow = null;
    // Of several selectors the lowest tag id wins.
    const offerMoveSelector = function (candidate) {
      if (!moveSelectorPoint || candidate.tagId < moveSelectorPoint.tagId) moveSelectorPoint = candidate;
    };

    for (const tag of lastTags) {
      if (!tag || !tag.uv) continue;
      const id = String(tag.id);
      if (!markers.has(id)) markers.set(id, makeMarker(id));
      seen.add(id);
      const point = uvToPx(tag.uv.u, tag.uv.v);
      const assignment = effectiveAssignmentForTag(tag.id, tagAssignments.getAssignment(tag.id));
      visibleTagEntries.push({ tag: tag, id: id, point: point, assignment: assignment, marker: markers.get(id) });
      if (!assignment) continue;
      if (assignment.tool === 'street-view') {
        const lngLat = pxToLngLat(point.x, point.y);
        streetViewAnchorPointNow = { x: point.x, y: point.y };
        streetViewLngLatNow = { lng: lngLat[0], lat: lngLat[1] };
        streetViewStateNow = pointInPolygon(point, currentMapPolygon) ? 'inside' : 'outside';
        streetViewHeadingNow = streetViewHeadingForTag(tag);
      }
      if (assignment.tool === 'pan' && Number(tag.id) === 22) {
        panPoint = { x: point.x, y: point.y };
      }
      if (assignment.tool === 'drag') {
        const selectorLngLat = pxToLngLat(point.x, point.y);
        offerMoveSelector({
          lng: selectorLngLat[0],
          lat: selectorLngLat[1],
          tagId: Number(tag.id),
          selectorKey: 'tag:' + id
        });
      }
    }

    const nowMs = Date.now();
    streetViewScreen.update(lastTags, uvToPx, nowMs);
    updateMapViewScreens(lastTags, uvToPx, nowMs);
    refreshStreetViewInset(streetViewStateNow, streetViewAnchorPointNow, streetViewLngLatNow, streetViewHeadingNow);
    refreshMapViewInset(streetViewStateNow, streetViewLngLatNow, streetViewHeadingNow, nowMs);
    applyZoomTag(visibleTagEntries, nowMs);
    applyPanTag(panPoint, nowMs);

    for (const entry of visibleTagEntries) {
      const tag = entry.tag;
      const point = entry.point;
      const assignment = entry.assignment;
      const lngLat = pxToLngLat(point.x, point.y);
      if (entry.marker) entry.marker.setLngLat(lngLat);
      if (!assignment) continue;
      const inMap = pointInPolygon(point, currentMapPolygon);
      if (assignment.tool === 'annotation') {
        annotationPointsByTagId[entry.id] = {
          lng: lngLat[0],
          lat: lngLat[1],
          angleDeg: tagAngleDeg(tag),
          tagSizePx: tagSizePx(tag)
        };
      }
      // A lone eraser is a draw-tool tag in erase mode seen without its pair; eraser pairs go
      // through applyFoldPairs.
      if (assignment.tool === 'eraser' && isDrawToolTagId(tag.id) && inMap) {
        eraserPoints.push({ lng: lngLat[0], lat: lngLat[1] });
      }
      if (assignment.tool === 'isochrone') {
        if (inMap) {
          isochroneTagPoint = { x: point.x, y: point.y };
          isochroneMinutes = Number(assignment.minutes) || 15;
        } else {
          isochroneTagOutsideMap = true;
        }
      }
      if (assignment.tool === 'isovist' && inMap) {
        isovistTagPoint = { x: point.x, y: point.y };
      }
      if (assignment.tool === 'route-origin') {
        if (inMap) routeOriginTagPoint = { x: point.x, y: point.y };
        else routeTagOutsideMap = true;
      }
      if (assignment.tool === 'route-dest') {
        if (inMap) routeDestTagPoint = { x: point.x, y: point.y };
        else routeTagOutsideMap = true;
      }
    }

    const foldStartedAt = perfNow();
    const drawPairMoves = applyFoldPairs(lastTags, drawPointsByTagId, eraserPoints, stickerPointsByTagId, nowMs);
    perfMark('applyFoldPairs', foldStartedAt);
    applyToolPairFrames();
    for (const move of drawPairMoves) offerMoveSelector(move);
    drawing.update(drawPointsByTagId, nowMs);
    for (const point of eraserPoints) {
      drawing.eraseAtPoint(point.lng, point.lat, ERASER_RADIUS_PX);
      stickerPlacement.eraseAtPoint(point.lng, point.lat, ERASER_RADIUS_PX);
    }
    stickerPlacement.update(stickerPointsByTagId, nowMs, true);
    annotationPlacement.update(annotationPointsByTagId, nowMs, true);
    if (moveSelectorPoint) moveTagTargetTo(moveSelectorPoint);
    else resetMoveTagTarget();
    if (isFloorplanMode) {
      isochrone.clear();
      updateFloorplanIsovist(isovistTagPoint);
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

    for (const [id, marker] of markers) {
      if (!seen.has(id)) {
        marker.remove();
        markers.delete(id);
      }
    }
  } catch (_err) {
    floorplanIsovist.clear();
    stickerPlacement.update({}, Date.now(), false);
    annotationPlacement.update({}, Date.now(), false);
  } finally {
    pollInFlight = false;
    perfMark('poll-total', pollStartedAt);
    perfReport();
  }
}
