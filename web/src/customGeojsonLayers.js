(function () {
  // Facilitator-uploaded GeoJSON overlays (managed via /api/custom-layers).
  // Besides geometry, this renderer understands common uMap/SimpleStyle
  // properties, builds popups + labels, exposes category filters, and uses
  // feature-state for hover/selection highlighting.

  var PALETTE = ['#f59e0b', '#10b981', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#f43f5e'];
  var UMAP_ICON_ORIGIN = 'https://umap.openstreetmap.fr';
  var INTERNAL_PREFIX = '__cw_';
  var POPUP_STYLE_ID = 'compact-custom-geo-popup-styles';

  function ensurePopupStyles() {
    if (document.getElementById(POPUP_STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = POPUP_STYLE_ID;
    style.textContent =
      '.compact-data-popup .maplibregl-popup-content,' +
      '.compact-data-popup .mapboxgl-popup-content{' +
        'padding:16px 54px 16px 16px;border-radius:12px;' +
        'box-shadow:0 14px 36px rgba(15,23,42,.24)' +
      '}' +
      '.compact-data-popup .maplibregl-popup-close-button,' +
      '.compact-data-popup .mapboxgl-popup-close-button{' +
        'display:grid;place-items:center;width:40px;height:40px;' +
        'top:7px;right:7px;padding:0;border:1px solid #cbd5e1;' +
        'border-radius:999px;background:#fff;color:#334155;' +
        'box-shadow:0 2px 7px rgba(15,23,42,.16);cursor:pointer;' +
        'font:400 28px/1 Arial,sans-serif;z-index:2;transition:' +
        'background .14s ease,color .14s ease,transform .14s ease' +
      '}' +
      '.compact-data-popup .maplibregl-popup-close-button:hover,' +
      '.compact-data-popup .mapboxgl-popup-close-button:hover{' +
        'background:#f1f5f9;color:#0f172a;transform:scale(1.04)' +
      '}' +
      '.compact-data-popup .maplibregl-popup-close-button:focus-visible,' +
      '.compact-data-popup .mapboxgl-popup-close-button:focus-visible{' +
        'outline:3px solid rgba(20,184,166,.42);outline-offset:2px' +
      '}';
    document.head.appendChild(style);
  }

  function createCustomGeojsonLayers(options) {
    var map = options.map;
    var registry = [];                  // [{id, name}] from the server
    var dataById = {};                  // id -> prepared FeatureCollection
    var visibleById = {};               // id -> current map visibility
    var loadCallbacksById = {};         // id -> [cb] while fetch is in flight
    var metaById = {};                  // id -> categories/icons/fallback color
    var categoryStateById = {};         // id -> {category: boolean}
    var interactionHandlersById = {};   // id -> delegated map listeners
    var iconLoading = {};               // icon id -> true while loading
    var hoveredFeature = null;           // {layerId, featureId}
    var selectedFeature = null;          // {layerId, featureId}
    var activePopup = null;
    var legendEl = null;
    var legendBodyEl = null;
    var legendTitleEl = null;
    var legendCollapsed = false;

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

    function layerKey(id) { return hashString(id); }
    function srcId(id) { return 'custom-geo-src-' + layerKey(id); }
    function layerIdsFor(id) {
      var key = layerKey(id);
      return {
        fill: 'custom-geo-fill-' + key,
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
      return [ids.fill, ids.line, ids.point, ids.icon, ids.labelPoint, ids.labelLine, ids.labelArea];
    }

    function clamp(value, min, max, fallback) {
      value = Number(value);
      if (!isFinite(value)) return fallback;
      return Math.max(min, Math.min(max, value));
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
      probe.style.color = '';
      probe.style.color = value;
      return probe.style.color ? value : fallback;
    }

    function humanize(value) {
      value = textValue(value).replace(/[_-]+/g, ' ');
      if (!value) return 'Other';
      return value.charAt(0).toUpperCase() + value.slice(1);
    }

    function umapOptions(properties) {
      var value = properties && properties._umap_options;
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

    function resolveIconUrl(value) {
      value = textValue(value);
      if (!value) return '';
      if (/^data:image\//i.test(value) || /^https?:\/\//i.test(value)) return value;
      if (/^\/\//.test(value)) return 'https:' + value;
      if (/^\/uploads\//i.test(value)) return UMAP_ICON_ORIGIN + value;
      return '';
    }

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
      // Block boundaries are only safe when the manifest describes every
      // feature in this exact export. Otherwise retain the generic fallback.
      return total === featureCount ? normalized : null;
    }

    function prepareData(id, payload) {
      var fallbackColor = colorFor(id);
      var features = payload && Array.isArray(payload.features) ? payload.features : [];
      var manifestLayers = compactLayerManifest(payload, features.length);
      var manifestLayerByIndex = null;
      var categoryInfo = {};
      var categoryOrder = [];
      var iconDefs = {};
      var usedFeatureIds = {};

      if (manifestLayers) {
        manifestLayerByIndex = [];
        manifestLayers.forEach(function (entry, layerIndex) {
          var layerColor = validCssColor(entry.options.color, colorFor(id + ':' + entry.id));
          categoryInfo[entry.name] = {
            name: entry.name,
            displayName: entry.name,
            count: 0,
            color: layerColor,
            order: layerIndex
          };
          categoryOrder.push(entry.name);
          for (var offset = 0; offset < entry.count; offset++) manifestLayerByIndex.push(entry);
        });
      }

      features.forEach(function (feature, index) {
        if (!feature || typeof feature !== 'object') return;
        var properties = feature.properties && typeof feature.properties === 'object'
          ? feature.properties
          : {};
        var manifestLayer = manifestLayerByIndex && manifestLayerByIndex[index];
        var inheritedOptions = manifestLayer ? manifestLayer.options : {};
        var featureOptions = umapOptions(properties);
        var opts = Object.assign({}, inheritedOptions, featureOptions);
        var category = manifestLayer ? manifestLayer.name : categoryFor(properties);
        var categoryFallback = manifestLayer ? categoryInfo[category].color : fallbackColor;
        var baseColor = validCssColor(opts.color, categoryFallback);
        // uMap's own feature/layer styles take precedence over generic
        // SimpleStyle fields. Reach-area polygons in uMap backups all carry a
        // generic teal `fill`, while their real distinct colors live on each
        // uMap data layer.
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
        var label = firstValue(properties.name, properties.title);
        var iconUrl = resolveIconUrl(firstValue(opts.iconUrl, properties['marker-symbol']));
        var featureId = feature.id != null ? String(feature.id) : 'feature-' + (index + 1);
        if (usedFeatureIds[featureId]) featureId += '-' + (index + 1);
        usedFeatureIds[featureId] = true;
        feature.id = featureId;

        var normalized = Object.assign({}, properties, {
          __cw_category: category,
          __cw_label: label,
          __cw_color: baseColor,
          __cw_fill: fillColor,
          __cw_stroke: strokeColor,
          __cw_fill_opacity: clamp(featureOptions.fillOpacity, 0, 1,
            clamp(featureOptions.opacity, 0, 1,
              clamp(inheritedOptions.fillOpacity, 0, 1,
                clamp(inheritedOptions.opacity, 0, 1,
                  clamp(properties['fill-opacity'], 0, 1, 0.24))))),
          __cw_line_opacity: clamp(featureOptions.opacity, 0, 1,
            clamp(inheritedOptions.opacity, 0, 1,
              clamp(properties['stroke-opacity'], 0, 1, 0.9))),
          __cw_line_width: clamp(featureOptions.weight, 0.5, 16,
            clamp(inheritedOptions.weight, 0.5, 16,
              clamp(properties['stroke-width'], 0.5, 16, 2.5))),
          __cw_point_opacity: clamp(featureOptions.iconOpacity, 0, 1,
            clamp(featureOptions.opacity, 0, 1,
              clamp(inheritedOptions.iconOpacity, 0, 1,
                clamp(inheritedOptions.opacity, 0, 1, 0.92)))),
          __cw_point_radius: markerRadius(properties, opts),
          __cw_outlink: firstValue(opts.outlink),
          __cw_popup_shape: firstValue(opts.popupShape)
        });

        if (iconUrl) {
          var iconId = 'custom-geo-image-' + hashString(iconUrl);
          normalized.__cw_icon_id = iconId;
          normalized.__cw_icon_size = firstValue(properties['marker-size']).toLowerCase() === 'large' ? 1.25
            : (firstValue(properties['marker-size']).toLowerCase() === 'small' ? 0.75 : 1);
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
      metaById[id] = { categories: categories, icons: iconDefs, fallbackColor: fallbackColor };
      return { type: 'FeatureCollection', features: features };
    }

    function selectedStateExpression() {
      return ['boolean', ['feature-state', 'selected'], false];
    }
    function hoverStateExpression() {
      return ['boolean', ['feature-state', 'hover'], false];
    }

    function geometryFilter(kind) {
      if (kind === 'fill') return ['==', '$type', 'Polygon'];
      if (kind === 'line') return ['any', ['==', '$type', 'LineString'], ['==', '$type', 'Polygon']];
      return ['==', '$type', 'Point'];
    }

    function enabledCategories(id) {
      var state = categoryStateById[id] || {};
      return Object.keys(state).filter(function (name) { return state[name] !== false; });
    }

    function filterFor(id, kind) {
      var geometryKind = kind === 'labelPoint' ? 'point'
        : (kind === 'labelLine' ? 'line' : (kind === 'labelArea' ? 'fill' : kind));
      var geometry = kind === 'labelLine' ? ['==', '$type', 'LineString']
        : (kind === 'labelArea' ? ['==', '$type', 'Polygon'] : geometryFilter(geometryKind));
      var filters = [geometry];
      if (kind === 'labelPoint' || kind === 'labelLine' || kind === 'labelArea') {
        filters.push(['!=', '__cw_label', '']);
      }
      if (kind === 'icon') filters.push(['has', '__cw_icon_id']);
      // MapLibre still parses layer filters using its legacy property-filter
      // grammar. Keep expression syntax in paint/layout values, but use the
      // legacy `in` form here so this also works on MapLibre 5.
      var categories = enabledCategories(id);
      filters.push(categories.length
        ? ['in', '__cw_category'].concat(categories)
        : ['==', '__cw_category', '__cw_no_category_enabled__']);
      return ['all'].concat(filters);
    }

    function ensureLayers(id) {
      if (!map || !dataById[id]) return;
      var visibility = visibleById[id] ? 'visible' : 'none';
      var ids = layerIdsFor(id);

      if (!map.getSource(srcId(id))) {
        map.addSource(srcId(id), { type: 'geojson', data: dataById[id] });
      }

      if (!map.getLayer(ids.fill)) {
        map.addLayer({
          id: ids.fill, type: 'fill', source: srcId(id), filter: filterFor(id, 'fill'),
          layout: { visibility: visibility },
          paint: {
            'fill-color': ['get', '__cw_fill'],
            'fill-opacity': ['case', selectedStateExpression(), ['min', 1, ['+', ['get', '__cw_fill_opacity'], 0.38]],
              hoverStateExpression(), ['min', 1, ['+', ['get', '__cw_fill_opacity'], 0.2]], ['get', '__cw_fill_opacity']]
          }
        });
      }
      if (!map.getLayer(ids.line)) {
        map.addLayer({
          id: ids.line, type: 'line', source: srcId(id), filter: filterFor(id, 'line'),
          layout: { visibility: visibility, 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': ['get', '__cw_stroke'],
            'line-opacity': ['get', '__cw_line_opacity'],
            'line-width': ['case', selectedStateExpression(), ['+', ['get', '__cw_line_width'], 3],
              hoverStateExpression(), ['+', ['get', '__cw_line_width'], 1.5], ['get', '__cw_line_width']]
          }
        });
      }
      if (!map.getLayer(ids.point)) {
        map.addLayer({
          id: ids.point, type: 'circle', source: srcId(id), filter: filterFor(id, 'point'),
          layout: { visibility: visibility },
          paint: {
            'circle-radius': ['case', selectedStateExpression(), ['+', ['get', '__cw_point_radius'], 4],
              hoverStateExpression(), ['+', ['get', '__cw_point_radius'], 2], ['get', '__cw_point_radius']],
            'circle-color': ['get', '__cw_color'],
            'circle-opacity': ['get', '__cw_point_opacity'],
            'circle-stroke-color': ['case', selectedStateExpression(), '#ffffff', hoverStateExpression(), '#fff7d6', '#ffffff'],
            'circle-stroke-width': ['case', selectedStateExpression(), 3, hoverStateExpression(), 2.25, 1.5]
          }
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
          paint: { 'icon-opacity': ['get', '__cw_point_opacity'] }
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
          'text-font': ['Open Sans Semibold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 17, 13],
          'text-max-width': 14,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-optional': false
        }, extraLayout || {}),
        paint: {
          'text-color': '#172033',
          'text-halo-color': 'rgba(255,255,255,0.95)',
          'text-halo-width': 1.6,
          'text-halo-blur': 0.5
        }
      });
    }

    function fallbackIcon(definition) {
      var canvas = document.createElement('canvas');
      canvas.width = 48;
      canvas.height = 48;
      var context = canvas.getContext('2d');
      context.clearRect(0, 0, 48, 48);
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
      if (!map || map.hasImage(definition.id)) return;
      try {
        map.addImage(definition.id, image, { pixelRatio: 2 });
      } catch (_error) {
        if (!map.hasImage(definition.id)) {
          try { map.addImage(definition.id, fallbackIcon(definition), { pixelRatio: 2 }); } catch (_fallbackError) {}
        }
      }
    }

    function ensureIcons(id) {
      var meta = metaById[id];
      if (!map || !meta) return;
      Object.keys(meta.icons).forEach(function (iconId) {
        var definition = meta.icons[iconId];
        if (map.hasImage(iconId) || iconLoading[iconId]) return;
        iconLoading[iconId] = true;
        Promise.resolve(map.loadImage(definition.url))
          .then(function (result) { addIconImage(definition, result && result.data ? result.data : result); })
          .catch(function () { addIconImage(definition, fallbackIcon(definition)); })
          .finally(function () { delete iconLoading[iconId]; });
      });
    }

    function applyCategoryFilter(id) {
      if (!map || !dataById[id]) return;
      var ids = layerIdsFor(id);
      var kinds = {
        fill: 'fill', line: 'line', point: 'point', icon: 'icon',
        labelPoint: 'labelPoint', labelLine: 'labelLine', labelArea: 'labelArea'
      };
      Object.keys(kinds).forEach(function (key) {
        if (map.getLayer(ids[key])) map.setFilter(ids[key], filterFor(id, kinds[key]));
      });
    }

    function safeSetFeatureState(ref, state) {
      if (!ref || !map || !map.getSource(srcId(ref.layerId))) return;
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
      if (!value) return '';
      if (/^\/\//.test(value)) value = 'https:' + value;
      return /^https?:\/\//i.test(value) ? value : '';
    }

    function descriptionHtml(value) {
      value = String(value == null ? '' : value);
      if (!value) return '';
      var output = '';
      var position = 0;
      var imagePattern = /\{\{(https?:\/\/[^}]+)\}\}/gi;
      var match;
      function appendText(text) { output += escapeHtml(text).replace(/\r?\n/g, '<br>'); }
      while ((match = imagePattern.exec(value))) {
        appendText(value.slice(position, match.index));
        var imageUrl = safeHttpUrl(match[1]);
        if (imageUrl) output += '<img src="' + escapeHtml(imageUrl) + '" alt="" style="display:block;max-width:100%;max-height:190px;margin:7px 0;border-radius:7px;object-fit:cover">';
        position = match.index + match[0].length;
      }
      appendText(value.slice(position));
      return output;
    }

    function popupHtml(feature) {
      var properties = feature && feature.properties ? feature.properties : {};
      var title = firstValue(properties.name, properties.title, humanize(properties.__cw_category), 'Map feature');
      var html = '<div style="font:13px/1.42 system-ui,sans-serif;color:#172033;max-width:340px">' +
        '<div style="font-size:16px;font-weight:750;margin:0 0 6px">' + escapeHtml(title) + '</div>';
      var description = descriptionHtml(properties.description);
      if (description) html += '<div style="max-height:235px;overflow:auto;margin:0 0 8px">' + description + '</div>';

      var fields = [
        ['Category', properties.type || properties.__cw_category],
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
      if (website) links.push(['Website', website]);
      if (outlink && outlink !== website) links.push(['More information', outlink]);
      if (wikipedia) links.push(['Wikipedia', wikipedia]);
      if (textValue(properties.phone)) links.push(['Call', 'tel:' + textValue(properties.phone).replace(/[^0-9+]/g, '')]);
      if (textValue(properties.email)) links.push(['Email', 'mailto:' + textValue(properties.email)]);
      if (links.length) {
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:9px">';
        links.forEach(function (link) {
          html += '<a href="' + escapeHtml(link[1]) + '" target="_blank" rel="noopener noreferrer" style="color:#0f766e;text-decoration:none;font-weight:700">' + escapeHtml(link[0]) + '</a>';
        });
        html += '</div>';
      }
      return html + '</div>';
    }

    function showPopup(event, feature) {
      var PopupCtor = (window.maplibregl && window.maplibregl.Popup) || (window.mapboxgl && window.mapboxgl.Popup);
      if (!PopupCtor || !event || !event.lngLat) return;
      if (activePopup) activePopup.remove();
      ensurePopupStyles();
      activePopup = new PopupCtor({
        closeButton: true,
        closeOnClick: true,
        className: 'compact-data-popup',
        maxWidth: '370px'
      })
        .setLngLat(event.lngLat)
        .setHTML(popupHtml(feature))
        .addTo(map);
      var popupElement = activePopup.getElement && activePopup.getElement();
      var closeButton = popupElement && popupElement.querySelector(
        '.maplibregl-popup-close-button, .mapboxgl-popup-close-button'
      );
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
      if (!map || interactionHandlersById[id]) return;
      var ids = layerIdsFor(id);
      var handlers = [];
      // Bind in visual stacking order. A point/icon often sits inside a large
      // polygon, and the first handler marks the native click as consumed, so
      // the top-most feature must get the popup and selection first.
      [ids.labelPoint, ids.labelLine, ids.labelArea, ids.icon, ids.point, ids.line, ids.fill].forEach(function (layerId) {
        if (!map.getLayer(layerId)) return;
        var move = function (event) {
          if (!event.features || !event.features.length) return;
          var original = event.originalEvent;
          if (original && original.__compactCustomGeoHoverHandled) return;
          try { if (original) original.__compactCustomGeoHoverHandled = true; } catch (_error) {}
          map.getCanvas().style.cursor = 'pointer';
          setHovered(id, event.features[0].id);
        };
        var leave = function () {
          map.getCanvas().style.cursor = '';
          if (hoveredFeature && hoveredFeature.layerId === id) setHovered(null, null);
        };
        var click = function (event) {
          if (!event.features || !event.features.length) return;
          var original = event.originalEvent;
          if (original && original.__compactCustomGeoHandled) return;
          try { if (original) original.__compactCustomGeoHandled = true; } catch (_error) {}
          var feature = event.features[0];
          setSelected(id, feature.id);
          showPopup(event, feature);
        };
        map.on('mousemove', layerId, move);
        map.on('mouseleave', layerId, leave);
        map.on('click', layerId, click);
        handlers.push({ layerId: layerId, move: move, leave: leave, click: click });
      });
      interactionHandlersById[id] = handlers;
    }

    function unbindInteractions(id) {
      var handlers = interactionHandlersById[id] || [];
      handlers.forEach(function (entry) {
        try { map.off('mousemove', entry.layerId, entry.move); } catch (_error) {}
        try { map.off('mouseleave', entry.layerId, entry.leave); } catch (_error) {}
        try { map.off('click', entry.layerId, entry.click); } catch (_error) {}
      });
      delete interactionHandlersById[id];
    }

    function ensureLegendDom() {
      if (legendEl) return;
      var host = document.getElementById('main_container') || (map && map.getContainer && map.getContainer().parentNode) || document.body;
      legendEl = document.createElement('div');
      legendEl.id = 'customGeoLayerLegend';
      Object.assign(legendEl.style, {
        position: 'absolute', left: '124px', top: '50%', bottom: 'auto',
        transform: 'translateY(-50%)', zIndex: '1002',
        display: 'none', width: '280px', maxWidth: 'calc(100% - 140px)',
        maxHeight: 'calc(100vh - 32px)',
        color: '#fff', background: 'rgba(18,18,18,0.9)',
        border: '1px solid rgba(255,255,255,0.2)', borderRadius: '10px',
        boxShadow: '0 12px 30px rgba(0,0,0,0.35)',
        font: '12px/1.35 system-ui, sans-serif', pointerEvents: 'auto', overflow: 'hidden'
      });
      var header = document.createElement('div');
      Object.assign(header.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 10px', borderBottom: '1px solid rgba(255,255,255,0.14)' });
      legendTitleEl = document.createElement('strong');
      legendTitleEl.style.flex = '1';
      var collapse = document.createElement('button');
      collapse.type = 'button';
      collapse.textContent = '−';
      collapse.title = 'Collapse data-layer filters';
      Object.assign(collapse.style, { border: '0', background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: '17px', lineHeight: '1', padding: '1px 4px' });
      collapse.addEventListener('click', function () {
        legendCollapsed = !legendCollapsed;
        legendBodyEl.style.display = legendCollapsed ? 'none' : 'block';
        collapse.textContent = legendCollapsed ? '+' : '−';
        collapse.title = legendCollapsed ? 'Expand data-layer filters' : 'Collapse data-layer filters';
      });
      header.appendChild(legendTitleEl);
      header.appendChild(collapse);
      legendBodyEl = document.createElement('div');
      Object.assign(legendBodyEl.style, { maxHeight: '42vh', overflowY: 'auto', padding: '7px 9px 9px' });
      legendEl.appendChild(header);
      legendEl.appendChild(legendBodyEl);
      host.appendChild(legendEl);
    }

    function registryName(id) {
      for (var i = 0; i < registry.length; i++) {
        if (String(registry[i].id) === String(id)) return registry[i].name || registry[i].id;
      }
      return String(id || 'Data layer');
    }

    function updateCategoryControls(id, value, checkboxes, status) {
      var state = categoryStateById[id] || {};
      Object.keys(state).forEach(function (name) { state[name] = value; });
      checkboxes.forEach(function (checkbox) { checkbox.checked = value; });
      status.textContent = (value ? Object.keys(state).length : 0) + '/' + Object.keys(state).length + ' shown';
      applyCategoryFilter(id);
    }

    function renderLegend() {
      // Sublayer controls live in the workshop editor's Data Layers tree.
      // Remove the former floating map panel if this module is hot-reloaded.
      if (legendEl && legendEl.parentNode) legendEl.parentNode.removeChild(legendEl);
      legendEl = null;
      legendBodyEl = null;
      legendTitleEl = null;
    }

    // Refresh the id/name registry from the server. callback(err, registry).
    function refresh(callback) {
      fetch('/api/custom-layers', { cache: 'no-store' })
        .then(function (response) { return response.json(); })
        .then(function (data) {
          registry = data && Array.isArray(data.layers) ? data.layers : [];
          renderLegend();
          if (typeof callback === 'function') callback(null, registry);
        })
        .catch(function (error) {
          if (typeof callback === 'function') callback(error, registry);
        });
    }

    function list() { return registry.slice(); }
    function getName(id) { return registryName(id); }

    function getSublayers(id) {
      id = String(id || '');
      var meta = metaById[id];
      var state = categoryStateById[id] || {};
      if (!meta || !Array.isArray(meta.categories)) return null;
      return meta.categories.map(function (entry) {
        return {
          name: entry.name,
          label: entry.displayName || humanize(entry.name),
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
      if (typeof callback !== 'function') callback = function () {};
      id = String(id || '');
      if (dataById[id]) { callback(null, dataById[id]); return; }
      if (loadCallbacksById[id]) { loadCallbacksById[id].push(callback); return; }
      loadCallbacksById[id] = [callback];
      fetch('/api/custom-layers/' + encodeURIComponent(id))
        .then(function (response) {
          if (!response.ok) throw new Error('http_' + response.status);
          return response.json();
        })
        .then(function (geojson) {
          dataById[id] = prepareData(id, geojson);
          var callbacks = loadCallbacksById[id];
          delete loadCallbacksById[id];
          callbacks.forEach(function (done) { done(null, dataById[id]); });
          renderLegend();
        })
        .catch(function (error) {
          var callbacks = loadCallbacksById[id];
          delete loadCallbacksById[id];
          callbacks.forEach(function (done) { done(error, null); });
        });
    }

    function setLayerVisible(id, show) {
      id = String(id || '');
      visibleById[id] = !!show;
      if (show) ensureLayers(id);
      allLayerIds(id).forEach(function (layerId) {
        if (map && map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', show ? 'visible' : 'none');
      });
      if (!show && hoveredFeature && hoveredFeature.layerId === id) setHovered(null, null);
      renderLegend();
    }

    function hideAllExcept(keepIds) {
      var keep = {};
      (Array.isArray(keepIds) ? keepIds : []).forEach(function (id) { keep[String(id)] = true; });
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
        if (map && map.getLayer(layerId)) map.removeLayer(layerId);
      });
      if (map && map.getSource(srcId(id))) map.removeSource(srcId(id));
      delete dataById[id];
      delete visibleById[id];
      delete metaById[id];
      delete categoryStateById[id];
      renderLegend();
    }

    return {
      refresh: refresh,
      list: list,
      getName: getName,
      getSublayers: getSublayers,
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
