// Map page: the map view sheets. Marker Setting can define several, each with its own border
// tags; while the camera sees one on the table, printedScreen.js warps its inset onto it. A sheet
// shows the view the Project panel assigned to it (the table's map as it was when the sheet's
// button was pressed, shrunk to fit the sheet) or, with none assigned, a close-up map round the
// street view pointer, turned like the table's map. Both show a cone where the street view
// pointer stands, the way the street view looks.
// People draw on the sheets with pens. Nothing flashes: each sheet reports what it shows to the
// paper watcher (backend/paper_watch.py, POST /api/map-screen/watch) every MAP_VIEW_WATCH_EVERY_MS,
// and the watcher photographs the paper whenever no hand is over it. It compares the photo with
// the page's blank sheet under the same map, and the lines and points drawn since join the
// table's drawings.
// The sheet of paper keeps its map (a "page") while the pointer is lifted. When the map it
// shows changes (another view assigned; or, following the pointer, the table map panned, zoomed
// or turned, or the pointer put somewhere else) the ink on it belongs to the old map: the old map
// stays up until the watcher has read the paper once more (at most MAP_VIEW_CLOSE_WAIT_MS), and
// the sheet asks for a fresh sheet of paper for MAP_VIEW_MOVED_NOTE_MS. A new sheet cannot be told
// from the old one, so the note simply times out and the new map comes up.
const MAP_VIEW_ZOOM_STEP = 2;            // zoom levels closer than the table: four times the scale
const MAP_VIEW_MAX_ZOOM = 19;
const MAP_VIEW_POINTER_HOLD_MS = 3000;   // the cone stays this long once the pointer is lost
const MAP_VIEW_MOVED_PX = 4;             // pixels the page's centre may drift (pointer jitter) before it has moved
const MAP_VIEW_WATCH_EVERY_MS = 400;
const MAP_VIEW_CLOSE_WAIT_MS = 8000;     // a moved page waits this long at most for its last reading
const MAP_VIEW_CONE_RADIUS_PX = 80;      // half the cone's box (.map-view-inset__cone), in inset px
const MAP_VIEW_MOVED_NOTE_MS = 10000;    // counted while the sheet is on the table
const MAP_VIEW_MOVED_NOTE = 'The map has moved. Put a fresh sheet of paper here.';
const MAP_VIEW_IDLE_NOTE = 'Place the street view pointer on the map, or put a map view on this sheet from the Project panel';
const MAP_VIEW_INSET_HTML = '<div class="map-view-inset__map"></div>' +
  // Where the street view pointer stands and the way the street view looks (80 degrees).
  '<svg class="map-view-inset__cone" viewBox="-100 -100 200 200" aria-hidden="true">' +
  '<path d="M0 0 L-55.3 -65.9 A86 86 0 0 1 55.3 -65.9 Z" /><circle r="14" /></svg>';
// One per map view sheet with at least two border tags, in Marker Setting order. Each holds its
// inset, its printed screen and its own page, map and reports; see createMapViewSheet.
const mapViewSheets = [];
let mapViewPointer = null;               // { lng, lat } where the pointer last stood on the map
let mapViewPointerSeenMs = 0;
let mapViewHeading = 0;
let mapViewLastPollMs = 0;

// The floorplan basemap is drawn by the table map's own layers, and an empty sheet shows no place,
// so for those the street map stands in.
function mapViewStyleTheme() {
  return activeMapTheme === MAP_THEME_FLOORPLAN || activeMapTheme === MAP_THEME_BLANK || !mapThemeStyles[activeMapTheme]
    ? MAP_THEME_STREETS : activeMapTheme;
}

// A copy: MapLibre may keep the style object it is given, and the table map uses the same one.
function mapViewStyle(theme) {
  const style = mapThemeStyles[theme];
  return style && typeof style === 'object' ? JSON.parse(JSON.stringify(style)) : style;
}

function mapViewZoom() {
  return Math.min(MAP_VIEW_MAX_ZOOM, map.getZoom() + MAP_VIEW_ZOOM_STEP);
}

// Web Mercator pixels of a place at a zoom (MapLibre's 512 px tiles).
function mapViewWorldPx(lng, lat, zoom) {
  const world = 512 * Math.pow(2, zoom);
  const s = Math.sin(lat * Math.PI / 180);
  return [(lng + 180) / 360 * world, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world];
}

// The table map's camera now, with the size in CSS px of the map it is drawn on: what a sheet's
// button puts on that sheet.
function mapViewTableView() {
  const centre = map.getCenter();
  const box = map.getContainer();
  return {
    lng: centre.lng,
    lat: centre.lat,
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    width: box.clientWidth,
    height: box.clientHeight
  };
}

