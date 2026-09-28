// Map page: the street view inset shown where the single-state pointer (street-view
// tool) stands, looking the way it points. Panoramas are always found through an
// OUTDOOR lookup, never by position, so the inset cannot land inside a building.
// On the printed street view screen, streetViewScreen.js places the inset instead.
const streetViewInset = document.getElementById('streetViewInset');
const streetViewFrame = document.getElementById('streetViewFrame');
const STREET_VIEW_FOV = 80;
const STREET_VIEW_HEADING = 0;
const STREET_VIEW_PITCH = 0;
const STREET_VIEW_REQUEST_DISTANCE_M = 15;
const STREET_VIEW_REQUEST_DEBOUNCE_MS = 400;
const STREET_VIEW_REQUEST_COOLDOWN_MS = 1000;
const STREET_VIEW_COORD_DECIMALS = 4;
const STREET_VIEW_MISSING_HOLD_MS = 3000;
const STREET_VIEW_SEARCH_RADIUS_M = 80;
// Added to the tag's screen angle to get the heading; change it if "tag pointing up" should face elsewhere.
const STREET_VIEW_HEADING_OFFSET_DEG = 0;
let googleMapsKeyCached = '';
let googleMapsKeyPromise = null;
let streetViewVisible = false;
let streetViewLastUrl = '';
let streetViewHideTimer = 0;
let streetViewRequestTimer = 0;
let streetViewPendingRequestKey = '';
let streetViewLastAnchorPoint = null;
let streetViewLastLngLat = null;
let streetViewLastRequestedLngLat = null;
let streetViewLastRequestAtMs = 0;
let streetViewDesiredState = 'hidden';
// The JS panorama, once the Maps SDK loads, is updated in place: no reload when the pointer turns.
let streetViewPanorama = null;
let streetViewSdkPromise = null;
let streetViewLastHeading = 0;
let streetViewService = null;
let streetViewLastPano = '';
let streetViewQueryLngLat = null;
let streetViewResolving = false;
let streetViewNoOutdoor = false;

function streetViewHeadingForTag(tag) {
  var heading = (Number(tagAngleDeg(tag)) + STREET_VIEW_HEADING_OFFSET_DEG) % 360;
  if (heading < 0) heading += 360;
  return heading;
}

function fetchGoogleMapsKey() {
  if (googleMapsKeyCached) return Promise.resolve(googleMapsKeyCached);
  if (googleMapsKeyPromise) return googleMapsKeyPromise;
  googleMapsKeyPromise = fetch('/api/google-maps-key', { cache: 'no-store' })
    .then(function (response) { return response.json(); })
    .then(function (data) {
      googleMapsKeyCached = data && data.ok && data.key ? String(data.key).trim() : '';
      return googleMapsKeyCached;
    })
    .catch(function () {
      googleMapsKeyCached = '';
      return '';
    })
    .finally(function () {
      googleMapsKeyPromise = null;
    });
  return googleMapsKeyPromise;
}

function buildStreetViewUrl(pano, key, heading) {
  if (!key) return '';
  var url = new URL('https://www.google.com/maps/embed/v1/streetview');
  url.searchParams.set('key', key);
  // A pano id, never location=: the embed API has no source filter and snaps to any nearby panorama.
  url.searchParams.set('pano', pano.pano);
  var headingNum = Number(heading);
  url.searchParams.set('heading', String(Number.isFinite(headingNum) ? headingNum : STREET_VIEW_HEADING));
  url.searchParams.set('pitch', String(STREET_VIEW_PITCH));
  url.searchParams.set('fov', String(STREET_VIEW_FOV));
  return url.toString();
}

// Loads the Google Maps JS SDK once: unlike the embed iframe, its panorama turns without reloading.
function ensureStreetViewSdk() {
  if (window.google && window.google.maps && window.google.maps.StreetViewPanorama) {
    return Promise.resolve(window.google.maps);
  }
  if (streetViewSdkPromise) return streetViewSdkPromise;
  streetViewSdkPromise = fetchGoogleMapsKey().then(function (key) {
    if (!key) throw new Error('no_google_maps_key');
    return new Promise(function (resolve, reject) {
      var existing = document.getElementById('googleMapsSdkScript');
      if (existing) {
        existing.addEventListener('load', function () { resolve(window.google && window.google.maps); });
        existing.addEventListener('error', function () { reject(new Error('sdk_load_failed')); });
        return;
      }
      var s = document.createElement('script');
      s.id = 'googleMapsSdkScript';
      s.async = true;
      s.defer = true;
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key);
      s.addEventListener('load', function () { resolve(window.google && window.google.maps); });
      s.addEventListener('error', function () { reject(new Error('sdk_load_failed')); });
      document.head.appendChild(s);
    });
  });
  // A failed load may be retried later.
  streetViewSdkPromise.catch(function () {
    streetViewSdkPromise = null;
  });
  return streetViewSdkPromise;
}

