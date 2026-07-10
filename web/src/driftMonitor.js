(function () {
  // Periodically checks whether the calibrated projection surface has drifted
  // (camera or table moved). Every `checkIntervalMs` it briefly projects ONE
  // reference corner tag (the top-left, id 25), reads where the camera now sees
  // it, and compares to the stored surface corner. If it moved more than
  // `driftThresholdPx`, it re-projects all four corner tags and lets the backend
  // re-detect (auto-corners) before freezing the calibration again.
  function createDriftMonitor(options) {
    options = options || {};
    var checkIntervalMs = options.checkIntervalMs || 20000;  // 20s between checks
    var pollMs = options.pollMs || 80;                       // how often we re-read /api/tags
    var maxDetectMs = options.maxDetectMs || 2500;           // give up if not seen by here
    var driftThresholdPx = options.driftThresholdPx || 40;   // camera-frame px
    var recalHoldMs = options.recalHoldMs || 2500;           // 4-tag relock window
    var tagBase = options.tagBase || '/apriltags/tag36h11_';
    var REF_TAG_ID = 25;   // top-left corner tag
    var REF_SLOT = 0;      // surface_corners[0] = TL

    var TAG_SIZE = '16vmin';
    var TAG_PULL = '0px'; // keep the full white quiet-zone on-screen
    var OUTER_CORNER_SCALE = 10 / 8; // 10x10 SVG, 8x8 detected black square

    var enabled = false;
    var checkTimer = 0;
    var busy = false;

    // --- overlay: 4 corner tags, hidden until needed ---
    var overlay = document.createElement('div');
    overlay.id = 'driftTagOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none;display:none;';

    function makeTag(id, posCss) {
      var img = document.createElement('img');
      img.src = tagBase + id + '.svg';
      img.alt = '';
      img.style.cssText = 'position:fixed;width:' + TAG_SIZE + ';height:' + TAG_SIZE
        + ';background:#fff;image-rendering:pixelated;' + posCss;
      overlay.appendChild(img);
      return img;
    }
    var tagTL = makeTag(25, 'top:' + TAG_PULL + ';left:' + TAG_PULL + ';');
    var tagTR = makeTag(26, 'top:' + TAG_PULL + ';right:' + TAG_PULL + ';');
    var tagBR = makeTag(27, 'bottom:' + TAG_PULL + ';right:' + TAG_PULL + ';');
    var tagBL = makeTag(28, 'bottom:' + TAG_PULL + ';left:' + TAG_PULL + ';');
    if (document.body) document.body.appendChild(overlay);
    else window.addEventListener('DOMContentLoaded', function () { document.body.appendChild(overlay); });

    function showTags(which) {
      tagTL.style.display = '';
      var four = (which === 'four');
      tagTR.style.display = four ? '' : 'none';
      tagBR.style.display = four ? '' : 'none';
      tagBL.style.display = four ? '' : 'none';
      overlay.style.display = 'block';
    }
    function hideTags() { overlay.style.display = 'none'; }

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function getTags() {
      return fetch('/api/tags', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .catch(function () { return null; });
    }

    function setAutoCorners(on) {
      return fetch('/api/auto-corners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !!on })
      }).catch(function () {});
    }

    function centroidOf(corners) {
      var sx = 0, sy = 0, n = 0;
      for (var i = 0; i < corners.length; i++) {
        var c = corners[i];
        if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) { sx += c.x; sy += c.y; n++; }
      }
      return n ? { x: sx / n, y: sy / n } : null;
    }

    // The reference tag's surface corner is its corner farthest from the
    // surface centre — same rule the backend uses, so it's orientation-proof.
    function outerCorner(tagCorners, center) {
      // Detector corners are on the black square; expand to the full SVG corner.
      var best = null, bestD = -1;
      var sx = 0, sy = 0, n = 0;
      for (var i = 0; i < tagCorners.length; i++) {
        var p = tagCorners[i];
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        sx += p.x;
        sy += p.y;
        n++;
        var d = Math.hypot(p.x - center.x, p.y - center.y);
        if (d > bestD) { bestD = d; best = p; }
      }
      if (!best || !n) return best;
      var cx = sx / n;
      var cy = sy / n;
      return {
        x: cx + (best.x - cx) * OUTER_CORNER_SCALE,
        y: cy + (best.y - cy) * OUTER_CORNER_SCALE
      };
    }

    function findTag(tags, id) {
      if (!Array.isArray(tags)) return null;
      for (var i = 0; i < tags.length; i++) {
        if (Number(tags[i].id) === id) return tags[i];
      }
      return null;
    }

    async function runCheck() {
      if (!enabled || busy) return;
      busy = true;
      try {
        var data = await getTags();
        if (!data || !Array.isArray(data.corners)) return;
        var stored = data.corners;
        var refStored = stored[REF_SLOT];
        if (!refStored) return;            // not calibrated yet — nothing to compare
        var center = centroidOf(stored);
        if (!center) return;

        // Show the single reference tag and keep it up until the camera
        // actually detects it (detection latency varies), then hide it the
        // instant we have a reading. Give up after maxDetectMs if it's never
        // seen (e.g. occluded) so we don't leave it on screen.
        showTags('one');
        var detected = null;
        var deadline = Date.now() + maxDetectMs;
        while (Date.now() < deadline) {
          await sleep(pollMs);
          var snap = await getTags();
          if (snap) {
            var rt = findTag(snap.tags, REF_TAG_ID);
            if (rt && Array.isArray(rt.corners)) {
              var oc = outerCorner(rt.corners, center);
              if (oc) { detected = oc; break; }   // got it — stop showing immediately
            }
          }
        }
        hideTags();

        if (!detected) return;             // never caught it this cycle — skip
        var drift = Math.hypot(detected.x - refStored.x, detected.y - refStored.y);
        if (drift > driftThresholdPx) {
          await recalibrate();
        }
      } finally {
        busy = false;
      }
    }

    async function recalibrate() {
      await setAutoCorners(true);          // let the backend fill corners from tags
      showTags('four');
      await sleep(recalHoldMs);            // give the detector a few cycles to lock all 4
      hideTags();
      await setAutoCorners(false);         // freeze again for the next check
    }

    function start() {
      if (enabled) return;
      enabled = true;
      setAutoCorners(false);               // freeze the baseline we compare against
      checkTimer = window.setInterval(runCheck, checkIntervalMs);
    }
    function stop() {
      enabled = false;
      if (checkTimer) { window.clearInterval(checkTimer); checkTimer = 0; }
      hideTags();
    }

    return {
      start: start,
      stop: stop,
      checkNow: runCheck,        // manual trigger for testing
      recalibrate: recalibrate,
      isEnabled: function () { return enabled; }
    };
  }

  window.CompactDriftMonitor = { createDriftMonitor: createDriftMonitor };
})();