// A stored view, checked; null when it is not one.
function cleanMapSheetView(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const view = {};
  for (const key of ['lng', 'lat', 'zoom', 'bearing', 'width', 'height']) {
    const value = Number(raw[key]);
    if (!Number.isFinite(value)) return null;
    view[key] = value;
  }
  if (view.width < 1 || view.height < 1 || Math.abs(view.lat) > 85 || Math.abs(view.lng) > 180) return null;
  return view;
}

// The map a sheet would show now, or null: its assigned view shrunk so all of it fits the
// sheet's inside, else a close-up round the street view pointer (once it was ever on the map).
function mapViewTarget(sheet) {
  if (sheet.assigned) {
    const size = sheet.screen.viewSize();
    if (!size) return null;
    const view = sheet.assigned;
    const fit = Math.min(size.width / view.width, size.height / view.height);
    return { lng: view.lng, lat: view.lat, zoom: Math.max(0, view.zoom + Math.log2(fit)), bearing: view.bearing, pinned: true };
  }
  if (!mapViewPointer) return null;
  return { lng: mapViewPointer.lng, lat: mapViewPointer.lat, zoom: mapViewZoom(), bearing: map.getBearing(), pinned: false };
}

function mapViewPageMoved(page, target) {
  if (page.pinned !== target.pinned) return true;
  if (Math.abs(page.zoom - target.zoom) > 0.01) return true;
  if (Math.abs(((target.bearing - page.bearing) % 360 + 540) % 360 - 180) > 0.5) return true;
  // An assigned view in the sheet's own pixels; the pointer in the table map's.
  const a = page.pinned ? mapViewWorldPx(page.lng, page.lat, page.zoom) : (function (p) { return [p.x, p.y]; })(map.project([page.lng, page.lat]));
  const b = page.pinned ? mapViewWorldPx(target.lng, target.lat, page.zoom) : (function (p) { return [p.x, p.y]; })(map.project([target.lng, target.lat]));
  return Math.hypot(a[0] - b[0], a[1] - b[1]) >= MAP_VIEW_MOVED_PX;
}

function openMapViewPage(sheet, target, nowMs) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  sheet.page = {
    id: 'page-' + stamp + '-' + Math.random().toString(36).slice(2, 6),
    lng: target.lng,
    lat: target.lat,
    zoom: target.zoom,
    bearing: target.bearing,
    pinned: target.pinned
  };
}

function ensureMapViewMap(sheet) {
  if (sheet.map) return sheet.map;
  sheet.theme = mapViewStyleTheme();
  sheet.map = new mapboxgl.Map({
    container: sheet.mapEl,
    style: mapViewStyle(sheet.theme),
    center: [sheet.page.lng, sheet.page.lat],
    zoom: sheet.page.zoom,
    bearing: sheet.page.bearing,
    interactive: false,
    attributionControl: false,
    // printedScreen.js sizes the inset; the sheet's onModeChange resizes the map after it.
    trackResize: false
  });
  // In the paper style, street names are spaced and collide as on the table map (paperMap.js).
  sheet.map.on('style.load', function () {
    if (sheet.theme === MAP_THEME_PAPER && window.CompactPaperRoadNames) window.CompactPaperRoadNames.apply(sheet.map);
  });
  // Drawn in full, tiles and all: the watcher may take the blank sheet under this map.
  sheet.map.on('idle', function () { sheet.idleKey = sheet.appliedKey + '|' + sheet.theme; });
  return sheet.map;
}

function mapViewDrawn(sheet) {
  return !!sheet.map && sheet.idleKey === sheet.appliedKey + '|' + sheet.theme;
}

