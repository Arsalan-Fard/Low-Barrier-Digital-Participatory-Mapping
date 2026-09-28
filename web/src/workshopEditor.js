(function () {
  // Workshop authoring on the live map, opened from the workshop picker. It
  // edits the {id, name, steps: [...]} list that workshopRuntime.js plays: each
  // part's view, basemap or floorplan, data layers, and on-map texts and images.

  function clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
  }

  function uid() {
    return 'ws_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  var OUTDOOR_THEMES = [
    { value: 'streets', label: 'Streets' },
    { value: 'satellite', label: 'Satellite' },
    { value: 'topo', label: 'Topographic' },
    { value: 'paper', label: 'Paper map' }
  ];

  // A part lists uploaded GeoJSON layers in its dataLayers as 'custom:<file id>'.
  var CUSTOM_PREFIX = 'custom:';

  function createEditor() {
    var state = { workshops: [], wsIndex: -1, stepIndex: 0, floorplans: [], dataLayers: [] };
    var open = false;
    var saveTimer = 0;
    var loaded = false;
    var sublayersOpenById = {};

    var panel = null;
    var labelOverlay = null;
    var els = {};
    var container = null;

    function getApp() {
      return window.CompactMapApp;
    }

    function getContainer() {
      if (!container) container = document.getElementById('main_container') || document.body;
      return container;
    }

    function curWorkshop() {
      return state.workshops[state.wsIndex] || null;
    }

    function curStep() {
      var w = curWorkshop();
      if (!w || !Array.isArray(w.steps)) return null;
      return w.steps[state.stepIndex] || null;
    }

    function partName(idx) {
      return 'Part ' + (idx + 1);
    }

    function makeStep(n) {
      return { id: n, label: partName(n - 1), theme: 'streets', indoor: false, indoorId: '', mapView: null, labels: [], images: [], dataLayers: [] };
    }

    function makeWorkshop(name) {
      return { id: uid(), name: name, steps: [makeStep(1)] };
    }

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
        if (!d || !d.ok) {
          setStatus('Save failed', 'err');
          return;
        }
        setStatus('Saved');
        setTimeout(function () {
          if (els.status.textContent === 'Saved') setStatus('');
        }, 1200);
      }).catch(function () { setStatus('Save failed', 'err'); });
    }

    function loadWorkshops() {
      return fetch('/api/workshops', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          state.workshops = (d && Array.isArray(d.workshops)) ? d.workshops : [];
          state.workshops.forEach(function (w) {
            if (!Array.isArray(w.steps)) w.steps = [];
            w.steps.forEach(function (s, i) {
              if (!Array.isArray(s.labels)) s.labels = [];
              if (!Array.isArray(s.images)) s.images = [];
              if (!Array.isArray(s.dataLayers)) s.dataLayers = [];
              s.label = partName(i);
            });
          });
          if (!state.workshops.length) state.workshops.push(makeWorkshop('Workshop 1'));
          state.wsIndex = 0;
          state.stepIndex = 0;
        })
        .catch(function () {
          state.workshops = [makeWorkshop('Workshop 1')];
          state.wsIndex = 0;
          state.stepIndex = 0;
        });
    }

    function loadFloorplans() {
      return fetch('/api/floorplans', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) { state.floorplans = (d && Array.isArray(d.floorplans)) ? d.floorplans : []; })
        .catch(function () { state.floorplans = []; });
    }

    // Refreshes the map's shared id/name registry of uploaded layers.
    function loadCustomLayers() {
      return new Promise(function (resolve) {
        window.CompactCustomGeoLayers.refresh(function () { resolve(); });
      });
    }

    function loadDataLayers() {
      return fetch('/api/data-layers', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) { state.dataLayers = (d && Array.isArray(d.layers)) ? d.layers : []; })
        .catch(function () { state.dataLayers = []; });
    }

    // The runtime's applyStep without the input tagging.
    function applyStepToMap(step) {
      var a = getApp();
      if (step.indoor) a.setIndoorFloorplan(step.indoorId || '');
      a.setMapTheme(step.indoor ? 'floorplan' : (step.theme || 'streets'));
      if (step.mapView) a.applyStepView(step.mapView);
      // setDataLayers waits out any style reload setMapTheme started.
      a.setDataLayers(Array.isArray(step.dataLayers) ? step.dataLayers : []);
    }

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
      var images = Array.isArray(step.images) ? step.images : [];
      images.forEach(function (img, i) { overlay.appendChild(buildImageChip(img, i, step)); });
    }

    // Follows the mouse until the button is released, then saves.
    function trackDrag(onMove) {
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        scheduleSave();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    // Dragging the chip stores its centre as a fraction of the map container.
    function makeMovable(chip, item) {
      chip.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var rect = getContainer().getBoundingClientRect();
        trackDrag(function (ev) {
          item.xPct = clamp01((ev.clientX - rect.left) / rect.width);
          item.yPct = clamp01((ev.clientY - rect.top) / rect.height);
          chip.style.left = (item.xPct * 100) + '%';
          chip.style.top = (item.yPct * 100) + '%';
        });
      });
    }

    function addDeleteButton(chip, list, index) {
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
        list.splice(index, 1);
        renderLabels();
        scheduleSave();
      });
      chip.appendChild(del);
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

      var textEl = document.createElement('span');
      textEl.textContent = String(label.text || '');
      textEl.setAttribute('contenteditable', 'true');
      textEl.style.outline = 'none';
      textEl.style.cursor = 'text';
      // Editing the text must not start a drag.
      textEl.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      textEl.addEventListener('input', function () {
        label.text = textEl.textContent;
        scheduleSave();
      });
      chip.appendChild(textEl);
      addDeleteButton(chip, step.labels, index);
      makeMovable(chip, label);
      return chip;
    }

    function buildImageChip(image, index, step) {
      var chip = document.createElement('div');
      var widthPct = Math.max(0.05, Math.min(0.8, Number(image.widthPct) || 0.2));
      Object.assign(chip.style, {
        position: 'absolute',
        left: (clamp01(image.xPct) * 100) + '%',
        top: (clamp01(image.yPct) * 100) + '%',
        width: (widthPct * 100) + '%',
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'auto', cursor: 'move',
        outline: '1px dashed rgba(111,227,214,0.9)',
        userSelect: 'none'
      });

      var img = document.createElement('img');
      img.src = String(image.src || '');
      img.alt = String(image.name || 'Workshop image');
      img.draggable = false;
      Object.assign(img.style, {
        display: 'block', width: '100%', height: 'auto',
        pointerEvents: 'none', userSelect: 'none'
      });
      chip.appendChild(img);
      addDeleteButton(chip, step.images, index);

      var resize = document.createElement('span');
      resize.title = 'Resize image';
      Object.assign(resize.style, {
        position: 'absolute', right: '-6px', bottom: '-6px',
        width: '13px', height: '13px', borderRadius: '2px',
        background: '#6fe3d6', border: '1px solid rgba(0,0,0,0.55)',
        cursor: 'nwse-resize'
      });
      resize.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var containerRect = getContainer().getBoundingClientRect();
        var startX = e.clientX;
        var startWidth = chip.getBoundingClientRect().width;
        trackDrag(function (ev) {
          var next = Math.max(0.05, Math.min(0.8, (startWidth + ev.clientX - startX) / containerRect.width));
          image.widthPct = next;
          chip.style.width = (next * 100) + '%';
        });
      });
      chip.appendChild(resize);
      makeMovable(chip, image);
      return chip;
    }

    function addLabel() {
      var step = curStep();
      if (!step) return;
      if (!Array.isArray(step.labels)) step.labels = [];
      step.labels.push({ text: 'Text', xPct: 0.5, yPct: 0.5, fontSize: 20, bgOpacity: 0.6 });
      renderLabels();
      scheduleSave();
    }

    function addImage(file) {
      var step = curStep();
      if (!step || !file) return;
      var form = new FormData();
      form.append('file', file);
      setStatus('Uploading image…');
      fetch('/api/workshop-assets', { method: 'POST', body: form })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (result) {
          if (!result.ok || !result.data || !result.data.url) {
            throw new Error((result.data && result.data.error) || 'upload_failed');
          }
          if (!Array.isArray(step.images)) step.images = [];
          step.images.push({
            src: result.data.url,
            name: result.data.name || file.name || 'Workshop image',
            xPct: 0.5, yPct: 0.5, widthPct: 0.2
          });
          renderLabels();
          setStatus('Image added ✓');
          scheduleSave();
        })
        .catch(function (err) { setStatus('Image upload failed: ' + ((err && err.message) || ''), 'err'); });
    }

    function css(el, styles) {
      Object.assign(el.style, styles);
      return el;
    }

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
      els.status.textContent = msg || '';
      els.status.style.color = kind === 'err' ? '#ff8d7e' : 'rgba(255,255,255,0.6)';
    }

    function ensurePanel() {
      if (panel) return panel;
      // A native select's option list opens on a light OS popup: dark text there.
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

      var head = css(document.createElement('div'), {
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.14)'
      });
      var title = document.createElement('div');
      title.textContent = 'Workshop editor';
      css(title, { fontWeight: '700', fontSize: '15px', flex: '1' });
      head.appendChild(title);
      head.appendChild(mkBtn('Close', closeEditor));
      panel.appendChild(head);

      var body = css(document.createElement('div'), {
        flex: '1', minHeight: '0', overflowY: 'auto', padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: '12px'
      });
      panel.appendChild(body);

      var wsRow = css(document.createElement('div'), { display: 'flex', gap: '6px', alignItems: 'center' });
      els.wsSelect = document.createElement('select');
      css(els.wsSelect, fieldStyle());
      els.wsSelect.style.flex = '1';
      els.wsSelect.addEventListener('change', function () { selectWorkshop(Number(els.wsSelect.value)); });
      wsRow.appendChild(els.wsSelect);
      wsRow.appendChild(mkBtn('New', newWorkshop));
      wsRow.appendChild(mkBtn('Delete', deleteWorkshop, Object.assign({}, BTN, { color: '#ff8d7e', borderColor: '#e6c6c0' })));
      body.appendChild(wsRow);

      els.nameInput = document.createElement('input');
      els.nameInput.type = 'text';
      els.nameInput.placeholder = 'Workshop name';
      css(els.nameInput, fieldStyle());
      els.nameInput.addEventListener('input', function () {
        var w = curWorkshop();
        if (!w) return;
        w.name = els.nameInput.value;
        renderWsSelect();
        scheduleSave();
      });
      els.nameInput.style.width = '100%';
      body.appendChild(labeledRow('Name', els.nameInput));

      var stepsHead = css(document.createElement('div'), { display: 'flex', alignItems: 'center', gap: '8px' });
      var stepsLbl = sectionLabel('Workshop parts');
      stepsLbl.style.flex = '1';
      stepsLbl.style.margin = '0';
      stepsHead.appendChild(stepsLbl);
      stepsHead.appendChild(mkBtn('+ Add part', addStep, PRIMARY));
      body.appendChild(stepsHead);
      els.stepList = css(document.createElement('div'), { display: 'flex', flexDirection: 'column', gap: '4px' });
      body.appendChild(els.stepList);

      els.stepControls = css(document.createElement('div'), {
        display: 'flex', flexDirection: 'column', gap: '10px',
        paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.14)'
      });
      body.appendChild(els.stepControls);
      buildStepControls();

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

    function labeledRow(text, row) {
      var wrap = document.createElement('div');
      wrap.appendChild(sectionLabel(text));
      wrap.appendChild(row);
      return wrap;
    }

    function buildStepControls() {
      var c = els.stepControls;

      var envRow = css(document.createElement('div'), { display: 'flex', gap: '6px' });
      els.envOutdoor = mkBtn('Outdoor', function () { setEnvironment(false); });
      els.envIndoor = mkBtn('Indoor', function () { setEnvironment(true); });
      els.envOutdoor.style.flex = '1';
      els.envIndoor.style.flex = '1';
      envRow.appendChild(els.envOutdoor);
      envRow.appendChild(els.envIndoor);
      c.appendChild(labeledRow('Environment', envRow));

      els.themeSelect = document.createElement('select');
      css(els.themeSelect, fieldStyle());
      els.themeSelect.style.width = '100%';
      OUTDOOR_THEMES.forEach(function (t) {
        var o = document.createElement('option');
        o.value = t.value;
        o.textContent = t.label;
        els.themeSelect.appendChild(o);
      });
      els.themeSelect.addEventListener('change', function () {
        var s = curStep();
        if (!s) return;
        s.theme = els.themeSelect.value;
        applyStepToMap(s);
        scheduleSave();
      });
      els.themeWrap = labeledRow('Basemap', els.themeSelect);
      c.appendChild(els.themeWrap);

      var fpRow = css(document.createElement('div'), { display: 'flex', gap: '6px', alignItems: 'center' });
      els.fpSelect = document.createElement('select');
      css(els.fpSelect, fieldStyle());
      els.fpSelect.style.flex = '1';
      els.fpSelect.addEventListener('change', function () {
        var s = curStep();
        if (!s) return;
        s.indoorId = els.fpSelect.value || '';
        applyStepToMap(s);
        scheduleSave();
      });
      els.fpFile = document.createElement('input');
      els.fpFile.type = 'file';
      els.fpFile.accept = '.dxf';
      els.fpFile.style.display = 'none';
      els.fpFile.addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        if (f) uploadFloorplan(f);
        els.fpFile.value = '';
      });
      fpRow.appendChild(els.fpSelect);
      fpRow.appendChild(mkBtn('Upload', function () { els.fpFile.click(); }));
      fpRow.appendChild(els.fpFile);
      els.fpWrap = labeledRow('Floorplan (.dxf)', fpRow);
      c.appendChild(els.fpWrap);

      // A checkbox per data layer (see renderDataLayerChecks), then a drop zone
      // for GeoJSON or uMap backup files.
      els.layersCol = css(document.createElement('div'), { display: 'flex', flexDirection: 'column', gap: '5px' });
      var layersWrap = labeledRow('Data layers', els.layersCol);
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
      els.layerDrop.addEventListener('dragover', function (e) {
        e.preventDefault();
        setDropHot(true);
      });
      els.layerDrop.addEventListener('dragleave', function () { setDropHot(false); });
      els.layerDrop.addEventListener('drop', function (e) {
        e.preventDefault();
        setDropHot(false);
        uploadCustomLayers(e.dataTransfer && e.dataTransfer.files);
      });
      layersWrap.appendChild(els.layerDrop);
      layersWrap.appendChild(els.layerFile);
      c.appendChild(layersWrap);

      var actRow = css(document.createElement('div'), { display: 'flex', gap: '6px' });
      var capBtn = mkBtn('Capture view', captureView, PRIMARY);
      capBtn.style.flex = '1';
      var textBtn = mkBtn('+ Add text', addLabel);
      textBtn.style.flex = '1';
      els.imageFile = document.createElement('input');
      els.imageFile.type = 'file';
      els.imageFile.accept = 'image/png,image/jpeg,image/webp';
      els.imageFile.style.display = 'none';
      els.imageFile.addEventListener('change', function () {
        var file = els.imageFile.files && els.imageFile.files[0];
        els.imageFile.value = '';
        if (file) addImage(file);
      });
      var imageBtn = mkBtn('+ Add image', function () { els.imageFile.click(); });
      imageBtn.style.flex = '1';
      actRow.appendChild(capBtn);
      actRow.appendChild(textBtn);
      actRow.appendChild(imageBtn);
      c.appendChild(actRow);
      c.appendChild(els.imageFile);

      var viewHint = css(document.createElement('div'), { fontSize: '11px', color: 'rgba(255,255,255,0.5)', lineHeight: '1.4' });
      viewHint.textContent = 'Pan/zoom the map, then Capture view to save this part’s camera.';
      c.appendChild(viewHint);
    }

    function layerCheckRow(key, label, onDelete) {
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
        var s = curStep();
        if (!s) return;
        if (!Array.isArray(s.dataLayers)) s.dataLayers = [];
        var i = s.dataLayers.indexOf(key);
        if (cb.checked && i === -1) s.dataLayers.push(key);
        if (!cb.checked && i !== -1) s.dataLayers.splice(i, 1);
        getApp().setDataLayers(s.dataLayers);
        scheduleSave();
      });
      var txt = css(document.createElement('span'), {
        flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      });
      txt.textContent = label;
      row.appendChild(cb);
      row.appendChild(txt);
      // preventDefault: inside the label, the click would also toggle the checkbox.
      var delStyle = Object.assign({}, BTN, { padding: '1px 3px', fontSize: '15px', lineHeight: '1', color: '#ff8d7e', border: '0', background: 'transparent' });
      var del = mkBtn('🗑', function (e) {
        e.preventDefault();
        e.stopPropagation();
        onDelete();
      }, delStyle);
      del.title = 'Remove from Data Layers';
      del.setAttribute('aria-label', 'Remove ' + label + ' from Data Layers');
      row.appendChild(del);
      return row;
    }

    function renderCustomSublayers(layer, host) {
      var key = String(layer.id || '');
      var id = key.slice(CUSTOM_PREFIX.length);
      if (!id) return;
      var geo = window.CompactCustomGeoLayers;

      var sublayers = geo.getSublayers(id);
      if (!sublayers) {
        var loading = css(document.createElement('div'), {
          marginLeft: '24px', color: 'rgba(255,255,255,0.45)',
          font: '11px system-ui, sans-serif'
        });
        loading.textContent = 'Loading sublayers…';
        host.appendChild(loading);
        geo.loadLayer(id, function () {
          if (host.isConnected) renderDataLayerChecks();
        });
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
        var shown = (geo.getSublayers(id) || []).filter(function (entry) { return entry.visible; }).length;
        summary.textContent = shown + '/' + sublayers.length + ' sublayers';
      }
      updateSummary();
      details.appendChild(summary);

      var controls = css(document.createElement('div'), {
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        gap: '5px', padding: '3px 0 4px'
      });
      function sublayerButton(text, show) {
        return mkBtn(text, function (e) {
          e.preventDefault();
          e.stopPropagation();
          geo.setAllSublayersVisible(id, show);
          renderDataLayerChecks();
        }, Object.assign({}, BTN, { padding: '2px 6px', fontSize: '10px' }));
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
          geo.setSublayerVisible(id, entry.name, checkbox.checked);
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

    function refreshAfterLayerChange() {
      renderDataLayerChecks();
      var s = curStep();
      if (s) getApp().setDataLayers(s.dataLayers || []);
      scheduleSave();
    }

    function uploadCustomLayers(files) {
      var list = Array.prototype.slice.call(files || []).filter(function (f) {
        return /\.(?:(?:geo)?json|umap)$/i.test(String((f && f.name) || ''));
      });
      if (!list.length) {
        setStatus('Only .geojson/.json/.umap files', 'err');
        return;
      }
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
            // Switched on for the current part straight away.
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
              refreshAfterLayerChange();
              setStatus(failed ? 'Some uploads failed' : 'Layer added ✓', failed ? 'err' : '');
            });
          });
      });
    }

    function deleteDataLayer(layer) {
      var key = String((layer && layer.id) || '');
      var name = String((layer && layer.name) || key);
      if (!key) return;
      if (!window.confirm('Remove layer "' + name + '" from Data Layers? It will be removed from every workshop, but its source file will be kept.')) return;
      fetch('/api/data-layers/' + encodeURIComponent(key), { method: 'DELETE' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok) throw new Error((d && d.error) || 'delete_failed');
          state.workshops.forEach(function (w) {
            (Array.isArray(w.steps) ? w.steps : []).forEach(function (s) {
              if (!Array.isArray(s.dataLayers)) return;
              var i = s.dataLayers.indexOf(key);
              if (i !== -1) s.dataLayers.splice(i, 1);
            });
          });
          if (key.indexOf(CUSTOM_PREFIX) === 0) {
            window.CompactCustomGeoLayers.forget(key.slice(CUSTOM_PREFIX.length));
          }
          return Promise.all([loadCustomLayers(), loadDataLayers()]);
        })
        .then(function () {
          refreshAfterLayerChange();
          setStatus('Layer removed from Data Layers');
        })
        .catch(function (err) { setStatus('Remove failed: ' + ((err && err.message) || ''), 'err'); });
    }

    function renderWsSelect() {
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
      els.stepList.innerHTML = '';
      var w = curWorkshop();
      if (!w) return;
      w.steps.forEach(function (step, i) {
        var selected = i === state.stepIndex;
        var row = css(document.createElement('div'), {
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '7px 9px', borderRadius: '7px', cursor: 'pointer',
          border: '1px solid ' + (selected ? 'rgba(47,143,134,0.9)' : 'rgba(255,255,255,0.14)'),
          background: selected ? 'rgba(47,143,134,0.22)' : 'rgba(255,255,255,0.05)'
        });
        var num = css(document.createElement('span'), { opacity: '0.6', fontSize: '11px', flex: '0 0 auto' });
        num.textContent = 'P' + (i + 1);
        var nm = css(document.createElement('span'), { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: '600' });
        nm.textContent = partName(i);
        var envTag = css(document.createElement('span'), { fontSize: '10px', opacity: '0.7', flex: '0 0 auto' });
        envTag.textContent = step.indoor ? 'indoor' : 'outdoor';
        row.appendChild(num);
        row.appendChild(nm);
        row.appendChild(envTag);
        row.addEventListener('click', function () { selectStep(i); });
        if (w.steps.length > 1) {
          var delStyle = Object.assign({}, BTN, { padding: '2px 8px', color: '#ff8d7e', borderColor: 'transparent', background: 'transparent' });
          row.appendChild(mkBtn('×', function (e) {
            e.stopPropagation();
            deleteStep(i);
          }, delStyle));
        }
        els.stepList.appendChild(row);
      });
    }

    function renderStepControls() {
      var step = curStep();
      if (!step) return;
      var onStyle = { background: 'rgba(47,143,134,0.9)', borderColor: 'rgba(53,160,148,0.95)' };
      var offStyle = { background: 'rgba(255,255,255,0.12)', borderColor: 'rgba(255,255,255,0.28)' };
      css(els.envOutdoor, step.indoor ? offStyle : onStyle);
      css(els.envIndoor, step.indoor ? onStyle : offStyle);
      els.themeWrap.style.display = step.indoor ? 'none' : 'block';
      els.fpWrap.style.display = step.indoor ? 'block' : 'none';
      els.themeSelect.value = step.theme || 'streets';
      renderFloorplanSelect(step);
      renderDataLayerChecks();
    }

    function renderFloorplanSelect(step) {
      els.fpSelect.innerHTML = '';
      var def = document.createElement('option');
      def.value = '';
      def.textContent = 'Default plan';
      els.fpSelect.appendChild(def);
      state.floorplans.forEach(function (fp) {
        var o = document.createElement('option');
        o.value = fp.id;
        o.textContent = fp.name || fp.id;
        els.fpSelect.appendChild(o);
      });
      els.fpSelect.value = step.indoorId || '';
    }

    function renderAll() {
      renderWsSelect();
      var w = curWorkshop();
      els.nameInput.value = w ? (w.name || '') : '';
      renderStepList();
      renderStepControls();
      renderLabels();
    }

    function selectWorkshop(idx) {
      if (idx < 0 || idx >= state.workshops.length) return;
      state.wsIndex = idx;
      state.stepIndex = 0;
      var s = curStep();
      if (s) applyStepToMap(s);
      renderAll();
    }

    function selectStep(idx) {
      var w = curWorkshop();
      if (!w) return;
      state.stepIndex = Math.max(0, Math.min(idx, w.steps.length - 1));
      var s = curStep();
      if (s) applyStepToMap(s);
      renderStepList();
      renderStepControls();
      renderLabels();
    }

    function newWorkshop() {
      state.workshops.push(makeWorkshop('Workshop ' + (state.workshops.length + 1)));
      selectWorkshop(state.workshops.length - 1);
      scheduleSave();
    }

    function deleteWorkshop() {
      var target = curWorkshop();
      if (!target) return;
      var targetId = String(target.id || '');
      var targetName = String(target.name || 'this workshop');

      function removeTarget() {
        var targetIndex = state.workshops.indexOf(target);
        if (targetIndex < 0 && targetId) {
          targetIndex = state.workshops.findIndex(function (workshop) {
            return String((workshop && workshop.id) || '') === targetId;
          });
        }
        if (targetIndex < 0) return;
        state.workshops.splice(targetIndex, 1);
        if (!state.workshops.length) state.workshops.push(makeWorkshop('Workshop 1'));
        state.wsIndex = Math.max(0, Math.min(targetIndex - 1, state.workshops.length - 1));
        state.stepIndex = 0;
        selectWorkshop(state.wsIndex);
        scheduleSave();
      }

      window.CompactPageFlow.confirmDialog({
        title: 'Delete workshop?',
        message: '"' + targetName + '" and all of its parts will be permanently deleted.',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        danger: true,
        onConfirm: removeTarget
      });
    }

    function addStep() {
      var w = curWorkshop();
      if (!w) return;
      w.steps.push(makeStep(w.steps.length + 1));
      selectStep(w.steps.length - 1);
      scheduleSave();
    }

    function deleteStep(idx) {
      var w = curWorkshop();
      if (!w || w.steps.length <= 1) return;
      w.steps.splice(idx, 1);
      w.steps.forEach(function (s, i) {
        s.id = i + 1;
        s.label = partName(i);
      });
      if (state.stepIndex >= w.steps.length) state.stepIndex = w.steps.length - 1;
      selectStep(state.stepIndex);
      scheduleSave();
    }

    function setEnvironment(indoor) {
      var s = curStep();
      if (!s) return;
      if (!!s.indoor === !!indoor) return;
      s.indoor = !!indoor;
      // An outdoor view does not frame the indoor plan or the other way round.
      s.mapView = null;
      applyStepToMap(s);
      renderStepControls();
      renderStepList();
      scheduleSave();
    }

    function captureView() {
      var s = curStep();
      if (!s) return;
      s.mapView = getApp().getMapView();
      setStatus('View captured ✓');
      setTimeout(function () {
        if (els.status.textContent === 'View captured ✓') setStatus('');
      }, 1200);
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
          if (s) {
            s.indoor = true;
            s.indoorId = res.d.id || '';
            s.mapView = null;
            applyStepToMap(s);
          }
          renderStepControls();
          renderStepList();
          setStatus('Floorplan added ✓');
          scheduleSave();
        })
        .catch(function (err) { setStatus('Upload failed: ' + ((err && err.message) || ''), 'err'); });
    }

    function openEditor() {
      if (open) return;
      // Authoring takes the map over from a running workshop.
      var runtime = window.CompactWorkshopRuntime;
      if (runtime.isActive()) runtime.exit();
      ensurePanel();
      ensureLabelOverlay();
      open = true;
      panel.style.display = 'flex';
      var start = loaded
        ? Promise.resolve()
        : Promise.all([loadWorkshops(), loadFloorplans(), loadCustomLayers(), loadDataLayers()]).then(function () { loaded = true; });
      start.then(function () {
        var s = curStep();
        if (s) applyStepToMap(s);
        renderAll();
      });
    }

    function closeEditor() {
      if (!open) return;
      open = false;
      panel.style.display = 'none';
      renderLabels();
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveNow();
      }
    }

    return { open: openEditor, close: closeEditor, isOpen: function () { return open; } };
  }

  window.CompactWorkshopEditor = createEditor();
})();