// The nearest OUTDOOR panorama as { pano, lat, lng }, or null when there is none or
// the SDK never loaded: a bare position lets Google snap to indoor collections too.
function resolveOutdoorPano(lngLat) {
  return ensureStreetViewSdk().then(function (maps) {
    if (!maps || !maps.StreetViewService) return null;
    if (!streetViewService) streetViewService = new maps.StreetViewService();
    if (!maps.StreetViewSource || !maps.StreetViewSource.OUTDOOR) return null;
    var ask = {
      location: { lat: Number(lngLat.lat), lng: Number(lngLat.lng) },
      radius: STREET_VIEW_SEARCH_RADIUS_M,
      source: maps.StreetViewSource.OUTDOOR
    };
    return new Promise(function (resolve) {
      streetViewService.getPanorama(ask, function (data, status) {
        if (status !== 'OK' || !data || !data.location || !data.location.pano) {
          resolve(null);
          return;
        }
        var loc = data.location.latLng;
        var lat = Number(lngLat.lat);
        var lng = Number(lngLat.lng);
        if (loc) {
          lat = Number(typeof loc.lat === 'function' ? loc.lat() : loc.lat);
          lng = Number(typeof loc.lng === 'function' ? loc.lng() : loc.lng);
        }
        resolve({ pano: data.location.pano, lat: lat, lng: lng });
      });
    });
  }).catch(function () { return null; });
}

function showStreetViewPano(pano) {
  if (pano.pano === streetViewLastPano) return;
  try {
    streetViewPanorama.setPano(pano.pano);
  } catch (_err) {}
  streetViewLastPano = pano.pano;
}

function ensureStreetViewPanorama(pano, heading) {
  return ensureStreetViewSdk().then(function (maps) {
    if (!maps || !maps.StreetViewPanorama) return null;
    if (streetViewPanorama) {
      showStreetViewPano(pano);
      return streetViewPanorama;
    }
    streetViewPanorama = new maps.StreetViewPanorama(document.getElementById('streetViewPanorama'), {
      pano: pano.pano,
      pov: { heading: Number(heading) || 0, pitch: STREET_VIEW_PITCH },
      zoom: 0,
      addressControl: false,
      fullscreenControl: false,
      linksControl: false,
      panControl: false,
      enableCloseButton: false,
      motionTracking: false,
      motionTrackingControl: false,
      showRoadLabels: false,
      // No walking through links: a street panorama can link into the building beside it.
      clickToGo: false,
      visible: true
    });
    streetViewLastPano = pano.pano;
    streetViewLastHeading = Number(heading) || 0;
    streetViewInset.classList.add('pano-ready');
    return streetViewPanorama;
  }).catch(function () { return null; });
}

// Updates the live panorama; returns whether there is an outdoor one to show.
function applyStreetViewPanoramaState(lngLat, heading) {
  if (!streetViewPanorama) return false;
  var pos = { lat: Number(lngLat.lat), lng: Number(lngLat.lng) };
  var movedFar = streetViewDistanceMeters(streetViewQueryLngLat, pos) >= STREET_VIEW_REQUEST_DISTANCE_M;
  if (Number.isFinite(pos.lat) && Number.isFinite(pos.lng) && !streetViewResolving && movedFar) {
    // Look the outdoor panorama up again rather than setPosition(), whose snap can land indoors.
    // Distance counts from the last point asked about, not the pano found, or a pano 40 m off
    // would trigger a lookup every frame.
    streetViewResolving = true;
    streetViewQueryLngLat = pos;
    resolveOutdoorPano(pos).then(function (pano) {
      streetViewResolving = false;
      if (!streetViewPanorama) return;
      if (!pano) {
        streetViewNoOutdoor = true;
        setStreetViewVisible(false);
        return;
      }
      streetViewNoOutdoor = false;
      showStreetViewPano(pano);
    });
  }
  var headingNum = Number(heading);
  if (Number.isFinite(headingNum) && Math.abs(headingNum - streetViewLastHeading) > 0.5) {
    try {
      streetViewPanorama.setPov({ heading: headingNum, pitch: STREET_VIEW_PITCH });
    } catch (_err) {}
    streetViewLastHeading = headingNum;
  }
  return !streetViewNoOutdoor;
}

