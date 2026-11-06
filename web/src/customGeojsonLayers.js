// Facilitator-uploaded GeoJSON layers (/api/custom-layers): uMap and SimpleStyle styling,
// labels, popups, per-category filters and hover/selection highlights.
//
// A layer can also be coloured by a value: every feature is a cell (a grid square, a block, a
// street...) and the value is a property of it, named in the collection's properties._compact_values:
//   { "title": "...", "variables": [
//       { "key": "trees", "label": "Trees within 200 m", "unit": "trees per hectare",
//         "palette": "greens", "min": 0, "max": 14, "hideAtOrBelow": 0 } ] }
// The first variable colours the layer; any others only show in its popup. A variable can also be
// { "key": "score", "palette": "diverging", "mid": 0, "breaks": [-2, -1, 1, 2] } or
// { "key": "land_use", "type": "category", "colors": { "park": "#4caf50" } }.
// null or a missing value = no data (not coloured); min/max default to the data's 1st-99th percentile.
// With "countStickers": true, a layer of areas is coloured by the stickers placed on the table instead:
// counted inside each cell, or within "countRadius" metres of the cell's centre.
// One opacity, from the Project panel, applies to every layer coloured by a value.
(function () {
  var PALETTE = ['#f59e0b', '#10b981', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#f43f5e'];
  // Colour ramps for values, low to high. A header can also give its own list of colours.
  var VALUE_PALETTES = {
    heat: ['#ffffb2', '#fed976', '#feb24c', '#fd8d3c', '#f03b20', '#bd0026'],
    spectral: ['#3288bd', '#66c2a5', '#abdda4', '#e6f598', '#fee08b', '#fdae61', '#f46d43', '#d53e4f'],
    viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
    magma: ['#000004', '#51127c', '#b73779', '#fc8961', '#fcfdbf'],
    greens: ['#ffffcc', '#c2e699', '#78c679', '#31a354', '#006837'],
    blues: ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c'],
    // Starts at a visible lavender: sticker counts hide zero, so 1 must still show.
    purples: ['#dadaeb', '#bcbddc', '#9e9ac8', '#807dba', '#6a51a3', '#4a1486'],
    diverging: ['#2166ac', '#67a9cf', '#d1e5f0', '#f7f7f7', '#fddbc7', '#ef8a62', '#b2182b']
  };
  var CATEGORY_PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b',
    '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];
  var DEFAULT_VALUE_OPACITY = 0.6;
  var LIVE_KEY = '__cw_live_stickers';
  var UMAP_ICON_ORIGIN = 'https://umap.openstreetmap.fr';
  var POPUP_STYLE_ID = 'compact-custom-geo-popup-styles';

  function ensurePopupStyles() {
    if (document.getElementById(POPUP_STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = POPUP_STYLE_ID;
    style.textContent =
      '.compact-data-popup .maplibregl-popup-content{' +
        'padding:16px 54px 16px 16px;border-radius:12px;' +
        'box-shadow:0 14px 36px rgba(15,23,42,.24)' +
      '}' +
      '.compact-data-popup .maplibregl-popup-close-button{' +
        'display:grid;place-items:center;width:40px;height:40px;' +
        'top:7px;right:7px;padding:0;border:1px solid #cbd5e1;' +
        'border-radius:999px;background:#fff;color:#334155;' +
        'box-shadow:0 2px 7px rgba(15,23,42,.16);cursor:pointer;' +
        'font:400 28px/1 Arial,sans-serif;z-index:2;transition:' +
        'background .14s ease,color .14s ease,transform .14s ease' +
      '}' +
      '.compact-data-popup .maplibregl-popup-close-button:hover{' +
        'background:#f1f5f9;color:#0f172a;transform:scale(1.04)' +
      '}' +
      '.compact-data-popup .maplibregl-popup-close-button:focus-visible{' +
        'outline:3px solid rgba(20,184,166,.42);outline-offset:2px' +
      '}';
    document.head.appendChild(style);
  }

  function createCustomGeojsonLayers(options) {
    var map = options.map;
    var registry = []; // [{ id, name }] from the server
    var dataById = {}; // id -> prepared FeatureCollection
    var visibleById = {};
    var loadCallbacksById = {}; // id -> callbacks waiting for the fetch
    var metaById = {}; // id -> { categories, icons }
    var categoryStateById = {}; // id -> { category: shown }
    var interactionHandlersById = {};
    var iconLoading = {};
    var hoveredFeature = null; // { layerId, featureId }
    var selectedFeature = null; // { layerId, featureId }
    var activePopup = null;
    var valueOpacity = null; // the Project panel's opacity for every value layer; null = each layer's own
    var legendEl = null;
    var tooltipEl = null;
    var livePoints = []; // [{ lng, lat }] stickers on the table, counted into value layers' cells
    var liveSignature = '';
    var cellsById = {}; // id -> the layer's areas, prepared for counting points

    function hashString(value) {
      var text = String(value || '');
      var hash = 2166136261;
      for (var i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    }

    function colorFor(id) {
      var text = String(id || '');
      var hash = 0;
      for (var i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
      return PALETTE[Math.abs(hash) % PALETTE.length];
    }

    function srcId(id) {
      return 'custom-geo-src-' + hashString(id);
    }

    function layerIdsFor(id) {
      var key = hashString(id);
      return {
        fill: 'custom-geo-fill-' + key,
        casing: 'custom-geo-casing-' + key,
        line: 'custom-geo-line-' + key,
        point: 'custom-geo-point-' + key,
        icon: 'custom-geo-icon-' + key,
        labelPoint: 'custom-geo-label-point-' + key,
        labelLine: 'custom-geo-label-line-' + key,
        labelArea: 'custom-geo-label-area-' + key
      };
    }

    function allLayerIds(id) {
      var ids = layerIdsFor(id);
      return Object.keys(ids).map(function (kind) { return ids[kind]; });
    }

    // The first value that is a number, clamped to [min, max].
    function firstClamped(min, max, fallback, values) {
      for (var i = 0; i < values.length; i++) {
        var n = Number(values[i]);
        if (isFinite(n)) return Math.max(min, Math.min(max, n));
      }
      return fallback;
    }

    function textValue(value) {
      if (value == null) return '';
      return String(value).trim();
    }

    function firstValue() {
      for (var i = 0; i < arguments.length; i++) {
        var value = textValue(arguments[i]);
        if (value) return value;
      }
      return '';
    }

    function validCssColor(value, fallback) {
      value = textValue(value);
      if (!value) return fallback;
      var probe = document.createElement('span');
      probe.style.color = value;
      return probe.style.color ? value : fallback;
    }

    function humanize(value) {
      value = textValue(value).replace(/[_-]+/g, ' ');
      if (!value) return 'Other';
      return value.charAt(0).toUpperCase() + value.slice(1);
    }

    function umapOptions(properties) {
      var value = properties._umap_options;
      if (value && typeof value === 'object') return value;
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
          if (value && typeof value === 'object') return value;
        } catch (_error) {}
      }
      return {};
    }

    function categoryFor(properties) {
      return firstValue(
        properties.type,
        properties.amenity,
        properties.shop,
        properties.sport,
        properties.tourism,
        properties.highway,
        properties.indoor ? 'indoor' : '',
        'Other'
      );
    }

    function markerRadius(properties, opts) {
      var size = firstValue(properties['marker-size'], opts.iconClass).toLowerCase();
      if (size === 'small') return 4.5;
      if (size === 'large') return 8;
      return 6;
    }

    function iconSize(properties) {
      var size = firstValue(properties['marker-size']).toLowerCase();
      if (size === 'large') return 1.25;
      if (size === 'small') return 0.75;
      return 1;
    }

    function resolveIconUrl(value) {
      value = textValue(value);
      if (!value) return '';
      if (/^data:image\//i.test(value) || /^https?:\/\//i.test(value)) return value;
      if (/^\/\//.test(value)) return 'https:' + value;
      if (/^\/uploads\//i.test(value)) return UMAP_ICON_ORIGIN + value;
      return '';
    }

    // ---------- Values ----------

    function finiteOrNull(value) {
      if (value == null || value === '') return null;
      var n = Number(value);
      return isFinite(n) ? n : null;
    }

    function formatValue(value) {
      var n = Number(value);
      if (!isFinite(n)) return '';
      var size = Math.abs(n);
      if (size >= 1000) return Math.round(n).toLocaleString('en-US');
      return String(parseFloat(n.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)));
    }

    function quantile(sorted, q) {
      if (!sorted.length) return null;
      var position = (sorted.length - 1) * q;
      var low = Math.floor(position);
      var high = Math.ceil(position);
      return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
    }

    function paletteColours(spec, fallbackName) {
      if (Array.isArray(spec)) {
        var colours = spec.map(function (c) { return validCssColor(c, ''); }).filter(Boolean);
        if (colours.length >= 2) return colours;
      }
      var named = VALUE_PALETTES[textValue(spec).toLowerCase()];
      return (named || VALUE_PALETTES[fallbackName]).slice();
    }

    function hexToRgb(colour) {
      var match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(textValue(colour));
      if (!match) return null;
      var hex = match[1].length === 3 ? match[1].replace(/./g, '$&$&') : match[1];
      return [0, 2, 4].map(function (i) { return parseInt(hex.slice(i, i + 2), 16); });
    }

    // The ramp's colour at t (0..1); colours that are not hex are not blended.
    function sampleColours(colours, t) {
      var position = Math.max(0, Math.min(1, t)) * (colours.length - 1);
      var low = Math.floor(position);
      var high = Math.min(colours.length - 1, low + 1);
      var a = hexToRgb(colours[low]);
      var b = hexToRgb(colours[high]);
      if (!a || !b) return colours[Math.round(position)];
      var f = position - low;
      return 'rgb(' + a.map(function (v, i) { return Math.round(v + (b[i] - v) * f); }).join(',') + ')';
    }

    // The values the header (properties._compact_values) names; none without a header.
    function readValues(payload, features) {
      var header = payload && payload.properties && payload.properties._compact_values;
      header = header && typeof header === 'object' ? header : null;
      var numbers = {};
      var texts = {};
      features.forEach(function (feature) {
        var properties = feature && feature.properties;
        if (!properties || typeof properties !== 'object') return;
        Object.keys(properties).forEach(function (key) {
          var value = properties[key];
          if (value == null || value === '') return;
          if (typeof value === 'number' && isFinite(value)) (numbers[key] = numbers[key] || []).push(value);
          else (texts[key] = texts[key] || []).push(String(value));
        });
      });

      var definitions = header && Array.isArray(header.variables)
        ? header.variables.filter(function (d) { return d && textValue(d.key); })
        : [];

      var variables = definitions.map(function (d) {
        var key = textValue(d.key);
        var variable = { key: key, label: textValue(d.label) || humanize(key), unit: textValue(d.unit) };
        if (textValue(d.type).toLowerCase() === 'category') {
          var colours = d.colors && typeof d.colors === 'object' ? d.colors : {};
          var seen = {};
          variable.type = 'category';
          variable.categories = [];
          (texts[key] || []).concat((numbers[key] || []).map(String)).forEach(function (value) {
            if (seen[value]) return;
            seen[value] = true;
            variable.categories.push({
              value: value,
              color: validCssColor(colours[value], CATEGORY_PALETTE[variable.categories.length % CATEGORY_PALETTE.length])
            });
          });
          return variable;
        }
        var sorted = (numbers[key] || []).slice().sort(function (a, b) { return a - b; });
        var many = sorted.length >= 100;
        var min = finiteOrNull(d.min);
        var max = finiteOrNull(d.max);
        if (min == null) min = many ? quantile(sorted, 0.01) : (sorted.length ? sorted[0] : 0);
        if (max == null) max = many ? quantile(sorted, 0.99) : (sorted.length ? sorted[sorted.length - 1] : 1);
        if (!(max > min)) max = min + 1;
        var mid = finiteOrNull(d.mid);
        variable.type = 'number';
        variable.min = min;
        variable.max = max;
        variable.mid = mid != null && mid > min && mid < max ? mid : null;
        variable.hide = finiteOrNull(d.hideAtOrBelow);
        variable.colours = paletteColours(d.palette, variable.mid != null ? 'diverging' : 'heat');
        var breaks = Array.isArray(d.breaks) ? d.breaks.map(finiteOrNull).filter(function (b) { return b != null; }) : [];
        breaks.sort(function (a, b) { return a - b; });
        breaks = breaks.filter(function (b, i) { return i === 0 || b > breaks[i - 1]; });
        if (breaks.length) {
          variable.breaks = breaks;
          variable.classColours = breaks.concat([null]).map(function (_b, i) {
            return sampleColours(variable.colours, breaks.length ? i / breaks.length : 0);
          });
        }
        return variable;
      });
      return {
        title: header ? textValue(header.title) : '',
        opacity: header ? finiteOrNull(header.opacity) : null,
        countStickers: !!(header && header.countStickers === true),
        countRadius: header ? finiteOrNull(header.countRadius) : null,
        variables: variables,
        live: null // the stickers-on-the-table value, added for layers with areas
      };
    }

    function liveVariable(values) {
      var radius = values.countRadius > 0 ? values.countRadius : 0;
      return {
        key: LIVE_KEY, type: 'number', label: 'Stickers placed on the table',
        unit: radius ? 'stickers within ' + formatValue(radius) + ' m' : 'stickers in the area',
        min: 0, max: 1, mid: null, hide: 0, colours: VALUE_PALETTES.purples.slice()
      };
    }

    // The layer's areas, for counting points: [{ properties, bbox, polygons, centre }].
    function cellsFor(id) {
      if (cellsById[id]) return cellsById[id];
      var cells = [];
      (dataById[id] ? dataById[id].features : []).forEach(function (feature) {
        var geometry = feature.geometry;
        if (!geometry || !feature.properties.__cw_area) return;
        var polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
          : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
        var bbox = [Infinity, Infinity, -Infinity, -Infinity];
        polygons.forEach(function (polygon) {
          (polygon[0] || []).forEach(function (point) {
            bbox[0] = Math.min(bbox[0], point[0]);
            bbox[1] = Math.min(bbox[1], point[1]);
            bbox[2] = Math.max(bbox[2], point[0]);
            bbox[3] = Math.max(bbox[3], point[1]);
          });
        });
        if (!isFinite(bbox[0])) return;
        cells.push({
          properties: feature.properties, bbox: bbox, polygons: polygons,
          centre: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
        });
      });
      cellsById[id] = cells;
      return cells;
    }

    function inRing(x, y, ring) {
      var inside = false;
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }

    function inCell(point, cell) {
      if (point.lng < cell.bbox[0] || point.lng > cell.bbox[2] || point.lat < cell.bbox[1] || point.lat > cell.bbox[3]) return false;
      return cell.polygons.some(function (polygon) {
        if (!polygon.length || !inRing(point.lng, point.lat, polygon[0])) return false;
        for (var hole = 1; hole < polygon.length; hole++) {
          if (inRing(point.lng, point.lat, polygon[hole])) return false;
        }
        return true;
      });
    }

    function metresBetween(point, lngLat) {
      var dx = (point.lng - lngLat[0]) * 111320 * Math.cos(lngLat[1] * Math.PI / 180);
      var dy = (point.lat - lngLat[1]) * 110574;
      return Math.sqrt(dx * dx + dy * dy);
    }

    // Writes the live sticker count into each cell's properties; false if the layer has none.
    function countLivePoints(id) {
      var values = metaById[id] && metaById[id].values;
      if (!values || !values.live) return false;
      var radius = values.countRadius > 0 ? values.countRadius : 0;
      var most = 0;
      cellsFor(id).forEach(function (cell) {
        var count = 0;
        livePoints.forEach(function (point) {
          if (radius ? metresBetween(point, cell.centre) <= radius : inCell(point, cell)) count++;
        });
        cell.properties[LIVE_KEY] = count;
        most = Math.max(most, count);
      });
      // The scale follows the busiest cell, so a few stickers already show.
      values.live.max = Math.max(1, most);
      return true;
    }

    // [[value, colour], ...] for an interpolated ramp, the middle colour at `mid` if there is one.
    function rampStops(variable) {
      var colours = variable.colours;
      var last = colours.length - 1;
      var centre = last / 2;
      return colours.map(function (colour, i) {
        var value;
        if (variable.mid != null && last >= 2) {
          value = i <= centre
            ? variable.min + (variable.mid - variable.min) * (i / centre)
            : variable.mid + (variable.max - variable.mid) * ((i - centre) / (last - centre));
        } else {
          value = variable.min + (variable.max - variable.min) * (i / last);
        }
        return [value, colour];
      });
    }

    function colourExpression(variable) {
      var value = ['get', variable.key];
      if (variable.type === 'category') {
        if (!variable.categories.length) return 'rgba(0,0,0,0)';
        var match = ['match', ['to-string', value]];
        variable.categories.forEach(function (c) { match.push(c.value, c.color); });
        match.push('rgba(0,0,0,0)');
        return match;
      }
      if (variable.breaks) {
        var step = ['step', ['to-number', value, 0], variable.classColours[0]];
        variable.breaks.forEach(function (b, i) { step.push(b, variable.classColours[i + 1]); });
        return step;
      }
      var ramp = ['interpolate', ['linear'], ['to-number', value, 0]];
      rampStops(variable).forEach(function (stop) { ramp.push(stop[0], stop[1]); });
      return ramp;
    }

    // True where the feature gets a colour: it has a value, above hideAtOrBelow.
    function colouredExpression(variable) {
      var value = ['get', variable.key];
      if (variable.type === 'category') {
        if (!variable.categories.length) return false;
        return ['match', ['to-string', value], variable.categories.map(function (c) { return c.value; }), true, false];
      }
      var hasNumber = ['==', ['typeof', value], 'number'];
      if (variable.hide == null) return hasNumber;
      return ['all', hasNumber, ['>', ['to-number', value, 0], variable.hide]];
    }

    // How a layer is coloured: { variable (its first value, or null for its own colours), opacity }.
    function activeColour(id) {
      var values = metaById[id] && metaById[id].values;
      var variable = values && values.variables.length ? values.variables[0] : null;
      var opacity = valueOpacity;
      if (opacity == null) opacity = values && values.opacity != null ? values.opacity : DEFAULT_VALUE_OPACITY;
      return { variable: variable, opacity: Math.max(0, Math.min(1, opacity)) };
    }

    // Paint properties per layer kind, for the layer's own colours or for a value.
    function paintFor(id) {
      var selected = selectedStateExpression();
      var hover = hoverStateExpression();
      var colour = activeColour(id);
      var variable = colour.variable;
      if (!variable) {
        return {
          fill: {
            'fill-color': ['get', '__cw_fill'],
            'fill-opacity': ['case', selected, ['min', 1, ['+', ['get', '__cw_fill_opacity'], 0.38]],
              hover, ['min', 1, ['+', ['get', '__cw_fill_opacity'], 0.2]], ['get', '__cw_fill_opacity']]
          },
          line: {
            'line-color': ['get', '__cw_stroke'],
            'line-opacity': ['get', '__cw_line_opacity'],
            'line-width': ['case', selected, ['+', ['get', '__cw_line_width'], 3],
              hover, ['+', ['get', '__cw_line_width'], 1.5], ['get', '__cw_line_width']]
          },
          point: {
            'circle-radius': ['case', selected, ['+', ['get', '__cw_point_radius'], 4],
              hover, ['+', ['get', '__cw_point_radius'], 2], ['get', '__cw_point_radius']],
            'circle-color': ['get', '__cw_color'],
            'circle-opacity': ['get', '__cw_point_opacity'],
            'circle-stroke-color': ['case', selected, '#ffffff', hover, '#fff7d6', '#ffffff'],
            'circle-stroke-width': ['case', selected, 3, hover, 2.25, 1.5]
          },
          icon: { 'icon-opacity': ['get', '__cw_point_opacity'] },
          casing: { 'line-opacity': 0 }
        };
      }
      var fillColour = colourExpression(variable);
      var coloured = colouredExpression(variable);
      var opacity = colour.opacity;
      var isArea = ['to-boolean', ['get', '__cw_area']];
      // Areas get only a hover/selection outline; lines take the value's colour.
      var lineWidth = ['case', isArea, 1, ['max', ['get', '__cw_line_width'], 3]];
      return {
        fill: {
          'fill-color': fillColour,
          'fill-opacity': ['case', coloured,
            ['case', selected, Math.min(1, opacity + 0.35), hover, Math.min(1, opacity + 0.2), opacity], 0]
        },
        line: {
          'line-color': ['case', isArea, '#ffffff', fillColour],
          'line-opacity': ['case', isArea, ['case', selected, 1, hover, 0.9, 0], coloured, Math.max(opacity, 0.85), 0],
          'line-width': ['case', selected, ['+', lineWidth, 2], hover, ['+', lineWidth, 1], lineWidth]
        },
        point: {
          'circle-radius': ['case', selected, ['+', ['get', '__cw_point_radius'], 4],
            hover, ['+', ['get', '__cw_point_radius'], 2], ['get', '__cw_point_radius']],
          'circle-color': fillColour,
          'circle-opacity': ['case', coloured, Math.max(opacity, 0.85), 0],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': ['case', coloured, ['case', selected, 3, hover, 2.25, 1], 0]
        },
        icon: { 'icon-opacity': 0 },
        // A dark edge under coloured lines, so light colours still read on light or yellow roads.
        casing: {
          'line-color': '#1f2937',
          'line-opacity': ['case', coloured, 0.6, 0],
          'line-width': ['+', ['case', selected, ['+', lineWidth, 2], hover, ['+', lineWidth, 1], lineWidth], 2.5]
        }
      };
    }

    function applyPaint(id) {
      var ids = layerIdsFor(id);
      var paint = paintFor(id);
      Object.keys(paint).forEach(function (kind) {
        if (!map.getLayer(ids[kind])) return;
        Object.keys(paint[kind]).forEach(function (property) {
          map.setPaintProperty(ids[kind], property, paint[kind][property]);
        });
      });
    }

    // The value of the hovered feature, near the pointer.
    function showTooltip(id, feature, point) {
      var variable = activeColour(id).variable;
      if (!variable) {
        hideTooltip();
        return;
      }
      if (!tooltipEl) {
        tooltipEl = document.createElement('div');
        Object.assign(tooltipEl.style, {
          position: 'absolute', zIndex: '5', pointerEvents: 'none', whiteSpace: 'nowrap',
          padding: '5px 9px', borderRadius: '7px', background: 'rgba(17,24,39,0.88)', color: '#fff',
          font: '600 13px/1.3 system-ui, sans-serif', boxShadow: '0 4px 14px rgba(0,0,0,0.25)'
        });
        map.getContainer().appendChild(tooltipEl);
      }
      tooltipEl.textContent = valueText(variable, feature.properties && feature.properties[variable.key]);
      tooltipEl.style.left = Math.round(point.x + 14) + 'px';
      tooltipEl.style.top = Math.round(point.y + 14) + 'px';
      tooltipEl.style.display = 'block';
    }

    function hideTooltip() {
      if (tooltipEl) tooltipEl.style.display = 'none';
    }

    function valueText(variable, raw) {
      if (raw == null || raw === '') return 'No data';
      if (variable.type === 'category') return String(raw);
      var n = finiteOrNull(raw);
      if (n == null) return String(raw);
      return formatValue(n) + (variable.unit ? ' ' + variable.unit : '');
    }

    function legendBlock(id, variable) {
      var block = document.createElement('div');
      Object.assign(block.style, { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: '0' });
      var title = document.createElement('div');
      title.textContent = variable.label;
      Object.assign(title.style, { font: '700 14px/1.25 system-ui, sans-serif' });
      block.appendChild(title);
      var opacity = Math.max(0.55, activeColour(id).opacity);

      function swatchRow(colour, text) {
        var row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '7px', font: '500 12px system-ui, sans-serif' });
        var swatch = document.createElement('span');
        Object.assign(swatch.style, { width: '14px', height: '14px', flex: '0 0 auto', borderRadius: '3px', background: colour, opacity: String(opacity) });
        var label = document.createElement('span');
        label.textContent = text;
        row.appendChild(swatch);
        row.appendChild(label);
        return row;
      }

      if (variable.type === 'category') {
        variable.categories.slice(0, 12).forEach(function (c) { block.appendChild(swatchRow(c.color, c.value)); });
        if (variable.categories.length > 12) block.appendChild(swatchRow('transparent', '+' + (variable.categories.length - 12) + ' more'));
      } else if (variable.breaks) {
        var b = variable.breaks;
        variable.classColours.forEach(function (colour, i) {
          var text = i === 0 ? 'below ' + formatValue(b[0])
            : i === b.length ? formatValue(b[b.length - 1]) + ' and above'
              : formatValue(b[i - 1]) + ' to ' + formatValue(b[i]);
          block.appendChild(swatchRow(colour, text));
        });
      } else {
        var span = variable.max - variable.min;
        var stops = rampStops(variable).map(function (stop) {
          return stop[1] + ' ' + ((stop[0] - variable.min) / span * 100).toFixed(1) + '%';
        });
        var bar = document.createElement('div');
        Object.assign(bar.style, {
          height: '12px', borderRadius: '3px', opacity: String(opacity),
          background: 'linear-gradient(to right, ' + stops.join(', ') + ')'
        });
        block.appendChild(bar);
        var scale = document.createElement('div');
        Object.assign(scale.style, { position: 'relative', height: '15px', font: '500 12px system-ui, sans-serif' });
        var ticks = [[variable.min, 0, 'left'], [variable.max, 100, 'right']];
        if (variable.mid != null) ticks.push([variable.mid, (variable.mid - variable.min) / span * 100, 'center']);
        ticks.forEach(function (tick) {
          var label = document.createElement('span');
          label.textContent = formatValue(tick[0]);
          Object.assign(label.style, { position: 'absolute', top: '0', whiteSpace: 'nowrap' });
          if (tick[2] === 'left') label.style.left = '0';
          else if (tick[2] === 'right') label.style.right = '0';
          else Object.assign(label.style, { left: tick[1] + '%', transform: 'translateX(-50%)' });
          scale.appendChild(label);
        });
        block.appendChild(scale);
      }
      if (variable.unit) {
        var unit = document.createElement('div');
        unit.textContent = variable.unit;
        Object.assign(unit.style, { font: '500 12px/1.3 system-ui, sans-serif', color: '#4b5563' });
        block.appendChild(unit);
      }
      return block;
    }

    // One legend entry per shown layer that is coloured by a value.
    function renderLegend() {
      var shown = Object.keys(visibleById).filter(function (id) {
        return visibleById[id] && dataById[id] && activeColour(id).variable;
      });
      if (!shown.length) {
        if (legendEl) legendEl.style.display = 'none';
        return;
      }
      if (!legendEl) {
        legendEl = document.createElement('div');
        legendEl.className = 'compact-value-legend';
        Object.assign(legendEl.style, {
          // Bottom-right, above the map credits: the Project panel covers the left side.
          position: 'absolute', right: '12px', bottom: '48px', zIndex: '4', pointerEvents: 'none',
          display: 'flex', flexDirection: 'column', gap: '12px',
          width: '260px', maxWidth: 'calc(100% - 24px)', padding: '11px 13px', borderRadius: '10px',
          background: 'rgba(255,255,255,0.92)', color: '#111827', boxShadow: '0 6px 20px rgba(15,23,42,0.22)'
        });
        map.getContainer().appendChild(legendEl);
      }
      legendEl.innerHTML = '';
      shown.forEach(function (id) { legendEl.appendChild(legendBlock(id, activeColour(id).variable)); });
      legendEl.style.display = 'flex';
    }

    // The uMap layers an export was made from, as the server records them; null unless
    // their counts add up to exactly the features in this export.
    function compactLayerManifest(payload, featureCount) {
      var properties = payload && payload.properties;
      var manifest = properties && properties._compact_workshop_layers;
      var layers = manifest && Array.isArray(manifest.layers) ? manifest.layers : null;
      if (!layers || !layers.length) return null;
      var total = 0;
      var normalized = [];
      for (var i = 0; i < layers.length; i++) {
        var entry = layers[i];
        var count = entry && Number(entry.count);
        var name = entry && textValue(entry.name);
        if (!name || !Number.isInteger(count) || count < 0) return null;
        total += count;
        normalized.push({
          id: textValue(entry.id) || 'layer-' + (i + 1),
          name: name,
          count: count,
          options: entry.options && typeof entry.options === 'object' ? entry.options : {}
        });
      }
      return total === featureCount ? normalized : null;
    }

    function prepareData(id, payload) {
      var fallbackColor = colorFor(id);
      var features = payload && Array.isArray(payload.features) ? payload.features : [];
      var values = readValues(payload, features);
      var manifestLayers = compactLayerManifest(payload, features.length);
      var manifestLayerByIndex = null;
      var categoryInfo = {};
      var categoryOrder = [];
      var iconDefs = {};
      var usedFeatureIds = {};

      if (manifestLayers) {
        manifestLayerByIndex = [];
        manifestLayers.forEach(function (entry) {
          categoryInfo[entry.name] = {
            name: entry.name,
            displayName: entry.name,
            count: 0,
            color: validCssColor(entry.options.color, colorFor(id + ':' + entry.id))
          };
          categoryOrder.push(entry.name);
          for (var offset = 0; offset < entry.count; offset++) manifestLayerByIndex.push(entry);
        });
      }

      features.forEach(function (feature, index) {
        if (!feature || typeof feature !== 'object') return;
        var properties = feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
        var manifestLayer = manifestLayerByIndex && manifestLayerByIndex[index];
        var inheritedOptions = manifestLayer ? manifestLayer.options : {};
        var featureOptions = umapOptions(properties);
        var opts = Object.assign({}, inheritedOptions, featureOptions);
        var category = manifestLayer ? manifestLayer.name : categoryFor(properties);
        var categoryFallback = manifestLayer ? categoryInfo[category].color : fallbackColor;
        var baseColor = validCssColor(opts.color, categoryFallback);
        // uMap's own styles win over SimpleStyle fields: uMap backups give every reach-area
        // polygon the same teal `fill`, while the real colours sit on the uMap layers.
        var fillColor = validCssColor(firstValue(
          featureOptions.fillColor,
          featureOptions.color,
          inheritedOptions.fillColor,
          inheritedOptions.color,
          properties.fill
        ), baseColor);
        var strokeColor = validCssColor(firstValue(
          featureOptions.color,
          inheritedOptions.color,
          properties.stroke
        ), baseColor);
        var iconUrl = resolveIconUrl(firstValue(opts.iconUrl, properties['marker-symbol']));
        var featureId = feature.id != null ? String(feature.id) : 'feature-' + (index + 1);
        if (usedFeatureIds[featureId]) featureId += '-' + (index + 1);
        usedFeatureIds[featureId] = true;
        feature.id = featureId;

        var normalized = Object.assign({}, properties, {
          __cw_category: category,
          __cw_label: firstValue(properties.name, properties.title),
          __cw_color: baseColor,
          __cw_fill: fillColor,
          __cw_stroke: strokeColor,
          __cw_fill_opacity: firstClamped(0, 1, 0.24, [featureOptions.fillOpacity, featureOptions.opacity,
            inheritedOptions.fillOpacity, inheritedOptions.opacity, properties['fill-opacity']]),
          __cw_line_opacity: firstClamped(0, 1, 0.9, [featureOptions.opacity, inheritedOptions.opacity,
            properties['stroke-opacity']]),
          __cw_line_width: firstClamped(0.5, 16, 2.5, [featureOptions.weight, inheritedOptions.weight,
            properties['stroke-width']]),
          __cw_point_opacity: firstClamped(0, 1, 0.92, [featureOptions.iconOpacity, featureOptions.opacity,
            inheritedOptions.iconOpacity, inheritedOptions.opacity]),
          __cw_point_radius: markerRadius(properties, opts),
          __cw_outlink: firstValue(opts.outlink),
          __cw_area: !!(feature.geometry && /Polygon$/.test(String(feature.geometry.type || '')))
        });

        if (iconUrl) {
          var iconId = 'custom-geo-image-' + hashString(iconUrl);
          normalized.__cw_icon_id = iconId;
          normalized.__cw_icon_size = iconSize(properties);
          iconDefs[iconId] = {
            id: iconId,
            url: iconUrl,
            color: baseColor,
            label: humanize(category).charAt(0)
          };
        }

        feature.properties = normalized;
        if (!categoryInfo[category]) {
          categoryInfo[category] = { name: category, displayName: humanize(category), count: 0, color: baseColor };
          categoryOrder.push(category);
        }
        categoryInfo[category].count++;
      });

      var categories = categoryOrder.map(function (name) { return categoryInfo[name]; });
      if (!manifestLayers) {
        categories.sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });
      }
      var previousState = categoryStateById[id] || {};
      var nextState = {};
      categories.forEach(function (entry) {
        nextState[entry.name] = previousState[entry.name] !== false;
      });
      categoryStateById[id] = nextState;
      var hasArea = features.some(function (f) { return f && f.properties && f.properties.__cw_area; });
      if (hasArea && values.countStickers) {
        values.live = liveVariable(values);
        values.variables.unshift(values.live);
      }
      metaById[id] = { categories: categories, icons: iconDefs, values: values };
      delete cellsById[id];
      return { type: 'FeatureCollection', features: features };
    }

    function selectedStateExpression() {
      return ['boolean', ['feature-state', 'selected'], false];
    }

    function hoverStateExpression() {
      return ['boolean', ['feature-state', 'hover'], false];
    }

    function geometryFilter(kind) {
      if (kind === 'fill' || kind === 'labelArea') return ['==', '$type', 'Polygon'];
      if (kind === 'line') return ['any', ['==', '$type', 'LineString'], ['==', '$type', 'Polygon']];
      if (kind === 'labelLine' || kind === 'casing') return ['==', '$type', 'LineString'];
      return ['==', '$type', 'Point'];
    }

    function filterFor(id, kind) {
      var filters = [geometryFilter(kind)];
      if (kind === 'labelPoint' || kind === 'labelLine' || kind === 'labelArea') {
        filters.push(['!=', '__cw_label', '']);
      }
      if (kind === 'icon') filters.push(['has', '__cw_icon_id']);
      // Legacy filter syntax (`$type`, `in key ...values`), which MapLibre 5 still accepts.
      var state = categoryStateById[id] || {};
      var categories = Object.keys(state).filter(function (name) { return state[name] !== false; });
      filters.push(categories.length
        ? ['in', '__cw_category'].concat(categories)
        : ['==', '__cw_category', '__cw_no_category_enabled__']);
      return ['all'].concat(filters);
    }

    function ensureLayers(id) {
      if (!dataById[id]) return;
      var visibility = visibleById[id] ? 'visible' : 'none';
      var ids = layerIdsFor(id);

      if (!map.getSource(srcId(id))) {
        map.addSource(srcId(id), { type: 'geojson', data: dataById[id] });
      }

      var paint = paintFor(id);
      if (!map.getLayer(ids.fill)) {
        map.addLayer({
          id: ids.fill, type: 'fill', source: srcId(id), filter: filterFor(id, 'fill'),
          layout: { visibility: visibility },
          paint: paint.fill
        });
      }
      if (!map.getLayer(ids.casing)) {
        map.addLayer({
          id: ids.casing, type: 'line', source: srcId(id), filter: filterFor(id, 'casing'),
          layout: { visibility: visibility, 'line-join': 'round', 'line-cap': 'round' },
          paint: paint.casing
        });
      }
      if (!map.getLayer(ids.line)) {
        map.addLayer({
          id: ids.line, type: 'line', source: srcId(id), filter: filterFor(id, 'line'),
          layout: { visibility: visibility, 'line-join': 'round', 'line-cap': 'round' },
          paint: paint.line
        });
      }
      if (!map.getLayer(ids.point)) {
        map.addLayer({
          id: ids.point, type: 'circle', source: srcId(id), filter: filterFor(id, 'point'),
          layout: { visibility: visibility },
          paint: paint.point
        });
      }
      if (!map.getLayer(ids.icon)) {
        map.addLayer({
          id: ids.icon, type: 'symbol', source: srcId(id), filter: filterFor(id, 'icon'),
          layout: {
            visibility: visibility,
            'icon-image': ['get', '__cw_icon_id'],
            'icon-size': ['get', '__cw_icon_size'],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true
          },
          paint: paint.icon
        });
      }
      addLabelLayer(ids.labelPoint, id, visibility, 'labelPoint', {
        'text-offset': [0, 1.25],
        'text-anchor': 'top'
      }, 14);
      addLabelLayer(ids.labelLine, id, visibility, 'labelLine', {
        'symbol-placement': 'line',
        'text-rotation-alignment': 'map',
        'text-padding': 6
      }, 14.5);
      addLabelLayer(ids.labelArea, id, visibility, 'labelArea', {
        'text-anchor': 'center'
      }, 15);

      ensureIcons(id);
      bindInteractions(id);
      applyCategoryFilter(id);
      keepBelowResults(id);
    }

    // A layer coloured by a value sits under the workshop results (hexagons, heatmap, drawings,
    // sticker marks) and the pen lines drawn now (drawing.js, 'draw-layer' first), whichever was
    // added first, so those stay readable on top of it.
    function keepBelowResults(id) {
      if (isValueLayer(id) !== true) return;
      var layers = (map.getStyle() && map.getStyle().layers) || [];
      var firstResult = null;
      for (var i = 0; i < layers.length; i++) {
        if (layers[i].id === 'draw-layer' || layers[i].id.indexOf('results-') === 0) {
          firstResult = layers[i].id;
          break;
        }
      }
      if (!firstResult) return;
      allLayerIds(id).forEach(function (layerId) {
        if (map.getLayer(layerId)) map.moveLayer(layerId, firstResult);
      });
    }

    function addLabelLayer(layerId, id, visibility, kind, extraLayout, minzoom) {
      if (map.getLayer(layerId)) return;
      map.addLayer({
        id: layerId,
        type: 'symbol',
        source: srcId(id),
        minzoom: minzoom,
        filter: filterFor(id, kind),
        layout: Object.assign({
          visibility: visibility,
          'text-field': ['get', '__cw_label'],
          'text-font': window.CompactMapSetup.labelFont(map, ['Open Sans Semibold']),
          'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 17, 13],
          'text-max-width': 14,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-optional': false
        }, extraLayout),
        paint: {
          'text-color': '#172033',
          'text-halo-color': 'rgba(255,255,255,0.95)',
          'text-halo-width': 1.6,
          'text-halo-blur': 0.5
        }
      });
    }

    // A disc with the category's initial, for icons that cannot be loaded.
    function fallbackIcon(definition) {
      var canvas = document.createElement('canvas');
      canvas.width = 48;
      canvas.height = 48;
      var context = canvas.getContext('2d');
      context.beginPath();
      context.arc(24, 24, 20, 0, Math.PI * 2);
      context.fillStyle = validCssColor(definition.color, '#334155');
      context.fill();
      context.lineWidth = 4;
      context.strokeStyle = '#ffffff';
      context.stroke();
      context.fillStyle = '#ffffff';
      context.font = '700 22px system-ui, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(definition.label || '•', 24, 25);
      return context.getImageData(0, 0, 48, 48);
    }

    function addIconImage(definition, image) {
      if (map.hasImage(definition.id)) return;
      try {
        map.addImage(definition.id, image, { pixelRatio: 2 });
      } catch (_error) {
        if (!map.hasImage(definition.id)) map.addImage(definition.id, fallbackIcon(definition), { pixelRatio: 2 });
      }
    }

    function ensureIcons(id) {
      var icons = metaById[id].icons;
      Object.keys(icons).forEach(function (iconId) {
        var definition = icons[iconId];
        if (map.hasImage(iconId) || iconLoading[iconId]) return;
        iconLoading[iconId] = true;
        Promise.resolve(map.loadImage(definition.url))
          .then(function (result) { addIconImage(definition, result && result.data ? result.data : result); })
          .catch(function () { addIconImage(definition, fallbackIcon(definition)); })
          .finally(function () { delete iconLoading[iconId]; });
      });
    }

    function applyCategoryFilter(id) {
      if (!dataById[id]) return;
      var ids = layerIdsFor(id);
      Object.keys(ids).forEach(function (kind) {
        if (map.getLayer(ids[kind])) map.setFilter(ids[kind], filterFor(id, kind));
      });
    }

    function safeSetFeatureState(ref, state) {
      if (!ref || !map.getSource(srcId(ref.layerId))) return;
      // setFeatureState throws while a new basemap style is still loading.
      try { map.setFeatureState({ source: srcId(ref.layerId), id: ref.featureId }, state); } catch (_error) {}
    }

    function setHovered(layerId, featureId) {
      featureId = featureId == null ? null : featureId;
      if (hoveredFeature && hoveredFeature.layerId === layerId && hoveredFeature.featureId === featureId) return;
      if (hoveredFeature) safeSetFeatureState(hoveredFeature, { hover: false });
      hoveredFeature = featureId == null ? null : { layerId: layerId, featureId: featureId };
      if (hoveredFeature) safeSetFeatureState(hoveredFeature, { hover: true });
    }

    function setSelected(layerId, featureId) {
      if (selectedFeature) safeSetFeatureState(selectedFeature, { selected: false });
      selectedFeature = featureId == null ? null : { layerId: layerId, featureId: featureId };
      if (selectedFeature) safeSetFeatureState(selectedFeature, { selected: true });
    }

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function safeHttpUrl(value) {
      value = textValue(value);
      if (/^\/\//.test(value)) value = 'https:' + value;
      return /^https?:\/\//i.test(value) ? value : '';
    }

    // Escaped text with line breaks, and uMap's {{https://...}} image links as images.
    function descriptionHtml(value) {
      value = String(value == null ? '' : value);
      var output = '';
      var position = 0;
      var imagePattern = /\{\{(https?:\/\/[^}]+)\}\}/gi;
      var match;
      function appendText(text) {
        output += escapeHtml(text).replace(/\r?\n/g, '<br>');
      }
      while ((match = imagePattern.exec(value))) {
        appendText(value.slice(position, match.index));
        var imageUrl = safeHttpUrl(match[1]);
        if (imageUrl) output += '<img src="' + escapeHtml(imageUrl) + '" alt="" style="display:block;max-width:100%;max-height:190px;margin:7px 0;border-radius:7px;object-fit:cover">';
        position = match.index + match[0].length;
      }
      appendText(value.slice(position));
      return output;
    }

    // The feature's values, the one the layer is coloured by first and in bold.
    function valuesHtml(id, properties) {
      var values = metaById[id] && metaById[id].values;
      if (!values || !values.variables.length) return '';
      var active = activeColour(id).variable;
      var rows = '';
      values.variables.forEach(function (variable) {
        var strong = variable === active;
        rows += '<div style="display:grid;grid-template-columns:1fr auto;gap:10px;padding:3px 0;border-top:1px solid #e7e9ee' +
          (strong ? ';font-weight:750' : '') + '">' +
          '<span style="color:' + (strong ? '#172033' : '#687184') + '">' + escapeHtml(variable.label) + '</span>' +
          '<span style="text-align:right">' + escapeHtml(valueText(variable, properties[variable.key])) + '</span></div>';
      });
      return rows ? '<div style="margin-top:4px;max-height:235px;overflow:auto">' + rows + '</div>' : '';
    }

    function popupHtml(id, feature) {
      var properties = feature.properties || {};
      var values = metaById[id] && metaById[id].values;
      var valueLayer = !!(values && values.variables.length);
      var title = firstValue(properties.name, properties.title, valueLayer ? values.title : '',
        humanize(properties.__cw_category), 'Map feature');
      var html = '<div style="font:13px/1.42 system-ui,sans-serif;color:#172033;max-width:340px">' +
        '<div style="font-size:16px;font-weight:750;margin:0 0 6px">' + escapeHtml(title) + '</div>';
      var description = descriptionHtml(properties.description);
      if (description) html += '<div style="max-height:235px;overflow:auto;margin:0 0 8px">' + description + '</div>';
      if (valueLayer) html += valuesHtml(id, properties);

      var category = properties.type || properties.__cw_category;
      var fields = [
        // Value layers have no categories of their own: skip the catch-all one.
        ['Category', valueLayer && category === 'Other' ? '' : category],
        ['Operator', properties.operator],
        ['Address', properties.address],
        ['Opening hours', properties.opening_hours],
        ['Cuisine', properties.cuisine],
        ['Sport', properties.sport],
        ['Capacity', properties.capacity],
        ['Wheelchair', properties.wheelchair],
        ['Level', properties.level],
        ['Source', properties.source]
      ];
      var rows = '';
      fields.forEach(function (field) {
        var value = textValue(field[1]);
        if (!value) return;
        rows += '<div style="display:grid;grid-template-columns:92px 1fr;gap:7px;padding:3px 0;border-top:1px solid #e7e9ee">' +
          '<span style="color:#687184">' + escapeHtml(field[0]) + '</span><span>' + escapeHtml(value) + '</span></div>';
      });
      if (rows) html += '<div style="margin-top:7px">' + rows + '</div>';

      var links = [];
      var website = safeHttpUrl(properties.website);
      var outlink = safeHttpUrl(properties.__cw_outlink);
      var wikipedia = safeHttpUrl(properties.wikipedia);
      var phone = textValue(properties.phone);
      var email = textValue(properties.email);
      if (website) links.push(['Website', website]);
      if (outlink && outlink !== website) links.push(['More information', outlink]);
      if (wikipedia) links.push(['Wikipedia', wikipedia]);
      if (phone) links.push(['Call', 'tel:' + phone.replace(/[^0-9+]/g, '')]);
      if (email) links.push(['Email', 'mailto:' + email]);
      if (links.length) {
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:9px">';
        links.forEach(function (link) {
          html += '<a href="' + escapeHtml(link[1]) + '" target="_blank" rel="noopener noreferrer" style="color:#0f766e;text-decoration:none;font-weight:700">' + escapeHtml(link[0]) + '</a>';
        });
        html += '</div>';
      }
      return html + '</div>';
    }

    function showPopup(id, event, feature) {
      if (activePopup) activePopup.remove();
      ensurePopupStyles();
      activePopup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: true,
        className: 'compact-data-popup',
        maxWidth: '370px'
      })
        .setLngLat(event.lngLat)
        .setHTML(popupHtml(id, feature))
        .addTo(map);
      var closeButton = activePopup.getElement().querySelector('.maplibregl-popup-close-button');
      if (closeButton) {
        closeButton.textContent = '×';
        closeButton.title = 'Close popup';
        closeButton.setAttribute('aria-label', 'Close popup');
      }
      activePopup.on('close', function () {
        activePopup = null;
        setSelected(null, null);
      });
    }

    function bindInteractions(id) {
      if (interactionHandlersById[id]) return;
      var ids = layerIdsFor(id);
      var handlers = [];
      // Bound top layer first: a point often sits inside a large polygon, and the first
      // handler marks the native event as handled so the top-most feature wins.
      [ids.labelPoint, ids.labelLine, ids.labelArea, ids.icon, ids.point, ids.line, ids.fill].forEach(function (layerId) {
        if (!map.getLayer(layerId)) return;
        var move = function (event) {
          if (!event.features || !event.features.length) return;
          var original = event.originalEvent;
          if (original && original.__compactCustomGeoHoverHandled) return;
          if (original) original.__compactCustomGeoHoverHandled = true;
          map.getCanvas().style.cursor = 'pointer';
          setHovered(id, event.features[0].id);
          showTooltip(id, event.features[0], event.point);
        };
        var leave = function () {
          map.getCanvas().style.cursor = '';
          if (hoveredFeature && hoveredFeature.layerId === id) setHovered(null, null);
          hideTooltip();
        };
        var click = function (event) {
          if (!event.features || !event.features.length) return;
          // A click made with a mouse tool is the tool's.
          if (window.CompactMouseTools && window.CompactMouseTools.isActive()) return;
          var original = event.originalEvent;
          if (original && original.__compactCustomGeoHandled) return;
          if (original) original.__compactCustomGeoHandled = true;
          var feature = event.features[0];
          setSelected(id, feature.id);
          hideTooltip(); // the popup shows the values
          showPopup(id, event, feature);
        };
        map.on('mousemove', layerId, move);
        map.on('mouseleave', layerId, leave);
        map.on('click', layerId, click);
        handlers.push({ layerId: layerId, move: move, leave: leave, click: click });
      });
      interactionHandlersById[id] = handlers;
    }

    function unbindInteractions(id) {
      (interactionHandlersById[id] || []).forEach(function (entry) {
        map.off('mousemove', entry.layerId, entry.move);
        map.off('mouseleave', entry.layerId, entry.leave);
        map.off('click', entry.layerId, entry.click);
      });
      delete interactionHandlersById[id];
    }

    // Refreshes the id/name registry from the server; callback(err, registry).
    function refresh(callback) {
      fetch('/api/custom-layers', { cache: 'no-store' })
        .then(function (response) { return response.json(); })
        .then(function (data) {
          registry = data && Array.isArray(data.layers) ? data.layers : [];
          if (typeof callback === 'function') callback(null, registry);
        })
        .catch(function (error) {
          if (typeof callback === 'function') callback(error, registry);
        });
    }

    function getName(id) {
      for (var i = 0; i < registry.length; i++) {
        if (String(registry[i].id) === String(id)) return registry[i].name || registry[i].id;
      }
      return String(id || 'Data layer');
    }

    function getSublayers(id) {
      id = String(id || '');
      var meta = metaById[id];
      var state = categoryStateById[id] || {};
      if (!meta) return null;
      return meta.categories.map(function (entry) {
        return {
          name: entry.name,
          label: entry.displayName,
          count: entry.count,
          color: entry.color,
          visible: state[entry.name] !== false
        };
      });
    }

    function setSublayerVisible(id, name, show) {
      id = String(id || '');
      name = String(name || '');
      var state = categoryStateById[id];
      if (!state || !Object.prototype.hasOwnProperty.call(state, name)) return false;
      state[name] = !!show;
      applyCategoryFilter(id);
      return true;
    }

    function setAllSublayersVisible(id, show) {
      id = String(id || '');
      var state = categoryStateById[id];
      if (!state) return false;
      Object.keys(state).forEach(function (name) { state[name] = !!show; });
      applyCategoryFilter(id);
      return true;
    }

    function loadLayer(id, callback) {
      id = String(id || '');
      if (dataById[id]) {
        callback(null, dataById[id]);
        return;
      }
      if (loadCallbacksById[id]) {
        loadCallbacksById[id].push(callback);
        return;
      }
      loadCallbacksById[id] = [callback];
      function finish(error, data) {
        var callbacks = loadCallbacksById[id];
        delete loadCallbacksById[id];
        callbacks.forEach(function (done) { done(error, data); });
      }
      fetch('/api/custom-layers/' + encodeURIComponent(id))
        .then(function (response) {
          if (!response.ok) throw new Error('http_' + response.status);
          return response.json();
        })
        .then(function (geojson) {
          dataById[id] = prepareData(id, geojson);
          countLivePoints(id);
          finish(null, dataById[id]);
        })
        .catch(function (error) {
          finish(error, null);
        });
    }

    function setLayerVisible(id, show) {
      id = String(id || '');
      visibleById[id] = !!show;
      if (show) ensureLayers(id);
      allLayerIds(id).forEach(function (layerId) {
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', show ? 'visible' : 'none');
      });
      if (!show && hoveredFeature && hoveredFeature.layerId === id) {
        setHovered(null, null);
        hideTooltip();
      }
      renderLegend();
    }

    // The stickers on the table ([{ lng, lat }]), recounted into every loaded value layer when they change.
    function setLivePoints(points) {
      var next = (Array.isArray(points) ? points : []).map(function (p) {
        return { lng: Number(p && p.lng), lat: Number(p && p.lat) };
      }).filter(function (p) { return isFinite(p.lng) && isFinite(p.lat); });
      var signature = next.map(function (p) { return p.lng.toFixed(6) + ',' + p.lat.toFixed(6); }).join(';');
      if (signature === liveSignature) return;
      liveSignature = signature;
      livePoints = next;
      Object.keys(dataById).forEach(function (id) {
        if (!countLivePoints(id)) return;
        var source = map.getSource(srcId(id));
        if (source) source.setData(dataById[id]);
        // The ramp's top follows the busiest cell.
        if (activeColour(id).variable === metaById[id].values.live) applyPaint(id);
      });
      renderLegend();
    }

    // Whether the layer is coloured by a value; null until the layer is loaded.
    function isValueLayer(id) {
      var meta = metaById[String(id || '')];
      return meta ? meta.values.variables.length > 0 : null;
    }

    // One opacity (0-1) for every layer coloured by a value; null gives each layer its own default.
    function setValueOpacity(opacity) {
      var next = finiteOrNull(opacity);
      next = next == null ? null : Math.max(0, Math.min(1, next));
      if (next === valueOpacity) return;
      valueOpacity = next;
      Object.keys(dataById).forEach(function (id) {
        if (activeColour(id).variable) applyPaint(id);
      });
    }

    function hideAllExcept(keepIds) {
      var keep = {};
      keepIds.forEach(function (id) { keep[String(id)] = true; });
      Object.keys(visibleById).forEach(function (id) {
        if (visibleById[id] && !keep[id]) setLayerVisible(id, false);
      });
    }

    function forget(id) {
      id = String(id || '');
      if (hoveredFeature && hoveredFeature.layerId === id) setHovered(null, null);
      if (selectedFeature && selectedFeature.layerId === id) {
        setSelected(null, null);
        if (activePopup) activePopup.remove();
      }
      unbindInteractions(id);
      allLayerIds(id).forEach(function (layerId) {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
      });
      if (map.getSource(srcId(id))) map.removeSource(srcId(id));
      delete dataById[id];
      delete visibleById[id];
      delete metaById[id];
      delete categoryStateById[id];
      delete cellsById[id];
      hideTooltip();
      renderLegend();
    }

    return {
      refresh: refresh,
      getName: getName,
      getSublayers: getSublayers,
      isValueLayer: isValueLayer,
      setValueOpacity: setValueOpacity,
      defaultValueOpacity: DEFAULT_VALUE_OPACITY,
      setLivePoints: setLivePoints,
      loadLayer: loadLayer,
      setLayerVisible: setLayerVisible,
      setSublayerVisible: setSublayerVisible,
      setAllSublayersVisible: setAllSublayersVisible,
      hideAllExcept: hideAllExcept,
      forget: forget
    };
  }

  window.CompactCustomGeojsonLayers = { createCustomGeojsonLayers: createCustomGeojsonLayers };
})();
