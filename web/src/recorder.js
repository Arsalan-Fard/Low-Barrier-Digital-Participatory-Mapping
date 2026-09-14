// Record button for the camera + microphone recorder that lives in the backend.
// Auto-wires when #recordBtn is on the page; #recordToast is optional.
//
// One recorder, many buttons: /api/record drives the same backend instance the
// Ctrl+Shift+R hotkey and the workshop page use, so whoever starts it, every
// page agrees about it. Video and sound only -- the workshop page additionally
// writes a timeline of map state, which describes a workshop being run, and the
// pages that load this module are not running one.
//
// Markup this expects (see imobyl.html):
//   <button id="recordBtn" class="launch rec">
//     <span class="rec-icon"></span><span class="rec-label">Record</span>
//   </button>
//   <div id="recordToast" role="status" aria-live="polite"></div>
(function () {
  var button = document.getElementById('recordBtn');
  if (!button) return;

  var recordOn = false;
  var recordBusy = false;
  var recordAvailable = true;
  // Bumped whenever the button acts. A status poll already in flight when that
  // happens is answering an older question, and its answer would undo the very
  // change the operator just asked for.
  var recordEpoch = 0;

  function toast(html, kind) {
    var el = document.getElementById('recordToast');
    if (!el) return;
    if (el._timer) { window.clearTimeout(el._timer); el._timer = 0; }
    // 'rec' is the running notice. It used to stay up for the whole session --
    // a plate parked over the projected map saying what the button already
    // says (red disc -> red square, "Record" -> "Stop"). Nothing is shown for
    // it now. Only news gets a plate: what was saved, or why a start failed,
    // and it goes away on its own.
    if (kind === 'rec') { el.style.opacity = '0'; return; }
    el.innerHTML = html;
    el.style.borderColor = kind === 'err' ? '#e0a13a' : '#28d17c';
    el.style.opacity = '1';
    el._timer = window.setTimeout(function () { el.style.opacity = '0'; }, 4500);
  }

  function paint() {
    button.classList.toggle('is-on', recordOn);
    var label = button.querySelector('.rec-label');
    if (label) label.textContent = recordOn ? 'Stop' : 'Record';
    button.setAttribute('aria-label', recordOn ? 'Stop recording' : 'Start recording');
    button.disabled = !recordAvailable;
    button.title = recordAvailable
      ? (recordOn ? 'Stop recording camera and microphone'
                  : 'Record camera and microphone')
      : 'No recorder on this server';
  }

  function api(method, action) {
    var options = { method: method, cache: 'no-store' };
    if (action) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({ action: action });
    }
    return fetch('/api/record', options).then(function (response) {
      return response.json().catch(function () { return null; });
    });
  }

  // Somebody else may start or stop it -- the hotkey, or another page in
  // another window -- so the button asks rather than assumes.
  function sync() {
    if (recordBusy) return;
    var epoch = recordEpoch;
    api('GET').then(function (data) {
      if (!data || epoch !== recordEpoch) return;   // overtaken by a click
      recordAvailable = data.available !== false;
      if (data.recording !== recordOn) {
        recordOn = !!data.recording;
        if (recordOn) toast('&#9679; REC &mdash; camera + microphone', 'rec');
        else toast('Recording stopped.', 'done');
      }
      paint();
    }).catch(function () { /* the server will be asked again shortly */ });
  }

  function toggle() {
    if (recordBusy || !recordAvailable) return;
    recordBusy = true;
    recordEpoch += 1;
    var starting = !recordOn;
    toast(starting ? '&#9679; Starting&hellip;' : 'Saving&hellip;',
          starting ? 'rec' : 'done');
    api('POST', starting ? 'start' : 'stop').then(function (data) {
      recordBusy = false;
      if (!data) {
        toast('Recorder unreachable.', 'err');
        return;
      }
      if (starting) {
        // "Already recording" is not a failure: it is the state asked for.
        if (data.ok || data.error === 'already_recording') {
          recordOn = true;
          toast('&#9679; REC &mdash; camera + microphone', 'rec');
        } else {
          recordOn = !!data.recording;
          var why = data.error === 'recorder_unavailable' ? 'no recorder on this server'
            : data.error === 'no_camera_frame' ? 'camera not connected'
            : (data.error || 'unavailable');
          if (data.error === 'recorder_unavailable') recordAvailable = false;
          toast('Could not start<br><span style="font-weight:400;font-size:12px;'
            + 'opacity:.85">' + why + '</span>', 'err');
        }
      } else {
        recordOn = !!data.recording;
        if (data.ok) {
          var files = (data.files || []).length;
          toast('Saved &#10003;<br><span style="font-weight:400;font-size:12px;'
            + 'opacity:.85">' + (files ? files + ' file' + (files === 1 ? '' : 's') + ' in ' : '')
            + (data.directory || 'the recordings folder') + '</span>', 'done');
        } else if (data.error === 'not_recording') {
          toast('Nothing was recording.', 'done');
        } else {
          toast('Stop failed<br><span style="font-weight:400;font-size:12px;'
            + 'opacity:.85">' + (data.error || 'unknown') + '</span>', 'err');
        }
      }
      paint();
    }).catch(function () {
      recordBusy = false;
      toast('Recorder unreachable.', 'err');
    });
  }

  button.addEventListener('click', toggle);
  paint();
  sync();
  window.setInterval(sync, 1500);
})();