// streetViewScreen's callback when the printed screen appears or goes.
function handleStreetScreenModeChange(onScreen) {
  if (!onScreen) {
    streetViewInset.style.left = '';
    streetViewInset.style.top = '';
    positionStreetViewInset();
  }
  // The panorama measured its host when it was built; the host has a new size now.
  if (streetViewPanorama) {
    try {
      window.google.maps.event.trigger(streetViewPanorama, 'resize');
    } catch (_err) {}
  }
}

function setStreetViewVisible(visible) {
  streetViewVisible = !!visible;
  streetViewInset.classList.toggle('visible', streetViewVisible);
  streetViewInset.setAttribute('aria-hidden', streetViewVisible ? 'false' : 'true');
}

function hasFiniteStreetViewLngLat(lngLat) {
  return !!(lngLat && Number.isFinite(Number(lngLat.lng)) && Number.isFinite(Number(lngLat.lat)));
}

function quantizeStreetViewLngLat(lngLat) {
  if (!hasFiniteStreetViewLngLat(lngLat)) return null;
  var scale = Math.pow(10, STREET_VIEW_COORD_DECIMALS);
  return {
    lng: Math.round(Number(lngLat.lng) * scale) / scale,
    lat: Math.round(Number(lngLat.lat) * scale) / scale
  };
}

function streetViewLngLatKey(lngLat) {
  return Number(lngLat.lat).toFixed(STREET_VIEW_COORD_DECIMALS) + ',' + Number(lngLat.lng).toFixed(STREET_VIEW_COORD_DECIMALS);
}

