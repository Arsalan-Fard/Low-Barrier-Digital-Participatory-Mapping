// Map page: the small square previews on the Project panel's basemap buttons, like the layer
// chooser of Google Maps. Raster basemaps show their own tiles around the map's centre; the
// vector "Print style" is drawn once by a small hidden map and kept as an image; an indoor plan
// is drawn from its lines; an empty sheet is its colour.
(function () {
  'use strict';

  var SHOT_SIZE = 200;
  var SHOT_TIMEOUT_MS = 12000;

  // Shown while a preview loads, or when it cannot be drawn.
  var PLACEHOLDERS = {
    paper: '<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' +
      '<rect width="100" height="100" fill="#f3efe6"/>' +
      '<path d="M-5 70 C 25 60, 45 75, 105 52" stroke="#fff" stroke-width="7" fill="none"/>' +
      '<path d="M30 -5 L 42 105" stroke="#fff" stroke-width="5" fill="none"/>' +
      '<rect x="52" y="14" width="20" height="16" fill="#e2dccd"/><rect x="10" y="20" width="14" height="22" fill="#e2dccd"/>' +
      '<rect x="62" y="74" width="24" height="16" fill="#d9ead0"/></svg>',
    floorplan: '<svg viewBox="0 0 100 100" aria-hidden="true">' +
      '<rect width="100" height="100" fill="#f8f7f2"/>' +
      '<path d="M16 16 H84 V84 H16 Z M16 48 H40 M54 48 H84 M48 16 V36 M48 60 V84" ' +
      'stroke="#202020" stroke-width="2.6" fill="none" stroke-linecap="square"/></svg>',
    raster: '<svg viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" fill="#dfe6e3"/></svg>'
  };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function viewKey(view, digits) {
    return Number(view.center[0]).toFixed(digits) + ',' + Number(view.center[1]).toFixed(digits) + '@' + Number(view.zoom).toFixed(1);
  }

  function setKey(host, key) {
    if (host.dataset.bmKey === key) return false;
    host.dataset.bmKey = key;
    return true;
  }

  function hostsFor(key) {
    return Array.prototype.filter.call(document.querySelectorAll('[data-bm-key]'), function (el) {
      return el.dataset.bmKey === key;
    });
  }

  function imageOf(url) {
    var img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.className = 'bm-shot';
    img.src = url;
    return img;
  }

  // ---------------------------------------------------------------- raster basemaps
  // The tile URL and zoom limit of a style made of one raster layer, or null.
  function rasterSource(style) {
    if (!style || typeof style !== 'object' || !style.sources || !Array.isArray(style.layers)) return null;
    var layer = null;
    for (var i = 0; i < style.layers.length; i++) {
      if (style.layers[i] && style.layers[i].type === 'raster') {
        layer = style.layers[i];
        break;
      }
    }
    var source = layer && style.sources[layer.source];
    if (!source || !Array.isArray(source.tiles) || !source.tiles.length) return null;
    return {
      url: String(source.tiles[0]),
      maxzoom: Math.min(Number(layer.maxzoom) || 19, Number(source.maxzoom) || 22)
    };
  }

  // Web Mercator pixels at a zoom of 256 px tiles.
  function worldPx(lng, lat, z) {
    var world = 256 * Math.pow(2, z);
    var s = Math.sin(clamp(lat, -85, 85) * Math.PI / 180);
    return [(lng + 180) / 360 * world, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world];
  }

  // One tile's worth of map centred on the view, a zoom level out from the table map's.
  function drawRaster(host, source, view) {
    var z = clamp(Math.round(Number(view.zoom) - 1), 1, source.maxzoom);
    if (!setKey(host, 'raster|' + source.url + '|' + viewKey(view, 5) + '|' + z)) return;
    var n = Math.pow(2, z);
    var p = worldPx(Number(view.center[0]), Number(view.center[1]), z);
    var left = p[0] - 128;
    var top = p[1] - 128;
    var mosaic = document.createElement('div');
    mosaic.className = 'bm-mosaic';
    for (var ty = Math.floor(top / 256); ty <= Math.floor((top + 255) / 256); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (var tx = Math.floor(left / 256); tx <= Math.floor((left + 255) / 256); tx++) {
        var x = ((tx % n) + n) % n;
        var img = document.createElement('img');
        img.alt = '';
        img.draggable = false;
        img.src = source.url.replace('{z}', z).replace('{x}', x).replace('{y}', ty);
        img.style.left = ((tx * 256 - left) / 256 * 100) + '%';
        img.style.top = ((ty * 256 - top) / 256 * 100) + '%';
        mosaic.appendChild(img);
      }
    }
    host.replaceChildren(mosaic);
  }

  // ---------------------------------------------------------------- vector basemaps
  // One hidden map draws them, one at a time; the newest request wins over waiting ones.
  var shot = { map: null, el: null, style: null, busy: false, current: null, next: null, last: {}, releasePending: false };

  function freeShotMap() {
    if (shot.map) {
      try { shot.map.remove(); } catch (_err) { }
    }
    if (shot.el && shot.el.parentNode) shot.el.parentNode.removeChild(shot.el);
    shot.map = null;
    shot.el = null;
    shot.style = null;
  }

  function cloneStyle(style) {
    return style && typeof style === 'object' ? JSON.parse(JSON.stringify(style)) : style;
  }

  function runShot() {
    var job = shot.next;
    shot.next = null;
    var GL = window.maplibregl || window.mapboxgl;
    if (!job || !GL) {
      if (shot.releasePending) freeShotMap();
      return;
    }
    shot.releasePending = false;
    shot.busy = true;
    shot.current = job;
    var zoom = Math.max(0, Number(job.view.zoom) - 2.4);
    var center = [Number(job.view.center[0]), Number(job.view.center[1])];
    try {
      if (!shot.map || shot.style !== job.style) {
        freeShotMap();
        shot.el = document.createElement('div');
        shot.el.setAttribute('aria-hidden', 'true');
        shot.el.setAttribute('data-page-warp-exclude', '');
        shot.el.style.cssText = 'position:fixed;left:-10000px;top:0;width:' + SHOT_SIZE + 'px;height:' + SHOT_SIZE + 'px;pointer-events:none;';
        document.body.appendChild(shot.el);
        shot.map = new GL.Map({
          container: shot.el,
          style: cloneStyle(job.style),
          center: center,
          zoom: zoom,
          interactive: false,
          attributionControl: false,
          fadeDuration: 0,
          // Keeps the last frame readable for toDataURL (MapLibre 5 and older option names).
          canvasContextAttributes: { preserveDrawingBuffer: true },
          preserveDrawingBuffer: true
        });
        // Street names as on the table map, not overlapping each other (paperMap.js).
        var shotMap = shot.map;
        shotMap.on('style.load', function () {
          if (window.CompactPaperRoadNames) window.CompactPaperRoadNames.apply(shotMap);
        });
        shot.style = job.style;
      } else {
        shot.map.jumpTo({ center: center, zoom: zoom, bearing: 0, pitch: 0 });
        shot.map.triggerRepaint();
      }
    } catch (err) {
      console.warn('[basemap previews] could not draw', job.theme, err);
      freeShotMap();
      shot.busy = false;
      shot.current = null;
      return;
    }
    var map = shot.map;
    var finished = false;
    var timer = setTimeout(finish, SHOT_TIMEOUT_MS);
    map.once('idle', finish);

    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      var url = '';
      try { url = map.getCanvas().toDataURL('image/jpeg', 0.86); } catch (_err) { }
      if (url && url.length > 2000) {
        shot.last[job.theme] = { key: job.key, url: url };
        hostsFor(job.key).forEach(function (h) { h.replaceChildren(imageOf(url)); });
      }
      shot.busy = false;
      shot.current = null;
      runShot();
    }
  }

  // Redrawn only once the view has moved about 100 m or half a zoom level: each picture loads tiles.
  function drawVector(host, theme, style, view) {
    var key = 'vector|' + theme + '|' + Number(view.center[0]).toFixed(3) + ',' + Number(view.center[1]).toFixed(3)
      + '@' + (Math.round(Number(view.zoom) * 2) / 2);
    if (!setKey(host, key)) return;
    var last = shot.last[theme];
    // Until the new picture is ready, the previous one (of a nearby view) stands in.
    if (last) host.replaceChildren(imageOf(last.url));
    else host.innerHTML = PLACEHOLDERS.paper;
    if ((last && last.key === key) || (shot.current && shot.current.key === key)) return;
    shot.next = { theme: theme, style: style, view: view, key: key };
    if (!shot.busy) runShot();
  }

  // ---------------------------------------------------------------- indoor plans
  var plans = {};   // plan id -> { svg: markup once loaded, failed }

  function eachLine(geometry, fn) {
    if (!geometry) return;
    var c = geometry.coordinates;
    switch (geometry.type) {
      case 'LineString': fn(c); break;
      case 'MultiLineString':
      case 'Polygon': c.forEach(fn); break;
      case 'MultiPolygon': c.forEach(function (poly) { poly.forEach(fn); }); break;
      case 'GeometryCollection': (geometry.geometries || []).forEach(function (g) { eachLine(g, fn); }); break;
      default: break;
    }
  }

  // The plan's lines in a 100 x 100 box, at its proportions.
  function planSvg(payload) {
    var lines = [];
    (payload && Array.isArray(payload.features) ? payload.features : []).forEach(function (f) {
      eachLine(f && f.geometry, function (line) { if (Array.isArray(line) && line.length > 1) lines.push(line); });
    });
    if (!lines.length) return '';
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var midLat = 0, count = 0;
    lines.forEach(function (line) {
      line.forEach(function (c) { midLat += Number(c[1]); count++; });
    });
    var k = Math.cos((midLat / count) * Math.PI / 180);
    lines.forEach(function (line) {
      line.forEach(function (c) {
        var x = Number(c[0]) * k;
        var y = -Number(c[1]);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      });
    });
    var span = Math.max(maxX - minX, maxY - minY) || 1;
    var scale = 88 / span;
    var ox = (100 - (maxX - minX) * scale) / 2;
    var oy = (100 - (maxY - minY) * scale) / 2;
    var d = [];
    lines.forEach(function (line) {
      var prev = '';
      line.forEach(function (c, i) {
        var pt = ((Number(c[0]) * k - minX) * scale + ox).toFixed(1) + ' ' + ((-Number(c[1]) - minY) * scale + oy).toFixed(1);
        if (pt === prev) return;
        d.push((i === 0 ? 'M' : 'L') + pt);
        prev = pt;
      });
    });
    return '<svg viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" fill="#f8f7f2"/>' +
      '<path d="' + d.join('') + '" fill="none" stroke="#202020" stroke-width="0.55" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function drawPlan(host, planId) {
    var id = String(planId || '');
    var key = 'plan|' + id;
    var entry = plans[id];
    if (!setKey(host, key) && entry && (entry.svg || entry.failed)) return;
    host.innerHTML = entry && entry.svg ? entry.svg : PLACEHOLDERS.floorplan;
    if (entry) return;
    plans[id] = entry = { svg: '', failed: false };
    fetch('/api/floorplan' + (id ? '?id=' + encodeURIComponent(id) : ''), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        entry.svg = data && data.ok && data.floorplan ? planSvg(data.floorplan) : '';
        entry.failed = !entry.svg;
        if (entry.svg) hostsFor(key).forEach(function (h) { h.innerHTML = entry.svg; });
      })
      .catch(function () { entry.failed = true; });
  }

  // ---------------------------------------------------------------- public
  // Fills `host` with a preview of the basemap `theme` around `view` ({ center: [lng, lat], zoom }).
  // opts.planId: the indoor plan; opts.color: the empty sheet's colour. Unchanged previews are left be.
  function draw(host, theme, style, view, opts) {
    opts = opts || {};
    if (!host) return;
    if (theme === 'blank') {
      setKey(host, 'blank');
      host.replaceChildren();
      host.style.background = opts.color || '#ffffff';
      return;
    }
    host.style.background = '';
    if (theme === 'floorplan') {
      drawPlan(host, opts.planId);
      return;
    }
    if (!view || !Array.isArray(view.center)) return;
    var raster = rasterSource(style);
    if (raster) {
      drawRaster(host, raster, view);
      return;
    }
    if (style) {
      drawVector(host, theme, style, view);
      return;
    }
    if (setKey(host, 'none|' + theme)) host.innerHTML = PLACEHOLDERS.raster;
  }

  window.CompactBasemapPreviews = {
    draw: draw,
    // Frees the hidden map that draws the vector previews (its pictures are kept).
    release: function () {
      shot.next = null;
      shot.releasePending = true;
      if (!shot.busy) freeShotMap();
    },
    // A plan was uploaded again under the same id: draw it afresh next time.
    forgetPlan: function (planId) { delete plans[String(planId || '')]; }
  };
})();
