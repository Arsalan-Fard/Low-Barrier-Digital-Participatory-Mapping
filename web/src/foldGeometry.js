// Fold-pen hinge geometry on a tag's four detected corners, in any px/uv space.
(function () {
  // Per edge: tag-local index, midpoint (mx, my), unit tangent (tx, ty) and outward normal (nx, ny).
  function tagEdges(corners) {
    var cx = 0;
    var cy = 0;
    for (var k = 0; k < corners.length; k++) {
      cx += corners[k].x;
      cy += corners[k].y;
    }
    cx /= corners.length;
    cy /= corners.length;
    var edges = [];
    for (var i = 0; i < 4; i++) {
      var a = corners[i];
      var b = corners[(i + 1) % 4];
      var vx = b.x - a.x;
      var vy = b.y - a.y;
      var len = Math.hypot(vx, vy);
      if (len < 1e-6) continue;
      var tx = vx / len;
      var ty = vy / len;
      var mx = (a.x + b.x) / 2;
      var my = (a.y + b.y) / 2;
      var nx = -ty;
      var ny = tx;
      if (nx * (mx - cx) + ny * (my - cy) < 0) {
        nx = -nx;
        ny = -ny;
      }
      edges.push({ index: i, mx: mx, my: my, tx: tx, ty: ty, nx: nx, ny: ny });
    }
    return edges;
  }

  function meanSide(corners) {
    var sum = 0;
    for (var i = 0; i < 4; i++) {
      var a = corners[i];
      var b = corners[(i + 1) % 4];
      sum += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return sum / 4;
  }

  // The closest mutually-facing edge pair is the hinge; the angle between their tangents is the fold.
  function hinge(edgesA, edgesB) {
    var best = null;
    var bestFacing = null;
    for (var i = 0; i < edgesA.length; i++) {
      for (var j = 0; j < edgesB.length; j++) {
        var ea = edgesA[i];
        var eb = edgesB[j];
        var dx = eb.mx - ea.mx;
        var dy = eb.my - ea.my;
        var gap = Math.hypot(dx, dy);
        var face = 1;
        if (gap > 1e-6) {
          var ux = dx / gap;
          var uy = dy / gap;
          face = Math.min(ea.nx * ux + ea.ny * uy, eb.nx * (-ux) + eb.ny * (-uy));
        }
        var dot = Math.min(1, Math.max(0, Math.abs(ea.tx * eb.tx + ea.ty * eb.ty)));
        var angle = Math.acos(dot) * 180 / Math.PI;
        var cand = { gap: gap, angle: angle, ea: ea, eb: eb };
        if (!best || gap < best.gap) best = cand;
        if (face > 0.05 && (!bestFacing || gap < bestFacing.gap)) bestFacing = cand;
      }
    }
    return bestFacing || best;
  }

  function fixedEdge(edges, index) {
    for (var i = 0; i < edges.length; i++) {
      if (edges[i].index === index) return edges[i];
    }
    return null;
  }

  function edgeOffset(edge, offsetPx) {
    return { x: edge.mx + edge.nx * offsetPx, y: edge.my + edge.ny * offsetPx };
  }

  window.CompactFoldGeometry = { tagEdges: tagEdges, meanSide: meanSide, hinge: hinge, fixedEdge: fixedEdge, edgeOffset: edgeOffset };
})();
