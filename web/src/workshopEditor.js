(function () {
  // The Project panel on the map page: merges workshop authoring (projects, steps,
  // environment, basemap/floorplan, camera view, on-map texts and images) with the
  // Results list (inside Data layers, with other projects' results dimmed) and the
  // per-project Visualization settings (drawings, comments, heatmap -- sticker marks with a density
  // or hexagon surface, coloured by sticker type -- and the timeline) and the views it puts on the
  // printed map view sheets.
  'use strict';

  function clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
  }

  function uid() {
    return 'ws_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  // A step's basemap buttons, in order. 'floorplan' is the indoor plan (older steps say indoor: true),
  // 'blank' an empty sheet in the step's blankColor.
  var BASEMAPS = [
    { value: 'streets', label: 'OpenStreetMap', title: 'The standard OpenStreetMap street map' },
    { value: 'satellite', label: 'Satellite', title: 'Aerial photos (Esri World Imagery)' },
    { value: 'topo', label: 'Terrain', title: 'OpenTopoMap: contour lines and hill shading' },
    { value: 'paper', label: 'Print style', title: 'The style the paper map sheets are printed in, as set in Generate Paper Map' },
    { value: 'floorplan', label: 'Indoor plan', title: 'A building floor plan, from a .dxf file' },
    { value: 'blank', label: 'Empty sheet', title: 'A plain sheet in one colour. Click it again to pick the colour.' }
  ];
  var DEFAULT_BLANK_COLOR = '#ffffff';

  function basemapLabel(theme) {
    for (var i = 0; i < BASEMAPS.length; i++) {
      if (BASEMAPS[i].value === theme) return BASEMAPS[i].label;
    }
    return '';
  }

  function stepTheme(step) {
    if (!step) return 'streets';
    if (step.indoor || step.theme === 'floorplan') return 'floorplan';
    return basemapLabel(step.theme) ? String(step.theme) : 'streets';
  }

  function blankColor(step) {
    var c = step && step.blankColor;
    return /^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c) : DEFAULT_BLANK_COLOR;
  }

  // Two cameras closer than this are the same view.
  function sameView(a, b) {
    if (!a || !b || !Array.isArray(a.center) || !Array.isArray(b.center)) return false;
    return Math.abs(a.center[0] - b.center[0]) < 1e-7 && Math.abs(a.center[1] - b.center[1]) < 1e-7
      && Math.abs((a.zoom || 0) - (b.zoom || 0)) < 1e-4 && Math.abs((a.bearing || 0) - (b.bearing || 0)) < 1e-3
      && Math.abs((a.pitch || 0) - (b.pitch || 0)) < 1e-3;
  }

  // A step lists uploaded GeoJSON layers in its dataLayers as 'custom:<file id>', and in
  // layerOpacity (0-1) how opaque the ones coloured by a value are.
  var CUSTOM_PREFIX = 'custom:';
  var RESULT_PREFIX = 'result:';
  var COLLAPSED_KEY = 'compact-results-collapsed';
  // marks: each mark (a sticker placed) as a dot; heatmap: the surface under them, heatStyle 'hexagon'
  // or else density; hexMetres: a hexagon's width, flat to flat; hexMix: a hexagon's colour is its
  // marks' colours averaged, weighted by how many of each, instead of the colour most of them are;
  // stickerColors: mark type -> the colour its marks and hexagons are drawn in;
  // hiddenStickerTypes: the types switched off (left out of marks, hexagons and density).
  var DEFAULT_VIS = {
    drawings: true, comments: false, heatmap: true, marks: true, heatStyle: 'density',
    radius: 28, intensity: 1, hexMetres: 150, hexMix: false, stickerColors: {}, hiddenStickerTypes: []
  };

  // A project's visualization with the defaults filled in, and a mark colour list of its own. Marks
  // used to show only under Heatmap: settings saved then (no marksApart) keep them off where it was off.
  function visWithDefaults(v) {
    var out = Object.assign({}, DEFAULT_VIS, v || {});
    if (v && v.marksApart !== true && v.heatmap === false) out.marks = false;
    out.marksApart = true;
    if (out.heatStyle !== 'hexagon') out.heatStyle = 'density';
    out.stickerColors = Object.assign({}, (v && v.stickerColors) || {});
    out.hiddenStickerTypes = Array.isArray(v && v.hiddenStickerTypes) ? v.hiddenStickerTypes.slice() : [];
    return out;
  }

  var platform = navigator.platform || navigator.userAgent || '';
  var REVEAL_LABEL = /Mac/i.test(platform) ? 'Show in Finder' : /Win/i.test(platform) ? 'Show in Explorer' : 'Open its folder';

  function readCollapsed() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) || '{}');
      return saved && typeof saved === 'object' ? saved : {};
    } catch (_err) {
      return {};
    }
  }

  function saveCollapsed(collapsed) {
    try { window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed)); } catch (_err) { }
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function createEditor() {
    var state = {
      workshops: [],
      wsIndex: -1,
      stepIndex: 0,
      shownSteps: new Set(),     // step numbers (step.id || idx + 1) currently ticked for the active project
      floorplans: [],
      dataLayers: [],
      picked: new Set(),         // result keys ('<kind>:<filename>') picked in the results tree
      anchor: null,
      pickedMarks: new Set(),    // mark types picked in the Mark types list
      markAnchor: null,
      collapsed: readCollapsed()
    };
    var open = false;
    // While the panel is open and loaded, the map's camera is the open step's view.
    var tracksView = false;
    var viewListenerOn = false;
    var previewTimer = 0;
    var saveTimer = 0;
    var loaded = false;
    var sublayersOpenById = {};
    var folders = null;
    var pathSeparator = '/';
    var drag = null;
    var markDrag = null;

    var panel = null;
    var rowMenu = null;
    var labelOverlay = null;
    var els = {};
    var container = null;

    function getApp() { return window.CompactMapApp; }
    function getResults() { return window.CompactResultsLayer; }

    function getContainer() {
      if (!container) container = document.getElementById('main_container') || document.body;
      return container;
    }

    function make(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }

    function curWorkshop() {
      return state.workshops[state.wsIndex] || null;
    }

    function curStep() {
      var w = curWorkshop();
      if (!w || !Array.isArray(w.steps)) return null;
      return w.steps[state.stepIndex] || null;
    }

    function stepName(idx) {
      return 'Step ' + (idx + 1);
    }

    function stepNumber(step, idx) {
      return (step && Number(step.id)) || (idx + 1);
    }

    // A new step starts from the map's current view.
    function makeStep(n) {
      var a = getApp();
      return {
        id: n, label: stepName(n - 1), theme: 'streets', indoor: false, indoorId: '', blankColor: DEFAULT_BLANK_COLOR,
        mapView: a ? a.getMapView() : null, labels: [], images: [], dataLayers: []
      };
    }

    function makeWorkshop(name) {
      return { id: uid(), name: name, steps: [makeStep(1)], visualization: visWithDefaults() };
    }

    function curVis() {
      var w = curWorkshop();
      if (!w) return visWithDefaults();
      w.visualization = visWithDefaults(typeof w.visualization === 'object' ? w.visualization : null);
      return w.visualization;
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
          if (els.status && els.status.textContent === 'Saved') setStatus('');
        }, 1200);
      }).catch(function () { setStatus('Save failed', 'err'); });
    }

    function normalizeWorkshops(list) {
      (list || []).forEach(function (w) {
        if (!Array.isArray(w.steps) || !w.steps.length) w.steps = [makeStep(1)];
        w.steps.forEach(function (s, i) {
          s.id = i + 1;
          if (!Array.isArray(s.labels)) s.labels = [];
          if (!Array.isArray(s.images)) s.images = [];
          if (!Array.isArray(s.dataLayers)) s.dataLayers = [];
          s.label = stepName(i);
          s.theme = stepTheme(s);
          s.indoor = s.theme === 'floorplan';
        });
        w.visualization = visWithDefaults(w.visualization);
      });
    }

    function loadWorkshops() {
      return fetch('/api/workshops', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var prevId = curWorkshop() && curWorkshop().id;
          state.workshops = (d && Array.isArray(d.workshops)) ? d.workshops : [];
          normalizeWorkshops(state.workshops);
          if (!state.workshops.length) state.workshops.push(makeWorkshop('Project 1'));
          var foundIdx = prevId ? state.workshops.findIndex(function (w) { return w.id === prevId; }) : -1;
          state.wsIndex = foundIdx >= 0 ? foundIdx : 0;
          state.stepIndex = Math.min(state.stepIndex, state.workshops[state.wsIndex].steps.length - 1);
          initShownSteps();
        })
        .catch(function () {
          if (!state.workshops.length) {
            state.workshops = [makeWorkshop('Project 1')];
            state.wsIndex = 0;
            state.stepIndex = 0;
            initShownSteps();
          }
        });
    }

    function initShownSteps() {
      var w = curWorkshop();
      state.shownSteps = new Set();
      if (!w || !Array.isArray(w.steps)) return;
      w.steps.forEach(function (s, i) {
        state.shownSteps.add(stepNumber(s, i));
      });
      if (w.id && state.collapsed[w.id] === undefined) {
        state.collapsed[w.id] = false;
      }
    }

    function loadFloorplans() {
      return fetch('/api/floorplans', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) { state.floorplans = (d && Array.isArray(d.floorplans)) ? d.floorplans : []; })
        .catch(function () { state.floorplans = []; });
    }

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

    function loadResults() {
      return getResults().load().catch(function () { });
    }

    // Union of dataLayers across all ticked steps of the current project.
    function activeDataLayersForShownSteps() {
      var w = curWorkshop();
      if (!w || !Array.isArray(w.steps)) return [];
      var out = [];
      w.steps.forEach(function (s, i) {
        if (!state.shownSteps.has(stepNumber(s, i))) return;
        (Array.isArray(s.dataLayers) ? s.dataLayers : []).forEach(function (id) {
          if (out.indexOf(id) === -1) out.push(id);
        });
      });
      return out;
    }

    // The open step's opacity for the layers coloured by a value, or null for their default.
    function stepLayerOpacity() {
      var s = curStep();
      return s && typeof s.layerOpacity === 'number' && isFinite(s.layerOpacity) ? s.layerOpacity : null;
    }

    function syncMapLayers() {
      if (running()) {
        getRuntime().setVisibleSteps(Array.from(state.shownSteps));
        showInRun();
        return;
      }
      var a = getApp();
      var w = curWorkshop();
      if (!w) return;
      var allChecked = Array.isArray(w.steps) && state.shownSteps.size >= w.steps.length;
      var stepsArr = Array.from(state.shownSteps);
      a.setVisibleWorkshopSteps(allChecked ? null : stepsArr, w.id || '');
      a.setDataLayers(activeDataLayersForShownSteps(), stepLayerOpacity());
    }

    // Applies the open step's camera/basemap and the ticked steps' data layers.
    function applyStepToMap(step) {
      if (!step) return;
      if (running()) {
        showInRun();
        return;
      }
      var a = getApp();
      var w = curWorkshop();
      getResults().setDisplay(curVis());
      a.applyStepBasemap(step);
      if (step.mapView) a.applyStepView(step.mapView);
      if (w) syncMapLayers();
      syncMapSheets();
    }

    // ---------------------------------------------------------------- during a workshop run
    // The panel can open while a workshop runs. It then edits the running project: its open step is
    // the run's step, picking another step moves the run there, and changes show on the run's map.
    // The camera stays the facilitator's: moving the map does not change the step's saved view.
    function getRuntime() { return window.CompactWorkshopRuntime; }

    function running() {
      var runtime = getRuntime();
      return !!(runtime && runtime.isActive());
    }

    function showInRun() {
      var run = getRuntime().current();
      if (!run) return;
      if (run.stepIndex !== state.stepIndex) getRuntime().goTo(state.stepIndex);
      else getRuntime().refresh();
    }

    // The panel follows the run: its project, its step and the steps whose inputs it shows.
    function syncFromRun() {
      var runtime = getRuntime();
      var run = runtime.current();
      if (!run) return;
      var id = String(run.workshop.id || '');
      var idx = state.workshops.indexOf(run.workshop);
      if (idx < 0 && id) {
        idx = state.workshops.findIndex(function (w) { return String((w && w.id) || '') === id; });
      }
      if (idx < 0) {
        state.workshops.push(run.workshop);
        idx = state.workshops.length - 1;
      }
      state.wsIndex = idx;
      state.stepIndex = run.stepIndex;
      state.shownSteps = new Set(run.visibleSteps);
      // The run uses the panel's copy, the one the panel edits and saves.
      if (state.workshops[idx] !== run.workshop) runtime.setWorkshop(state.workshops[idx]);
      renderAll();
    }

    // The run ended with the panel open: back to editing the project.
    function backToEditing() {
      tracksView = false;
      var s = curStep();
      if (s) applyStepToMap(s);
      renderAll();
      tracksView = true;
    }

    // During a run only the running project can be edited, and Start becomes Exit.
    function renderRunControls() {
      var isRunning = running();
      [els.wsSelect, els.newBtn, els.deleteBtn].forEach(function (el) {
        if (!el) return;
        el.disabled = isRunning;
        el.style.opacity = isRunning ? '0.5' : '';
        el.style.cursor = isRunning ? 'not-allowed' : '';
        el.title = isRunning ? 'Not while the workshop is running' : '';
      });
      if (els.startBtn) els.startBtn.textContent = isRunning ? '■ Exit workshop' : '▶ Start workshop';
    }

    window.addEventListener('compact-workshop-run', function () {
      if (!open || !loaded) return;
      if (running()) syncFromRun();
      else backToEditing();
    });

    // ---------------------------------------------------------------- map view sheets
    // The views the project put on its map view sheets: sheet key -> the table view (mapViewInset.js).
    function curSheetViews() {
      var w = curWorkshop();
      var views = w && w.mapSheetViews;
      return views && typeof views === 'object' && !Array.isArray(views) ? views : {};
    }

    // A sheet the project gave no view follows the street view pointer.
    function syncMapSheets() {
      if (window.CompactMapViewSheets) window.CompactMapViewSheets.setViews(curSheetViews());
    }

    function assignSheetView(sheet) {
      var w = curWorkshop();
      var api = window.CompactMapViewSheets;
      if (!w || !api) return;
      var view = api.currentView();
      if (!w.mapSheetViews || typeof w.mapSheetViews !== 'object' || Array.isArray(w.mapSheetViews)) w.mapSheetViews = {};
      w.mapSheetViews[sheet.key] = view;
      api.setView(sheet.key, view);
      renderMapSheets();
      scheduleSave();
      setStatus(sheet.label + ' shows this view ✓');
    }

    function clearSheetView(sheet) {
      var w = curWorkshop();
      if (!w || !w.mapSheetViews) return;
      delete w.mapSheetViews[sheet.key];
      if (window.CompactMapViewSheets) window.CompactMapViewSheets.setView(sheet.key, null);
      renderMapSheets();
      scheduleSave();
      setStatus(sheet.label + ' follows the pointer');
    }

    // One row per sheet: the button puts the table's current view on it; a dot shows whether the
    // camera sees the sheet on the table (to tell the sheets apart); ↺ lets it follow the pointer again.
    function renderMapSheets() {
      if (!els.mapSheetList) return;
      var api = window.CompactMapViewSheets;
      var sheets = api ? api.list() : [];
      var views = curSheetViews();
      els.mapSheetList.innerHTML = '';
      els.mapSheetDots = {};
      els.mapSheetHint.style.display = sheets.length ? '' : 'none';
      if (!sheets.length) {
        var none = css(document.createElement('div'), { fontSize: '12px', color: 'var(--ui-muted)', lineHeight: '1.4' });
        none.textContent = 'No map view sheets yet: give the map view sheet its border tags, or add more sheets, on the Marker Setting page.';
        els.mapSheetList.appendChild(none);
        return;
      }
      sheets.forEach(function (sheet) {
        var assigned = !!views[sheet.key];
        var row = css(document.createElement('div'), { display: 'flex', gap: '6px', alignItems: 'stretch' });
        var btn = mkBtn('', function () { assignSheetView(sheet); }, assigned ? PRIMARY : BTN);
        css(btn, { flex: '1', minWidth: '0', display: 'flex', alignItems: 'center', gap: '8px', textAlign: 'left' });
        btn.title = 'Show the current map view on ' + sheet.label;
        var dot = css(document.createElement('span'), {
          width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto', background: 'var(--ui-dot-off)',
          boxShadow: '0 0 0 1.5px rgba(255,255,255,0.85)'
        });
        els.mapSheetDots[sheet.key] = dot;
        var name = css(document.createElement('span'), {
          flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
        });
        name.textContent = sheet.label;
        var mode = css(document.createElement('span'), { flex: '0 0 auto', fontSize: '10.5px', fontWeight: '600', opacity: '0.75' });
        mode.textContent = assigned ? 'view set' : 'follows pointer';
        btn.appendChild(dot);
        btn.appendChild(name);
        btn.appendChild(mode);
        row.appendChild(btn);
        if (assigned) {
          var reset = mkBtn('↺', function () { clearSheetView(sheet); }, Object.assign({}, BTN, { padding: '5px 10px' }));
          reset.title = sheet.label + ': follow the street view pointer again';
          reset.setAttribute('aria-label', reset.title);
          row.appendChild(reset);
        }
        els.mapSheetList.appendChild(row);
      });
      updateMapSheetDots();
    }

    function updateMapSheetDots() {
      if (!open || !els.mapSheetDots || !window.CompactMapViewSheets) return;
      window.CompactMapViewSheets.list().forEach(function (sheet) {
        var dot = els.mapSheetDots[sheet.key];
        if (!dot) return;
        dot.style.background = sheet.onTable ? 'var(--ui-dot-on)' : 'var(--ui-dot-off)';
        dot.title = sheet.onTable ? 'On the table' : 'Not seen by the camera';
      });
    }

    // ---------------------------------------------------------------- on-map labels & images
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
      var w = curWorkshop();
      var step = curStep();
      overlay.style.display = (open && step) ? 'block' : 'none';
      if (!open || !w || !step) return;
      // Show editable chips for the open step, plus read-only chips for any other ticked steps
      // (during a run only the open step's, as the run shows).
      var inRun = running();
      w.steps.forEach(function (s, sIdx) {
        var isEditing = sIdx === state.stepIndex;
        if (!isEditing && (inRun || !state.shownSteps.has(stepNumber(s, sIdx)))) return;
        var labels = Array.isArray(s.labels) ? s.labels : [];
        labels.forEach(function (l, i) { overlay.appendChild(buildLabelChip(l, i, s, isEditing)); });
        var images = Array.isArray(s.images) ? s.images : [];
        images.forEach(function (img, i) { overlay.appendChild(buildImageChip(img, i, s, isEditing)); });
      });
    }

    function trackDrag(onMove) {
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        scheduleSave();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

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

    function buildLabelChip(label, index, step, editable) {
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
        pointerEvents: editable ? 'auto' : 'none',
        cursor: editable ? 'move' : 'default',
        outline: editable ? '1px dashed rgba(111,227,214,0.7)' : 'none',
        userSelect: 'none'
      });

      var textEl = document.createElement('span');
      textEl.textContent = String(label.text || '');
      if (editable) {
        textEl.setAttribute('contenteditable', 'true');
        textEl.style.outline = 'none';
        textEl.style.cursor = 'text';
        textEl.addEventListener('mousedown', function (e) { e.stopPropagation(); });
        textEl.addEventListener('input', function () {
          label.text = textEl.textContent;
          scheduleSave();
        });
      }
      chip.appendChild(textEl);
      if (editable) {
        addDeleteButton(chip, step.labels, index);
        makeMovable(chip, label);
      }
      return chip;
    }

    function buildImageChip(image, index, step, editable) {
      var chip = document.createElement('div');
      var widthPct = Math.max(0.05, Math.min(0.8, Number(image.widthPct) || 0.2));
      Object.assign(chip.style, {
        position: 'absolute',
        left: (clamp01(image.xPct) * 100) + '%',
        top: (clamp01(image.yPct) * 100) + '%',
        width: (widthPct * 100) + '%',
        transform: 'translate(-50%, -50%)',
        pointerEvents: editable ? 'auto' : 'none',
        cursor: editable ? 'move' : 'default',
        outline: editable ? '1px dashed rgba(111,227,214,0.9)' : 'none',
        userSelect: 'none'
      });

      var img = document.createElement('img');
      img.src = String(image.src || '');
      img.alt = String(image.name || 'Step image');
      img.draggable = false;
      Object.assign(img.style, {
        display: 'block', width: '100%', height: 'auto',
        pointerEvents: 'none', userSelect: 'none'
      });
      chip.appendChild(img);
      if (editable) {
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
      }
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
            name: result.data.name || file.name || 'Step image',
            xPct: 0.5, yPct: 0.5, widthPct: 0.2
          });
          renderLabels();
          setStatus('Image added ✓');
          scheduleSave();
        })
        .catch(function (err) { setStatus('Image upload failed: ' + ((err && err.message) || ''), 'err'); });
    }

    // ---------------------------------------------------------------- UI helpers
    function css(el, styles) {
      Object.assign(el.style, styles);
      return el;
    }

    // Light, like the menu: the colours are map.css's --ui-* variables.
    var BTN = {
      padding: '7px 11px', font: '600 13px system-ui, sans-serif', color: 'var(--ui-ink)',
      background: 'var(--ui-panel)', border: '1px solid var(--ui-line-strong)',
      borderRadius: '7px', cursor: 'pointer', whiteSpace: 'nowrap'
    };
    var PRIMARY = Object.assign({}, BTN, { color: '#fff', background: 'var(--ui-green)', borderColor: 'var(--ui-green-dark)' });

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
      els.status.style.color = kind === 'err' ? 'var(--ui-danger)' : 'var(--ui-green-dark)';
    }

    function fieldStyle() {
      return {
        boxSizing: 'border-box', padding: '7px 9px', borderRadius: '8px',
        border: '1px solid var(--ui-line-strong)', background: 'var(--ui-panel)',
        color: 'var(--ui-ink)', font: '600 13px system-ui, sans-serif'
      };
    }

    function sectionLabel(text) {
      var l = document.createElement('div');
      l.textContent = text;
      css(l, {
        fontSize: '11px', fontWeight: '700', letterSpacing: '0.05em',
        textTransform: 'uppercase', color: 'var(--ui-muted)', margin: '2px 0'
      });
      return l;
    }

    function labeledRow(text, row) {
      var wrap = document.createElement('div');
      wrap.appendChild(sectionLabel(text));
      wrap.appendChild(row);
      return wrap;
    }

    function slider(labelText, min, max, step, value, format, onInput) {
      var wrap = make('div', 'rp-slider');
      var label = make('div', 'rp-label', labelText + ' ');
      var val = make('span', 'rp-val', format(value));
      label.appendChild(val);
      var input = make('input');
      input.type = 'range';
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = value;
      input.addEventListener('input', function () {
        val.textContent = format(Number(input.value));
        onInput(Number(input.value));
      });
      wrap.appendChild(label);
      wrap.appendChild(input);
      return { wrap: wrap, input: input, val: val, format: format };
    }

    // A sliding switch. Two labels: a choice between them, on being the right-hand one (Density |
    // Hexagon); one label: that setting on or off. onSet(on) gets the new state.
    function makeSwitch(labels, title, onSet) {
      var choice = labels.length === 2;
      var row = make('div', 'rp-switch-row' + (choice ? ' choice' : ''));
      var knob = make('button', 'rp-switch');
      knob.type = 'button';
      knob.title = title;
      knob.setAttribute('role', 'switch');
      knob.setAttribute('aria-checked', 'false');
      knob.setAttribute('aria-label', title);
      knob.appendChild(make('span', 'rp-knob'));
      var isOn = function () { return knob.getAttribute('aria-checked') === 'true'; };
      knob.addEventListener('click', function () { onSet(!isOn()); });
      var sides = labels.map(function (text, i) {
        var side = make('button', 'rp-switch-side', text);
        side.type = 'button';
        side.tabIndex = -1;
        side.title = title;
        side.addEventListener('click', function () { onSet(choice ? i === 1 : !isOn()); });
        return side;
      });
      row.appendChild(sides[0]);
      row.appendChild(knob);
      if (choice) row.appendChild(sides[1]);
      return {
        wrap: row,
        set: function (on) {
          knob.setAttribute('aria-checked', on ? 'true' : 'false');
          row.classList.toggle('on', !!on);
          if (choice) {
            sides[0].classList.toggle('active', !on);
            sides[1].classList.toggle('active', !!on);
          }
        }
      };
    }

    // ---------------------------------------------------------------- panel DOM
    var onBackCallback = null;

    function syncOpenClasses() {
      if (!panel) return;
      panel.classList.toggle('collapsed', !open);
      if (els.body) els.body.style.display = open ? 'flex' : 'none';
      if (els.status) els.status.style.display = open ? '' : 'none';
      if (els.projectBtn) {
        els.projectBtn.classList.toggle('active', open);
        els.projectBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
      }
    }

    function ensurePanel() {
      if (panel) return panel;
      var optStyle = document.createElement('style');
      optStyle.textContent = '#wsEditPanel select option { color: #111; background: #fff; }';
      document.head.appendChild(optStyle);

      panel = document.createElement('div');
      panel.id = 'wsEditPanel';
      panel.className = 'project-panel collapsed';

      var head = document.createElement('div');
      head.id = 'mapTopBar';
      head.className = 'ws-panel-head';
      head.setAttribute('role', 'toolbar');
      head.setAttribute('aria-label', 'Map menu');

      var backBtn = document.createElement('button');
      backBtn.id = 'mapBackButton';
      backBtn.type = 'button';
      backBtn.textContent = 'Back';
      backBtn.title = 'Back to main menu';
      backBtn.className = 'top-btn back';
      backBtn.addEventListener('click', function () {
        if (typeof onBackCallback === 'function') onBackCallback();
      });
      head.appendChild(backBtn);

      var projectBtn = document.createElement('button');
      projectBtn.id = 'mapProjectButton';
      projectBtn.type = 'button';
      projectBtn.textContent = 'Project';
      projectBtn.title = 'Projects: steps, data layers, results and visualization';
      projectBtn.className = 'top-btn';
      projectBtn.setAttribute('aria-pressed', 'false');
      projectBtn.addEventListener('click', function () {
        if (open) closeEditor();
        else openEditor();
      });
      head.appendChild(projectBtn);
      els.projectBtn = projectBtn;

      els.status = css(document.createElement('div'), {
        fontSize: '12px', color: 'var(--ui-green-dark)', marginLeft: 'auto', display: 'none'
      });
      head.appendChild(els.status);
      panel.appendChild(head);

      var body = css(document.createElement('div'), {
        flex: '1', minHeight: '0', overflowY: 'auto', padding: '12px 14px',
        display: 'none', flexDirection: 'column', gap: '12px'
      });
      body.addEventListener('scroll', closeRowMenu);
      panel.appendChild(body);
      els.body = body;

      // 1. Project selector + New / Delete
      var wsRow = css(document.createElement('div'), { display: 'flex', gap: '6px', alignItems: 'center' });
      els.wsSelect = document.createElement('select');
      css(els.wsSelect, fieldStyle());
      els.wsSelect.style.flex = '1';
      els.wsSelect.style.minWidth = '0';
      els.wsSelect.addEventListener('change', function () { selectWorkshop(Number(els.wsSelect.value)); });
      wsRow.appendChild(els.wsSelect);
      els.newBtn = mkBtn('New', newWorkshop);
      wsRow.appendChild(els.newBtn);
      els.deleteBtn = mkBtn('Delete', deleteWorkshop, Object.assign({}, BTN, { color: 'var(--ui-danger)', background: 'var(--ui-danger-soft)', borderColor: 'var(--ui-danger-line)' }));
      wsRow.appendChild(els.deleteBtn);
      body.appendChild(wsRow);

      // 2. Project name + Start workshop
      els.nameInput = document.createElement('input');
      els.nameInput.type = 'text';
      els.nameInput.placeholder = 'Project name';
      css(els.nameInput, fieldStyle());
      els.nameInput.style.width = '100%';
      els.nameInput.addEventListener('input', function () {
        var w = curWorkshop();
        if (!w) return;
        w.name = els.nameInput.value;
        renderWsSelect();
        renderResultsTree();
        scheduleSave();
      });
      body.appendChild(labeledRow('Name', els.nameInput));

      var startBtn = mkBtn('▶ Start workshop', startCurrent, PRIMARY);
      css(startBtn, { width: '100%', padding: '9px 12px', fontSize: '14px' });
      els.startBtn = startBtn;
      body.appendChild(startBtn);

      // 3. Steps list (tick multiple steps to show them together; click a step row to open and edit it)
      var stepsHead = css(document.createElement('div'), {
        display: 'flex', alignItems: 'center', gap: '8px',
        paddingTop: '8px', borderTop: '1px solid var(--ui-line)'
      });
      var stepsLbl = sectionLabel('Steps');
      stepsLbl.style.flex = '1';
      stepsLbl.style.margin = '0';
      stepsHead.appendChild(stepsLbl);
      stepsHead.appendChild(mkBtn('+ Add step', addStep, PRIMARY));
      body.appendChild(stepsHead);

      els.stepList = css(document.createElement('div'), { display: 'flex', flexDirection: 'column', gap: '4px' });
      body.appendChild(els.stepList);

      // 4. Open step editing controls + Data layers + Visualization
      els.stepControls = css(document.createElement('div'), {
        display: 'flex', flexDirection: 'column', gap: '10px',
        paddingTop: '10px', borderTop: '1px solid var(--ui-line)'
      });
      body.appendChild(els.stepControls);
      buildStepControls();

      // Drag-and-drop results files onto the panel
      panel.addEventListener('dragover', function (e) {
        if (!draggingFiles(e)) return;
        e.preventDefault();
        panel.classList.add('dropping');
      });
      panel.addEventListener('dragleave', function (e) {
        if (!panel.contains(e.relatedTarget)) panel.classList.remove('dropping');
      });
      panel.addEventListener('drop', function (e) {
        if (!draggingFiles(e)) return;
        e.preventDefault();
        panel.classList.remove('dropping');
        uploadResultFiles(e.dataTransfer && e.dataTransfer.files);
      });
      window.addEventListener('dragover', function (e) { if (draggingFiles(e)) e.preventDefault(); });
      window.addEventListener('drop', function (e) { if (draggingFiles(e)) e.preventDefault(); });

      rowMenu = make('div');
      rowMenu.id = 'resultsRowMenu';
      rowMenu.hidden = true;
      rowMenu.setAttribute('role', 'menu');
      document.addEventListener('mousedown', function (e) {
        if (rowMenu && !rowMenu.contains(e.target)) closeRowMenu();
      });
      window.addEventListener('resize', closeRowMenu);
      window.addEventListener('blur', closeRowMenu);
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeRowMenu();
      });

      document.body.appendChild(panel);
      document.body.appendChild(rowMenu);

      fetch('/api/results/locations')
        .then(function (r) { return r.json(); })
        .then(function (b) {
          if (!b || !b.ok) return;
          folders = b.folders;
          pathSeparator = b.separator || '/';
        })
        .catch(function () { });

      getResults().onChange(function () {
        syncTimelineControl();
        renderMarkTypes();
      });
      return panel;
    }

    function buildStepControls() {
      var c = els.stepControls;

      els.editingStepHeader = sectionLabel('Editing Step 1');
      els.editingStepHeader.style.color = 'var(--ui-green-dark)';
      c.appendChild(els.editingStepHeader);

      // Square basemap buttons with a preview each; the empty sheet's colour is picked by clicking it again.
      els.basemapGrid = make('div', 'bm-grid');
      els.basemapGrid.setAttribute('role', 'group');
      els.basemapGrid.setAttribute('aria-label', 'Basemap');
      els.basemapTiles = {};
      BASEMAPS.forEach(function (b) {
        var cell = make('div', 'bm-cell');
        var tile = make('button', 'bm-tile');
        tile.type = 'button';
        tile.title = b.title;
        tile.setAttribute('aria-pressed', 'false');
        var preview = make('span', 'bm-preview');
        tile.appendChild(preview);
        tile.appendChild(make('span', 'bm-label', b.label));
        tile.addEventListener('click', function () { setBasemap(b.value); });
        cell.appendChild(tile);
        els.basemapTiles[b.value] = { tile: tile, preview: preview };
        els.basemapGrid.appendChild(cell);
      });
      var blankCell = els.basemapTiles.blank.tile.parentNode;
      var paint = make('span', 'bm-paint');
      paint.setAttribute('aria-hidden', 'true');
      paint.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" ' +
        'stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2a2 2 0 0 0-1.5 3.3A2 2 0 0 1 12 22z"/>' +
        '<circle cx="7.5" cy="10.5" r="1.2"/><circle cx="11" cy="6.8" r="1.2"/><circle cx="16" cy="8.3" r="1.2"/></svg>';
      els.basemapTiles.blank.tile.appendChild(paint);
      // In the cell rather than the button, so the browser's colour picker opens over the tile.
      els.blankColor = make('input', 'bm-color');
      els.blankColor.type = 'color';
      els.blankColor.tabIndex = -1;
      els.blankColor.setAttribute('aria-label', 'Empty sheet colour');
      els.blankColor.addEventListener('input', function () {
        var s = curStep();
        if (!s) return;
        s.blankColor = els.blankColor.value;
        getApp().setBlankSheetColor(s.blankColor);
        renderBasemapTiles(s);
        scheduleSave();
      });
      blankCell.appendChild(els.blankColor);
      c.appendChild(labeledRow('Basemap', els.basemapGrid));

      var fpRow = css(document.createElement('div'), { display: 'flex', gap: '6px', alignItems: 'center' });
      els.fpSelect = document.createElement('select');
      css(els.fpSelect, fieldStyle());
      els.fpSelect.style.flex = '1';
      els.fpSelect.addEventListener('change', function () {
        var s = curStep();
        if (!s) return;
        s.indoorId = els.fpSelect.value || '';
        // Another plan is framed afresh; the framed view then becomes the step's view.
        s.mapView = null;
        applyStepToMap(s);
        renderBasemapTiles(s);
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

      var actRow = css(document.createElement('div'), { display: 'flex', gap: '6px' });
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
      actRow.appendChild(textBtn);
      actRow.appendChild(imageBtn);
      c.appendChild(actRow);
      c.appendChild(els.imageFile);

      // ---------------------------------------------------------------- Data layers (built-in, custom, and results)
      var layersWrap = css(document.createElement('div'), {
        display: 'flex', flexDirection: 'column', gap: '6px',
        paddingTop: '10px', borderTop: '1px solid var(--ui-line)'
      });
      var layersHead = css(document.createElement('div'), { display: 'flex', alignItems: 'center', gap: '6px' });
      var layersTitle = sectionLabel('Data layers');
      layersTitle.style.flex = '1';
      layersTitle.style.margin = '0';
      layersHead.appendChild(layersTitle);

      els.layerFile = document.createElement('input');
      els.layerFile.type = 'file';
      els.layerFile.accept = '.geojson,.json,.umap,application/geo+json,application/json';
      els.layerFile.multiple = true;
      els.layerFile.style.display = 'none';
      els.layerFile.addEventListener('change', function (e) {
        uploadCustomLayers(e.target.files);
        els.layerFile.value = '';
      });
      layersHead.appendChild(mkBtn('+ Map layer', function () { els.layerFile.click(); }, Object.assign({}, BTN, { padding: '4px 8px', fontSize: '11.5px' })));
      layersHead.appendChild(els.layerFile);
      layersWrap.appendChild(layersHead);

      els.layersCol = css(document.createElement('div'), { display: 'flex', flexDirection: 'column', gap: '5px' });
      layersWrap.appendChild(els.layersCol);

      // Results subsection inside Data layers
      var resActions = css(document.createElement('div'), {
        display: 'flex', gap: '6px', alignItems: 'center', marginTop: '4px'
      });
      resActions.appendChild(mkBtn('Show all', function () { setProjectResultsVisible(true); }, Object.assign({}, BTN, { flex: '1', padding: '5px 8px', fontSize: '12px' })));
      resActions.appendChild(mkBtn('Hide all', function () { setProjectResultsVisible(false); }, Object.assign({}, BTN, { flex: '1', padding: '5px 8px', fontSize: '12px' })));
      els.resultFile = document.createElement('input');
      els.resultFile.type = 'file';
      els.resultFile.accept = '.json,.geojson,application/json,application/geo+json';
      els.resultFile.multiple = true;
      els.resultFile.hidden = true;
      els.resultFile.addEventListener('change', function () {
        uploadResultFiles(els.resultFile.files);
        els.resultFile.value = '';
      });
      var uploadResBtn = mkBtn('+ Upload results', function () { els.resultFile.click(); }, Object.assign({}, BTN, {
        padding: '5px 9px', fontSize: '12px', borderStyle: 'dashed',
        borderColor: 'var(--ui-green)', color: 'var(--ui-green-dark)'
      }));
      uploadResBtn.title = 'Upload session, timeline, expo or GeoJSON result files into this project.';
      resActions.appendChild(uploadResBtn);
      resActions.appendChild(els.resultFile);
      layersWrap.appendChild(resActions);

      els.resCount = make('div', 'rp-count');
      layersWrap.appendChild(els.resCount);

      els.resultsList = make('div', 'rp-list');
      els.resultsList.setAttribute('role', 'tree');
      els.resultsList.addEventListener('scroll', closeRowMenu);
      installResultsListEvents();
      layersWrap.appendChild(els.resultsList);

      c.appendChild(layersWrap);

      // ---------------------------------------------------------------- Visualization section
      var visWrap = make('div', 'ws-section');
      visWrap.appendChild(sectionLabel('Visualization'));

      // Four switches, two by two: the lines, the comments, the surface under the marks, the marks.
      var visToggles = make('div', 'rp-toggles rp-grid2');
      els.visButtons = {};
      [
        ['Drawings', 'drawings', 'The lines drawn'],
        ['Comments', 'comments', 'The comments, as labels on the map'],
        ['Heatmap', 'heatmap', 'A density surface or hexagons of the marks and comments'],
        ['Marks', 'marks', 'Each mark as a dot in its type\'s colour']
      ].forEach(function (item) {
        var key = item[1];
        var b = mkBtn(item[0], function () {
          var v = curVis();
          v[key] = !v[key];
          applyVis();
        }, BTN);
        b.classList.add('rp-toggle');
        b.title = item[2];
        b.setAttribute('aria-pressed', 'false');
        els.visButtons[key] = b;
        visToggles.appendChild(b);
      });
      visWrap.appendChild(visToggles);

      var tl = slider('Timeline frame', 0, 0, 1, 0, function () { return ''; }, function (v) {
        getResults().setTimelineFrame(v);
      });
      els.timelineWrap = tl.wrap;
      els.timelineInput = tl.input;
      els.timelineVal = tl.val;
      els.timelineWrap.hidden = true;
      visWrap.appendChild(els.timelineWrap);

      // Under Heatmap, while it is on: a density surface or hexagons, and their settings.
      els.heatOptions = make('div', 'rp-suboptions');
      els.heatStyleSwitch = makeSwitch(['Density', 'Hexagon'], 'A smooth density surface, or hexagons coloured by their marks',
        function (on) {
          curVis().heatStyle = on ? 'hexagon' : 'density';
          applyVis();
        });
      els.heatOptions.appendChild(els.heatStyleSwitch.wrap);

      els.radiusSlider = slider('Density radius', 4, 80, 1, DEFAULT_VIS.radius, String, function (v) {
        var vis = curVis();
        vis.radius = v;
        getResults().setDisplay(vis);
        scheduleSave();
      });
      els.heatOptions.appendChild(els.radiusSlider.wrap);

      els.intensitySlider = slider('Density intensity', 0.1, 4, 0.1, DEFAULT_VIS.intensity, function (v) { return Number(v).toFixed(1); }, function (v) {
        var vis = curVis();
        vis.intensity = v;
        getResults().setDisplay(vis);
        scheduleSave();
      });
      els.heatOptions.appendChild(els.intensitySlider.wrap);

      els.hexSlider = slider('Hexagon size', 30, 600, 10, DEFAULT_VIS.hexMetres, function (v) { return v + ' m'; }, function (v) {
        var vis = curVis();
        vis.hexMetres = v;
        getResults().setDisplay(vis);
        scheduleSave();
      });
      els.heatOptions.appendChild(els.hexSlider.wrap);

      els.mixSwitch = makeSwitch(['Mix colours'],
        'Colour each hexagon by its marks\' colours averaged, weighted by how many of each (red and blue make purple), ' +
        'instead of the colour most of them are', function (on) {
          curVis().hexMix = on;
          applyVis();
        });
      els.heatOptions.appendChild(els.mixSwitch.wrap);
      visWrap.appendChild(els.heatOptions);

      // Each mark type among the results shown: on or off, and its colour (marks and hexagons follow
      // it). Rows are picked like the results above -- click, Shift for a range, Ctrl to add one, or
      // drag over several -- and ticking or recolouring a picked row does it to every picked row.
      els.marksWrap = make('div', 'rp-marks');
      var marksHead = make('div', 'rp-head');
      var marksLabel = sectionLabel('Mark types');
      marksLabel.style.flex = '1';
      marksLabel.style.margin = '0';
      marksHead.appendChild(marksLabel);
      [['All', true], ['None', false]].forEach(function (pair) {
        marksHead.appendChild(mkBtn(pair[0], function () {
          setMarkTypesShown(getResults().stickerTypes().map(function (e) { return e.type; }), pair[1]);
        }, Object.assign({}, BTN, { padding: '2px 8px', fontSize: '11px' })));
      });
      els.marksWrap.appendChild(marksHead);
      els.marksCount = make('div', 'rp-count');
      els.marksWrap.appendChild(els.marksCount);
      els.markList = make('div', 'rp-list rp-mark-list');
      els.markList.setAttribute('role', 'listbox');
      els.markList.setAttribute('aria-multiselectable', 'true');
      els.markList.setAttribute('aria-label', 'Mark types');
      els.markList.addEventListener('scroll', closeRowMenu);
      installMarkListEvents();
      els.marksWrap.appendChild(els.markList);
      visWrap.appendChild(els.marksWrap);
      c.appendChild(visWrap);

      // ---------------------------------------------------------------- Mouse tools section
      // The tag tools for the mouse (mouseTools.js): draw, erase, sticker, comment, walking reach, path.
      if (window.CompactMouseTools) {
        var mouseWrap = make('div', 'ws-section');
        mouseWrap.appendChild(sectionLabel('Mouse tools'));
        mouseWrap.appendChild(window.CompactMouseTools.createToolbar());
        c.appendChild(mouseWrap);
      }

      // ---------------------------------------------------------------- Map view sheets section
      var sheetsWrap = css(document.createElement('div'), {
        display: 'flex', flexDirection: 'column', gap: '6px',
        paddingTop: '10px', borderTop: '1px solid var(--ui-line)'
      });
      sheetsWrap.appendChild(sectionLabel('Map view sheets'));
      els.mapSheetList = css(document.createElement('div'), { display: 'flex', flexDirection: 'column', gap: '5px' });
      sheetsWrap.appendChild(els.mapSheetList);
      els.mapSheetHint = css(document.createElement('div'), { fontSize: '11px', color: 'var(--ui-muted)', lineHeight: '1.4' });
      els.mapSheetHint.textContent = 'Pan/zoom the map, then press a sheet to show this view on it, shrunk to fit. The project keeps each sheet’s view.';
      sheetsWrap.appendChild(els.mapSheetHint);
      c.appendChild(sheetsWrap);
      window.setInterval(updateMapSheetDots, 700);
    }

    // ---------------------------------------------------------------- step data layers (built-in & custom)
    function hasStepLayer(step, key) {
      return !!(step && Array.isArray(step.dataLayers) && step.dataLayers.indexOf(key) !== -1);
    }

    function setStepLayer(step, key, on) {
      if (!step) return;
      if (!Array.isArray(step.dataLayers)) step.dataLayers = [];
      var idx = step.dataLayers.indexOf(key);
      if (on && idx === -1) step.dataLayers.push(key);
      else if (!on && idx !== -1) step.dataLayers.splice(idx, 1);
    }

    function layerCheckRow(key, label, onDelete) {
      var step = curStep();
      var row = css(document.createElement('label'), {
        display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
        font: '600 13px system-ui, sans-serif'
      });
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.style.accentColor = 'var(--ui-green)';
      cb.checked = hasStepLayer(step, key);
      cb.addEventListener('change', function () {
        var s = curStep();
        if (!s) return;
        setStepLayer(s, key, cb.checked);
        ensureOpenStepShown();
        syncMapLayers();
        scheduleSave();
      });
      var txt = css(document.createElement('span'), {
        flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      });
      txt.textContent = label;
      row.appendChild(cb);
      row.appendChild(txt);
      var delStyle = Object.assign({}, BTN, { padding: '1px 3px', fontSize: '15px', lineHeight: '1', color: 'var(--ui-danger)', border: '0', background: 'transparent' });
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
          marginLeft: '24px', color: 'var(--ui-muted)',
          font: '11px system-ui, sans-serif'
        });
        loading.textContent = 'Loading sublayers…';
        host.appendChild(loading);
        geo.loadLayer(id, function () {
          if (host.isConnected) renderDataLayerChecks();
        });
        return;
      }
      // A single sublayer only repeats the layer's own checkbox.
      if (sublayers.length < 2) return;

      var step = curStep();
      var parentEnabled = hasStepLayer(step, key);
      if (sublayersOpenById[key] == null) sublayersOpenById[key] = parentEnabled;

      var details = document.createElement('details');
      details.open = !!sublayersOpenById[key];
      css(details, { marginLeft: '22px', minWidth: '0' });
      details.addEventListener('toggle', function () { sublayersOpenById[key] = details.open; });

      var summary = css(document.createElement('summary'), {
        cursor: 'pointer', color: 'var(--ui-muted)',
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
          font: '500 11px system-ui, sans-serif', color: 'var(--ui-ink)'
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
          boxShadow: '0 0 0 1px rgba(22,48,43,0.25)'
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

    // One opacity for every uploaded layer coloured by a value (such as the objective-data squares),
    // saved with the step; shown once such a layer is in the list.
    function renderLayerOpacity() {
      var geo = window.CompactCustomGeoLayers;
      var any = state.dataLayers.some(function (l) {
        var key = String(l.id || '');
        return key.indexOf(CUSTOM_PREFIX) === 0 && geo.isValueLayer(key.slice(CUSTOM_PREFIX.length)) === true;
      });
      if (!any) return;
      var row = css(document.createElement('label'), {
        display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) 36px', alignItems: 'center', gap: '8px',
        padding: '0 0 3px', font: '600 12px system-ui, sans-serif', color: 'var(--ui-muted)'
      });
      row.title = 'Opacity of the layers coloured by a value';
      row.appendChild(document.createTextNode('Opacity'));
      var range = document.createElement('input');
      range.type = 'range';
      range.min = '0.1';
      range.max = '1';
      range.step = '0.05';
      var current = stepLayerOpacity();
      range.value = String(current != null ? current : geo.defaultValueOpacity);
      css(range, { width: '100%', minWidth: '0', margin: '0', accentColor: 'var(--ui-green)' });
      var percent = css(document.createElement('span'), { textAlign: 'right' });
      function showPercent() {
        percent.textContent = Math.round(Number(range.value) * 100) + '%';
      }
      // While dragging, only the map is restyled; the step is saved on release.
      range.addEventListener('input', function () {
        showPercent();
        geo.setValueOpacity(Number(range.value));
      });
      range.addEventListener('change', function () {
        var s = curStep();
        if (!s) return;
        s.layerOpacity = Number(range.value);
        syncMapLayers();
        scheduleSave();
      });
      showPercent();
      row.appendChild(range);
      row.appendChild(percent);
      els.layersCol.appendChild(row);
    }

    function renderDataLayerChecks() {
      els.layersCol.innerHTML = '';
      renderLayerOpacity();
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
      renderResultsTree();
    }

    // ---------------------------------------------------------------- Results tree in Data layers
    function resultLayerKey(entryKey) {
      return RESULT_PREFIX + entryKey;
    }

    function isResultChecked(entryKey) {
      return hasStepLayer(curStep(), resultLayerKey(entryKey));
    }

    function ensureOpenStepShown() {
      var s = curStep();
      if (!s) return;
      var num = stepNumber(s, state.stepIndex);
      if (!state.shownSteps.has(num)) {
        state.shownSteps.add(num);
        renderStepList();
      }
    }

    function setResultsChecked(entryKeys, on) {
      var s = curStep();
      if (!s || !entryKeys.length) return;
      var hadAny = (s.dataLayers || []).some(function (id) { return String(id).indexOf(RESULT_PREFIX) === 0; });
      entryKeys.forEach(function (entryKey) {
        setStepLayer(s, resultLayerKey(entryKey), on);
      });
      ensureOpenStepShown();
      refreshResultMarks();
      syncMapLayers();
      if (on && !hadAny && !s.mapView) {
        getResults().fitTo(entryKeys);
      }
      scheduleSave();
    }

    function setProjectResultsVisible(on) {
      var w = curWorkshop();
      var allKeys = getResults().order();
      var ownKeys = w ? allKeys.filter(function (k) {
        var e = getResults().entry(k);
        return e && e.project === w.id;
      }) : [];
      var target = ownKeys.length ? ownKeys : allKeys;
      setResultsChecked(target, on);
    }

    // Groups results by project: current project first, then other projects (dimmed), then unassigned ("Other").
    function buildResultGroups() {
      var rl = getResults();
      var order = rl.order();
      var byProject = {};
      order.forEach(function (key) {
        var e = rl.entry(key);
        if (!e) return;
        var pid = e.project || '';
        (byProject[pid] = byProject[pid] || []).push(key);
      });

      var cur = curWorkshop();
      var curId = cur ? String(cur.id || '') : '';
      var groups = [];
      var seen = {};

      // 1. Current project's results first
      if (curId && byProject[curId] && byProject[curId].length) {
        groups.push({
          id: curId,
          name: cur.name || 'This project',
          keys: byProject[curId],
          isCurrent: true
        });
        seen[curId] = true;
      }

      // 2. Other known workshops in state.workshops order
      state.workshops.forEach(function (w) {
        var id = String(w.id || '');
        if (!id || seen[id] || !byProject[id] || !byProject[id].length) return;
        groups.push({
          id: id,
          name: w.name || id,
          keys: byProject[id],
          isCurrent: false
        });
        seen[id] = true;
      });

      // 3. Any unknown projects returned by /api/results/all
      rl.projects().forEach(function (p) {
        var id = String(p.id || '');
        if (!id || seen[id] || !byProject[id] || !byProject[id].length) return;
        groups.push({
          id: id,
          name: p.name || 'Other project',
          keys: byProject[id],
          isCurrent: false
        });
        seen[id] = true;
      });

      // 4. Unassigned results (project === '')
      if (byProject[''] && byProject[''].length) {
        groups.push({
          id: '_other',
          name: 'Unassigned results',
          keys: byProject[''],
          isCurrent: false
        });
      }

      return groups;
    }

    function renderResultsTree() {
      if (!els.resultsList) return;
      els.resultsList.innerHTML = '';
      var groups = buildResultGroups();
      var rl = getResults();

      if (!groups.length) {
        var empty = make('div', 'rp-empty', 'No saved results yet.');
        els.resultsList.appendChild(empty);
        refreshResultMarks();
        return;
      }

      groups.forEach(function (g) {
        var group = make('div', 'rp-project ' + (g.isCurrent ? 'current-project' : 'other-project'));
        group.dataset.project = g.id;
        var defaultCollapsed = !g.isCurrent;
        var collapsed = g.id in state.collapsed ? !!state.collapsed[g.id] : defaultCollapsed;

        var head = make('div', 'rp-project-row');
        head.setAttribute('role', 'treeitem');
        head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

        var caret = make('button', 'rp-caret');
        caret.type = 'button';
        caret.setAttribute('aria-label', (collapsed ? 'Open ' : 'Fold ') + g.name);
        caret.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
        caret.addEventListener('click', function () { toggleGroupCollapsed(g.id, defaultCollapsed); });

        var box = make('input', 'rp-project-check');
        box.type = 'checkbox';
        box.title = 'Show or hide all of ' + g.name + ' on this step';
        box.addEventListener('change', function () { setResultsChecked(g.keys, box.checked); });

        var nameWrap = make('span', 'rp-project-name');
        nameWrap.textContent = g.name;
        nameWrap.addEventListener('click', function () { toggleGroupCollapsed(g.id, defaultCollapsed); });

        var badge = make('span', 'rp-project-badge', g.isCurrent ? 'this project' : 'other project');
        var count = make('span', 'rp-project-count');

        head.appendChild(caret);
        head.appendChild(box);
        head.appendChild(nameWrap);
        head.appendChild(badge);
        head.appendChild(count);
        head.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          openProjectMenu(g, e.clientX, e.clientY);
        });
        group.appendChild(head);
        group.classList.toggle('collapsed', collapsed);

        if (!collapsed) {
          var children = make('div', 'rp-children');
          children.setAttribute('role', 'group');
          g.keys.forEach(function (key) {
            var entry = rl.entry(key);
            if (!entry) return;
            var row = make('div', 'rp-item' + (g.isCurrent ? '' : ' other-item'));
            row.dataset.key = key;
            row.setAttribute('role', 'treeitem');
            var cb = make('input');
            cb.type = 'checkbox';
            cb.title = 'Show on this step (ticking a picked row changes all picked rows)';
            var label = make('span', 'rp-name', rl.displayName(entry.filename));
            label.title = entry.filename;
            row.appendChild(cb);
            row.appendChild(label);
            children.appendChild(row);
          });
          group.appendChild(children);
        }

        els.resultsList.appendChild(group);
      });

      refreshResultMarks();
    }

    function toggleGroupCollapsed(groupId, defaultCollapsed) {
      var cur = groupId in state.collapsed ? !!state.collapsed[groupId] : defaultCollapsed;
      state.collapsed[groupId] = !cur;
      saveCollapsed(state.collapsed);
      renderResultsTree();
    }

    function refreshResultMarks() {
      if (!els.resultsList) return;
      var groups = buildResultGroups();
      var groupMap = {};
      groups.forEach(function (g) { groupMap[g.id] = g; });

      els.resultsList.querySelectorAll('.rp-item').forEach(function (row) {
        var key = row.dataset.key;
        row.querySelector('input').checked = isResultChecked(key);
        row.classList.toggle('picked', state.picked.has(key));
        row.setAttribute('aria-selected', state.picked.has(key) ? 'true' : 'false');
      });

      els.resultsList.querySelectorAll('.rp-project').forEach(function (groupEl) {
        var g = groupMap[groupEl.dataset.project];
        var keys = g ? g.keys : [];
        var shown = keys.filter(isResultChecked).length;
        var box = groupEl.querySelector('.rp-project-check');
        box.checked = shown === keys.length && shown > 0;
        box.indeterminate = shown > 0 && shown < keys.length;
        groupEl.querySelector('.rp-project-count').textContent = shown + '/' + keys.length;
      });

      var allKeys = getResults().order();
      var shownAll = allKeys.filter(isResultChecked).length;
      if (els.resCount) {
        els.resCount.innerHTML = '<b>' + shownAll + '</b>/' + allKeys.length + ' results shown on this step'
          + (state.picked.size ? ' · <b>' + state.picked.size + '</b> picked' : '');
      }
    }

    // ---------------------------------------------------------------- picking & context menu on results
    function rowKeys() {
      return Array.prototype.map.call(els.resultsList.querySelectorAll('.rp-item'), function (r) { return r.dataset.key; });
    }

    function rangeKeys(fromKey, toKey) {
      var keys = rowKeys();
      var a = keys.indexOf(fromKey);
      var b = keys.indexOf(toKey);
      if (a < 0 || b < 0) return [toKey];
      return keys.slice(Math.min(a, b), Math.max(a, b) + 1);
    }

    function installResultsListEvents() {
      els.resultsList.addEventListener('mousedown', function (e) {
        var row = e.target.closest('.rp-item');
        if (!row || e.button !== 0 || e.target.tagName === 'INPUT') return;
        e.preventDefault();
        var key = row.dataset.key;
        if (e.shiftKey && state.anchor) {
          var base = (e.ctrlKey || e.metaKey) ? new Set(state.picked) : new Set();
          rangeKeys(state.anchor, key).forEach(function (k) { base.add(k); });
          state.picked = base;
        } else if (e.ctrlKey || e.metaKey) {
          if (state.picked.has(key)) state.picked.delete(key);
          else state.picked.add(key);
          state.anchor = key;
          drag = { anchor: key, base: new Set(state.picked) };
        } else {
          state.picked = new Set([key]);
          state.anchor = key;
          drag = { anchor: key, base: new Set() };
        }
        refreshResultMarks();
      });

      els.resultsList.addEventListener('mouseover', function (e) {
        if (!drag) return;
        var row = e.target.closest('.rp-item');
        if (!row) return;
        var picked = new Set(drag.base);
        rangeKeys(drag.anchor, row.dataset.key).forEach(function (k) { picked.add(k); });
        state.picked = picked;
        refreshResultMarks();
      });

      document.addEventListener('mouseup', function () { drag = null; });

      els.resultsList.addEventListener('change', function (e) {
        var row = e.target.closest('.rp-item');
        if (!row) return;
        var key = row.dataset.key;
        var keys = state.picked.has(key) && state.picked.size > 1 ? Array.from(state.picked) : [key];
        setResultsChecked(keys, e.target.checked);
      });

      els.resultsList.addEventListener('contextmenu', function (e) {
        var row = e.target.closest('.rp-item');
        if (!row) return;
        e.preventDefault();
        var key = row.dataset.key;
        if (!state.picked.has(key)) {
          state.picked = new Set([key]);
          state.anchor = key;
          refreshResultMarks();
        }
        openPickedMenu(e.clientX, e.clientY);
      });
    }

    function filePath(entry) {
      var folder = folders && folders[entry.kind];
      return folder ? folder + pathSeparator + entry.filename : entry.filename;
    }

    function closeRowMenu() {
      if (rowMenu) rowMenu.hidden = true;
    }

    function menuItem(text, onClick, className) {
      var b = make('button', className || '', text);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', function () {
        closeRowMenu();
        onClick();
      });
      rowMenu.appendChild(b);
      return b;
    }

    function showMenuAt(x, y) {
      rowMenu.hidden = false;
      rowMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - rowMenu.offsetWidth - 8)) + 'px';
      rowMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - rowMenu.offsetHeight - 8)) + 'px';
      var first = rowMenu.querySelector('button');
      if (first) first.focus();
    }

    function openPickedMenu(x, y) {
      var rl = getResults();
      var keys = Array.from(state.picked).filter(function (k) { return rl.entry(k); });
      if (!keys.length) return;
      rowMenu.innerHTML = '';
      if (keys.length === 1) {
        rowMenu.appendChild(make('div', 'rp-path', filePath(rl.entry(keys[0]))));
      } else {
        rowMenu.appendChild(make('div', 'rp-menu-title', plural(keys.length, 'result picked', 'results picked')));
      }
      var n = keys.length > 1 ? ' ' + keys.length : '';
      menuItem('Show' + n, function () { setResultsChecked(keys, true); });
      menuItem('Hide' + n, function () { setResultsChecked(keys, false); });
      menuItem('Zoom to' + n, function () { rl.fitTo(keys); });
      if (keys.length === 1) menuItem(REVEAL_LABEL, function () { revealFile(rl.entry(keys[0])); });
      rowMenu.appendChild(make('div', 'rp-sep'));
      menuItem(keys.length === 1 ? 'Delete…' : 'Delete ' + keys.length + ' results…',
        function () { confirmDeleteResults(keys); }, 'danger');
      showMenuAt(x, y);
    }

    function openProjectMenu(group, x, y) {
      var keys = group.keys;
      rowMenu.innerHTML = '';
      rowMenu.appendChild(make('div', 'rp-menu-title', group.name));
      menuItem('Show all ' + keys.length, function () { setResultsChecked(keys, true); });
      menuItem('Hide all ' + keys.length, function () { setResultsChecked(keys, false); });
      menuItem('Zoom to all ' + keys.length, function () { getResults().fitTo(keys); });
      menuItem('Pick all ' + keys.length, function () {
        state.picked = new Set(keys);
        state.collapsed[group.id] = false;
        saveCollapsed(state.collapsed);
        renderResultsTree();
      });
      rowMenu.appendChild(make('div', 'rp-sep'));
      menuItem('Delete all ' + keys.length + ' results…', function () { confirmDeleteResults(keys); }, 'danger');
      showMenuAt(x, y);
    }

    function revealFile(entry) {
      fetch('/api/results/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: entry.kind, filename: entry.filename })
      })
        .then(function (r) { return r.json(); })
        .then(function (body) {
          if (body.ok) return;
          setStatus(body.error === 'this_computer_only'
            ? 'Files can only be shown on the computer the app runs on.'
            : 'Could not show the file (' + body.error + ').', 'err');
        })
        .catch(function () { setStatus('Could not reach the app.', 'err'); });
    }

    function confirmDeleteResults(keys) {
      var rl = getResults();
      keys = keys.filter(function (k) { return rl.entry(k); });
      if (!keys.length) return;
      var bin = folders && folders.session ? folders.session + pathSeparator + 'deleted' : 'the "deleted" folder';
      window.CompactPageFlow.confirmDialog({
        title: keys.length === 1 ? 'Delete ' + rl.displayName(rl.entry(keys[0]).filename) + '?'
          : 'Delete ' + keys.length + ' results?',
        message: 'The files move to ' + bin + ', where they can be put back.',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        danger: true,
        onConfirm: function () { deleteResults(keys); }
      });
    }

    function deleteResults(keys) {
      var rl = getResults();
      var items = keys.map(function (k) {
        var e = rl.entry(k);
        return { kind: e.kind, filename: e.filename };
      });
      var layerKeys = new Set(keys.map(resultLayerKey));
      fetch('/api/results/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items })
      })
        .then(function (r) { return r.json(); })
        .then(function (body) {
          if (body.error === 'this_computer_only') {
            setStatus('Results can only be deleted on the computer the app runs on.', 'err');
            return;
          }
          state.workshops.forEach(function (w) {
            (w.steps || []).forEach(function (s) {
              if (Array.isArray(s.dataLayers)) {
                s.dataLayers = s.dataLayers.filter(function (id) { return !layerKeys.has(id); });
              }
            });
          });
          state.picked = new Set();
          return loadResults().then(function () {
            renderResultsTree();
            syncMapLayers();
            var moved = (body.moved || []).length;
            setStatus(moved ? 'Deleted ' + plural(moved, 'result', 'results') : 'Could not delete', moved ? '' : 'err');
          });
        })
        .catch(function () { setStatus('Could not reach the app.', 'err'); });
    }

    function draggingFiles(e) {
      return !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0);
    }

    function uploadResultFiles(fileList) {
      var files = Array.prototype.slice.call(fileList || []);
      if (!files.length) return;
      var w = curWorkshop();
      var form = new FormData();
      if (w && w.id) form.append('project', w.id);
      files.forEach(function (f) { form.append('files', f, f.name); });
      setStatus('Uploading ' + plural(files.length, 'file…', 'files…'));
      fetch('/api/results/upload', { method: 'POST', body: form })
        .then(function (r) { return r.json(); })
        .then(function (body) {
          var stored = body.stored || [];
          var failed = body.failed || [];
          var addedKeys = stored.map(function (s) { return s.kind + ':' + s.filename; });
          var s = curStep();
          if (s && addedKeys.length) {
            addedKeys.forEach(function (k) { setStepLayer(s, resultLayerKey(k), true); });
            ensureOpenStepShown();
            scheduleSave();
          }
          return loadResults().then(function () {
            if (w && w.id) state.collapsed[w.id] = false;
            renderResultsTree();
            syncMapLayers();
            if (addedKeys.length && s && !s.mapView) getResults().fitTo(addedKeys);
            var added = stored.filter(function (x) { return x.new; }).length;
            var msg = [];
            if (added) msg.push('Added ' + plural(added, 'result', 'results'));
            if (stored.length > added) msg.push((stored.length - added) + ' already here');
            failed.forEach(function (f) { msg.push(f.file + ': ' + f.error); });
            setStatus(msg.join(' · ') || 'Uploaded', failed.length ? 'err' : '');
          });
        })
        .catch(function () { setStatus('Upload failed: could not reach the app.', 'err'); });
    }

    // ---------------------------------------------------------------- custom map layers upload/delete
    function refreshAfterLayerChange() {
      renderDataLayerChecks();
      syncMapLayers();
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
            var s = curStep();
            if (s) setStepLayer(s, CUSTOM_PREFIX + res.d.id, true);
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
      window.CompactPageFlow.confirmDialog({
        title: 'Remove layer "' + name + '"?',
        message: 'It will be removed from every project, but its source file on disk will be kept.',
        confirmText: 'Remove',
        cancelText: 'Cancel',
        danger: true,
        onConfirm: function () {
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
              setStatus('Layer removed');
            })
            .catch(function (err) { setStatus('Remove failed: ' + ((err && err.message) || ''), 'err'); });
        }
      });
    }

    // ---------------------------------------------------------------- rendering
    function renderWsSelect() {
      els.wsSelect.innerHTML = '';
      state.workshops.forEach(function (w, i) {
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = w.name || ('Project ' + (i + 1));
        els.wsSelect.appendChild(o);
      });
      els.wsSelect.value = String(state.wsIndex);
    }

    function renderStepList() {
      els.stepList.innerHTML = '';
      var w = curWorkshop();
      if (!w) return;
      w.steps.forEach(function (step, i) {
        var num = stepNumber(step, i);
        var isEditing = i === state.stepIndex;
        var isShown = state.shownSteps.has(num);
        var row = css(document.createElement('div'), {
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '7px 9px', borderRadius: '7px', cursor: 'pointer',
          border: '1px solid ' + (isEditing ? 'var(--ui-green)' : (isShown ? '#a9d8cf' : 'var(--ui-line)')),
          background: isEditing ? 'var(--ui-green-soft)' : (isShown ? 'var(--ui-green-tint)' : 'var(--ui-panel)'),
          boxShadow: isEditing ? '0 0 0 1px var(--ui-green)' : 'none'
        });

        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isShown;
        cb.title = 'Show ' + stepName(i) + ' on the map';
        cb.style.accentColor = 'var(--ui-green)';
        cb.style.width = '15px';
        cb.style.height = '15px';
        cb.style.cursor = 'pointer';
        cb.addEventListener('click', function (e) { e.stopPropagation(); });
        cb.addEventListener('change', function () {
          if (cb.checked) state.shownSteps.add(num);
          else state.shownSteps.delete(num);
          renderStepList();
          renderLabels();
          syncMapLayers();
        });

        var badge = css(document.createElement('span'), { opacity: '0.65', fontSize: '11px', flex: '0 0 auto', fontWeight: '700' });
        badge.textContent = 'S' + (i + 1);

        var nm = css(document.createElement('span'), {
          flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: '600'
        });
        nm.textContent = stepName(i);

        var metaTag = css(document.createElement('span'), {
          fontSize: '10.5px', opacity: isEditing ? '0.95' : '0.65', flex: '0 0 auto',
          color: isEditing ? 'var(--ui-green-dark)' : 'var(--ui-muted)'
        });
        metaTag.textContent = (isEditing ? 'editing · ' : '') + basemapLabel(stepTheme(step));

        row.appendChild(cb);
        row.appendChild(badge);
        row.appendChild(nm);
        row.appendChild(metaTag);
        row.addEventListener('click', function () { selectStep(i); });

        if (w.steps.length > 1) {
          var delStyle = Object.assign({}, BTN, {
            padding: '2px 7px', color: 'var(--ui-danger)', borderColor: 'transparent', background: 'transparent'
          });
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
      els.editingStepHeader.textContent = 'Editing ' + stepName(state.stepIndex);
      renderBasemapTiles(step);
      els.fpWrap.style.display = stepTheme(step) === 'floorplan' ? 'block' : 'none';
      renderFloorplanSelect(step);
      renderDataLayerChecks();
      renderVisControls();
    }

    // Marks the step's basemap and draws each button's preview around the map's current view.
    function renderBasemapTiles(step) {
      if (!els.basemapTiles || !step) return;
      var a = getApp();
      var theme = stepTheme(step);
      var view = a.getMapView();
      BASEMAPS.forEach(function (b) {
        var t = els.basemapTiles[b.value];
        var on = b.value === theme;
        t.tile.classList.toggle('on', on);
        t.tile.setAttribute('aria-pressed', on ? 'true' : 'false');
        window.CompactBasemapPreviews.draw(t.preview, b.value, a.getThemeStyle(b.value), view, {
          planId: step.indoorId || '',
          color: blankColor(step)
        });
      });
      els.basemapTiles.blank.tile.title = theme === 'blank'
        ? 'Empty sheet. Click again to pick its colour.'
        : 'A plain sheet in one colour. Click it again to pick the colour.';
      els.blankColor.value = blankColor(step);
    }

    function schedulePreviewRefresh() {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(function () {
        previewTimer = 0;
        if (open) renderBasemapTiles(curStep());
      }, 350);
    }

    // The map's camera is the open step's view: there is no capture button, the last view counts.
    function rememberStepView() {
      if (!open) return;
      schedulePreviewRefresh();
      if (!tracksView) return;
      var s = curStep();
      if (!s) return;
      var view = getApp().getMapView();
      if (sameView(s.mapView, view)) return;
      s.mapView = view;
      scheduleSave();
    }

    function listenForViewChanges() {
      if (viewListenerOn) return;
      var map = getApp() && getApp().getMap();
      if (!map) return;
      map.on('moveend', rememberStepView);
      viewListenerOn = true;
    }

    function applyVis() {
      renderVisControls();
      getResults().setDisplay(curVis());
      scheduleSave();
    }

    function renderVisControls() {
      var vis = curVis();
      Object.keys(els.visButtons || {}).forEach(function (k) {
        var on = !!vis[k];
        els.visButtons[k].classList.toggle('on', on);
        els.visButtons[k].setAttribute('aria-pressed', on ? 'true' : 'false');
        css(els.visButtons[k], on ? PRIMARY : BTN);
      });
      if (els.heatOptions) {
        var hexagons = vis.heatStyle === 'hexagon';
        els.heatOptions.hidden = !vis.heatmap;
        els.heatStyleSwitch.set(hexagons);
        els.radiusSlider.wrap.hidden = hexagons;
        els.intensitySlider.wrap.hidden = hexagons;
        els.hexSlider.wrap.hidden = !hexagons;
        els.mixSwitch.wrap.hidden = !hexagons;
        els.mixSwitch.set(!!vis.hexMix);
      }
      if (els.radiusSlider) {
        els.radiusSlider.input.value = vis.radius;
        els.radiusSlider.val.textContent = els.radiusSlider.format(vis.radius);
      }
      if (els.intensitySlider) {
        els.intensitySlider.input.value = vis.intensity;
        els.intensitySlider.val.textContent = els.intensitySlider.format(vis.intensity);
      }
      if (els.hexSlider) {
        els.hexSlider.input.value = vis.hexMetres;
        els.hexSlider.val.textContent = els.hexSlider.format(vis.hexMetres);
      }
      syncTimelineControl();
      renderMarkTypes();
    }

    // ---------------------------------------------------------------- Mark types
    // One row per mark type among the results shown: a box to show or hide it, a colour picker, its
    // name and how many. Shown while the marks or the heatmap are on: both leave hidden types out,
    // and the marks and hexagons are drawn in these colours.
    function renderMarkTypes() {
      if (!els.markList) return;
      var vis = curVis();
      var types = getResults().stickerTypes();
      var known = new Set(types.map(function (t) { return t.type; }));
      state.pickedMarks.forEach(function (type) { if (!known.has(type)) state.pickedMarks.delete(type); });
      els.marksWrap.hidden = !types.length || !(vis.marks || vis.heatmap);
      els.markList.innerHTML = '';
      types.forEach(function (entry) {
        var row = make('div', 'rp-item rp-mark' + (entry.shown ? '' : ' off'));
        row.dataset.type = entry.type;
        row.setAttribute('role', 'option');
        var box = make('input');
        box.type = 'checkbox';
        box.checked = entry.shown;
        box.title = (entry.shown ? 'Hide ' : 'Show ') + entry.type;
        var picker = make('input', 'rp-mark-color');
        picker.type = 'color';
        picker.value = /^#[0-9a-f]{6}$/i.test(entry.color) ? entry.color : '#ff5b5b';
        picker.title = 'Colour of ' + entry.type;
        row.appendChild(box);
        row.appendChild(picker);
        row.appendChild(make('span', 'rp-name', entry.type));
        row.appendChild(make('span', 'rp-mark-count', String(entry.count)));
        els.markList.appendChild(row);
      });
      refreshMarkPicks();
    }

    function refreshMarkPicks() {
      if (!els.markList) return;
      els.markList.querySelectorAll('.rp-mark').forEach(function (row) {
        var on = state.pickedMarks.has(row.dataset.type);
        row.classList.toggle('picked', on);
        row.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      var types = getResults().stickerTypes();
      var shown = types.filter(function (t) { return t.shown; }).length;
      els.marksCount.innerHTML = '<b>' + shown + '</b>/' + types.length + ' types shown'
        + (state.pickedMarks.size ? ' · <b>' + state.pickedMarks.size + '</b> picked' : '');
    }

    function setMarkTypesShown(types, shown) {
      var v = curVis();
      types.forEach(function (type) {
        var i = v.hiddenStickerTypes.indexOf(type);
        if (shown && i !== -1) v.hiddenStickerTypes.splice(i, 1);
        if (!shown && i === -1) v.hiddenStickerTypes.push(type);
      });
      getResults().setDisplay(v);
      renderMarkTypes();
      scheduleSave();
    }

    // Recolours without redrawing the list, which would close the colour picker being used.
    function setMarkTypesColor(types, color) {
      var v = curVis();
      types.forEach(function (type) { v.stickerColors[type] = color; });
      getResults().setDisplay(v);
      els.markList.querySelectorAll('.rp-mark').forEach(function (row) {
        if (types.indexOf(row.dataset.type) !== -1) row.querySelector('.rp-mark-color').value = color;
      });
      scheduleSave();
    }

    // A row's own type, or every picked type when it is one of several picked.
    function markTypesFor(type) {
      return state.pickedMarks.has(type) && state.pickedMarks.size > 1 ? Array.from(state.pickedMarks) : [type];
    }

    function markRowTypes() {
      return Array.prototype.map.call(els.markList.querySelectorAll('.rp-mark'), function (r) { return r.dataset.type; });
    }

    function markRange(from, to) {
      var types = markRowTypes();
      var a = types.indexOf(from);
      var b = types.indexOf(to);
      if (a < 0 || b < 0) return [to];
      return types.slice(Math.min(a, b), Math.max(a, b) + 1);
    }

    function installMarkListEvents() {
      var list = els.markList;
      list.addEventListener('mousedown', function (e) {
        var row = e.target.closest('.rp-mark');
        if (!row || e.button !== 0 || e.target.tagName === 'INPUT') return;
        e.preventDefault();
        var type = row.dataset.type;
        if (e.shiftKey && state.markAnchor) {
          var base = (e.ctrlKey || e.metaKey) ? new Set(state.pickedMarks) : new Set();
          markRange(state.markAnchor, type).forEach(function (t) { base.add(t); });
          state.pickedMarks = base;
        } else if (e.ctrlKey || e.metaKey) {
          if (state.pickedMarks.has(type)) state.pickedMarks.delete(type);
          else state.pickedMarks.add(type);
          state.markAnchor = type;
          markDrag = { anchor: type, base: new Set(state.pickedMarks) };
        } else {
          state.pickedMarks = new Set([type]);
          state.markAnchor = type;
          markDrag = { anchor: type, base: new Set() };
        }
        refreshMarkPicks();
      });
      list.addEventListener('mouseover', function (e) {
        if (!markDrag) return;
        var row = e.target.closest('.rp-mark');
        if (!row) return;
        var picked = new Set(markDrag.base);
        markRange(markDrag.anchor, row.dataset.type).forEach(function (t) { picked.add(t); });
        state.pickedMarks = picked;
        refreshMarkPicks();
      });
      document.addEventListener('mouseup', function () { markDrag = null; });
      list.addEventListener('change', function (e) {
        var row = e.target.closest('.rp-mark');
        if (row && e.target.type === 'checkbox') setMarkTypesShown(markTypesFor(row.dataset.type), e.target.checked);
      });
      list.addEventListener('input', function (e) {
        var row = e.target.closest('.rp-mark');
        if (row && e.target.type === 'color') setMarkTypesColor(markTypesFor(row.dataset.type), e.target.value);
      });
      list.addEventListener('contextmenu', function (e) {
        var row = e.target.closest('.rp-mark');
        if (!row) return;
        e.preventDefault();
        var type = row.dataset.type;
        if (!state.pickedMarks.has(type)) {
          state.pickedMarks = new Set([type]);
          state.markAnchor = type;
          refreshMarkPicks();
        }
        openMarkMenu(e.clientX, e.clientY);
      });
    }

    function openMarkMenu(x, y) {
      var types = Array.from(state.pickedMarks);
      if (!types.length) return;
      var all = getResults().stickerTypes().map(function (t) { return t.type; });
      rowMenu.innerHTML = '';
      rowMenu.appendChild(make('div', 'rp-menu-title', types.length === 1 ? types[0] : plural(types.length, 'type picked', 'types picked')));
      var n = types.length > 1 ? ' ' + types.length : '';
      menuItem('Show' + n, function () { setMarkTypesShown(types, true); });
      menuItem('Hide' + n, function () { setMarkTypesShown(types, false); });
      menuItem(types.length > 1 ? 'Show only these' : 'Show only this', function () {
        var v = curVis();
        v.hiddenStickerTypes = all.filter(function (t) { return types.indexOf(t) === -1; });
        getResults().setDisplay(v);
        renderMarkTypes();
        scheduleSave();
      });
      menuItem('Pick all ' + all.length, function () {
        state.pickedMarks = new Set(all);
        refreshMarkPicks();
      });
      showMenuAt(x, y);
    }

    function syncTimelineControl() {
      if (!els.timelineWrap) return;
      var info = getResults().timeline();
      els.timelineWrap.hidden = !info.any;
      if (info.any) {
        els.timelineInput.max = String(info.max);
        els.timelineInput.value = String(info.frame);
        els.timelineVal.textContent = (info.frame + 1) + '/' + (info.max + 1);
      }
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
      renderMapSheets();
      renderRunControls();
    }

    // ---------------------------------------------------------------- actions
    function startCurrent() {
      if (running()) {
        getRuntime().exit();
        return;
      }
      var w = curWorkshop();
      if (w) window.CompactWorkshopRuntime.start(w);
    }

    function selectWorkshop(idx) {
      if (idx < 0 || idx >= state.workshops.length) return;
      state.wsIndex = idx;
      state.stepIndex = 0;
      state.picked = new Set();
      state.pickedMarks = new Set();
      initShownSteps();
      var s = curStep();
      if (s) applyStepToMap(s);
      renderAll();
    }

    function selectStep(idx) {
      var w = curWorkshop();
      if (!w) return;
      state.stepIndex = Math.max(0, Math.min(idx, w.steps.length - 1));
      var s = curStep();
      if (s) {
        state.shownSteps.add(stepNumber(s, state.stepIndex));
        applyStepToMap(s);
      }
      renderStepList();
      renderStepControls();
      renderLabels();
    }

    function newWorkshop() {
      state.workshops.push(makeWorkshop('Project ' + (state.workshops.length + 1)));
      selectWorkshop(state.workshops.length - 1);
      scheduleSave();
    }

    function deleteWorkshop() {
      var target = curWorkshop();
      if (!target) return;
      var targetId = String(target.id || '');
      var targetName = String(target.name || 'this project');

      function removeTarget() {
        var targetIndex = state.workshops.indexOf(target);
        if (targetIndex < 0 && targetId) {
          targetIndex = state.workshops.findIndex(function (w) {
            return String((w && w.id) || '') === targetId;
          });
        }
        if (targetIndex < 0) return;
        state.workshops.splice(targetIndex, 1);
        if (!state.workshops.length) state.workshops.push(makeWorkshop('Project 1'));
        state.wsIndex = Math.max(0, Math.min(targetIndex - 1, state.workshops.length - 1));
        state.stepIndex = 0;
        selectWorkshop(state.wsIndex);
        scheduleSave();
      }

      window.CompactPageFlow.confirmDialog({
        title: 'Delete project?',
        message: '"' + targetName + '" and all of its steps will be permanently deleted.',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        danger: true,
        onConfirm: removeTarget
      });
    }

    function addStep() {
      var w = curWorkshop();
      if (!w) return;
      var step = makeStep(w.steps.length + 1);
      w.steps.push(step);
      state.shownSteps.add(step.id);
      selectStep(w.steps.length - 1);
      scheduleSave();
    }

    function deleteStep(idx) {
      var w = curWorkshop();
      if (!w || w.steps.length <= 1) return;
      w.steps.splice(idx, 1);
      w.steps.forEach(function (s, i) {
        s.id = i + 1;
        s.label = stepName(i);
      });
      initShownSteps();
      if (state.stepIndex >= w.steps.length) state.stepIndex = w.steps.length - 1;
      selectStep(state.stepIndex);
      scheduleSave();
    }

    // Clicking the step's own basemap again does nothing, except on the empty sheet: that picks its colour.
    function setBasemap(theme) {
      var s = curStep();
      if (!s) return;
      var was = stepTheme(s);
      if (was === theme) {
        if (theme === 'blank') openBlankColorPicker();
        return;
      }
      s.theme = theme;
      s.indoor = theme === 'floorplan';
      // An indoor plan is framed when it opens; the framed view then becomes the step's view.
      if (theme === 'floorplan') s.mapView = null;
      if (theme === 'blank') s.blankColor = blankColor(s);
      applyStepToMap(s);
      renderStepControls();
      renderStepList();
      scheduleSave();
    }

    function openBlankColorPicker() {
      var input = els.blankColor;
      if (!input) return;
      try {
        if (typeof input.showPicker === 'function') {
          input.showPicker();
          return;
        }
      } catch (_err) {
        // showPicker refused (no user gesture, or unsupported): fall back to a click.
      }
      input.click();
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
            s.theme = 'floorplan';
            s.indoor = true;
            s.indoorId = res.d.id || '';
            s.mapView = null;
            window.CompactBasemapPreviews.forgetPlan(s.indoorId);
            applyStepToMap(s);
          }
          renderStepControls();
          renderStepList();
          setStatus('Floorplan added ✓');
          scheduleSave();
        })
        .catch(function (err) { setStatus('Upload failed: ' + ((err && err.message) || ''), 'err'); });
    }

    function mountEditor(opts) {
      if (opts && typeof opts.onBack === 'function') onBackCallback = opts.onBack;
      ensurePanel();
      syncOpenClasses();
      return panel;
    }

    function openEditor() {
      if (open) return;
      ensurePanel();
      ensureLabelOverlay();
      listenForViewChanges();
      open = true;
      tracksView = false;
      syncOpenClasses();
      // During a run the panel shows the step's texts and images, editable, in place of the run's.
      if (running()) getRuntime().setLabelsHidden(true);
      var start = loaded
        ? Promise.all([loadWorkshops(), loadResults()])
        : Promise.all([loadWorkshops(), loadFloorplans(), loadCustomLayers(), loadDataLayers(), loadResults()])
          .then(function () { loaded = true; });
      start.then(function () {
        if (!open) return;
        if (running()) {
          syncFromRun();
          return;
        }
        var s = curStep();
        if (s) applyStepToMap(s);
        renderAll();
        tracksView = true;
      });
    }

    function closeEditor() {
      if (!open) return;
      open = false;
      tracksView = false;
      window.CompactBasemapPreviews.release();
      closeRowMenu();
      syncOpenClasses();
      renderLabels();
      if (running()) {
        // The run's own texts and images come back, with the panel's changes.
        getRuntime().setLabelsHidden(false);
        getRuntime().refresh();
      }
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveNow();
      }
    }

    return {
      mount: mountEditor,
      open: openEditor,
      close: closeEditor,
      toggle: function () { if (open) closeEditor(); else openEditor(); },
      isOpen: function () { return open; }
    };
  }

  window.CompactWorkshopEditor = createEditor();
})();
