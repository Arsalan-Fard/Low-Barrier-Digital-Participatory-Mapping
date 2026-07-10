// Shared tiny helpers — the home for genuinely-reusable utilities so they aren't
// re-pasted per module. Load this BEFORE modules that use window.CompactUtil.
// (Most "duplication" across the placement modules turned out to be parsePoint,
//  which is domain-specific per module and intentionally NOT shared here.)
(function () {
  function clamp(value, min, max) {
    value = Number(value);
    if (!isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }
  function clamp01(value) { return clamp(value, 0, 1); }
  function mix(a, b, t) { return Number(a) + ((Number(b) - Number(a)) * Number(t)); }
  function distanceSq(a, b) {
    if (!a || !b) return Infinity;
    var dx = Number(a.x) - Number(b.x);
    var dy = Number(a.y) - Number(b.y);
    return (dx * dx) + (dy * dy);
  }
  window.CompactUtil = { clamp: clamp, clamp01: clamp01, mix: mix, distanceSq: distanceSq };
})();
