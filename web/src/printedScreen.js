// A printed screen: an A3 sheet with AprilTags round its border. While the camera sees the
// sheet on the table, an inset of the page is warped into the sheet's white inside. One per
// sheet, each with its own tags: the street view (/api/street-screen/frame) and each map view
// sheet (/api/map-screen/frame, with ?sheet=<key> for all but the first).
(function () {
  var MIN_TAGS = 2;          // one tag extrapolates ~20x its own size to the far corner, and jitters to match
  var HOLD_MS = 1800;        // keep the last pose this long once the sheet is lost
  var SMOOTH = 0.4;          // per-frame ease of the drawn quad toward the pose it follows
  var SETTLE_FRAMES = 8;     // once the sheet stops, this many fits are averaged into its resting pose
  var VIEW_W = 960;          // the inset's own width before it is warped onto the sheet
  // How far, on average, the sheet's tags must move (map container px) before the view follows
  // them; smaller shifts are taken as detection jitter. Camera Tuning sets it through /api/tags.
  var jitterPx = 3;

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
  // Returns { quad, centers: {tag id: [x, y]}, count }, or null while fewer than MIN_TAGS
  // border tags are seen.
  function sheetPose(layout, tags, toPx) {
    var byId = {};
    tags.forEach(function (tag) {
      if (Array.isArray(tag.uvCorners) && tag.uvCorners.length === 4) byId[tag.id] = tag;
    });
    var pairs = [];
    var centers = {};
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
      var mid = toPx((mine[0].u + mine[1].u + mine[2].u + mine[3].u) / 4,
                     (mine[0].v + mine[1].v + mine[2].v + mine[3].v) / 4);
      centers[tag.id] = [mid.x, mid.y];
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
    return {
      quad: [toScreen(I[0], I[1]), toScreen(I[2], I[1]), toScreen(I[2], I[3]), toScreen(I[0], I[3])],
      centers: centers,
      count: seen
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

  // How far the tags seen in both sets moved, on average; Infinity when none is in both.
  function meanShift(from, to) {
    var sum = 0;
    var n = 0;
    Object.keys(to).forEach(function (id) {
      var a = from[id];
      if (!a) return;
      sum += Math.hypot(to[id][0] - a[0], to[id][1] - a[1]);
      n += 1;
    });
    return n ? sum / n : Infinity;
  }

  // One SMOOTH step of the drawn quad toward the target, landing on it once within a tenth of a pixel.
  function ease(old, target) {
    if (!old) return target;
    var near = true;
    var next = target.map(function (point, i) {
      var dx = point[0] - old[i][0];
      var dy = point[1] - old[i][1];
      if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) near = false;
      return [old[i][0] + dx * SMOOTH, old[i][1] + dy * SMOOTH];
    });
    return near ? target : next;
  }

  // Running sums of the fits made while the sheet rests after a move.
  function startSettle(pose) {
    var settle = { n: 0, quad: [[0, 0], [0, 0], [0, 0], [0, 0]], centers: {} };
    addToSettle(settle, pose);
    return settle;
  }

  function addToSettle(settle, pose) {
    settle.n += 1;
    pose.quad.forEach(function (point, i) {
      settle.quad[i][0] += point[0];
      settle.quad[i][1] += point[1];
    });
    Object.keys(pose.centers).forEach(function (id) {
      var sum = settle.centers[id] || (settle.centers[id] = [0, 0, 0]);
      sum[0] += pose.centers[id][0];
      sum[1] += pose.centers[id][1];
      sum[2] += 1;
    });
  }

  function createPrintedScreen(options) {
    var insetEl = options.insetEl;
    var containerEl = options.containerEl;
    var onModeChange = options.onModeChange;

    var layout = null;
    var quad = null;    // the sheet's inside as drawn, four container pixels
    var target = null;  // the pose the drawn quad eases toward
    var anchor = null;  // the tag centres target was fitted from; the tags must move away from these
    var anchorCount = 0;
    var settle = null;  // sums of the fits since the last move, until SETTLE_FRAMES of them
    var lastSeen = 0;
    var seenTags = 0; // of this sheet's tags, how many the last frame saw
    var active = false;
    var appliedTransform = '';

    // Shown in the sheet while there is no street view to show in it.
    var noteEl = document.createElement('div');
    noteEl.className = 'printed-screen-note';
    noteEl.hidden = true;
    noteEl.textContent = options.noteText;
    containerEl.appendChild(noteEl);

    fetch(options.frameUrl, { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        // Not ok just means this screen is not set up on the Marker Setting page.
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
      } else {
        insetEl.style.width = VIEW_W + 'px';
        insetEl.style.height = viewHeight() + 'px';
        noteEl.style.width = VIEW_W + 'px';
        noteEl.style.height = viewHeight() + 'px';
      }
      // What the inset holds measured its host when it was built; the host just changed size.
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
    }

    function forgetPose() {
      quad = null;
      target = null;
      anchor = null;
      anchorCount = 0;
      settle = null;
    }

    // A fresh fit moves the target only once the tags have moved jitterPx on average, or more of
    // them are seen than it was fitted from. After a move, the next fits are averaged into the
    // resting pose, so it does not hang on one noisy frame.
    function follow(pose) {
      var shift = anchor ? meanShift(anchor, pose.centers) : Infinity;
      if (!target || shift >= jitterPx || pose.count > anchorCount) {
        target = pose.quad;
        anchor = pose.centers;
        anchorCount = pose.count;
        settle = startSettle(pose);
        return;
      }
      if (!settle) return;
      addToSettle(settle, pose);
      if (settle.n < SETTLE_FRAMES) return;
      var n = settle.n;
      target = settle.quad.map(function (point) { return [point[0] / n, point[1] / n]; });
      anchor = {};
      Object.keys(settle.centers).forEach(function (id) {
        var sum = settle.centers[id];
        anchor[id] = [sum[0] / sum[2], sum[1] / sum[2]];
      });
      settle = null;
    }

    // Called every frame with every tag the camera sees; toPx maps surface uv to container px.
    function update(tags, toPx, nowMs) {
      if (!layout) return;
      var ids = {};
      tags.forEach(function (tag) { ids[tag.id] = true; });
      seenTags = layout.tags.filter(function (tag) { return ids[tag.id]; }).length;
      var pose = sheetPose(layout, tags, toPx);
      if (pose) {
        follow(pose);
        lastSeen = nowMs;
      }
      if (!target || (nowMs - lastSeen) >= HOLD_MS) {
        forgetPose();
        setActive(false);
        return;
      }
      quad = ease(quad, target);
      setActive(true);
      render();
    }

    // The quads are in container pixels, so a resize drops them and the next frame refits.
    window.addEventListener('resize', forgetPose);

    return {
      update: update,
      isActive: function () { return active; },
      visibleTagCount: function () { return layout ? seenTags : 0; },
      // The inset's size on the sheet, in CSS px before the warp; null until the layout is in.
      viewSize: function () { return layout ? { width: VIEW_W, height: viewHeight() } : null; },
      // The text shown while the inset is hidden; null puts the default back.
      setNote: function (text) { noteEl.textContent = text == null ? options.noteText : String(text); }
    };
  }

  window.CompactPrintedScreen = {
    createPrintedScreen: createPrintedScreen,
    // Container px the tags must move on average before every sheet's view follows; 0 follows all.
    setJitterPx: function (px) {
      var value = Number(px);
      if (isFinite(value) && value >= 0) jitterPx = value;
    }
  };
})();
