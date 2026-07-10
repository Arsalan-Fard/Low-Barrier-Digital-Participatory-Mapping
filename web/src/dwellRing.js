// Shared segmented dwell-ring: the rounded-square ring that fills clockwise as a
// dwell progresses. Pure drawing — the CALLER owns the canvas, the dwell timing,
// and the colour/pop, so each scene keeps its own look. Used by the expos.
//   draw(ctx, cx, cy, opts)
//     opts.seg      = { n, r, w, h, corner }
//     opts.litCount = integer 0..n  (how many segments are lit)
//     opts.colorAt  = function(i, n) -> fillStyle
//     opts.shadowAt = optional function(i, n) -> { color, blur }
//     opts.scaleAt  = optional function(i) -> scale   (per-segment "pop")
(function () {
  function roundedRect(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === "function") { ctx.roundRect(x, y, w, h, r); return; }
    var rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y); ctx.lineTo(x + w - rr, y); ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr); ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr); ctx.quadraticCurveTo(x, y, x + rr, y);
  }

  function draw(ctx, cx, cy, opts) {
    var seg = opts.seg, lit = opts.litCount, colorAt = opts.colorAt;
    var shadowAt = opts.shadowAt || null, scaleAt = opts.scaleAt || null;
    var TAU = Math.PI * 2;
    for (var i = 0; i < lit; i++) {
      var a = -Math.PI / 2 + (i / seg.n) * TAU;
      ctx.save();
      ctx.translate(cx + Math.cos(a) * seg.r, cy + Math.sin(a) * seg.r);
      ctx.rotate(a + Math.PI / 2);
      if (scaleAt) { var s = scaleAt(i); ctx.scale(s, s); }
      ctx.fillStyle = colorAt(i, seg.n);
      if (shadowAt) { var sh = shadowAt(i, seg.n); ctx.shadowColor = sh.color; ctx.shadowBlur = sh.blur; }
      ctx.beginPath();
      roundedRect(ctx, -seg.w / 2, -seg.h / 2, seg.w, seg.h, seg.corner);
      ctx.fill();
      ctx.restore();
    }
  }

  window.CompactDwellRing = { draw: draw, roundedRect: roundedRect };
})();
