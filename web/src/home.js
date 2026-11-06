// Fullscreen always ends when the page changes. So while the menu is fullscreen, the page a menu
// button opens is shown in a frame over the menu instead, which keeps fullscreen. That page's own
// way back to the menu loads /home in the frame, and the script at the top of home.html then
// closes the frame.
(function () {
  'use strict';
  var frame = null;
  var menuUrl = window.location.pathname + window.location.search + window.location.hash;
  var menuTitle = document.title;

  function announce(isOpen) {
    window.dispatchEvent(new CustomEvent('menuframechange', { detail: { open: isOpen } }));
  }

  function open(url) {
    if (frame) return;
    frame = document.createElement('iframe');
    frame.id = 'menuFrame';
    frame.title = 'Page';
    frame.setAttribute('data-page-warp-exclude', '');
    frame.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write; autoplay');
    frame.allowFullscreen = true;
    // The title and address follow the page in the frame, so a reload opens that page.
    frame.addEventListener('load', function () {
      try {
        var loc = frame.contentWindow.location;
        document.title = frame.contentDocument.title || menuTitle;
        window.history.replaceState(window.history.state, '', loc.pathname + loc.search + loc.hash);
        frame.contentWindow.focus();
      } catch (_err) {
        // Closed while loading.
      }
    });
    frame.src = url;
    document.body.appendChild(frame);
    document.body.classList.add('menu-frame-open');
    try { window.history.replaceState(window.history.state, '', url); } catch (_err) { }
    frame.focus();
    announce(true);
  }

  function close() {
    if (!frame) return;
    var old = frame;
    frame = null;
    old.remove();
    document.body.classList.remove('menu-frame-open');
    document.title = menuTitle;
    try { window.history.replaceState(window.history.state, '', menuUrl); } catch (_err) { }
    window.focus();
    announce(false);
  }

  window.CompactMenuFrame = {
    open: open,
    close: close,
    isOpen: function () { return !!frame; },
    // Opens a page from the menu: in the frame while fullscreen, else as a normal page change.
    go: function (url) {
      if (document.fullscreenElement) open(url);
      else window.location.href = url;
    }
  };
})();

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var menuFrame = window.CompactMenuFrame;

  function setStatus(el, message, kind) {
    el.textContent = message || '';
    el.className = 'status-line' + (kind ? ' ' + kind : '');
  }

  var introOverlay = $('introOverlay');

  function showIntro() {
    introOverlay.hidden = false;
    requestAnimationFrame(updateIntroLink);
  }
  function closeIntro() {
    introOverlay.hidden = true;
  }
  $('introStart').addEventListener('click', closeIntro);
  $('goGuide').addEventListener('click', showIntro);

  // The dashed line from the pointer in the photo to the "Cardboard Pointer"
  // box depends on the responsive layout, so it is drawn from live rects.
  var introLink = $('introLink');
  function updateIntroLink() {
    if (introOverlay.hidden) return;
    if (window.getComputedStyle(introLink).display === 'none') return;
    var line = introLink.querySelector('line');
    var ref = introLink.getBoundingClientRect();
    var dotRect = document.querySelector('.callout--pointer').getBoundingClientRect(); // 0×0 box anchored on the dot
    var mediaRect = document.querySelector('.intro-tool__media').getBoundingClientRect();
    line.setAttribute('x1', dotRect.left - ref.left);
    line.setAttribute('y1', dotRect.top - ref.top);
    line.setAttribute('x2', mediaRect.left - ref.left);
    line.setAttribute('y2', mediaRect.top + mediaRect.height * 0.72 - ref.top);
  }
  window.addEventListener('resize', updateIntroLink);
  introOverlay.addEventListener('scroll', updateIntroLink, { passive: true });
  // Also redraw once the photo has loaded and the video's real size is known.
  var introLinkRo = new ResizeObserver(updateIntroLink);
  introLinkRo.observe(document.querySelector('.intro-photo img.setup'));
  introLinkRo.observe(document.querySelector('.intro-tool__media'));

  function goMap() { menuFrame.go('/map'); }

  // The menu's links keep fullscreen too (a plain click only; Ctrl+click and the like are left be).
  ['goGenerate', 'goDigitize', 'goMarker'].forEach(function (id) {
    var link = $(id);
    link.addEventListener('click', function (e) {
      if (!document.fullscreenElement || e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      menuFrame.open(link.getAttribute('href'));
    });
  });
  function doExit() {
    if (!window.confirm('Exit the application?')) return;
    fetch('/api/shutdown', { method: 'POST' }).catch(function () { });
    setTimeout(function () { window.close(); }, 250);
    document.body.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;'
      + 'font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:18px;color:#3a3a3a;">'
      + 'Shutting down… you can close this window.</div>';
  }
  $('goMap').addEventListener('click', goMap);

  // A panel takes the nav's place instead of opening a page, so the camera
  // view keeps streaming: it is the feedback for the tuning sliders.
  var rightCol = $('rightCol');
  var sideNav = $('sideNav');
  var openPanel = null;

  function showPanel(id) {
    if (openPanel && openPanel !== id) $(openPanel).hidden = true;
    openPanel = id;
    sideNav.hidden = true;
    $(id).hidden = false;
    rightCol.classList.add('panel-open');
    if (id === 'tuningPanel') window.CompactHomeTuning.init();
  }

  function closePanel() {
    if (openPanel) $(openPanel).hidden = true;
    openPanel = null;
    sideNav.hidden = false;
    rightCol.classList.remove('panel-open');
  }

  document.querySelectorAll('[data-panel-close]').forEach(function (b) {
    b.addEventListener('click', closePanel);
  });
  $('goTuning').addEventListener('click', function () { showPanel('tuningPanel'); });
  $('exitBtn').addEventListener('click', doExit);

  // The menu has no keyboard shortcuts. Esc only closes what lies on top of it: the automatic
  // definition's grid (it covers the whole page, so there is no button to reach), the guide or a panel.
  window.addEventListener('keydown', function (e) {
    // A page is open over the menu: the menu's keys are not for it.
    if (menuFrame.isOpen()) return;
    var key = String(e.key || '').toLowerCase();
    if (autoCalibActive && (key === 'escape' || key === 'backspace')) {
      e.preventDefault();
      stopAutoCalib(false);
      setStatus(cornerStatus, 'Automatic definition cancelled.');
      return;
    }
    if (key !== 'escape') return;
    if (!introOverlay.hidden) closeIntro();
    else if (openPanel) closePanel();
  });

  var srcSmartphone = $('srcSmartphone');
  var srcWebcam = $('srcWebcam');
  var cameraStatus = $('cameraStatus');
  var cameraState = $('cameraState');
  var cameraStateText = $('cameraStateText');

  var currentSource = 'smartphone';
  var cameraConnected = false;

  function detectSourceKind(source) {
    var s = String(source || '');
    if (/^\d+$/.test(s)) return 'webcam';
    if (s) return 'smartphone';
    return '';
  }

  var webcamIndexWrap = $('webcamIndexWrap');
  var webcamIndex = $('webcamIndex');
  var camGuide = $('camGuide');
  // On a Mac the guide also has steps for an iPhone (Continuity Camera: one of the Mac's cameras,
  // opened with Webcam), picked with the Android / iPhone switch above it.
  var camGuideIphone = $('camGuideIphone');
  var guidePhoneSwitch = $('guidePhoneSwitch');
  var guidePhoneBtns = guidePhoneSwitch.querySelectorAll('[data-guide-phone]');
  var onMac = false;
  var guidePhone = 'android';
  try { if (localStorage.getItem('guidePhone') === 'iphone') guidePhone = 'iphone'; } catch (_err) { }

  function refreshGuide() {
    var iphone = onMac && guidePhone === 'iphone';
    // The Android steps are for Smartphone; the iPhone's stay up with Webcam, since they pick its device.
    camGuide.hidden = iphone || currentSource === 'webcam';
    camGuideIphone.hidden = !iphone;
    guidePhoneSwitch.hidden = !onMac || (currentSource === 'webcam' && !iphone);
    guidePhoneBtns.forEach(function (btn) {
      var on = btn.dataset.guidePhone === (iphone ? 'iphone' : 'android');
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  guidePhoneBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      guidePhone = btn.dataset.guidePhone;
      try { localStorage.setItem('guidePhone', guidePhone); } catch (_err) { }
      refreshGuide();
    });
  });

  function markSource(kind) {
    currentSource = kind;
    srcSmartphone.classList.toggle('active', kind === 'smartphone');
    srcWebcam.classList.toggle('active', kind === 'webcam');
    webcamIndexWrap.hidden = kind !== 'webcam';
    refreshGuide();
  }

  function connect(kind, payload) {
    return fetch('/api/camera/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ kind: kind }, payload || {}))
    }).then(function (r) {
      return r.json().then(function (d) { return { status: r.status, data: d }; });
    });
  }

  var smartphoneConnectInFlight = false;

  function connectSmartphone() {
    markSource('smartphone');
    if (smartphoneConnectInFlight) return;
    smartphoneConnectInFlight = true;
    setStatus(cameraStatus, 'Looking for IP Camera on :8080…');
    connect('smartphone').then(function (res) {
      if (res.data && res.data.ok) {
        setStatus(cameraStatus, 'Connected: ' + (res.data.source || ''), 'ok');
        setCameraConnected(true, res.data.source || '');
      } else {
        setStatus(cameraStatus, 'No IP camera found — retrying every 10s.', 'err');
        setCameraConnected(false, '');
      }
    }).catch(function () { setStatus(cameraStatus, 'Network error — retrying every 10s.', 'err'); })
      .then(function () { smartphoneConnectInFlight = false; });
  }

  function connectWebcam() {
    markSource('webcam');
    var idx = parseInt(webcamIndex.value, 10);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    setStatus(cameraStatus, 'Opening webcam…');
    connect('webcam', { index: idx }).then(function (res) {
      if (res.data && res.data.ok) {
        setStatus(cameraStatus, 'Connected to webcam.', 'ok');
        setCameraConnected(true, String(idx));
      } else {
        setStatus(cameraStatus, 'Could not open a webcam.', 'err');
        setCameraConnected(false, '');
      }
    }).catch(function () { setStatus(cameraStatus, 'Network error.', 'err'); });
  }

  srcSmartphone.addEventListener('click', connectSmartphone);
  srcWebcam.addEventListener('click', connectWebcam);

  var camFeedWrap = $('camFeedWrap');
  var camFeed = $('camFeed');
  var camCanvas = $('camCanvas');
  var camPlaceholder = $('camPlaceholder');
  var cornerStatus = $('cornerStatus');
  var cornerBtns = document.querySelectorAll('.corner-btn');
  var screenState = $('screenState');
  var screenStateText = $('screenStateText');

  var activeCornerIndex = null;
  var lastCorners = [null, null, null, null];
  var lastFrame = { width: 0, height: 0 };
  var lastTags = [];

  function startFeed() {
    if (menuFrame.isOpen()) return;
    if (!camFeed.getAttribute('src')) camFeed.src = '/video_feed?q=70&t=' + Date.now();
    camFeedWrap.style.display = 'block';
    camPlaceholder.style.display = 'none';
  }
  function stopFeed() {
    camFeed.removeAttribute('src');
    camFeedWrap.style.display = 'none';
    camPlaceholder.style.display = '';
  }

  function setCameraConnected(connected, source) {
    var was = cameraConnected;
    cameraConnected = !!connected;
    cameraState.classList.toggle('ok', cameraConnected);
    if (cameraConnected) cameraStateText.textContent = 'Camera' + (source ? ' · ' + source : '');
    else cameraStateText.textContent = 'No camera';
    if (cameraConnected) startFeed();
    else if (was) stopFeed();
    refreshReady();
  }

  function cornersSetCount() {
    var n = 0;
    for (var i = 0; i < 4; i++) if (lastCorners[i]) n++;
    return n;
  }

  function setActiveCorner(idx) {
    activeCornerIndex = idx;
    cornerBtns.forEach(function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-corner')) === idx);
    });
    if (idx !== null) {
      setStatus(cornerStatus, 'Corner ' + (idx + 1) + ' selected — click the camera view where it sits.');
    }
  }

  var manualDefineBtn = $('manualDefineBtn');
  var cornerPick = $('cornerPick');

  function manualDefineOpen() { return !cornerPick.hidden; }

  function setManualDefine(open) {
    cornerPick.hidden = !open;
    manualDefineBtn.classList.toggle('on', open);
    manualDefineBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      if (autoCalibActive) stopAutoCalib(false);
      if (activeCornerIndex === null) {
        var next = 0;
        for (var i = 0; i < 4; i++) {
          if (!lastCorners[i]) {
            next = i;
            break;
          }
        }
        setActiveCorner(next);
      }
    } else {
      setActiveCorner(null);
      refreshCornerUi();
    }
  }

  manualDefineBtn.addEventListener('click', function () { setManualDefine(!manualDefineOpen()); });

  function toggleCorner(idx) {
    if (!manualDefineOpen()) {
      setManualDefine(true);
      setActiveCorner(idx);
      return;
    }
    setActiveCorner(activeCornerIndex === idx ? null : idx);
    if (activeCornerIndex === null) refreshCornerUi();
  }

  cornerBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      toggleCorner(Number(b.getAttribute('data-corner')));
    });
  });

  $('cornerReset').addEventListener('click', function () {
    fetch('/api/corners', { method: 'DELETE' }).then(function (r) { return r.json(); })
      .then(function (data) {
        lastCorners = (data && Array.isArray(data.corners)) ? data.corners : [null, null, null, null];
        setActiveCorner(null);
        drawCornerOverlay();
        refreshCornerUi();
      })
      .catch(function () { setStatus(cornerStatus, 'Could not reset.', 'err'); });
  });

  // client coords -> camera-frame coords, allowing for the object-fit letterboxing
  function clientToFrame(clientX, clientY) {
    if (!lastFrame.width || !lastFrame.height) return null;
    var rect = camFeed.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var scale = Math.min(rect.width / lastFrame.width, rect.height / lastFrame.height);
    var drawW = lastFrame.width * scale;
    var drawH = lastFrame.height * scale;
    var ox = (rect.width - drawW) / 2;
    var oy = (rect.height - drawH) / 2;
    var px = clientX - rect.left - ox;
    var py = clientY - rect.top - oy;
    if (px < 0 || py < 0 || px > drawW || py > drawH) return null;
    return { x: px / scale, y: py / scale };
  }

  camFeed.addEventListener('click', function (e) {
    if (activeCornerIndex === null) return;
    var p = clientToFrame(e.clientX, e.clientY);
    if (!p) return;
    var idx = activeCornerIndex;
    fetch('/api/corners', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: idx, x: p.x, y: p.y })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && Array.isArray(data.corners)) lastCorners = data.corners;
      var nextIdx = null;
      for (var i = 1; i <= 4; i++) {
        var cand = (idx + i) % 4;
        if (!lastCorners[cand]) {
          nextIdx = cand;
          break;
        }
      }
      setActiveCorner(nextIdx);
      drawCornerOverlay();
      refreshCornerUi();
    }).catch(function () { setStatus(cornerStatus, 'Failed to save corner.', 'err'); });
  });

  function refreshCornerUi() {
    cornerBtns.forEach(function (b) {
      var ci = Number(b.getAttribute('data-corner'));
      b.classList.toggle('set', !!lastCorners[ci]);
    });
    var n = cornersSetCount();
    screenState.classList.toggle('ok', n === 4);
    screenStateText.textContent = n === 4 ? 'Corners set' : (n + '/4 corners');
    // At rest the line stays empty (the badge above shows the count); it only guides manual picking.
    if (activeCornerIndex === null && !autoCalibActive) {
      if (n < 4 && manualDefineOpen()) setStatus(cornerStatus, n + '/4 corners set — pick a number, then click the camera view where that corner is.');
      else setStatus(cornerStatus, '');
    }
    refreshReady();
  }

  function framePoint(c) {
    var rect = camFeed.getBoundingClientRect();
    var scale = Math.min(rect.width / lastFrame.width, rect.height / lastFrame.height);
    var drawW = lastFrame.width * scale;
    var drawH = lastFrame.height * scale;
    var ox = (rect.width - drawW) / 2;
    var oy = (rect.height - drawH) / 2;
    return { x: ox + c.x * scale, y: oy + c.y * scale };
  }

  function drawCornerOverlay() {
    var rect = camFeed.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (camCanvas.width !== Math.round(rect.width)) camCanvas.width = Math.round(rect.width);
    if (camCanvas.height !== Math.round(rect.height)) camCanvas.height = Math.round(rect.height);
    var ctx = camCanvas.getContext('2d');
    ctx.clearRect(0, 0, camCanvas.width, camCanvas.height);
    if (!lastFrame.width || !lastFrame.height) return;

    for (var ti = 0; ti < lastTags.length; ti++) {
      var tag = lastTags[ti];
      if (!tag || !Array.isArray(tag.corners) || tag.corners.length < 4) continue;
      ctx.beginPath();
      var valid = true;
      for (var ci = 0; ci < 4; ci++) {
        var tc = tag.corners[ci];
        if (!tc || !isFinite(Number(tc.x)) || !isFinite(Number(tc.y))) {
          valid = false;
          break;
        }
        var tp = framePoint(tc);
        if (ci === 0) ctx.moveTo(tp.x, tp.y);
        else ctx.lineTo(tp.x, tp.y);
      }
      if (!valid) continue;
      ctx.closePath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#00ff66';
      ctx.stroke();
      if (tag.center && isFinite(Number(tag.center.x)) && isFinite(Number(tag.center.y))) {
        var cp = framePoint(tag.center);
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ff2222';
        ctx.fill();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText('id ' + tag.id, cp.x + 7, cp.y - 7);
        ctx.fillStyle = '#ffffff';
        ctx.fillText('id ' + tag.id, cp.x + 7, cp.y - 7);
      }
    }

    var pts = [];
    var allSet = true;
    for (var i = 0; i < 4; i++) {
      var c = lastCorners[i];
      if (!c) {
        allSet = false;
        pts.push(null);
        continue;
      }
      pts.push(framePoint(c));
    }
    if (allSet) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var k = 1; k < 4; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(47, 143, 134, 0.20)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#2f8f86';
      ctx.stroke();
    }
    for (var i2 = 0; i2 < 4; i2++) {
      var p = pts[i2];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd24d';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#1c3a36';
      ctx.stroke();
      ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#1c3a36';
      ctx.fillText(String(i2 + 1), p.x, p.y);
    }
  }

  var calibGrid = $('calibGrid');
  var autoDetectBtn = $('autoDetectBtn');
  var autoCalibActive = false;
  var autoCalibTimer = 0;
  var calibGridBuilt = false;
  var calibTagEls = {};
  var calibHud = null;

  var CALIB_REASONS = {
    too_few_tags: 'Need at least 4. Lower the camera exposure, and keep the whole screen in view.',
    tags_too_clustered: 'The tags seen are bunched together. More of the screen has to be in view.',
    fit_too_loose: 'The fit is not tight enough yet. Keep the camera still and in focus.',
    no_fit: 'No consistent fit yet.',
    degenerate: 'No consistent fit yet.'
  };

  function paintCalibHud(data) {
    var ids = data && Array.isArray(data.found_ids) ? data.found_ids : [];
    Object.keys(calibTagEls).forEach(function (id) {
      calibTagEls[id].classList.toggle('seen', ids.indexOf(Number(id)) >= 0);
    });
    if (!data) {
      calibHud.textContent = '';
      return;
    }
    var found = data.tags_found || 0;
    var total = data.tags_total || 0;
    var lines = [found + ' of ' + total + ' tags seen'];
    if (typeof data.error === 'number') lines[0] += ' · fit ' + data.error.toFixed(1) + ' px';
    if (data.reason && CALIB_REASONS[data.reason]) lines.push(CALIB_REASONS[data.reason]);
    else if (found >= 4) lines.push('Locking ' + (data.stable || 0) + ' / ' + (data.confirm || 0));
    lines.push('Esc or Backspace to cancel');
    calibHud.textContent = lines.join('\n');
  }

  function buildCalibGrid() {
    if (calibGridBuilt) return Promise.resolve(true);
    return fetch('/api/auto-calibrate/layout', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || data.ok !== true || !Array.isArray(data.tags)) return false;
        var fam = data.family || 'tag36h11';
        calibGrid.innerHTML = '';
        calibTagEls = {};
        data.tags.forEach(function (t) {
          var img = document.createElement('img');
          img.className = 'calib-tag';
          img.alt = '';
          img.src = '/api/apriltag-svg/' + encodeURIComponent(fam) + '/' + t.id + '.svg';
          img.style.left = (t.cx * 100) + '%';
          img.style.top = (t.cy * 100) + '%';
          calibGrid.appendChild(img);
          calibTagEls[t.id] = img;
        });
        calibHud = document.createElement('div');
        calibHud.className = 'calib-hud';
        calibGrid.appendChild(calibHud);
        calibGridBuilt = true;
        return true;
      })
      .catch(function () { return false; });
  }

  function postAutoCalib(enabled) {
    fetch('/api/auto-calibrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled })
    }).catch(function () { });
  }

  function stopAutoCalib(silent) {
    var wasActive = autoCalibActive;
    autoCalibActive = false;
    clearInterval(autoCalibTimer);
    autoCalibTimer = 0;
    calibGrid.classList.remove('visible');
    paintCalibHud(null);
    autoDetectBtn.classList.remove('active');
    autoDetectBtn.textContent = 'Define automatically';
    if (!silent && wasActive) postAutoCalib(false);
  }

  function startAutoCalib() {
    if (!cameraConnected) {
      setStatus(cornerStatus, 'Connect a camera first.', 'err');
      return;
    }
    if (manualDefineOpen()) setManualDefine(false);
    buildCalibGrid().then(function (ok) {
      if (!ok) {
        setStatus(cornerStatus, 'Could not load the calibration grid.', 'err');
        return;
      }
      autoCalibActive = true;
      paintCalibHud({ tags_found: 0, tags_total: Object.keys(calibTagEls).length });
      calibGrid.classList.add('visible');
      autoDetectBtn.classList.add('active');
      autoDetectBtn.textContent = 'Cancel';
      setStatus(cornerStatus, 'Projecting grid — keep the whole screen in the camera view…');
      postAutoCalib(true);
      clearInterval(autoCalibTimer);
      autoCalibTimer = setInterval(pollAutoCalib, 200);
    });
  }

  function pollAutoCalib() {
    fetch('/api/auto-calibrate', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || data.ok !== true) return;
        if (Array.isArray(data.corners)) {
          lastCorners = data.corners;
          drawCornerOverlay();
          refreshCornerUi();
        }
        if (data.done) {
          stopAutoCalib(true);
          setStatus(cornerStatus, 'All 4 corners set ✓ (auto)', 'ok');
          return;
        }
        if (autoCalibActive) paintCalibHud(data);
        var found = data.tags_found || 0;
        var total = data.tags_total || 0;
        var err = (typeof data.error === 'number') ? (', err ' + data.error.toFixed(1) + 'px') : '';
        if (found < 4) {
          setStatus(cornerStatus, 'Projecting grid — ' + found + '/' + total + ' tags visible' + err);
        } else {
          setStatus(cornerStatus, 'Calibrating — ' + found + '/' + total + ' tags, stabilizing '
            + (data.stable || 0) + '/' + (data.confirm || 0) + err);
        }
      })
      .catch(function () { });
  }

  autoDetectBtn.addEventListener('click', function () {
    if (autoCalibActive) stopAutoCalib(false);
    else startAutoCalib();
  });

  var goMapBtn = $('goMap');
  function refreshReady() {
    goMapBtn.classList.toggle('ready', cameraConnected && cornersSetCount() === 4);
  }

  function pollCameraStatus() {
    // While a page is open over the menu (CompactMenuFrame) the menu rests, as if it had been left.
    if (menuFrame.isOpen()) return Promise.resolve();
    return fetch('/api/camera/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var connected = !!(data && data.connected);
        var src = String((data && data.source) || '');
        // On a Mac the phone's camera comes over USB debugging (adb), not USB tethering, and the guide
        // has the iPhone's steps too.
        var mac = !!(data && data.mac);
        $('guideTether').hidden = mac;
        $('guideAdb').hidden = !mac;
        if (mac !== onMac) {
          onMac = mac;
          refreshGuide();
        }
        var kind = detectSourceKind(src);
        if (connected && kind && kind !== currentSource && !cameraConnected) markSource(kind);
        setCameraConnected(connected, src);
      })
      .catch(function () { setCameraConnected(false, ''); });
  }

  function pollTags() {
    if (!cameraConnected || menuFrame.isOpen()) return;
    fetch('/api/tags', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data) return;
        if (data.frame) lastFrame = data.frame;
        if (Array.isArray(data.corners)) lastCorners = data.corners;
        lastTags = Array.isArray(data.tags) ? data.tags : [];
        if (lastFrame.width && lastFrame.height) {
          startFeed();
          drawCornerOverlay();
          refreshCornerUi();
        }
      })
      .catch(function () { });
  }

  function retrySmartphone() {
    if (menuFrame.isOpen()) return;
    if (currentSource === 'smartphone' && !cameraConnected && !smartphoneConnectInFlight) connectSmartphone();
  }

  // The camera view stops streaming while a page is open over the menu, and resumes after.
  window.addEventListener('menuframechange', function (e) {
    if (e.detail && e.detail.open) stopFeed();
    else pollCameraStatus();
  });

  // Look for the phone straight away (not 10 s later), so the view says at once whether it was found.
  pollCameraStatus().then(retrySmartphone);
  setInterval(pollCameraStatus, 2500);
  setInterval(pollTags, 150);
  setInterval(function () {
    if (openPanel === 'tuningPanel') window.CompactHomeTuning.refreshReadout(cameraConnected, lastTags.length);
  }, 250);
  setInterval(retrySmartphone, 10000);
})();

