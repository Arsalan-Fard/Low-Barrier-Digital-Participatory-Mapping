// Map page: the tool mode of each draw-tool tag (draw, erase, select or sticker)
// and the tool-selector menus that switch it.
const drawToolTagIds = tagAssignments.getToolTagIds('draw');
const DRAW_TOOL_TAG_IDS = drawToolTagIds.length ? drawToolTagIds : [11, 12, 13, 14];
const DRAW_TOOL_DEFAULT_COLOR = '#ff5b5b';
const drawToolModeByTagId = {};
DRAW_TOOL_TAG_IDS.forEach(function (tagId) {
  drawToolModeByTagId[tagId] = 'draw';
});
// A selector pair at rest shows a fixed arc of options above it; folding the pair
// toward one switches its drawing pair to that tool. The options sit on the top
// half only, so a press aimed downward selects nothing.
const TOOL_PAIR_MENU_RADIUS_PX = 96;
const TOOL_PAIR_MENU_DEAD_ZONE_PX = 22;
const TOOL_PAIR_MENU_MAX_ANGLE_DEG = 34;
const TOOL_PAIR_MENU_OPTIONS = [
  { key: 'draw', label: 'Draw', angleDeg: -157.5, accent: '#ff6b6b' },
  { key: 'erase', label: 'Erase', angleDeg: -112.5, accent: '#f8fafc' },
  { key: 'select', label: 'Select', angleDeg: -67.5, accent: '#7dd3fc' },
  { key: 'sticker', label: 'Mark', angleDeg: -22.5, accent: '#facc15' }
];
const TOOL_PAIR_DRAW_COLOR = '#ff5b5b';
const toolPairRuntimeByKey = {};
let toolPairMenuRoot = null;

function isDrawToolTagId(tagId) {
  return DRAW_TOOL_TAG_IDS.indexOf(Number(tagId)) !== -1;
}

function currentDrawToolMode(tagId) {
  if (!isDrawToolTagId(tagId)) return 'draw';
  return drawToolModeByTagId[Number(tagId)];
}

function setDrawToolMode(tagId, mode) {
  if (isDrawToolTagId(tagId)) drawToolModeByTagId[Number(tagId)] = mode;
}

function baseDrawTagAssignment(tagId, baseAssignment) {
  var base = baseAssignment || {};
  return {
    tagId: Number(tagId),
    colorName: base.colorName ? String(base.colorName) : 'red',
    color: base.color ? String(base.color) : DRAW_TOOL_DEFAULT_COLOR
  };
}

// A draw-tool tag acts as the tool of its current mode.
function effectiveAssignmentForTag(tagId, baseAssignment) {
  if (!isDrawToolTagId(tagId)) return baseAssignment;
  var base = baseDrawTagAssignment(tagId, baseAssignment);
  var mode = currentDrawToolMode(tagId);
  if (mode === 'erase') {
    return { tagId: base.tagId, tool: 'eraser', colorName: 'white', color: '#ffffff' };
  }
  if (mode === 'select') {
    return { tagId: base.tagId, tool: 'drag', colorName: 'blue', color: '#7dd3fc' };
  }
  return { tagId: base.tagId, tool: 'draw', colorName: base.colorName, color: base.color };
}

function normalizeAngle(a) {
  a = a % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

function polarPoint(center, radius, angleDeg) {
  var angleRad = angleDeg * Math.PI / 180;
  return {
    x: center.x + Math.cos(angleRad) * radius,
    y: center.y + Math.sin(angleRad) * radius
  };
}

function toolPairState(pairKey, drawTagId) {
  var key = String(pairKey);
  if (!toolPairRuntimeByKey[key]) {
    toolPairRuntimeByKey[key] = { mode: currentDrawToolMode(drawTagId), menuRuntime: null, wasOpen: false };
  }
  return toolPairRuntimeByKey[key];
}

function toolPairLaserColor(pair) {
  var mode = toolPairState(pair.key, pair.drawTagId).mode;
  if (mode === 'draw') return TOOL_PAIR_DRAW_COLOR;
  if (mode === 'erase') return FOLD_ERASER_COLOR;
  if (mode === 'sticker') return '#facc15';
  return '#7dd3fc';
}

function ensureToolPairMenuRoot() {
  if (toolPairMenuRoot) return toolPairMenuRoot;
  toolPairMenuRoot = document.createElement('div');
  Object.assign(toolPairMenuRoot.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '11' });
  mapView.appendChild(toolPairMenuRoot);
  return toolPairMenuRoot;
}

function styleToolPairMenu(menu) {
  TOOL_PAIR_MENU_OPTIONS.forEach(function (option) {
    var el = menu.optionElsByKey[option.key];
    var active = option.key === menu.selectedMode;
    var opacity = '1';
    if (option.key === 'select') opacity = active ? '0.92' : '0.72';
    el.style.background = active ? 'rgba(255, 255, 255, 0.20)' : 'rgba(8, 10, 16, 0.76)';
    el.style.borderColor = active ? option.accent : 'rgba(255, 255, 255, 0.16)';
    el.style.color = active && option.key === 'erase' ? '#111827' : '#f8fafc';
    el.style.transform = 'translate(-50%, -50%) scale(' + (active ? '1.08' : '1') + ')';
    el.style.boxShadow = active
      ? '0 0 0 1px rgba(255,255,255,0.08), 0 10px 24px rgba(0,0,0,0.26), 0 0 24px ' + option.accent
      : '0 8px 18px rgba(0,0,0,0.22)';
    el.style.opacity = opacity;
  });
}

