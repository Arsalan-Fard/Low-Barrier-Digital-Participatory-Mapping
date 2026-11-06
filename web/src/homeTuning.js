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

  // A setting's name, then which way helps ("higher = ...") in smaller text beside it.
  function setLabel(el, text, hint) {
    el.appendChild(document.createTextNode(text));
    if (!hint) return;
    var span = document.createElement('span');
    span.className = 'tune-hint';
    span.textContent = hint;
    el.appendChild(span);
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

  function sliderRow(c, onCommit) {
    var row = document.createElement('div');
    row.className = 'tune-row';

    var label = document.createElement('label');
    label.className = 'tune-row__label';
    setLabel(label, c.label, c.hint);

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
        data.controls.forEach(function (c) {
          arucoTuningEl.appendChild(sliderRow(c, function (v) { putOne(c.key, v); }));
        });

        // Upscaling rejected tag-shaped regions rescues small or distant tags
        // but is costly, so it has its own toggle.
        if (Array.isArray(data.upscale)) {
          arucoTuningEl.appendChild(checkboxRow('Upscale small regions (slower)', !!data.upscaleEnabled, function (v) {
            putTuning({ upEnabled: v });
          }));
          data.upscale.forEach(function (c) {
            arucoTuningEl.appendChild(sliderRow(c, function (v) { putOne(c.key, v); }));
          });
        }

        // How far a printed sheet's tags must move before the view projected onto it follows.
        (data.screen || []).forEach(function (c) {
          arucoTuningEl.appendChild(sliderRow(c, function (v) { putOne(c.key, v); }));
        });
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

        function putControl(name, value) {
          fetch('/api/camera/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, value: value })
          }).catch(function () { });
        }

        // The boxes follow what the backend does: setting exposure or focus turns its auto mode off,
        // Smart exposure turns the phone's own Auto exposure off, and setting the exposure by hand
        // (Auto exposure or the slider) turns Smart exposure off.
        var autoCbByKey = {};
        var pairedAuto = { exposure: 'exposureAuto', focus: 'focusAuto' };
        function untick(key) {
          if (autoCbByKey[key]) autoCbByKey[key].checked = false;
        }

        data.controls.forEach(function (c) {
          if (c.type === 'toggle') {
            var wrap = checkboxRow(c.label, Number(c.value) !== 0, function (v) {
              if (c.key === 'smartExposure' && v) untick('exposureAuto');
              if (c.key === 'exposureAuto') untick('smartExposure');
              putControl(c.key, v);
            });
            autoCbByKey[c.key] = wrap.querySelector('input');
            cameraControlsEl.appendChild(wrap);
            return;
          }
          if (c.type === 'select') {
            var row = document.createElement('div');
            row.className = 'tune-row';
            var label = document.createElement('label');
            label.className = 'tune-row__label';
            setLabel(label, c.label, c.hint);
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
            if (pairedAuto[c.key]) untick(pairedAuto[c.key]);
            if (c.key === 'exposure') untick('smartExposure');
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
