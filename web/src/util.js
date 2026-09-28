(function () {
  function distanceSq(a, b) {
    if (!a || !b) return Infinity;
    var dx = Number(a.x) - Number(b.x);
    var dy = Number(a.y) - Number(b.y);
    return (dx * dx) + (dy * dy);
  }

  window.CompactUtil = { distanceSq: distanceSq };
})();
