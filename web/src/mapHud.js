// Map page: the HUD line and its note, the Light settings panel (CSS filters on
// #map) and timeline recording with its on-screen toast.
const hud = document.getElementById('hud');
const viewFilterPanel = document.getElementById('viewFilterPanel');
const viewBrightness = document.getElementById('viewBrightness');
const viewSaturation = document.getElementById('viewSaturation');
const viewContrast = document.getElementById('viewContrast');
const viewInvert = document.getElementById('viewInvert');
const viewSepia = document.getElementById('viewSepia');
const viewBrightnessValue = document.getElementById('viewBrightnessValue');
const viewSaturationValue = document.getElementById('viewSaturationValue');
const viewContrastValue = document.getElementById('viewContrastValue');
const viewInvertValue = document.getElementById('viewInvertValue');
const viewSepiaValue = document.getElementById('viewSepiaValue');
const viewFilterClose = document.getElementById('viewFilterClose');
const viewFilterReset = document.getElementById('viewFilterReset');
const TIMELINE_SAMPLE_MS = 1000;
const TIMELINE_MAX_FRAMES = 3600;
// Autosaving keeps a recording nobody stopped (or a crash) from being lost.
const TIMELINE_AUTOSAVE_MS = 5000;
let uiNote = '';
let hudVisible = true;
let viewFilterPanelVisible = false;
let timelineRecording = null;

function setUiNote(text) {
  uiNote = String(text || '');
}

function setHudVisible(visible) {
  hudVisible = !!visible;
  hud.classList.toggle('hidden', !hudVisible);
  return hudVisible;
}

function toggleHudVisible() {
  return setHudVisible(!hudVisible);
}

function cornersSetCount(corners) {
  if (!Array.isArray(corners)) return 0;
  let n = 0;
  for (let i = 0; i < corners.length; i++) {
    if (overlays.isFinitePoint(corners[i])) n++;
  }
  return n;
}

function refreshHud() {
  const mode = calibration.isActive() ? 'ON' : 'OFF';
  const mask = overlays.isMaskEnabled() ? 'ON' : 'OFF';
  const roads = roadSnapping.isRoadsVisible() ? 'ON' : 'OFF';
  const debug = debugMarkersVisible ? 'ON' : 'OFF';
  const timeline = timelineRecording ? 'ON' : 'OFF';
  const transport = customMapObjects.isModeVisible('transportation') ? 'ON' : 'OFF';
  const landmark = customMapObjects.isModeVisible('landmark') ? 'ON' : 'OFF';
  const amenities = customMapObjects.isModeVisible('amenities') ? 'ON' : 'OFF';
  const parts = [
    `Source: ${lastSource}`,
    `frame: ${lastFrame.width}x${lastFrame.height}`,
    `corners: ${cornersSetCount(lastCorners)}/4`,
    `tags: ${lastTags.length}`,
    `theme: ${activeMapTheme.toUpperCase()}`,
    `C: ${mode}`,
    `mask(T): ${mask}`,
    `roads(O): ${roads}`,
    `tags(D): ${debug}`,
    `timeline(Y): ${timeline}`,
    'N: object',
    `1 transport: ${transport}`,
    `2 landmark: ${landmark}`,
    `3 amenities: ${amenities}`,
    'L: theme', 'V: view filters', 'H: HUD', 'X: clear', 'S: save'
  ];
  if (isFloorplanMode) parts.push('I: isovist');
  parts.push(calibration.getHint(), 'B: main menu');
  const note = uiNote || calibration.getNote();
  if (note) parts.push(note);
  hud.textContent = parts.join(' | ');
}

function formatFilterValue(value) {
  return Number(value).toFixed(2) + 'x';
}

function formatPercentValue(value) {
  return Math.round(Number(value) * 100) + '%';
}

