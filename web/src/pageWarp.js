(function () {
  var WARP_ID = 'projectionWarp';
  var STORAGE_KEY = 'compact-workshop-page-warp-v1';
  var LEGACY_AUTO_KEY = 'compact-workshop-maptastic-layout-v1';
  var instance = null;
  var layerEl = null;
  var applyingLayout = false;
  var saveTimer = 0;
  // Set by reset(). Nothing may write a layout back for the rest of this
  // page's life once the alignment has been deliberately cleared.
  var savingBlocked = false;

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
    if (savingBlocked) return false;
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

  // ---- viewport <-> layer coordinates -------------------------------------
  // The projector paints the VIEWPORT, so a camera tag's uv (normalised inside
  // the projected quad) names a viewport point. Content, though, is laid out
  // inside #projectionWarp, which the warp transform then bends. To put an
  // element under a tag you therefore need the layer point that the transform
  // maps ONTO that viewport point -- i.e. the inverse warp. The layer is fixed
  // at viewport 0,0 with transform-origin 0 0, so its transform alone relates
  // the two and no bounding-rect offset is involved. Both are the identity when
  // nothing is warped. (mapWarp.js does the same for the workshop map page.)
  function layerMatrix() {
    if (!layerEl) return null;
    var transform = window.getComputedStyle(layerEl).transform;
    if (!transform || transform === 'none') return null;
    try {
      return new DOMMatrixReadOnly(transform);
    } catch (_err) {
      return null;
    }
  }

  function project(x, y, matrix) {
    if (!matrix) return { x: x, y: y };
    try {
      var p = new DOMPoint(x, y, 0, 1).matrixTransform(matrix);
      if (typeof p.w === 'number' && p.w && p.w !== 1) return { x: p.x / p.w, y: p.y / p.w };
      return { x: p.x, y: p.y };
    } catch (_err) {
      return { x: x, y: y };
    }
  }

  function screenToLayer(x, y) {
    var m = layerMatrix();
    if (!m) return { x: x, y: y };
    try {
      return project(x, y, m.inverse());
    } catch (_err) {
      return { x: x, y: y };
    }
  }

  function layerToScreen(x, y) {
    return project(x, y, layerMatrix());
  }

  // uv (0..1 across the projected surface) -> the layer point that lands there.
  function uvToLayer(u, v, width, height) {
    var w = width || window.innerWidth;
    var h = height || window.innerHeight;
    return screenToLayer(Number(u) * w, Number(v) * h);
  }

  // Clear the saved projection alignment and flatten the page now.
  //
  // Removing the storage keys is not enough on its own: this module saves the
  // live layout on beforeunload, so a caller that cleared storage and then
  // reloaded had its OWN unload handler write the still-warped layout straight
  // back, and the page came up warped again -- which is exactly what the Reset
  // button on the home page did. Blocking saves first is what makes the clear
  // stick, and flattening the layout means the page straightens immediately
  // whether or not the caller reloads.
  function reset() {
    savingBlocked = true;
    if (saveTimer) { window.clearTimeout(saveTimer); saveTimer = 0; }
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_AUTO_KEY);
    } catch (_err) { /* private mode: the layout below still straightens it */ }

    var size = elementSize();
    if (instance && typeof instance.setLayout === 'function' && size.width && size.height) {
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
    return true;
  }

  function shouldKeepOutsideWarp(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.hasAttribute('data-page-warp-exclude')) return true;
    var id = String(node.id || '');
    return id === 'cornerTags' || id === 'driftTagOverlay';
  }

  // Whether the page has declared itself non-scrolling (html or body with
  // overflow hidden/clip), as the map pages and the workshop home do.
  function pageDeclaresNoScroll() {
    try {
      var body = window.getComputedStyle(document.body).overflowY;
      var root = window.getComputedStyle(document.documentElement).overflowY;
      return body === 'hidden' || body === 'clip' || root === 'hidden' || root === 'clip';
    } catch (_err) {
      return false;
    }
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
    // Once the body's children move in here, this layer IS the page's scroll
    // container: body itself holds nothing. So a page that has declared
    // itself non-scrolling must not grow scrollbars here either. It used to
    // (overflow: auto regardless), and on the map pages any child poking past
    // the viewport -- a sheet window at the table's edge, a pen menu near a
    // corner, a popup -- popped both scrollbars up, shrank the layer's client
    // box by their width, and the fixed-inset map with it; when the child
    // moved back, the map grew again. Scrolling pages (results) keep the
    // layer as their scroller.
    //
    // clip rather than hidden where the engine has it: a hidden scroller is
    // still scrolled by focus() and scrollIntoView(), which would shift the
    // whole page under the projector; clip never scrolls. An engine without
    // clip ignores that assignment and keeps hidden.
    if (pageDeclaresNoScroll()) {
      wrapper.style.overflow = 'hidden';
      wrapper.style.overflow = 'clip';
    } else {
      wrapper.style.overflow = 'auto';
    }
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
    reset: reset,
    screenToLayer: screenToLayer,
    layerToScreen: layerToScreen,
    uvToLayer: uvToLayer,
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
