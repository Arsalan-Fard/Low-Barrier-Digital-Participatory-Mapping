// Shared fold-pen hinge geometry (compare.py port). Pure functions on a tag's 4
// detected corners (in whatever px/uv space the caller works in). Used by the
// main map page (src/script.js) AND the expos so the math lives in ONE place.
//   tagEdges(corners)        -> [{index, mx, my, tx, ty, nx, ny}]  (mid, tangent, outward normal)
//   meanSide(corners)        -> mean edge length
//   hinge(edgesA, edgesB)    -> {gap, angle, ea, eb}  (closest mutually-facing edge pair; angle = fold)
//   fixedEdge(edges, index)  -> the edge with that tag-local index
//   edgeOffset(edge, offPx)  -> edge centre pushed out along its normal
(function () {
  function tagEdges(corners) {
    var cx = 0, cy = 0;
    for (var k = 0; k < corners.length; k++) { cx += corners[k].x; cy += corners[k].y; }
    cx /= corners.length; cy /= corners.length;
    var edges = [];
    for (var i = 0; i < 4; i++) {
      var a = corners[i], b = corners[(i + 1) % 4];
      var vx = b.x - a.x, vy = b.y - a.y;
      var len = Math.hypot(vx, vy);
      if (len < 1e-6) continue;
      var tx = vx / len, ty = vy / len;            // edge tangent
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      var nx = -ty, ny = tx;                        // outward normal (away from centroid)
      if (nx * (mx - cx) + ny * (my - cy) < 0) { nx = -nx; ny = -ny; }
      edges.push({ index: i, mx: mx, my: my, tx: tx, ty: ty, nx: nx, ny: ny });
    }
    return edges;
  }

  function meanSide(corners) {
    var s = 0;
    for (var i = 0; i < 4; i++) { var a = corners[i], b = corners[(i + 1) % 4]; s += Math.hypot(b.x - a.x, b.y - a.y); }
    return s / 4;
  }

  // Closest mutually-facing edge pair = the hinge; angle between tangents = fold angle.
  function hinge(edgesA, edgesB) {
    var best = null, bestFacing = null;
    for (var i = 0; i < edgesA.length; i++) for (var j = 0; j < edgesB.length; j++) {
      var ea = edgesA[i], eb = edgesB[j];
      var dx = eb.mx - ea.mx, dy = eb.my - ea.my, gap = Math.hypot(dx, dy);
      var face = 1;
      if (gap > 1e-6) {
        var ux = dx / gap, uy = dy / gap;
        face = Math.min(ea.nx * ux + ea.ny * uy, eb.nx * (-ux) + eb.ny * (-uy));
      }
      var dot = Math.min(1, Math.max(0, Math.abs(ea.tx * eb.tx + ea.ty * eb.ty)));
      var angle = Math.acos(dot) * 180 / Math.PI;
      var cand = { gap: gap, angle: angle, ea: ea, eb: eb };
      if (!best || gap < best.gap) best = cand;
      if (face > 0.05 && (!bestFacing || gap < bestFacing.gap)) bestFacing = cand;
    }
    return bestFacing || best;
  }

  function fixedEdge(edges, index) {
    for (var i = 0; i < edges.length; i++) if (edges[i].index === index) return edges[i];
    return null;
  }

  function edgeOffset(edge, offsetPx) {
    return { x: edge.mx + edge.nx * offsetPx, y: edge.my + edge.ny * offsetPx };
  }

  window.CompactFoldGeometry = { tagEdges: tagEdges, meanSide: meanSide, hinge: hinge, fixedEdge: fixedEdge, edgeOffset: edgeOffset };
})();