function streetViewDistanceMeters(a, b) {
  if (!hasFiniteStreetViewLngLat(a) || !hasFiniteStreetViewLngLat(b)) return Infinity;
  var lat1 = Number(a.lat) * Math.PI / 180;
  var lat2 = Number(b.lat) * Math.PI / 180;
  var dLat = lat2 - lat1;
  var dLng = (Number(b.lng) - Number(a.lng)) * Math.PI / 180;
  var sinLat = Math.sin(dLat / 2);
  var sinLng = Math.sin(dLng / 2);
  var h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function clearStreetViewHideTimer() {
  if (!streetViewHideTimer) return;
  window.clearTimeout(streetViewHideTimer);
  streetViewHideTimer = 0;
}

function clearStreetViewRequestTimer() {
  if (!streetViewRequestTimer) return;
  window.clearTimeout(streetViewRequestTimer);
  streetViewRequestTimer = 0;
  streetViewPendingRequestKey = '';
}

function scheduleStreetViewHide() {
  if (streetViewHideTimer) return;
  streetViewHideTimer = window.setTimeout(function () {
    streetViewHideTimer = 0;
    clearStreetViewRequestTimer();
    setStreetViewVisible(false);
  }, STREET_VIEW_MISSING_HOLD_MS);
}

function commitStreetViewRequest(requestLngLat, heading) {
  if (streetViewDesiredState !== 'inside') return;
  var effectiveLngLat = quantizeStreetViewLngLat(requestLngLat);
  if (!effectiveLngLat) return;
  // Recorded before the answer, so a spot without outdoor imagery is asked about once, not every cooldown.
  streetViewLastRequestedLngLat = effectiveLngLat;
  streetViewLastRequestAtMs = Date.now();
  streetViewQueryLngLat = effectiveLngLat;
  resolveOutdoorPano(effectiveLngLat).then(function (found) {
    if (streetViewDesiredState !== 'inside') return;
    if (!found) {
      // Showing nothing beats showing an interior.
      streetViewNoOutdoor = true;
      streetViewLastUrl = '';
      setStreetViewVisible(false);
      return;
    }
    streetViewNoOutdoor = false;
    ensureStreetViewPanorama(found, heading).then(function (pano) {
      if (streetViewDesiredState !== 'inside') return;
      if (pano) {
        applyStreetViewPanoramaState(effectiveLngLat, heading);
        positionStreetViewInset();
        setStreetViewVisible(true);
        return;
      }
      // No JS panorama: the embed iframe on the same outdoor pano, reloaded on every heading change.
      fetchGoogleMapsKey().then(function (key) {
        if (streetViewDesiredState !== 'inside') return;
        var url = buildStreetViewUrl(found, key, heading);
        if (!url) {
          setStreetViewVisible(false);
          return;
        }
        if (streetViewLastUrl !== url) {
          streetViewFrame.src = url;
          streetViewLastUrl = url;
        }
        positionStreetViewInset();
        setStreetViewVisible(true);
      });
    });
  });
}

function shouldRequestNewStreetView(rawLngLat) {
  var quantized = quantizeStreetViewLngLat(rawLngLat);
  if (!quantized) return false;
  if (!streetViewLastRequestedLngLat) return true;
  return streetViewDistanceMeters(quantized, streetViewLastRequestedLngLat) >= STREET_VIEW_REQUEST_DISTANCE_M;
}

function scheduleStreetViewRequest(rawLngLat, heading) {
  var quantized = quantizeStreetViewLngLat(rawLngLat);
  if (!quantized) return;
  var requestKey = streetViewLngLatKey(quantized);
  if (streetViewRequestTimer && streetViewPendingRequestKey === requestKey) return;
  clearStreetViewRequestTimer();
  streetViewPendingRequestKey = requestKey;
  var remainingCooldown = Math.max(0, STREET_VIEW_REQUEST_COOLDOWN_MS - (Date.now() - streetViewLastRequestAtMs));
  var delay = Math.max(STREET_VIEW_REQUEST_DEBOUNCE_MS, remainingCooldown);
  streetViewRequestTimer = window.setTimeout(function () {
    streetViewRequestTimer = 0;
    streetViewPendingRequestKey = '';
    commitStreetViewRequest(quantized, heading);
  }, delay);
}

function positionStreetViewInset() {
  if (!streetViewLastAnchorPoint || streetViewScreen.isActive()) return;
  streetViewInset.style.left = String(streetViewLastAnchorPoint.x) + 'px';
  streetViewInset.style.top = String(streetViewLastAnchorPoint.y) + 'px';
}

// Once per poll. state: 'inside' (pointer on the map), 'outside' (pointer off it) or 'missing' (not seen).
function refreshStreetViewInset(state, anchorPoint, lngLat, heading) {
  streetViewDesiredState = String(state || 'hidden');
  if (anchorPoint && Number.isFinite(anchorPoint.x) && Number.isFinite(anchorPoint.y)) {
    streetViewLastAnchorPoint = { x: Number(anchorPoint.x), y: Number(anchorPoint.y) };
    if (hasFiniteStreetViewLngLat(lngLat)) {
      streetViewLastLngLat = { lng: Number(lngLat.lng), lat: Number(lngLat.lat) };
    }
  }
  positionStreetViewInset();
  if (state === 'outside') {
    clearStreetViewHideTimer();
    clearStreetViewRequestTimer();
    streetViewDesiredState = 'hidden';
    setStreetViewVisible(false);
    return;
  }
  if (state === 'missing') {
    clearStreetViewRequestTimer();
    scheduleStreetViewHide();
    return;
  }
  clearStreetViewHideTimer();
  if (!hasFiniteStreetViewLngLat(streetViewLastLngLat)) return;
  // A live panorama is updated every frame: a new outdoor lookup when the pointer moved far
  // enough, setPov for turns (client-side only).
  if (streetViewPanorama) {
    var hasOutdoor = applyStreetViewPanoramaState(streetViewLastLngLat, heading);
    positionStreetViewInset();
    setStreetViewVisible(hasOutdoor);
    return;
  }
  var currentQuantizedLngLat = quantizeStreetViewLngLat(streetViewLastLngLat);
  var nearLastRequest = !!streetViewLastRequestedLngLat
    && streetViewDistanceMeters(currentQuantizedLngLat, streetViewLastRequestedLngLat) < STREET_VIEW_REQUEST_DISTANCE_M;
  if (!streetViewVisible && streetViewLastUrl && nearLastRequest) {
    clearStreetViewRequestTimer();
    positionStreetViewInset();
    setStreetViewVisible(true);
    return;
  }
  if (shouldRequestNewStreetView(streetViewLastLngLat)) {
    scheduleStreetViewRequest(streetViewLastLngLat, heading);
  } else if (streetViewVisible && streetViewLastAnchorPoint) {
    clearStreetViewRequestTimer();
    positionStreetViewInset();
  }
}
