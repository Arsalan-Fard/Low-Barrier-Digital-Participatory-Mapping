// The street view screen: a printed A3 sheet with AprilTags round its border. While the
// camera sees the sheet on the table, the page's street view inset is warped into the
// sheet's white inside; the tag layout comes from /api/street-screen/frame.
(function () {
  var MIN_TAGS = 2;          // one tag extrapolates ~20x its own size to the far corner, and jitters to match
  var HOLD_MS = 1800;        // keep the last pose this long once the sheet is lost
  var SMOOTH = 0.4;          // per-frame blend toward the freshly fitted quad
  var STILL_PX = 1.5;        // a corner has to move this far before the screen is redrawn
  var VIEW_W = 960;          // the inset's own width before it is warped onto the sheet
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // Gaussian elimination with partial pivoting; null when singular.
  function solve(M, r) {
    var n = r.length;
    var A = M.map(function (row, i) { return row.concat([r[i]]); });
    for (var col = 0; col < n; col += 1) {
      var pivot = col;
      for (var i = col + 1; i < n; i += 1) {
        if (Math.abs(A[i][col]) > Math.abs(A[pivot][col])) pivot = i;
      }
      if (Math.abs(A[pivot][col]) < 1e-12) return null;
      var swap = A[col];
      A[col] = A[pivot];
      A[pivot] = swap;
      for (var k = col + 1; k < n; k += 1) {
        var f = A[k][col] / A[col][col];
        if (!f) continue;
        for (var j = col; j <= n; j += 1) A[k][j] -= f * A[col][j];
      }
    }
    var x = new Array(n);
    for (var i2 = n - 1; i2 >= 0; i2 -= 1) {
      var acc = A[i2][n];
      for (var j2 = i2 + 1; j2 < n; j2 += 1) acc -= A[i2][j2] * x[j2];
      x[i2] = acc / A[i2][i2];
    }
    return x;
  }

  // Least-squares homography from (x, y) to (u, v), h33 = 1, over four or more pairs.
  // `scale` divides x and y first so millimetres or pixels do not swamp the unit-square side.
  function homography(pairs, scale) {
    if (!pairs || pairs.length < 4) return null;
    var M = [];
    var r = [];
    for (var i = 0; i < 8; i += 1) {
      M.push([0, 0, 0, 0, 0, 0, 0, 0]);
      r.push(0);
    }
    pairs.forEach(function (p) {
      var x = p.x / scale;
      var y = p.y / scale;
      var u = p.u;
      var v = p.v;
      [[x, y, 1, 0, 0, 0, -x * u, -y * u, u],
       [0, 0, 0, x, y, 1, -x * v, -y * v, v]].forEach(function (row) {
        for (var a = 0; a < 8; a += 1) {
          for (var b = 0; b < 8; b += 1) M[a][b] += row[a] * row[b];
          r[a] += row[a] * row[8];
        }
      });
    });
    var h = solve(M, r);
    if (!h || h.some(function (value) { return !isFinite(value); })) return null;
    return {
      apply: function (x, y) {
        x /= scale;
        y /= scale;
        var d = h[6] * x + h[7] * y + 1;
        return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
      },
      // The same map in unscaled units, for CSS.
      raw: [h[0] / scale, h[1] / scale, h[2], h[3] / scale, h[4] / scale, h[5],
            h[6] / scale, h[7] / scale, 1]
    };
  }

  // The sheet's pose from the border tags in view: each seen tag pairs its four corners with
  // where they were printed. toPx turns a surface uv into a pixel of the map container.
  // Returns { quad, cells }, or null while fewer than MIN_TAGS border tags are seen.
  function sheetPose(layout, tags, toPx) {
    var byId = {};
    tags.forEach(function (tag) {
      if (Array.isArray(tag.uvCorners) && tag.uvCorners.length === 4) byId[tag.id] = tag;
    });
    var pairs = [];
    var seen = 0;
    layout.tags.forEach(function (tag) {
      var live = byId[tag.id];
      if (!live) return;
      var ok = true;
      var mine = tag.corners.map(function (corner, i) {
        var uv = live.uvCorners[i];
        if (!uv || !isFinite(uv.u) || !isFinite(uv.v)) ok = false;
        return { x: corner[0], y: corner[1], u: uv ? uv.u : 0, v: uv ? uv.v : 0 };
      });
      if (!ok) return;
      seen += 1;
      Array.prototype.push.apply(pairs, mine);
    });
    if (seen < MIN_TAGS) return null;
    var H = homography(pairs, 100);
    if (!H) return null;
    function toScreen(x, y) {
      var uv = H.apply(x, y);
      var px = toPx(uv[0], uv[1]);
      return [px.x, px.y];
    }
    var I = layout.interiorMm;
    // Every cell, seen or not, so a tag the camera has lost is still kept dark.
    var half = (layout.cellMm || layout.borderMm) / 2;
    return {
      quad: [toScreen(I[0], I[1]), toScreen(I[2], I[1]), toScreen(I[2], I[3]), toScreen(I[0], I[3])],
      cells: layout.tags.map(function (tag) {
        return [toScreen(tag.cx - half, tag.cy - half), toScreen(tag.cx + half, tag.cy - half),
                toScreen(tag.cx + half, tag.cy + half), toScreen(tag.cx - half, tag.cy + half)];
      })
    };
  }

  // The CSS transform that takes a w x h rectangle onto a quad.
  function matrix3d(w, h, quad) {
    var H = homography([
      { x: 0, y: 0, u: quad[0][0], v: quad[0][1] },
      { x: w, y: 0, u: quad[1][0], v: quad[1][1] },
      { x: w, y: h, u: quad[2][0], v: quad[2][1] },
      { x: 0, y: h, u: quad[3][0], v: quad[3][1] }
    ], w);
    if (!H) return '';
    var m = H.raw;
    return 'matrix3d(' + [m[0], m[3], 0, m[6], m[1], m[4], 0, m[7], 0, 0, 1, 0, m[2], m[5], 0, 1]
      .map(function (value) { return Number(value.toFixed(8)); }).join(',') + ')';
  }

  function moved(old, fresh, byPx) {
    if (!old) return true;
    return fresh.some(function (point, i) {
      return Math.hypot(point[0] - old[i][0], point[1] - old[i][1]) >= byPx;
    });
  }

  function blend(old, fresh) {
    if (!old) return fresh;
    return fresh.map(function (point, i) {
      return [old[i][0] + (point[0] - old[i][0]) * SMOOTH,
              old[i][1] + (point[1] - old[i][1]) * SMOOTH];
    });
  }

  function createStreetViewScreen(options) {
    var insetEl = options.insetEl;
    var containerEl = options.containerEl;
    var onModeChange = options.onModeChange;

    var layout = null;
    var quad = null; // the sheet's inside, four container pixels
    var cellQuads = null; // one four-point quad per tag cell
    var lastSeen = 0;
    var active = false;
    var appliedTransform = '';

    // Shown in the sheet while there is no street view to show in it.
    var noteEl = document.createElement('div');
    noteEl.className = 'street-screen-note';
    noteEl.hidden = true;
    noteEl.textContent = 'Place the street view pointer on the map';
    containerEl.appendChild(noteEl);

    // The tag cells stand into the inside, so the view would land on them; these black
    // polygons above it keep every printed tag dark for the camera under the projector.
    var cellsEl = document.createElementNS(SVG_NS, 'svg');
    cellsEl.setAttribute('class', 'street-screen-cells');
    cellsEl.setAttribute('aria-hidden', 'true');
    cellsEl.style.display = 'none';
    containerEl.appendChild(cellsEl);

    fetch('/api/street-screen/frame', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        // Not ok just means no screen is set up on the Marker Setting page.
        if (data && data.ok && Array.isArray(data.tags) && data.tags.length >= MIN_TAGS) layout = data;
      })
      .catch(function () {});

    function viewHeight() {
      var I = layout.interiorMm;
      return Math.round(VIEW_W * (I[3] - I[1]) / (I[2] - I[0]));
    }

    function setActive(next) {
      if (next === active) return;
      active = next;
      insetEl.classList.toggle('on-screen', active);
      if (!active) {
        insetEl.style.transform = '';
        insetEl.style.width = '';
        insetEl.style.height = '';
        appliedTransform = '';
        noteEl.hidden = true;
        cellsEl.style.display = 'none';
      } else {
        insetEl.style.width = VIEW_W + 'px';
        insetEl.style.height = viewHeight() + 'px';
        noteEl.style.width = VIEW_W + 'px';
        noteEl.style.height = viewHeight() + 'px';
        cellsEl.style.display = '';
      }
      // The panorama measured its host when it was built; the host just changed size.
      onModeChange(active);
    }

    function render() {
      var transform = matrix3d(VIEW_W, viewHeight(), quad);
      if (transform && transform !== appliedTransform) {
        appliedTransform = transform;
        insetEl.style.transform = transform;
        noteEl.style.transform = transform;
      }
      noteEl.hidden = insetEl.classList.contains('visible');
      var nodes = cellsEl.querySelectorAll('polygon');
      (cellQuads || []).forEach(function (cell, i) {
        var node = nodes[i];
        if (!node) {
          node = document.createElementNS(SVG_NS, 'polygon');
          cellsEl.appendChild(node);
        }
        node.setAttribute('points', cell.map(function (p) {
          return p[0].toFixed(1) + ',' + p[1].toFixed(1);
        }).join(' '));
      });
    }

    // Called every frame with every tag the camera sees; toPx maps surface uv to container px.
    function update(tags, toPx, nowMs) {
      if (!layout) return;
      var pose = sheetPose(layout, tags, toPx);
      if (pose) {
        if (moved(quad, pose.quad, STILL_PX)) {
          quad = blend(quad, pose.quad);
          cellQuads = pose.cells.map(function (cell, i) {
            return blend(cellQuads ? cellQuads[i] : null, cell);
          });
        }
        lastSeen = nowMs;
      }
      if (!quad || (nowMs - lastSeen) >= HOLD_MS) {
        quad = null;
        cellQuads = null;
        setActive(false);
        return;
      }
      setActive(true);
      render();
    }

    // The quads are in container pixels, so a resize drops them and the next frame refits.
    window.addEventListener('resize', function () {
      quad = null;
      cellQuads = null;
    });

    return {
      update: update,
      isActive: function () { return active; }
    };
  }

  window.CompactStreetViewScreen = { createStreetViewScreen: createStreetViewScreen };
})();
