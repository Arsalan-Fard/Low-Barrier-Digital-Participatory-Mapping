(function () {
  var DEFAULT_DRAW_OFFSET_CM = 3;
  var DEFAULT_SLOTS = [
    { key: 'draw-1', group: 'Drawing', tool: 'draw', label: 'Pointer', tagId: 11, tagId2: null, selectorTagId: 20, selectorTagId2: 19, color: '#ff5b5b', offsetCm: DEFAULT_DRAW_OFFSET_CM },
    { key: 'draw-2', group: 'Drawing', tool: 'draw', label: 'Drawing 2', tagId: 12, tagId2: null, selectorTagId: null, selectorTagId2: null, color: '#3b82f6', offsetCm: DEFAULT_DRAW_OFFSET_CM },
    { key: 'draw-3', group: 'Drawing', tool: 'draw', label: 'Drawing 3', tagId: 13, tagId2: null, selectorTagId: null, selectorTagId2: null, color: '#22cc66', offsetCm: DEFAULT_DRAW_OFFSET_CM },
    { key: 'draw-4', group: 'Drawing', tool: 'draw', label: 'Drawing 4', tagId: 14, tagId2: null, selectorTagId: null, selectorTagId2: null, color: '#111111', offsetCm: DEFAULT_DRAW_OFFSET_CM },
    { key: 'route-origin', group: 'Shortest-path', tool: 'route-origin', label: 'Route start', tagId: 9, color: '' },
    { key: 'route-dest', group: 'Shortest-path', tool: 'route-dest', label: 'Route end', tagId: 10, color: '' },
    { key: 'isochrone-5', group: 'Analysis', tool: 'isochrone', label: 'Isochrone 5 min', tagId: 38, color: '', minutes: 5 },
    { key: 'isochrone-15', group: 'Analysis', tool: 'isochrone', label: 'Isochrone 15 min', tagId: 37, color: '', minutes: 15 },
    { key: 'isovist-1', group: 'Analysis', tool: 'isovist', label: 'Isovist', tagId: 39, color: '' },
    // "Comment": one shared keyboard-location tag + one-or-more post-it tags.
    { key: 'comment-keyboard', group: 'Comment', tool: 'comment-keyboard', label: 'Keyboard location', tagId: 1, color: '' },
    { key: 'comment-postit-1', group: 'Comment', tool: 'comment-postit', label: 'Post-it 1', tagId: 0, color: '' }
  ];

  var FIXED_ASSIGNMENTS = {
    21: { tool: 'pan', colorName: 'white', color: '#ffffff' },
    22: { tool: 'pan', colorName: 'white', color: '#ffffff' },
    23: { tool: 'street-view', colorName: 'white', color: '#ffffff' },
    31: { tool: 'theme', colorName: 'white', color: '#ffffff' },
    32: { tool: 'theme', colorName: 'white', color: '#ffffff' },
    33: { tool: 'theme', colorName: 'white', color: '#ffffff' },
    34: { tool: 'theme', colorName: 'white', color: '#ffffff' }
  };
  var REMOVABLE_TOOLS = { draw: true, 'keyboard-annotation': true };

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
      tagId: normalizeTagId(Object.prototype.hasOwnProperty.call(src, 'tagId') ? src.tagId : base.tagId),
      color: tool === 'draw' ? normalizeColor(src.color, fallbackColor) : '',
      image: String(src.image || base.image || '')
    };
    if (tool === 'draw') {
      // Drawing pair plus the pair that selects this drawing tool's mode.
      normalized.tagId2 = normalizeTagId(Object.prototype.hasOwnProperty.call(src, 'tagId2') ? src.tagId2 : base.tagId2);
      normalized.selectorTagId = normalizeTagId(Object.prototype.hasOwnProperty.call(src, 'selectorTagId') ? src.selectorTagId : base.selectorTagId);
      normalized.selectorTagId2 = normalizeTagId(Object.prototype.hasOwnProperty.call(src, 'selectorTagId2') ? src.selectorTagId2 : base.selectorTagId2);
      normalized.offsetCm = normalizeOffsetCm(
        Object.prototype.hasOwnProperty.call(src, 'offsetCm') ? src.offsetCm : base.offsetCm,
        base.offsetCm
      );
    }
    if (Object.prototype.hasOwnProperty.call(src, 'minutes') || Object.prototype.hasOwnProperty.call(base, 'minutes')) {
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
    // Read old settings that stored one global selector as an eraser pair.
    var legacySelector = incomingByKey['eraser-1'] || null;
    if (legacySelector && incomingByKey['draw-1']
        && !Object.prototype.hasOwnProperty.call(incomingByKey['draw-1'], 'selectorTagId')) {
      incomingByKey['draw-1'] = Object.assign({}, incomingByKey['draw-1'], {
        selectorTagId: legacySelector.tagId,
        selectorTagId2: legacySelector.tagId2
      });
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
      if (tool !== 'draw' && tool !== 'comment-postit') continue;
      var isDraw = tool === 'draw';
      slots.push(normalizeSlot(slot, {
        key: key,
        group: isDraw ? 'Drawing' : 'Comment',
        tool: tool,
        label: isDraw ? 'Drawing' : 'Post-it',
        tagId: null,
        tagId2: isDraw ? null : undefined,
        selectorTagId: isDraw ? null : undefined,
        selectorTagId2: isDraw ? null : undefined,
        offsetCm: isDraw ? DEFAULT_DRAW_OFFSET_CM : undefined,
        color: isDraw ? '#ff5b5b' : ''
      }));
    }

    return {
      family: String(cfg.family || 'tag36h11'),
      tagSizeCm: Number(cfg.tagSizeCm) || 3,
      slots: slots
    };
  }

  var config = (window.CompactMapConfig && window.CompactMapConfig.CONFIG) || {};
  var markerSettings = normalizeSettings(config.markerSettings || null);

  function assignmentFromSlot(slot) {
    if (!slot || normalizeTagId(slot.tagId) === null || !slot.tool) return null;
    var color = (slot.tool === 'comment-keyboard' || slot.tool === 'comment-postit')
      ? '#082f49'
      : (slot.tool === 'draw' ? normalizeColor(slot.color, '#ff5b5b') : '');
    return {
      tagId: normalizeTagId(slot.tagId),
      tool: slot.tool,
      colorName: colorName(color),
      color: color,
      image: String(slot.image || ''),
      minutes: Number(slot.minutes) || 0
    };
  }

  function assignmentMap() {
    var out = {};
    for (var key in FIXED_ASSIGNMENTS) {
      if (!Object.prototype.hasOwnProperty.call(FIXED_ASSIGNMENTS, key)) continue;
      out[key] = {
        tagId: normalizeTagId(key),
        tool: String(FIXED_ASSIGNMENTS[key].tool || ''),
        colorName: String(FIXED_ASSIGNMENTS[key].colorName || ''),
        color: String(FIXED_ASSIGNMENTS[key].color || ''),
        image: ''
      };
    }
    markerSettings.slots.forEach(function (slot) {
      var assignment = assignmentFromSlot(slot);
      if (assignment) out[String(assignment.tagId)] = assignment;
      // For draw pairs, the fold partner maps to the same draw tool/color so both
      // physical tags render as 'draw' markers.
      if (slot.tool === 'draw') {
        var t2 = normalizeTagId(slot.tagId2);
        if (t2 !== null) {
          var c2 = normalizeColor(slot.color, '#ff5b5b');
          out[String(t2)] = { tagId: t2, tool: 'draw', colorName: colorName(c2), color: c2, image: '' };
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
    return {
      tagId: id,
      tool: String(a.tool || ''),
      colorName: String(a.colorName || ''),
      color: String(a.color || ''),
      image: String(a.image || ''),
      minutes: Number(a.minutes) || 0
    };
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

  function getToolTagMap(tool, limit) {
    var out = {};
    var slots = getSlots(tool);
    var max = Number(limit) || 0;
    for (var i = 0; i < slots.length; i++) {
      if (max && i >= max) break;
      var id = normalizeTagId(slots[i].tagId);
      if (id !== null) out[String(i + 1)] = id;
    }
    return out;
  }

  // Draw tool tag pairs (slot.tagId + slot.tagId2) for the fold-open pen.
  function getDrawPairs() {
    var pairs = [];
    markerSettings.slots.forEach(function (slot) {
      if (!slot || slot.tool !== 'draw') return;
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

  // Each selector pair controls the mode of exactly one drawing pair.
  function getToolSelectorPairs() {
    var pairs = [];
    markerSettings.slots.forEach(function (slot) {
      if (!slot || slot.tool !== 'draw') return;
      var a = normalizeTagId(slot.selectorTagId);
      var b = normalizeTagId(slot.selectorTagId2);
      var drawTagId = normalizeTagId(slot.tagId);
      if (a === null || b === null || a === b) return;
      if (drawTagId === null) return;
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

  // Comment = one shared keyboard-location tag + one-or-more post-it tags. Each
  // post-it is paired with the shared keyboard location for the map runtime.
  function getKeyboardAnnotationSlots() {
    var keyboardTagId = null;
    markerSettings.slots.forEach(function (slot) {
      if (slot && slot.tool === 'comment-keyboard') {
        var k = normalizeTagId(slot.tagId);
        if (k !== null) keyboardTagId = k;
      }
    });
    var slots = [];
    if (keyboardTagId === null) return slots;
    markerSettings.slots.forEach(function (slot) {
      if (!slot || slot.tool !== 'comment-postit') return;
      var annotationTagId = normalizeTagId(slot.tagId);
      if (annotationTagId === null || annotationTagId === keyboardTagId) return;
      slots.push({
        key: String(slot.key || ('comment-' + annotationTagId)),
        label: String(slot.label || 'Comment'),
        annotationTagId: annotationTagId,
        keyboardTagId: keyboardTagId,
        color: '#082f49'
      });
    });
    return slots;
  }

  function listAssignments() {
    var map = assignmentMap();
    var out = [];
    for (var key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      out.push(getAssignment(key));
    }
    out.sort(function (a, b) { return a.tagId - b.tagId; });
    return out;
  }

  function getMarkerSettings() {
    return normalizeSettings(markerSettings);
  }

  window.CompactTagAssignments = {
    getAssignment: getAssignment,
    getDrawColor: getDrawColor,
    getSlots: getSlots,
    getToolTagIds: getToolTagIds,
    getToolTagMap: getToolTagMap,
    getDrawPairs: getDrawPairs,
    getToolSelectorPairs: getToolSelectorPairs,
    getKeyboardAnnotationSlots: getKeyboardAnnotationSlots,
    getMarkerSettings: getMarkerSettings,
    listAssignments: listAssignments
  };
})();
