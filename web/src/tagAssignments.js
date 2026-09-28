(function () {
  var DEFAULT_DRAW_OFFSET_CM = 3;
  // The street view screen's border tags, in the same order as the marker page
  // and app.py: corners clockwise from top-left, then right, bottom, left middles.
  var SCREEN_SLOTS = ['tl', 'tr', 'br', 'bl', 'rm', 'bm', 'lm'];
  // Keep in step with MARKER_SLOT_DEFAULTS in app.py.
  var DEFAULT_SLOTS = [
    { key: 'draw-1', group: 'Multi-state pointer', tool: 'draw', label: 'Pointer 1', tagId: 11, tagId2: null, selectorTagId: 20, selectorTagId2: 19, color: '#ff5b5b', offsetCm: DEFAULT_DRAW_OFFSET_CM },
    { key: 'draw-2', group: 'Multi-state pointer', tool: 'draw', label: 'Pointer 2', tagId: 12, tagId2: null, selectorTagId: null, selectorTagId2: null, color: '#3b82f6', offsetCm: DEFAULT_DRAW_OFFSET_CM },
    { key: 'draw-3', group: 'Multi-state pointer', tool: 'draw', label: 'Pointer 3', tagId: 13, tagId2: null, selectorTagId: null, selectorTagId2: null, color: '#22cc66', offsetCm: DEFAULT_DRAW_OFFSET_CM },
    { key: 'draw-4', group: 'Multi-state pointer', tool: 'draw', label: 'Pointer 4', tagId: 14, tagId2: null, selectorTagId: null, selectorTagId2: null, color: '#111111', offsetCm: DEFAULT_DRAW_OFFSET_CM },
    { key: 'pointer-single-1', group: 'Single-state pointer', tool: 'street-view', label: 'Street view', tagId: 23, color: '' },
    { key: 'street-screen', group: 'Street view screen', tool: 'street-screen', label: 'Screen', tagId: null, frameTagIds: [2, 3, 4, 5, 6, 7, 8], color: '' },
    { key: 'route-origin', group: 'Shortest-path', tool: 'route-origin', label: 'Route start', tagId: 9, color: '' },
    { key: 'route-dest', group: 'Shortest-path', tool: 'route-dest', label: 'Route end', tagId: 10, color: '' },
    { key: 'isochrone-5', group: 'Analysis', tool: 'isochrone', label: 'Isochrone 5 min', tagId: 38, color: '', minutes: 5 },
    { key: 'isochrone-15', group: 'Analysis', tool: 'isochrone', label: 'Isochrone 15 min', tagId: 37, color: '', minutes: 15 },
    { key: 'isovist-1', group: 'Analysis', tool: 'isovist', label: 'Isovist', tagId: 39, color: '' }
  ];

  var FIXED_ASSIGNMENTS = {
    21: { tool: 'pan', colorName: 'white', color: '#ffffff' },
    22: { tool: 'pan', colorName: 'white', color: '#ffffff' }
  };
  var REMOVABLE_TOOLS = { draw: true };

  function normalizeTagId(raw) {
    var n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeColor(raw, fallback) {
    var value = String(raw || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : (fallback || '');
  }

  function normalizeOffsetCm(raw, fallback) {
    var n = Number(raw);
    if (!Number.isFinite(n)) n = Number(fallback);
    if (!Number.isFinite(n)) n = DEFAULT_DRAW_OFFSET_CM;
    return Math.max(0, Math.min(20, n));
  }

  // One entry per screen slot, null where a slot has no tag. A repeated id is
  // dropped: the camera cannot tell two slots with the same tag apart.
  function normalizeFrameTagIds(raw, fallback) {
    var src = [];
    if (Array.isArray(raw)) src = raw;
    else if (Array.isArray(fallback)) src = fallback;
    var seen = {};
    var out = [];
    for (var i = 0; i < SCREEN_SLOTS.length; i++) {
      var id = normalizeTagId(src[i]);
      if (id !== null && seen[id]) id = null;
      if (id !== null) seen[id] = true;
      out.push(id);
    }
    return out;
  }

  function colorName(color) {
    var value = normalizeColor(color, '');
    var names = {
      '#ff5b5b': 'red',
      '#ff5555': 'red',
      '#3b82f6': 'blue',
      '#7dd3fc': 'blue',
      '#22cc66': 'green',
      '#111111': 'black',
      '#ffffff': 'white',
      '#00aaff': 'blue',
      '#082f49': 'dark blue'
    };
    return names[value] || value;
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // src's value when it has the key at all (null included), else base's.
  function own(src, base, key) {
    return hasOwn(src, key) ? src[key] : base[key];
  }

  function normalizeSlot(raw, fallback) {
    var src = raw && typeof raw === 'object' ? raw : {};
    var base = fallback && typeof fallback === 'object' ? fallback : {};
    var tool = String(src.tool || base.tool || '').trim();
    var fallbackColor = tool === 'draw' ? (base.color || '#ff5b5b') : '';
    var normalized = {
      key: String(src.key || base.key || ''),
      group: String(src.group || base.group || ''),
      tool: tool,
      label: String(src.label || base.label || ''),
      tagId: normalizeTagId(own(src, base, 'tagId')),
      color: tool === 'draw' ? normalizeColor(src.color, fallbackColor) : ''
    };
    if (tool === 'draw') {
      normalized.tagId2 = normalizeTagId(own(src, base, 'tagId2'));
      normalized.selectorTagId = normalizeTagId(own(src, base, 'selectorTagId'));
      normalized.selectorTagId2 = normalizeTagId(own(src, base, 'selectorTagId2'));
      normalized.offsetCm = normalizeOffsetCm(own(src, base, 'offsetCm'), base.offsetCm);
    }
    if (tool === 'street-screen') {
      normalized.tagId = null;
      normalized.frameTagIds = normalizeFrameTagIds(src.frameTagIds, base.frameTagIds);
    }
    if (hasOwn(src, 'minutes') || hasOwn(base, 'minutes')) {
      normalized.minutes = Math.max(1, Math.min(180, Number(src.minutes || base.minutes || 15)));
    }
    return normalized;
  }

  function normalizeSettings(raw) {
    var cfg = raw && typeof raw === 'object' ? raw : {};
    var incoming = Array.isArray(cfg.slots) ? cfg.slots : [];
    var incomingByKey = {};
    for (var i = 0; i < incoming.length; i++) {
      if (!incoming[i] || typeof incoming[i] !== 'object') continue;
      incomingByKey[String(incoming[i].key || '')] = incoming[i];
    }

    var slots = [];
    for (var d = 0; d < DEFAULT_SLOTS.length; d++) {
      var defaultSlot = DEFAULT_SLOTS[d];
      if (incoming.length && !incomingByKey[defaultSlot.key] && REMOVABLE_TOOLS[defaultSlot.tool]) continue;
      slots.push(normalizeSlot(incomingByKey[defaultSlot.key], defaultSlot));
    }
    for (var j = 0; j < incoming.length; j++) {
      var slot = incoming[j];
      if (!slot || typeof slot !== 'object') continue;
      var key = String(slot.key || '');
      if (key.indexOf('extra-') !== 0) continue;
      var tool = String(slot.tool || '').trim();
      if (tool !== 'draw') continue;
      slots.push(normalizeSlot(slot, {
        key: key,
        group: 'Multi-state pointer',
        tool: tool,
        label: 'Pointer',
        tagId: null,
        tagId2: null,
        selectorTagId: null,
        selectorTagId2: null,
        offsetCm: DEFAULT_DRAW_OFFSET_CM,
        color: '#ff5b5b'
      }));
    }

    return {
      family: String(cfg.family || 'tag36h11'),
      tagSizeCm: Number(cfg.tagSizeCm) || 3,
      slots: slots
    };
  }

  var markerSettings = normalizeSettings(window.CompactMapConfig.CONFIG.markerSettings);

  function assignmentFromSlot(slot) {
    if (normalizeTagId(slot.tagId) === null || !slot.tool) return null;
    var color = slot.tool === 'draw' ? normalizeColor(slot.color, '#ff5b5b') : '';
    return {
      tagId: normalizeTagId(slot.tagId),
      tool: slot.tool,
      colorName: colorName(color),
      color: color,
      minutes: Number(slot.minutes) || 0
    };
  }

  function assignmentMap() {
    var out = {};
    Object.keys(FIXED_ASSIGNMENTS).forEach(function (key) {
      var fixed = FIXED_ASSIGNMENTS[key];
      out[key] = { tagId: Number(key), tool: fixed.tool, colorName: fixed.colorName, color: fixed.color };
    });
    markerSettings.slots.forEach(function (slot) {
      var assignment = assignmentFromSlot(slot);
      if (assignment) out[String(assignment.tagId)] = assignment;
      // The screen's border tags are claimed too, so nothing else reads them.
      if (slot.tool === 'street-screen') {
        normalizeFrameTagIds(slot.frameTagIds).forEach(function (id) {
          if (id !== null) out[String(id)] = { tagId: id, tool: 'street-screen', colorName: '', color: '' };
        });
      }
      // The pen's second tag draws in the same colour.
      if (slot.tool === 'draw') {
        var t2 = normalizeTagId(slot.tagId2);
        if (t2 !== null) {
          var c2 = normalizeColor(slot.color, '#ff5b5b');
          out[String(t2)] = { tagId: t2, tool: 'draw', colorName: colorName(c2), color: c2 };
        }
      }
    });
    return out;
  }

  function getAssignment(tagId) {
    var id = normalizeTagId(tagId);
    if (id === null) return null;
    var a = assignmentMap()[String(id)];
    if (!a) return null;
    return { tagId: id, tool: a.tool, colorName: a.colorName, color: a.color, minutes: Number(a.minutes) || 0 };
  }

  function getDrawColor(tagId) {
    var a = getAssignment(tagId);
    if (!a || a.tool !== 'draw' || !a.color) return null;
    return a.color;
  }

  function getSlots(tool) {
    var wanted = String(tool || '').trim();
    return markerSettings.slots
      .filter(function (slot) { return !wanted || slot.tool === wanted; })
      .map(function (slot) { return normalizeSlot(slot, slot); });
  }

  function getToolTagIds(tool) {
    return getSlots(tool)
      .map(function (slot) { return normalizeTagId(slot.tagId); })
      .filter(function (id) { return id !== null; });
  }

  function getDrawPairs() {
    var pairs = [];
    markerSettings.slots.forEach(function (slot) {
      if (slot.tool !== 'draw') return;
      var a = normalizeTagId(slot.tagId);
      var b = normalizeTagId(slot.tagId2);
      if (a === null || b === null || a === b) return;
      pairs.push({
        key: String(slot.key || (a + '-' + b)),
        a: a,
        b: b,
        tool: 'draw',
        color: normalizeColor(slot.color, '#ff5b5b'),
        offsetCm: normalizeOffsetCm(slot.offsetCm, DEFAULT_DRAW_OFFSET_CM)
      });
    });
    return pairs;
  }

  // Each selector pair switches the mode of its own slot's drawing pair.
  function getToolSelectorPairs() {
    var pairs = [];
    markerSettings.slots.forEach(function (slot) {
      if (slot.tool !== 'draw') return;
      var a = normalizeTagId(slot.selectorTagId);
      var b = normalizeTagId(slot.selectorTagId2);
      var drawTagId = normalizeTagId(slot.tagId);
      if (a === null || b === null || a === b || drawTagId === null) return;
      pairs.push({
        key: 'selector:' + String(slot.key || (a + '-' + b)),
        a: a,
        b: b,
        tool: 'tool-selector',
        drawTagId: drawTagId,
        label: String(slot.label || 'Drawing') + ' tools',
        offsetCm: normalizeOffsetCm(slot.offsetCm, DEFAULT_DRAW_OFFSET_CM)
      });
    });
    return pairs;
  }

  function getMarkerSettings() {
    return normalizeSettings(markerSettings);
  }

  window.CompactTagAssignments = {
    getAssignment: getAssignment,
    getDrawColor: getDrawColor,
    getToolTagIds: getToolTagIds,
    getDrawPairs: getDrawPairs,
    getToolSelectorPairs: getToolSelectorPairs,
    getMarkerSettings: getMarkerSettings
  };
})();
