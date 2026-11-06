// Saved results on the map: workshop sessions, timelines, expo sessions and GeoJSON (the Digitizer's
// sheets, uploads), drawn as lines, marks (the stickers placed), a density heatmap or hexagons, and
// comment labels. Marks and hexagons take each mark type's colour (chosen in the Project panel). Which
// results are drawn is set by the current step's data layers ('result:<kind>:<filename>', through
// mapLayers.js); how they are drawn by the project's visualization settings (the Project panel).
(function () {
  'use strict';

  var DRAWING_SOURCE = 'results-drawing-source';
  var HEAT_SOURCE = 'results-heat-source';
  var HEX_SOURCE = 'results-hex-source';
  var DOTS_SOURCE = 'results-dots-source';
  var DRAWING_LAYER = 'results-drawing-line';
  var DRAWING_POINT_LAYER = 'results-drawing-point';  // places marked with a pen on a map view sheet
  var HEAT_LAYER = 'results-heat';
  var HEX_LAYER = 'results-hex';
  var DOTS_LAYER = 'results-dots';
  // The first layer of the pen lines drawn now (drawing.js): the saved results go under them.
  var LIVE_DRAWING_LAYER = 'draw-layer';
  var DEFAULT_COLOR = '#ff5b5b';
  // marks: each mark as a dot; heatmap: the surface under them, heatStyle 'hexagon' or else density;
  // hexMetres: a hexagon's width, flat to flat; hexMix: a hexagon's colour is the average of its marks'
  // colours, weighted by how many of each, instead of the colour most of them are; stickerColors: mark
  // type -> its colour; hiddenStickerTypes: the types left out of the marks, the hexagons and the density.
  var DEFAULT_DISPLAY = {
    drawings: true, comments: false, heatmap: true, marks: true, heatStyle: 'density',
    radius: 28, intensity: 1, hexMetres: 150, hexMix: false, stickerColors: {}, hiddenStickerTypes: []
  };

  // Marks used to be drawn only under Heatmap; settings saved then (no marksApart) keep them off
  // where the heatmap was off.
  function displayWithDefaults(display) {
    var out = Object.assign({}, DEFAULT_DISPLAY, display || {});
    if (display && display.marksApart !== true && display.heatmap === false) out.marks = false;
    out.marksApart = true;
    return out;
  }

  var state = {
    entries: {},               // kind + ':' + filename -> { key, filename, kind, mode, project, data }
    order: [],                 // entry keys, in the server's order
    projects: [],              // [{ id, name, known }] from the server
    shown: [],                 // entry keys drawn on the map
    stepFilter: null,          // { project, steps: Set }: that project's results show only those steps
    display: displayWithDefaults(null),
    timelineFrame: 0,
    drawingFeatures: [],
    heatFeatures: [],
    dotFeatures: [],           // the stickers, each with its type
    stickerTypes: {},          // type -> { type, dataColor, count } among the stickers drawn
    commentSpecs: [],
    commentMarkers: []
  };
  var loading = null;
  var loaded = false;
  var styleHooked = false;
  var listeners = [];

  function getMap() { return window.CompactMapApp.getMap(); }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function displayName(filename) {
    return String(filename).replace(/^(session|timeline|expo)_/, '').replace(/\.(json|geojson)$/, '');
  }

  // ---------------------------------------------------------------- loading
  // Every result in one request, with the project each belongs to.
  function load() {
    loading = fetch('/api/results/all', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        if (!body || !body.ok) throw new Error((body && body.error) || 'results_load_failed');
        state.entries = {};
        state.order = [];
        (body.results || []).forEach(function (item) {
          var entry = toEntry(item);
          state.entries[entry.key] = entry;
          state.order.push(entry.key);
        });
        state.projects = body.projects || [];
        loaded = true;
        rebuild();
      })
      .finally(function () { loading = null; });
    return loading;
  }

  function ensureLoaded() {
    if (loaded) return Promise.resolve();
    return loading || load();
  }

  function toEntry(item) {
    var data = item.data || {};
    var mode = item.kind === 'timeline' || String(data.mode || '').toLowerCase() === 'timeline' ? 'timeline' : 'session';
    if (item.kind === 'expo') data = expoToSession(data);
    return {
      key: item.kind + ':' + item.filename, filename: item.filename, kind: item.kind,
      mode: mode, project: String(item.project || ''), data: data
    };
  }

  // Expo sessions have their own compact shape: like/dislike notes become comment points and
  // walk/bicycle/car routes become lines.
  function expoToSession(data) {
    data = data && typeof data === 'object' ? data : {};
    var notes = [];
    var lines = [];
    var NOTE_COLOR = { like: '#0fb5ba', dislike: '#e0822b' };
    var NOTE_STEP = { like: 2, dislike: 3 };
    var PATH_COLOR = { walk: '#ff5b5b', bicycle: '#16a34a', car: '#2563eb' };
    var PATH_STEP = { walk: 4, bicycle: 7, car: 8 };
    var annotations = data.annotations || {};
    ['like', 'dislike'].forEach(function (k) {
      (annotations[k] || []).forEach(function (a) {
        if (!a || !Number.isFinite(Number(a.lng)) || !Number.isFinite(Number(a.lat))) return;
        notes.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [Number(a.lng), Number(a.lat)] },
          properties: { text: String(a.text || ''), color: NOTE_COLOR[k], step: NOTE_STEP[k] }
        });
      });
    });
    var paths = data.paths || {};
    ['walk', 'bicycle', 'car'].forEach(function (m) {
      (paths[m] || []).forEach(function (coords) {
        if (!Array.isArray(coords) || coords.length < 2) return;
        lines.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { color: PATH_COLOR[m], step: PATH_STEP[m] }
        });
      });
    });
    return {
      annotations: { type: 'FeatureCollection', features: notes },
      drawings: { type: 'FeatureCollection', features: lines }
    };
  }

  // ---------------------------------------------------------------- what is drawn
  function stepOf(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function timelineInfo() {
    var max = 0;
    var any = false;
    state.shown.forEach(function (key) {
      var entry = state.entries[key];
      if (!entry || entry.mode !== 'timeline') return;
      var frames = entry.data && Array.isArray(entry.data.frames) ? entry.data.frames : [];
      if (!frames.length) return;
      any = true;
      max = Math.max(max, frames.length - 1);
    });
    return { any: any, max: max, frame: Math.min(state.timelineFrame, max) };
  }

  function sessionOf(entry) {
    if (entry.mode !== 'timeline') return entry.data;
    var frames = entry.data && Array.isArray(entry.data.frames) ? entry.data.frames : [];
    var frame = frames[Math.max(0, Math.min(frames.length - 1, state.timelineFrame))];
    return frame && frame.state ? frame.state : null;
  }

  // A mark's type, the name its colour is chosen by: the Digitizer's colour and shape ("Blue
  // triangle": one colour in two shapes is two kinds of mark), else its own name, else its tag.
  function stickerType(p) {
    if (p.name || p.label) return String(p.name || p.label);
    if (p.colorLabel) return String(p.colorLabel) + (p.shape ? ' ' + String(p.shape) : '');
    if (p.tagId != null && p.tagId !== '') return 'Tag ' + p.tagId;
    return 'Mark';
  }

  // The colour chosen for a sticker type, else the colour its stickers came with.
  function typeColor(type) {
    var picked = state.display.stickerColors && state.display.stickerColors[type];
    if (picked) return String(picked);
    var known = state.stickerTypes[type];
    return known ? known.dataColor : DEFAULT_COLOR;
  }

  // Another project's results, expo sessions, and input made outside a step (step 0) are not filtered by step.
  function stepShown(entry, step) {
    var filter = state.stepFilter;
    if (!filter || entry.kind === 'expo' || entry.project !== filter.project || step <= 0) return true;
    return filter.steps.has(step);
  }

  function collect(entry) {
    var session = sessionOf(entry);
    if (!session) return;
    var notes = session.annotations;
    if (notes && Array.isArray(notes.features)) {
      notes.features.forEach(function (f) {
        var g = f && f.geometry;
        if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates) || g.coordinates.length < 2) return;
        var p = f.properties || {};
        var step = stepOf(p.step);
        if (!stepShown(entry, step)) return;
        var lng = Number(g.coordinates[0]);
        var lat = Number(g.coordinates[1]);
        addHeatPoint(lng, lat, '');
        state.commentSpecs.push({
          lng: lng, lat: lat, text: p.text ? String(p.text) : '', step: step,
          tagId: p.tagId != null ? String(p.tagId) : '', color: p.color ? String(p.color) : '', key: entry.key
        });
      });
    }
    // Stickers feed the heatmap too; commented ones also get a label.
    var stickers = session.stickers;
    if (stickers && Array.isArray(stickers.features)) {
      stickers.features.forEach(function (f) {
        var g = f && f.geometry;
        if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates) || g.coordinates.length < 2) return;
        var p = f.properties || {};
        var step = stepOf(p.step);
        if (!stepShown(entry, step)) return;
        var lng = Number(g.coordinates[0]);
        var lat = Number(g.coordinates[1]);
        var color = p.color ? String(p.color) : DEFAULT_COLOR;
        var type = stickerType(p);
        var known = state.stickerTypes[type];
        if (!known) known = state.stickerTypes[type] = { type: type, dataColor: color, count: 0 };
        known.count += 1;
        addHeatPoint(lng, lat, type);
        state.dotFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: { type: type }
        });
        if (p.commented && p.commentText) {
          state.commentSpecs.push({
            lng: lng, lat: lat, text: String(p.commentText), step: step,
            tagId: p.tagId != null ? String(p.tagId) : '', color: color, key: entry.key
          });
        }
      });
    }
    // Newer sessions keep lines in drawing.path; older and converted ones in drawings. Points among
    // them are places marked with a pen on a map view sheet.
    var lines = (session.drawing && session.drawing.path) || session.drawings || null;
    if (!lines || !Array.isArray(lines.features)) return;
    lines.features.forEach(function (f) {
      var g = f && f.geometry;
      if (!g || (g.type !== 'LineString' && g.type !== 'Point') || !Array.isArray(g.coordinates) || g.coordinates.length < 2) return;
      if (!stepShown(entry, stepOf(f.properties && f.properties.step))) return;
      state.drawingFeatures.push(f);
    });
  }

  // type: the sticker type, or '' for a comment.
  function addHeatPoint(lng, lat, type) {
    if (!isFinite(lng) || !isFinite(lat)) return;
    state.heatFeatures.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: { weight: 1, type: type }
    });
  }

  function typeShown(type) {
    return !type || state.display.hiddenStickerTypes.indexOf(type) === -1;
  }

  function shownByType(features) {
    return features.filter(function (f) { return typeShown(f.properties.type); });
  }

  function rebuild() {
    state.timelineFrame = timelineInfo().frame;
    state.drawingFeatures = [];
    state.heatFeatures = [];
    state.dotFeatures = [];
    state.stickerTypes = {};
    state.commentSpecs = [];
    state.shown.forEach(function (key) {
      if (state.entries[key]) collect(state.entries[key]);
    });
    pushToMap();
    listeners.forEach(function (fn) { fn(); });
  }

  // ---------------------------------------------------------------- hexagon grid
  // Pointy-top hexagons on axial coordinates, in local metres about the stickers' middle: the results
  // span a few kilometres, so a flat approximation keeps every hexagon the same real size. size is
  // the circumradius; hexMetres, flat to flat, is sqrt(3) times it.
  function hexAt(x, y, size) {
    var q = (Math.sqrt(3) / 3 * x - y / 3) / size;
    var r = (2 / 3 * y) / size;
    var s = -q - r;
    var rq = Math.round(q);
    var rr = Math.round(r);
    var rs = Math.round(s);
    var dq = Math.abs(rq - q);
    var dr = Math.abs(rr - r);
    var ds = Math.abs(rs - s);
    if (dq > dr && dq > ds) rq = -rr - rs;
    else if (dr > ds) rr = -rq - rs;
    return [rq, rr];
  }

  // ---------------------------------------------------------------- mixing colours
  // Averaged in OKLab, where equal steps look equal, so red and blue meet at purple rather than a
  // muddy grey-violet. A plain average also greys out colours of different hues (their hue vectors
  // partly cancel); some chroma is put back the more the hues agree, so two hues close together
  // stay vivid and two opposite ones (red and cyan) still meet near grey.
  var colorProbe = null;

  function parseColor(value) {
    var text = String(value || '');
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
    if (!m) {
      // Any other CSS colour: a canvas reads it back as #rrggbb.
      if (!colorProbe) colorProbe = document.createElement('canvas').getContext('2d');
      colorProbe.fillStyle = '#000';
      colorProbe.fillStyle = text;
      m = /^#([0-9a-f]{6})$/i.exec(colorProbe.fillStyle);
      if (!m) return null;
    }
    var hex = m[1].length === 3 ? m[1].split('').map(function (c) { return c + c; }).join('') : m[1];
    return [0, 2, 4].map(function (i) { return parseInt(hex.slice(i, i + 2), 16) / 255; });
  }

  function toLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function fromLinear(c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

  function rgbToOklab(rgb) {
    var r = toLinear(rgb[0]);
    var g = toLinear(rgb[1]);
    var b = toLinear(rgb[2]);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    ];
  }

  function oklabToHex(lab) {
    var l = Math.pow(lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2], 3);
    var m = Math.pow(lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2], 3);
    var s = Math.pow(lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2], 3);
    var rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    ];
    return '#' + rgb.map(function (c) {
      var v = Math.round(fromLinear(Math.max(0, Math.min(1, c))) * 255);
      return (v < 16 ? '0' : '') + v.toString(16);
    }).join('');
  }

  // weights: colour -> how many; their weighted average colour as #rrggbb.
  function mixColors(weights) {
    var total = 0;
    var sum = [0, 0, 0];
    var chroma = 0;
    Object.keys(weights).forEach(function (color) {
      var rgb = parseColor(color);
      var w = Number(weights[color]);
      if (!rgb || !(w > 0)) return;
      var lab = rgbToOklab(rgb);
      total += w;
      sum[0] += w * lab[0];
      sum[1] += w * lab[1];
      sum[2] += w * lab[2];
      chroma += w * Math.hypot(lab[1], lab[2]);
    });
    if (!total) return DEFAULT_COLOR;
    var lab = [sum[0] / total, sum[1] / total, sum[2] / total];
    chroma /= total;
    var length = Math.hypot(lab[1], lab[2]);
    if (length > 1e-6 && chroma > 0) {
      // 1: one hue; 0: hues that cancel out. Squared, so only hues near each other get much back
      // (blue and yellow meet at a soft grey-blue, not a vivid sky blue).
      var agreement = Math.pow(length / chroma, 2);
      var scale = (length + (chroma - length) * agreement) / length;
      lab[1] *= scale;
      lab[2] *= scale;
    }
    return oklabToHex(lab);
  }

  // ---------------------------------------------------------------- hexagons
  // Each hexagon with marks in it takes the colour of the type most of them are -- or, mixing, the
  // average of their colours weighted by how many of each -- and is more opaque the more it holds.
  function hexFeatures() {
    var points = shownByType(state.dotFeatures);
    if (!points.length) return [];
    var lng0 = 0;
    var lat0 = 0;
    points.forEach(function (f) {
      lng0 += f.geometry.coordinates[0];
      lat0 += f.geometry.coordinates[1];
    });
    lng0 /= points.length;
    lat0 /= points.length;
    var perLat = 110540;
    var perLng = 111320 * Math.cos(lat0 * Math.PI / 180);
    var size = Math.max(10, Number(state.display.hexMetres) || DEFAULT_DISPLAY.hexMetres) / Math.sqrt(3);
    var bins = {};
    points.forEach(function (f) {
      var c = f.geometry.coordinates;
      var qr = hexAt((c[0] - lng0) * perLng, (c[1] - lat0) * perLat, size);
      var key = qr[0] + ',' + qr[1];
      var bin = bins[key] || (bins[key] = { q: qr[0], r: qr[1], total: 0, byType: {} });
      bin.total += 1;
      bin.byType[f.properties.type] = (bin.byType[f.properties.type] || 0) + 1;
    });
    var max = 1;
    var mix = !!state.display.hexMix;
    Object.keys(bins).forEach(function (key) { max = Math.max(max, bins[key].total); });
    return Object.keys(bins).map(function (key) {
      var bin = bins[key];
      var color;
      if (mix) {
        var weights = {};
        Object.keys(bin.byType).forEach(function (type) {
          var c = typeColor(type);
          weights[c] = (weights[c] || 0) + bin.byType[type];
        });
        color = mixColors(weights);
      } else {
        var top = null;
        Object.keys(bin.byType).forEach(function (type) {
          if (top === null || bin.byType[type] > bin.byType[top]) top = type;
        });
        color = typeColor(top);
      }
      var cx = size * Math.sqrt(3) * (bin.q + bin.r / 2);
      var cy = size * 1.5 * bin.r;
      var ring = [];
      for (var i = 0; i < 6; i += 1) {
        var angle = Math.PI / 180 * (60 * i - 30);
        ring.push([lng0 + (cx + size * Math.cos(angle)) / perLng, lat0 + (cy + size * Math.sin(angle)) / perLat]);
      }
      ring.push(ring[0]);
      return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { color: color, opacity: 0.3 + 0.5 * (bin.total / max) }
      };
    });
  }

  // The marks, each in its type's colour.
  function dotFeaturesColored() {
    return shownByType(state.dotFeatures).map(function (f) {
      return { type: 'Feature', geometry: f.geometry, properties: { color: typeColor(f.properties.type) } };
    });
  }

  // ---------------------------------------------------------------- the map
  function heatPaint() {
    var r = state.display.radius * 1.2;
    var i = state.display.intensity;
    return {
      radius: ['interpolate', ['linear'], ['zoom'], 10, r * 0.6, 16, r, 22, r * 2.2],
      intensity: ['interpolate', ['linear'], ['zoom'], 10, i * 0.6, 16, i, 22, i * 1.8]
    };
  }

  function ensureLayers(map) {
    var empty = { type: 'FeatureCollection', features: [] };
    [DRAWING_SOURCE, HEAT_SOURCE, HEX_SOURCE, DOTS_SOURCE].forEach(function (id) {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: empty });
    });
    // Bottom to top: hexagons, the lines, the density heatmap, the marks.
    if (!map.getLayer(HEX_LAYER)) {
      map.addLayer({
        id: HEX_LAYER, type: 'fill', source: HEX_SOURCE,
        paint: {
          'fill-color': ['coalesce', ['get', 'color'], DEFAULT_COLOR],
          'fill-opacity': ['coalesce', ['get', 'opacity'], 0.5],
          'fill-outline-color': 'rgba(255, 255, 255, 0.55)'
        }
      });
    }
    if (!map.getLayer(DRAWING_LAYER)) {
      map.addLayer({
        id: DRAWING_LAYER, type: 'line', source: DRAWING_SOURCE,
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], DEFAULT_COLOR],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 16, 3.5, 22, 7],
          'line-opacity': 0.85
        }
      });
    }
    if (!map.getLayer(DRAWING_POINT_LAYER)) {
      map.addLayer({
        id: DRAWING_POINT_LAYER, type: 'circle', source: DRAWING_SOURCE,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-color': ['coalesce', ['get', 'color'], DEFAULT_COLOR],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 5.5, 22, 10],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.2,
          'circle-opacity': 0.9
        }
      });
    }
    if (!map.getLayer(HEAT_LAYER)) {
      var paint = heatPaint();
      map.addLayer({
        id: HEAT_LAYER, type: 'heatmap', source: HEAT_SOURCE, maxzoom: 22,
        paint: {
          'heatmap-weight': ['coalesce', ['get', 'weight'], 1],
          'heatmap-intensity': paint.intensity,
          'heatmap-radius': paint.radius,
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0.00, 'rgba(16, 24, 48, 0)',
            0.20, 'rgb(147, 197, 253)',
            0.40, 'rgb(191, 219, 254)',
            0.60, 'rgb(253, 224, 71)',
            0.80, 'rgb(251, 146, 60)',
            1.00, 'rgb(217, 70, 239)'
          ],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.85, 22, 0.7]
        }
      });
    }
    if (!map.getLayer(DOTS_LAYER)) {
      map.addLayer({
        id: DOTS_LAYER, type: 'circle', source: DOTS_SOURCE,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 7, 22, 12],
          'circle-color': ['coalesce', ['get', 'color'], DEFAULT_COLOR],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.2,
          'circle-opacity': 0.95
        }
      });
    }
    // All of them under what is being drawn now, which stays visible on top.
    if (map.getLayer(LIVE_DRAWING_LAYER)) {
      [HEX_LAYER, DRAWING_LAYER, DRAWING_POINT_LAYER, HEAT_LAYER, DOTS_LAYER].forEach(function (id) {
        if (map.getLayer(id)) map.moveLayer(id, LIVE_DRAWING_LAYER);
      });
    }
  }

  // Waits for a basemap switch to finish: it replaces the style, and these layers with it.
  function pushToMap() {
    window.CompactMapApp.whenStyleReady(function () {
      var map = getMap();
      var d = state.display;
      // Nothing shown and nothing drawn yet: no layers to add.
      if (!state.shown.length && !map.getSource(DRAWING_SOURCE)) {
        clearComments();
        return;
      }
      hookStyleReloads(map);
      ensureLayers(map);
      map.getSource(DRAWING_SOURCE).setData({
        type: 'FeatureCollection', features: d.drawings ? state.drawingFeatures : []
      });
      var hexagons = d.heatStyle === 'hexagon';
      map.getSource(HEAT_SOURCE).setData({
        type: 'FeatureCollection', features: d.heatmap && !hexagons ? shownByType(state.heatFeatures) : []
      });
      map.getSource(HEX_SOURCE).setData({
        type: 'FeatureCollection', features: d.heatmap && hexagons ? hexFeatures() : []
      });
      map.getSource(DOTS_SOURCE).setData({
        type: 'FeatureCollection', features: d.marks ? dotFeaturesColored() : []
      });
      renderComments();
    });
  }

  function hookStyleReloads(map) {
    if (styleHooked) return;
    styleHooked = true;
    map.on('style.load', function () { if (state.shown.length) pushToMap(); });
  }

  function updateHeat() {
    var map = getMap();
    if (!map.getLayer(HEAT_LAYER)) return;
    var paint = heatPaint();
    map.setPaintProperty(HEAT_LAYER, 'heatmap-radius', paint.radius);
    map.setPaintProperty(HEAT_LAYER, 'heatmap-intensity', paint.intensity);
  }

  function clearComments() {
    state.commentMarkers.forEach(function (m) { m.remove(); });
    state.commentMarkers = [];
  }

  function commentColor(spec) {
    if (spec.color) return spec.color;
    if (spec.tagId && window.CompactTagAssignments) {
      var a = window.CompactTagAssignments.getAssignment(spec.tagId);
      if (a && a.color) return String(a.color);
    }
    return '#fef08a';
  }

  function commentFontSize(text) {
    var len = String(text || '').length;
    if (len <= 30) return 18;
    if (len <= 60) return 15;
    if (len <= 120) return 13;
    return 11;
  }

  function renderComments() {
    clearComments();
    if (!state.display.comments) return;
    var map = getMap();
    state.commentSpecs.forEach(function (s) {
      if (!s.text || !isFinite(s.lng) || !isFinite(s.lat)) return;
      var chip = document.createElement('div');
      chip.className = 'results-comment';
      chip.textContent = s.text;
      chip.style.color = commentColor(s);
      chip.style.fontSize = commentFontSize(s.text) + 'px';
      var entry = state.entries[s.key];
      var meta = '<div style="opacity:0.7;font-size:11px;margin-bottom:4px;color:#333;">'
        + (s.step > 0 ? 'step ' + s.step : 'outside a step')
        + (entry ? ' · ' + escapeHtml(displayName(entry.filename)) : '') + '</div>';
      var popup = new mapboxgl.Popup({ offset: 14, closeButton: true, maxWidth: '320px' })
        .setHTML('<div style="font:13px/1.4 Arial,sans-serif;max-width:300px;color:#111;">'
          + meta + '<div>' + escapeHtml(s.text) + '</div></div>');
      state.commentMarkers.push(new mapboxgl.Marker({ element: chip, anchor: 'bottom', offset: [0, -6] })
        .setLngLat([s.lng, s.lat])
        .setPopup(popup)
        .addTo(map));
    });
  }

  // The bounds of the given results' points and lines, or null.
  function boundsOf(keys) {
    var bounds = null;
    function extend(coord) {
      var lng = Number(coord && coord[0]);
      var lat = Number(coord && coord[1]);
      if (!isFinite(lng) || !isFinite(lat)) return;
      if (!bounds) bounds = new mapboxgl.LngLatBounds([lng, lat], [lng, lat]);
      else bounds.extend([lng, lat]);
    }
    keys.forEach(function (key) {
      var entry = state.entries[key];
      var session = entry && sessionOf(entry);
      if (!session) return;
      [session.annotations, session.stickers, (session.drawing && session.drawing.path) || session.drawings]
        .forEach(function (collection) {
          if (!collection || !Array.isArray(collection.features)) return;
          collection.features.forEach(function (f) {
            var g = f && f.geometry;
            if (!g || !Array.isArray(g.coordinates)) return;
            if (g.type === 'Point') extend(g.coordinates);
            else if (g.type === 'LineString') g.coordinates.forEach(extend);
          });
        });
    });
    return bounds;
  }

  window.CompactResultsLayer = {
    load: load,
    ensureLoaded: ensureLoaded,
    entry: function (key) { return state.entries[key] || null; },
    order: function () { return state.order.slice(); },
    projects: function () { return state.projects.slice(); },
    displayName: displayName,
    // keys: entry keys ('<kind>:<filename>') to draw; unknown ones wait for the next load.
    setShown: function (keys) {
      state.shown = Array.isArray(keys) ? keys.slice() : [];
      if (state.shown.length && !loaded) ensureLoaded().catch(function () { });
      rebuild();
    },
    // steps (an array of step numbers) for that project's results; null shows every step.
    setStepFilter: function (projectId, steps) {
      state.stepFilter = projectId && steps ? { project: String(projectId), steps: new Set(steps.map(Number)) } : null;
      rebuild();
    },
    getDisplay: function () { return Object.assign({}, state.display); },
    // A project's visualization settings; missing ones fall back to the defaults.
    setDisplay: function (display) {
      var before = state.display;
      state.display = displayWithDefaults(display);
      state.display.stickerColors = Object.assign({}, (display && display.stickerColors) || {});
      state.display.hiddenStickerTypes = ((display && display.hiddenStickerTypes) || []).slice();
      if (before.radius !== state.display.radius || before.intensity !== state.display.intensity) updateHeat();
      pushToMap();
    },
    mixColors: mixColors,
    // The mark types among the results drawn: [{ type, shown, color, dataColor, count }], by name.
    stickerTypes: function () {
      return Object.keys(state.stickerTypes).sort(function (a, b) { return a.localeCompare(b); })
        .map(function (type) {
          var known = state.stickerTypes[type];
          return {
            type: type, shown: typeShown(type), color: typeColor(type),
            dataColor: known.dataColor, count: known.count
          };
        });
    },
    timeline: timelineInfo,
    setTimelineFrame: function (frame) {
      state.timelineFrame = Math.max(0, Number(frame) || 0);
      rebuild();
    },
    fitTo: function (keys) {
      var bounds = boundsOf(keys);
      if (bounds) getMap().fitBounds(bounds, { padding: 60, duration: 600, maxZoom: 17 });
      return !!bounds;
    },
    // fn runs after every redraw (the panel keeps its timeline slider in step).
    onChange: function (fn) { listeners.push(fn); }
  };
})();