function applyViewFilters() {
  const brightness = Number(viewBrightness.value || 1);
  const saturation = Number(viewSaturation.value || 1);
  const contrast = Number(viewContrast.value || 1);
  const invert = Number(viewInvert.value || 0);
  const sepia = Number(viewSepia.value || 0);
  const isDefault = brightness === 1 && saturation === 1 && contrast === 1 && invert === 0 && sepia === 0;
  const filter = `brightness(${brightness}) saturate(${saturation}) contrast(${contrast}) invert(${invert}) sepia(${sepia})`;
  // #map only: a filter on #main_container (the Maptastic target) breaks its position:fixed and loops map resizes.
  document.getElementById('map').style.filter = isDefault ? '' : filter;
  viewBrightnessValue.textContent = formatFilterValue(brightness);
  viewSaturationValue.textContent = formatFilterValue(saturation);
  viewContrastValue.textContent = formatFilterValue(contrast);
  viewInvertValue.textContent = formatPercentValue(invert);
  viewSepiaValue.textContent = formatPercentValue(sepia);
}

function setViewFilterPanelVisible(visible) {
  viewFilterPanelVisible = !!visible;
  viewFilterPanel.classList.toggle('hidden', !viewFilterPanelVisible);
  return viewFilterPanelVisible;
}

function toggleViewFilterPanelVisible() {
  return setViewFilterPanelVisible(!viewFilterPanelVisible);
}

function resetViewFilters() {
  viewBrightness.value = '1';
  viewSaturation.value = '1';
  viewContrast.value = '1';
  viewInvert.value = '0';
  viewSepia.value = '0';
  applyViewFilters();
}

function watchViewFilterSlider(slider, label, format) {
  slider.addEventListener('input', function () {
    applyViewFilters();
    setUiNote(label + ' ' + format(slider.value));
    refreshHud();
  });
}

function collectTimelineState(commitActive) {
  var state = dataExport.collectAll({ commitActive: !!commitActive });
  var center = map.getCenter();
  state.mode = 'timeline_frame';
  state.mapView = {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch()
  };
  return state;
}

function addTimelineFrame(reason) {
  if (!timelineRecording) return false;
  var nowMs = Date.now();
  var state = collectTimelineState(reason === 'stop');
  // A sample that changes nothing is skipped.
  var hash = JSON.stringify([state.drawings, state.stickers, state.annotations]);
  if (hash === timelineRecording.lastHash && reason !== 'stop') return false;
  timelineRecording.lastHash = hash;
  timelineRecording.frames.push({
    at: new Date(nowMs).toISOString(),
    elapsedMs: nowMs - timelineRecording.startedAtMs,
    reason: String(reason || 'sample'),
    state: state
  });
  if (timelineRecording.frames.length > TIMELINE_MAX_FRAMES) {
    timelineRecording.frames.shift();
  }
  return true;
}

function buildTimelinePayload(recorder, finalised) {
  return {
    mode: 'timeline',
    timelineVersion: 1,
    sessionId: recorder.sessionId,
    startedAt: recorder.startedAt,
    stoppedAt: finalised ? new Date().toISOString() : '',
    inProgress: !finalised,
    sampleMs: TIMELINE_SAMPLE_MS,
    basemap: isFloorplanMode ? 'floorplan' : 'mapbox',
    frameCount: recorder.frames.length,
    frames: recorder.frames
  };
}

function autosaveTimelineRecording() {
  if (!timelineRecording) return;
  var payload = buildTimelinePayload(timelineRecording, false);
  dataExport.saveTimelineToBackend(payload, function () {});
}

// A banner that stays visible with the HUD hidden. kind 'rec' stays up; 'done' and 'err' fade.
function showRecordToast(html, kind) {
  var el = document.getElementById('recordToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'recordToast';
    el.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;'
      + 'background:rgba(17,22,29,.96);color:#fff;border:2px solid #2a323d;border-radius:11px;'
      + 'padding:10px 18px;font:600 14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;'
      + 'box-shadow:0 8px 30px rgba(0,0,0,.5);max-width:80vw;text-align:center;'
      + 'transition:opacity .25s;pointer-events:none;';
    document.body.appendChild(el);
  }
  var border = '#28d17c';
  if (kind === 'rec') border = '#e11d2f';
  else if (kind === 'err') border = '#e0a13a';
  el.innerHTML = html;
  el.style.borderColor = border;
  el.style.opacity = '1';
  if (el._t) {
    clearTimeout(el._t);
    el._t = 0;
  }
  if (kind !== 'rec') {
    el._t = setTimeout(function () { el.style.opacity = '0'; }, 4500);
  }
}

