(function () {
  function cloneStyle(style) {
    if (!style || typeof style !== 'object') return style;
    try {
      return JSON.parse(JSON.stringify(style));
    } catch (_error) {
      return style;
    }
  }

  // themeStyles: theme name -> style (object or URL).
  function initMap(options) {
    var config = options.config;
    var themeStyles = options.themeStyles;
    var onStyleLoad = options.onStyleLoad;
    var initialTheme = options.initialTheme;
    var currentTheme = initialTheme;
    var map = new mapboxgl.Map({
      container: 'map',
      style: cloneStyle(themeStyles[initialTheme]),
      center: config.center,
      zoom: config.zoom,
      pitch: config.pitch,
      bearing: config.bearing,
      attributionControl: config.attributionControl,
      // Explicit: MapLibre defaults this to true.
      trackResize: false
    });

    map.on('style.load', onStyleLoad);

    function applyTheme(theme) {
      var nextTheme = Object.prototype.hasOwnProperty.call(themeStyles, theme) ? String(theme) : initialTheme;
      var sameTheme = nextTheme === currentTheme;
      currentTheme = nextTheme;
      if (sameTheme && map.isStyleLoaded()) {
        onStyleLoad();
        return { theme: currentTheme, reloaded: false };
      }
      // diff: false forces a full reload, which re-fires 'style.load'; the
      // default diffing setStyle can skip it and leave the custom layers wiped.
      map.setStyle(cloneStyle(themeStyles[nextTheme]), { diff: false });
      return { theme: currentTheme, reloaded: true };
    }

    return {
      map: map,
      applyTheme: applyTheme,
      getCurrentTheme: function () {
        return currentTheme;
      }
    };
  }

  // The paper sheets are designed in the Maputnik generator, so the "paper"
  // layer shows the generator's style. Maputnik is same-origin and keeps its
  // working copy in localStorage, which carries edits never re-bundled, so an
  // intact saved copy wins over the bundled file (whose sprite URLs the server rewrites).
  var GENERATOR_STYLE_URL = '/maputnik/styles/liberty.json';
  var GENERATOR_STYLE_KEY = 'maputnik:latest_style';

  // MapLibre needs absolute sprite URLs. Root-relative ones go on this origin,
  // and so do ones baked in under another LOCAL address (other port, localhost
  // vs LAN IP). Public hosts are left alone: OpenFreeMap's sprite path also
  // starts with /sprites/, and one failed sprite drops every icon on the map.
  var PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|.*\.local)$/i;

  function rehostAsset(url) {
    if (typeof url !== 'string' || !url) return url;
    if (url.charAt(0) === '/') return window.location.origin + url;
    try {
      var parsed = new URL(url, window.location.href);
      if (parsed.origin !== window.location.origin && PRIVATE_HOST.test(parsed.hostname)) {
        return window.location.origin + parsed.pathname;
      }
    } catch (_error) {
      // Leave anything unparseable alone.
    }
    return url;
  }

  function normalizeGeneratorStyle(style) {
    if (Array.isArray(style.sprite)) {
      style.sprite.forEach(function (entry) {
        if (entry && typeof entry === 'object') entry.url = rehostAsset(entry.url);
      });
    } else if (typeof style.sprite === 'string') {
      style.sprite = rehostAsset(style.sprite);
    }
    if (typeof style.glyphs === 'string' && style.glyphs.charAt(0) === '/') {
      style.glyphs = window.location.origin + style.glyphs;
    }
    return style;
  }

  function generatorStyle() {
    var raw = null;
    try {
      raw = window.localStorage.getItem(GENERATOR_STYLE_KEY);
    } catch (_error) {
      // Private browsing: use the bundled file.
    }
    if (raw) {
      try {
        var stored = JSON.parse(raw);
        var usable = stored && Number(stored.version) === 8
          && Array.isArray(stored.layers) && stored.layers.length
          && stored.sources && typeof stored.sources === 'object';
        if (usable) return normalizeGeneratorStyle(stored);
      } catch (_error) {
        // Corrupt entry: use the bundled file.
      }
    }
    return GENERATOR_STYLE_URL;
  }

  // The font for a symbol layer added over the basemap. Glyphs come from the
  // active style's server, and a font that server lacks never draws (the raster
  // styles serve Open Sans, the generator's OpenFreeMap only Noto Sans), so use
  // the style's own label font, bold if it has one, else the fallback.
  function labelFont(map, fallback) {
    var layers = [];
    try {
      layers = (map.getStyle() || {}).layers || [];
    } catch (_error) {
      // Mid style swap.
    }
    var first = null;
    for (var i = 0; i < layers.length; i++) {
      var font = layers[i] && layers[i].layout && layers[i].layout['text-font'];
      if (!Array.isArray(font) || !font.length || typeof font[0] !== 'string') continue;
      if (/bold/i.test(font[0])) return font.slice();
      if (!first) first = font.slice();
    }
    return first || fallback;
  }

  window.CompactMapSetup = {
    initMap: initMap,
    labelFont: labelFont,
    generatorStyle: generatorStyle
  };
})();
