(function () {
  function isTextInputTarget(target) {
    const name = String((target && target.tagName) || '').toUpperCase();
    if (name === 'TEXTAREA' || name === 'SELECT' || !!(target && target.isContentEditable)) return true;
    if (name !== 'INPUT') return false;
    const type = String((target && target.type) || '').toLowerCase();
    return type !== 'range' && type !== 'button' && type !== 'checkbox' && type !== 'radio';
  }

  // Detect which page we are on by checking which root element is present.
  // Map page has #main_container; camera page has #cameraPage.
  function detectCurrentPage() {
    if (document.getElementById('main_container')) return 'map';
    return 'camera';
  }

  function createPageFlow(options) {
    const nextBtn = options.nextBtn;
    const onPageChange = options.onPageChange || function () {};
    const onBackToCamera = options.onBackToCamera || function () {};
    const onNextToMap = options.onNextToMap || function () {};

    const currentPage = detectCurrentPage();

    // Notify the current page on load.
    if (typeof onPageChange === 'function') {
      onPageChange(currentPage);
    }

    function isCameraPage() {
      return currentPage === 'camera';
    }

    function isMapPage() {
      return currentPage === 'map';
    }

    function getPage() {
      return currentPage;
    }

    // setPage navigates to the other page via href.
    function setPage(next) {
      if (next === 'map') {
        if (typeof onNextToMap === 'function') onNextToMap();
        window.location.href = 'index.html';
      } else {
        if (typeof onBackToCamera === 'function') onBackToCamera();
        window.location.href = '/settings';   // camera setup now lives in /settings (camera page retired)
      }
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', function () {
        setPage('map');
      });
    }

    function goBackHome() {
      confirmDialog({
        title: 'Leave this page?',
        message: 'You will return to the main menu. Any unsaved activity stays in the session.',
        confirmText: 'Leave',
        cancelText: 'Cancel',
        danger: true,
        onConfirm: function () {
          if (typeof onBackToCamera === 'function') onBackToCamera();
          window.location.href = '/home?setup';
        }
      });
    }

    function startWorkshop() {
      if (window.CompactWorkshopRuntime && typeof window.CompactWorkshopRuntime.enter === 'function') {
        window.CompactWorkshopRuntime.enter();
      }
    }

    function toggleLayers() {
      toggleLayerPicker();
    }

    function toggleLight() {
      var app = window.CompactMapApp;
      if (app && typeof app.toggleLightSettings === 'function') app.toggleLightSettings();
    }

    function toggleIndoor() {
      var app = window.CompactMapApp;
      if (!app || typeof app.toggleIndoorOutdoor !== 'function') return;
      var mode = app.toggleIndoorOutdoor();
      var btn = document.getElementById('mapIndoorButton');
      if (btn) btn.textContent = mode === 'indoor' ? 'Outdoor' : 'Indoor';
    }

    function toggleRecord() {
      var app = window.CompactMapApp;
      if (!app || typeof app.toggleRecording !== 'function') return;
      app.toggleRecording();
      refreshRecordButton();
    }

    // Red disc when idle → red square while recording.
    function refreshRecordButton() {
      var btn = document.getElementById('mapRecordButton');
      if (!btn) return;
      var app = window.CompactMapApp;
      var rec = !!(app && typeof app.isRecording === 'function' && app.isRecording());
      var icon = btn.querySelector('.rec-icon');
      if (icon) icon.style.borderRadius = rec ? '2px' : '50%';
      btn.setAttribute('aria-label', rec ? 'Stop recording' : 'Start recording');
      btn.lastChild.textContent = rec ? 'Stop' : 'Record';
    }

    // 'b' navigates back to the main menu; 'w' toggles the workshop runtime.
    if (isMapPage()) {
      window.addEventListener('keydown', function (e) {
        if (e.repeat) return;
        if (isTextInputTarget(e.target)) return;
        const key = String(e.key || '').toLowerCase();
        if (key === 'b') {
          e.preventDefault();
          goBackHome();
        } else if (key === 'w') {
          e.preventDefault();
          startWorkshop();
        }
      });

      createCornerButtons({ onBack: goBackHome, onWorkshop: startWorkshop, onLayers: toggleLayers, onLight: toggleLight, onIndoor: toggleIndoor, onRecord: toggleRecord });
      // Keep the Record button's icon in sync if recording is toggled elsewhere
      // (e.g. the 'y' key).
      setInterval(function () { if (typeof refreshRecordButton === 'function') refreshRecordButton(); }, 700);
    }

    return {
      setPage,
      getPage,
      isCameraPage,
      isMapPage
    };
  }

  // Left-edge nav bar on the map page. Hidden by default so the projected map
  // stays clean; it slides in when the mouse reaches the left edge (a slim
  // handle marks the spot) and slides back out when the mouse moves away.
  function createCornerButtons(opts) {
    opts = opts || {};
    const buttons = [];

    // Vertical bar pinned to the left edge, vertically centered.
    const bar = document.createElement('div');
    bar.id = 'mapCornerButtons';
    Object.assign(bar.style, {
      position: 'fixed',
      left: '0',
      top: '50%',
      zIndex: '10000',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: '8px',
      padding: '12px 10px',
      background: 'rgba(15, 15, 15, 0.86)',
      border: '1px solid rgba(255, 255, 255, 0.22)',
      borderLeft: 'none',
      borderRadius: '0 12px 12px 0',
      boxShadow: '6px 0 24px rgba(0,0,0,0.35)',
      transform: 'translate(0, -50%)',
      transition: 'transform 0.2s ease, opacity 0.2s ease',
      opacity: '1',
      pointerEvents: 'auto'
    });
    document.body.appendChild(bar);

    // Always-visible slim handle so users know the nav lives at the left edge.
    const handle = document.createElement('div');
    handle.id = 'mapNavHandle';
    handle.setAttribute('aria-hidden', 'true');
    Object.assign(handle.style, {
      position: 'fixed',
      left: '0',
      top: '50%',
      transform: 'translateY(-50%)',
      width: '6px',
      height: '72px',
      zIndex: '9999',
      borderRadius: '0 4px 4px 0',
      background: 'rgba(15, 15, 15, 0.5)',
      border: '1px solid rgba(255, 255, 255, 0.6)',
      borderLeft: 'none',
      boxSizing: 'border-box',
      transition: 'opacity 0.2s ease',
      pointerEvents: 'none'
    });
    document.body.appendChild(handle);

    function makeButton(id, text, ariaLabel, onClick) {
      const btn = document.createElement('button');
      btn.id = id;
      btn.type = 'button';
      btn.textContent = text;
      btn.setAttribute('aria-label', ariaLabel);
      Object.assign(btn.style, {
        padding: '10px 16px',
        fontSize: '14px',
        fontWeight: '600',
        textAlign: 'left',
        color: '#fff',
        background: 'rgba(255, 255, 255, 0.08)',
        border: '1px solid rgba(255, 255, 255, 0.22)',
        borderRadius: '8px',
        cursor: 'pointer',
        whiteSpace: 'nowrap'
      });
      btn.addEventListener('click', function (e) {
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        if (typeof onClick === 'function') onClick();
      });
      btn.addEventListener('mouseenter', function () { setVisible(true); });
      bar.appendChild(btn);
      buttons.push(btn);
      return btn;
    }

    // Mouse-x thresholds: reveal when the cursor touches the left edge, keep
    // open while it stays near the bar (pickers open to its right), hide after.
    const REVEAL_X = 48;
    const KEEP_X = 300;
    let visible = true;
    let lastMouseX = window.innerWidth;
    let lastMouseY = 0;

    function anyPickerOpen() {
      const layerPicker = document.getElementById('mapLayerPicker');
      if (layerPicker && layerPicker.style.display !== 'none') return true;
      const wsPicker = document.getElementById('workshopPicker');
      if (wsPicker && wsPicker.style.display && wsPicker.style.display !== 'none') return true;
      return false;
    }

    function shouldShowAt(x) {
      if (anyPickerOpen()) return true;
      return visible ? x <= KEEP_X : x <= REVEAL_X;
    }

    function setVisible(next) {
      if (next === visible) return;
      visible = next;
      bar.style.transform = next ? 'translate(0, -50%)' : 'translate(-100%, -50%)';
      bar.style.opacity = next ? '1' : '0';
      bar.style.pointerEvents = next ? 'auto' : 'none';
      handle.style.opacity = next ? '0' : '1';
    }

    makeButton('mapBackButton', 'Home', 'Back to setup (camera / screen)', opts.onBack);
    makeButton('mapWorkshopButton', 'Workshop', 'Workshops: play or create', opts.onWorkshop);
    makeButton('mapLayersButton', 'Layers', 'Switch basemap layer', opts.onLayers);
    makeButton('mapLightButton', 'Light', 'Light settings (brightness, saturation, contrast)', opts.onLight);
    makeButton('mapIndoorButton', 'Indoor', 'Toggle indoor (Telecom floorplan) / outdoor map', opts.onIndoor);
    makeRecordButton();

    // Record button: a red disc (idle) that becomes a red square while recording.
    function makeRecordButton() {
      const btn = document.createElement('button');
      btn.id = 'mapRecordButton';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Start recording');
      Object.assign(btn.style, {
        display: 'inline-flex', alignItems: 'center', gap: '7px',
        padding: '10px 16px', fontSize: '14px', fontWeight: '600', color: '#fff',
        background: 'rgba(255, 255, 255, 0.08)', border: '1px solid rgba(255, 255, 255, 0.22)',
        borderRadius: '8px', cursor: 'pointer', whiteSpace: 'nowrap', textAlign: 'left'
      });
      const icon = document.createElement('span');
      icon.className = 'rec-icon';
      Object.assign(icon.style, {
        width: '12px', height: '12px', background: '#e23b3b',
        borderRadius: '50%', display: 'inline-block', transition: 'border-radius 0.12s ease',
        flex: '0 0 auto'
      });
      const label = document.createElement('span');
      label.textContent = 'Record';
      btn.appendChild(icon);
      btn.appendChild(label);
      btn.addEventListener('click', function (e) {
        lastMouseX = e.clientX; lastMouseY = e.clientY;
        if (typeof opts.onRecord === 'function') opts.onRecord();
      });
      btn.addEventListener('mouseenter', function () { setVisible(true); });
      bar.appendChild(btn);
      buttons.push(btn);
    }

    window.addEventListener('mousemove', function (e) {
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      setVisible(shouldShowAt(lastMouseX));
    });

    bar.addEventListener('mouseleave', function (e) {
      setVisible(shouldShowAt(e.clientX));
    });

    // Show the bar briefly on load so it is discoverable, then tuck it away.
    window.setTimeout(function () {
      setVisible(shouldShowAt(lastMouseX));
    }, 2800);

    return buttons;
  }

  // ---- Styled confirm dialog -----------------------------------------------
  // A centered modal matching the app's dark popup style, used instead of the
  // native window.confirm(). Resolves through onConfirm / onCancel / onThird
  // callbacks. The optional third button enables flows like
  // Save / Don't save / Cancel.
  var confirmEl = null;
  var confirmOnConfirm = null;
  var confirmOnCancel = null;
  var confirmOnThird = null;

  function closeConfirm(outcome) {
    if (confirmEl) confirmEl.style.display = 'none';
    var cb = outcome === 'confirm' ? confirmOnConfirm
      : (outcome === 'third' ? confirmOnThird : confirmOnCancel);
    confirmOnConfirm = null;
    confirmOnCancel = null;
    confirmOnThird = null;
    if (typeof cb === 'function') cb();
  }

  function ensureConfirmDialog() {
    if (confirmEl) return confirmEl;
    confirmEl = document.createElement('div');
    confirmEl.id = 'compactConfirmOverlay';
    Object.assign(confirmEl.style, {
      position: 'fixed', inset: '0', zIndex: '10005', display: 'none',
      alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.45)'
    });

    var box = document.createElement('div');
    box.id = 'compactConfirmBox';
    Object.assign(box.style, {
      width: 'min(360px, calc(100vw - 32px))',
      borderRadius: '10px',
      background: 'rgba(20,20,20,0.96)',
      border: '1px solid rgba(255,255,255,0.24)',
      boxShadow: '0 18px 42px rgba(0,0,0,0.45)',
      color: '#fff',
      font: '600 14px system-ui, sans-serif',
      padding: '18px 18px 14px'
    });

    var titleEl = document.createElement('div');
    titleEl.id = 'compactConfirmTitle';
    Object.assign(titleEl.style, { fontSize: '17px', marginBottom: '8px' });

    var msgEl = document.createElement('div');
    msgEl.id = 'compactConfirmMessage';
    Object.assign(msgEl.style, {
      fontWeight: '400', fontSize: '14px', lineHeight: '1.4',
      color: 'rgba(255,255,255,0.82)', marginBottom: '16px'
    });

    var actions = document.createElement('div');
    Object.assign(actions.style, {
      display: 'flex', justifyContent: 'flex-end', gap: '10px'
    });

    var cancelBtn = document.createElement('button');
    cancelBtn.id = 'compactConfirmCancel';
    cancelBtn.type = 'button';
    Object.assign(cancelBtn.style, {
      padding: '8px 16px', borderRadius: '7px', cursor: 'pointer',
      color: '#fff', font: '600 14px system-ui, sans-serif',
      background: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.3)'
    });
    cancelBtn.addEventListener('click', function () { closeConfirm('cancel'); });

    // Optional middle button (e.g. "Don't save"); hidden unless thirdText set.
    var thirdBtn = document.createElement('button');
    thirdBtn.id = 'compactConfirmThird';
    thirdBtn.type = 'button';
    Object.assign(thirdBtn.style, {
      padding: '8px 16px', borderRadius: '7px', cursor: 'pointer',
      color: '#fff', font: '600 14px system-ui, sans-serif',
      background: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.3)',
      display: 'none'
    });
    thirdBtn.addEventListener('click', function () { closeConfirm('third'); });

    var confirmBtn = document.createElement('button');
    confirmBtn.id = 'compactConfirmAccept';
    confirmBtn.type = 'button';
    Object.assign(confirmBtn.style, {
      padding: '8px 16px', borderRadius: '7px', cursor: 'pointer',
      color: '#fff', font: '600 14px system-ui, sans-serif',
      background: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.3)'
    });
    confirmBtn.addEventListener('click', function () { closeConfirm('confirm'); });

    actions.appendChild(cancelBtn);
    actions.appendChild(thirdBtn);
    actions.appendChild(confirmBtn);
    box.appendChild(titleEl);
    box.appendChild(msgEl);
    box.appendChild(actions);
    confirmEl.appendChild(box);
    document.body.appendChild(confirmEl);

    // Click on the dimmed backdrop = cancel. Esc = cancel, Enter = confirm.
    confirmEl.addEventListener('mousedown', function (e) {
      if (e.target === confirmEl) closeConfirm('cancel');
    });
    document.addEventListener('keydown', function (e) {
      if (!confirmEl || confirmEl.style.display === 'none') return;
      if (e.key === 'Escape') { e.preventDefault(); closeConfirm('cancel'); }
      else if (e.key === 'Enter') { e.preventDefault(); closeConfirm('confirm'); }
    });

    return confirmEl;
  }

  function confirmDialog(opts) {
    opts = opts || {};
    var el = ensureConfirmDialog();
    var titleEl = el.querySelector('#compactConfirmTitle');
    titleEl.textContent = opts.title || 'Are you sure?';
    // Message line is optional; hide it (and its margin) when no message given
    // so a title-only dialog reads cleanly. Without a message, give the title a
    // larger bottom margin to keep a comfortable gap above the buttons.
    var msgEl = el.querySelector('#compactConfirmMessage');
    if (opts.message) {
      msgEl.textContent = opts.message;
      msgEl.style.display = '';
      titleEl.style.marginBottom = '8px';
    } else {
      msgEl.textContent = '';
      msgEl.style.display = 'none';
      titleEl.style.marginBottom = '16px';
    }
    var cancelBtn = el.querySelector('#compactConfirmCancel');
    var thirdBtn = el.querySelector('#compactConfirmThird');
    var confirmBtn = el.querySelector('#compactConfirmAccept');
    cancelBtn.textContent = opts.cancelText || 'Cancel';
    confirmBtn.textContent = opts.confirmText || 'OK';
    // Confirm button color: green (positive, matches step toggles), red (danger),
    // or the neutral default.
    if (opts.confirmColor === 'green') {
      confirmBtn.style.background = 'rgba(60,150,80,0.85)';
      confirmBtn.style.borderColor = 'rgba(120,220,140,0.9)';
    } else if (opts.danger) {
      confirmBtn.style.background = 'rgba(180,40,40,0.9)';
      confirmBtn.style.borderColor = 'rgba(220,90,90,0.9)';
    } else {
      confirmBtn.style.background = 'rgba(255,255,255,0.16)';
      confirmBtn.style.borderColor = 'rgba(255,255,255,0.3)';
    }
    if (opts.thirdText) {
      thirdBtn.textContent = opts.thirdText;
      thirdBtn.style.display = '';
    } else {
      thirdBtn.style.display = 'none';
    }
    confirmOnConfirm = typeof opts.onConfirm === 'function' ? opts.onConfirm : null;
    confirmOnCancel = typeof opts.onCancel === 'function' ? opts.onCancel : null;
    confirmOnThird = typeof opts.onThird === 'function' ? opts.onThird : null;
    el.style.display = 'flex';
  }

  // ---- Basemap layer picker (map page) -------------------------------------
  // A small popup anchored above the Layers button that lists the selectable
  // basemaps from CompactMapApp.getThemeCycle() and switches via setMapTheme().
  var LAYER_LABELS = {
    streets: 'Streets',
    satellite: 'Satellite',
    topo: 'Topographic'
  };

  function layerLabel(key) {
    return LAYER_LABELS[key] || (String(key || '').charAt(0).toUpperCase() + String(key || '').slice(1));
  }

  var layerPickerEl = null;

  function getMapApp() {
    return window.CompactMapApp || null;
  }

  function isLayerPickerVisible() {
    return !!(layerPickerEl && layerPickerEl.style.display !== 'none');
  }

  function hideLayerPicker() {
    if (layerPickerEl) layerPickerEl.style.display = 'none';
  }

  function ensureLayerPicker() {
    if (layerPickerEl) return layerPickerEl;
    layerPickerEl = document.createElement('div');
    layerPickerEl.id = 'mapLayerPicker';
    Object.assign(layerPickerEl.style, {
      position: 'fixed',
      left: '206px',
      top: '50%',
      zIndex: '10003',
      width: 'min(220px, calc(100vw - 32px))',
      display: 'none',
      flexDirection: 'column',
      gap: '4px',
      padding: '6px',
      borderRadius: '8px',
      background: 'rgba(20,20,20,0.92)',
      border: '1px solid rgba(255,255,255,0.24)',
      boxShadow: '0 18px 42px rgba(0,0,0,0.35)',
      color: '#fff',
      font: '600 14px system-ui, sans-serif'
    });
    document.body.appendChild(layerPickerEl);

    // Dismiss on outside click (but not when clicking the Layers button itself).
    document.addEventListener('mousedown', function (e) {
      if (!isLayerPickerVisible()) return;
      if (layerPickerEl.contains(e.target)) return;
      var btn = document.getElementById('mapLayersButton');
      if (btn && btn.contains(e.target)) return;
      hideLayerPicker();
    });
    document.addEventListener('keydown', function (e) {
      if (isLayerPickerVisible() && e.key === 'Escape') {
        e.preventDefault();
        hideLayerPicker();
      }
    });
    return layerPickerEl;
  }

  function renderLayerPicker() {
    var app = getMapApp();
    if (!app || typeof app.getThemeCycle !== 'function') return;
    var themes = app.getThemeCycle() || [];
    var activeTheme = typeof app.getActiveTheme === 'function' ? app.getActiveTheme() : '';
    var el = ensureLayerPicker();
    el.innerHTML = '';
    themes.forEach(function (key) {
      var item = document.createElement('button');
      item.type = 'button';
      item.textContent = layerLabel(key);
      var isActive = String(key) === String(activeTheme);
      Object.assign(item.style, {
        width: '100%',
        textAlign: 'left',
        padding: '9px 11px',
        borderRadius: '6px',
        border: '1px solid rgba(255,255,255,0.14)',
        background: isActive ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.10)',
        color: '#fff',
        cursor: 'pointer',
        font: '600 14px system-ui, sans-serif'
      });
      item.addEventListener('click', function () {
        if (app.setMapTheme) app.setMapTheme(key);
        renderLayerPicker(); // refresh active highlight
      });
      el.appendChild(item);
    });

    // Below the basemaps: the data layers activated for the current workshop
    // step (if any), behind a divider. Green = shown; clicking toggles the
    // layer mid-workshop without touching the step's authored selection.
    var dataLayers = typeof app.getDataLayerState === 'function' ? (app.getDataLayerState() || []) : [];
    if (dataLayers.length) {
      var sep = document.createElement('div');
      Object.assign(sep.style, { height: '1px', background: 'rgba(255,255,255,0.22)', margin: '4px 2px' });
      el.appendChild(sep);
      var cap = document.createElement('div');
      cap.textContent = 'Data layers';
      Object.assign(cap.style, {
        fontSize: '10px', fontWeight: '700', letterSpacing: '0.05em',
        textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', padding: '2px 4px'
      });
      el.appendChild(cap);
      dataLayers.forEach(function (l) {
        var item = document.createElement('button');
        item.type = 'button';
        item.textContent = l.label;
        item.title = (l.visible ? 'Hide ' : 'Show ') + l.label;
        Object.assign(item.style, {
          width: '100%',
          textAlign: 'left',
          padding: '9px 11px',
          borderRadius: '6px',
          border: '1px solid ' + (l.visible ? 'rgba(120,220,140,0.9)' : 'rgba(255,255,255,0.14)'),
          background: l.visible ? 'rgba(60,150,80,0.55)' : 'rgba(255,255,255,0.10)',
          color: '#fff',
          cursor: 'pointer',
          font: '600 14px system-ui, sans-serif'
        });
        item.addEventListener('click', function () {
          if (app.toggleDataLayer) app.toggleDataLayer(l.id);
          renderLayerPicker(); // refresh on/off state
        });
        el.appendChild(item);
      });
    }
  }

  function toggleLayerPicker() {
    var el = ensureLayerPicker();
    if (isLayerPickerVisible()) {
      hideLayerPicker();
      return;
    }
    renderLayerPicker();
    // Open the picker to the right of the Layers button in the left nav bar,
    // top-aligned with it (clamped so it never runs off the bottom edge).
    var btn = document.getElementById('mapLayersButton');
    if (btn && btn.getBoundingClientRect) {
      var r = btn.getBoundingClientRect();
      el.style.left = Math.round(r.right + 12) + 'px';
      el.style.top = Math.max(12, Math.round(r.top)) + 'px';
      el.style.bottom = 'auto';
    }
    el.style.display = 'flex';
    // Re-clamp against the bottom edge now that the content height is known
    // (the data-layer section can make the popup taller than the basemap list).
    var maxTop = window.innerHeight - el.offsetHeight - 12;
    if (parseInt(el.style.top, 10) > maxTop) {
      el.style.top = Math.max(12, Math.round(maxTop)) + 'px';
    }
  }

  window.CompactPageFlow = { createPageFlow: createPageFlow, confirmDialog: confirmDialog };
})();
