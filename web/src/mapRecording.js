// Map page: timeline recording (the top bar's Record button), with its on-screen toast and the
// backend camera + microphone recorder started and stopped alongside it.
const TIMELINE_SAMPLE_MS = 1000;
const TIMELINE_MAX_FRAMES = 3600;
// Autosaving keeps a recording nobody stopped (or a crash) from being lost.
const TIMELINE_AUTOSAVE_MS = 5000;
let timelineRecording = null;

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

// A banner over the page. kind 'rec' stays up; 'done' and 'err' fade.
function showRecordToast(html, kind) {
  var el = document.getElementById('recordToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'recordToast';
    el.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;'
      + 'background:#fff;color:#16302b;border:2px solid #cfe6e0;border-radius:11px;'
      + 'padding:10px 18px;font:600 14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;'
      + 'box-shadow:0 8px 30px rgba(22,48,43,.25);max-width:80vw;text-align:center;'
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

// The backend camera + mic recorder.
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
  showRecordToast('Saving&hellip;', 'done');

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
    res.tl = ok ? 'map timeline saved' : 'map timeline FAILED';
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
