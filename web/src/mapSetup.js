(function () {
  function cloneStyle(style) {
    if (!style || typeof style !== 'object') return style;
    try {
      return JSON.parse(JSON.stringify(style));
    } catch (_error) {
      return style;
    }
  }

  function normalizeThemeDefinition(definition, fallbackStyle) {
    if (typeof definition === 'string') {
      return {
        style: definition,
        styleOptions: null,
        useBuiltIn3D: false
      };
    }

    if (definition && typeof definition === 'object') {
      if (Number(definition.version) === 8 && Array.isArray(definition.layers)) {
        return {
          style: cloneStyle(definition),
          styleOptions: null,
          useBuiltIn3D: true
        };
      }
      return {
        style: cloneStyle(definition.style || fallbackStyle),
        styleOptions: definition.config ? { config: definition.config } : null,
        useBuiltIn3D: Boolean(definition.useBuiltIn3D)
      };
    }

    return {
      style: cloneStyle(fallbackStyle),
      styleOptions: null,
      useBuiltIn3D: false
    };
  }

  function add3DBuildings(map) {
    if (!map || typeof map.getLayer !== 'function') return;
    if (map.getLayer('add-3d-buildings')) return;

    var style = typeof map.getStyle === 'function' ? map.getStyle() : null;
    // The 3D buildings layer needs a vector "composite" source (Mapbox styles).
    // OSM raster / satellite / floorplan styles don't have it; bail before
    // addLayer() so MapLibre doesn't log a "source composite not found"
    // validation error to the console (try/catch can't suppress that log).
    var sources = (style && style.sources) || {};
    if (!sources.composite) return;
    var layers = style && Array.isArray(style.layers) ? style.layers : [];
    var beforeId = null;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (layer && layer.type === 'symbol' && layer.layout && layer.layout['text-field']) {
        beforeId = layer.id;
        break;
      }
    }

    try {
      map.addLayer({
        id: 'add-3d-buildings',
        source: 'composite',
        'source-layer': 'building',
        filter: ['==', 'extrude', 'true'],
        type: 'fill-extrusion',
        minzoom: 15,
        paint: {
          'fill-extrusion-color': '#aaa',
          'fill-extrusion-height': ['coalesce', ['get', 'height'], 0],
          'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
          'fill-extrusion-opacity': 0.6
        }
      }, beforeId || undefined);
    } catch (_error) {
      // Ignore styles that do not expose the expected building source.
    }
  }

  function initMap(options) {
    var config = options && options.config ? options.config : {};
    var themeStyles = options && options.themeStyles ? options.themeStyles : {};
    var onStyleLoad = options && typeof options.onStyleLoad === 'function'
      ? options.onStyleLoad
      : function () {};
    var initialTheme = options && options.initialTheme ? String(options.initialTheme) : '';
    var fallbackStyle = config.style || {
      version: 8,
      sources: {},
      layers: [
        { id: 'fallback-bg', type: 'background', paint: { 'background-color': '#e5e7eb' } }
      ]
    };

    function getThemeDefinition(theme) {
      return normalizeThemeDefinition(themeStyles[theme], fallbackStyle);
    }

    var defaultThemeDefinition = getThemeDefinition(initialTheme);

    mapboxgl.accessToken = config.useMapboxServices ? (config.accessToken || '') : '';

    var currentTheme = initialTheme;
    var currentThemeDefinition = defaultThemeDefinition;
    var map = new mapboxgl.Map({
      container: 'map',
      style: currentThemeDefinition.style,
      center: config.center || [0, 0],
      zoom: Number.isFinite(config.zoom) ? config.zoom : 15,
      pitch: Number.isFinite(config.pitch) ? config.pitch : 0,
      bearing: Number.isFinite(config.bearing) ? config.bearing : 0,
      attributionControl: config.attributionControl !== false,
      trackResize: false,
      ...(currentThemeDefinition.styleOptions || {})
    });

    // Fire onStyleLoad every time a style finishes applying. 'style.load' fires
    // for the initial style and — because applyTheme() calls setStyle() with
    // { diff: false } — for every basemap switch too. (With MapLibre's default
    // diff mode, setStyle() to a new style did NOT re-fire 'style.load', so our
    // custom layers were wiped and never re-added. Forcing a full reload via
    // diff:false restores the event.)
    map.on('style.load', function () {
      if (!currentThemeDefinition.useBuiltIn3D) {
        add3DBuildings(map);
      }
      onStyleLoad({
        map: map,
        theme: currentTheme
      });
    });

    // The OSM theme family (light/dark/dawn) is the same single raster layer
    // pulling the same tiles; the themes differ ONLY in raster paint
    // (brightness/saturation). For those, swapping the whole style via
    // setStyle() is wasteful and destructive: it tears down every source and
    // layer — including the draw layers — and reloads asynchronously, which is
    // what broke live drawing on the first workshop step. Instead we detect
    // that case and update the existing raster layer's paint in place, so the
    // map (and all custom layers) stay loaded throughout.
    function rasterThemeInfo(definition) {
      var style = definition && definition.style;
      if (!style || typeof style !== 'object') return null;
      var layers = Array.isArray(style.layers) ? style.layers : [];
      if (layers.length !== 1) return null;
      var layer = layers[0];
      if (!layer || layer.type !== 'raster' || !layer.source) return null;
      var sources = style.sources || {};
      var source = sources[layer.source];
      if (!source || source.type !== 'raster') return null;
      var tiles = Array.isArray(source.tiles) ? source.tiles.join('|') : '';
      return { tilesKey: tiles, paint: layer.paint || {} };
    }

    // Raster paint properties used by the OSM themes. We reset all of them on
    // every in-place switch so a theme that omits a property reverts to the
    // raster default rather than inheriting the previous theme's value.
    var RASTER_PAINT_KEYS = [
      'raster-brightness-min',
      'raster-brightness-max',
      'raster-saturation',
      'raster-contrast',
      'raster-hue-rotate',
      'raster-opacity'
    ];

    function applyRasterPaintInPlace(nextDefinition) {
      var style = typeof map.getStyle === 'function' ? map.getStyle() : null;
      var layers = style && Array.isArray(style.layers) ? style.layers : [];
      var rasterLayerId = null;
      for (var i = 0; i < layers.length; i++) {
        if (layers[i] && layers[i].type === 'raster') { rasterLayerId = layers[i].id; break; }
      }
      if (!rasterLayerId) return false;
      var paint = (rasterThemeInfo(nextDefinition) || {}).paint || {};
      for (var k = 0; k < RASTER_PAINT_KEYS.length; k++) {
        var key = RASTER_PAINT_KEYS[k];
        // undefined resets the property to its spec default.
        map.setPaintProperty(rasterLayerId, key, paint[key]);
      }
      return true;
    }

    function applyTheme(theme) {
      var previousTheme = currentTheme;
      var previousThemeDefinition = currentThemeDefinition;
      var nextTheme = Object.prototype.hasOwnProperty.call(themeStyles, theme)
        ? String(theme)
        : initialTheme;
      var nextThemeDefinition = getThemeDefinition(nextTheme);
      currentTheme = nextTheme;
      currentThemeDefinition = nextThemeDefinition;

      if (previousTheme === nextTheme && (!map.isStyleLoaded || map.isStyleLoaded())) {
        if (!currentThemeDefinition.useBuiltIn3D) {
          add3DBuildings(map);
        }
        onStyleLoad({
          map: map,
          theme: currentTheme
        });
        // No setStyle() reload — the style stays loaded throughout.
        return { theme: currentTheme, reloaded: false };
      }

      // Same raster source on both sides (only paint differs) → update paint in
      // place, no reload. Requires the current style to already be loaded so the
      // raster layer exists to patch.
      var prevRaster = rasterThemeInfo(previousThemeDefinition);
      var nextRaster = rasterThemeInfo(nextThemeDefinition);
      if (prevRaster && nextRaster && prevRaster.tilesKey === nextRaster.tilesKey
          && (!map.isStyleLoaded || map.isStyleLoaded())
          && applyRasterPaintInPlace(nextThemeDefinition)) {
        if (!currentThemeDefinition.useBuiltIn3D) {
          add3DBuildings(map);
        }
        // Notify like a style settle so custom layers (re)assert themselves,
        // mirroring the setStyle() path's 'style.load' callback.
        onStyleLoad({
          map: map,
          theme: currentTheme
        });
        return { theme: currentTheme, reloaded: false };
      }

      // setStyle() tears down every source and layer and reloads. We force
      // diff:false so MapLibre does a FULL reload and re-fires 'style.load';
      // its default diff mode can skip the event, which left our custom layers
      // (drawings, roads, etc.) wiped and never re-added. Callers treat this as
      // a reload and re-add their layers from the onStyleLoad handler.
      var styleOptions = Object.assign({ diff: false }, nextThemeDefinition.styleOptions || {});
      map.setStyle(nextThemeDefinition.style, styleOptions);
      return { theme: currentTheme, reloaded: true };
    }

    return {
      map: map,
      applyTheme: applyTheme,
      getCurrentTheme: function () {
        return currentTheme;
      },
      getThemeStyle: function (theme) {
        return getThemeDefinition(theme).style || '';
      }
    };
  }

  window.CompactMapSetup = {
    add3DBuildings: add3DBuildings,
    initMap: initMap
  };
})();
