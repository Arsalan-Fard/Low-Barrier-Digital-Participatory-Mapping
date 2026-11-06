// The /marker page: which AprilTag each tool uses. The slot model (groups,
// tools, the order of the screen's slots) must agree with tagAssignments.js,
// which the map page reads, and sanitize_marker_settings on the server.
(function () {
  var els = {
    family: document.getElementById('markerFamily'),
    size: document.getElementById('markerSizeCm'),
    download: document.getElementById('markerDownload'),
    body: document.getElementById('markerBody'),
    status: document.getElementById('markerSaveStatus')
  };

  var state = {
    family: 'tag36h11',
    tagSizeCm: 3,
    slots: [],
    availableFamilies: []
  };
  var flippedBySlot = {};
  var saveTimer = 0;
  var defaultDrawOffsetCm = 3;

  var GROUP_MULTI = 'Pointer';
  var GROUP_SINGLE = 'Single-state pointer';
  var GROUP_SCREEN = 'Screens';

  // Per screen tool: the PDF the server draws for it (a map view sheet other than the first adds
  // ?sheet=<its key>). The sheet's label is the word in its diagram's middle.
  var SCREEN_KINDS = {
    'street-screen': {
      pdfUrl: '/api/street-screen/frame.pdf',
      pdfTitle: 'The sheet to print: page 1 is the screen, page 2 the street view pointer'
    },
    'map-screen': {
      pdfUrl: '/api/map-screen/frame.pdf',
      pdfTitle: 'The sheet to print. It shows the view the Project panel assigned to it, or else follows the street view pointer'
    }
  };
  // Map view sheets: the first is "map-screen", the others "map-screen-<n>" (n is printed on the
  // sheet, so it stays with it). Keep in step with marker_settings.py.
  var MAP_SHEET_KEY = 'map-screen';
  var MAX_MAP_SHEETS = 20;

  function mapSheetNumber(key) {
    if (key === MAP_SHEET_KEY) return 1;
    var match = /^map-screen-(\d{1,2})$/.exec(String(key || ''));
    var n = match ? Number(match[1]) : 0;
    return n >= 2 && n <= MAX_MAP_SHEETS ? n : null;
  }

  function mapSheets() {
    return state.slots.filter(function (slot) { return slot.tool === 'map-screen'; });
  }

  // A screen's border slots in frameTagIds order, with each one's place on
  // the sheet diagram in percent of its width and height.
  var SCREEN_SLOTS = [
    { slot: 'tl', name: 'Top left', x: 0, y: 0 },
    { slot: 'tr', name: 'Top right', x: 100, y: 0 },
    { slot: 'br', name: 'Bottom right', x: 100, y: 100 },
    { slot: 'bl', name: 'Bottom left', x: 0, y: 100 },
    { slot: 'rm', name: 'Right middle', x: 100, y: 50 },
    { slot: 'bm', name: 'Bottom middle', x: 50, y: 100 },
    { slot: 'lm', name: 'Left middle', x: 0, y: 50 }
  ];
  // Ids "Assign automatically" never hands out because the map page uses them
  // regardless of this page: the zoom and pan tags (21, 22).
  var RESERVED_TAG_IDS = [21, 22];
  var TAG_PROPS = ['tagId', 'tagId2', 'selectorTagId', 'selectorTagId2'];

  function setMarkerStatus(text, kind) {
    els.status.textContent = text || '';
    els.status.className = 'status-line' + (kind ? ' ' + kind : '');
  }

  function normalizeOffsetCm(raw) {
    var n = Number(raw);
    if (!Number.isFinite(n)) n = defaultDrawOffsetCm;
    return Math.max(0, Math.min(20, n));
  }

  function toId(raw) {
    return raw == null || raw === '' ? null : Number(raw);
  }

  function cloneFrameTagIds(raw) {
    var src = Array.isArray(raw) ? raw : [];
    return SCREEN_SLOTS.map(function (_entry, index) { return toId(src[index]); });
  }

  function cloneSlot(slot) {
    var tool = String(slot.tool || '');
    var rawGroup = String(slot.group || '');
    var group = (tool === 'draw' || rawGroup === 'Multi-state pointer') ? GROUP_MULTI : rawGroup;
    var out = {
      key: String(slot.key || ''),
      group: group,
      tool: tool,
      label: String(slot.label || ''),
      tagId: toId(slot.tagId),
      tagId2: toId(slot.tagId2),
      selectorTagId: toId(slot.selectorTagId),
      selectorTagId2: toId(slot.selectorTagId2),
      color: String(slot.color || ''),
      offsetCm: tool === 'draw' ? normalizeOffsetCm(slot.offsetCm) : undefined
    };
    if (SCREEN_KINDS[tool]) out.frameTagIds = cloneFrameTagIds(slot.frameTagIds);
    return out;
  }

  function applyMarkerData(data) {
    data = data && typeof data === 'object' ? data : {};
    state.family = String(data.family || state.family || 'tag36h11');
    state.tagSizeCm = Number(data.tagSizeCm) || 3;
    state.slots = Array.isArray(data.slots) ? data.slots.map(cloneSlot) : [];
    state.availableFamilies = Array.isArray(data.availableFamilies) ? data.availableFamilies : state.availableFamilies;
    els.size.value = String(state.tagSizeCm);
  }

  function familyIds() {
    for (var i = 0; i < state.availableFamilies.length; i++) {
      if (state.availableFamilies[i].family === state.family) {
        return Array.isArray(state.availableFamilies[i].ids) ? state.availableFamilies[i].ids : [];
      }
    }
    return [];
  }

  function slotTagIds(slot) {
    var ids = [];
    TAG_PROPS.forEach(function (prop) {
      if (slot[prop] != null) ids.push(Number(slot[prop]));
    });
    (slot.frameTagIds || []).forEach(function (id) { if (id != null) ids.push(Number(id)); });
    return ids;
  }

  function usedByTagId() {
    var used = {};
    state.slots.forEach(function (slot) {
      slotTagIds(slot).forEach(function (id) { used[String(id)] = slot.key; });
    });
    return used;
  }

  // An id belongs to one place only: giving it to `owner` (in `ownerProp`, or
  // in frame position `ownerIndex`) takes it away from wherever else it was.
  function claimTagId(owner, tagId, ownerProp, ownerIndex) {
    if (tagId == null) return;
    state.slots.forEach(function (slot) {
      TAG_PROPS.forEach(function (prop) {
        if (slot === owner && prop === ownerProp) return;
        if (Number(slot[prop]) === Number(tagId) && slot[prop] != null) slot[prop] = null;
      });
      if (!slot.frameTagIds) return;
      slot.frameTagIds = slot.frameTagIds.map(function (id, index) {
        if (slot === owner && index === ownerIndex) return id;
        return id != null && Number(id) === Number(tagId) ? null : id;
      });
    });
  }

  function scheduleMarkerSave() {
    setMarkerStatus('Saving...', '');
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveMarkerSettings, 250);
  }

  function saveMarkerSettings() {
    saveTimer = 0;
    var httpStatus = 0;
    return fetch('/api/marker-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        family: state.family,
        tagSizeCm: Number(state.tagSizeCm) || 3,
        slots: state.slots
      })
    }).then(function (r) {
      httpStatus = r.status;
      // An error response's body carries the server's reason.
      return r.json().catch(function () { return null; });
    })
      .then(function (data) {
        if (!data || !data.ok) {
          var reason = (data && (data.detail || data.error)) || ('HTTP ' + (httpStatus || '?'));
          throw new Error(reason);
        }
        applyMarkerData(data);
        renderMarkerEditor();
        setMarkerStatus('Saved', 'ok');
        window.setTimeout(function () {
          if (els.status.textContent === 'Saved') setMarkerStatus('', '');
        }, 1200);
        return true;
      })
      .catch(function (err) {
        var msg = (err && err.message) ? String(err.message) : 'network error';
        setMarkerStatus('Save failed: ' + msg, 'err');
        return false;
      });
  }

  function renderFamilyOptions() {
    els.family.innerHTML = '';
    state.availableFamilies.forEach(function (entry) {
      var opt = document.createElement('option');
      opt.value = entry.family;
      opt.textContent = entry.family;
      els.family.appendChild(opt);
    });
    els.family.value = state.family;
  }

  function markerSvgPath(tagId) {
    return '/api/apriltag-svg/' + encodeURIComponent(state.family) + '/' + Number(tagId) + '.svg';
  }

  // Ids another slot holds are marked, not hidden: picking one moves it here.
  function buildTagSelect(slot, current, title, onPick, className) {
    var select = document.createElement('select');
    select.className = className || 'marker-tag-select';
    select.title = title;
    var emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = 'Empty';
    select.appendChild(emptyOpt);
    var used = usedByTagId();
    familyIds().forEach(function (id) {
      var opt = document.createElement('option');
      opt.value = String(id);
      opt.textContent = String(id);
      if (used[String(id)] && used[String(id)] !== slot.key) {
        opt.className = 'taken';
        opt.title = 'Already used by another marker';
      }
      select.appendChild(opt);
    });
    select.value = current == null ? '' : String(current);
    select.addEventListener('change', function () {
      onPick(select.value === '' ? null : Number(select.value));
      renderMarkerEditor();
      scheduleMarkerSave();
    });
    return select;
  }

  // Every tag is picked the same way: the tag's own image (or an empty square) is the button, and
  // clicking it opens the list of ids. className sizes and places it.
  function buildTagPicker(slot, current, title, onPick, className) {
    var pick = document.createElement('div');
    pick.className = 'tag-pick' + (className ? ' ' + className : '');
    function emptyBox(text) {
      var box = document.createElement('div');
      box.className = 'tag-pick-empty';
      box.textContent = text;
      return box;
    }
    if (current == null) {
      pick.appendChild(emptyBox('Empty'));
    } else {
      var img = document.createElement('img');
      img.alt = 'AprilTag ' + current;
      img.src = markerSvgPath(current);
      img.onerror = function () { img.replaceWith(emptyBox('Missing')); };
      pick.appendChild(img);
      var badge = document.createElement('span');
      badge.className = 'tag-pick-id';
      badge.textContent = String(current);
      pick.appendChild(badge);
    }
    var hint = current == null ? title + ': click to pick a tag' : title + ' (ID ' + current + '): click to change';
    pick.appendChild(buildTagSelect(slot, current, hint, onPick, 'tag-pick-select'));
    return pick;
  }

  function buildPropPicker(slot, prop, title, className) {
    return buildTagPicker(slot, slot[prop], title, function (next) {
      claimTagId(slot, next, prop, -1);
      slot[prop] = next;
    }, className);
  }

  function buildPointerWing(slot, prop, sideClass, title) {
    return buildPropPicker(slot, prop, title, 'pointer-wing ' + sideClass);
  }

  function renderPointerPreview(slot, preview) {
    preview.classList.add('pointer-preview');
    var isBack = !!flippedBySlot[slot.key];
    var colorHex = /^#[0-9a-fA-F]{6}$/.test(slot.color || '') ? slot.color : '#ff5b5b';
    var curOffset = normalizeOffsetCm(slot.offsetCm);

    var centerCol = document.createElement('div');
    centerCol.className = 'pointer-center-col';

    // 1. Colored circle on top of the pointer (click to change color; moves up/down with offset)
    var circleTrack = document.createElement('div');
    circleTrack.className = 'pointer-circle-track';
    var stem = document.createElement('span');
    stem.className = 'pointer-circle-stem';
    circleTrack.appendChild(stem);

    var circle = document.createElement('label');
    circle.className = 'pointer-color-circle';
    circle.style.background = colorHex;
    circle.title = 'Click to change pointer color';
    var colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = colorHex;
    colorInput.setAttribute('aria-label', 'Pointer color');
    colorInput.addEventListener('input', function () {
      slot.color = colorInput.value;
      circle.style.background = colorInput.value;
      scheduleMarkerSave();
    });
    circle.appendChild(colorInput);
    circleTrack.appendChild(circle);
    centerCol.appendChild(circleTrack);

    function syncCircleOffset(cm) {
      var travelPx = Math.round((Math.max(0, Math.min(20, cm)) / 20) * 26);
      circle.style.bottom = travelPx + 'px';
      stem.style.height = travelPx + 'px';
    }
    syncCircleOffset(curOffset);

    // 2. Folding pointer silhouette with clickable tag squares on both wings
    var fig = document.createElement('div');
    fig.className = 'pointer-figure';
    var bodyFill = isBack ? '#f2ece1' : '#ffffff';
    var sideLabel = isBack ? 'Tools' : 'Draw';
    fig.innerHTML =
      '<svg class="pointer-shape-svg" viewBox="4 8 92 82" aria-hidden="true">' +
        '<path d="M 80.5,84.4 V 54.4 H 90.5 V 14.4 H 10.5 V 54.4 H 20.5 V 84.4 H 45.5 L 50.5,50.6 L 55.5,84.4 Z" ' +
          'fill="' + bodyFill + '" stroke="#16302b" stroke-width="1.4" stroke-linejoin="round" />' +
        '<path d="M 50.5,14.4 V 50.6" fill="none" stroke="#16302b" stroke-width="1.1" stroke-dasharray="2.4,2" />' +
        '<path d="M 10.5,34.4 H 16.5 M 84.5,34.4 H 90.5" fill="none" stroke="#16302b" stroke-width="1.2" />' +
        '<text x="68" y="71.5" text-anchor="middle" fill="#16302b" font-size="8.2" font-weight="800" font-family="system-ui, sans-serif">' + sideLabel + '</text>' +
      '</svg>';

    var leftProp = isBack ? 'selectorTagId' : 'tagId';
    var rightProp = isBack ? 'selectorTagId2' : 'tagId2';
    var leftTitle = isBack ? 'Left tool-selection tag' : 'Left pointer tag';
    var rightTitle = isBack ? 'Right tool-selection tag' : 'Right pointer tag';

    fig.appendChild(buildPointerWing(slot, leftProp, 'left', leftTitle));
    fig.appendChild(buildPointerWing(slot, rightProp, 'right', rightTitle));
    centerCol.appendChild(fig);

    // 3. Flip button at the bottom of the pointer preview
    var turn = document.createElement('button');
    turn.className = 'pointer-turn-btn' + (isBack ? ' is-back' : '');
    turn.type = 'button';
    turn.title = 'Flip pointer to see and edit the tags on its other side';
    turn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>' +
      '<span>Flip</span>';
    turn.addEventListener('click', function () {
      flippedBySlot[slot.key] = !flippedBySlot[slot.key];
      renderMarkerEditor();
    });
    centerCol.appendChild(turn);
    preview.appendChild(centerCol);

    // 4. Long vertical offset slider beside the pointer
    var sliderWrap = document.createElement('div');
    sliderWrap.className = 'pointer-offset-slider-wrap';
    sliderWrap.title = 'Offset from the pointer to the tip, in centimeters';
    var curOffset = normalizeOffsetCm(slot.offsetCm);
    var offsetVal = document.createElement('span');
    offsetVal.className = 'pointer-offset-val';
    offsetVal.textContent = curOffset + ' cm';
    var trackBox = document.createElement('div');
    trackBox.className = 'pointer-offset-track-box';
    var slider = document.createElement('input');
    slider.className = 'pointer-offset-slider';
    slider.type = 'range';
    slider.min = '0';
    slider.max = '20';
    slider.step = '0.5';
    slider.value = String(curOffset);
    slider.setAttribute('aria-label', 'Pen tip offset in centimeters');
    slider.addEventListener('input', function () {
      var next = normalizeOffsetCm(slider.value);
      slot.offsetCm = next;
      offsetVal.textContent = next + ' cm';
      syncCircleOffset(next);
      scheduleMarkerSave();
    });
    trackBox.appendChild(slider);
    sliderWrap.appendChild(offsetVal);
    sliderWrap.appendChild(trackBox);
    preview.appendChild(sliderWrap);
  }

  function renderMarkerCard(slot) {
    // Pointers are the only slots that can be added or removed,
    // and they show the folding pointer silhouette with clickable tags on both wings.
    var isDraw = slot.tool === 'draw';
    var card = document.createElement('div');
    card.className = 'marker-card' + (isDraw ? ' wide' : '');

    var preview = document.createElement('div');
    preview.className = 'marker-preview';
    if (isDraw) {
      var del = document.createElement('button');
      del.className = 'marker-delete';
      del.type = 'button';
      del.title = 'Delete pointer';
      del.setAttribute('aria-label', 'Delete pointer');
      del.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
        '<path fill="currentColor" d="M9 3v1H4v2h16V4h-5V3H9zM6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13H6zm4 3h1.5v8H10v-8zm2.5 0H14v8h-1.5v-8z"/></svg>';
      del.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        state.slots = state.slots.filter(function (candidate) { return candidate.key !== slot.key; });
        renderMarkerEditor();
        scheduleMarkerSave();
      });
      preview.appendChild(del);
      renderPointerPreview(slot, preview);
    } else {
      preview.appendChild(buildPropPicker(slot, 'tagId', (slot.label || slot.tool || 'Marker') + ' tag', 'tag-pick--card'));
    }
    card.appendChild(preview);

    var label = document.createElement('div');
    label.className = 'marker-card-label';
    label.textContent = slot.label || slot.tool || '';
    card.appendChild(label);
    return card;
  }

  // The single-state pointer that opens the street view: picked inside the street view sheet.
  function streetViewPointerSlot() {
    for (var i = 0; i < state.slots.length; i++) {
      if (state.slots[i].tool === 'street-view') return state.slots[i];
    }
    return null;
  }

  function hasStreetScreen() {
    return state.slots.some(function (slot) { return slot.tool === 'street-screen'; });
  }

  // The lowest free ids, in order. Ids the screen already holds count as free
  // (they are being reassigned); ids any other tool holds do not.
  function autoAssignScreen(slot) {
    var taken = {};
    RESERVED_TAG_IDS.forEach(function (id) { taken[String(id)] = true; });
    state.slots.forEach(function (other) {
      if (other === slot) return;
      slotTagIds(other).forEach(function (id) { taken[String(id)] = true; });
    });
    var free = familyIds().filter(function (id) { return !taken[String(id)]; });
    slot.frameTagIds = SCREEN_SLOTS.map(function (_entry, index) {
      return index < free.length ? Number(free[index]) : null;
    });
    return Math.min(free.length, SCREEN_SLOTS.length);
  }

  function downloadScreenSheet(slot) {
    var kind = SCREEN_KINDS[slot.tool];
    var url = kind.pdfUrl + (slot.key !== slot.tool ? '?sheet=' + encodeURIComponent(slot.key) : '');
    var name = String(slot.label || slot.tool).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-screen-A3.pdf';
    // The server draws the PDF from the SAVED settings, so a pending save goes first.
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
    }
    saveMarkerSettings().then(function (ok) {
      if (!ok) return;
      var link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setMarkerStatus('PDF download started', '');
      window.setTimeout(function () { setMarkerStatus('', ''); }, 1800);
    });
  }

  function renderScreenCard(slot) {
    var kind = SCREEN_KINDS[slot.tool];
    if (!Array.isArray(slot.frameTagIds)) slot.frameTagIds = cloneFrameTagIds(null);
    var card = document.createElement('div');
    card.className = 'screen-card';

    var sheet = document.createElement('div');
    sheet.className = 'screen-sheet';
    var inside = document.createElement('div');
    inside.className = 'screen-sheet-inside';
    var name = document.createElement('span');
    name.className = 'screen-sheet-name';
    name.textContent = slot.label || slot.tool;
    inside.appendChild(name);
    var pointer = slot.tool === 'street-screen' ? streetViewPointerSlot() : null;
    if (pointer) {
      var pointerWrap = document.createElement('div');
      pointerWrap.className = 'screen-pointer';
      pointerWrap.appendChild(buildPropPicker(pointer, 'tagId', 'Street view pointer tag', 'tag-pick--pointer'));
      var pointerLabel = document.createElement('span');
      pointerLabel.className = 'screen-pointer-label';
      pointerLabel.textContent = 'Street view pointer';
      pointerWrap.appendChild(pointerLabel);
      inside.appendChild(pointerWrap);
    }
    sheet.appendChild(inside);
    SCREEN_SLOTS.forEach(function (entry, index) {
      var cell = document.createElement('div');
      cell.className = 'screen-cell';
      cell.style.left = entry.x + '%';
      cell.style.top = entry.y + '%';
      cell.appendChild(buildTagPicker(slot, slot.frameTagIds[index], entry.name + ' tag', function (next) {
        claimTagId(slot, next, '', index);
        slot.frameTagIds[index] = next;
      }, 'tag-pick--cell'));
      sheet.appendChild(cell);
    });
    card.appendChild(sheet);

    var side = document.createElement('div');
    side.className = 'screen-side';
    var assigned = slot.frameTagIds.filter(function (id) { return id != null; }).length;
    var count = document.createElement('div');
    count.className = 'screen-count' + (assigned < 2 ? ' warn' : '');
    count.textContent = assigned + ' of ' + SCREEN_SLOTS.length + ' tags assigned'
      + (assigned < 2 ? ' — the screen needs at least 2' : '');
    side.appendChild(count);
    var buttons = document.createElement('div');
    buttons.className = 'screen-buttons';
    side.appendChild(buttons);

    var auto = document.createElement('button');
    auto.className = 'action';
    auto.type = 'button';
    auto.textContent = 'Assign automatically';
    auto.title = 'Give all seven positions the lowest tag ids no other tool is using';
    auto.addEventListener('click', function () {
      var got = autoAssignScreen(slot);
      renderMarkerEditor();
      scheduleMarkerSave();
      if (got < SCREEN_SLOTS.length) {
        window.setTimeout(function () {
          setMarkerStatus('Only ' + got + ' free ids in ' + state.family + ' — pick a larger tag family for a full border.', 'err');
        }, 400);
      }
    });
    buttons.appendChild(auto);

    var clear = document.createElement('button');
    clear.className = 'action ghost';
    clear.type = 'button';
    clear.textContent = 'Clear';
    clear.addEventListener('click', function () {
      slot.frameTagIds = cloneFrameTagIds(null);
      renderMarkerEditor();
      scheduleMarkerSave();
    });
    buttons.appendChild(clear);

    var pdf = document.createElement('button');
    pdf.className = 'action ghost';
    pdf.type = 'button';
    pdf.textContent = 'Download screen (A3 PDF)';
    pdf.title = kind.pdfTitle;
    pdf.disabled = assigned < 2;
    pdf.addEventListener('click', function () { downloadScreenSheet(slot); });
    buttons.appendChild(pdf);

    // The first map view sheet stays (clear its tags to switch it off); added ones can go.
    if (slot.tool === 'map-screen' && slot.key !== MAP_SHEET_KEY) {
      var remove = document.createElement('button');
      remove.className = 'action ghost danger';
      remove.type = 'button';
      remove.textContent = 'Remove sheet';
      remove.title = 'Remove ' + (slot.label || 'this map view sheet') + ' and free its tags';
      remove.addEventListener('click', function () {
        state.slots = state.slots.filter(function (candidate) { return candidate.key !== slot.key; });
        renderMarkerEditor();
        scheduleMarkerSave();
      });
      buttons.appendChild(remove);
    }

    card.appendChild(side);
    return card;
  }

  // A new map view sheet takes the lowest free number and, straight away, the lowest free tags.
  function addMapSheet() {
    var used = {};
    mapSheets().forEach(function (slot) { used[mapSheetNumber(slot.key)] = true; });
    var number = 2;
    while (used[number] && number <= MAX_MAP_SHEETS) number += 1;
    if (number > MAX_MAP_SHEETS) {
      setMarkerStatus('At most ' + MAX_MAP_SHEETS + ' map view sheets.', 'err');
      return;
    }
    var slot = {
      key: 'map-screen-' + number,
      group: GROUP_SCREEN,
      tool: 'map-screen',
      label: 'Map view ' + number,
      tagId: null,
      color: '',
      frameTagIds: cloneFrameTagIds(null)
    };
    // Right after the last map view sheet, so the sheets stay together and in order.
    var last = -1;
    state.slots.forEach(function (candidate, i) {
      var n = candidate.tool === 'map-screen' ? mapSheetNumber(candidate.key) : null;
      if (n !== null && n < number) last = i;
    });
    state.slots.splice(last + 1, 0, slot);
    var got = autoAssignScreen(slot);
    renderMarkerEditor();
    scheduleMarkerSave();
    if (got < 4) {
      window.setTimeout(function () {
        setMarkerStatus('Only ' + got + ' free ids in ' + state.family + ' for ' + slot.label +
          ' — drawings on it are read with 4 or more. Pick a larger tag family or free some ids.', 'err');
      }, 400);
    }
  }

  function addPointerSlot() {
    var count = state.slots.filter(function (slot) { return slot.tool === 'draw'; }).length + 1;
    state.slots.push({
      key: 'extra-draw-' + Date.now().toString(36),
      group: GROUP_MULTI,
      tool: 'draw',
      label: 'Pointer ' + count,
      tagId: null,
      tagId2: null,
      selectorTagId: null,
      selectorTagId2: null,
      color: '#ff5b5b',
      offsetCm: defaultDrawOffsetCm
    });
    renderMarkerEditor();
    scheduleMarkerSave();
  }

  function buildGroup(groupName) {
    var wrap = document.createElement('div');
    wrap.className = 'marker-group';
    var title = document.createElement('h3');
    title.textContent = groupName;
    wrap.appendChild(title);

    var row = document.createElement('div');
    row.className = 'marker-card-row';
    state.slots.filter(function (slot) { return slot.group === groupName; }).forEach(function (slot) {
      row.appendChild(SCREEN_KINDS[slot.tool] ? renderScreenCard(slot) : renderMarkerCard(slot));
    });

    if (groupName === GROUP_MULTI) {
      var add = document.createElement('button');
      add.className = 'marker-add-card';
      add.type = 'button';
      add.textContent = '+';
      add.title = 'Add a pointer';
      add.addEventListener('click', addPointerSlot);
      row.appendChild(add);
    }
    if (groupName === GROUP_SCREEN) {
      var addSheet = document.createElement('button');
      addSheet.className = 'marker-add-card screen-add-card';
      addSheet.type = 'button';
      addSheet.textContent = '+';
      addSheet.setAttribute('aria-label', 'Add a map view');
      addSheet.title = 'Add a map view: another sheet with its own border tags. In the Project panel of Run a Workshop, each sheet gets a button that puts the current map view on it.';
      addSheet.addEventListener('click', addMapSheet);
      row.appendChild(addSheet);
    }
    wrap.appendChild(row);
    return wrap;
  }

  function renderMarkerEditor() {
    var pointerNumber = 0;
    state.slots.forEach(function (slot) {
      if (slot.tool === 'draw') {
        pointerNumber += 1;
        slot.label = 'Pointer ' + pointerNumber;
      }
    });
    // As marker_settings.py names them: "Map view" while there is one, else "Map view <n>".
    var sheets = mapSheets();
    sheets.forEach(function (slot) {
      slot.label = sheets.length <= 1 ? 'Map view' : 'Map view ' + mapSheetNumber(slot.key);
    });
    renderFamilyOptions();
    // A re-render must not scroll the list back to the top.
    var scrollTop = els.body.scrollTop;
    els.body.innerHTML = '';
    // The single-state pointer is picked inside the street view sheet; on its own only without one.
    var groups = hasStreetScreen() ? [GROUP_MULTI, GROUP_SCREEN] : [GROUP_MULTI, GROUP_SINGLE, GROUP_SCREEN];
    groups.forEach(function (groupName) {
      var hasSlots = state.slots.some(function (slot) { return slot.group === groupName; });
      if (!hasSlots && groupName !== GROUP_MULTI) return;
      var section = document.createElement('section');
      section.className = 'marker-section';
      section.appendChild(buildGroup(groupName));
      els.body.appendChild(section);
    });
    // The analysis tools go below, in a compact grid.
    var section = document.createElement('section');
    section.className = 'marker-section';
    var grid = document.createElement('div');
    grid.className = 'marker-bottom-grid';
    ['Shortest-path', 'Analysis'].forEach(function (groupName) {
      if (state.slots.some(function (slot) { return slot.group === groupName; })) {
        grid.appendChild(buildGroup(groupName));
      }
    });
    section.appendChild(grid);
    els.body.appendChild(section);
    els.body.scrollTop = scrollTop;
  }

  // What goes on the cut-out marker sheet. The screens' border tags are not
  // on it: they are printed in place on each screen's own PDF.
  function selectedMarkerEntries() {
    var entries = [];
    var seen = {};
    function add(slot, prop, useLabel) {
      if (slot[prop] == null) return;
      var id = Number(slot[prop]);
      if (!Number.isFinite(id) || seen[String(id)]) return;
      seen[String(id)] = true;
      entries.push({ tagId: id, label: String(useLabel || slot.label || slot.group || 'Marker') });
    }
    var pointerNumber = 0;
    state.slots.forEach(function (slot) {
      if (slot.tool === 'draw') {
        pointerNumber += 1;
        add(slot, 'tagId', 'Pointer ' + pointerNumber + ' (left)');
        add(slot, 'tagId2', 'Pointer ' + pointerNumber + ' (right)');
        add(slot, 'selectorTagId', 'Selector ' + pointerNumber + ' (left)');
        add(slot, 'selectorTagId2', 'Selector ' + pointerNumber + ' (right)');
      } else if (slot.tool === 'street-view') {
        add(slot, 'tagId', 'Street view pointer');
      } else {
        add(slot, 'tagId', '');
      }
    });
    return entries;
  }

  function downloadMarkerSheet() {
    var entries = selectedMarkerEntries();
    if (!entries.length) {
      window.alert('No marker IDs selected.');
      return;
    }
    var size = Math.max(1, Math.min(20, Number(state.tagSizeCm) || 3));
    var params = new URLSearchParams();
    params.set('family', state.family);
    params.set('sizeCm', String(size));
    params.set('entries', JSON.stringify(entries.map(function (item) {
      return { id: item.tagId, use: item.label };
    })));
    var link = document.createElement('a');
    link.href = '/api/marker-sheet.pdf?' + params.toString();
    link.download = 'markers_' + state.family + '_' +
      String(size).replace('.', '_') + 'cm.pdf';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setMarkerStatus('PDF download started', '');
    window.setTimeout(function () { setMarkerStatus('', ''); }, 1800);
  }

  els.family.addEventListener('change', function () {
    state.family = els.family.value || state.family;
    var allowed = {};
    familyIds().forEach(function (id) { allowed[String(id)] = true; });
    state.slots.forEach(function (slot) {
      TAG_PROPS.forEach(function (prop) {
        if (slot[prop] != null && !allowed[String(slot[prop])]) slot[prop] = null;
      });
      if (slot.frameTagIds) {
        slot.frameTagIds = slot.frameTagIds.map(function (id) {
          return id != null && allowed[String(id)] ? id : null;
        });
      }
    });
    renderMarkerEditor();
    scheduleMarkerSave();
  });
  els.size.addEventListener('change', function () {
    state.tagSizeCm = Math.max(1, Math.min(20, Number(els.size.value) || 3));
    els.size.value = String(state.tagSizeCm);
    scheduleMarkerSave();
  });
  els.download.addEventListener('click', downloadMarkerSheet);

  fetch('/api/marker-settings', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      applyMarkerData(data);
      renderMarkerEditor();
    })
    .catch(function () {
      applyMarkerData(window.CompactMapConfig.CONFIG.markerSettings || {});
      renderMarkerEditor();
      setMarkerStatus('Load failed', 'err');
    });
})();
