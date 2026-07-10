(function () {
  var CALIBRATION_GROUPS = [
    { key: 'draw', title: '11-14, 20', tagIds: [11, 12, 13, 14, 20], allowComp: true },
    { key: 'sticker', title: '1-5, 15-19', tagIds: [1, 2, 3, 4, 5, 15, 16, 17, 18, 19], allowComp: false },
    { key: 'annotation', title: '9', tagIds: [9], allowComp: false },
    { key: 'selector', title: '36, 37', tagIds: [36, 37], allowComp: false }
  ];

  function createCalibration(options) {
    var overlayEl = options.overlayEl;

    var active = false;
    var note = '';
    var groupByKey = {};
    var groupByTagId = {};
    var controlsByKey = {};
    var offsets = {};

    for (var i = 0; i < CALIBRATION_GROUPS.length; i++) {
      var group = CALIBRATION_GROUPS[i];
      groupByKey[group.key] = group;
      offsets[group.key] = defaultOffset(group);
      for (var j = 0; j < group.tagIds.length; j++) {
        groupByTagId[group.tagIds[j]] = group;
      }
    }

    var panel = document.createElement('div');
    panel.className = 'calib-panel';

    function defaultOffset(group) {
      var out = { ox: 0, oy: 0 };
      if (group.allowComp) {
        out.compX = 0;
        out.compY = 0;
      }
      return out;
    }

    function normalizeGroupOffset(group, raw) {
      var base = defaultOffset(group);
      if (!raw || typeof raw !== 'object') return base;

      var ox = Number(raw.ox);
      var oy = Number(raw.oy);
      if (Number.isFinite(ox)) base.ox = ox;
      if (Number.isFinite(oy)) base.oy = oy;

      if (group.allowComp) {
        var compX = Number(raw.compX);
        var compY = Number(raw.compY);
        if (Number.isFinite(compX)) base.compX = compX;
        if (Number.isFinite(compY)) base.compY = compY;
      }
      return base;
    }

    function makeSlider(label, min, max, value, step, onChange) {
      var row = document.createElement('div');
      row.className = 'calib-row';

      var lbl = document.createElement('span');
      lbl.className = 'calib-label';
      lbl.textContent = label;

      var slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'calib-slider';
      slider.min = min;
      slider.max = max;
      slider.step = String(step);
      slider.value = value;

      var val = document.createElement('span');
      val.className = 'calib-value';
      val.textContent = String(value);

      slider.addEventListener('input', function () {
        var next = Number(slider.value);
        val.textContent = slider.value;
        onChange(next);
      });

      row.appendChild(lbl);
      row.appendChild(slider);
      row.appendChild(val);
      return { row: row, slider: slider, val: val };
    }

    function addGroupSection(group) {
      var section = document.createElement('div');
      section.className = 'calib-section';

      var title = document.createElement('div');
      title.className = 'calib-section-title';
      title.textContent = group.title;
      section.appendChild(title);

      var state = offsets[group.key];
      var controls = {
        x: makeSlider('X', -200, 200, state.ox, 1, function (v) { offsets[group.key].ox = v; }),
        y: makeSlider('Y', -200, 200, state.oy, 1, function (v) { offsets[group.key].oy = v; })
      };
      section.appendChild(controls.x.row);
      section.appendChild(controls.y.row);

      if (group.allowComp) {
        controls.cx = makeSlider('CX', -100, 100, state.compX, 1, function (v) { offsets[group.key].compX = v; });
        controls.cy = makeSlider('CY', -100, 100, state.compY, 1, function (v) { offsets[group.key].compY = v; });
        section.appendChild(controls.cx.row);
        section.appendChild(controls.cy.row);
      }

      controlsByKey[group.key] = controls;
      panel.appendChild(section);
    }

    for (var k = 0; k < CALIBRATION_GROUPS.length; k++) {
      addGroupSection(CALIBRATION_GROUPS[k]);
    }

    var crosshair = document.createElement('div');
    crosshair.className = 'calib-crosshair';
    overlayEl.appendChild(crosshair);
    overlayEl.appendChild(panel);

    function syncGroupSliders(groupKey) {
      var group = groupByKey[groupKey];
      var state = offsets[groupKey];
      var controls = controlsByKey[groupKey];
      if (!group || !state || !controls) return;

      controls.x.slider.value = String(state.ox);
      controls.x.val.textContent = String(state.ox);
      controls.y.slider.value = String(state.oy);
      controls.y.val.textContent = String(state.oy);

      if (group.allowComp && controls.cx && controls.cy) {
        controls.cx.slider.value = String(state.compX);
        controls.cx.val.textContent = String(state.compX);
        controls.cy.slider.value = String(state.compY);
        controls.cy.val.textContent = String(state.compY);
      }
    }

    function syncAllSliders() {
      for (var i = 0; i < CALIBRATION_GROUPS.length; i++) {
        syncGroupSliders(CALIBRATION_GROUPS[i].key);
      }
    }

    function renderOverlay() {
      overlayEl.classList.toggle('active', active);
    }

    function buildPayload() {
      var groups = {};
      for (var i = 0; i < CALIBRATION_GROUPS.length; i++) {
        var group = CALIBRATION_GROUPS[i];
        var state = offsets[group.key];
        groups[group.key] = {
          ox: state.ox,
          oy: state.oy
        };
        if (group.allowComp) {
          groups[group.key].compX = state.compX;
          groups[group.key].compY = state.compY;
        }
      }
      return { groups: groups };
    }

    function applyLoadedGroups(rawGroups) {
      if (!rawGroups || typeof rawGroups !== 'object') return false;
      for (var i = 0; i < CALIBRATION_GROUPS.length; i++) {
        var group = CALIBRATION_GROUPS[i];
        offsets[group.key] = normalizeGroupOffset(group, rawGroups[group.key]);
      }
      syncAllSliders();
      return true;
    }

    async function saveSlot() {
      try {
        var res = await fetch('/api/calibration', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildPayload())
        });
        var data = await res.json();
        if (!res.ok || !data || data.ok !== true) {
          note = 'Failed to save calibration';
          return false;
        }
        note = 'Calibration saved (S)';
        return true;
      } catch (_e) {
        note = 'Failed to save calibration';
        return false;
      }
    }

    async function loadSlot() {
      try {
        var res = await fetch('/api/calibration', { cache: 'no-store' });
        var data = await res.json();
        if (!res.ok || !data || data.ok !== true) {
          note = 'No saved calibration';
          return false;
        }

        if (data.groups && applyLoadedGroups(data.groups)) {
          note = 'Calibration loaded (L)';
          return true;
        }

        if (Number.isFinite(data.ox) && Number.isFinite(data.oy)) {
          offsets.draw = normalizeGroupOffset(groupByKey.draw, data);
          syncAllSliders();
          note = 'Calibration loaded (L)';
          return true;
        }

        note = 'No saved calibration';
        return false;
      } catch (_e) {
        note = 'Failed to load calibration';
        return false;
      }
    }

    function resetSliders() {
      for (var i = 0; i < CALIBRATION_GROUPS.length; i++) {
        var group = CALIBRATION_GROUPS[i];
        offsets[group.key] = defaultOffset(group);
      }
      syncAllSliders();
      note = 'Calibration reset (R)';
    }

    function buildTagAxesPx(tag, uvToPx) {
      if (!tag || !Array.isArray(tag.uvCorners) || tag.uvCorners.length < 4) return null;
      var c = tag.uvCorners.map(function (p) { return uvToPx(p.u, p.v); });
      if (c.some(function (p) { return !Number.isFinite(p.x) || !Number.isFinite(p.y); })) return null;

      function unit(i, j) {
        var vx = c[j].x - c[i].x;
        var vy = c[j].y - c[i].y;
        var len = Math.hypot(vx, vy);
        if (!Number.isFinite(len) || len <= 1e-6) return null;
        return { x: vx / len, y: vy / len };
      }

      function merge(arr) {
        var base = null;
        var sx = 0;
        var sy = 0;
        for (var i = 0; i < arr.length; i++) {
          var v = arr[i];
          if (!v) continue;
          if (!base) {
            base = v;
          } else if ((v.x * base.x + v.y * base.y) < 0) {
            v = { x: -v.x, y: -v.y };
          }
          sx += v.x;
          sy += v.y;
        }
        var m = Math.hypot(sx, sy);
        if (!Number.isFinite(m) || m <= 1e-6) return null;
        return { x: sx / m, y: sy / m };
      }

      var xAxis = merge([unit(0, 1), unit(3, 2)]);
      var yAxis = merge([unit(0, 3), unit(1, 2)]);
      return xAxis && yAxis ? { xAxis: xAxis, yAxis: yAxis } : null;
    }

    function applyTagOffset(tag, x, y, uvToPx) {
      var tagId = Number(tag && tag.id);
      var group = groupByTagId[tagId];
      if (!group) return { x: x, y: y };

      var state = offsets[group.key] || defaultOffset(group);
      var scaleX = 1;
      var scaleY = 1;

      if (group.allowComp && tag && tag.uv) {
        var dx = (tag.uv.u - 0.5) * 2;
        var dy = (tag.uv.v - 0.5) * 2;
        scaleX = 1 + (state.compX / 100) * dx;
        scaleY = 1 + (state.compY / 100) * dy;
      }

      var effOx = state.ox * scaleX;
      var effOy = state.oy * scaleY;
      var axes = buildTagAxesPx(tag, uvToPx);
      if (!axes) return { x: x + effOx, y: y + effOy };

      return {
        x: x + effOx * axes.xAxis.x + effOy * axes.yAxis.x,
        y: y + effOx * axes.xAxis.y + effOy * axes.yAxis.y
      };
    }

    async function handleKeyDown(e, tags, uvToPx) {
      if (e.repeat) return false;
      var t = e.target;
      var name = String((t && t.tagName) || '').toUpperCase();
      if (name === 'TEXTAREA' || name === 'SELECT' || (t && t.isContentEditable)) return false;
      if (name === 'INPUT') {
        var type = String((t && t.type) || '').toLowerCase();
        if (type !== 'range' && type !== 'button' && type !== 'checkbox' && type !== 'radio') return false;
      }
      var key = String(e.key || '').toLowerCase();

      if (key === 'c') {
        active = !active;
        if (active) resetSliders();
        renderOverlay();
        note = active ? 'Calibration ON' : 'Calibration OFF';
        return true;
      }

      if (!active) return false;
      if (key === 's') {
        e.preventDefault();
        await saveSlot();
        return true;
      }
      if (key === 'l') {
        e.preventDefault();
        await loadSlot();
        return true;
      }
      if (key === 'r') {
        e.preventDefault();
        resetSliders();
        return true;
      }
      return false;
    }

    loadSlot();

    return {
      renderOverlay: renderOverlay,
      handleKeyDown: handleKeyDown,
      applyTagOffset: applyTagOffset,
      isActive: function () { return active; },
      getHint: function () { return active ? 'drag sliders, S save, L load, R reset' : 'press C to calibrate'; },
      getNote: function () { return note; }
    };
  }

  window.CompactCalibration = { createCalibration: createCalibration };
})();
