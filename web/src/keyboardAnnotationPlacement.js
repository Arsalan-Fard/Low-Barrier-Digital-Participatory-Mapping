(function () {
  // Base geometry of the callout. The factory derives the live (scaled) values
  // from these via an optional `scale` option, so /map keeps scale=1 unchanged
  // while the expo can grow/shrink the whole card at runtime (setScale).
  var BASE_CALLOUT_WIDTH = 330;
  var BASE_CALLOUT_HEIGHT = 165;
  var CALLOUT_GAP = 14;
  var BASE_TRIANGLE_WIDTH = 22;
  var BASE_TRIANGLE_HEIGHT = 16;
  var BASE_TRIANGLE_TIP_OFFSET = 2;
  var BASE_LINE_INSET = 24;        // comment-line left/right padding
  var BASE_LINE_LOWER_INSET = 14;  // extra inset for lines that clear the tag
  var BASE_LINE_GAP = 18;          // vertical gap between comment lines
  var BASE_LINE_TOP = 30;          // first comment line below the box top
  var BASE_FONT_PX = 16;           // typed-comment font size
  var BASE_TAG_LEFT_OFFSET_CM = 2.5;   // callout shifted left of the tag (cm)
  var BASE_TAG_BOTTOM_OFFSET_CM = 0.4; // callout bottom below the tag (cm)
  var TYPING_PULSE_MS = 920;
  var TYPING_PULSE_WIDTH = 0.12;

  function createKeyboardAnnotationPlacement(options) {
    options = options || {};
    var containerEl = options.containerEl;
    var lostHoldMs = Number(options.lostHoldMs || 500);
    var dwellMs = Number(options.dwellMs || 2000);
    var formStartMs = Number(options.formStartMs || 500);
    var formDurationMs = Math.max(1, dwellMs - formStartMs);
    var moveThresholdPx = Number(options.moveThresholdPx || 28);
    var tagSizeCm = Number(options.tagSizeCm || 3);
    var unprojectPxToLngLat = typeof options.unprojectPxToLngLat === 'function'
      ? options.unprojectPxToLngLat
      : function () { return null; };

    // Adjustable metrics (all default to the original look, so /map is unchanged):
    //   widthScale / heightScale  - the callout box, scaled per axis (independent)
    //   triWidthScale / triHeightScale - the connector triangle, per axis
    //   leftOffsetCm / bottomOffsetCm  - where the callout sits relative to the tag (cm)
    // `scale` is still accepted as a uniform shortcut for width+height.
    var uni = (Number(options.scale) > 0) ? Number(options.scale) : 1;
    var scaleX = (Number(options.widthScale) > 0) ? Number(options.widthScale) : uni;
    var scaleY = (Number(options.heightScale) > 0) ? Number(options.heightScale) : uni;
    var triWidthMul = (Number(options.triangleWidthScale) > 0) ? Number(options.triangleWidthScale) : 1;
    var triHeightMul = (Number(options.triangleHeightScale) > 0) ? Number(options.triangleHeightScale) : 1;
    var leftOffsetCm = Number.isFinite(Number(options.leftOffsetCm)) ? Number(options.leftOffsetCm) : BASE_TAG_LEFT_OFFSET_CM;
    var bottomOffsetCm = Number.isFinite(Number(options.bottomOffsetCm)) ? Number(options.bottomOffsetCm) : BASE_TAG_BOTTOM_OFFSET_CM;
    // flipVertical (default ON): the callout body hangs BELOW the anchor and the
    // connector triangle sits on the box top, pointing UP at the anchor — the hosts
    // anchor the annotation tag at its far edge, so the triangle points at the tag's
    // effective (red) point and the box overlays the physical card beneath it.
    // Pass/setMetrics flipVertical:false for the classic box-above/tip-down layout.
    var flipVertical = options.flipVertical !== false;
    // flipHorizontal (default ON) mirrors the box about the anchor's vertical axis,
    // so the text field opens to the RIGHT of the tag. The triangle stays at the anchor.
    var flipHorizontal = options.flipHorizontal !== false;
    // Detected tag angles jitter; hold the displayed rotation until the raw angle
    // moves more than this many degrees away from it.
    var rotationThresholdDeg = Number.isFinite(Number(options.rotationThresholdDeg))
      ? Number(options.rotationThresholdDeg) : 5;
    // Detected tag positions jitter too; the drawn anchor is frozen while the raw
    // point stays inside this radius, and dragged along smoothly once it escapes.
    var moveDeadbandPx = Number.isFinite(Number(options.moveDeadbandPx))
      ? Number(options.moveDeadbandPx) : 6;
    var CALLOUT_WIDTH, CALLOUT_HEIGHT, TRIANGLE_WIDTH, TRIANGLE_HEIGHT, TRIANGLE_TIP_OFFSET;
    var LINE_INSET, LINE_LOWER_INSET, LINE_GAP, LINE_TOP, FONT_PX;
    function applyScale() {
      CALLOUT_WIDTH = BASE_CALLOUT_WIDTH * scaleX;
      CALLOUT_HEIGHT = BASE_CALLOUT_HEIGHT * scaleY;
      TRIANGLE_WIDTH = BASE_TRIANGLE_WIDTH * triWidthMul;       // triangle sized independently of the box
      TRIANGLE_HEIGHT = BASE_TRIANGLE_HEIGHT * triHeightMul;
      TRIANGLE_TIP_OFFSET = BASE_TRIANGLE_TIP_OFFSET;
      LINE_INSET = BASE_LINE_INSET * scaleX;                    // horizontal metrics follow width
      LINE_LOWER_INSET = BASE_LINE_LOWER_INSET * scaleX;
      LINE_GAP = BASE_LINE_GAP * scaleY;                        // vertical metrics follow height
      LINE_TOP = BASE_LINE_TOP * scaleY;
      FONT_PX = BASE_FONT_PX * Math.min(scaleX, scaleY);        // keep text inside the box
    }
    applyScale();

    var enabled = false;
    var rootEl = null;
    var canvasEl = null;
    var canvasCtx = null;
    var svgEl = null;
    var htmlLayerEl = null;
    var currentStep = 0;
    var visibleSteps = null;
    var activeItems = [];
    var lastSeenMs = 0;
    var runtimeByKey = {};
    var textByKey = {};
    var collapsedNotes = [];
    var animationFrame = 0;
    var canvasWidth = 0;
    var canvasHeight = 0;
    var canvasDpr = 1;

    function clamp01(value) {
      value = Number(value);
      if (!Number.isFinite(value)) return 0;
      if (value < 0) return 0;
      if (value > 1) return 1;
      return value;
    }

    function clamp(value, min, max) {
      value = Number(value);
      if (!Number.isFinite(value)) return min;
      return Math.max(min, Math.min(max, value));
    }

    function distanceSq(a, b) {
      if (!a || !b) return Infinity;
      var dx = Number(a.x) - Number(b.x);
      var dy = Number(a.y) - Number(b.y);
      return (dx * dx) + (dy * dy);
    }

    function mix(a, b, t) {
      return Number(a) + ((Number(b) - Number(a)) * Number(t));
    }

    function lineLength(a, b) {
      var dx = Number(b.x) - Number(a.x);
      var dy = Number(b.y) - Number(a.y);
      return Math.sqrt((dx * dx) + (dy * dy));
    }

    function isVisibleStep(step) {
      if (!visibleSteps) return true;
      return visibleSteps.has(Number(step) || 0);
    }

    function ensureDom() {
      if (rootEl || !containerEl) return;
      rootEl = document.createElement('div');
      rootEl.className = 'keyboard-annotation-overlay hidden';

      canvasEl = document.createElement('canvas');
      canvasEl.className = 'keyboard-annotation-canvas';
      canvasCtx = canvasEl.getContext('2d');
      rootEl.appendChild(canvasEl);

      svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svgEl.setAttribute('class', 'keyboard-annotation-svg');
      rootEl.appendChild(svgEl);

      htmlLayerEl = document.createElement('div');
      htmlLayerEl.className = 'keyboard-annotation-html';
      rootEl.appendChild(htmlLayerEl);

      containerEl.appendChild(rootEl);
    }

    function resizeCanvas() {
      if (!canvasEl || !canvasCtx || !containerEl) return false;
      var rect = containerEl.getBoundingClientRect();
      var width = Math.max(1, Math.round(rect.width || containerEl.clientWidth || 1));
      var height = Math.max(1, Math.round(rect.height || containerEl.clientHeight || 1));
      var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      if (width === canvasWidth && height === canvasHeight && dpr === canvasDpr) return false;
      canvasWidth = width;
      canvasHeight = height;
      canvasDpr = dpr;
      canvasEl.style.width = width + 'px';
      canvasEl.style.height = height + 'px';
      canvasEl.width = Math.ceil(width * dpr);
      canvasEl.height = Math.ceil(height * dpr);
      canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return true;
    }

    function clearCanvas() {
      if (!canvasCtx) return;
      resizeCanvas();
      canvasCtx.clearRect(0, 0, canvasWidth, canvasHeight);
    }

    function mixRgb(a, b, t) {
      t = clamp01(t);
      return {
        r: Math.round(mix(a.r, b.r, t)),
        g: Math.round(mix(a.g, b.g, t)),
        b: Math.round(mix(a.b, b.b, t))
      };
    }

    function rgbaRgb(rgb, alpha) {
      return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + clamp(alpha, 0, 1) + ')';
    }

    function particleColor(role, index, count) {
      var darkBlue = { r: 5, g: 31, b: 58 };
      var blue = { r: 8, g: 90, b: 150 };
      var cyan = { r: 45, g: 212, b: 255 };
      var t = count ? index / Math.max(1, count - 1) : 0;
      var wave = 0.5 + (0.5 * Math.sin((t * Math.PI * 2.7) + (index * 0.41)));
      var cyanBias = role === 'connector' ? 0.22 : 0.28;
      var mixT = clamp01((wave * 0.58) + cyanBias);
      return mixRgb(mixRgb(darkBlue, blue, mixT), cyan, Math.max(0, mixT - 0.48) * 1.4);
    }

    function commentLineColor(index, progress) {
      var darkBlue = { r: 5, g: 31, b: 58 };
      var cyan = { r: 45, g: 212, b: 255 };
      return mixRgb(darkBlue, cyan, clamp01(0.16 + (index * 0.06) + (progress * 0.2)));
    }

    function parsePoint(raw) {
      if (!raw) return null;
      var x = Number(raw.x);
      var y = Number(raw.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      var lng = Number(raw.lng);
      var lat = Number(raw.lat);
      var angleDeg = Number(raw.angleDeg);
      var tagSizePx = Number(raw.tagSizePx);
      var rawTagSizeCm = Number(raw.tagSizeCm);
      return {
        x: x,
        y: y,
        lng: Number.isFinite(lng) ? lng : null,
        lat: Number.isFinite(lat) ? lat : null,
        angleDeg: Number.isFinite(angleDeg) ? angleDeg : 0,
        tagSizePx: Number.isFinite(tagSizePx) && tagSizePx > 0 ? tagSizePx : 0,
        tagSizeCm: Number.isFinite(rawTagSizeCm) && rawTagSizeCm > 0 ? rawTagSizeCm : tagSizeCm
      };
    }

    function pointLngLat(point) {
      if (!point) return null;
      if (Number.isFinite(point.lng) && Number.isFinite(point.lat)) {
        return [Number(point.lng), Number(point.lat)];
      }
      var ll = unprojectPxToLngLat(point.x, point.y);
      if (!Array.isArray(ll) || ll.length < 2) return null;
      if (!Number.isFinite(Number(ll[0])) || !Number.isFinite(Number(ll[1]))) return null;
      return [Number(ll[0]), Number(ll[1])];
    }

    function normalizeItem(raw) {
      if (!raw || typeof raw !== 'object') return null;
      var annotation = parsePoint(raw.annotation);
      var keyboard = parsePoint(raw.keyboard);
      if (!annotation || !keyboard) return null;
      return {
        key: String(raw.key || 'keyboard-annotation'),
        label: String(raw.label || 'Keyboard Annotation'),
        color: String(raw.color || '#082f49'),
        annotation: annotation,
        keyboard: keyboard,
        text: String(textByKey[String(raw.key || 'keyboard-annotation')] || ''),
        step: Number(currentStep) || 0
      };
    }

    function cmToPx(point, cm) {
      var sizePx = Number(point && point.tagSizePx);
      var sizeCm = Number(point && point.tagSizeCm) || tagSizeCm;
      if (Number.isFinite(sizePx) && sizePx > 0 && Number.isFinite(sizeCm) && sizeCm > 0) {
        return (sizePx / sizeCm) * Number(cm || 0);
      }
      return Number(cm || 0) * 12;
    }

    // With flipVertical the callout body opens below the anchor and the triangle
    // points UP; otherwise (default) the box sits above with the tip at the bottom.
    function annotationTagBox(item) {
      // The tag body sits on the anchor's far side: above it in both layouts (the
      // hosts anchor at the tag's lower/far edge, or its bottom-centre classically).
      var size = Math.max(18, Number(item.annotation.tagSizePx) || 0);
      var y = Number(item.annotation.y);
      return {
        left: Number(item.annotation.x) - (size / 2),
        right: Number(item.annotation.x) + (size / 2),
        top: y - size,
        bottom: y,
        size: size
      };
    }

    function calloutBox(item) {
      var tagBox = annotationTagBox(item);
      var leftOffset = cmToPx(item.annotation, leftOffsetCm);
      var bottomOffset = cmToPx(item.annotation, bottomOffsetCm);
      var effectiveX = Number(item.annotation.x);
      var effectiveY = Number(item.annotation.y);
      var top, bottom;
      if (flipVertical) {
        top = effectiveY - bottomOffset;
        bottom = top + CALLOUT_HEIGHT;
      } else {
        bottom = effectiveY + bottomOffset;
        top = bottom - CALLOUT_HEIGHT;
      }
      var left = flipHorizontal
        ? (effectiveX + leftOffset) - CALLOUT_WIDTH   // mirrored: box opens to the right
        : effectiveX - leftOffset;
      return {
        left: left,
        right: left + CALLOUT_WIDTH,
        top: top,
        bottom: bottom,
        centerX: left + (CALLOUT_WIDTH / 2),
        triangleX: effectiveX,
        tagBox: tagBox,
        leftOffsetPx: leftOffset,
        bottomOffsetPx: bottomOffset
      };
    }

    function trianglePoints(item) {
      var box = calloutBox(item);
      var baseY = flipVertical ? box.top : box.bottom;
      var tipY = flipVertical
        ? box.top - TRIANGLE_HEIGHT - TRIANGLE_TIP_OFFSET
        : box.bottom + TRIANGLE_HEIGHT + TRIANGLE_TIP_OFFSET;
      return {
        left: { x: box.triangleX - (TRIANGLE_WIDTH / 2), y: baseY },
        right: { x: box.triangleX + (TRIANGLE_WIDTH / 2), y: baseY },
        tip: { x: box.triangleX, y: tipY }
      };
    }

    // tag rows = the comment lines that share vertical space with the tag. In the
    // flipped layout the box hangs below the anchor while the tag sits above it, so
    // the tag never overlaps the text and no rows are shortened.
    function isTagRow(index, lineCount) {
      if (flipVertical) return false;
      var count = Number(lineCount || 7);
      return index >= Math.max(0, count - 4);
    }

    function rectPerimeterPoint(item, t) {
      var box = calloutBox(item);
      var w = CALLOUT_WIDTH;
      var h = CALLOUT_HEIGHT;
      var startX = clamp(box.triangleX, box.left, box.right);
      var triY = flipVertical ? box.top : box.bottom;      // edge carrying the triangle
      var farY = flipVertical ? box.bottom : box.top;
      var toFar = flipVertical ? 1 : -1;
      var firstRun = box.right - startX;
      var backRun = startX - box.left;
      var perimeter = firstRun + h + w + h + backRun;
      var d = ((t % 1) + 1) % 1;
      var distance = d * perimeter;
      if (distance < firstRun) return { x: startX + distance, y: triY };
      if (distance < firstRun + h) return { x: box.right, y: triY + (toFar * (distance - firstRun)) };
      if (distance < firstRun + h + w) return { x: box.right - (distance - firstRun - h), y: farY };
      if (distance < firstRun + h + w + h) return { x: box.left, y: farY - (toFar * (distance - firstRun - h - w)) };
      return { x: box.left + (distance - firstRun - h - w - h), y: triY };
    }

    function connectorPoint(item, t) {
      var tri = trianglePoints(item);
      return {
        x: mix(item.keyboard.x, tri.tip.x, t),
        y: mix(item.keyboard.y, tri.tip.y, t)
      };
    }

    function commentLineLayout(item, index, lineCount) {
      var box = calloutBox(item);
      var tagBox = annotationTagBox(item);
      var startY = box.top + LINE_TOP;
      var gap = LINE_GAP;
      var tagRow = isTagRow(index, lineCount);
      var x1 = box.left + LINE_INSET;
      if (tagRow) {
        x1 = Math.max(x1, tagBox.right + LINE_LOWER_INSET);
      }
      return {
        x1: x1,
        x2: box.right - LINE_INSET,
        y: startY + (index * gap),
        lower: tagRow
      };
    }

    function textStartPointForItem(item) {
      var layout = commentLineLayout(item, 0, 7);
      return { x: layout.x1, y: layout.y + 4 };
    }

    function snapshotItem(item) {
      if (!item) return null;
      return {
        key: item.key,
        label: item.label,
        color: item.color,
        annotation: Object.assign({}, item.annotation),
        keyboard: Object.assign({}, item.keyboard),
        step: item.step
      };
    }

    function itemAngleRad(item) {
      var deg = Number(item && item.annotation && item.annotation.angleDeg);
      return Number.isFinite(deg) ? (deg * Math.PI / 180) : 0;
    }

    function rotateAbout(x, y, ax, ay, rad) {
      var cos = Math.cos(rad);
      var sin = Math.sin(rad);
      var dx = Number(x) - ax;
      var dy = Number(y) - ay;
      return { x: ax + (dx * cos) - (dy * sin), y: ay + (dx * sin) + (dy * cos) };
    }

    // The whole callout is drawn in a canvas frame rotated by the tag angle around the
    // annotation anchor, so the box follows the physical tag's rotation. The keyboard
    // point is counter-rotated first: after the canvas rotation it lands back on the
    // real keyboard tag, keeping the connector anchored to it.
    function itemInRotatedFrame(item, rad) {
      if (!rad) return item;
      var ax = Number(item.annotation.x);
      var ay = Number(item.annotation.y);
      var kb = rotateAbout(item.keyboard.x, item.keyboard.y, ax, ay, -rad);
      var clone = Object.assign({}, item);
      clone.keyboard = Object.assign({}, item.keyboard, { x: kb.x, y: kb.y });
      return clone;
    }

    function particleTarget(item, particle) {
      if (particle.role === 'connector') return connectorPoint(item, particle.t);
      return rectPerimeterPoint(item, particle.t);
    }

    function particleLoosePoint(item, particle, nowMs, target) {
      var t = particle.t;
      var phase = particle.phase + (nowMs * particle.speed);
      var ox = Math.cos(phase) * particle.orbit;
      var oy = Math.sin(phase * 0.83) * particle.orbitY;
      if (particle.role === 'connector') {
        var tri = trianglePoints(item);
        var dx = Number(tri.tip.x) - Number(item.keyboard.x);
        var dy = Number(tri.tip.y) - Number(item.keyboard.y);
        var len = Math.max(1, Math.sqrt((dx * dx) + (dy * dy)));
        var tx = dx / len;
        var ty = dy / len;
        var nx = -ty;
        var ny = tx;
        var wave = Math.sin(phase * 1.7);
        var travel = Math.cos(phase * 0.7);
        return {
          x: target.x + (nx * wave * particle.orbit) + (tx * travel * particle.orbit * 0.35),
          y: target.y + (ny * wave * particle.orbit) + (ty * travel * particle.orbit * 0.35)
        };
      }
      var box = calloutBox(item);
      var anchorX = mix(target.x, box.centerX, 0.28);
      var anchorY = mix(target.y, Number(box.bottom), 0.28);
      return {
        x: anchorX + ox + Math.sin(phase * 0.43 + t * 6.28) * particle.orbit * 0.45,
        y: anchorY + oy + Math.cos(phase * 0.51 + t * 6.28) * particle.orbitY * 0.35
      };
    }

    function makeParticle(role, t, index, count, item) {
      var initialU = Math.random();
      var initialV = Math.random();
      var particle = {
        role: role,
        t: t,
        u: initialU,
        v: initialV,
        x: 0,
        y: 0,
        prevX: 0,
        prevY: 0,
        phase: Math.random() * Math.PI * 2,
        speed: (0.0012 + Math.random() * 0.0026) * (index % 2 ? 1 : -1),
        orbit: role === 'connector' ? (3 + Math.random() * 7) : (7 + Math.random() * 14),
        orbitY: role === 'connector' ? (3 + Math.random() * 5) : (6 + Math.random() * 10),
        size: 2.8 + Math.random() * 1.9,
        alpha: 0.68 + Math.random() * 0.28,
        rgb: particleColor(role, index, count),
        targetIndex: count ? index / count : 0
      };
      var target = particleTarget(item, particle);
      var loose = particleLoosePoint(item, particle, Date.now(), target);
      particle.x = loose.x;
      particle.y = loose.y;
      particle.prevX = loose.x;
      particle.prevY = loose.y;
      return particle;
    }

    function createParticles(item) {
      var connectorCount = Math.round(clamp(lineLength(item.keyboard, trianglePoints(item).tip) / 14, 12, 44));
      var perimeter = (CALLOUT_WIDTH * 2) + (CALLOUT_HEIGHT * 2);
      var frameCount = Math.round(clamp(perimeter / 14, 42, 84));
      var particles = [];
      var i;
      for (i = 0; i < connectorCount; i++) {
        particles.push(makeParticle('connector', (i + 0.5) / connectorCount, i, connectorCount, item));
      }
      for (i = 0; i < frameCount; i++) {
        particles.push(makeParticle('frame', (i + 0.5) / frameCount, i, frameCount, item));
      }
      return particles;
    }

    function refreshRuntimeProgress(item, nowMs) {
      var key = String(item.key || 'keyboard-annotation');
      var runtime = runtimeByKey[key];
      if (!runtime) return item;
      var now = Number(nowMs) || Date.now();
      var dwellProgress = clamp01((now - Number(runtime.dwellStartMs || now)) / dwellMs);
      if (!runtime.settled && dwellProgress >= 1) {
        runtime.settled = true;
        runtime.formedAtMs = now;
      }
      item.dwellProgress = runtime.settled ? 1 : dwellProgress;
      item.settled = !!runtime.settled;
      item.formProgress = clamp01((now - Number(runtime.dwellStartMs || now) - formStartMs) / formDurationMs);
      item.phaseMs = now;
      return item;
    }

    function truncatePreview(text) {
      var compact = String(text || '').replace(/\s+/g, ' ').trim();
      if (compact.length <= 20) return compact;
      return compact.slice(0, 20);
    }

    function archiveCollapsedNote(item, nowMs) {
      if (!item) return;
      var text = String(textByKey[item.key] || '').trim();
      if (!text) return;
      var tip = trianglePoints(item).tip;
      var from = textStartPointForItem(item);
      var rad = itemAngleRad(item);
      if (rad) {   // match the rotated on-screen positions of the tip / first text line
        var ax = Number(item.annotation.x);
        var ay = Number(item.annotation.y);
        tip = rotateAbout(tip.x, tip.y, ax, ay, rad);
        from = rotateAbout(from.x, from.y, ax, ay, rad);
      }
      collapsedNotes = collapsedNotes.filter(function (note) {
        if (!note || note.key !== item.key) return true;
        return distanceSq(note.anchor, item.annotation) > (moveThresholdPx * moveThresholdPx);
      });
      collapsedNotes.push({
        key: item.key,
        text: text,
        preview: truncatePreview(text),
        anchor: { x: item.annotation.x, y: item.annotation.y },
        x: tip.x,
        y: tip.y,
        fromX: from.x,
        fromY: from.y,
        createdAtMs: Number(nowMs) || Date.now(),
        step: item.step
      });
      textByKey[item.key] = '';
    }

    function archiveRuntimeNote(runtime, nowMs) {
      if (!runtime) return;
      archiveCollapsedNote(runtime.collapseItem || runtime.lastItem, nowMs);
    }

    function archiveAllRuntimeNotes(nowMs) {
      Object.keys(runtimeByKey).forEach(function (key) {
        archiveRuntimeNote(runtimeByKey[key], nowMs);
      });
    }

    function restoreCollapsedNoteIfNear(item) {
      if (!item) return false;
      var thresholdSq = (moveThresholdPx * moveThresholdPx);
      for (var i = 0; i < collapsedNotes.length; i++) {
        var note = collapsedNotes[i];
        if (!note || note.key !== item.key) continue;
        if (distanceSq(note.anchor, item.annotation) > thresholdSq) continue;
        textByKey[item.key] = note.text || '';
        collapsedNotes.splice(i, 1);
        return true;
      }
      return false;
    }

    // Pull `held` toward (rawX, rawY) only as far as needed to keep it within
    // moveDeadbandPx of the raw point (hysteresis follower).
    function rubberBandPoint(held, rawX, rawY) {
      var dx = rawX - held.x;
      var dy = rawY - held.y;
      var dist = Math.sqrt((dx * dx) + (dy * dy));
      if (dist > moveDeadbandPx) {
        var pull = (dist - moveDeadbandPx) / dist;
        held.x += dx * pull;
        held.y += dy * pull;
      }
    }

    function applyRuntimeState(item, nowMs) {
      var key = String(item.key || 'keyboard-annotation');
      var now = Number(nowMs) || Date.now();
      var restoredCollapsedNote = restoreCollapsedNoteIfNear(item);
      var runtime = runtimeByKey[key];
      var moved = false;
      if (runtime && (runtime.anchorAnnotation || runtime.annotation)) {
        moved = distanceSq(runtime.anchorAnnotation || runtime.annotation, item.annotation) > (moveThresholdPx * moveThresholdPx);
      }

      if (!runtime || moved) {
        if (runtime && moved && !restoredCollapsedNote) {
          archiveRuntimeNote(runtime, now);
        }
        runtime = {
          dwellStartMs: restoredCollapsedNote ? now - dwellMs : now,
          settled: !!restoredCollapsedNote,
          formedAtMs: restoredCollapsedNote ? now : 0,
          anchorAnnotation: { x: item.annotation.x, y: item.annotation.y },
          annotation: { x: item.annotation.x, y: item.annotation.y },
          keyboard: { x: item.keyboard.x, y: item.keyboard.y },
          collapseItem: snapshotItem(item),
          particles: createParticles(item)
        };
        runtimeByKey[key] = runtime;
      } else if (!runtime.particles || !runtime.particles.length) {
        runtime.particles = createParticles(item);
      }

      // rotation dead-band: hold the shown angle until the raw one drifts past the threshold
      var rawAngle = Number(item.annotation.angleDeg) || 0;
      if (!Number.isFinite(runtime.heldAngleDeg)) {
        runtime.heldAngleDeg = rawAngle;
      } else {
        var angleDrift = ((rawAngle - runtime.heldAngleDeg + 540) % 360) - 180;
        if (Math.abs(angleDrift) > rotationThresholdDeg) runtime.heldAngleDeg = rawAngle;
      }
      item.annotation.angleDeg = runtime.heldAngleDeg;

      // position dead-band (rubber band): the held point only moves once the raw
      // point escapes the radius, and then only enough to sit on its rim — still
      // jitter-free at rest, smooth (snap-free) while genuinely moving.
      if (!runtime.heldAnnotation) runtime.heldAnnotation = { x: Number(item.annotation.x), y: Number(item.annotation.y) };
      if (!runtime.heldKeyboard) runtime.heldKeyboard = { x: Number(item.keyboard.x), y: Number(item.keyboard.y) };
      rubberBandPoint(runtime.heldAnnotation, Number(item.annotation.x), Number(item.annotation.y));
      rubberBandPoint(runtime.heldKeyboard, Number(item.keyboard.x), Number(item.keyboard.y));
      if (item.annotation.x !== runtime.heldAnnotation.x || item.annotation.y !== runtime.heldAnnotation.y) {
        item.annotation.lng = null;   // stale for the damped position; let pointLngLat unproject
        item.annotation.lat = null;
      }
      item.annotation.x = runtime.heldAnnotation.x;
      item.annotation.y = runtime.heldAnnotation.y;
      item.keyboard.x = runtime.heldKeyboard.x;
      item.keyboard.y = runtime.heldKeyboard.y;

      runtime.annotation = { x: item.annotation.x, y: item.annotation.y };
      runtime.keyboard = { x: item.keyboard.x, y: item.keyboard.y };
      runtime.lastItem = snapshotItem(item);
      return refreshRuntimeProgress(item, now);
    }

    function particleRevealProgress(item, particle) {
      if (!item || !particle) return 0;
      if (Number(item.formProgress || 0) <= 0) {
        return particle.role === 'connector' && Number(particle.t) <= 0.30
          ? 0.62 + (0.28 * Number(item.dwellProgress || 0))
          : 0;
      }

      var form = clamp01(item.formProgress);
      if (particle.role === 'connector') {
        var connectorEnd = 0.30 + (0.70 * clamp01(form / 0.48));
        return clamp01((connectorEnd - Number(particle.t)) / 0.09);
      }
      var borderEnd = clamp01((form - 0.48) / 0.52);
      return clamp01((borderEnd - Number(particle.t)) / 0.08);
    }

    function connectorTypingPulse(runtime, particle, nowMs) {
      if (!runtime || !particle || particle.role !== 'connector') return 0;
      var starts = Array.isArray(runtime.typingPulseStarts) ? runtime.typingPulseStarts : [];
      var pulse = 0;
      for (var i = 0; i < starts.length; i++) {
        var age = Number(nowMs) - Number(starts[i]);
        if (age < 0 || age > TYPING_PULSE_MS) continue;
        var progress = clamp01(age / TYPING_PULSE_MS);
        var center = -0.08 + (progress * 1.16);
        var distance = Number(particle.t) - center;
        var wave = Math.exp(-(distance * distance) / (2 * TYPING_PULSE_WIDTH * TYPING_PULSE_WIDTH));
        var envelope = Math.sin(progress * Math.PI);
        pulse = Math.max(pulse, wave * envelope);
      }
      return clamp01(pulse);
    }

    function updateParticlesForItem(item, nowMs) {
      var runtime = runtimeByKey[String(item.key || 'keyboard-annotation')];
      if (!runtime || !runtime.particles || !canvasCtx) return;
      runtime.typingPulseStarts = (Array.isArray(runtime.typingPulseStarts) ? runtime.typingPulseStarts : [])
        .filter(function (startedAt) {
          return Number(nowMs) - Number(startedAt) <= TYPING_PULSE_MS;
        });

      runtime.particles.forEach(function (particle) {
        var revealProgress = particleRevealProgress(item, particle);
        if (revealProgress <= 0) return;
        var pulse = connectorTypingPulse(runtime, particle, nowMs);
        var target = particleTarget(item, particle);
        var loose = particleLoosePoint(item, particle, nowMs, target);
        var pull = item.settled
          ? revealProgress
          : (Number(item.formProgress || 0) > 0 ? revealProgress : 0.86);
        var desired = {
          x: mix(loose.x, target.x, pull),
          y: mix(loose.y, target.y, pull)
        };
        particle.prevX = particle.x;
        particle.prevY = particle.y;
        var ease = Number(item.formProgress || 0) > 0 ? (0.10 + 0.24 * revealProgress) : 0.14;
        particle.x += (desired.x - particle.x) * ease;
        particle.y += (desired.y - particle.y) * ease;
        drawParticle(item, particle, revealProgress, pulse);
      });
    }

    function drawParticle(item, particle, roleProgress, pulseProgress) {
      if (!canvasCtx) return;
      var pulse = particle.role === 'connector' ? clamp01(pulseProgress || 0) : 0;
      var alphaBase = Number(item.formProgress || 0) > 0 ? 0.84 : 0.72;
      var alpha = alphaBase * particle.alpha * clamp01(0.45 + (0.55 * roleProgress) + (0.3 * pulse));
      var size = particle.size * mix(0.9, 1.55, roleProgress) * (1 + (1.55 * pulse));
      var rgb = particle.rgb;
      if (pulse > 0) rgb = mixRgb(rgb, { r: 90, g: 230, b: 255 }, 0.72 * pulse);
      canvasCtx.save();
      canvasCtx.translate(particle.x, particle.y);
      canvasCtx.rotate(particle.phase * 0.25);
      canvasCtx.shadowBlur = 5 + (10 * pulse);
      canvasCtx.shadowColor = rgbaRgb(rgb, alpha * (0.55 + (0.35 * pulse)));
      canvasCtx.fillStyle = rgbaRgb(rgb, alpha);
      canvasCtx.fillRect(-size / 2, -size / 2, size, size);
      canvasCtx.restore();
    }

    function drawTriangleMarker(item, nowMs) {
      if (!canvasCtx || !item) return;
      var tri = trianglePoints(item);
      var progress = clamp01(0.7 + (0.18 * Number(item.dwellProgress || 0)) + (0.12 * Number(item.formProgress || 0)));
      var pulse = 0.94 + (0.06 * Math.sin((Number(nowMs || Date.now()) / 280) + Number(item.annotation.x || 0)));
      var alpha = progress * pulse;
      canvasCtx.save();
      var gradient = canvasCtx.createLinearGradient(tri.left.x, tri.left.y, tri.tip.x, tri.tip.y);
      gradient.addColorStop(0, 'rgba(5,31,58,' + String(0.90 * alpha) + ')');
      gradient.addColorStop(0.55, 'rgba(8,90,150,' + String(0.88 * alpha) + ')');
      gradient.addColorStop(1, 'rgba(45,212,255,' + String(0.72 * alpha) + ')');
      canvasCtx.shadowBlur = 8;
      canvasCtx.shadowColor = 'rgba(5,31,58,' + String(0.42 * alpha) + ')';
      canvasCtx.fillStyle = gradient;
      canvasCtx.strokeStyle = 'rgba(45,212,255,' + String(0.75 * alpha) + ')';
      canvasCtx.lineWidth = 1.4;
      canvasCtx.beginPath();
      canvasCtx.moveTo(tri.left.x, tri.left.y);
      canvasCtx.lineTo(tri.right.x, tri.right.y);
      canvasCtx.lineTo(tri.tip.x, tri.tip.y);
      canvasCtx.closePath();
      canvasCtx.fill();
      canvasCtx.stroke();
      canvasCtx.restore();
    }

    function hashNoise(index, salt) {
      var x = Math.sin((index * 127.1) + (salt * 311.7)) * 43758.5453;
      return x - Math.floor(x);
    }

    function drawNoisyCommentBackground(item, nowMs) {
      if (!canvasCtx) return;
      var progress = clamp01((item.formProgress - 0.08) / 0.72);
      if (progress <= 0) return;
      var box = calloutBox(item);
      var noiseCount = 170;
      var phase = Math.floor(Number(nowMs || Date.now()) / 120);

      canvasCtx.save();
      canvasCtx.fillStyle = 'rgba(255,255,255,' + String(0.72 * progress) + ')';
      canvasCtx.fillRect(box.left, box.top, CALLOUT_WIDTH, CALLOUT_HEIGHT);
      canvasCtx.beginPath();
      canvasCtx.rect(box.left, box.top, CALLOUT_WIDTH, CALLOUT_HEIGHT);
      canvasCtx.clip();

      for (var i = 0; i < noiseCount; i++) {
        var x = box.left + (hashNoise(i, 1) * CALLOUT_WIDTH);
        var y = box.top + (hashNoise(i, 2) * CALLOUT_HEIGHT);
        var shimmer = hashNoise(i, phase);
        var size = 1 + (hashNoise(i, 3) * 2.2);
        var alpha = progress * (0.09 + (shimmer * 0.2));
        canvasCtx.fillStyle = 'rgba(255,255,255,' + String(alpha) + ')';
        canvasCtx.fillRect(x - (size / 2), y - (size / 2), size, size);
      }

      canvasCtx.restore();
    }

    function drawAnimatedCommentLines(item, nowMs) {
      if (!canvasCtx) return;
      var progress = clamp01((item.formProgress - 0.2) / 0.72);
      if (progress <= 0) return;
      var box = calloutBox(item);
      var lineCount = 7;
      var startY = box.top + LINE_TOP;
      var gap = LINE_GAP;
      var phase = Number(nowMs || Date.now());

      canvasCtx.save();
      canvasCtx.beginPath();
      canvasCtx.rect(box.left, box.top, CALLOUT_WIDTH, CALLOUT_HEIGHT);
      canvasCtx.clip();
      canvasCtx.lineCap = 'round';

      for (var i = 0; i < lineCount; i++) {
        var localProgress = clamp01((progress - (i * 0.065)) / 0.5);
        if (localProgress <= 0) continue;
        var y = startY + (i * gap) + (Math.sin((phase / 420) + i) * 0.8);
        var x1 = box.left + LINE_INSET;
        var x2 = box.right - LINE_INSET - ((i % 3) * LINE_INSET);
        var endX = x1 + ((x2 - x1) * localProgress);
        var rgb = commentLineColor(i, localProgress);
        var pulse = 0.72 + (0.18 * Math.sin((phase / 260) + (i * 0.9)));

        canvasCtx.strokeStyle = rgbaRgb(rgb, 0.52 * localProgress * pulse);
        canvasCtx.lineWidth = 1.6;
        canvasCtx.beginPath();
        canvasCtx.moveTo(x1, y);
        canvasCtx.lineTo(endX, y);
        canvasCtx.stroke();

        if (isTagRow(i, lineCount)) {
          var tagBox = annotationTagBox(item);
          var whiteStart = Math.max(x1, tagBox.left - 10);
          var whiteEnd = Math.min(endX, tagBox.right + 12);
          if (whiteEnd > whiteStart) {
            canvasCtx.strokeStyle = 'rgba(255,255,255,' + String(0.78 * localProgress) + ')';
            canvasCtx.lineWidth = 2.1;
            canvasCtx.beginPath();
            canvasCtx.moveTo(whiteStart, y);
            canvasCtx.lineTo(whiteEnd, y);
            canvasCtx.stroke();
          }
        }

        var dotCount = 7;
        for (var d = 0; d < dotCount; d++) {
          var t = (d + 0.5) / dotCount;
          if (t > localProgress) continue;
          var jitter = hashNoise((i * 31) + d, Math.floor(phase / 180)) - 0.5;
          var dotX = x1 + ((x2 - x1) * t);
          var lowerLineOnTag = isTagRow(i, lineCount) &&
            dotX >= (annotationTagBox(item).left - 10) &&
            dotX <= (annotationTagBox(item).right + 12);
          canvasCtx.fillStyle = lowerLineOnTag
            ? 'rgba(255,255,255,' + String(0.5 * localProgress) + ')'
            : rgbaRgb(rgb, 0.28 * localProgress);
          canvasCtx.beginPath();
          canvasCtx.arc(dotX, y + (jitter * 2.2), 0.75 + Math.abs(jitter), 0, Math.PI * 2);
          canvasCtx.fill();
        }
      }

      canvasCtx.restore();
    }

    function wrapTextToLayouts(text, item, maxLines) {
      // Measure with the same font the text is drawn with — the context may still
      // carry another font from a previous draw call, which made lines wrap too
      // late and run past the box border.
      canvasCtx.font = '600 ' + FONT_PX + 'px Arial, sans-serif';
      var normalized = String(text || '').replace(/\r/g, '');
      var out = [];
      var line = '';
      for (var i = 0; i < normalized.length && out.length < maxLines; i++) {
        var ch = normalized[i];
        if (ch === '\n') {
          out.push(line);
          line = '';
          continue;
        }
        var layout = commentLineLayout(item, out.length, maxLines);
        var maxWidth = Math.max(24, layout.x2 - layout.x1);
        var candidate = line + ch;
        if (line && canvasCtx.measureText(candidate).width > maxWidth) {
          out.push(line.trimEnd());
          line = ch.trimStart();
        } else {
          line = candidate;
        }
      }
      if (out.length < maxLines) out.push(line);
      return out.slice(0, maxLines);
    }

    function drawTypedCommentText(item, nowMs) {
      if (!canvasCtx || item.formProgress < 0.85) return;
      var text = String(textByKey[item.key] || '');
      if (!text) return;
      var box = calloutBox(item);
      var maxLines = 7;
      var lines = wrapTextToLayouts(text, item, maxLines);
      var phase = Number(nowMs || Date.now());

      canvasCtx.save();
      canvasCtx.beginPath();
      canvasCtx.rect(box.left, box.top, CALLOUT_WIDTH, CALLOUT_HEIGHT);
      canvasCtx.clip();
      // The border stays glued to the tag, but text must stay readable: when the
      // held tag angle turns the box past +/-90deg, spin the text block 180deg
      // about the box centre so the glyphs come out upright for the reader.
      if (Math.cos(itemAngleRad(item)) < 0) {
        var bcx = box.left + (CALLOUT_WIDTH / 2);
        var bcy = box.top + (CALLOUT_HEIGHT / 2);
        canvasCtx.translate(bcx, bcy);
        canvasCtx.rotate(Math.PI);
        canvasCtx.translate(-bcx, -bcy);
      }
      canvasCtx.font = '600 ' + FONT_PX + 'px Arial, sans-serif';
      canvasCtx.textBaseline = 'alphabetic';
      canvasCtx.fillStyle = 'rgba(4,31,58,0.9)';
      canvasCtx.shadowBlur = 5;
      canvasCtx.shadowColor = 'rgba(255,255,255,0.65)';

      for (var i = 0; i < lines.length; i++) {
        var layout = commentLineLayout(item, i, maxLines);
        canvasCtx.fillText(lines[i], layout.x1, layout.y + 4);
      }

      if ((Math.floor(phase / 520) % 2) === 0) {
        var lastLine = lines[lines.length - 1] || '';
        var lastLayout = commentLineLayout(item, lines.length - 1, maxLines);
        var caretX = lastLayout.x1 + canvasCtx.measureText(lastLine).width + 2;
        var caretY = lastLayout.y - 10;
        canvasCtx.fillStyle = 'rgba(4,31,58,0.75)';
        canvasCtx.fillRect(caretX, caretY, 2, 16);
      }
      canvasCtx.restore();
    }

    function drawCommentIcon(cx, cy, alpha) {
      if (!canvasCtx) return;
      canvasCtx.save();
      canvasCtx.translate(cx, cy);
      canvasCtx.lineJoin = 'round';
      canvasCtx.lineCap = 'round';
      canvasCtx.fillStyle = 'rgba(255,255,255,' + String(0.72 * alpha) + ')';
      canvasCtx.strokeStyle = 'rgba(5,31,58,' + String(0.92 * alpha) + ')';
      canvasCtx.lineWidth = 1.8;
      canvasCtx.beginPath();
      if (typeof canvasCtx.roundRect === 'function') {
        canvasCtx.roundRect(-11, -9, 22, 16, 4);
      } else {
        canvasCtx.rect(-11, -9, 22, 16);
      }
      canvasCtx.moveTo(-3, 7);
      canvasCtx.lineTo(-8, 13);
      canvasCtx.lineTo(4, 7);
      canvasCtx.closePath();
      canvasCtx.fill();
      canvasCtx.stroke();
      canvasCtx.fillStyle = 'rgba(5,31,58,' + String(0.8 * alpha) + ')';
      for (var i = 0; i < 3; i++) {
        canvasCtx.beginPath();
        canvasCtx.arc(-5 + (i * 5), -1, 1.15, 0, Math.PI * 2);
        canvasCtx.fill();
      }
      canvasCtx.restore();
    }

    function drawCollapsedNotes(nowMs) {
      if (!canvasCtx || !collapsedNotes.length) return;
      var now = Number(nowMs) || Date.now();
      canvasCtx.save();
      canvasCtx.font = '700 15px Arial, sans-serif';
      canvasCtx.textBaseline = 'middle';

      collapsedNotes.forEach(function (note) {
        if (!note || !isVisibleStep(note.step)) return;
        var progress = clamp01((now - Number(note.createdAtMs || now)) / 850);
        var ease = 1 - Math.pow(1 - progress, 3);
        var x = mix(Number(note.fromX), Number(note.x), ease);
        var y = mix(Number(note.fromY), Number(note.y), ease);
        var alpha = 0.35 + (0.65 * progress);

        drawCommentIcon(x, y, alpha);
        var label = String(note.preview || '');
        if (label) {
          var textWidth = canvasCtx.measureText(label).width;
          var textX = x - (textWidth / 2);
          var textY = y - 25;
          canvasCtx.shadowBlur = 7;
          canvasCtx.shadowColor = 'rgba(255,255,255,' + String(0.7 * alpha) + ')';
          canvasCtx.fillStyle = 'rgba(5,31,58,' + String(0.9 * alpha) + ')';
          canvasCtx.fillText(label, textX, textY);
          canvasCtx.shadowBlur = 0;
        }
      });

      canvasCtx.restore();
    }

    function drawParticleLayer(nowMs) {
      if (!canvasCtx) return;
      resizeCanvas();
      canvasCtx.clearRect(0, 0, canvasWidth, canvasHeight);
      canvasCtx.save();
      canvasCtx.globalCompositeOperation = 'source-over';
      activeItems.forEach(function (item) {
        if (item && isVisibleStep(item.step)) {
          var rad = itemAngleRad(item);
          var drawItem = itemInRotatedFrame(item, rad);
          canvasCtx.save();
          if (rad) {
            canvasCtx.translate(Number(item.annotation.x), Number(item.annotation.y));
            canvasCtx.rotate(rad);
            canvasCtx.translate(-Number(item.annotation.x), -Number(item.annotation.y));
          }
          drawNoisyCommentBackground(drawItem, nowMs);
          drawAnimatedCommentLines(drawItem, nowMs);
          drawTypedCommentText(drawItem, nowMs);
          updateParticlesForItem(drawItem, nowMs);
          drawTriangleMarker(drawItem, nowMs);
          canvasCtx.restore();
        }
      });
      drawCollapsedNotes(nowMs);
      canvasCtx.restore();
    }

    function visibleActiveItems() {
      return activeItems.filter(function (item) {
        return item && isVisibleStep(item.step);
      });
    }

    function visibleCollapsedNotes() {
      return collapsedNotes.filter(function (note) {
        return note && isVisibleStep(note.step);
      });
    }

    function activeTypingItem() {
      var visibleItems = visibleActiveItems();
      for (var i = 0; i < visibleItems.length; i++) {
        if (visibleItems[i] && visibleItems[i].settled) return visibleItems[i];
      }
      return visibleItems[0] || null;
    }

    function triggerTypingPulse(item) {
      if (!item) return;
      var runtime = runtimeByKey[String(item.key || 'keyboard-annotation')];
      if (!runtime) return;
      var now = Date.now();
      var starts = Array.isArray(runtime.typingPulseStarts) ? runtime.typingPulseStarts : [];
      runtime.typingPulseStarts = starts
        .filter(function (startedAt) { return now - Number(startedAt) <= TYPING_PULSE_MS; })
        .slice(-5);
      runtime.typingPulseStarts.push(now);
    }

    function handleKeyDown(e) {
      if (!enabled || !e) return false;
      var item = activeTypingItem();
      if (!item) return false;
      var key = String(e.key || '');
      var current = String(textByKey[item.key] || '');
      var handled = false;
      var textChanged = false;

      if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var typed = (current + key).slice(0, 360);
        textByKey[item.key] = typed;
        textChanged = typed !== current;
        handled = true;
      } else if (key === 'Backspace') {
        var backspaced = current.slice(0, -1);
        textByKey[item.key] = backspaced;
        textChanged = backspaced !== current;
        handled = true;
      } else if (key === 'Delete') {
        textByKey[item.key] = '';
        textChanged = current !== '';
        handled = true;
      } else if (key === 'Enter') {
        var entered = (current + '\n').slice(0, 360);
        textByKey[item.key] = entered;
        textChanged = entered !== current;
        handled = true;
      } else if (key === 'Escape') {
        handled = true;
      }

      if (!handled) return false;
      e.preventDefault();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      } else {
        e.stopPropagation();
      }
      if (textChanged) triggerTypingPulse(item);
      render();
      return true;
    }

    function renderStaticLayers() {
      ensureDom();
      if (!rootEl || !svgEl || !htmlLayerEl) return;

      svgEl.textContent = '';
      htmlLayerEl.textContent = '';

      var visibleItems = visibleActiveItems();
      var visibleNotes = visibleCollapsedNotes();
      rootEl.classList.toggle('hidden', !enabled || (visibleItems.length === 0 && visibleNotes.length === 0));
      if (!enabled || (visibleItems.length === 0 && visibleNotes.length === 0)) return;

    }

    function refreshActiveProgress(nowMs) {
      activeItems.forEach(function (item) {
        if (item) refreshRuntimeProgress(item, nowMs);
      });
    }

    function shouldAnimate() {
      return !!(enabled && (visibleActiveItems().length || visibleCollapsedNotes().length));
    }

    function animationTick() {
      animationFrame = 0;
      if (!shouldAnimate()) {
        clearCanvas();
        return;
      }
      var now = Date.now();
      refreshActiveProgress(now);
      renderStaticLayers();
      drawParticleLayer(now);
      animationFrame = window.requestAnimationFrame(animationTick);
    }

    function ensureAnimation() {
      if (animationFrame || !shouldAnimate()) return;
      animationFrame = window.requestAnimationFrame(animationTick);
    }

    function stopAnimation() {
      if (!animationFrame) return;
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }

    function render() {
      renderStaticLayers();
      drawParticleLayer(Date.now());
      ensureAnimation();
    }

    function update(rawItems, nowMs, maybeEnabled) {
      if (typeof maybeEnabled === 'boolean') setEnabled(maybeEnabled);
      ensureDom();
      if (!enabled) return;

      var items = [];
      var list = Array.isArray(rawItems) ? rawItems : [];
      for (var i = 0; i < list.length; i++) {
        var normalized = normalizeItem(list[i]);
        if (normalized) items.push(applyRuntimeState(normalized, nowMs));
      }

      if (items.length) {
        activeItems = items;
        lastSeenMs = Number(nowMs) || Date.now();
        render();
        return;
      }

      if (activeItems.length && (Number(nowMs) - Number(lastSeenMs || 0)) <= lostHoldMs) {
        refreshActiveProgress(nowMs);
        render();
        return;
      }

      archiveAllRuntimeNotes(nowMs);
      activeItems = [];
      runtimeByKey = {};
      render();
    }

    function setEnabled(nextEnabled) {
      enabled = !!nextEnabled;
      ensureDom();
      if (!enabled) {
        activeItems = [];
        runtimeByKey = {};
        stopAnimation();
        render();
      }
    }

    function setCurrentStep(stepNumber) {
      currentStep = Number(stepNumber) || 0;
      render();
    }

    // Partial update of any metric(s); only valid finite values are applied.
    function setMetrics(m) {
      if (!m || typeof m !== 'object') return;
      if (Number(m.widthScale) > 0) scaleX = Number(m.widthScale);
      if (Number(m.heightScale) > 0) scaleY = Number(m.heightScale);
      if (Number(m.scale) > 0) { scaleX = Number(m.scale); scaleY = Number(m.scale); }
      if (Number(m.triangleWidthScale) > 0) triWidthMul = Number(m.triangleWidthScale);
      if (Number(m.triangleHeightScale) > 0) triHeightMul = Number(m.triangleHeightScale);
      if (Number.isFinite(Number(m.leftOffsetCm))) leftOffsetCm = Number(m.leftOffsetCm);
      if (Number.isFinite(Number(m.bottomOffsetCm))) bottomOffsetCm = Number(m.bottomOffsetCm);
      if (typeof m.flipVertical === 'boolean') flipVertical = m.flipVertical;
      if (typeof m.flipHorizontal === 'boolean') flipHorizontal = m.flipHorizontal;
      if (Number.isFinite(Number(m.rotationThresholdDeg))) rotationThresholdDeg = Number(m.rotationThresholdDeg);
      if (Number.isFinite(Number(m.moveDeadbandPx))) moveDeadbandPx = Number(m.moveDeadbandPx);
      applyScale();
      render();
    }

    function getMetrics() {
      return {
        widthScale: scaleX, heightScale: scaleY,
        triangleWidthScale: triWidthMul, triangleHeightScale: triHeightMul,
        leftOffsetCm: leftOffsetCm, bottomOffsetCm: bottomOffsetCm,
        flipVertical: flipVertical, flipHorizontal: flipHorizontal,
        rotationThresholdDeg: rotationThresholdDeg,
        moveDeadbandPx: moveDeadbandPx
      };
    }

    // Back-compat uniform helpers.
    function setScale(next) { var v = Number(next); if (Number.isFinite(v) && v > 0) setMetrics({ scale: v }); }
    function getScale() { return scaleX; }

    function setVisibleSteps(steps) {
      if (!steps) {
        visibleSteps = null;
      } else if (steps instanceof Set) {
        visibleSteps = steps;
      } else if (Array.isArray(steps)) {
        visibleSteps = new Set(steps.map(function (n) { return Number(n) || 0; }));
      } else {
        visibleSteps = null;
      }
      render();
    }

    function lineFeature(item, role, a, b) {
      var aLL = pointLngLat(a);
      var bLL = pointLngLat(b);
      if (!aLL || !bLL) return null;
      return {
        type: 'Feature',
        properties: {
          sourceType: 'keyboard-annotation',
          role: role,
          key: item.key,
          label: item.label,
          text: String(textByKey[item.key] || ''),
          color: item.color,
          step: Number(item.step) || 0
        },
        geometry: {
          type: 'LineString',
          coordinates: [aLL, bLL]
        }
      };
    }

    function pointFeature(item, role, p) {
      var ll = pointLngLat(p);
      if (!ll) return null;
      return {
        type: 'Feature',
        properties: {
          sourceType: 'keyboard-annotation',
          role: role,
          key: item.key,
          label: item.label,
          text: String(textByKey[item.key] || ''),
          color: item.color,
          step: Number(item.step) || 0
        },
        geometry: {
          type: 'Point',
          coordinates: ll
        }
      };
    }

    function getGeoJSON() {
      var features = [];
      activeItems.forEach(function (item) {
        if (!item || !isVisibleStep(item.step)) return;
        [
          lineFeature(item, 'connector', item.keyboard, item.annotation),
          pointFeature(item, 'annotation-anchor', item.annotation),
          pointFeature(item, 'keyboard-anchor', item.keyboard)
        ].forEach(function (feature) {
          if (feature) features.push(feature);
        });
      });
      return { type: 'FeatureCollection', features: features };
    }

    function clearAll() {
      activeItems = [];
      lastSeenMs = 0;
      runtimeByKey = {};
      collapsedNotes = [];
      stopAnimation();
      render();
    }

    return {
      setEnabled: setEnabled,
      update: update,
      clearAll: clearAll,
      handleKeyDown: handleKeyDown,
      getGeoJSON: getGeoJSON,
      setCurrentStep: setCurrentStep,
      setVisibleSteps: setVisibleSteps,
      setScale: setScale,
      getScale: getScale,
      setMetrics: setMetrics,
      getMetrics: getMetrics
    };
  }

  window.CompactKeyboardAnnotationPlacement = {
    createKeyboardAnnotationPlacement: createKeyboardAnnotationPlacement
  };
})();
