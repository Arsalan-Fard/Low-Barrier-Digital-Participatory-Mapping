(function () {
  function createPageFlow() {
    var lastX = -1;
    var lastY = -1;
    var hoverPanel = false;

    function goBackHome() {
      confirmDialog({
        title: 'Leave this page?',
        message: 'You will return to the main menu. Make sure to save your work first.',
        confirmText: 'Leave',
        cancelText: 'Cancel',
        danger: true,
        onConfirm: function () {
          window.location.href = '/home?setup';
        }
      });
    }

    function pointerNearTopLeft(x, y) {
      return Number.isFinite(x) && Number.isFinite(y) && x <= 260 && y <= 84;
    }

    function refreshVisibility() {
      var panel = document.getElementById('wsEditPanel');
      if (!panel) return;
      var running = !!(window.CompactWorkshopRuntime && window.CompactWorkshopRuntime.isActive());
      var hide = running && !hoverPanel && !pointerNearTopLeft(lastX, lastY);
      panel.classList.toggle('workshop-hidden', hide);
    }

    var panel = window.CompactWorkshopEditor.mount({ onBack: goBackHome });

    panel.addEventListener('mouseenter', function () {
      hoverPanel = true;
      refreshVisibility();
    });
    panel.addEventListener('mouseleave', function () {
      hoverPanel = false;
      refreshVisibility();
    });
    window.addEventListener('mousemove', function (e) {
      lastX = e.clientX;
      lastY = e.clientY;
      refreshVisibility();
    });

    // Catch up when a workshop starts or stops.
    setInterval(refreshVisibility, 250);
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
      color: 'var(--ui-ink)', font: '600 14px system-ui, sans-serif',
      background: 'var(--ui-panel)', border: '1px solid var(--ui-line-strong)'
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
      background: 'rgba(22,48,43,0.35)'
    });

    var box = document.createElement('div');
    box.id = 'compactConfirmBox';
    Object.assign(box.style, {
      width: 'min(360px, calc(100vw - 32px))',
      borderRadius: '10px',
      background: 'var(--ui-panel)',
      border: '1px solid var(--ui-line)',
      boxShadow: '0 18px 42px rgba(22,48,43,0.25)',
      color: 'var(--ui-ink)',
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
      color: 'var(--ui-muted)', marginBottom: '16px'
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
      confirmBtn.style.color = '#fff';
      confirmBtn.style.background = 'var(--ui-green)';
      confirmBtn.style.borderColor = 'var(--ui-green-dark)';
    } else if (opts.danger) {
      confirmBtn.style.color = '#fff';
      confirmBtn.style.background = 'var(--ui-danger)';
      confirmBtn.style.borderColor = 'var(--ui-danger)';
    } else {
      confirmBtn.style.color = 'var(--ui-ink)';
      confirmBtn.style.background = 'var(--ui-panel)';
      confirmBtn.style.borderColor = 'var(--ui-line-strong)';
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

  window.CompactPageFlow = { createPageFlow: createPageFlow, confirmDialog: confirmDialog };
})();
