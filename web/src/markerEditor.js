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
  var saveTimer = 0;
  var defaultDrawOffsetCm = 3;

  var GROUP_MULTI = 'Multi-state pointer';
  var GROUP_SINGLE = 'Single-state pointer';
  var GROUP_SCREEN = 'Street view screen';
  var GROUP_HINTS = {};
  GROUP_HINTS[GROUP_MULTI] = 'A folding pen made of two tags. Closed it points; pinched open it acts, and its tool-selection pair switches between draw, move, erase and sticker.';
  GROUP_HINTS[GROUP_SINGLE] = 'One tag with a single job. Placed on the map it chooses where the street view looks from; turning it turns the view.';
  GROUP_HINTS[GROUP_SCREEN] = 'A printed A3 sheet with tags round its border. Laid on the table it becomes the screen the street view is shown in. Without it the view floats next to the pointer.';

  // The screen's border slots in frameTagIds order, with each one's place on
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
    var out = {
      key: String(slot.key || ''),
      group: String(slot.group || ''),
      tool: tool,
      label: String(slot.label || ''),
      tagId: toId(slot.tagId),
      tagId2: toId(slot.tagId2),
      selectorTagId: toId(slot.selectorTagId),
      selectorTagId2: toId(slot.selectorTagId2),
      color: String(slot.color || ''),
      offsetCm: tool === 'draw' ? normalizeOffsetCm(slot.offsetCm) : undefined
    };
    if (tool === 'street-screen') out.frameTagIds = cloneFrameTagIds(slot.frameTagIds);
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
  function buildTagSelect(slot, current, title, onPick) {
    var select = document.createElement('select');
    select.className = 'marker-tag-select';
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

  function buildPropSelect(slot, prop, title) {
    return buildTagSelect(slot, slot[prop], title, function (next) {
      claimTagId(slot, next, prop, -1);
      slot[prop] = next;
    });
  }

  function renderMarkerCard(slot) {
    // Multi-state pointers are the only slots that can be added or removed,
    // and they get a wider card for their two pairs of dropdowns.
    var isDraw = slot.tool === 'draw';
    var card = document.createElement('div');
    card.className = 'marker-card';

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
    }
    if (slot.tagId == null) {
      var empty = document.createElement('div');
      empty.className = 'marker-empty';
      empty.textContent = 'Empty';
      preview.appendChild(empty);
    } else {
      var img = document.createElement('img');
      img.alt = 'AprilTag ' + slot.tagId;
      img.src = markerSvgPath(slot.tagId);
      img.onerror = function () {
        preview.innerHTML = '';
        var missing = document.createElement('div');
        missing.className = 'marker-empty';
        missing.textContent = 'Missing';
        preview.appendChild(missing);
      };
      preview.appendChild(img);
    }
    card.appendChild(preview);

    var label = document.createElement('div');
    label.className = 'marker-card-label' + (isDraw ? ' draw-label' : '');
    label.textContent = slot.label || slot.tool || '';
    card.appendChild(label);
    if (isDraw) card.classList.add('wide');

    var controls = document.createElement('div');
    controls.className = 'marker-controls ' + (isDraw ? 'draw-controls' : 'no-color');
    controls.appendChild(buildPropSelect(slot, 'tagId', isDraw ? 'First tag of the pen' : 'Marker ID'));
    if (isDraw) {
      controls.appendChild(buildPropSelect(slot, 'tagId2', 'Fold-partner ID (second tag of the pen)'));

      var color = document.createElement('input');
      color.className = 'marker-color';
      color.type = 'color';
      color.value = /^#[0-9a-fA-F]{6}$/.test(slot.color || '') ? slot.color : '#ff5b5b';
      color.title = 'Tool color';
      color.addEventListener('input', function () {
        slot.color = color.value;
        scheduleMarkerSave();
      });
      controls.appendChild(color);

      var selectorWrap = document.createElement('div');
      selectorWrap.className = 'marker-tool-selector-row';
      var selectorLabel = document.createElement('div');
      selectorLabel.className = 'marker-tool-selector-label';
      selectorLabel.textContent = 'Tool selection';
      selectorWrap.appendChild(selectorLabel);
      var selectorGrid = document.createElement('div');
      selectorGrid.className = 'marker-tool-selector-grid';
      selectorGrid.appendChild(buildPropSelect(slot, 'selectorTagId', 'First tag of the tool-selection pair'));
      selectorGrid.appendChild(buildPropSelect(slot, 'selectorTagId2', 'Second tag of the tool-selection pair'));
      selectorWrap.appendChild(selectorGrid);
      controls.appendChild(selectorWrap);

      var offsetBlock = document.createElement('div');
      offsetBlock.className = 'marker-offset-block';
      var offsetLabel = document.createElement('div');
      offsetLabel.className = 'marker-offset-label';
      offsetLabel.textContent = 'Offset';
      offsetBlock.appendChild(offsetLabel);

      var offsetWrap = document.createElement('label');
      offsetWrap.className = 'marker-offset-wrap';
      offsetWrap.title = 'Distance from each tag to the pen tip, in centimeters';
      var offset = document.createElement('input');
      offset.className = 'marker-offset';
      offset.type = 'number';
      offset.min = '0';
      offset.max = '20';
      offset.step = '0.1';
      offset.inputMode = 'decimal';
      offset.value = String(normalizeOffsetCm(slot.offsetCm));
      offset.setAttribute('aria-label', 'Pen tip offset in centimeters');
      offset.addEventListener('input', function () {
        var next = Number(offset.value);
        if (!Number.isFinite(next)) return;
        slot.offsetCm = Math.max(0, Math.min(20, next));
        scheduleMarkerSave();
      });
      offset.addEventListener('change', function () {
        slot.offsetCm = normalizeOffsetCm(offset.value);
        offset.value = String(slot.offsetCm);
        scheduleMarkerSave();
      });
      var offsetUnit = document.createElement('span');
      offsetUnit.className = 'marker-offset-unit';
      offsetUnit.textContent = 'cm';
      offsetWrap.appendChild(offset);
      offsetWrap.appendChild(offsetUnit);
      offsetBlock.appendChild(offsetWrap);
      controls.appendChild(offsetBlock);
    }
    card.appendChild(controls);
    return card;
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

  function downloadScreenSheet() {
    // The server draws the PDF from the SAVED settings, so a pending save goes first.
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
    }
    saveMarkerSettings().then(function (ok) {
      if (!ok) return;
      var link = document.createElement('a');
      link.href = '/api/street-screen/frame.pdf';
      link.download = 'street-view-screen-A3.pdf';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setMarkerStatus('PDF download started', '');
      window.setTimeout(function () { setMarkerStatus('', ''); }, 1800);
    });
  }

  function renderScreenCard(slot) {
    if (!Array.isArray(slot.frameTagIds)) slot.frameTagIds = cloneFrameTagIds(null);
    var card = document.createElement('div');
    card.className = 'screen-card';

    var sheet = document.createElement('div');
    sheet.className = 'screen-sheet';
    var inside = document.createElement('div');
    inside.className = 'screen-sheet-inside';
    inside.textContent = 'Street view';
    sheet.appendChild(inside);
    SCREEN_SLOTS.forEach(function (entry, index) {
      var cell = document.createElement('div');
      cell.className = 'screen-cell';
      cell.style.left = entry.x + '%';
      cell.style.top = entry.y + '%';
      var id = slot.frameTagIds[index];
      if (id != null) {
        var img = document.createElement('img');
        img.alt = '';
        img.src = markerSvgPath(id);
        cell.appendChild(img);
      }
      cell.appendChild(buildTagSelect(slot, id, entry.name + ' tag', function (next) {
        claimTagId(slot, next, '', index);
        slot.frameTagIds[index] = next;
      }));
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

    var auto = document.createElement('button');
    auto.className = 'action';
    auto.type = 'button';
    auto.id = 'screenAutoAssign';
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
    side.appendChild(auto);

    var clear = document.createElement('button');
    clear.className = 'action ghost';
    clear.type = 'button';
    clear.textContent = 'Clear';
    clear.addEventListener('click', function () {
      slot.frameTagIds = cloneFrameTagIds(null);
      renderMarkerEditor();
      scheduleMarkerSave();
    });
    side.appendChild(clear);

    var pdf = document.createElement('button');
    pdf.className = 'action ghost';
    pdf.type = 'button';
    pdf.id = 'screenDownload';
    pdf.textContent = 'Download screen (A3 PDF)';
    pdf.title = 'The sheet to print: page 1 is the screen, page 2 the street view pointer';
    pdf.disabled = assigned < 2;
    pdf.addEventListener('click', downloadScreenSheet);
    side.appendChild(pdf);

    card.appendChild(side);
    return card;
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
    if (GROUP_HINTS[groupName]) {
      var hint = document.createElement('p');
      hint.className = 'marker-group-hint';
      hint.textContent = GROUP_HINTS[groupName];
      wrap.appendChild(hint);
    }

    var row = document.createElement('div');
    row.className = 'marker-card-row';
    state.slots.filter(function (slot) { return slot.group === groupName; }).forEach(function (slot) {
      row.appendChild(slot.tool === 'street-screen' ? renderScreenCard(slot) : renderMarkerCard(slot));
    });

    if (groupName === GROUP_MULTI) {
      var add = document.createElement('button');
      add.className = 'marker-add-card';
      add.type = 'button';
      add.textContent = '+';
      add.title = 'Add a multi-state pointer';
      add.addEventListener('click', addPointerSlot);
      row.appendChild(add);
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
    renderFamilyOptions();
    // A re-render must not scroll the list back to the top.
    var scrollTop = els.body.scrollTop;
    els.body.innerHTML = '';
    [GROUP_MULTI, GROUP_SINGLE, GROUP_SCREEN].forEach(function (groupName) {
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

  // What goes on the cut-out marker sheet. The screen's border tags are not
  // on it: they are printed in place on the screen's own PDF.
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
