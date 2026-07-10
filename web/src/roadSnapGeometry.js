// Shared road-snapping geometry. Pure functions on [lng,lat] coords + a roads
// GeoJSON (LineString features). One home for the algorithm used by the main map
// page (src/roadSnapping.js) and the expos.
//   snapLineString(coords, roads, maxSnapDegrees) -> path: snap each vertex to the
//     nearest road within the threshold, and where consecutive vertices land on the
//     SAME road feature, follow that road between them.
//   resample(coords, step)  -> polyline resampled to ~even spacing
//   chaikin(coords, iters)  -> Chaikin corner-cutting smoothing
(function () {
  function distSq(a, b) { var dx = a[0] - b[0], dy = a[1] - b[1]; return dx * dx + dy * dy; }

  // Closest point on segment AB to P.
  function nearestOnSegment(p, a, b) {
    var abx = b[0] - a[0], aby = b[1] - a[1];
    var ab2 = abx * abx + aby * aby;
    if (ab2 === 0) return a;
    var t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / ab2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return [a[0] + t * abx, a[1] + t * aby];
  }

  // Nearest point on any road segment to a point.
  function snapPointToRoads(point, roads) {
    var bestDist = Infinity, bestPoint = point, bestFeatureIdx = -1, bestSegIdx = -1;
    for (var i = 0; i < roads.features.length; i++) {
      var coords = roads.features[i].geometry.coordinates;
      for (var j = 0; j < coords.length - 1; j++) {
        var nearest = nearestOnSegment(point, coords[j], coords[j + 1]);
        var d = distSq(point, nearest);
        if (d < bestDist) { bestDist = d; bestPoint = nearest; bestFeatureIdx = i; bestSegIdx = j; }
      }
    }
    return { point: bestPoint, dist: Math.sqrt(bestDist), featureIdx: bestFeatureIdx, segIdx: bestSegIdx };
  }

  // Path along ONE road feature between two snapped vertices.
  function roadPathBetween(roads, featureIdx, segIdxA, pointA, segIdxB, pointB) {
    var coords = roads.features[featureIdx].geometry.coordinates;
    var path = [pointA], k;
    if (segIdxA <= segIdxB) { for (k = segIdxA + 1; k <= segIdxB; k++) path.push(coords[k]); }
    else { for (k = segIdxA; k >= segIdxB + 1; k--) path.push(coords[k]); }
    path.push(pointB);
    return path;
  }

  function snapLineString(coords, roads, maxSnapDegrees) {
    if (!coords || coords.length < 2) return coords;
    var snapped = [], i;
    for (i = 0; i < coords.length; i++) {
      var result = snapPointToRoads(coords[i], roads);
      if (result.dist <= maxSnapDegrees) snapped.push(result);
      else snapped.push({ point: coords[i], featureIdx: -1, segIdx: -1, dist: result.dist });
    }
    var output = [snapped[0].point];
    for (i = 1; i < snapped.length; i++) {
      var prev = snapped[i - 1], curr = snapped[i];
      if (prev.featureIdx >= 0 && curr.featureIdx >= 0 && prev.featureIdx === curr.featureIdx) {
        var path = roadPathBetween(roads, prev.featureIdx, prev.segIdx, prev.point, curr.segIdx, curr.point);
        for (var j = 1; j < path.length; j++) output.push(path[j]);
      } else {
        output.push(curr.point);
      }
    }
    return output;
  }

  // Resample a polyline to ~even spacing so per-vertex snapping is uniform.
  function resample(coords, step) {
    if (coords.length < 2) return coords.slice();
    var out = [coords[0]], acc = 0;
    for (var i = 1; i < coords.length; i++) {
      var a = coords[i - 1], b = coords[i];
      var segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      while (acc + segLen >= step) {
        var t = (step - acc) / segLen;
        a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        out.push(a); segLen = Math.hypot(b[0] - a[0], b[1] - a[1]); acc = 0;
      }
      acc += segLen;
    }
    out.push(coords[coords.length - 1]);
    return out;
  }

  // Chaikin corner-cutting smoothing.
  function chaikin(coords, iters) {
    var pts = coords;
    for (var k = 0; k < (iters || 2); k++) {
      if (pts.length < 3) break;
      var next = [pts[0]];
      for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1];
        next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
        next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
      }
      next.push(pts[pts.length - 1]);
      pts = next;
    }
    return pts;
  }

  window.CompactRoadSnapGeometry = {
    snapLineString: snapLineString, resample: resample, chaikin: chaikin,
    snapPointToRoads: snapPointToRoads, nearestOnSegment: nearestOnSegment
  };
})();
