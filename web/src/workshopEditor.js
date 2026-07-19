(function () {
  // In-map workshop AUTHORING. Opened from the map's "Workshops" nav button, it
  // edits the same {id,name,steps:[...]} shape the runtime player reads, directly
  // against the live map (pan/zoom + "Capture view", per-step theme/environment,
  // draggable on-map text labels, .dxf floorplan upload). No VGA — the old
  // settings-page editor's VGA/boundary tooling is intentionally omitted.

  function clamp01(v) { v = Number(v); return !isFinite(v) ? 0 : (v < 0 ? 0 : (v > 1 ? 1 : v)); }
  function uid() { return 'ws_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }

  var OUTDOOR_THEMES = [
    { value: 'streets', label: 'Streets' },
    { value: 'satellite', label: 'Satellite' },
    { value: 'topo', label: 'Topographic' }
  ];

  // Uploaded GeoJSON layers are stored per step as 'custom:<file id>'.
  var CUSTOM_PREFIX = 'custom:';

  function createEditor() {
    var state = { workshops: [], wsIndex: -1, stepIndex: 0, floorplans: [], dataLayers: [] };
    var open = false;
    var saveTimer = 0;
    var loaded = false;
    var sublayersOpenById = {};

    var panel = null;
    var labelOverlay = null;   // draggable text-label layer over #main_container
    var els = {};              // cached panel sub-elements
    var container = null;

    function getApp() { return window.CompactMapApp || null; }
    function getContainer() {
      if (!container) container = document.getElementById('main_container') || document.body;
      return container;
    }

    // ---- data helpers ----
    function curWorkshop() { return state.workshops[state.wsIndex] || null; }
    function curStep() {
      var w = curWorkshop();
      if (!w || !Array.isArray(w.steps)) return null;
      return w.steps[state.stepIndex] || null;
    }
    function makeStep(n) {
      return { id: n, label: 'Step ' + n, theme: 'streets', indoor: false, indoorId: '', mapView: null, labels: [], dataLayers: [] };
    }
    // A step's display name = its first text label, else "Step N".
    function stepName(step, idx) {
      var labels = (step && Array.isArray(step.labels)) ? step.labels : [];
      for (var i = 0; i < labels.length; i++) {
        var t = String((labels[i] && labels[i].text) || '').trim();
        if (t) return t;
      }
      return 'Step ' + (Number(step && step.id) || (idx + 1));
    }
    function syncStepLabel(step, idx) {
      if (step) step.label = stepName(step, idx);
    }

    // ---- persistence ----
    function scheduleSave() {
      setStatus('Saving…');
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, 500);
    }
    function saveNow() {
      saveTimer = 0;
      fetch('/api/workshops', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workshops: state.workshops })
      }).then(function (r) { return r.json(); }).then(function (d) {
        setStatus(d && d.ok ? 'Saved' : 'Save failed', d && d.ok ? '' : 'err');
        if (d && d.ok) setTimeout(function () { if (els.status && els.status.textContent === 'Saved') setStatus(''); }, 1200);
      }).catch(function () { setStatus('Save failed', 'err'); });
    }

    function loadWorkshops() {
      return fetch('/api/workshops', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          state.workshops = (d && Array.isArray(d.workshops)) ? d.workshops : [];
          // Normalize: every step needs labels + dataLayers arrays.
          state.workshops.forEach(function (w) {
            if (!Array.isArray(w.steps)) w.steps = [];
            w.steps.forEach(function (s) {
              if (!Array.isArray(s.labels)) s.labels = [];
              if (!Array.isArray(s.dataLayers)) s.dataLayers = [];
            });
          });
          if (!state.workshops.length) {
            state.workshops.push({ id: uid(), name: 'Workshop 1', steps: [makeStep(1)] });
          }
          state.wsIndex = 0;
          state.stepIndex = 0;
        })
        .catch(function () {
          state.workshops = [{ id: uid(), name: 'Workshop 1', steps: [makeStep(1)] }];
          state.wsIndex = 0; state.stepIndex = 0;
        });
    }
    function loadFloorplans() {
      return fetch('/api/floorplans', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) { state.floorplans = (d && Array.isArray(d.floorplans)) ? d.floorplans : []; })
        .catch(function () { state.floorplans = []; });
    }
    function loadCustomLayers() {
      // Refresh the map app's shared id/name registry after catalog changes.
      var geo = window.CompactCustomGeoLayers;
      if (geo && typeof geo.refresh === 'function') {
        return new Promise(function (resolve) {
          geo.refresh(function () { resolve(); });
        });
      }
      return fetch('/api/custom-layers', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .catch(function () {});
    }
    function loadDataLayers() {
      return fetch('/api/data-layers', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) { state.dataLayers = (d && Array.isArray(d.layers)) ? d.layers : []; })
        .catch(function () { state.dataLayers = []; });
    }

    // ---- apply a step's state to the live map (mirrors runtime.applyStep, no tagging) ----
    function applyStepToMap(step) {
      var a = getApp();
      if (!a || !step) return;
      if (step.indoor && a.setIndoorFloorplan) a.setIndoorFloorplan(step.indoorId || '');
      var layer = step.indoor ? 'floorplan' : (step.theme || 'streets');
      if (a.setMapTheme) a.setMapTheme(layer);
      if (step.mapView && a.applyStepView) a.applyStepView(step.mapView);
      // setDataLayers self-defers past any style reload setMapTheme kicked off.
      if (a.setDataLayers) a.setDataLayers(Array.isArray(step.dataLayers) ? step.dataLayers : []);
    }

    // ================= draggable on-map text labels =================
    function ensureLabelOverlay() {
      if (labelOverlay) return labelOverlay;
      labelOverlay = document.createElement('div');
      labelOverlay.id = 'wsEditLabels';
      Object.assign(labelOverlay.style, {
        position: 'absolute', inset: '0', zIndex: '950',
        pointerEvents: 'none', display: 'none'
      });
      getContainer().appendChild(labelOverlay);
      return labelOverlay;
    }

    function renderLabels() {
      var overlay = ensureLabelOverlay();
      overlay.innerHTML = '';
      var step = curStep();
      overlay.style.display = (open && step) ? 'block' : 'none';
      if (!open || !step) return;
      var labels = Array.isArray(step.labels) ? step.labels : [];
      labels.forEach(function (l, i) { overlay.appendChild(buildLabelChip(l, i, step)); });
    }

    function buildLabelChip(label, index, step) {
      var op = clamp01(label.bgOpacity != null ? label.bgOpacity : 0.6);
      var chip = document.createElement('div');
      Object.assign(chip.style, {
        position: 'absolute',
        left: (clamp01(label.xPct) * 100) + '%',
        top: (clamp01(label.yPct) * 100) + '%',
        transform: 'translate(-50%, -50%)',
        maxWidth: '70%',
        padding: '6px 10px',
        borderRadius: '6px',
        color: '#fff',
        background: 'rgba(0,0,0,' + op + ')',
        fontSize: (Number(label.fontSize) || 20) + 'px',
        fontWeight: '600',
        lineHeight: '1.25',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'auto',
        cursor: 'move',
        outline: '1px dashed rgba(111,227,214,0.7)',
        userSelect: 'none'
      });

      // Editable text.
      var textEl = document.createElement('span');
      textEl.textContent = String(label.text || '');
      textEl.setAttribute('contenteditable', 'true');
      textEl.style.outline = 'none';
      textEl.style.cursor = 'text';
      textEl.addEventListener('mousedown', function (e) { e.stopPropagation(); }); // don't start a drag when editing
      textEl.addEventListener('input', function () {
        label.text = textEl.textContent;
        syncStepLabel(step, state.stepIndex);
        renderStepList();
        scheduleSave();
      });
      chip.appendChild(textEl);

      // Delete button.
      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      Object.assign(del.style, {
        position: 'absolute', top: '-10px', right: '-10px',
        width: '20px', height: '20px', lineHeight: '18px', padding: '0',
        borderRadius: '50%', border: '1px solid #b0483e', background: '#fff',
        color: '#b0483e', fontWeight: '700', cursor: 'pointer'
      });
      del.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        step.labels.splice(index, 1);
        syncStepLabel(step, state.stepIndex);
        renderLabels();
        renderStepList();
        scheduleSave();
      });
      chip.appendChild(del);

      // Drag to reposition (updates xPct/yPct as a fraction of the container).
      chip.addEventListener('mousedown', function (e) {
        if (e.target === del || e.target === textEl) return;
        e.preventDefault();
        var rect = getContainer().getBoundingClientRect();
        function onMove(ev) {
          label.xPct = clamp01((ev.clientX - rect.left) / rect.width);
          label.yPct = clamp01((ev.clientY - rect.top) / rect.height);
          chip.style.left = (label.xPct * 100) + '%';
          chip.style.top = (label.yPct * 100) + '%';
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          scheduleSave();
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      return chip;
    }

    function addLabel() {
      var step = curStep();
      if (!step) return;
      if (!Array.isArray(step.labels)) step.labels = [];
      step.labels.push({ text: 'Text', xPct: 0.5, yPct: 0.5, fontSize: 20, bgOpacity: 0.6 });
      syncStepLabel(step, state.stepIndex);
      renderLabels();
      renderStepList();
      scheduleSave();
    }

    // ================= panel UI =================
    function css(el, styles) { Object.assign(el.style, styles); return el; }
    var BTN = {
      padding: '7px 12px', font: '600 13px system-ui, sans-serif', color: '#fff',
      background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.28)',
      borderRadius: '8px', cursor: 'pointer', whiteSpace: 'nowrap'
    };
    var PRIMARY = Object.assign({}, BTN, { background: 'rgba(47,143,134,0.9)', borderColor: 'rgba(53,160,148,0.95)' });

    function mkBtn(text, onClick, style) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      css(b, style || BTN);
      b.addEventListener('click', onClick);
      return b;
    }
    function setStatus(msg, kind) {
      if (!els.status) return;
      els.status.textContent = msg || '';
      els.status.style.color = kind === 'err' ? '#ff8d7e' : 'rgba(255,255,255,0.6)';
    }

    function ensurePanel() {
      if (panel) return panel;
      // Native <select> dropdown lists render on a light OS popup, so give the
      // options dark text (the closed field keeps its white-on-dark styling).
      var optStyle = document.createElement('style');
      optStyle.textContent = '#wsEditPanel select option { color: #111; background: #fff; }';
      document.head.appendChild(optStyle);

      panel = document.createElement('div');
      panel.id = 'wsEditPanel';
      css(panel, {
        position: 'fixed', top: '0', right: '0', bottom: '0', width: '320px',
        zIndex: '10001', display: 'none', flexDirection: 'column',
        background: 'rgba(18,18,18,0.95)', borderLeft: '1px solid rgba(255,255,255,0.18)',
        color: '#fff', font: '400 13px system-ui, sans-serif',
        boxShadow: '-14px 0 34px rgba(0,0,0,0.45)'
      });

      // Header
      var head = css(document.createElement('div'), {
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.14)'
      });
      var title = document.createElement('div');
      title.textContent = 'Workshop editor';
      css(title, { fontWeight: '700', fontSize: '15px', flex: '1' });
      var closeBtn = mkBtn('Close', close_);
      head.appendChild(title);
      head.appendChild(closeBtn);
      panel.appendChild(head);

      // Scroll body
      var body = css(document.createElement('div'), {
        flex: '1', minHeight: '0', overflowY: 'auto', padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: '12px'
      });
      panel.appendChild(body);

      // Workshop selector + new + delete
      var wsRow = css(document.createElement('div'), { display: 'flex', gap: '6px', alignItems: 'center' });
      els.wsSelect = document.createElement('select');
      css(els.wsSelect, fieldStyle());
      els.wsSelect.style.flex = '1';
      els.wsSelect.addEventListener('change', function () { selectWorkshop(Number(els.wsSelect.value)); });
      wsRow.appendChild(els.wsSelect);
      wsRow.appendChild(mkBtn('New', newWorkshop));
      wsRow.appendChild(mkBtn('Delete', deleteWorkshop, Object.assign({}, BTN, { color: '#ff8d7e', borderColor: '#e6c6c0' })));
      body.appendChild(wsRow);

      // Name
      els.nameInput = document.createElement('input');
      els.nameInput.type = 'text';
      els.nameInput.placeholder = 'Workshop name';
      css(els.nameInput, fieldStyle());
      els.nameInput.addEventListener('input', function () {
        var w = curWorkshop(); if (w) { w.name = els.nameInput.value; renderWsSelect(); scheduleSave(); }
      });
      body.appendChild(labeled('Name', els.nameInput));

      // Steps (questions)
      var stepsHead = css(document.createElement('div'), { display: 'flex', alignItems: 'center', gap: '8px' });
      var stepsLbl = sectionLabel('Questions (steps)'); stepsLbl.style.flex = '1'; stepsLbl.style.margin = '0';
      stepsHead.appendChild(stepsLbl);
      stepsHead.appendChild(mkBtn('+ Add question', addStep, PRIMARY));
      body.appendChild(stepsHead);
      els.stepList = css(document.createElement('div'), { display: 'flex', flexDirection: 'column', gap: '4px' });
      body.appendChild(els.stepList);

      // Selected-step controls
      els.stepControls = css(document.createElement('div'), {
        display: 'flex', flexDirection: 'column', gap: '10px',
        paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.14)'
      });
      body.appendChild(els.stepControls);
      buildStepControls();

      // Status
      els.status = css(document.createElement('div'), { fontSize: '12px', minHeight: '16px', color: 'rgba(255,255,255,0.6)' });
      body.appendChild(els.status);

      document.body.appendChild(panel);
      return panel;
    }

    function fieldStyle() {
      return {
        boxSizing: 'border-box', padding: '7px 9px', borderRadius: '8px',
        border: '1px solid rgba(255,255,255,0.28)', background: 'rgba(255,255,255,0.08)',
        color: '#fff', font: '600 13px system-ui, sans-serif'
      };
    }
    function sectionLabel(text) {
      var l = document.createElement('div');
      l.textContent = text;
      css(l, { fontSize: '11px', fontWeight: '700', letterSpacing: '0.05em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', margin: '2px 0' });
      return l;
    }
    function labeled(text, field) {
      var wrap = document.createElement('div');
      wrap.appendChild(sectionLabel(text));
      field.style.width = '100%';
      wrap.appendChild(field);
      return wrap;
    }

    function buildStepControls() {
      var c = els.stepControls;
      c.innerHTML = '';

      // Environment toggle
      var envRow = css(document.createElement('div'), { display: 'flex', gap: '6px' });
      els.envOutdoor = mkBtn('Outdoor', function () { setEnvironment(false); });
      els.envIndoor = mkBtn('Indoor', function () { setEnvironment(true); });
      els.envOutdoor.style.flex = '1'; els.envIndoor.style.flex = '1';
      envRow.appendChild(els.envOutdoor);
      envRow.appendChild(els.envIndoor);
      c.appendChild(labeledRow('Environment', envRow));

      // Theme (outdoor)
      els.themeSelect = document.createElement('select');
      css(els.themeSelect, fieldStyle()); els.themeSelect.style.width = '100%';
      OUTDOOR_THEMES.forEach(function (t) {
        var o = document.createElement('option'); o.value = t.value; o.textContent = t.label; els.themeSelect.appendChild(o);
      });
      els.themeSelect.addEventListener('change', function () {
        var s = curStep(); if (s) { s.theme = els.themeSelect.value; applyStepToMap(s); scheduleSave(); }
      });
      els.themeWrap = labeledRow('Basemap', els.themeSelect);
      c.appendChild(els.themeWrap);

      // Floorplan (indoor)
      var fpRow = css(document.createElement('div'), { display: 'flex', gap: '6px', alignItems: 'center' });
      els.fpSelect = document.createElement('select');
      css(els.fpSelect, fieldStyle()); els.fpSelect.style.flex = '1';
      els.fpSelect.addEventListener('change', function () {
        var s = curStep(); if (s) { s.indoorId = els.fpSelect.value || ''; applyStepToMap(s); scheduleSave(); }
      });
      els.fpFile = document.createElement('input');
      els.fpFile.type = 'file'; els.fpFile.accept = '.dxf'; els.fpFile.style.display = 'none';
      els.fpFile.addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0]; if (f) uploadFloorplan(f); els.fpFile.value = '';
      });
      var upBtn = mkBtn('Upload', function () { els.fpFile.click(); });
      fpRow.appendChild(els.fpSelect);
      fpRow.appendChild(upBtn);
      fpRow.appendChild(els.fpFile);
      els.fpWrap = labeledRow('Floorplan (.dxf)', fpRow);
      c.appendChild(els.fpWrap);

      // Data layers shown on this step's map: the built-in checkboxes plus one
      // per uploaded GeoJSON file (rows rebuilt by renderDataLayerChecks).
      els.layersCol = css(document.createElement('div'), { display: 'flex', flexDirection: 'column', gap: '5px' });
      var layersWrap = labeledRow('Data layers', els.layersCol);

      // Upload GeoJSON or a full uMap backup: drag & drop onto the zone, or
      // click to browse. The backend normalizes both to the shared renderer.
      els.layerFile = document.createElement('input');
      els.layerFile.type = 'file';
      els.layerFile.accept = '.geojson,.json,.umap,application/geo+json,application/json';
      els.layerFile.multiple = true;
      els.layerFile.style.display = 'none';
      els.layerFile.addEventListener('change', function (e) {
        uploadCustomLayers(e.target.files);
        els.layerFile.value = '';
      });
      els.layerDrop = document.createElement('div');
      els.layerDrop.textContent = 'Drop .geojson or .umap here — or click to browse';
      css(els.layerDrop, {
        marginTop: '6px', padding: '10px', textAlign: 'center', cursor: 'pointer',
        border: '1px dashed rgba(255,255,255,0.35)', borderRadius: '8px',
        color: 'rgba(255,255,255,0.6)', font: '600 12px system-ui, sans-serif'
      });
      var setDropHot = function (hot) {
        els.layerDrop.style.borderColor = hot ? 'rgba(53,160,148,0.95)' : 'rgba(255,255,255,0.35)';
        els.layerDrop.style.background = hot ? 'rgba(47,143,134,0.18)' : 'transparent';
      };
      els.layerDrop.addEventListener('click', function () { els.layerFile.click(); });
      els.layerDrop.addEventListener('dragover', function (e) { e.preventDefault(); setDropHot(true); });
      els.layerDrop.addEventListener('dragleave', function () { setDropHot(false); });
      els.layerDrop.addEventListener('drop', function (e) {
        e.preventDefault();
        setDropHot(false);
        uploadCustomLayers(e.dataTransfer && e.dataTransfer.files);
      });
      layersWrap.appendChild(els.layerDrop);
      layersWrap.appendChild(els.layerFile);
      c.appendChild(layersWrap);

      // Capture view + add text
      var actRow = css(document.createElement('div'), { display: 'flex', gap: '6px' });
      var capBtn = mkBtn('⤓ Capture view', captureView, PRIMARY); capBtn.style.flex = '1';
      var textBtn = mkBtn('+ Add text', addLabel); textBtn.style.flex = '1';
      actRow.appendChild(capBtn);
      actRow.appendChild(textBtn);
      c.appendChild(actRow);

      els.viewHint = css(document.createElement('div'), { fontSize: '11px', color: 'rgba(255,255,255,0.5)', lineHeight: '1.4' });
      els.viewHint.textContent = 'Pan/zoom the map, then Capture view to save this step’s camera.';
      c.appendChild(els.viewHint);
    }
    function labeledRow(text, row) {
      var wrap = document.createElement('div');
      wrap.appendChild(sectionLabel(text));
      wrap.appendChild(row);
      return wrap;
    }

    // ---- data-layer rows (built-ins + uploaded custom layers) ----
    function layerCheckRow(key, label, onDelete, onToggle) {
      var step = curStep();
      var row = css(document.createElement('label'), {
        display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
        font: '600 13px system-ui, sans-serif'
      });
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.style.accentColor = 'rgba(47,143,134,0.9)';
      cb.checked = !!(step && Array.isArray(step.dataLayers) && step.dataLayers.indexOf(key) !== -1);
      cb.addEventListener('change', function () {
        var s = curStep(); if (!s) return;
        if (!Array.isArray(s.dataLayers)) s.dataLayers = [];
        var i = s.dataLayers.indexOf(key);
        if (cb.checked && i === -1) s.dataLayers.push(key);
        if (!cb.checked && i !== -1) s.dataLayers.splice(i, 1);
        var a = getApp();
        if (a && a.setDataLayers) a.setDataLayers(s.dataLayers);
        scheduleSave();
        if (typeof onToggle === 'function') onToggle(cb.checked);
      });
      var txt = css(document.createElement('span'), {
        flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      });
      txt.textContent = label;
      row.appendChild(cb);
      row.appendChild(txt);
      if (onDelete) {
        // preventDefault so the click doesn't also activate the label's checkbox.
        var del = mkBtn('\uD83D\uDDD1', function (e) { e.preventDefault(); e.stopPropagation(); onDelete(); },
          Object.assign({}, BTN, { padding: '1px 3px', fontSize: '15px', lineHeight: '1', color: '#ff8d7e', border: '0', background: 'transparent' }));
        del.title = 'Remove from Data Layers';
        del.setAttribute('aria-label', 'Remove ' + label + ' from Data Layers');
        row.appendChild(del);
      }
      return row;
    }

    function renderCustomSublayers(layer, host) {
      var key = String(layer && layer.id || '');
      var id = key.slice(CUSTOM_PREFIX.length);
      var geo = window.CompactCustomGeoLayers;
      if (!id || !geo) return;

      var sublayers = typeof geo.getSublayers === 'function' ? geo.getSublayers(id) : null;
      if (!sublayers) {
        var loading = css(document.createElement('div'), {
          marginLeft: '24px', color: 'rgba(255,255,255,0.45)',
          font: '11px system-ui, sans-serif'
        });
        loading.textContent = 'Loading sublayers…';
        host.appendChild(loading);
        if (typeof geo.loadLayer === 'function') {
          geo.loadLayer(id, function () {
            if (host.isConnected) renderDataLayerChecks();
          });
        }
        return;
      }
      if (!sublayers.length) return;

      var step = curStep();
      var parentEnabled = !!(step && Array.isArray(step.dataLayers) && step.dataLayers.indexOf(key) !== -1);
      if (sublayersOpenById[key] == null) sublayersOpenById[key] = parentEnabled;

      var details = document.createElement('details');
      details.open = !!sublayersOpenById[key];
      css(details, { marginLeft: '22px', minWidth: '0' });
      details.addEventListener('toggle', function () { sublayersOpenById[key] = details.open; });

      var summary = css(document.createElement('summary'), {
        cursor: 'pointer', color: 'rgba(255,255,255,0.68)',
        font: '600 11px system-ui, sans-serif', padding: '2px 0'
      });
      function updateSummary() {
        var current = typeof geo.getSublayers === 'function' ? geo.getSublayers(id) : sublayers;
        var shown = (current || []).filter(function (entry) { return entry.visible; }).length;
        summary.textContent = shown + '/' + sublayers.length + ' sublayers';
      }
      updateSummary();
      details.appendChild(summary);

      var controls = css(document.createElement('div'), {
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        gap: '5px', padding: '3px 0 4px'
      });
      function sublayerButton(text, show) {
        var button = mkBtn(text, function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof geo.setAllSublayersVisible === 'function') geo.setAllSublayersVisible(id, show);
          renderDataLayerChecks();
        }, Object.assign({}, BTN, { padding: '2px 6px', fontSize: '10px' }));
        return button;
      }
      controls.appendChild(sublayerButton('All', true));
      controls.appendChild(sublayerButton('None', false));
      details.appendChild(controls);

      var list = css(document.createElement('div'), {
        display: 'flex', flexDirection: 'column', gap: '3px',
        maxHeight: '220px', overflowY: 'auto', padding: '1px 4px 3px 0'
      });
      sublayers.forEach(function (entry) {
        var row = css(document.createElement('label'), {
          display: 'grid', gridTemplateColumns: '14px 9px minmax(0, 1fr) auto',
          alignItems: 'center', gap: '5px', cursor: 'pointer', minWidth: '0',
          font: '500 11px system-ui, sans-serif', color: 'rgba(255,255,255,0.82)'
        });
        var checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = entry.visible;
        checkbox.style.margin = '0';
        checkbox.style.accentColor = entry.color;
        checkbox.addEventListener('change', function () {
          if (typeof geo.setSublayerVisible === 'function') {
            geo.setSublayerVisible(id, entry.name, checkbox.checked);
          }
          updateSummary();
        });
        var swatch = css(document.createElement('span'), {
          width: '8px', height: '8px', borderRadius: '50%', background: entry.color,
          boxShadow: '0 0 0 1px rgba(255,255,255,0.35)'
        });
        var name = css(document.createElement('span'), {
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
        });
        name.textContent = entry.label || entry.name;
        var count = css(document.createElement('span'), { opacity: '0.5' });
        count.textContent = String(entry.count);
        row.appendChild(checkbox);
        row.appendChild(swatch);
        row.appendChild(name);
        row.appendChild(count);
        list.appendChild(row);
      });
      details.appendChild(list);
      host.appendChild(details);
    }

    function renderDataLayerChecks() {
      if (!els.layersCol) return;
      els.layersCol.innerHTML = '';
      state.dataLayers.forEach(function (l) {
        var group = css(document.createElement('div'), {
          display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0'
        });
        group.appendChild(layerCheckRow(l.id, l.name || l.id, function () {
          deleteDataLayer(l);
        }));
        if (String(l.id || '').indexOf(CUSTOM_PREFIX) === 0) renderCustomSublayers(l, group);
        els.layersCol.appendChild(group);
      });
    }

    function uploadCustomLayers(files) {
      var list = Array.prototype.slice.call(files || []).filter(function (f) {
        return /\.(?:(?:geo)?json|umap)$/i.test(String(f && f.name || ''));
      });
      if (!list.length) { setStatus('Only .geojson/.json/.umap files', 'err'); return; }
      setStatus('Uploading layer…');
      var pending = list.length;
      var failed = 0;
      list.forEach(function (file) {
        var fd = new FormData();
        fd.append('file', file);
        fetch('/api/custom-layers', { method: 'POST', body: fd })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (res) {
            if (!res.ok || !res.d || !res.d.ok) throw new Error((res.d && res.d.error) || 'upload_failed');
            // Activate the new layer on the current step right away.
            var s = curStep();
            if (s) {
              if (!Array.isArray(s.dataLayers)) s.dataLayers = [];
              var key = CUSTOM_PREFIX + res.d.id;
              if (s.dataLayers.indexOf(key) === -1) s.dataLayers.push(key);
            }
          })
          .catch(function () { failed++; })
          .finally(function () {
            pending--;
            if (pending) return;
            Promise.all([loadCustomLayers(), loadDataLayers()]).then(function () {
              renderDataLayerChecks();
              var s = curStep();
              var a = getApp();
              if (s && a && a.setDataLayers) a.setDataLayers(s.dataLayers || []);
              scheduleSave();
              setStatus(failed ? 'Some uploads failed' : 'Layer added ✓', failed ? 'err' : '');
            });
          });
      });
    }

    function deleteDataLayer(layer) {
      var key = String(layer && layer.id || '');
      var name = String(layer && layer.name || key);
      if (!key) return;
      if (!window.confirm('Remove layer "' + name + '" from Data Layers? It will be removed from every workshop, but its source file will be kept.')) return;
      fetch('/api/data-layers/' + encodeURIComponent(key), { method: 'DELETE' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok) throw new Error((d && d.error) || 'delete_failed');
          // Strip the layer from every step of every workshop.
          state.workshops.forEach(function (w) {
            (Array.isArray(w.steps) ? w.steps : []).forEach(function (s) {
              if (!Array.isArray(s.dataLayers)) return;
              var i = s.dataLayers.indexOf(key);
              if (i !== -1) s.dataLayers.splice(i, 1);
            });
          });
          var geo = window.CompactCustomGeoLayers;
          if (key.indexOf(CUSTOM_PREFIX) === 0 && geo && typeof geo.forget === 'function') {
            geo.forget(key.slice(CUSTOM_PREFIX.length));
          }
          return Promise.all([loadCustomLayers(), loadDataLayers()]);
        })
        .then(function () {
          renderDataLayerChecks();
          var s = curStep();
          var a = getApp();
          if (s && a && a.setDataLayers) a.setDataLayers(s.dataLayers || []);
          scheduleSave();
          setStatus('Layer removed from Data Layers');
        })
        .catch(function (err) { setStatus('Remove failed: ' + (err && err.message || ''), 'err'); });
    }

    // ---- rendering ----
    function renderWsSelect() {
      if (!els.wsSelect) return;
      els.wsSelect.innerHTML = '';
      state.workshops.forEach(function (w, i) {
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = w.name || ('Workshop ' + (i + 1));
        els.wsSelect.appendChild(o);
      });
      els.wsSelect.value = String(state.wsIndex);
    }

    function renderStepList() {
      if (!els.stepList) return;
      els.stepList.innerHTML = '';
      var w = curWorkshop();
      if (!w) return;
      w.steps.forEach(function (step, i) {
        var row = css(document.createElement('div'), {
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '7px 9px', borderRadius: '7px', cursor: 'pointer',
          border: '1px solid ' + (i === state.stepIndex ? 'rgba(47,143,134,0.9)' : 'rgba(255,255,255,0.14)'),
          background: i === state.stepIndex ? 'rgba(47,143,134,0.22)' : 'rgba(255,255,255,0.05)'
        });
        var num = css(document.createElement('span'), { opacity: '0.6', fontSize: '11px', flex: '0 0 auto' });
        num.textContent = (i + 1) + '.';
        var nm = css(document.createElement('span'), { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: '600' });
        nm.textContent = stepName(step, i);
        var envTag = css(document.createElement('span'), { fontSize: '10px', opacity: '0.7', flex: '0 0 auto' });
        envTag.textContent = step.indoor ? 'indoor' : 'outdoor';
        row.appendChild(num); row.appendChild(nm); row.appendChild(envTag);
        row.addEventListener('click', function () { selectStep(i); });
        if (w.steps.length > 1) {
          var del = mkBtn('×', function (e) { e.stopPropagation(); deleteStep(i); }, Object.assign({}, BTN, { padding: '2px 8px', color: '#ff8d7e', borderColor: 'transparent', background: 'transparent' }));
          row.appendChild(del);
        }
        els.stepList.appendChild(row);
      });
    }

    function renderStepControls() {
      var step = curStep();
      if (!step) return;
      // env toggle active states
      var onStyle = { background: 'rgba(47,143,134,0.9)', borderColor: 'rgba(53,160,148,0.95)' };
      var offStyle = { background: 'rgba(255,255,255,0.12)', borderColor: 'rgba(255,255,255,0.28)' };
      css(els.envOutdoor, step.indoor ? offStyle : onStyle);
      css(els.envIndoor, step.indoor ? onStyle : offStyle);
      // theme vs floorplan visibility
      els.themeWrap.style.display = step.indoor ? 'none' : 'block';
      els.fpWrap.style.display = step.indoor ? 'block' : 'none';
      els.themeSelect.value = step.theme || 'streets';
      renderFloorplanSelect(step);
      renderDataLayerChecks();
    }

    function renderFloorplanSelect(step) {
      if (!els.fpSelect) return;
      els.fpSelect.innerHTML = '';
      var def = document.createElement('option'); def.value = ''; def.textContent = 'Default plan'; els.fpSelect.appendChild(def);
      state.floorplans.forEach(function (fp) {
        var o = document.createElement('option'); o.value = fp.id; o.textContent = fp.name || fp.id; els.fpSelect.appendChild(o);
      });
      els.fpSelect.value = (step && step.indoorId) || '';
    }

    function renderAll() {
      renderWsSelect();
      if (els.nameInput) { var w = curWorkshop(); els.nameInput.value = w ? (w.name || '') : ''; }
      renderStepList();
      renderStepControls();
      renderLabels();
    }

    // ---- actions ----
    function selectWorkshop(idx) {
      if (idx < 0 || idx >= state.workshops.length) return;
      state.wsIndex = idx;
      state.stepIndex = 0;
      var s = curStep(); if (s) applyStepToMap(s);
      renderAll();
    }
    function selectStep(idx) {
      var w = curWorkshop(); if (!w) return;
      state.stepIndex = Math.max(0, Math.min(idx, w.steps.length - 1));
      var s = curStep(); if (s) applyStepToMap(s);
      renderStepList();
      renderStepControls();
      renderLabels();
    }
    function newWorkshop() {
      state.workshops.push({ id: uid(), name: 'Workshop ' + (state.workshops.length + 1), steps: [makeStep(1)] });
      selectWorkshop(state.workshops.length - 1);
      scheduleSave();
    }
    function deleteWorkshop() {
      if (!curWorkshop()) return;
      if (!window.confirm('Delete this workshop?')) return;
      state.workshops.splice(state.wsIndex, 1);
      if (!state.workshops.length) state.workshops.push({ id: uid(), name: 'Workshop 1', steps: [makeStep(1)] });
      state.wsIndex = Math.max(0, state.wsIndex - 1);
      state.stepIndex = 0;
      selectWorkshop(state.wsIndex);
      scheduleSave();
    }
    function addStep() {
      var w = curWorkshop(); if (!w) return;
      w.steps.push(makeStep(w.steps.length + 1));
      selectStep(w.steps.length - 1);
      scheduleSave();
    }
    function deleteStep(idx) {
      var w = curWorkshop(); if (!w || w.steps.length <= 1) return;
      w.steps.splice(idx, 1);
      // Renumber ids sequentially.
      w.steps.forEach(function (s, i) { s.id = i + 1; });
      if (state.stepIndex >= w.steps.length) state.stepIndex = w.steps.length - 1;
      selectStep(state.stepIndex);
      scheduleSave();
    }
    function setEnvironment(indoor) {
      var s = curStep(); if (!s) return;
      if (!!s.indoor === !!indoor) return;
      s.indoor = !!indoor;
      // The camera framing differs between outdoor map and indoor plan; drop the
      // saved view so it re-frames (same behaviour as the old editor).
      s.mapView = null;
      applyStepToMap(s);
      renderStepControls();
      renderStepList();
      scheduleSave();
    }
    function captureView() {
      var s = curStep(); var a = getApp();
      if (!s || !a || !a.getMapView) return;
      s.mapView = a.getMapView();
      setStatus('View captured ✓');
      setTimeout(function () { if (els.status && els.status.textContent === 'View captured ✓') setStatus(''); }, 1200);
      scheduleSave();
    }
    function uploadFloorplan(file) {
      setStatus('Uploading floorplan…');
      var fd = new FormData();
      fd.append('file', file);
      fetch('/api/floorplans', { method: 'POST', body: fd })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok || !res.d || !res.d.ok) throw new Error((res.d && res.d.error) || 'upload_failed');
          state.floorplans = Array.isArray(res.d.floorplans) ? res.d.floorplans : state.floorplans;
          var s = curStep();
          if (s) { s.indoor = true; s.indoorId = res.d.id || ''; s.mapView = null; applyStepToMap(s); }
          renderStepControls();
          renderStepList();
          setStatus('Floorplan added ✓');
          scheduleSave();
        })
        .catch(function (err) { setStatus('Upload failed: ' + (err && err.message || ''), 'err'); });
    }

    // ---- open / close ----
    function open_() {
      if (open) return Promise.resolve();
      // If the runtime player is active, leave it — authoring takes over the map.
      var rt = window.CompactWorkshopRuntime;
      if (rt && typeof rt.isActive === 'function' && rt.isActive() && typeof rt.exit === 'function') rt.exit();
      ensurePanel();
      ensureLabelOverlay();
      open = true;
      panel.style.display = 'flex';
      var start = loaded ? Promise.resolve() : Promise.all([loadWorkshops(), loadFloorplans(), loadCustomLayers(), loadDataLayers()]).then(function () { loaded = true; });
      return start.then(function () {
        var s = curStep(); if (s) applyStepToMap(s);
        renderAll();
      });
    }
    // Open the editor and immediately start a fresh workshop (picker "+" button).
    function openNew() {
      return Promise.resolve(open_()).then(function () { newWorkshop(); });
    }
    function close_() {
      if (!open) return;
      open = false;
      if (panel) panel.style.display = 'none';
      renderLabels();  // hides the overlay
      if (saveTimer) { clearTimeout(saveTimer); saveNow(); }
    }
    function toggle() { if (open) close_(); else open_(); }

    return { open: open_, openNew: openNew, close: close_, toggle: toggle, isOpen: function () { return open; } };
  }

  window.CompactWorkshopEditor = createEditor();
})();
