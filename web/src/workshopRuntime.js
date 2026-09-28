(function () {
  // Plays a workshop on the map page: each part's saved view, basemap, data
  // layers and on-screen texts and images. Through window.CompactMapApp the
  // participants' input is tagged with the current part and saved as a session.

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
    return Math.max(0, Math.min(1, v));
  }

  function createRuntime() {
    var container = null;
    var labelsEl = null;
    var barEl = null;
    var pickerEl = null;
    var pickerListEl = null;
    var indicatorEl = null;
    var barHandleEl = null;
    var barHideTimer = 0;
    var lastPointerX = -1;
    var lastPointerY = -1;
    var workshop = null;
    var stepIndex = 0;
    var active = false;
    var applySeq = 0;
    var pickerRequestSeq = 0;
    var togglesEl = null;
    // Parts whose inputs are shown: the current part always, others through the
    // bar's P1, P2... toggles, remembered while moving between parts.
    var visibleStepNumbers = new Set();

    function getApp() {
      return window.CompactMapApp;
    }

    function currentSteps() {
      return (workshop && Array.isArray(workshop.steps)) ? workshop.steps : [];
    }

    function pointerNearBottomCenter(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      var barWidth = barEl.offsetWidth || 520;
      var halfWidth = Math.max(260, Math.min(window.innerWidth * 0.45, barWidth * 0.5 + 48));
      return y >= window.innerHeight - 110
        && Math.abs(x - window.innerWidth * 0.5) <= halfWidth;
    }

    function setBarVisible(visible) {
      barEl.style.transform = visible
        ? 'translate(-50%, 0)'
        : 'translate(-50%, calc(100% + 24px))';
      barEl.style.opacity = visible ? '1' : '0';
      barEl.style.pointerEvents = visible ? 'auto' : 'none';
      barHandleEl.style.display = active ? 'block' : 'none';
      barHandleEl.style.opacity = visible ? '0' : '0.72';
    }

    function scheduleBarAutoHide() {
      if (barHideTimer) window.clearTimeout(barHideTimer);
      barHideTimer = window.setTimeout(function () {
        barHideTimer = 0;
        if (active && !pointerNearBottomCenter(lastPointerX, lastPointerY)) {
          setBarVisible(false);
        }
      }, 1800);
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
        position: 'fixed', left: '50%', bottom: '18px', transform: 'translate(-50%, 0)',
        zIndex: '10001', display: 'none', alignItems: 'center', gap: '10px',
        padding: '8px 12px', borderRadius: '10px',
        background: 'rgba(20,20,20,0.82)', border: '1px solid rgba(255,255,255,0.25)',
        color: '#fff', font: '600 14px system-ui, sans-serif',
        transition: 'transform 0.2s ease, opacity 0.2s ease'
      });

      var prev = mkBtn('← Previous part', function () { go(stepIndex - 1); });
      indicatorEl = document.createElement('span');
      indicatorEl.style.minWidth = '70px';
      indicatorEl.style.textAlign = 'center';
      var next = mkBtn('Next part →', function () { go(stepIndex + 1); });
      var exit = mkBtn('Exit', function () { exitWorkshop(); });
      exit.style.marginLeft = '6px';
      exit.style.background = 'rgba(180,40,40,0.85)';

      var sep = document.createElement('span');
      Object.assign(sep.style, {
        width: '1px', alignSelf: 'stretch', margin: '0 2px',
        background: 'rgba(255,255,255,0.22)'
      });
      var togglesLabel = document.createElement('span');
      togglesLabel.textContent = 'Showing inputs:';
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

      barHandleEl = document.createElement('div');
      barHandleEl.id = 'workshopBarHandle';
      barHandleEl.setAttribute('aria-hidden', 'true');
      Object.assign(barHandleEl.style, {
        position: 'fixed', left: '50%', bottom: '0', transform: 'translateX(-50%)',
        zIndex: '10000', width: '84px', height: '6px', display: 'none',
        borderRadius: '6px 6px 0 0', background: 'rgba(20,20,20,0.78)',
        border: '1px solid rgba(255,255,255,0.42)', borderBottom: 'none',
        boxSizing: 'border-box', opacity: '0', pointerEvents: 'none',
        transition: 'opacity 0.2s ease'
      });
      document.body.appendChild(barHandleEl);

      barEl.addEventListener('mouseenter', function () { setBarVisible(true); });
      window.addEventListener('mousemove', function (e) {
        lastPointerX = e.clientX;
        lastPointerY = e.clientY;
        if (!active) return;
        setBarVisible(pointerNearBottomCenter(lastPointerX, lastPointerY));
      });

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
      var listBtn = mkBtn('Workshop List', function () {
        hidePicker();
        window.CompactWorkshopEditor.open();
      });
      Object.assign(listBtn.style, {
        padding: '5px 11px', fontSize: '12px',
        background: 'rgba(47,143,134,0.9)', borderColor: 'rgba(53,160,148,0.95)'
      });
      var pickerClose = mkBtn('Close', hidePicker);
      Object.assign(pickerClose.style, {
        padding: '5px 9px',
        fontSize: '12px'
      });
      pickerHead.appendChild(pickerTitle);
      pickerHead.appendChild(listBtn);
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

    function stepNumberAt(i) {
      var step = currentSteps()[i];
      return step ? (Number(step.id) || (i + 1)) : (i + 1);
    }

    function applyVisibleSteps() {
      getApp().setVisibleWorkshopSteps(Array.from(visibleStepNumbers), workshop.id || '');
    }

    function renderStepToggles() {
      togglesEl.innerHTML = '';
      currentSteps().forEach(function (_step, idx) {
        var num = stepNumberAt(idx);
        var on = visibleStepNumbers.has(num);
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'P' + (idx + 1);
        b.title = (on ? 'Hide' : 'Show') + ' Part ' + (idx + 1) + ' inputs';
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
      });
    }

    function renderLabels(step) {
      labelsEl.innerHTML = '';
      var labels = (step && Array.isArray(step.labels)) ? step.labels : [];
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
      var images = (step && Array.isArray(step.images)) ? step.images : [];
      for (var j = 0; j < images.length; j++) {
        var image = images[j] || {};
        if (!image.src) continue;
        var imageEl = document.createElement('img');
        imageEl.src = String(image.src);
        imageEl.alt = String(image.name || 'Workshop image');
        var widthPct = Math.max(0.05, Math.min(0.8, Number(image.widthPct) || 0.2));
        Object.assign(imageEl.style, {
          position: 'absolute',
          left: (clamp01(image.xPct) * 100) + '%',
          top: (clamp01(image.yPct) * 100) + '%',
          width: (widthPct * 100) + '%',
          height: 'auto', transform: 'translate(-50%, -50%)',
          pointerEvents: 'none', userSelect: 'none'
        });
        labelsEl.appendChild(imageEl);
      }
    }

    function applyStep(i) {
      var steps = currentSteps();
      if (!steps.length) return;
      stepIndex = Math.max(0, Math.min(i, steps.length - 1));
      var step = steps[stepIndex];
      var seq = ++applySeq;
      var a = getApp();
      var stepNumber = Number(step.id) || (stepIndex + 1);
      a.setWorkshopStep(stepNumber);
      // Indoor parts show a floorplan basemap: the part's plan, or the default.
      if (step.indoor) a.setIndoorFloorplan(step.indoorId || '');
      var layer = step.indoor ? 'floorplan' : (step.theme || 'streets');
      a.setMapTheme(layer);
      // Indoor views are real lng/lat too. An indoor part without a saved view
      // is framed by the floorplan's own fit instead.
      if (step.mapView) a.applyStepView(step.mapView);
      visibleStepNumbers.add(stepNumber);
      renderStepToggles();
      a.whenStyleReady(function () {
        if (!active || !workshop || seq !== applySeq) return;
        a.setOverlayVisibility(Object.assign({ drawings: true }, step.overlays || {}));
        a.setDataLayers(Array.isArray(step.dataLayers) ? step.dataLayers : []);
        a.setWorkshopStep(stepNumber);
        applyVisibleSteps();
      });
      renderLabels(step);
      indicatorEl.textContent = 'P' + (stepIndex + 1) + ' (' + (stepIndex + 1) + '/' + steps.length + ')';
    }

    function go(i) {
      if (!active) return;
      var target = Math.max(0, Math.min(i, currentSteps().length - 1));
      // Autosave on every change of part, so progress survives a forgotten save.
      if (target !== stepIndex) getApp().persistWorkshopSession({ quiet: true });
      applyStep(i);
    }

    function isPickerVisible() {
      return !!(pickerEl && pickerEl.style.display !== 'none');
    }

    function hidePicker() {
      pickerRequestSeq++;
      if (pickerEl) pickerEl.style.display = 'none';
    }

    // Beside the Workshop button, top-aligned with it and kept off the bottom edge.
    function anchorPicker() {
      var r = document.getElementById('mapWorkshopButton').getBoundingClientRect();
      pickerEl.style.left = Math.round(r.right + 12) + 'px';
      pickerEl.style.top = Math.max(12, Math.min(Math.round(r.top), window.innerHeight - 450)) + 'px';
      pickerEl.style.bottom = 'auto';
    }

    function showPicker(list, workshopCounts) {
      ensureDom();
      pickerListEl.innerHTML = '';
      workshopCounts = workshopCounts || {};
      list.forEach(function (w, idx) {
        var steps = Array.isArray(w.steps) ? w.steps.length : 0;
        var savedCount = Number(workshopCounts[String(w.id || '')]) || 0;
        var isCurrent = active && workshop && String(workshop.id || '') === String(w.id || '');
        var row = document.createElement('div');
        Object.assign(row.style, {
          width: '100%', display: 'flex', alignItems: 'stretch', gap: '6px',
          margin: '0 0 6px'
        });
        var item = document.createElement('button');
        item.type = 'button';
        Object.assign(item.style, {
          minWidth: '0',
          flex: '1 1 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          padding: '10px 11px',
          borderRadius: '6px',
          border: '1px solid rgba(255,255,255,0.14)',
          background: isCurrent ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.10)',
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
        count.textContent = steps + (steps === 1 ? ' part' : ' parts');
        count.style.flex = '0 0 auto';
        count.style.opacity = '0.78';
        count.style.fontSize = '12px';
        item.appendChild(name);
        item.appendChild(count);
        item.addEventListener('click', function () {
          hidePicker();
          requestWorkshopStart(w);
        });
        var results = mkBtn('Results (' + savedCount + ')', function () {
          var params = new URLSearchParams();
          params.set('workshop', String(w.id || ''));
          params.set('name', String(w.name || ('Workshop ' + (idx + 1))));
          window.location.href = '/results?' + params.toString();
        });
        results.title = savedCount + (savedCount === 1 ? ' saved workshop session' : ' saved workshop sessions');
        Object.assign(results.style, {
          flex: '0 0 auto', padding: '7px 9px', fontSize: '11px',
          color: '#78dfd4', borderColor: 'rgba(83,190,178,0.55)',
          background: 'rgba(47,143,134,0.18)'
        });
        row.appendChild(item);
        row.appendChild(results);
        pickerListEl.appendChild(row);
      });
      anchorPicker();
      pickerEl.style.display = 'flex';
    }

    function setRecordingEnabled(enabled) {
      var a = getApp();
      if (a.isRecording() !== enabled) a.toggleRecording();
    }

    function requestWorkshopStart(def) {
      var recording = getApp().isRecording();
      window.CompactPageFlow.confirmDialog({
        title: 'Record this workshop?',
        message: recording
          ? 'Recording is already active. Choose whether to keep it running for this workshop.'
          : 'Choose whether to record the workshop while it is running.',
        confirmText: recording ? 'Keep recording & start' : 'Record & start',
        confirmColor: 'green',
        thirdText: recording ? 'Stop recording & start' : 'Start without recording',
        cancelText: 'Cancel',
        onConfirm: function () {
          setRecordingEnabled(true);
          startWorkshop(def);
        },
        onThird: function () {
          setRecordingEnabled(false);
          startWorkshop(def);
        }
      });
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
      window.setTimeout(function () { t.remove(); }, 2600);
    }

    function enter() {
      ensureDom();
      if (isPickerVisible()) {
        hidePicker();
        return;
      }
      var requestSeq = ++pickerRequestSeq;
      pickerListEl.innerHTML = '';
      var loading = document.createElement('div');
      loading.textContent = 'Loading workshops...';
      Object.assign(loading.style, { padding: '12px', color: 'rgba(255,255,255,0.78)' });
      pickerListEl.appendChild(loading);
      anchorPicker();
      pickerEl.style.display = 'flex';
      Promise.all([
        fetch('/api/workshops', { cache: 'no-store' }).then(function (r) { return r.json(); }),
        fetch('/api/sessions?workshopCounts=1', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .catch(function () { return { workshopCounts: {} }; })
      ])
        .then(function (responses) {
          if (requestSeq !== pickerRequestSeq) return;
          var data = responses[0];
          var sessionData = responses[1];
          var list = (data && Array.isArray(data.workshops)) ? data.workshops : [];
          list = list.filter(function (w) { return w && Array.isArray(w.steps) && w.steps.length; });
          if (!list.length) {
            hidePicker();
            toast('No workshops defined. Create one in Settings > Workshop.');
            return;
          }
          showPicker(list, sessionData && sessionData.workshopCounts);
        })
        .catch(function () {
          if (requestSeq !== pickerRequestSeq) return;
          hidePicker();
          toast('Failed to load workshops.');
        });
    }

    function startWorkshop(def) {
      ensureDom();
      var editor = window.CompactWorkshopEditor;
      if (editor.isOpen()) editor.close();
      workshop = def;
      active = true;
      stepIndex = 0;
      visibleStepNumbers = new Set();
      labelsEl.style.display = 'block';
      barEl.style.display = 'flex';
      setBarVisible(true);
      scheduleBarAutoHide();
      var a = getApp();
      a.setWorkshopContext(def.id || '');
      a.setWorkshopMeta({ workshopId: def.id || '', workshopName: def.name || '' });
      // The run's first save creates a new session file; later saves update it.
      a.beginWorkshopSession();
      applyStep(0);
    }

    function exitWorkshop() {
      if (!active) return;
      window.CompactPageFlow.confirmDialog({
        title: 'Save workshop inputs before exiting?',
        confirmText: 'Save & exit',
        confirmColor: 'green',
        thirdText: 'Exit without saving',
        cancelText: 'Cancel',
        onConfirm: function () {
          getApp().saveSession(function () { doExitWorkshop(); });
        },
        onThird: doExitWorkshop
      });
    }

    function doExitWorkshop() {
      if (!active) return;
      setRecordingEnabled(false);
      active = false;
      workshop = null;
      applySeq++;
      hidePicker();
      labelsEl.style.display = 'none';
      labelsEl.innerHTML = '';
      barEl.style.display = 'none';
      barHandleEl.style.display = 'none';
      if (barHideTimer) {
        window.clearTimeout(barHideTimer);
        barHideTimer = 0;
      }
      var a = getApp();
      a.setVisibleWorkshopStep(null, '');
      a.setWorkshopContext('');
      a.setWorkshopMeta(null);
      a.setWorkshopStep(0);
      a.setOverlayVisibility({ roads: null, drawings: true, stickers: true, annotations: true });
      a.setDataLayers([]);
    }

    window.addEventListener('keydown', function (e) {
      if (isPickerVisible()) {
        if (e.key === 'Escape') {
          e.preventDefault();
          hidePicker();
        }
        return;
      }
      if (!active || isTextInputTarget(e.target)) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setBarVisible(true);
        scheduleBarAutoHide();
        go(stepIndex + (e.key === 'ArrowRight' ? 1 : -1));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        exitWorkshop();
      }
    });
    window.addEventListener('compact-workshop-toggle-request', enter);

    return {
      exit: exitWorkshop,
      isActive: function () { return active; }
    };
  }

  window.CompactWorkshopRuntime = createRuntime();
})();
