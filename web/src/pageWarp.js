(function () {
  var WARP_ID = 'projectionWarp';
  var STORAGE_KEY = 'compact-workshop-page-warp-v1';
  var LEGACY_AUTO_KEY = 'compact-workshop-maptastic-layout-v1';
  var instance = null;
  var layerEl = null;
  var applyingLayout = false;
  var saveTimer = 0;

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function isValidPointArray(points) {
    if (!Array.isArray(points) || points.length !== 4) return false;
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (!Array.isArray(p) || p.length < 2 || !isFiniteNumber(Number(p[0])) || !isFiniteNumber(Number(p[1]))) {
        return false;
      }
    }
    return true;
  }

  function clonePoints(points) {
    return points.map(function (p) { return [Number(p[0]), Number(p[1])]; });
  }

  function elementSize() {
    if (!layerEl) return { width: 0, height: 0 };
    return {
      width: layerEl.offsetWidth || window.innerWidth || document.documentElement.clientWidth || 0,
      height: layerEl.offsetHeight || window.innerHeight || document.documentElement.clientHeight || 0
    };
  }

  function defaultSourcePoints(width, height) {
    return [[0, 0], [width, 0], [width, height], [0, height]];
  }

  function normalizePoints(points, width, height) {
    if (!isValidPointArray(points) || !width || !height) return null;
    return points.map(function (p) {
      return [Number(p[0]) / width, Number(p[1]) / height];
    });
  }

  function denormalizePoints(points, width, height) {
    if (!isValidPointArray(points) || !width || !height) return null;
    return points.map(function (p) {
      return [Number(p[0]) * width, Number(p[1]) * height];
    });
  }

  function readPayload() {
    function parse(raw) {
      if (!raw) return null;
      try {
        var payload = JSON.parse(raw);
        return payload && payload.source !== 'settings-auto-corner-tags' ? payload : null;
      } catch (_err) {
        return null;
      }
    }

    try {
      return parse(window.localStorage.getItem(STORAGE_KEY)) ||
        parse(window.localStorage.getItem(LEGACY_AUTO_KEY));
    } catch (_err) {
      return null;
    }
  }

  function writePayload(payload) {
    try {
      var raw = JSON.stringify(payload);
      window.localStorage.setItem(STORAGE_KEY, raw);
      window.localStorage.setItem(LEGACY_AUTO_KEY, raw);
      return true;
    } catch (_err) {
      return false;
    }
  }

  function payloadFromLayout(layout, sourceLabel) {
    var size = elementSize();
    if (!size.width || !size.height || !Array.isArray(layout) || !layout.length) return null;

    var entry = null;
    for (var i = 0; i < layout.length; i++) {
      if (layout[i] && layout[i].id === WARP_ID) {
        entry = layout[i];
        break;
      }
    }
    if (!entry) entry = layout[0];
    if (!entry || !isValidPointArray(entry.targetPoints)) return null;

    var sourcePoints = isValidPointArray(entry.sourcePoints)
      ? clonePoints(entry.sourcePoints)
      : defaultSourcePoints(size.width, size.height);
    var targetPoints = clonePoints(entry.targetPoints);
    var sourcePointsNormalized = normalizePoints(sourcePoints, size.width, size.height);
    var targetPointsNormalized = normalizePoints(targetPoints, size.width, size.height);
    if (!sourcePointsNormalized || !targetPointsNormalized) return null;

    return {
      version: 2,
      source: sourceLabel || 'manual-maptastic',
      id: WARP_ID,
      sourceSize: { width: size.width, height: size.height },
      sourcePoints: sourcePoints,
      targetPoints: targetPoints,
      sourcePointsNormalized: sourcePointsNormalized,
      targetPointsNormalized: targetPointsNormalized,
      updatedAt: Date.now()
    };
  }

  function layoutFromPayload(payload) {
    var size = elementSize();
    if (!size.width || !size.height || !payload || typeof payload !== 'object') return null;

    var sourcePoints = denormalizePoints(payload.sourcePointsNormalized, size.width, size.height);
    var targetPoints = denormalizePoints(payload.targetPointsNormalized, size.width, size.height);

    if (!sourcePoints && isValidPointArray(payload.sourcePoints)) {
      sourcePoints = clonePoints(payload.sourcePoints);
    }
    if (!targetPoints && isValidPointArray(payload.targetPoints)) {
      targetPoints = clonePoints(payload.targetPoints);
    }
    if (!targetPoints && Array.isArray(payload.layout) && payload.layout.length && isValidPointArray(payload.layout[0].targetPoints)) {
      targetPoints = clonePoints(payload.layout[0].targetPoints);
    }
    if (!sourcePoints) sourcePoints = defaultSourcePoints(size.width, size.height);
    if (!targetPoints) return null;

    return [{
      id: WARP_ID,
      sourcePoints: sourcePoints,
      targetPoints: targetPoints
    }];
  }

  function saveCurrentLayout(sourceLabel) {
    if (!instance || typeof instance.getLayout !== 'function') return false;
    var payload = payloadFromLayout(instance.getLayout(), sourceLabel);
    return payload ? writePayload(payload) : false;
  }

  function scheduleSave() {
    if (applyingLayout) return;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(function () {
      saveTimer = 0;
      saveCurrentLayout('manual-maptastic');
    }, 80);
  }

  function applySavedLayout(force) {
    if (!instance || typeof instance.setLayout !== 'function') return false;
    var layout = layoutFromPayload(readPayload());
    if (!layout) return false;
    applyingLayout = true;
    try {
      instance.setLayout(layout);
    } catch (err) {
      console.error('Failed to apply page warp layout:', err);
      return false;
    } finally {
      window.setTimeout(function () { applyingLayout = false; }, 0);
    }
    if (force) saveCurrentLayout('page-warp-resize');
    return true;
  }

  function saveTargetPoints(targetPoints, sourceLabel) {
    var size = elementSize();
    if (!size.width || !size.height || !isValidPointArray(targetPoints)) return false;
    var layout = [{
      id: WARP_ID,
      sourcePoints: defaultSourcePoints(size.width, size.height),
      targetPoints: clonePoints(targetPoints)
    }];
    var payload = payloadFromLayout(layout, sourceLabel || 'target-points');
    if (!payload || !writePayload(payload)) return false;
    applySavedLayout(true);
    return true;
  }

  function shouldKeepOutsideWarp(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.hasAttribute('data-page-warp-exclude')) return true;
    var id = String(node.id || '');
    return id === 'cornerTags' || id === 'driftTagOverlay';
  }

  function ensureLayer() {
    var existing = document.getElementById(WARP_ID);
    if (existing) {
      layerEl = existing;
      return existing;
    }

    var wrapper = document.createElement('div');
    wrapper.id = WARP_ID;
    wrapper.style.position = 'fixed';
    wrapper.style.left = '0';
    wrapper.style.top = '0';
    wrapper.style.width = '100vw';
    wrapper.style.height = '100vh';
    wrapper.style.overflow = 'auto';
    wrapper.style.transformOrigin = '0 0';

    document.body.insertBefore(wrapper, document.body.firstChild);
    var children = Array.prototype.slice.call(document.body.childNodes);
    for (var i = 0; i < children.length; i++) {
      var node = children[i];
      if (node === wrapper) continue;
      if (node.nodeType === 1 && String(node.tagName || '').toUpperCase() === 'SCRIPT') continue;
      if (node.nodeType === 1 && shouldKeepOutsideWarp(node)) continue;
      wrapper.appendChild(node);
    }
    layerEl = wrapper;
    return wrapper;
  }

  function init() {
    if (instance) return instance;
    var layer = ensureLayer();
    if (!layer || typeof window.Maptastic !== 'function') return null;

    instance = window.Maptastic({
      autoSave: false,
      autoLoad: false,
      onchange: scheduleSave,
      layers: [WARP_ID]
    });
    window.maptastic = instance;

    applySavedLayout(false);
    window.addEventListener('beforeunload', function () { saveCurrentLayout('manual-maptastic'); });
    window.addEventListener('resize', function () {
      window.setTimeout(function () { applySavedLayout(true); }, 50);
    });
    return instance;
  }

  window.CompactPageWarp = {
    init: init,
    applySavedLayout: applySavedLayout,
    saveCurrentLayout: saveCurrentLayout,
    saveTargetPoints: saveTargetPoints,
    isActive: function () { return !!instance; },
    getLayer: function () { return layerEl; },
    storageKey: STORAGE_KEY
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