function toastDetail(text) {
  return '<br><span style="font-weight:400;font-size:12px;opacity:.85">' + text + '</span>';
}

// The backend camera + mic recorder, the same one Ctrl+Shift+R drives.
function recordCamera(action, callback) {
  fetch('/api/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: action })
  })
    .then(function (r) { return r.json(); })
    .then(function (j) { callback(null, j); })
    .catch(function (e) { callback(e, null); });
}

function startTimelineRecording() {
  if (timelineRecording) return;
  // One id per recording, so every autosave overwrites the same file.
  var sessionId = (new Date()).toISOString().replace(/[^0-9]/g, '').slice(0, 14)
    + '_' + Math.random().toString(36).slice(2, 8);
  timelineRecording = {
    sessionId: sessionId,
    startedAtMs: Date.now(),
    startedAt: new Date().toISOString(),
    timer: 0,
    autosaveTimer: 0,
    lastHash: '',
    frames: []
  };
  addTimelineFrame('start');
  timelineRecording.timer = window.setInterval(function () {
    addTimelineFrame('sample');
  }, TIMELINE_SAMPLE_MS);
  autosaveTimelineRecording();
  timelineRecording.autosaveTimer = window.setInterval(autosaveTimelineRecording, TIMELINE_AUTOSAVE_MS);
  setUiNote('Timeline recording ON');
  refreshHud();
  showRecordToast('&#9679; Starting&hellip;', 'rec');
  recordCamera('start', function (err, j) {
    if (!err && j && (j.ok || j.error === 'already_recording')) {
      showRecordToast('&#9679; REC &mdash; camera + screen + map', 'rec');
      return;
    }
    var why = (j && j.error) || 'camera unavailable';
    if (why === 'no_camera_frame') why = 'camera not connected';
    showRecordToast('&#9679; REC &mdash; map only' + toastDetail('camera: ' + why), 'err');
  });
}

function stopTimelineRecording() {
  if (!timelineRecording) return;
  var recorder = timelineRecording;
  window.clearInterval(recorder.timer);
  window.clearInterval(recorder.autosaveTimer);
  addTimelineFrame('stop');
  timelineRecording = null;

  var payload = buildTimelinePayload(recorder, true);
  setUiNote('Saving timeline...');
  showRecordToast('Saving&hellip;', 'done');
  refreshHud();

  // Report once both the map timeline and the camera recorder have answered.
  var res = { tl: null, cam: null };
  function maybeReport() {
    if (res.tl === null || res.cam === null) return;
    var bad = /FAILED/.test(res.tl + res.cam);
    var title = bad ? 'Stopped' : 'Saved &#10003;';
    showRecordToast(title + toastDetail(res.cam + ' &middot; ' + res.tl), bad ? 'err' : 'done');
  }
  dataExport.saveTimelineToBackend(payload, function (err, result) {
    var ok = !err && !!result && result.ok === true;
    setUiNote(ok ? ('Timeline saved: ' + result.filename) : 'Timeline save failed');
    res.tl = ok ? 'map timeline saved' : 'map timeline FAILED';
    refreshHud();
    maybeReport();
  });
  recordCamera('stop', function (err, j) {
    if (!err && j && j.ok) res.cam = 'camera video saved';
    else if (j && j.error === 'not_recording') res.cam = 'no camera video';
    else res.cam = 'camera stop FAILED';
    maybeReport();
  });
}

function toggleTimelineRecording() {
  if (timelineRecording) stopTimelineRecording();
  else startTimelineRecording();
}