function setMapViewVisible(sheet, visible) {
  sheet.insetEl.classList.toggle('visible', visible);
  sheet.insetEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function renderMapView(sheet, nowMs) {
  const view = ensureMapViewMap(sheet);
  const theme = mapViewStyleTheme();
  if (theme !== sheet.theme) {
    sheet.theme = theme;
    view.setStyle(mapViewStyle(theme));
  }
  const page = sheet.page;
  const key = [page.lng, page.lat, page.zoom, page.bearing].join(',');
  if (key !== sheet.appliedKey) {
    sheet.appliedKey = key;
    view.jumpTo({ center: [page.lng, page.lat], zoom: page.zoom, bearing: page.bearing });
  }
  let pointerHere = !!mapViewPointer && (nowMs - mapViewPointerSeenMs) < MAP_VIEW_POINTER_HOLD_MS;
  // Within the jitter allowance the pointer sits a little off a following page's centre; on an
  // assigned view it can be anywhere, or off the sheet.
  const at = pointerHere ? view.project([mapViewPointer.lng, mapViewPointer.lat]) : null;
  if (at && page.pinned) {
    pointerHere = at.x >= 0 && at.y >= 0 && at.x <= sheet.insetEl.offsetWidth && at.y <= sheet.insetEl.offsetHeight;
  }
  sheet.coneEl.style.display = pointerHere ? '' : 'none';
  // The cone moves on the sheet, so the watcher leaves the paper under it out.
  sheet.coneAt = pointerHere ? { x: at.x, y: at.y, r: MAP_VIEW_CONE_RADIUS_PX } : null;
  if (!pointerHere) return;
  sheet.coneEl.style.left = at.x.toFixed(1) + 'px';
  sheet.coneEl.style.top = at.y.toFixed(1) + 'px';
  // The heading is a compass bearing; on a map turned by the page's bearing it points that much less.
  sheet.coneEl.style.transform = 'translate(-50%, -50%) rotate(' + (mapViewHeading - page.bearing).toFixed(1) + 'deg)';
}

// Every MAP_VIEW_WATCH_EVERY_MS: tells the paper watcher what the sheet shows (its page and view,
// whether that map is on the paper and drawn in full, where the cone is, whether the page is
// closing) and takes the drawing it read off the paper when there is a newer one. The drawing may
// be of a page already gone; it still joins the table's map.
function reportMapViewSheet(sheet, show, nowMs) {
  if (sheet.reporting || nowMs - sheet.reportedMs < MAP_VIEW_WATCH_EVERY_MS) return;
  const page = sheet.page;
  const size = sheet.screen.viewSize();
  const body = { sheet: sheet.key, known: sheet.drawingVersion, page: null };
  if (page && size) {
    body.page = {
      id: page.id,
      view: { lng: page.lng, lat: page.lat, zoom: page.zoom, bearing: page.bearing, width: size.width, height: size.height },
      shown: show,
      ready: show && mapViewDrawn(sheet),
      closing: sheet.closingSinceMs >= 0,
      cone: show ? sheet.coneAt : null
    };
  } else if (sheet.reportedEmpty) {
    return;  // the watcher already knows there is nothing to watch
  }
  sheet.reporting = true;
  sheet.reportedMs = nowMs;
  sheet.reportedEmpty = !body.page;
  fetch('/api/map-screen/watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function (response) { return response.json(); })
    .then(function (data) {
      if (!data || !data.ok) return;
      if (data.version < sheet.drawingVersion) sheet.drawingVersion = data.version;  // the server restarted
      if (data.drawing && data.version > sheet.drawingVersion) {
        sheet.drawingVersion = data.version;
        drawing.setPaperStrokes(data.drawing.pageId, data.drawing.geojson.features);
      }
      sheet.watch = { pageId: data.pageId, final: !!data.final, status: data.status };
    })
    .catch(function () {})
    .then(function () { sheet.reporting = false; });
}

function refreshMapViewSheet(sheet, nowMs, elapsedMs) {
  if (isFloorplanMode) {
    setMapViewVisible(sheet, false);
    return;
  }
  const onTable = sheet.screen.isActive();
  const target = mapViewTarget(sheet);
  // An assigned view taken off the sheet with no pointer to follow leaves nothing to show: that is
  // a move as well.
  if (!sheet.page) {
    if (target) openMapViewPage(sheet, target, nowMs);
  } else if (sheet.closingSinceMs >= 0) {
    // The ink drawn since the last reading is on the old map, so the old map stays until the watcher
    // has read the paper once more, the sheet leaves the table, or the wait runs out.
    const read = !!sheet.watch && sheet.watch.pageId === sheet.page.id && sheet.watch.final;
    if (read || !onTable || nowMs - sheet.closingSinceMs >= MAP_VIEW_CLOSE_WAIT_MS) {
      sheet.closingSinceMs = -1;
      sheet.movedNoteMs = 0;
    }
  } else if (sheet.movedNoteMs < 0 && (target ? mapViewPageMoved(sheet.page, target) : sheet.page.pinned)) {
    if (onTable) {
      sheet.closingSinceMs = nowMs;
      sheet.watch = null;
    } else {
      sheet.movedNoteMs = 0;
    }
  }
  if (sheet.movedNoteMs >= 0) {
    if (onTable) sheet.movedNoteMs += elapsedMs;
    if (sheet.movedNoteMs >= MAP_VIEW_MOVED_NOTE_MS) {
      sheet.movedNoteMs = -1;
      if (target) openMapViewPage(sheet, target, nowMs);
      else sheet.page = null;
    }
  }
  const moved = sheet.movedNoteMs >= 0;
  sheet.screen.setNote(moved ? MAP_VIEW_MOVED_NOTE : null);
  const show = onTable && !!sheet.page && !moved;
  if (show) renderMapView(sheet, nowMs);
  setMapViewVisible(sheet, show);
  reportMapViewSheet(sheet, show, nowMs);
}

// Once per poll, with the street view pointer as tagPolling.js found it: state 'inside' (on
// the map), 'outside' (off it) or 'missing' (not seen), its place and its heading.
function refreshMapViewInset(state, lngLat, heading, nowMs) {
  const elapsedMs = mapViewLastPollMs ? nowMs - mapViewLastPollMs : 0;
  mapViewLastPollMs = nowMs;
  if (state === 'inside' && hasFiniteStreetViewLngLat(lngLat)) {
    mapViewPointer = { lng: Number(lngLat.lng), lat: Number(lngLat.lat) };
    mapViewPointerSeenMs = nowMs;
    if (Number.isFinite(Number(heading))) mapViewHeading = Number(heading);
  }
  mapViewSheets.forEach(function (sheet) { refreshMapViewSheet(sheet, nowMs, elapsedMs); });
}

// Every frame, with every tag the camera sees: each sheet fits its pose from its own tags.
function updateMapViewScreens(tags, toPx, nowMs) {
  mapViewSheets.forEach(function (sheet) { sheet.screen.update(tags, toPx, nowMs); });
}

function createMapViewSheet(def, several) {
  const insetEl = document.createElement('div');
  insetEl.className = 'map-view-inset';
  insetEl.dataset.sheet = def.key;
  insetEl.setAttribute('aria-hidden', 'true');
  insetEl.innerHTML = MAP_VIEW_INSET_HTML;
  mapView.appendChild(insetEl);
  const sheet = {
    key: def.key,
    label: def.label,
    insetEl: insetEl,
    mapEl: insetEl.querySelector('.map-view-inset__map'),
    coneEl: insetEl.querySelector('.map-view-inset__cone'),
    screen: null,
    assigned: null,       // { lng, lat, zoom, bearing, width, height }: a table view put on this sheet
    map: null,
    theme: '',
    appliedKey: '',
    page: null,           // { id, lng, lat, zoom, bearing, pinned }: what the paper on the sheet shows
    movedNoteMs: -1,      // how long the moved note has shown; -1 when none is due
    closingSinceMs: -1,   // when the map moved off a page still waiting for its last reading; -1 when none
    idleKey: '',          // the view and theme the map last finished drawing (see mapViewDrawn)
    coneAt: null,         // { x, y, r } in inset px while the cone shows
    reporting: false,
    reportedMs: 0,
    reportedEmpty: false,
    drawingVersion: 0,    // the watcher's newest drawing this page has taken
    watch: null           // { pageId, final, status }: the watcher's last answer
  };
  sheet.screen = window.CompactPrintedScreen.createPrintedScreen({
    frameUrl: '/api/map-screen/frame' + (def.key === 'map-screen' ? '' : '?sheet=' + encodeURIComponent(def.key)),
    // With several sheets the note says which one it is, to match it with its button.
    noteText: several ? def.label + ': ' + MAP_VIEW_IDLE_NOTE.charAt(0).toLowerCase() + MAP_VIEW_IDLE_NOTE.slice(1) : MAP_VIEW_IDLE_NOTE,
    insetEl: insetEl,
    containerEl: mapView,
    // What the inset holds measured its host when it was built; the host just changed size.
    onModeChange: function (onScreen) { if (onScreen && sheet.map) sheet.map.resize(); }
  });
  return sheet;
}

// The sheets Marker Setting defines; one without two border tags cannot be found on the table.
function createMapViewSheets() {
  const defs = window.CompactTagAssignments.getMapSheets().filter(function (def) { return def.tagIds.length >= 2; });
  defs.forEach(function (def) { mapViewSheets.push(createMapViewSheet(def, defs.length > 1)); });
}

function findMapViewSheet(key) {
  return mapViewSheets.find(function (sheet) { return sheet.key === key; }) || null;
}

// For the Project panel: list the sheets, put the table's current view on one, or set every
// sheet's view from a project (a sheet left out follows the street view pointer again).
window.CompactMapViewSheets = {
  list: function () {
    return mapViewSheets.map(function (sheet) {
      return {
        key: sheet.key,
        label: sheet.label,
        onTable: sheet.screen.isActive(),
        view: sheet.assigned ? Object.assign({}, sheet.assigned) : null
      };
    });
  },
  currentView: mapViewTableView,
  setView: function (key, view) {
    const sheet = findMapViewSheet(key);
    if (!sheet) return false;
    sheet.assigned = cleanMapSheetView(view);
    return true;
  },
  setViews: function (views) {
    mapViewSheets.forEach(function (sheet) {
      sheet.assigned = cleanMapSheetView(views && typeof views === 'object' ? views[sheet.key] : null);
    });
  }
};
