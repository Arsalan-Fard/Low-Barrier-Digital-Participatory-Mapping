// Map page: the multi-state pointer's fold pairs. Two tags on a hinge; opening the
// pair past a threshold makes the point just beyond them act in the pointer's
// tool mode (see toolModes.js), and a laser dot with a fading trail follows it.
// Tool-selector pairs work the same way but drive their pointer's tool menu.
const FOLD_TAG_SIZE_CM = tagAssignments.getMarkerSettings().tagSizeCm;
// The pen point is offset from tag-local edge 2->3 (the decoded bottom edge), where the backend
// anchors tags too; the hinge edge only gives the fold angle.
const FOLD_EDGE_INDEX = 2;
// Open at 10 degrees, close below 8, so the pen does not flicker at the threshold.
const FOLD_PEN_OPEN_ANGLE_DEG = 10;
const FOLD_PEN_CLOSE_ANGLE_DEG = 8;
const FOLD_PEN_COLOR = '#ff3b3b';
const FOLD_ERASER_COLOR = '#e5e7eb';
const FOLD_PEN_SOURCE_ID = 'foldpen-debug-source';
const FOLD_PEN_POINT_LAYER_ID = 'foldpen-laser-core';
const FOLD_PEN_GLOW_LAYER_ID = 'foldpen-laser-glow';
const FOLD_LASER_TRAIL_MS = 380;
const FOLD_LASER_MAX_POINTS = 14;
// Low-pass on each tag's corners before any edge or angle math: a still tag shimmers a few px
// per frame. 1 = no smoothing.
const FOLD_CORNER_SMOOTH_ALPHA = 0.35;
const FOLD_PAIRS = tagAssignments.getDrawPairs().concat(tagAssignments.getToolSelectorPairs());
const foldGeometry = window.CompactFoldGeometry;
const foldLaserTrails = {};
const foldPairLatch = {};
const foldPairVisual = {};
const foldCornerEma = {};
let foldOverlaySig = null;
// The selector pairs seen this frame, for applyToolPairFrames: pair key -> frame.
let toolPairFramesByKey = {};

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

