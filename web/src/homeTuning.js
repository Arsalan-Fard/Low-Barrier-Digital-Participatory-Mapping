// Camera Tuning panel on the home page: the camera's own controls and the tag
// detector's parameters, both applied live. home.js calls init() when the panel
// opens and refreshReadout() while it is open.
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var cameraControlsEl = $('cameraControls');
  var arucoTuningEl = $('arucoTuning');
  var tuneDetect = $('tuneDetect');
  var tuneDetectN = $('tuneDetectN');
  var tuneDetectLabel = $('tuneDetectLabel');
  var tuningBuilt = false;
  var cameraControlsBuilt = false;

  function groupTitle(text) {
    var el = document.createElement('div');
    el.className = 'tune-group';
    el.textContent = text;
    return el;
  }

  function checkboxRow(labelText, checked, onChange) {
    var wrap = document.createElement('label');
    wrap.className = 'tune-check';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', function () { onChange(cb.checked ? 1 : 0); });
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(labelText));
    return wrap;
  }

  function sliderRow(c, onCommit, defaultText) {
    var row = document.createElement('div');
    row.className = 'tune-row';

    var label = document.createElement('label');
    label.className = 'tune-row__label';
    label.textContent = c.label;

    var val = document.createElement('span');
    val.className = 'tune-row__val';
    val.textContent = c.value;

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'tune-row__slider';
    slider.min = c.min;
    slider.max = c.max;
    slider.step = c.step;
    slider.value = c.value;

    row.appendChild(label);
    row.appendChild(val);
    row.appendChild(slider);
    if (defaultText) {
      var def = document.createElement('span');
      def.className = 'tune-row__def';
      def.textContent = defaultText;
      row.appendChild(def);
    }

    var timer = null;
    slider.addEventListener('input', function () {
      val.textContent = slider.value;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { onCommit(Number(slider.value)); }, 130);
    });
    return row;
  }

  function initArucoTuning() {
    function putTuning(body) {
      fetch('/api/aruco-tuning', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).catch(function () { });
    }
    function putOne(key, value) {
      var body = {};
      body[key] = value;
      putTuning(body);
    }
    fetch('/api/aruco-tuning', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !Array.isArray(data.controls)) return;
        arucoTuningEl.innerHTML = '';
        var heading = 'Tag detection';
        if (data.activeBackend && data.activeBackend !== 'aruco') {
          heading += ' (inactive, detector is ' + data.activeBackend + ')';
        }
        arucoTuningEl.appendChild(groupTitle(heading));
        data.controls.forEach(function (c) {
          arucoTuningEl.appendChild(sliderRow(c, function (v) { putOne(c.key, v); }, 'OpenCV default ' + c.default));
        });

        // Upscaling rejected tag-shaped regions rescues small or distant tags
        // but is costly, so it has its own toggle.
        if (Array.isArray(data.upscale)) {
          arucoTuningEl.appendChild(groupTitle('Rescue distant tags'));
          arucoTuningEl.appendChild(checkboxRow('Upscale small regions (slower)', !!data.upscaleEnabled, function (v) {
            putTuning({ upEnabled: v });
          }));
          data.upscale.forEach(function (c) {
            arucoTuningEl.appendChild(sliderRow(c, function (v) { putOne(c.key, v); }));
          });
        }
        tuningBuilt = true;
      })
      .catch(function () { });
  }

  function initCameraControls() {
    fetch('/api/camera/controls', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok || !Array.isArray(data.controls)) return;
        cameraControlsEl.innerHTML = '';
        if (data.kind === 'none') return;
        cameraControlsEl.appendChild(
          groupTitle('Camera (' + (data.kind === 'ip' ? 'phone' : 'webcam') + ')'));

        function putControl(name, value) {
          fetch('/api/camera/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, value: value })
          }).catch(function () { });
        }

        // Setting exposure or focus turns its auto mode off on the backend, so
        // untick the matching box to agree.
        var autoCbByKey = {};
        var pairedAuto = { exposure: 'exposureAuto', focus: 'focusAuto' };

        data.controls.forEach(function (c) {
          if (c.type === 'toggle') {
            var wrap = checkboxRow(c.label, Number(c.value) !== 0, function (v) { putControl(c.key, v); });
            autoCbByKey[c.key] = wrap.querySelector('input');
            cameraControlsEl.appendChild(wrap);
            return;
          }
          if (c.type === 'select') {
            var row = document.createElement('div');
            row.className = 'tune-row';
            var label = document.createElement('label');
            label.className = 'tune-row__label';
            label.textContent = c.label;
            row.appendChild(label);
            row.appendChild(document.createElement('span'));
            var sel = document.createElement('select');
            sel.className = 'tune-row__select';
            (c.options || []).forEach(function (opt) {
              var o = document.createElement('option');
              o.value = opt;
              o.textContent = opt;
              if (String(opt) === String(c.value)) o.selected = true;
              sel.appendChild(o);
            });
            sel.addEventListener('change', function () { putControl(c.key, sel.value); });
            row.appendChild(sel);
            cameraControlsEl.appendChild(row);
            return;
          }
          cameraControlsEl.appendChild(sliderRow(c, function (v) {
            var ak = pairedAuto[c.key];
            if (ak && autoCbByKey[ak]) autoCbByKey[ak].checked = false;
            putControl(c.key, v);
          }));
        });
        cameraControlsBuilt = true;
      })
      .catch(function () { });
  }

  function initTuning() {
    if (!tuningBuilt) initArucoTuning();
    if (!cameraControlsBuilt) initCameraControls();
  }

  function refreshReadout(cameraConnected, tagCount) {
    if (!cameraConnected) {
      tuneDetectN.textContent = '—';
      tuneDetectLabel.textContent = 'waiting for the camera';
      tuneDetect.classList.remove('none');
      return;
    }
    // Camera controls are only built once the backend reports a camera, so keep retrying.
    if (!cameraControlsBuilt) initCameraControls();
    tuneDetectN.textContent = String(tagCount);
    tuneDetectLabel.textContent = tagCount === 1 ? 'tag detected' : 'tags detected';
    tuneDetect.classList.toggle('none', tagCount === 0);
  }

  window.CompactHomeTuning = { init: initTuning, refreshReadout: refreshReadout };
})();