(function () {
  'use strict';
  var btn = document.getElementById('fsBtn');
  if (!document.documentElement.requestFullscreen) return;
  function sync() {
    var fs = !!document.fullscreenElement;
    btn.classList.toggle('is-fs', fs);
    btn.title = fs ? 'Exit fullscreen (F11)' : 'Toggle fullscreen (F11)';
  }
  btn.addEventListener('click', function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(function () { });
  });
  document.addEventListener('fullscreenchange', sync);
  sync();
})();

// Offer a reset when a saved projection warp (a stale table calibration) visibly skews this page.
(function () {
  'use strict';
  var notice = document.getElementById('warpNotice');
  var KEYS = ['compact-workshop-page-warp-v1', 'compact-workshop-maptastic-layout-v1'];
  function warpIsSignificant() {
    var raw = null;
    try { raw = window.localStorage.getItem(KEYS[0]) || window.localStorage.getItem(KEYS[1]); } catch (_e) { }
    if (!raw) return false;
    var p;
    try { p = JSON.parse(raw); } catch (_e) { return false; }
    var s = p && p.sourcePointsNormalized;
    var t = p && p.targetPointsNormalized;
    if (!Array.isArray(s) || !Array.isArray(t) || s.length !== 4 || t.length !== 4) return false;
    for (var i = 0; i < 4; i++) {
      if (Math.abs(s[i][0] - t[i][0]) > 0.01 || Math.abs(s[i][1] - t[i][1]) > 0.01) return true;
    }
    return false;
  }
  if (warpIsSignificant()) notice.hidden = false;
  document.getElementById('warpReset').addEventListener('click', function () {
    // reset() also stops pageWarp's beforeunload save, which would write the warp back on reload.
    window.CompactPageWarp.reset();
    notice.hidden = true;
    window.location.reload();
  });
})();
