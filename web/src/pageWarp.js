(function () {
  var WARP_ID = 'projectionWarp';
  var STORAGE_KEY = 'compact-workshop-page-warp-v1';
  // Read as a fallback here and in home.js, and cleared by reset(); never written.
  var LEGACY_KEY = 'compact-workshop-maptastic-layout-v1';
  var instance = null;
  var layerEl = null;
  var applyingLayout = false;
  var saveTimer = 0;
  // Set by reset(): nothing may write a layout back for the rest of this page's life.
  var savingBlocked = false;

  function isValidPointArray(points) {
    if (!Array.isArray(points) || points.length !== 4) return false;
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1]))) {
        return false;
      }
    }
    return true;
  }

  function clonePoints(points) {
    return points.map(function (p) { return [Number(p[0]), Number(p[1])]; });
  }

  function elementSize() {
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
    try {
      return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || window.localStorage.getItem(LEGACY_KEY));
    } catch (_err) {
      return null;
    }
  }

  function writePayload(payload) {
    if (savingBlocked) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_err) {
      // Storage unavailable.
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
      source: sourceLabel,
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
    if (!payload) return null;
    var size = elementSize();
    var targetPoints = denormalizePoints(payload.targetPointsNormalized, size.width, size.height);
    if (!targetPoints) return null;
    var sourcePoints = denormalizePoints(payload.sourcePointsNormalized, size.width, size.height)
      || defaultSourcePoints(size.width, size.height);
    return [{ id: WARP_ID, sourcePoints: sourcePoints, targetPoints: targetPoints }];
  }

  function saveCurrentLayout(sourceLabel) {
    if (!instance) return;
    var payload = payloadFromLayout(instance.getLayout(), sourceLabel);
    if (payload) writePayload(payload);
  }

  function scheduleSave() {
    if (applyingLayout) return;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(function () {
      saveTimer = 0;
      saveCurrentLayout('manual-maptastic');
    }, 80);
  }

  // Maptastic calls onchange for layouts set from code too; applyingLayout
  // keeps scheduleSave from treating those as manual edits.
  function applySavedLayout(force) {
    if (!instance) return;
    var layout = layoutFromPayload(readPayload());
    if (!layout) return;
    applyingLayout = true;
    try {
      instance.setLayout(layout);
    } catch (err) {
      console.error('Failed to apply page warp layout:', err);
      return;
    } finally {
      window.setTimeout(function () { applyingLayout = false; }, 0);
    }
    if (force) saveCurrentLayout('page-warp-resize');
  }

  // Clears the saved alignment and flattens the page now. Saving is blocked
  // first, or this page's beforeunload save writes the warp straight back
  // when the caller reloads.
  function reset() {
    savingBlocked = true;
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
    }
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_KEY);
    } catch (_err) {
      // Private mode: flattening the layout below still straightens the page.
    }

    var size = elementSize();
    if (instance && size.width && size.height) {
      var square = defaultSourcePoints(size.width, size.height);
      applyingLayout = true;
      try {
        instance.setLayout([{ id: WARP_ID, sourcePoints: square, targetPoints: square }]);
      } catch (err) {
        console.error('Failed to clear the page warp:', err);
      } finally {
        window.setTimeout(function () { applyingLayout = false; }, 0);
      }
    }
  }

  // Whether html or body is overflow hidden/clip, as on the map pages and the workshop home.
  function pageDeclaresNoScroll() {
    try {
      var body = window.getComputedStyle(document.body).overflowY;
      var root = window.getComputedStyle(document.documentElement).overflowY;
      return body === 'hidden' || body === 'clip' || root === 'hidden' || root === 'clip';
    } catch (_err) {
      return false;
    }
  }

  // Moves the body's content into one fixed layer that Maptastic warps.
  function createLayer() {
    layerEl = document.createElement('div');
    layerEl.id = WARP_ID;
    layerEl.style.position = 'fixed';
    layerEl.style.left = '0';
    layerEl.style.top = '0';
    layerEl.style.width = '100vw';
    layerEl.style.height = '100vh';
    // This layer becomes the page's scroll container. On a non-scrolling page
    // scrollbars would pop up whenever a child pokes past the viewport and
    // shrink the fixed-inset map with them. clip (where supported) also can't
    // be scrolled by focus() or scrollIntoView(), which would shift the page
    // under the projector.
    if (pageDeclaresNoScroll()) {
      layerEl.style.overflow = 'hidden';
      layerEl.style.overflow = 'clip';
    } else {
      layerEl.style.overflow = 'auto';
    }
    layerEl.style.transformOrigin = '0 0';

    document.body.insertBefore(layerEl, document.body.firstChild);
    var children = Array.prototype.slice.call(document.body.childNodes);
    for (var i = 0; i < children.length; i++) {
      var node = children[i];
      if (node === layerEl) continue;
      if (node.nodeType === 1 && (node.tagName === 'SCRIPT' || node.hasAttribute('data-page-warp-exclude'))) continue;
      layerEl.appendChild(node);
    }
  }

  function init() {
    createLayer();
    if (typeof window.Maptastic !== 'function') return;

    instance = window.Maptastic({
      autoSave: false,
      autoLoad: false,
      onchange: scheduleSave,
      layers: [WARP_ID]
    });

    applySavedLayout(false);
    window.addEventListener('beforeunload', function () { saveCurrentLayout('manual-maptastic'); });
    window.addEventListener('resize', function () {
      window.setTimeout(function () { applySavedLayout(true); }, 50);
    });
  }

  window.CompactPageWarp = {
    applySavedLayout: applySavedLayout,
    reset: reset,
    isActive: function () { return !!instance; },
    getLayer: function () { return layerEl; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