// The menu stays anchored where the selector pair first appeared, so the pair can move to aim at it.
function createToolPairMenu(frame, selectedMode) {
  var radius = TOOL_PAIR_MENU_RADIUS_PX;
  var container = document.createElement('div');
  Object.assign(container.style, {
    position: 'absolute',
    left: String(frame.anchorPx.x) + 'px',
    top: String(frame.anchorPx.y) + 'px',
    width: '0',
    height: '0',
    transform: 'translate(-50%, -50%)'
  });

  var ring = document.createElement('div');
  Object.assign(ring.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: String(radius * 2 + 78) + 'px',
    height: String(radius * 2 + 78) + 'px',
    transform: 'translate(-50%, -50%)',
    borderRadius: '999px',
    border: '1px solid rgba(255, 255, 255, 0.14)',
    background: 'radial-gradient(circle, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 42%, rgba(0,0,0,0) 68%)',
    boxShadow: '0 0 0 1px rgba(255,255,255,0.03), inset 0 0 28px rgba(255,255,255,0.03)'
  });
  container.appendChild(ring);

  var centerDot = document.createElement('div');
  Object.assign(centerDot.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '18px',
    height: '18px',
    transform: 'translate(-50%, -50%)',
    borderRadius: '999px',
    background: 'rgba(255,255,255,0.94)',
    boxShadow: '0 0 0 2px rgba(0,0,0,0.45), 0 0 24px rgba(255,255,255,0.32)'
  });
  container.appendChild(centerDot);

  var label = document.createElement('div');
  Object.assign(label.style, {
    position: 'absolute',
    left: '0',
    top: String(-(radius + 48)) + 'px',
    transform: 'translate(-50%, -50%)',
    padding: '6px 10px',
    borderRadius: '999px',
    background: 'rgba(6, 8, 14, 0.86)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: '#f8fafc',
    fontSize: '12px',
    fontWeight: '700',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap'
  });
  label.textContent = frame.label;
  container.appendChild(label);

  var menu = {
    anchorPoint: { x: Number(frame.anchorPx.x), y: Number(frame.anchorPx.y) },
    selectedMode: selectedMode,
    container: container,
    optionElsByKey: {}
  };
  TOOL_PAIR_MENU_OPTIONS.forEach(function (option) {
    var pos = polarPoint({ x: 0, y: 0 }, radius, option.angleDeg);
    var optionEl = document.createElement('div');
    Object.assign(optionEl.style, {
      position: 'absolute',
      left: String(pos.x) + 'px',
      top: String(pos.y) + 'px',
      width: '74px',
      minHeight: '74px',
      padding: '10px 8px',
      transform: 'translate(-50%, -50%)',
      borderRadius: '999px',
      border: '1px solid rgba(255,255,255,0.16)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      fontSize: '12px',
      fontWeight: '700',
      letterSpacing: '0.04em',
      color: '#f8fafc',
      transition: 'transform 110ms ease, border-color 110ms ease, box-shadow 110ms ease, background 110ms ease, opacity 110ms ease'
    });
    optionEl.textContent = option.label;
    menu.optionElsByKey[option.key] = optionEl;
    container.appendChild(optionEl);
  });

  styleToolPairMenu(menu);
  ensureToolPairMenuRoot().appendChild(container);
  return menu;
}

function removeToolPairMenu(state) {
  var menu = state.menuRuntime;
  if (menu && menu.container.parentNode) menu.container.parentNode.removeChild(menu.container);
  state.menuRuntime = null;
}

function toolPairMenuOptionAt(anchor, tip) {
  var dx = Number(tip.x) - Number(anchor.x);
  var dy = Number(tip.y) - Number(anchor.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (dy >= 0) return null;
  if (Math.sqrt(dx * dx + dy * dy) < TOOL_PAIR_MENU_DEAD_ZONE_PX) return null;
  var angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
  var best = null;
  var bestDistance = Infinity;
  for (var i = 0; i < TOOL_PAIR_MENU_OPTIONS.length; i++) {
    var option = TOOL_PAIR_MENU_OPTIONS[i];
    var distance = Math.abs(normalizeAngle(angleDeg - option.angleDeg));
    if (distance < bestDistance) {
      best = option;
      bestDistance = distance;
    }
  }
  return bestDistance <= TOOL_PAIR_MENU_MAX_ANGLE_DEG ? best : null;
}

// Shows a menu for every selector pair seen this frame (from applyFoldPairs); the
// moment a pair opens while aimed at an option, that option becomes its pointer's tool.
function applyToolPairFrames() {
  var visible = {};
  Object.keys(toolPairFramesByKey).forEach(function (pairKey) {
    var frame = toolPairFramesByKey[pairKey];
    var state = toolPairState(pairKey, frame.drawTagId);
    visible[pairKey] = true;
    if (!state.menuRuntime) state.menuRuntime = createToolPairMenu(frame, state.mode);
    state.menuRuntime.selectedMode = state.mode;
    styleToolPairMenu(state.menuRuntime);

    var pressEdge = frame.open && !state.wasOpen;
    state.wasOpen = frame.open;
    if (!pressEdge) return;
    var picked = toolPairMenuOptionAt(state.menuRuntime.anchorPoint, frame.tipPx);
    if (!picked) return;
    state.mode = picked.key;
    setDrawToolMode(frame.drawTagId, picked.key);
    state.menuRuntime.selectedMode = state.mode;
    styleToolPairMenu(state.menuRuntime);
  });

  Object.keys(toolPairRuntimeByKey).forEach(function (key) {
    if (visible[key]) return;
    var stale = toolPairRuntimeByKey[key];
    removeToolPairMenu(stale);
    stale.wasOpen = false;
  });
}
