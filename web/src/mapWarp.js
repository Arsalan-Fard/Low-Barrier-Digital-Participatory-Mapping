(function () {
  function normalizePoint(point) {
    if (!point || typeof point.w !== 'number' || !point.w || point.w === 1) return point;
    return new DOMPoint(point.x / point.w, point.y / point.w, point.z / point.w, 1);
  }

  function matrixOf(el) {
    var transform = window.getComputedStyle(el).transform;
    return (transform && transform !== 'none') ? new DOMMatrixReadOnly(transform) : new DOMMatrixReadOnly();
  }

  function createMapWarp(options) {
    var mapViewEl = options.mapViewEl;
    var initialized = false;

    function viewportToLocal(x, y) {
      try {
        return normalizePoint(new DOMPoint(x, y, 0, 1).matrixTransform(matrixOf(mapViewEl).inverse()));
      } catch (_err) {
        return { x: x, y: y };
      }
    }

    function localToViewport(x, y) {
      try {
        return normalizePoint(new DOMPoint(x, y, 0, 1).matrixTransform(matrixOf(mapViewEl)));
      } catch (_err) {
        return { x: x, y: y };
      }
    }

    // pageWarp.js warps the whole page through #projectionWarp, fixed at the
    // viewport origin with transform-origin 0 0, so inverting that transform
    // turns a screen pixel (tag uv, mouse) into the map-canvas pixel under it.
    function screenToMap(x, y) {
      var layer = window.CompactPageWarp.getLayer();
      try {
        var matrix = layer ? matrixOf(layer) : new DOMMatrixReadOnly();
        return normalizePoint(new DOMPoint(x, y, 0, 1).matrixTransform(matrix.inverse()));
      } catch (_err) {
        return { x: x, y: y };
      }
    }

    function getViewportSize() {
      return { width: mapViewEl.offsetWidth, height: mapViewEl.offsetHeight };
    }

    function applySavedLayout(force) {
      if (window.CompactPageWarp.isActive()) window.CompactPageWarp.applySavedLayout(force);
    }

    window.addEventListener('resize', function () {
      if (initialized) applySavedLayout(true);
    });

    function initIfNeeded() {
      if (initialized || !mapViewEl.offsetWidth || !mapViewEl.offsetHeight) return;
      initialized = true;
      applySavedLayout(true);
    }

    return {
      getViewportSize: getViewportSize,
      viewportToLocal: viewportToLocal,
      localToViewport: localToViewport,
      screenToMap: screenToMap,
      initIfNeeded: initIfNeeded
    };
  }

  window.CompactMapWarp = { createMapWarp: createMapWarp };
})();
