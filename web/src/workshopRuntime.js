(function () {
  // Runtime workshop player for the map page. Enters a facilitator-defined
  // workshop, applies each step's saved map view / theme / overlay visibility,
  // renders the step's static text labels, and drives the per-step machinery in
  // the placement modules (via window.CompactMapApp) so participant activity is
  // tagged with the active step and saved through the normal session flow.

  function isTextInputTarget(target) {
    var name = String((target && target.tagName) || '').toUpperCase();
    if (name === 'TEXTAREA' || name === 'SELECT' || !!(target && target.isContentEditable)) return true;
    if (name !== 'INPUT') return false;
    var type = String((target && target.type) || '').toLowerCase();
    return type !== 'range' && type !== 'button' && type !== 'checkbox' && type !== 'radio';
  }

  function clamp01(v) {
    v = Number(v);
    if (!Number.isFinite(v)) return 0;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  function createRuntime() {
    var app = null;                 // window.CompactMapApp
    var container = null;           // #main_container
    var labelsEl = null;            // overlay for static step labels
    var barEl = null;               // control bar (prev / indicator / next / exit)
    var pickerEl = null;            // workshop chooser shown from the map button
    var pickerListEl = null;
    var indicatorEl = null;
    var workshop = null;            // active workshop definition
    var stepIndex = 0;
    var active = false;
    var applySeq = 0;
    var togglesEl = null;           // row of per-step show/hide buttons in the bar
    // Step numbers whose inputs (drawings/stickers/annotations) are currently
    // shown. Facilitator-controlled via the bar toggles; remembered across
    // navigation. The current step is always kept visible.
    var visibleStepNumbers = new Set();

    function getApp() {
      if (!app) app = window.CompactMapApp || null;
      return app;
    }

    function ensureDom() {
      if (container) return;
      container = document.getElementById('main_container') || document.body;

      labelsEl = document.createElement('div');
      labelsEl.id = 'workshopLabels';
      Object.assign(labelsEl.style, {
        position: 'absolute', inset: '0', zIndex: '900',
        pointerEvents: 'none', display: 'none'
      });
      container.appendChild(labelsEl);

      barEl = document.createElement('div');
      barEl.id = 'workshopBar';
      Object.assign(barEl.style, {
        position: 'fixed', left: '50%', bottom: '18px', transform: 'translateX(-50%)',
        zIndex: '10001', display: 'none', alignItems: 'center', gap: '10px',
        padding: '8px 12px', borderRadius: '10px',
        background: 'rgba(20,20,20,0.82)', border: '1px solid rgba(255,255,255,0.25)',
        color: '#fff', font: '600 14px system-ui, sans-serif'
      });

      var prev = mkBtn('< Prev', function () { go(stepIndex - 1); });
      indicatorEl = document.createElement('span');
      indicatorEl.style.minWidth = '70px';
      indicatorEl.style.textAlign = 'center';
      var next = mkBtn('Next >', function () { go(stepIndex + 1); });
      var exit = mkBtn('Exit', function () { exitWorkshop(); });
      exit.style.marginLeft = '6px';
      exit.style.background = 'rgba(180,40,40,0.85)';

      // Per-step show/hide toggles (S1, S2, …). A thin divider separates them
      // from the navigation controls.
      var sep = document.createElement('span');
      Object.assign(sep.style, {
        width: '1px', alignSelf: 'stretch', margin: '0 2px',
        background: 'rgba(255,255,255,0.22)'
      });
      var togglesLabel = document.createElement('span');
      togglesLabel.textContent = 'Inputs:';
      togglesLabel.style.opacity = '0.78';
      togglesLabel.style.fontSize = '12px';
      togglesEl = document.createElement('span');
      Object.assign(togglesEl.style, { display: 'inline-flex', gap: '4px', flexWrap: 'wrap' });

      barEl.appendChild(prev);
      barEl.appendChild(indicatorEl);
      barEl.appendChild(next);
      barEl.appendChild(sep);
      barEl.appendChild(togglesLabel);
      barEl.appendChild(togglesEl);
      barEl.appendChild(exit);
      document.body.appendChild(barEl);

      pickerEl = document.createElement('div');
      pickerEl.id = 'workshopPicker';
      Object.assign(pickerEl.style, {
        position: 'fixed',
        left: '92px',
        bottom: '68px',
        zIndex: '10003',
        width: 'min(320px, calc(100vw - 32px))',
        maxHeight: 'min(430px, calc(100vh - 110px))',
        display: 'none',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRadius: '8px',
        background: 'rgba(20,20,20,0.92)',
        border: '1px solid rgba(255,255,255,0.24)',
        boxShadow: '0 18px 42px rgba(0,0,0,0.35)',
        color: '#fff',
        font: '600 14px system-ui, sans-serif'
      });
      var pickerHead = document.createElement('div');
      Object.assign(pickerHead.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '10px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.16)'
      });
      var pickerTitle = document.createElement('div');
      pickerTitle.textContent = 'Select workshop';
      pickerTitle.style.flex = '1';
      // "+ New" opens the in-map workshop editor to author a new one.
      var pickerNew = mkBtn('+ New', function () {
        hidePicker();
        if (window.DigitalMappingWorkshopEditor && typeof window.DigitalMappingWorkshopEditor.openNew === 'function') {
          window.DigitalMappingWorkshopEditor.openNew();
        }
      });
      Object.assign(pickerNew.style, {
        padding: '5px 11px', fontSize: '12px',
        background: 'rgba(47,143,134,0.9)', borderColor: 'rgba(53,160,148,0.95)'
      });
      var pickerClose = mkBtn('Close', hidePicker);
      Object.assign(pickerClose.style, {
        padding: '5px 9px',
        fontSize: '12px'
      });
      pickerHead.appendChild(pickerTitle);
      pickerHead.appendChild(pickerNew);
      pickerHead.appendChild(pickerClose);

      pickerListEl = document.createElement('div');
      Object.assign(pickerListEl.style, {
        overflowY: 'auto',
        padding: '6px'
      });
      pickerEl.appendChild(pickerHead);
      pickerEl.appendChild(pickerListEl);
      document.body.appendChild(pickerEl);

      document.addEventListener('mousedown', function (e) {
        if (!isPickerVisible()) return;
        if (pickerEl.contains(e.target)) return;
        var btn = document.getElementById('mapWorkshopButton');
        if (btn && btn.contains(e.target)) return;
        hidePicker();
      });
    }

    function mkBtn(text, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      Object.assign(b.style, {
        padding: '6px 12px', font: '600 14px system-ui, sans-serif', color: '#fff',
        background: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.3)',
        borderRadius: '7px', cursor: 'pointer'
      });
      b.addEventListener('click', onClick);
      return b;
    }

    // Step number for the step at index i (falls back to i+1).
    function stepNumberAt(i) {
      var steps = (workshop && Array.isArray(workshop.steps)) ? workshop.steps : [];
      var s = steps[i];
      return s ? (Number(s.id) || (i + 1)) : (i + 1);
    }

    // Push the current visible-steps set to the placement modules.
    function applyVisibleSteps() {
      var a = getApp();
      if (!a) return;
      var workshopId = (workshop && workshop.id) || '';
      var arr = [];
      visibleStepNumbers.forEach(function (n) { arr.push(n); });
      if (a.setVisibleWorkshopSteps) {
        a.setVisibleWorkshopSteps(arr, workshopId);
      } else if (a.setVisibleWorkshopStep) {
        // Fallback for older host: can only show one step.
        a.setVisibleWorkshopStep(arr.length ? arr[0] : null, workshopId);
      }
    }

    // Build the S1/S2/… toggle buttons for the active workshop's steps.
    function renderStepToggles() {
      if (!togglesEl) return;
      togglesEl.innerHTML = '';
      var steps = (workshop && Array.isArray(workshop.steps)) ? workshop.steps : [];
      for (var i = 0; i < steps.length; i++) {
        (function (idx) {
          var num = stepNumberAt(idx);
          var on = visibleStepNumbers.has(num);
          var b = document.createElement('button');
          b.type = 'button';
          b.textContent = 'S' + (idx + 1);
          b.title = (on ? 'Hide' : 'Show') + ' Step ' + (idx + 1) + ' inputs';
          Object.assign(b.style, {
            padding: '5px 9px', font: '600 13px system-ui, sans-serif',
            color: '#fff', borderRadius: '6px', cursor: 'pointer',
            border: '1px solid ' + (on ? 'rgba(120,220,140,0.9)' : 'rgba(255,255,255,0.28)'),
            background: on ? 'rgba(60,150,80,0.55)' : 'rgba(255,255,255,0.10)'
          });
          b.addEventListener('click', function () {
            if (visibleStepNumbers.has(num)) visibleStepNumbers.delete(num);
            else visibleStepNumbers.add(num);
            renderStepToggles();
            applyVisibleSteps();
          });
          togglesEl.appendChild(b);
        })(i);
      }
    }

    function renderLabels(step) {
      if (!labelsEl) return;
      labelsEl.innerHTML = '';
      var labels = (step && Array.isArray(step.labels)) ? step.labels : [];
      var rect = (container && container.getBoundingClientRect) ? container.getBoundingClientRect() : { width: 0, height: 0 };
      for (var i = 0; i < labels.length; i++) {
        var l = labels[i] || {};
        var el = document.createElement('div');
        el.textContent = String(l.text || '');
        var op = clamp01(l.bgOpacity != null ? l.bgOpacity : 0.6);
        Object.assign(el.style, {
          position: 'absolute',
          left: (clamp01(l.xPct) * 100) + '%',
          top: (clamp01(l.yPct) * 100) + '%',
          transform: 'translate(-50%, -50%)',
          maxWidth: '70%',
          padding: '6px 10px',
          borderRadius: '6px',
          color: '#fff',
          background: 'rgba(0,0,0,' + op + ')',
          fontSize: (Number(l.fontSize) || 20) + 'px',
          fontWeight: '600',
          lineHeight: '1.25',
          whiteSpace: 'pre-wrap',
          pointerEvents: 'none',
          textShadow: '0 1px 2px rgba(0,0,0,0.6)'
        });
        labelsEl.appendChild(el);
      }
    }

    function applyStep(i) {
      var steps = (workshop && Array.isArray(workshop.steps)) ? workshop.steps : [];
      if (!steps.length) return;
      stepIndex = Math.max(0, Math.min(i, steps.length - 1));
      var step = steps[stepIndex];
      var seq = ++applySeq;
      var a = getApp();
      if (a) {
        var stepNumber = Number(step.id) || (stepIndex + 1);
        var workshopId = workshop.id || '';
        if (a.setWorkshopStep) a.setWorkshopStep(stepNumber);
        // Indoor steps use a floorplan basemap (the step's chosen plan, or the
        // default); outdoor steps use the step's layer (streets/satellite/topo).
        if (step.indoor && a.setIndoorFloorplan) a.setIndoorFloorplan(step.indoorId || '');
        var stepLayer = step.indoor ? 'floorplan' : (step.theme || 'streets');
        if (a.setMapTheme) a.setMapTheme(stepLayer);
        // Restore the step's saved camera (outdoor and indoor alike — the
        // floorplan lives in real lng/lat, so a saved indoor view is valid and
        // includes its rotation/zoom). Indoor steps with NO saved view are
        // framed by the floorplan basemap's auto-fit instead.
        if (step.mapView && a.applyStepView) a.applyStepView(step.mapView);
        // The current step's inputs are always visible; previously-toggled
        // steps stay visible too (remembered across navigation).
        visibleStepNumbers.add(stepNumber);
        renderStepToggles();
        var applyStepState = function () {
          if (!active || !workshop || seq !== applySeq) return;
          if (a.setOverlayVisibility) {
            a.setOverlayVisibility(Object.assign({ drawings: true }, step.overlays || {}));
          }
          if (a.setWorkshopStep) a.setWorkshopStep(stepNumber);
          applyVisibleSteps();
        };
        if (a.whenStyleReady) {
          a.whenStyleReady(applyStepState);
        } else {
          applyStepState();
        }
      }
      renderLabels(step);
      if (indicatorEl) {
        indicatorEl.textContent = 'S' + (stepIndex + 1) + ' (' + (stepIndex + 1) + '/' + steps.length + ')';
      }
    }

    function go(i) {
      if (!active) return;
      var steps = (workshop && Array.isArray(workshop.steps)) ? workshop.steps : [];
      var target = Math.max(0, Math.min(i, steps.length - 1));
      // Autosave the run before changing steps, so progress is captured even if
      // the facilitator forgets to save at the end. The first transition creates
      // the session file; later transitions update that same file (quiet = no
      // UI note for these background saves).
      if (target !== stepIndex) {
        var a = getApp();
        if (a && typeof a.persistWorkshopSession === 'function') {
          a.persistWorkshopSession({ quiet: true });
        }
      }
      applyStep(i);
    }

    function notifyActiveChange() {
      try {
        window.dispatchEvent(new CustomEvent('digital-mapping-workshop-activechange', {
          detail: { active: active }
        }));
      } catch (_err) {}
    }

    function isPickerVisible() {
      return !!(pickerEl && pickerEl.style.display !== 'none');
    }

    function hidePicker() {
      if (pickerEl) pickerEl.style.display = 'none';
    }

    // Anchor the picker beside the Workshop button in the left nav bar,
    // top-aligned with it (clamped so it never runs off the bottom edge).
    function anchorPicker() {
      var btn = document.getElementById('mapWorkshopButton');
      if (!pickerEl || !btn || !btn.getBoundingClientRect) return;
      var r = btn.getBoundingClientRect();
      pickerEl.style.left = Math.round(r.right + 12) + 'px';
      pickerEl.style.top = Math.max(12, Math.min(Math.round(r.top), window.innerHeight - 450)) + 'px';
      pickerEl.style.bottom = 'auto';
    }

    function showPicker(list) {
      ensureDom();
      pickerListEl.innerHTML = '';
      for (var i = 0; i < list.length; i++) {
        (function (w, idx) {
          var steps = Array.isArray(w.steps) ? w.steps.length : 0;
          var item = document.createElement('button');
          item.type = 'button';
          Object.assign(item.style, {
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            margin: '0 0 6px',
            padding: '10px 11px',
            borderRadius: '6px',
            border: '1px solid rgba(255,255,255,0.14)',
            background: active && workshop && String(workshop.id || '') === String(w.id || '')
              ? 'rgba(255,255,255,0.24)'
              : 'rgba(255,255,255,0.10)',
            color: '#fff',
            cursor: 'pointer',
            textAlign: 'left',
            font: '600 14px system-ui, sans-serif'
          });
          var name = document.createElement('span');
          name.textContent = w.name || ('Workshop ' + (idx + 1));
          name.style.overflow = 'hidden';
          name.style.textOverflow = 'ellipsis';
          name.style.whiteSpace = 'nowrap';
          var count = document.createElement('span');
          count.textContent = steps + (steps === 1 ? ' step' : ' steps');
          count.style.flex = '0 0 auto';
          count.style.opacity = '0.78';
          count.style.fontSize = '12px';
          item.appendChild(name);
          item.appendChild(count);
          item.addEventListener('click', function () {
            hidePicker();
            startWorkshop(w);
          });
          pickerListEl.appendChild(item);
        })(list[i], i);
      }
      anchorPicker();
      pickerEl.style.display = 'flex';
    }

    function toast(msg) {
      var t = document.createElement('div');
      t.textContent = msg;
      Object.assign(t.style, {
        position: 'fixed', left: '50%', top: '20px', transform: 'translateX(-50%)',
        zIndex: '10002', padding: '10px 16px', borderRadius: '8px',
        background: 'rgba(20,20,20,0.9)', color: '#fff', font: '600 14px system-ui, sans-serif'
      });
      document.body.appendChild(t);
      window.setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
    }

    function enter() {
      ensureDom();
      pickerListEl.innerHTML = '';
      var loading = document.createElement('div');
      loading.textContent = 'Loading workshops...';
      Object.assign(loading.style, { padding: '12px', color: 'rgba(255,255,255,0.78)' });
      pickerListEl.appendChild(loading);
      anchorPicker();
      pickerEl.style.display = 'flex';
      fetch('/api/workshops', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var list = (data && Array.isArray(data.workshops)) ? data.workshops : [];
          list = list.filter(function (w) { return w && Array.isArray(w.steps) && w.steps.length; });
          if (!list.length) {
            hidePicker();
            toast('No workshops defined. Create one in Settings > Workshop.');
            return;
          }
          showPicker(list);
        })
        .catch(function () {
          hidePicker();
          toast('Failed to load workshops.');
        });
    }

    function startWorkshop(def) {
      ensureDom();
      workshop = def;
      active = true;
      notifyActiveChange();
      stepIndex = 0;
      // Fresh run: no steps toggled on yet (applyStep(0) adds the first step).
      visibleStepNumbers = new Set();
      labelsEl.style.display = 'block';
      barEl.style.display = 'flex';
      var a = getApp();
      if (a && a.setWorkshopContext) a.setWorkshopContext(def.id || '');
      if (a && a.setWorkshopMeta) {
        a.setWorkshopMeta({ workshopId: def.id || '', workshopName: def.name || '' });
      }
      // Fresh save target: the run's first persist creates a new session file,
      // subsequent step transitions update it.
      if (a && a.beginWorkshopSession) a.beginWorkshopSession();
      applyStep(0);
    }

    // Exit flow: confirm whether to save the workshop's inputs as a session
    // (visible on the results page) before leaving. Uses the shared styled
    // dialog (same look as Back-to-menu), falling back to a plain exit if the
    // dialog/host aren't available.
    function exitWorkshop() {
      if (!active) return;
      var a = getApp();
      var pf = window.CompactPageFlow;
      var canSave = !!(a && typeof a.saveSession === 'function');
      if (pf && typeof pf.confirmDialog === 'function' && canSave) {
        pf.confirmDialog({
          title: 'Save workshop inputs before exiting?',
          confirmText: 'Save & exit',
          confirmColor: 'green',
          thirdText: 'Exit without saving',
          cancelText: 'Cancel',
          onConfirm: function () {
            a.saveSession(function () { doExitWorkshop(); });
          },
          onThird: function () { doExitWorkshop(); }
          // onCancel: stay in the workshop (no-op).
        });
        return;
      }
      // No dialog/save available — exit directly.
      doExitWorkshop();
    }

    function doExitWorkshop() {
      if (!active) return;
      active = false;
      workshop = null;
      applySeq++;
      notifyActiveChange();
      hidePicker();
      if (labelsEl) { labelsEl.style.display = 'none'; labelsEl.innerHTML = ''; }
      if (barEl) barEl.style.display = 'none';
      var a = getApp();
      if (a) {
        if (a.setVisibleWorkshopStep) a.setVisibleWorkshopStep(null, '');
        if (a.setWorkshopContext) a.setWorkshopContext('');
        if (a.setWorkshopMeta) a.setWorkshopMeta(null);
        if (a.setWorkshopStep) a.setWorkshopStep(0);
        // Restore full overlay visibility on exit.
        if (a.setOverlayVisibility) a.setOverlayVisibility({ roads: null, drawings: true, stickers: true, annotations: true });
      }
    }

    window.addEventListener('keydown', function (e) {
      if (isPickerVisible()) {
        if (e.key === 'Escape') {
          e.preventDefault();
          hidePicker();
        }
        return;
      }
      if (!active) return;
      if (isTextInputTarget(e.target)) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); go(stepIndex + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(stepIndex - 1); }
      else if (e.key === 'Escape') { e.preventDefault(); exitWorkshop(); }
    });

    return {
      enter: enter,
      exit: exitWorkshop,
      next: function () { go(stepIndex + 1); },
      prev: function () { go(stepIndex - 1); },
      isActive: function () { return active; }
    };
  }

  window.DigitalMappingWorkshopRuntime = createRuntime();
})();
