(function () {
  function isTextInputTarget(target) {
    const name = String((target && target.tagName) || '').toUpperCase();
    if (name === 'TEXTAREA' || name === 'SELECT' || !!(target && target.isContentEditable)) return true;
    if (name !== 'INPUT') return false;
    const type = String((target && target.type) || '').toLowerCase();
    return type !== 'range' && type !== 'button' && type !== 'checkbox' && type !== 'radio';
  }

  function createPageFlow(options) {
    function goBackHome() {
      confirmDialog({
        title: 'Leave this page?',
        message: 'You will return to the main menu. Make sure to save your work first.',
        confirmText: 'Leave',
        cancelText: 'Cancel',
        danger: true,
        onConfirm: function () {
          options.onBackToCamera();
          window.location.href = '/home?setup';
        }
      });
    }

    function toggleWorkshop() {
      window.dispatchEvent(new CustomEvent('compact-workshop-toggle-request'));
    }

    function toggleRecord() {
      window.CompactMapApp.toggleRecording();
      refreshRecordButton();
    }

    // Red disc when idle, red square while recording.
    function refreshRecordButton() {
      const btn = document.getElementById('mapRecordButton');
      const recording = window.CompactMapApp.isRecording();
      btn.querySelector('.rec-icon').style.borderRadius = recording ? '2px' : '50%';
      btn.setAttribute('aria-label', recording ? 'Stop recording' : 'Start recording');
      btn.lastChild.textContent = recording ? 'Stop' : 'Record';
    }

    window.addEventListener('keydown', function (e) {
      if (e.repeat) return;
      if (isTextInputTarget(e.target)) return;
      const key = String(e.key || '').toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        goBackHome();
      } else if (key === 'w') {
        e.preventDefault();
        toggleWorkshop();
      }
    });

    createCornerButtons({
      onBack: goBackHome,
      onWorkshop: toggleWorkshop,
      onLayers: toggleLayerPicker,
      onLight: function () { window.CompactMapApp.toggleLightSettings(); },
      onRecord: toggleRecord
    });
    // Recording can also be toggled elsewhere (the 'y' key).
    setInterval(refreshRecordButton, 700);
  }

  // Left-edge nav bar. It stays hidden so the projected map is clean, slides
  // in when the mouse reaches the left edge (a slim handle marks the spot) and
  // slides out again when the mouse moves away.
  function createCornerButtons(opts) {
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

    // Reveal when the cursor touches the left edge; stay open while it is near
    // the bar, where the pickers open.
    const REVEAL_X = 48;
    const KEEP_X = 300;
    let visible = true;
    let lastMouseX = window.innerWidth;

    function anyPickerOpen() {
      const layerPicker = document.getElementById('mapLayerPicker');
      if (layerPicker && layerPicker.style.display !== 'none') return true;
      const wsPicker = document.getElementById('workshopPicker');
      return !!(wsPicker && wsPicker.style.display && wsPicker.style.display !== 'none');
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
        onClick();
      });
      btn.addEventListener('mouseenter', function () { setVisible(true); });
      bar.appendChild(btn);
      return btn;
    }

    const backButton = makeButton('mapBackButton', 'Back', 'Back to main menu', opts.onBack);
    Object.assign(backButton.style, {
      color: '#ffe8e8',
      background: 'rgba(166, 58, 58, 0.28)',
      borderColor: 'rgba(255, 132, 132, 0.48)'
    });
    makeButton('mapWorkshopButton', 'Workshop', 'Workshops: play or create', opts.onWorkshop);
    makeButton('mapLayersButton', 'Layers', 'Switch basemap layer', opts.onLayers);
    makeButton('mapLightButton', 'Light', 'Light settings (brightness, saturation, contrast)', opts.onLight);

    const recordButton = makeButton('mapRecordButton', '', 'Start recording', opts.onRecord);
    Object.assign(recordButton.style, { display: 'inline-flex', alignItems: 'center', gap: '7px' });
    const icon = document.createElement('span');
    icon.className = 'rec-icon';
    Object.assign(icon.style, {
      width: '12px', height: '12px', background: '#e23b3b',
      borderRadius: '50%', display: 'inline-block', transition: 'border-radius 0.12s ease',
      flex: '0 0 auto'
    });
    const label = document.createElement('span');
    label.textContent = 'Record';
    recordButton.appendChild(icon);
    recordButton.appendChild(label);

    window.addEventListener('mousemove', function (e) {
      lastMouseX = e.clientX;
      setVisible(shouldShowAt(lastMouseX));
    });

    bar.addEventListener('mouseleave', function (e) {
      setVisible(shouldShowAt(e.clientX));
    });

    // Shown briefly on load so it can be found, then tucked away.
    window.setTimeout(function () {
      setVisible(shouldShowAt(lastMouseX));
    }, 2800);
  }

  // A styled replacement for window.confirm(), with an optional third button
  // for flows like Save / Don't save / Cancel.
  var confirmEl = null;
  var confirmCallbacks = {};

  function closeConfirm(outcome) {
    confirmEl.style.display = 'none';
    var callback = confirmCallbacks[outcome];
    confirmCallbacks = {};
    if (typeof callback === 'function') callback();
  }

  function dialogButton(id, outcome) {
    var btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    Object.assign(btn.style, {
      padding: '8px 16px', borderRadius: '7px', cursor: 'pointer',
      color: '#fff', font: '600 14px system-ui, sans-serif',
      background: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.3)'
    });
    btn.addEventListener('click', function () { closeConfirm(outcome); });
    return btn;
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

    var thirdBtn = dialogButton('compactConfirmThird', 'third');
    thirdBtn.style.display = 'none';
    actions.appendChild(dialogButton('compactConfirmCancel', 'cancel'));
    actions.appendChild(thirdBtn);
    actions.appendChild(dialogButton('compactConfirmAccept', 'confirm'));
    box.appendChild(titleEl);
    box.appendChild(msgEl);
    box.appendChild(actions);
    confirmEl.appendChild(box);
    document.body.appendChild(confirmEl);

    // Backdrop click or Esc cancels, Enter confirms.
    confirmEl.addEventListener('mousedown', function (e) {
      if (e.target === confirmEl) closeConfirm('cancel');
    });
    document.addEventListener('keydown', function (e) {
      if (confirmEl.style.display === 'none') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeConfirm('cancel');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        closeConfirm('confirm');
      }
    });

    return confirmEl;
  }

  function confirmDialog(opts) {
    var el = ensureConfirmDialog();
    var titleEl = el.querySelector('#compactConfirmTitle');
    titleEl.textContent = opts.title || 'Are you sure?';
    // Without a message the title takes the gap above the buttons.
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
    confirmCallbacks = { confirm: opts.onConfirm, cancel: opts.onCancel, third: opts.onThird };
    el.style.display = 'flex';
  }

  // Basemap picker, opened from the Layers button: the basemaps from
  // CompactMapApp.getThemeCycle(), then the current workshop part's data layers.
  var LAYER_LABELS = {
    streets: 'Streets',
    satellite: 'Satellite',
    topo: 'Topographic',
    paper: 'Paper map'
  };

  function layerLabel(key) {
    if (LAYER_LABELS[key]) return LAYER_LABELS[key];
    var text = String(key || '');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  var layerPickerEl = null;

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

    // An outside click closes it, except on the Layers button, which toggles it.
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

  function pickerItem(text, border, background, onClick) {
    var item = document.createElement('button');
    item.type = 'button';
    item.textContent = text;
    Object.assign(item.style, {
      width: '100%',
      textAlign: 'left',
      padding: '9px 11px',
      borderRadius: '6px',
      border: '1px solid ' + border,
      background: background,
      color: '#fff',
      cursor: 'pointer',
      font: '600 14px system-ui, sans-serif'
    });
    item.addEventListener('click', onClick);
    return item;
  }

  function renderLayerPicker() {
    var app = window.CompactMapApp;
    var activeTheme = String(app.getActiveTheme());
    var el = ensureLayerPicker();
    el.innerHTML = '';
    app.getThemeCycle().forEach(function (key) {
      var background = String(key) === activeTheme ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.10)';
      el.appendChild(pickerItem(layerLabel(key), 'rgba(255,255,255,0.14)', background, function () {
        app.setMapTheme(key);
        renderLayerPicker();
      }));
    });

    // Green = shown. A click hides or shows the layer until the next part
    // starts; the part's own selection stays as authored.
    var dataLayers = app.getDataLayerState();
    if (!dataLayers.length) return;
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
      var border = l.visible ? 'rgba(120,220,140,0.9)' : 'rgba(255,255,255,0.14)';
      var background = l.visible ? 'rgba(60,150,80,0.55)' : 'rgba(255,255,255,0.10)';
      var item = pickerItem(l.label, border, background, function () {
        app.toggleDataLayer(l.id);
        renderLayerPicker();
      });
      item.title = (l.visible ? 'Hide ' : 'Show ') + l.label;
      el.appendChild(item);
    });
  }

  function toggleLayerPicker() {
    var el = ensureLayerPicker();
    if (isLayerPickerVisible()) {
      hideLayerPicker();
      return;
    }
    renderLayerPicker();
    // Beside the Layers button, top-aligned with it.
    var btn = document.getElementById('mapLayersButton');
    var r = btn.getBoundingClientRect();
    el.style.left = Math.round(r.right + 12) + 'px';
    el.style.top = Math.max(12, Math.round(r.top)) + 'px';
    el.style.bottom = 'auto';
    el.style.display = 'flex';
    // Keep it above the bottom edge now that its height is known.
    var maxTop = window.innerHeight - el.offsetHeight - 12;
    if (parseInt(el.style.top, 10) > maxTop) {
      el.style.top = Math.max(12, Math.round(maxTop)) + 'px';
    }
  }

  window.CompactPageFlow = { createPageFlow: createPageFlow, confirmDialog: confirmDialog };
})();
