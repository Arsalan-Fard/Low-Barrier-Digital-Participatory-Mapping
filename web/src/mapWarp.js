(function () {
  var AUTO_LAYOUT_STORAGE_KEY = 'compact-workshop-maptastic-layout-v1';

  function normalizePoint(point) {
    if (!point || typeof point.w !== 'number' || !point.w || point.w === 1) return point;
    return new DOMPoint(point.x / point.w, point.y / point.w, point.z / point.w, 1);
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function isValidPointArray(points) {
    if (!Array.isArray(points) || points.length !== 4) return false;
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (!Array.isArray(p) || p.length < 2 || !isFiniteNumber(p[0]) || !isFiniteNumber(p[1])) {
        return false;
      }
    }
    return true;
  }

  function clonePoints(points) {
    return points.map(function (p) { return [Number(p[0]), Number(p[1])]; });
  }

  function createMapWarp(options) {
    var mapViewEl = options.mapViewEl;
    var mapWarpEl = options.mapWarpEl;
    var initialized = false;
    var lastAppliedAutoLayoutKey = '';

    function getMatrix() {
      var transform = window.getComputedStyle(mapViewEl).transform;
      return (transform && transform !== 'none')
        ? new DOMMatrixReadOnly(transform)
        : new DOMMatrixReadOnly();
    }

    function viewportToLocal(x, y) {
      try {
        return normalizePoint(new DOMPoint(x, y, 0, 1).matrixTransform(getMatrix().inverse()));
      } catch (_err) {
        return { x: x, y: y };
      }
    }

    function localToViewport(x, y) {
      try {
        return normalizePoint(new DOMPoint(x, y, 0, 1).matrixTransform(getMatrix()));
      } catch (_err) {
        return { x: x, y: y };
      }
    }

    // The single page warp lives on #projectionWarp (fixed at viewport 0,0,
    // transform-origin 0 0), so a screen/viewport pixel maps to a map-canvas pixel by
    // inverting that transform. Used for screen-space inputs (tag uv, mouse) that must
    // be un-warped to land on the right map pixel. No-op when there's no page warp.
    function pageWarpEl() {
      return (window.CompactPageWarp && typeof window.CompactPageWarp.getLayer === 'function')
        ? window.CompactPageWarp.getLayer()
        : null;
    }

    function pageWarpMatrix() {
      var el = pageWarpEl();
      if (!el) return new DOMMatrixReadOnly();
      var transform = window.getComputedStyle(el).transform;
      return (transform && transform !== 'none') ? new DOMMatrixReadOnly(transform) : new DOMMatrixReadOnly();
    }

    function screenToMap(x, y) {
      try {
        return normalizePoint(new DOMPoint(x, y, 0, 1).matrixTransform(pageWarpMatrix().inverse()));
      } catch (_err) {
        return { x: x, y: y };
      }
    }

    function mapToScreen(x, y) {
      try {
        return normalizePoint(new DOMPoint(x, y, 0, 1).matrixTransform(pageWarpMatrix()));
      } catch (_err) {
        return { x: x, y: y };
      }
    }

    function clientToLocal(clientX, clientY) {
      // With the shared page warp, #projectionWarp is anchored at viewport (0,0), so
      // client == viewport and the map pixel is the inverse-warp of the client point.
      if (isPageWarpActive()) return screenToMap(clientX, clientY);
      var rect = mapViewEl.getBoundingClientRect();
      return viewportToLocal(clientX - rect.left, clientY - rect.top);
    }

    function localToClient(x, y) {
      if (isPageWarpActive()) {
        var s = mapToScreen(x, y);
        return { x: s.x, y: s.y };
      }
      var rect = mapViewEl.getBoundingClientRect();
      var viewportPoint = localToViewport(x, y);
      return {
        x: rect.left + viewportPoint.x,
        y: rect.top + viewportPoint.y
      };
    }

    function getViewportSize() {
      return {
        width: mapViewEl ? mapViewEl.offsetWidth : 0,
        height: mapViewEl ? mapViewEl.offsetHeight : 0
      };
    }

    function defaultSourcePoints() {
      var size = getViewportSize();
      return [[0, 0], [size.width, 0], [size.width, size.height], [0, size.height]];
    }

    function layoutFromTargetPoints(targetPoints) {
      if (!mapViewEl || !mapViewEl.id || !isValidPointArray(targetPoints)) return null;
      return [{
        id: mapViewEl.id,
        sourcePoints: defaultSourcePoints(),
        targetPoints: clonePoints(targetPoints)
      }];
    }

    function targetPointsFromPayload(payload) {
      var size = getViewportSize();
      if (!size.width || !size.height || !payload || typeof payload !== 'object') return null;

      if (isValidPointArray(payload.targetPointsNormalized)) {
        return payload.targetPointsNormalized.map(function (p) {
          return [Number(p[0]) * size.width, Number(p[1]) * size.height];
        });
      }

      if (isValidPointArray(payload.targetPoints)) {
        return clonePoints(payload.targetPoints);
      }

      if (Array.isArray(payload.layout) && payload.layout.length) {
        var entry = payload.layout[0];
        if (entry && isValidPointArray(entry.targetPoints)) {
          return clonePoints(entry.targetPoints);
        }
      }

      return null;
    }

    function getSavedAutoLayoutPayload() {
      try {
        var raw = window.localStorage.getItem(AUTO_LAYOUT_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (_err) {
        return null;
      }
    }

    function isPageWarpActive() {
      return !!(window.CompactPageWarp &&
        typeof window.CompactPageWarp.isActive === 'function' &&
        window.CompactPageWarp.isActive());
    }

    function applyLayout(layout) {
      if (!Array.isArray(layout) || !layout.length || !window.maptastic || typeof window.maptastic.setLayout !== 'function') {
        return false;
      }
      try {
        window.maptastic.setLayout(layout);
        return true;
      } catch (err) {
        console.error('Failed to apply Maptastic layout:', err);
        return false;
      }
    }

    function applySavedAutoLayout(force) {
      if (isPageWarpActive()) {
        if (window.CompactPageWarp && typeof window.CompactPageWarp.applySavedLayout === 'function') {
          return window.CompactPageWarp.applySavedLayout(!!force);
        }
        return true;
      }
      var payload = getSavedAutoLayoutPayload();
      if (!payload) return false;
      var targetPoints = targetPointsFromPayload(payload);
      var layout = layoutFromTargetPoints(targetPoints);
      if (!layout) return false;
      var key = JSON.stringify(layout[0].targetPoints);
      if (!force && key === lastAppliedAutoLayoutKey) return true;
      if (!applyLayout(layout)) return false;
      lastAppliedAutoLayoutKey = key;
      return true;
    }

    window.addEventListener('resize', function () {
      if (initialized) applySavedAutoLayout(true);
    });

    function initIfNeeded() {
      if (initialized) {
        applySavedAutoLayout(false);
        return;
      }
      if (!mapViewEl || !mapWarpEl || !mapViewEl.offsetWidth || !mapViewEl.offsetHeight) return;

      // Single-warp design: the shared page warp module (pageWarp.js → #projectionWarp)
      // owns the one and only Maptastic, which wraps the WHOLE page incl. the map.
      // pageWarp defines window.CompactPageWarp synchronously but constructs its
      // Maptastic instance later (on DOMContentLoaded). initIfNeeded() runs from
      // onPageChange, which can fire first — so guard on the MODULE existing, not on
      // isPageWarpActive(); otherwise mapWarp races in and creates a 2nd warp before
      // the page-warp instance exists. mapWarp then only provides coordinate helpers.
      if (window.CompactPageWarp) {
        initialized = true;
        applySavedAutoLayout(true);
        return;
      }

      try {
        if (!window.maptastic && (typeof window.Maptastic !== 'function' || !mapViewEl || !mapViewEl.id)) {
          return;
        }
        if (!window.maptastic) {
          window.maptastic = window.Maptastic({
            autoSave: true,
            autoLoad: false,
            layers: [mapViewEl.id]
          });
        }
        initialized = true;
        applySavedAutoLayout(true);
      } catch (err) {
        console.error('Failed to initialize Maptastic:', err);
      }
    }

    return {
      getViewportSize: getViewportSize,
      viewportToLocal: viewportToLocal,
      localToViewport: localToViewport,
      clientToLocal: clientToLocal,
      localToClient: localToClient,
      screenToMap: screenToMap,
      mapToScreen: mapToScreen,
      initIfNeeded: initIfNeeded,
      applySavedAutoLayout: applySavedAutoLayout,
      storageKey: AUTO_LAYOUT_STORAGE_KEY
    };
  }

  window.CompactMapWarp = { createMapWarp: createMapWarp };
})();
