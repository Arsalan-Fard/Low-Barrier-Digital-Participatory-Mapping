(function () {
  function createFloorplanIsovist(options) {
    var containerEl = options.containerEl;
    var maxRadiusPx = Number(options.maxRadiusPx || 620);
    var cellSize = Number(options.cellSize || 120);
    var toViewportPoint = typeof options.toViewportPoint === 'function' ? options.toViewportPoint : null;
    var root = null;
    var polygon = null;
    var originDot = null;
    var segments = [];
    var grid = {};
    var lastUpdateMs = 0;
    var lastOrigin = null;
    var visibilityModule = null;
    var visibilityModuleRequested = false;

    function ensureRoot() {
      if (root || !containerEl) return;
      root = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      root.setAttribute('class', 'floorplan-isovist-overlay');
      root.style.position = 'absolute';
      root.style.inset = '0';
      root.style.width = '100%';
      root.style.height = '100%';
      root.style.zIndex = '5';
      root.style.pointerEvents = 'none';

      polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      polygon.setAttribute('fill', 'rgba(250, 204, 21, 0.26)');
      polygon.setAttribute('stroke', 'rgba(250, 204, 21, 0.92)');
      polygon.setAttribute('stroke-width', '2');
      polygon.setAttribute('stroke-linejoin', 'round');
      root.appendChild(polygon);

      originDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      originDot.setAttribute('r', '5');
      originDot.setAttribute('fill', '#facc15');
      originDot.setAttribute('stroke', '#111');
      originDot.setAttribute('stroke-width', '2');
      root.appendChild(originDot);

      containerEl.appendChild(root);
    }

    function clear() {
      if (polygon) polygon.setAttribute('points', '');
      if (originDot) {
        originDot.setAttribute('cx', '-9999');
        originDot.setAttribute('cy', '-9999');
      }
      lastOrigin = null;
    }

    function cellKey(ix, iy) {
      return String(ix) + ',' + String(iy);
    }

    function setSegments(nextSegments) {
      segments = Array.isArray(nextSegments) ? nextSegments.slice() : [];
      grid = {};
      for (var i = 0; i < segments.length; i++) {
        var s = segments[i];
        var minX = Math.min(s.x1, s.x2);
        var maxX = Math.max(s.x1, s.x2);
        var minY = Math.min(s.y1, s.y2);
        var maxY = Math.max(s.y1, s.y2);
        if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) continue;
        var x0 = Math.floor(minX / cellSize);
        var x1 = Math.floor(maxX / cellSize);
        var y0 = Math.floor(minY / cellSize);
        var y1 = Math.floor(maxY / cellSize);
        for (var ix = x0; ix <= x1; ix++) {
          for (var iy = y0; iy <= y1; iy++) {
            var key = cellKey(ix, iy);
            if (!grid[key]) grid[key] = [];
            grid[key].push(i);
          }
        }
      }
      clear();
      loadVisibilityModule();
    }

    function nearbySegments(origin) {
      var seen = {};
      var out = [];
      var minX = origin.x - maxRadiusPx;
      var maxX = origin.x + maxRadiusPx;
      var minY = origin.y - maxRadiusPx;
      var maxY = origin.y + maxRadiusPx;
      var x0 = Math.floor(minX / cellSize);
      var x1 = Math.floor(maxX / cellSize);
      var y0 = Math.floor(minY / cellSize);
      var y1 = Math.floor(maxY / cellSize);
      var radiusSq = maxRadiusPx * maxRadiusPx;

      for (var ix = x0; ix <= x1; ix++) {
        for (var iy = y0; iy <= y1; iy++) {
          var bucket = grid[cellKey(ix, iy)];
          if (!bucket) continue;
          for (var bi = 0; bi < bucket.length; bi++) {
            var idx = bucket[bi];
            if (seen[idx]) continue;
            seen[idx] = true;
            var s = segments[idx];
            var cx = Math.max(Math.min(origin.x, Math.max(s.x1, s.x2)), Math.min(s.x1, s.x2));
            var cy = Math.max(Math.min(origin.y, Math.max(s.y1, s.y2)), Math.min(s.y1, s.y2));
            var dx = cx - origin.x;
            var dy = cy - origin.y;
            if ((dx * dx + dy * dy) <= radiusSq) out.push(s);
          }
        }
      }
      return out;
    }

    function loadVisibilityModule() {
      if (visibilityModule || visibilityModuleRequested) return;
      visibilityModuleRequested = true;
      import('/vendor/Isovist-VGA/visibility-polygon.esm.js')
        .then(function (mod) {
          visibilityModule = mod;
          lastOrigin = null;
        })
        .catch(function (err) {
          console.warn('visibility-polygon unavailable, using fallback isovist:', err);
        });
    }

    function toVisibilitySegments(origin, candidates) {
      var out = [];
      for (var i = 0; i < candidates.length; i++) {
        var s = candidates[i];
        out.push([[s.x1, s.y1], [s.x2, s.y2]]);
      }

      var r = maxRadiusPx;
      var sides = 64;
      var boundary = [];
      for (var j = 0; j < sides; j++) {
        var a = (Math.PI * 2 * j) / sides;
        boundary.push([origin.x + Math.cos(a) * r, origin.y + Math.sin(a) * r]);
      }
      for (var k = 0; k < boundary.length; k++) {
        out.push([boundary[k], boundary[(k + 1) % boundary.length]]);
      }
      return out;
    }

    function intersectRaySegment(origin, angle, s) {
      var rdx = Math.cos(angle);
      var rdy = Math.sin(angle);
      var sx = s.x2 - s.x1;
      var sy = s.y2 - s.y1;
      var denom = rdx * sy - rdy * sx;
      if (Math.abs(denom) < 1e-9) return null;
      var qpx = s.x1 - origin.x;
      var qpy = s.y1 - origin.y;
      var t = (qpx * sy - qpy * sx) / denom;
      var u = (qpx * rdy - qpy * rdx) / denom;
      if (t < 0 || u < 0 || u > 1) return null;
      return { x: origin.x + rdx * t, y: origin.y + rdy * t, dist: t };
    }

    function cast(origin, angle, candidates) {
      var best = { x: origin.x + Math.cos(angle) * maxRadiusPx, y: origin.y + Math.sin(angle) * maxRadiusPx, dist: maxRadiusPx };
      for (var i = 0; i < candidates.length; i++) {
        var hit = intersectRaySegment(origin, angle, candidates[i]);
        if (hit && hit.dist < best.dist) best = hit;
      }
      return { x: best.x, y: best.y, angle: angle };
    }

    function dedupeFallbackPoints(points) {
      var out = [];
      for (var i = 0; i < points.length; i++) {
        var p = points[i];
        var prev = out[out.length - 1];
        if (prev) {
          var dx = p.x - prev.x;
          var dy = p.y - prev.y;
          if ((dx * dx + dy * dy) < 1) continue;
        }
        out.push(p);
      }
      if (out.length > 2) {
        var first = out[0];
        var last = out[out.length - 1];
        var fdx = first.x - last.x;
        var fdy = first.y - last.y;
        if ((fdx * fdx + fdy * fdy) < 1) out.pop();
      }
      return out;
    }

    function fallbackVisibility(origin, candidates) {
      var angles = [];
      var eps = 0.0008;
      for (var i = 0; i < candidates.length; i++) {
        var s = candidates[i];
        var a1 = Math.atan2(s.y1 - origin.y, s.x1 - origin.x);
        var a2 = Math.atan2(s.y2 - origin.y, s.x2 - origin.x);
        angles.push(a1 - eps, a1, a1 + eps, a2 - eps, a2, a2 + eps);
      }
      var points = angles.map(function (angle) { return cast(origin, angle, candidates); });
      points.sort(function (a, b) { return a.angle - b.angle; });
      return dedupeFallbackPoints(points);
    }

    function cleanVisibilityPoints(rawPoints) {
      var out = [];
      var last = null;
      for (var i = 0; i < rawPoints.length; i++) {
        var p = rawPoints[i];
        if (!Array.isArray(p) || p.length < 2) continue;
        var x = Number(p[0]);
        var y = Number(p[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (last) {
          var dx = x - last.x;
          var dy = y - last.y;
          if ((dx * dx + dy * dy) < 1) continue;
        }
        last = { x: x, y: y };
        out.push(last);
      }
      if (out.length > 2) {
        var first = out[0];
        var final = out[out.length - 1];
        var fdx = first.x - final.x;
        var fdy = first.y - final.y;
        if ((fdx * fdx + fdy * fdy) < 1) out.pop();
      }
      return out;
    }

    function libraryVisibility(origin, candidates, options) {
      if (!visibilityModule || typeof visibilityModule.compute !== 'function') return null;
      options = options || {};
      var vpSegments = toVisibilitySegments(origin, candidates);
      try {
        if (!options.skipBreakIntersections && typeof visibilityModule.breakIntersections === 'function' && candidates.length < 1200) {
          vpSegments = visibilityModule.breakIntersections(vpSegments);
        }
        return cleanVisibilityPoints(visibilityModule.compute([origin.x, origin.y], vpSegments));
      } catch (err) {
        console.warn('visibility-polygon failed, using fallback isovist:', err);
        return null;
      }
    }

    function shouldSkip(origin, nowMs) {
      if (!lastOrigin) return false;
      var dx = origin.x - lastOrigin.x;
      var dy = origin.y - lastOrigin.y;
      return (nowMs - lastUpdateMs) < 90 && (dx * dx + dy * dy) < 16;
    }

    function computePolygon(origin, options) {
      if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !segments.length) return [];
      var candidates = nearbySegments(origin);
      return libraryVisibility(origin, candidates, options) || fallbackVisibility(origin, candidates);
    }

    function update(origin) {
      ensureRoot();
      loadVisibilityModule();
      if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !segments.length) {
        clear();
        return;
      }

      var nowMs = Date.now();
      if (shouldSkip(origin, nowMs)) return;
      lastUpdateMs = nowMs;
      lastOrigin = { x: origin.x, y: origin.y };

      var points = computePolygon(origin);

      polygon.setAttribute('points', points.map(function (p) {
        var out = toViewportPoint ? toViewportPoint(p) : p;
        return out.x.toFixed(1) + ',' + out.y.toFixed(1);
      }).join(' '));
      var displayOrigin = toViewportPoint ? toViewportPoint(origin) : origin;
      originDot.setAttribute('cx', String(displayOrigin.x));
      originDot.setAttribute('cy', String(displayOrigin.y));
    }

    return {
      setSegments: setSegments,
      update: update,
      computePolygon: computePolygon,
      hasSegments: function () { return segments.length > 0; },
      clear: clear
    };
  }

  window.CompactFloorplanIsovist = { createFloorplanIsovist: createFloorplanIsovist };
})();