function ensureFoldPenLayer() {
  if (!map.getSource(FOLD_PEN_SOURCE_ID)) {
    map.addSource(FOLD_PEN_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }
  if (!map.getLayer(FOLD_PEN_GLOW_LAYER_ID)) {
    map.addLayer({
      id: FOLD_PEN_GLOW_LAYER_ID,
      type: 'circle',
      source: FOLD_PEN_SOURCE_ID,
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
      id: FOLD_PEN_POINT_LAYER_ID,
      type: 'circle',
      source: FOLD_PEN_SOURCE_ID,
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

function foldTagCenterPx(corners) {
  let x = 0;
  let y = 0;
  for (const p of corners) {
    x += p.x;
    y += p.y;
  }
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

// One point per trail entry, fading with age; the newest is the bright laser dot.
// visualOpen (0..1) scales the brightness as the pair opens.
function foldLaserFeatures(penLL, color, visualOpen, key, now) {
  const features = [];
  let trail = foldLaserTrails[key];
  if (!trail) {
    trail = [];
    foldLaserTrails[key] = trail;
  }
  if (penLL) {
    trail.push({ lng: penLL[0], lat: penLL[1], at: now });
    if (trail.length > FOLD_LASER_MAX_POINTS) trail.splice(0, trail.length - FOLD_LASER_MAX_POINTS);
  }
  while (trail.length && (now - trail[0].at) > FOLD_LASER_TRAIL_MS) trail.shift();
  if (!trail.length) {
    delete foldLaserTrails[key];
    return features;
  }

  const intensity = 0.35 + 0.65 * foldClamp01(visualOpen);
  for (let i = 0; i < trail.length; i++) {
    const pt = trail[i];
    const life = foldClamp01(1 - (now - pt.at) / FOLD_LASER_TRAIL_MS);
    const isTip = i === trail.length - 1;
    const k = isTip ? 1 : life * life;
    features.push({
      type: 'Feature',
      properties: {
        role: 'fold-laser',
        key: key,
        color: color,
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

// A faint dot where the pen will start, while the pair is seen but still closed.
function foldGhostFeature(penLL, color, visualOpen, key) {
  const t = foldClamp01(visualOpen);
  return {
    type: 'Feature',
    properties: {
      role: 'fold-ghost',
      key: key,
      color: color,
      core: 3 + 1.5 * t,
      coreOpacity: 0.22 + 0.33 * t,
      glow: 12 + 6 * t,
      glowOpacity: 0.10 + 0.12 * t
    },
    geometry: { type: 'Point', coordinates: [penLL[0], penLL[1]] }
  };
}

function releaseFoldPair(key) {
  foldPairLatch[key] = false;
  delete foldPairVisual[key];
}

function foldPairColor(pair, drawMode) {
  if (pair.tool === 'tool-selector') return toolPairLaserColor(pair);
  if (drawMode === 'erase') return FOLD_ERASER_COLOR;
  if (drawMode === 'select') return '#7dd3fc';
  return pair.color;
}

// Runs every configured fold pair for this frame: fills drawPoints, erasePoints and
// stickerPoints, publishes selector frames, redraws the laser overlay, and returns
// the select-mode points that may grab a placed item.
function applyFoldPairs(tags, drawPoints, erasePoints, stickerPoints, nowMs) {
  const byId = {};
  for (const t of (tags || [])) {
    if (t && Number.isFinite(Number(t.id))) byId[Number(t.id)] = t;
  }
  const feats = [];
  const moveCandidates = [];
  const now = Number(nowMs) || Date.now();
  toolPairFramesByKey = {};
  for (const pair of FOLD_PAIRS) {
    const isSelector = pair.tool === 'tool-selector';
    const drawMode = isSelector ? null : currentDrawToolMode(pair.a);
    const pairColor = foldPairColor(pair, drawMode);
    const ta = byId[Number(pair.a)];
    const tb = byId[Number(pair.b)];
    const ready = ta && tb
      && Array.isArray(ta.uvCorners) && ta.uvCorners.length >= 4
      && Array.isArray(tb.uvCorners) && tb.uvCorners.length >= 4;
    if (!ready) {
      releaseFoldPair(pair.key);
      delete foldCornerEma[String(pair.a)];
      delete foldCornerEma[String(pair.b)];
      continue;
    }
    const cornersA = smoothFoldCorners(pair.a, ta.uvCorners.map(function (c) { return uvToPx(c.u, c.v); }));
    const cornersB = smoothFoldCorners(pair.b, tb.uvCorners.map(function (c) { return uvToPx(c.u, c.v); }));
    const edgesA = foldGeometry.tagEdges(cornersA);
    const edgesB = foldGeometry.tagEdges(cornersB);
    const hinge = foldGeometry.hinge(edgesA, edgesB);
    const ea = foldGeometry.fixedEdge(edgesA, FOLD_EDGE_INDEX);
    const eb = foldGeometry.fixedEdge(edgesB, FOLD_EDGE_INDEX);
    if (!hinge || !ea || !eb) {
      releaseFoldPair(pair.key);
      continue;
    }
    const sideA = foldGeometry.meanSide(cornersA);
    const sideB = foldGeometry.meanSide(cornersB);
    const oa = foldGeometry.edgeOffset(ea, (pair.offsetCm / FOLD_TAG_SIZE_CM) * sideA);
    const ob = foldGeometry.edgeOffset(eb, (pair.offsetCm / FOLD_TAG_SIZE_CM) * sideB);
    const effectivePoint = { x: (oa.x + ob.x) / 2, y: (oa.y + ob.y) / 2 };
    const penLL = pxToLngLat(effectivePoint.x, effectivePoint.y);
    if (!Number.isFinite(penLL[0]) || !Number.isFinite(penLL[1])) continue;

    const open = foldPairLatch[pair.key]
      ? hinge.angle > FOLD_PEN_CLOSE_ANGLE_DEG
      : hinge.angle >= FOLD_PEN_OPEN_ANGLE_DEG;
    foldPairLatch[pair.key] = open;
    const openRange = FOLD_PEN_OPEN_ANGLE_DEG - FOLD_PEN_CLOSE_ANGLE_DEG;
    const targetOpen = foldClamp01((hinge.angle - FOLD_PEN_CLOSE_ANGLE_DEG) / openRange);
    const visual = foldPairVisual[pair.key] || { value: targetOpen, at: now };
    const dt = Math.max(0, Math.min(160, now - Number(visual.at || now)));
    const visualOpen = foldMix(Number(visual.value) || 0, targetOpen, 1 - Math.exp(-dt / 180));
    foldPairVisual[pair.key] = { value: visualOpen, at: now };

    // Closed pairs feed no point, so their trail fades out.
    feats.push(...foldLaserFeatures(open ? penLL : null, pairColor, visualOpen, pair.key, now));
    if (!open) feats.push(foldGhostFeature(penLL, pairColor, visualOpen, pair.key));

    const penPoint = { lng: penLL[0], lat: penLL[1] };
    if (isSelector) {
      const centerA = foldTagCenterPx(cornersA);
      const centerB = foldTagCenterPx(cornersB);
      toolPairFramesByKey[String(pair.key)] = {
        pairKey: String(pair.key),
        drawTagId: Number(pair.drawTagId),
        label: String(pair.label || 'Tools'),
        open: open,
        tipPx: { x: effectivePoint.x, y: effectivePoint.y },
        anchorPx: { x: (centerA.x + centerB.x) / 2, y: (centerA.y + centerB.y) / 2 }
      };
    } else if (open && drawMode === 'erase') {
      erasePoints.push(penPoint);
    } else if (open && drawMode === 'sticker') {
      stickerPoints['drawpair:' + String(pair.key)] = {
        lng: penPoint.lng,
        lat: penPoint.lat,
        color: pair.color,
        tagSizePx: (sideA + sideB) / 2,
        holdMs: 1000,
        continuousHold: true
      };
    } else if (open && drawMode === 'select') {
      moveCandidates.push({
        lng: penPoint.lng,
        lat: penPoint.lat,
        tagId: Number(pair.a),
        selectorKey: 'drawpair:' + String(pair.key)
      });
    } else if (open && drawMode === 'draw') {
      drawPoints['pair:' + pair.key] = { lng: penPoint.lng, lat: penPoint.lat, color: pair.color };
    }
  }
  const src = map.getSource(FOLD_PEN_SOURCE_ID);
  if (src) {
    // Skip setData (a re-tessellation and GPU upload) when the overlay has not changed.
    const sig = feats.length ? JSON.stringify(feats) : '';
    if (sig !== foldOverlaySig) {
      foldOverlaySig = sig;
      src.setData({ type: 'FeatureCollection', features: feats });
    }
  }
  return moveCandidates;
}
