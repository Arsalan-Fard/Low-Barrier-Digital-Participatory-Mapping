(function () {
  // Plays a workshop on the map page: each step's saved view, basemap, data
  // layers and on-screen texts and images. Through window.CompactMapApp the
  // participants' input is tagged with the current step and saved as a session.

  function clamp01(v) {
    v = Number(v);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
  }

  function createRuntime() {
    var container = null;
    var labelsEl = null;
    var barEl = null;
    var indicatorEl = null;
    var barHandleEl = null;
    var barHideTimer = 0;
    var lastPointerX = -1;
    var lastPointerY = -1;
    var workshop = null;
    var stepIndex = 0;
    var active = false;
    var applySeq = 0;
    var togglesEl = null;
    // Steps whose inputs are shown: the current step always, others through the
    // bar's S1, S2... toggles, remembered while moving between steps.
    var visibleStepNumbers = new Set();
    // While the Project panel is open during the run, it shows the step's texts and images itself.
    var labelsHidden = false;

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
        background: 'rgba(255,255,255,0.97)', border: '1px solid var(--ui-line)',
        boxShadow: '0 8px 24px rgba(22,48,43,0.18)',
        color: 'var(--ui-ink)', font: '600 14px system-ui, sans-serif',
        transition: 'transform 0.2s ease, opacity 0.2s ease'
      });

      var prev = mkBtn('← Previous step', function () { go(stepIndex - 1); });
      indicatorEl = document.createElement('span');
      indicatorEl.style.minWidth = '70px';
      indicatorEl.style.textAlign = 'center';
      var next = mkBtn('Next step →', function () { go(stepIndex + 1); });
      var exit = mkBtn('Exit', function () { exitWorkshop(); });
      exit.style.marginLeft = '6px';
      exit.style.color = '#fff';
      exit.style.background = 'var(--ui-danger)';
      exit.style.borderColor = 'var(--ui-danger)';

      var sep = document.createElement('span');
      Object.assign(sep.style, {
        width: '1px', alignSelf: 'stretch', margin: '0 2px',
        background: 'var(--ui-line)'
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
      // The mouse tools (mouseTools.js) on a row of their own, so they stay at hand with the
      // Project panel, where they also sit, closed.
      if (window.CompactMouseTools) {
        barEl.style.flexWrap = 'wrap';
        barEl.style.justifyContent = 'center';
        barEl.style.maxWidth = 'calc(100vw - 24px)';
        var mouseRow = window.CompactMouseTools.createToolbar({ compact: true });
        mouseRow.classList.add('mouse-tools--bar');
        barEl.appendChild(mouseRow);
      }
      document.body.appendChild(barEl);

      barHandleEl = document.createElement('div');
      barHandleEl.id = 'workshopBarHandle';
      barHandleEl.setAttribute('aria-hidden', 'true');
      Object.assign(barHandleEl.style, {
        position: 'fixed', left: '50%', bottom: '0', transform: 'translateX(-50%)',
        zIndex: '10000', width: '84px', height: '6px', display: 'none',
        borderRadius: '6px 6px 0 0', background: 'rgba(255,255,255,0.95)',
        border: '1px solid var(--ui-line-strong)', borderBottom: 'none',
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
    }

    function mkBtn(text, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      Object.assign(b.style, {
        padding: '6px 12px', font: '600 14px system-ui, sans-serif', color: 'var(--ui-ink)',
        background: 'var(--ui-panel)', border: '1px solid var(--ui-line-strong)',
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
        b.textContent = 'S' + (idx + 1);
        b.title = (on ? 'Hide' : 'Show') + ' Step ' + (idx + 1) + ' inputs';
        Object.assign(b.style, {
          padding: '5px 9px', font: '600 13px system-ui, sans-serif',
          color: on ? '#fff' : 'var(--ui-ink)', borderRadius: '6px', cursor: 'pointer',
          border: '1px solid ' + (on ? 'var(--ui-green-dark)' : 'var(--ui-line-strong)'),
          background: on ? 'var(--ui-green)' : 'var(--ui-panel)'
        });
        b.addEventListener('click', function () {
          if (visibleStepNumbers.has(num)) visibleStepNumbers.delete(num);
          else visibleStepNumbers.add(num);
          renderStepToggles();
          applyVisibleSteps();
          notify();
        });
        togglesEl.appendChild(b);
      });
    }

    // Tells the Project panel, which can stay open during the run, that the step or the shown inputs changed.
    function notify() {
      window.dispatchEvent(new CustomEvent('compact-workshop-run'));
    }

    function setLabelsHidden(hidden) {
      labelsHidden = !!hidden;
      if (labelsEl) labelsEl.style.display = active && !labelsHidden ? 'block' : 'none';
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
      visibleStepNumbers.add(stepNumberAt(stepIndex));
      showStep(true);
      notify();
    }

    // Puts the current step on the map; withView also moves the camera to the step's saved view.
    function showStep(withView) {
      var steps = currentSteps();
      if (!steps.length) return;
      stepIndex = Math.max(0, Math.min(stepIndex, steps.length - 1));
      var step = steps[stepIndex];
      var seq = ++applySeq;
      var a = getApp();
      var stepNumber = stepNumberAt(stepIndex);
      a.setWorkshopStep(stepNumber);
      // Indoor steps show the step's plan (or the default), empty sheets the step's colour.
      // Shown again (withView false), only what changed: re-applying the same basemap can reload the style.
      var theme = a.stepBasemapTheme(step);
      if (withView || theme !== a.getActiveTheme()) a.applyStepBasemap(step);
      else if (theme === 'floorplan') a.setIndoorFloorplan(step.indoorId || '');
      else if (theme === 'blank') a.setBlankSheetColor(step.blankColor);
      // Indoor views are real lng/lat too. An indoor step without a saved view
      // is framed by the floorplan's own fit instead.
      if (withView && step.mapView) a.applyStepView(step.mapView);
      renderStepToggles();
      a.whenStyleReady(function () {
        if (!active || !workshop || seq !== applySeq) return;
        a.setOverlayVisibility(Object.assign({ drawings: true }, step.overlays || {}));
        a.setDataLayers(Array.isArray(step.dataLayers) ? step.dataLayers : [], step.layerOpacity);
        a.setWorkshopStep(stepNumber);
        applyVisibleSteps();
      });
      renderLabels(step);
      indicatorEl.textContent = 'S' + (stepIndex + 1) + ' (' + (stepIndex + 1) + '/' + steps.length + ')';
    }

    function go(i) {
      if (!active) return;
      var target = Math.max(0, Math.min(i, currentSteps().length - 1));
      // Autosave on every change of step, so progress survives a forgotten save.
      if (target !== stepIndex) getApp().persistWorkshopSession();
      applyStep(i);
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

    function startWorkshop(def) {
      ensureDom();
      var editor = window.CompactWorkshopEditor;
      if (editor.isOpen()) editor.close();
      workshop = def;
      active = true;
      stepIndex = 0;
      visibleStepNumbers = new Set();
      labelsHidden = false;
      labelsEl.style.display = 'block';
      barEl.style.display = 'flex';
      setBarVisible(true);
      scheduleBarAutoHide();
      var a = getApp();
      window.CompactResultsLayer.setDisplay(def.visualization);
      // The views the project put on its map view sheets; the others follow the street view pointer.
      if (window.CompactMapViewSheets) window.CompactMapViewSheets.setViews(def.mapSheetViews);
      a.setWorkshopContext(def.id || '');
      a.setWorkshopMeta({ workshopId: def.id || '', workshopName: def.name || '' });
      // The run's first save creates a new session file; later saves update it.
      a.beginWorkshopSession();
      applyStep(0);
    }

    // afterExit runs once the workshop has ended (not when the facilitator cancels).
    function exitWorkshop(afterExit) {
      if (!active) return;
      var then = typeof afterExit === 'function' ? afterExit : function () { };
      window.CompactPageFlow.confirmDialog({
        title: 'Save workshop inputs before exiting?',
        confirmText: 'Save & exit',
        confirmColor: 'green',
        thirdText: 'Exit without saving',
        cancelText: 'Cancel',
        onConfirm: function () {
          getApp().persistWorkshopSession(function () {
            doExitWorkshop();
            then();
          });
        },
        onThird: function () {
          doExitWorkshop();
          then();
        }
      });
    }

    function doExitWorkshop() {
      if (!active) return;
      setRecordingEnabled(false);
      active = false;
      workshop = null;
      applySeq++;
      labelsEl.style.display = 'none';
      labelsEl.innerHTML = '';
      barEl.style.display = 'none';
      barHandleEl.style.display = 'none';
      if (barHideTimer) {
        window.clearTimeout(barHideTimer);
        barHideTimer = 0;
      }
      var a = getApp();
      a.setVisibleWorkshopSteps(null, '');
      a.setWorkshopContext('');
      a.setWorkshopMeta(null);
      a.setWorkshopStep(0);
      a.setOverlayVisibility({ roads: null, drawings: true, stickers: true, annotations: true });
      a.setDataLayers([]);
      labelsHidden = false;
      notify();
    }

    // The Workshop list's Start button: asks whether to record, then runs the workshop.
    return {
      start: requestWorkshopStart,
      // For the Project panel, which can open during the run and edits the running project.
      current: function () {
        return active
          ? { workshop: workshop, stepIndex: stepIndex, visibleSteps: Array.from(visibleStepNumbers) }
          : null;
      },
      goTo: function (i) { go(i); },
      // Shows the current step again, with the panel's changes, leaving the camera where it is.
      refresh: function () { if (active) showStep(false); },
      // The panel's copy of the running project, which it edits and saves.
      setWorkshop: function (def) {
        if (!active || !def) return;
        workshop = def;
        showStep(false);
      },
      setVisibleSteps: function (numbers) {
        if (!active) return;
        visibleStepNumbers = new Set(numbers || []);
        renderStepToggles();
        applyVisibleSteps();
      },
      setLabelsHidden: setLabelsHidden,
      exit: exitWorkshop,
      isActive: function () { return active; }
    };
  }

  window.CompactWorkshopRuntime = createRuntime();
})();
