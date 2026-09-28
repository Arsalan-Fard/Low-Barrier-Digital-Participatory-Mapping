// The "Paper map" basemap: the map generator's style (the one the paper sheets are printed
// from), restyled so the table shows what the sheet shows. Its settings are the hidden
// inputs in #paperMapSettings (index.html), read at every style load. Loads after the map
// page scripts that publish window.CompactMapApp.
(function () {
  'use strict';

  var app = window.CompactMapApp;
  var map = app.getMap();
  var PAPER_THEME = 'paper';

  function $(id) {
    return document.getElementById(id);
  }

  // POI type groups over the OpenMapTiles `class` field, from a decoded z14 tile of this area
  // (8233 POIs, 78 classes). Street furniture alone is ~2600 of them, so it is off by default.
  var POI_TYPE_GROUPS = {
    food:      ['restaurant', 'cafe', 'fast_food', 'bar', 'beer', 'ice_cream', 'pub'],
    shop:      ['shop', 'grocery', 'bakery', 'butcher', 'clothing_store', 'alcohol_shop',
                'hairdresser', 'laundry', 'florist', 'jewelry', 'books', 'marketplace'],
    education: ['school', 'college', 'university', 'library', 'kindergarten'],
    health:    ['pharmacy', 'doctors', 'dentist', 'hospital', 'veterinary', 'clinic'],
    transport: ['bus', 'railway', 'subway', 'tram', 'ferry_terminal', 'airport',
                'bicycle_rental', 'car_rental', 'parking', 'fuel', 'charging_station'],
    leisure:   ['art_gallery', 'theatre', 'museum', 'cinema', 'attraction', 'castle',
                'park', 'garden', 'playground', 'pitch', 'sports_centre', 'swimming_pool',
                'dog_park', 'stadium', 'zoo', 'picnic_site'],
    civic:     ['town_hall', 'post', 'bank', 'atm', 'police', 'fire_station',
                'place_of_worship', 'office', 'lodging', 'embassy', 'courthouse',
                'community_centre'],
    street:    ['gate', 'bollard', 'lift_gate', 'cycle_barrier', 'waste_basket',
                'bicycle_parking', 'motorcycle_parking', 'recycling', 'drinking_water',
                'bench', 'toilets', 'shelter', 'entrance', 'information']
  };

  // Every class of a named group; any other class counts as "other".
  var POI_KNOWN_CLASSES = Object.keys(POI_TYPE_GROUPS).reduce(function (all, key) {
    return all.concat(POI_TYPE_GROUPS[key]);
  }, []);

  function poiTypeEnabled(name) {
    var input = document.querySelector('#poiCats input[data-poi="' + name + '"]');
    return !!(input && input.checked);
  }

  // The class test for the enabled groups: null when every group is on, false when none is.
  function poiClassFilter() {
    var groups = Object.keys(POI_TYPE_GROUPS);
    var enabled = groups.filter(poiTypeEnabled);
    var otherOn = poiTypeEnabled('other');
    if (enabled.length === groups.length && otherOn) return null;
    if (!enabled.length && !otherOn) return false;

    var allowed = [];
    enabled.forEach(function (key) {
      POI_TYPE_GROUPS[key].forEach(function (cls) {
        if (allowed.indexOf(cls) < 0) allowed.push(cls);
      });
    });
    var test = allowed.length ? ['match', ['get', 'class'], allowed, true, false] : null;
    if (otherOn) {
      // "Other" is any class no group claims, so unfamiliar classes elsewhere stay visible.
      var unknown = ['!', ['match', ['get', 'class'], POI_KNOWN_CLASSES, true, false]];
      test = test ? ['any', test, unknown] : unknown;
    }
    return test;
  }

  // Highest POI rank (1 = most important) shown at each #poiLevel. On the measured tile the
  // first four select about 12% / 21% / 32% / 55% of the POIs.
  var POI_RANK_CEILING = {
    1: 3,
    2: 6,
    3: 10,
    4: 20,
    5: 50,
    6: Infinity
  };

  // The #labelCats switches. highway-name-major holds four road classes in one layer, so
  // road categories are split by rewriting the road-name layers' class filters.
  var LABEL_CATEGORIES = {
    major:     { classes: ['trunk', 'primary'] },
    secondary: { classes: ['secondary', 'tertiary'] },
    minor:     { classes: ['minor'] },
    path:      { classes: ['path', 'service', 'track'] },
    place:     { layers: ['label_other', 'label_village', 'label_town', 'label_state',
                          'label_city', 'label_city_capital', 'label_country_1',
                          'label_country_2', 'label_country_3', 'airport'] },
    water:     { layers: ['water_name_point_label', 'water_name_line_label',
                          'waterway_line_label'] }
  };

  function labelCatEnabled(name) {
    var input = document.querySelector('#labelCats input[data-cat="' + name + '"]');
    return !!(input && input.checked);
  }

  // The #labelDensity levels. MapLibre culls colliding labels with 2px padding, a 250px
  // line-label spacing and text-optional false (a POI whose text does not fit loses its
  // icon too). Liberty keeps text at a fixed pixel size, so each zoom step out doubles a
  // label's ground footprint; `shrink` scales text and icons when zoomed out, which is what
  // buys back real room (a label's box shrinks as shrink^2).
  var LABEL_PACKING = [
    { padding: null, spacing: null, optional: false, shrink: 1.00 },
    { padding: 1,    spacing: 200,  optional: true,  shrink: 0.88 },
    { padding: 0,    spacing: 150,  optional: true,  shrink: 0.78 },
    { padding: 0,    spacing: 100,  optional: true,  shrink: 0.68 }
  ];
  var SHRINK_ZOOM_START = 17.5; // at/above this zoom: unchanged
  var SHRINK_ZOOM_END = 16;     // at/below this zoom: full shrink

  // `value` (a number or zoom expression) scaled by `factor` below SHRINK_ZOOM_START.
  function shrinkBySize(value, factor) {
    if (value === undefined || value === null || factor >= 1) return value;
    return ['interpolate', ['linear'], ['zoom'],
      SHRINK_ZOOM_END, ['*', value, factor],
      SHRINK_ZOOM_START, value
    ];
  }

  function currentPacking() {
    return LABEL_PACKING[Number($('labelDensity').value)] || LABEL_PACKING[0];
  }

  // symbol-spacing only affects line-placed labels; a placement expression may become 'line'.
  function isLinePlaced(placement) {
    if (placement === undefined || placement === null) return false;
    if (typeof placement === 'string') return placement !== 'point';
    return true;
  }

  function setLayout(layerId, prop, value) {
    try { map.setLayoutProperty(layerId, prop, value); } catch (_e) {}
  }

  function setLayerVisible(id, visible) {
    setLayout(id, 'visibility', visible ? 'visible' : 'none');
  }

  // null restores the layer's stock value, captured before any edit.
  function applyPackingTo(layerId, base) {
    var packing = currentPacking();
    setLayout(layerId, 'text-padding', packing.padding === null ? base.textPadding : packing.padding);
    setLayout(layerId, 'text-optional', packing.optional ? true : base.textOptional);
    if (isLinePlaced(base.placement)) {
      setLayout(layerId, 'symbol-spacing', packing.spacing === null ? base.symbolSpacing : packing.spacing);
    }
    if (base.textSize !== undefined) setLayout(layerId, 'text-size', shrinkBySize(base.textSize, packing.shrink));
    if (base.iconSize !== undefined) setLayout(layerId, 'icon-size', shrinkBySize(base.iconSize, packing.shrink));
  }

  // #poiOverlapOn lets POI icons (and, with #poiOverlapLabels, their names) skip collision;
  // otherwise #poiCollisionDistance pads the icons' collision boxes. Text stays optional in
  // every mode, so an icon is judged by its own small box and never lost with its long name.
  function applyPoiOverlap(layerId, base) {
    var overlapOn = $('poiOverlapOn').checked;
    var labelsToo = overlapOn && $('poiOverlapLabels').checked;
    function stock(value) {
      return value === undefined ? null : value;
    }

    setLayout(layerId, 'icon-padding', Number($('poiCollisionDistance').value));
    setLayout(layerId, 'text-padding', stock(base.textPadding));
    setLayout(layerId, 'text-optional', true);
    if (!overlapOn) {
      // A name placed by an earlier POI layer must not block the icons of later ones.
      setLayout(layerId, 'text-ignore-placement', true);
      setLayout(layerId, 'icon-allow-overlap', stock(base.iconAllowOverlap));
      setLayout(layerId, 'icon-ignore-placement', stock(base.iconIgnorePlacement));
      setLayout(layerId, 'text-allow-overlap', stock(base.textAllowOverlap));
      return;
    }

    setLayout(layerId, 'icon-allow-overlap', true);
    setLayout(layerId, 'icon-ignore-placement', true);
    if (!labelsToo) {
      setLayout(layerId, 'text-allow-overlap', stock(base.textAllowOverlap));
      setLayout(layerId, 'text-ignore-placement', stock(base.textIgnorePlacement));
      return;
    }
    setLayout(layerId, 'text-allow-overlap', true);
    setLayout(layerId, 'text-ignore-placement', true);
  }

  // POIs this page always hides, while the generator still prints them: health markers by
  // the generator's category metadata (so no rank can come back), and the transit layers,
  // which carry no category.
  var PAGE_HIDDEN_POI_CATEGORIES = ['health'];
  var PAGE_HIDDEN_POI_LAYERS = ['transit_metro_station', 'transit_metro_entrance', 'transit_bus'];

  function pageHidesPoiLayer(layer) {
    if (PAGE_HIDDEN_POI_LAYERS.indexOf(layer.id) >= 0) return true;
    var category = (layer.metadata || {})['paper:poi-category'];
    return PAGE_HIDDEN_POI_CATEGORIES.indexOf(category) >= 0;
  }

  // The lowest rank a generator POI bucket admits (its `rank >= N`), or null.
  function bucketMinRank(filter) {
    if (!Array.isArray(filter)) return null;
    if (filter[0] === 'all' || filter[0] === 'any') {
      for (var i = 1; i < filter.length; i++) {
        var found = bucketMinRank(filter[i]);
        if (found !== null) return found;
      }
      return null;
    }
    var getsRank = Array.isArray(filter[1]) && filter[1][0] === 'get' && filter[1][1] === 'rank';
    return filter[0] === '>=' && getsRank && Number.isFinite(filter[2]) ? filter[2] : null;
  }

  function poiLayerFacts(layer) {
    var meta = layer.metadata || {};
    return {
      filter: layer.filter ? JSON.parse(JSON.stringify(layer.filter)) : null,
      category: meta['paper:poi-category'] || '',
      bucket: meta['paper:poi-rank-level'] || '',
      // The generator publishes its POI buckets with the detailed ranks switched off.
      styleOff: (layer.layout || {}).visibility === 'none',
      pageHidden: pageHidesPoiLayer(layer)
    };
  }

  // The categories the style shows at least one bucket of; a category it switched off
  // entirely stays off at every level.
  function poiCategoriesOn(layers) {
    var on = {};
    layers.forEach(function (layer) {
      var meta = layer.metadata || {};
      if (layer['source-layer'] !== 'poi' || !meta['paper:poi-rank-level']) return;
      if ((layer.layout || {}).visibility !== 'none') on[meta['paper:poi-category']] = true;
    });
    return on;
  }

  // The filter a POI layer draws with at the current level, or false to hide it. A generator
  // bucket keeps its own rank band and gets the ceiling added: swapping the band for the
  // ceiling drew each POI once per bucket, plus ranks the sheet never had. A bucket the style
  // switched off comes back only once the ceiling reaches into its band.
  function poiLayerFilter(facts, ceiling, classes, categoriesOn) {
    if (facts.pageHidden) return false;
    var next;
    if (facts.bucket) {
      if (facts.styleOff) {
        var floor = bucketMinRank(facts.filter);
        if (floor === null || floor > ceiling || !categoriesOn[facts.category]) return false;
      }
      next = facts.filter;
    } else {
      if (facts.styleOff) return false;
      next = withoutRankTests(facts.filter);
    }
    if (ceiling !== Infinity) {
      var test = ['<=', ['get', 'rank'], ceiling];
      next = next ? ['all', next, test] : test;
    }
    if (classes) next = next ? ['all', next, classes] : classes;
    return next;
  }

  // Road names collide as in the generator's default road mode (liberty lets
  // highway-name-minor overlap everything); where two names contest a spot, the lesser road gives way.
  var ROAD_CLASS_RANK = ['match', ['get', 'class'],
    ['motorway', 'trunk'], 0, 'primary', 1, 'secondary', 2, 'tertiary', 3,
    ['minor', 'street'], 4, ['service', 'track'], 5, 6];

  function applyRoadNameCollision(layerId) {
    setLayout(layerId, 'text-allow-overlap', false);
    setLayout(layerId, 'text-ignore-placement', false);
    setLayout(layerId, 'text-overlap', 'never');
    setLayout(layerId, 'symbol-sort-key', ROAD_CLASS_RANK);
  }

  // Captured from the unmodified style, so repeated edits never compound.
  var baseLayerState = {};
  var basePoiCategoriesOn = {};

  function captureBaseLayerState() {
    var layers = map.getStyle().layers;
    baseLayerState = {};
    basePoiCategoriesOn = poiCategoriesOn(layers);
    layers.forEach(function (layer) {
      if (layer.type !== 'symbol') return;
      var layout = layer.layout || {};
      var isPoi = layer['source-layer'] === 'poi';
      baseLayerState[layer.id] = {
        maxzoom: Number.isFinite(layer.maxzoom) ? layer.maxzoom : 24,
        filter: layer.filter ? JSON.parse(JSON.stringify(layer.filter)) : null,
        isPoi: isPoi,
        poi: isPoi ? poiLayerFacts(layer) : null,
        placement: layout['symbol-placement'],
        textPadding: layout['text-padding'],
        textOptional: layout['text-optional'],
        textAllowOverlap: layout['text-allow-overlap'],
        textIgnorePlacement: layout['text-ignore-placement'],
        iconAllowOverlap: layout['icon-allow-overlap'],
        iconIgnorePlacement: layout['icon-ignore-placement'],
        symbolSpacing: layout['symbol-spacing'],
        textSize: layout['text-size'],
        iconSize: layout['icon-size']
      };
    });
  }

  // A non-bucket POI layer's stock filter without its rank tests, so the level's ceiling is
  // the only rank condition left.
  function withoutRankTests(filter) {
    if (!Array.isArray(filter)) return null;
    var head = filter[0];
    if (head === 'all' || head === 'any') {
      var kept = filter.slice(1).map(withoutRankTests).filter(Boolean);
      return kept.length ? [head].concat(kept) : null;
    }
    var mentionsRank = JSON.stringify(filter).indexOf('"rank"') >= 0;
    if (mentionsRank && ['>=', '<=', '>', '<', '==', '!='].indexOf(head) >= 0) return null;
    return filter;
  }

  // A road-name layer's stock filter without its class tests, so the category switches
  // decide the classes alone.
  function withoutClassTests(filter) {
    if (!Array.isArray(filter)) return null;
    var head = filter[0];
    if (head === 'all' || head === 'any') {
      var kept = filter.slice(1).map(withoutClassTests).filter(Boolean);
      return kept.length ? [head].concat(kept) : null;
    }
    var mentionsClass = JSON.stringify(filter).indexOf('"class"') >= 0;
    if (mentionsClass && (head === 'match' || head === '==' || head === '!=' || head === 'in')) return null;
    return filter;
  }

  function allowedRoadClasses() {
    var allowed = [];
    ['major', 'secondary', 'minor', 'path'].forEach(function (name) {
      if (!labelCatEnabled(name)) return;
      LABEL_CATEGORIES[name].classes.forEach(function (cls) {
        if (allowed.indexOf(cls) < 0) allowed.push(cls);
      });
    });
    return allowed;
  }

  // The classes a road-name layer labels itself, from its own class test, or null.
  function roadLayerClasses(filter) {
    if (!Array.isArray(filter)) return null;
    var head = filter[0];
    if (head === 'all' || head === 'any') {
      for (var i = 1; i < filter.length; i++) {
        var found = roadLayerClasses(filter[i]);
        if (found) return found;
      }
      return null;
    }
    if (filter[1] === 'class') { // legacy filter syntax
      if (head === 'in') return filter.slice(2);
      if (head === '==') return [filter[2]];
      return null;
    }
    var getsClass = Array.isArray(filter[1]) && filter[1][0] === 'get' && filter[1][1] === 'class';
    if (!getsClass) return null;
    if (head === '==' || head === 'match') return [].concat(filter[2]);
    return null;
  }

  // Only the enabled classes this layer labels itself: one shared list for all three
  // road-name layers drew every street name up to three times.
  function roadClassesFor(filter) {
    var allowed = allowedRoadClasses();
    var own = roadLayerClasses(filter);
    return own ? allowed.filter(function (cls) { return own.indexOf(cls) >= 0; }) : allowed;
  }

  var ROAD_NAME_LAYERS = ['highway-name-major', 'highway-name-minor', 'highway-name-path'];

  function categoryLayerIds(names) {
    var ids = [];
    names.forEach(function (name) {
      LABEL_CATEGORIES[name].layers.forEach(function (id) {
        if (ids.indexOf(id) < 0) ids.push(id);
      });
    });
    return ids;
  }

  // Every symbol layer gets the packing. Shown POI and label layers are forced visible from
  // zoom 0, so a setting holds at any zoom; MapLibre still culls overlapping text.
  function applyDetailLevels() {
    var poiEnabled = $('poiOn').checked;
    var labelEnabled = $('labelOn').checked;
    var poiCeiling = POI_RANK_CEILING[Number($('poiLevel').value)] || 10;
    var poiClasses = poiClassFilter();
    var placeIds = categoryLayerIds(['place']);
    var waterIds = categoryLayerIds(['water']);
    var placeOn = labelCatEnabled('place');
    var waterOn = labelCatEnabled('water');

    Object.keys(baseLayerState).forEach(function (id) {
      var base = baseLayerState[id];
      applyPackingTo(id, base);
      if (base.isPoi) {
        if (!poiEnabled || poiClasses === false) {
          setLayerVisible(id, false);
          return;
        }
        applyPoiOverlap(id, base);
        var poiFilter = poiLayerFilter(base.poi, poiCeiling, poiClasses, basePoiCategoriesOn);
        if (poiFilter === false) {
          setLayerVisible(id, false);
          return;
        }
        setLayerVisible(id, true);
        try { map.setFilter(id, poiFilter); } catch (_e) {}
        try { map.setLayerZoomRange(id, 0, base.maxzoom); } catch (_e) {}
        return;
      }

      if (!labelEnabled) {
        setLayerVisible(id, false);
        return;
      }

      if (ROAD_NAME_LAYERS.indexOf(id) >= 0) {
        var roadClasses = roadClassesFor(base.filter);
        if (!roadClasses.length) {
          setLayerVisible(id, false);
          return;
        }
        var rebuilt = withoutClassTests(base.filter);
        var classTest = ['match', ['get', 'class'], roadClasses, true, false];
        try { map.setFilter(id, rebuilt ? ['all', rebuilt, classTest] : classTest); } catch (_e) {}
        applyRoadNameCollision(id);
        setLayerVisible(id, true);
        try { map.setLayerZoomRange(id, 0, base.maxzoom); } catch (_e) {}
        return;
      }

      var keep = (placeIds.indexOf(id) >= 0 && placeOn) || (waterIds.indexOf(id) >= 0 && waterOn);
      setLayerVisible(id, keep);
      if (!keep) return;
      try { map.setLayerZoomRange(id, 0, base.maxzoom); } catch (_e) {}
    });
  }

  // #buildingMode. "As styled" leaves the buildings exactly as the generator has them:
  // liberty ends its flat building layer at z14 and hands over to an extrusion layer the
  // generator keeps off. The other modes need footprints to draw with, so they extend the
  // flat layer over the working zooms.
  function applyBuildings() {
    var mode = $('buildingMode').value;
    function paint(prop, value) {
      try { map.setPaintProperty('building', prop, value); } catch (_e) {}
    }
    if (mode === 'style') return;
    try { map.setLayerZoomRange('building', 13, 24); } catch (_e) {}
    if (mode === 'hide') {
      setLayerVisible('building', false);
      return;
    }
    setLayerVisible('building', true);
    if (mode === 'fade') {
      paint('fill-opacity', 0.25);
      paint('fill-outline-color', 'rgba(0,0,0,0)');
    } else if (mode === 'outline') {
      // A near-clear body with a visible edge: footprints stay as cues, inside free to draw on.
      paint('fill-opacity', 0.06);
      paint('fill-outline-color', 'rgba(120,112,100,0.85)');
    } else {
      paint('fill-opacity', 1);
      // The stock outline colour is a zoom ramp ending at z14; a plain edge reads at every zoom.
      paint('fill-outline-color', 'hsl(35,6%,72%)');
    }
  }

  // Extruded blocks hide the streets being drawn on and skew the flat printable view.
  function removeBuildingExtrusions() {
    map.getStyle().layers.forEach(function (layer) {
      if (layer.type === 'fill-extrusion') setLayerVisible(layer.id, false);
    });
  }

  // The generator marks the programme's colleges with a red star for the printed sheets;
  // this page serves any workshop, so the stars come off here.
  var SCHOOL_SOURCE = 'workshop-schools';

  function removeWorkshopSchools() {
    map.getStyle().layers.forEach(function (layer) {
      if (layer.source === SCHOOL_SOURCE && map.getLayer(layer.id)) map.removeLayer(layer.id);
    });
    if (map.getSource(SCHOOL_SOURCE)) map.removeSource(SCHOOL_SOURCE);
  }

  // A basemap switch rebuilds the style, so the Paper map is restyled after every load.
  function onStyleLoad() {
    if (app.getActiveTheme() !== PAPER_THEME) return;
    removeWorkshopSchools();
    removeBuildingExtrusions();
    captureBaseLayerState();
    applyDetailLevels();
    applyBuildings();
  }
  map.on('style.load', onStyleLoad);
  if (map.isStyleLoaded()) onStyleLoad();
})();
