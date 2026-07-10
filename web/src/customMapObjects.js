(function () {
  function createCustomMapObjects(options) {
    var map = options.map;
    var modalEl = options.modalEl;
    var formEl = options.formEl;
    var textInputEl = options.textInputEl;
    var modeSelectEl = options.modeSelectEl;
    var colorInputEl = options.colorInputEl;
    var cancelBtnEl = options.cancelBtnEl;
    var projectLngLatToPx = typeof options.projectLngLatToPx === 'function'
      ? options.projectLngLatToPx
      : null;
    var activationRadiusPx = Number(options.activationRadiusPx);
    var onStatusChange = typeof options.onStatusChange === 'function'
      ? options.onStatusChange
      : function () {};

    var MODE_ORDER = ['transportation', 'landmark', 'amenities'];
    var MODE_LABELS = {
      transportation: 'Transportation',
      landmark: 'Landmark',
      amenities: 'Amenities'
    };
    var LEGACY_STYLE_COLORS = {
      'red-square': '#ff4d4f',
      'blue-circle': '#3b82f6',
      'green-diamond': '#22c55e',
      'blue-triangle': '#3b82f6'
    };

    var items = [];
    var markersById = {};
    var interactionActiveById = {};
    var forcedActiveById = {};
    var highlightedById = {};
    var presentationMode = 'hidden';
    var modeTextScale = {
      transportation: 1,
      landmark: 1,
      amenities: 1
    };
    var modeVisibility = {
      transportation: true,
      landmark: true,
      amenities: true
    };

    function makeId() {
      return 'custom_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function isValidMode(mode) {
      return Object.prototype.hasOwnProperty.call(MODE_LABELS, String(mode || ''));
    }

    function normalizeMode(mode) {
      var key = String(mode || '').toLowerCase();
      if (key === 'amenity') key = 'amenities';
      return isValidMode(key) ? key : 'transportation';
    }

    function normalizeColor(color, legacyStyleId) {
      var raw = String(color || '').trim();
      if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
      var legacy = String(legacyStyleId || '').trim();
      if (Object.prototype.hasOwnProperty.call(LEGACY_STYLE_COLORS, legacy)) {
        return LEGACY_STYLE_COLORS[legacy];
      }
      return '#ff4d4f';
    }

    function normalizeItem(raw) {
      if (!raw) return null;
      var lng = Number(raw.lng);
      var lat = Number(raw.lat);
      var text = String(raw.text || '').trim();
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || !text) return null;
      return {
        id: String(raw.id || makeId()),
        text: text.slice(0, 120),
        mode: normalizeMode(raw.mode),
        color: normalizeColor(raw.color, raw.styleId),
        lng: lng,
        lat: lat
      };
    }

    function itemToFeature(item) {
      return {
        type: 'Feature',
        properties: {
          id: item.id,
          text: item.text,
          mode: item.mode,
          color: item.color
        },
        geometry: {
          type: 'Point',
          coordinates: [item.lng, item.lat]
        }
      };
    }

    function featureToItem(feature) {
      if (!feature || !feature.geometry || !feature.properties) return null;
      var coordinates = feature.geometry.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
      return normalizeItem({
        id: feature.properties.id,
        text: feature.properties.text,
        mode: feature.properties.mode,
        color: feature.properties.color,
        styleId: feature.properties.styleId,
        lng: coordinates[0],
        lat: coordinates[1]
      });
    }

    function getGeoJSON() {
      var features = [];
      for (var i = 0; i < items.length; i++) {
        features.push(itemToFeature(items[i]));
      }
      return { type: 'FeatureCollection', features: features };
    }

    function applyMarkerState(item) {
      var marker = markersById[item.id];
      if (!marker || typeof marker.getElement !== 'function') return;
      var el = marker.getElement();
      if (!el || !el.classList) return;
      var visible = modeVisibility[item.mode] && presentationMode !== 'hidden';
      el.style.display = visible ? '' : 'none';
      var expanded = presentationMode === 'expanded'
        || (presentationMode === 'interactive' && (!!interactionActiveById[item.id] || !!forcedActiveById[item.id]));
      el.classList.toggle('is-compact', !expanded);
      var textScale = Number(modeTextScale[item.mode]);
      if (!Number.isFinite(textScale) || textScale <= 0) textScale = 1;
      var markerScale = highlightedById[item.id] ? 1.25 : 1;
      el.style.setProperty('--custom-object-text-size', (18 * textScale * markerScale).toFixed(2) + 'px');
      el.style.setProperty('--custom-object-icon-size', (24 * markerScale).toFixed(2) + 'px');
      el.style.setProperty('--custom-object-icon-compact-size', (12 * markerScale).toFixed(2) + 'px');
    }

    function createMarkerElement(item) {
      var el = document.createElement('div');
      el.className = 'custom-object-marker is-compact';
      el.setAttribute('title', MODE_LABELS[item.mode] + ': ' + item.text);

      var iconEl = document.createElement('span');
      iconEl.className = 'custom-object-marker__icon';
      iconEl.style.setProperty('--custom-object-color', item.color);
      el.appendChild(iconEl);

      var textEl = document.createElement('span');
      textEl.className = 'custom-object-marker__text';
      textEl.textContent = item.text;
      el.appendChild(textEl);

      return el;
    }

    function persist(successNote) {
      return fetch('/api/custom-objects', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(getGeoJSON())
      })
        .then(function (res) {
          if (!res.ok) throw new Error('save_failed');
          return res.json();
        })
        .then(function () {
          if (successNote) onStatusChange(successNote);
          return true;
        })
        .catch(function () {
          onStatusChange('Failed to save custom objects');
          return false;
        });
    }

    function attachMarker(item) {
      var markerEl = createMarkerElement(item);
      var marker = new mapboxgl.Marker({
        element: markerEl,
        anchor: 'left',
        draggable: true
      })
        .setLngLat([item.lng, item.lat])
        .addTo(map);

      marker.on('dragstart', function () {
        marker.getElement().classList.add('dragging');
      });
      marker.on('dragend', function () {
        var lngLat = marker.getLngLat();
        item.lng = Number(lngLat.lng);
        item.lat = Number(lngLat.lat);
        marker.getElement().classList.remove('dragging');
        persist('Custom object saved');
      });
      markerEl.addEventListener('contextmenu', function (event) {
        event.preventDefault();
        removeItem(item.id);
      });

      markersById[item.id] = marker;
      interactionActiveById[item.id] = false;
      applyMarkerState(item);
    }

    function removeItem(id) {
      var key = String(id || '');
      var nextItems = [];
      var removed = false;

      for (var i = 0; i < items.length; i++) {
        if (items[i].id === key) {
          removed = true;
          continue;
        }
        nextItems.push(items[i]);
      }
      if (!removed) return false;

      var marker = markersById[key];
      if (marker) marker.remove();
      delete markersById[key];
      delete interactionActiveById[key];
      delete forcedActiveById[key];
      items = nextItems;
      persist('Custom object deleted');
      return true;
    }

    function clear() {
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var marker = markersById[item.id];
        if (marker) marker.remove();
      }
      items = [];
      markersById = {};
      interactionActiveById = {};
      forcedActiveById = {};
      highlightedById = {};
    }

    function replaceAll(nextItems) {
      clear();
      for (var i = 0; i < nextItems.length; i++) {
        var item = normalizeItem(nextItems[i]);
        if (!item) continue;
        items.push(item);
        attachMarker(item);
      }
    }

    function createItemAtCenter(raw) {
      var center = map.getCenter();
      var item = normalizeItem({
        id: makeId(),
        text: raw.text,
        mode: raw.mode,
        color: raw.color,
        lng: center.lng,
        lat: center.lat
      });
      if (!item) return null;
      items.push(item);
      attachMarker(item);
      persist('Custom object saved');
      return item;
    }

    function setModeVisible(mode, visible) {
      var key = normalizeMode(mode);
      modeVisibility[key] = !!visible;
      for (var i = 0; i < items.length; i++) {
        if (items[i].mode === key) applyMarkerState(items[i]);
      }
      return modeVisibility[key];
    }

    function toggleMode(mode) {
      var key = normalizeMode(mode);
      return setModeVisible(key, !modeVisibility[key]);
    }

    function isModeVisible(mode) {
      return !!modeVisibility[normalizeMode(mode)];
    }

    function updateInteractionTags(tagViewportPoints) {
      var points = Array.isArray(tagViewportPoints) ? tagViewportPoints : [];
      var radius = Number.isFinite(activationRadiusPx) && activationRadiusPx > 0
        ? activationRadiusPx
        : 28;

      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var isActive = false;
        if (projectLngLatToPx) {
          var markerPx = projectLngLatToPx(item.lng, item.lat);
          if (markerPx && Number.isFinite(markerPx.x) && Number.isFinite(markerPx.y)) {
            for (var j = 0; j < points.length; j++) {
              var point = points[j];
              if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
              var dx = point.x - markerPx.x;
              var dy = point.y - markerPx.y;
              if (Math.sqrt(dx * dx + dy * dy) <= radius) {
                isActive = true;
                break;
              }
            }
          }
        }
        interactionActiveById[item.id] = isActive;
        applyMarkerState(item);
      }
    }

    function setPresentationMode(mode) {
      var next = String(mode || '').toLowerCase();
      if (next !== 'expanded' && next !== 'hidden') next = 'interactive';
      presentationMode = next;
      for (var i = 0; i < items.length; i++) {
        applyMarkerState(items[i]);
      }
      return presentationMode;
    }

    function setForcedActiveIds(ids) {
      var next = {};
      var list = Array.isArray(ids) ? ids : [];
      for (var i = 0; i < list.length; i++) {
        var key = String(list[i] || '');
        if (key) next[key] = true;
      }
      forcedActiveById = next;
      for (var j = 0; j < items.length; j++) {
        applyMarkerState(items[j]);
      }
    }

    function setHighlightedIds(ids) {
      var next = {};
      var list = Array.isArray(ids) ? ids : [];
      for (var i = 0; i < list.length; i++) {
        var key = String(list[i] || '');
        if (key) next[key] = true;
      }
      highlightedById = next;
      for (var j = 0; j < items.length; j++) {
        applyMarkerState(items[j]);
      }
    }

    function setModeTextScale(mode, scale) {
      var key = normalizeMode(mode);
      var nextScale = Number(scale);
      if (!Number.isFinite(nextScale) || nextScale <= 0) nextScale = 1;
      modeTextScale[key] = nextScale;
      for (var i = 0; i < items.length; i++) {
        if (items[i].mode === key) applyMarkerState(items[i]);
      }
      return modeTextScale[key];
    }

    function findItemAtViewportPoint(point, options) {
      if (!projectLngLatToPx || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      var opts = options || {};
      var radius = Number(opts.radius);
      if (!Number.isFinite(radius) || radius <= 0) {
        radius = Number.isFinite(activationRadiusPx) && activationRadiusPx > 0 ? activationRadiusPx : 28;
      }
      var mode = opts.mode ? normalizeMode(opts.mode) : '';
      var closestItem = null;
      var closestDistance = Infinity;
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (mode && item.mode !== mode) continue;
        var markerPx = projectLngLatToPx(item.lng, item.lat);
        if (!markerPx || !Number.isFinite(markerPx.x) || !Number.isFinite(markerPx.y)) continue;
        var dx = point.x - markerPx.x;
        var dy = point.y - markerPx.y;
        var distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > radius || distance >= closestDistance) continue;
        closestItem = item;
        closestDistance = distance;
      }
      return closestItem;
    }

    function getItems() {
      return items.slice();
    }

    function isModalOpen() {
      return !!(modalEl && !modalEl.classList.contains('hidden'));
    }

    function closeModal() {
      if (!modalEl) return;
      modalEl.classList.add('hidden');
      if (formEl && typeof formEl.reset === 'function') formEl.reset();
      if (modeSelectEl) modeSelectEl.value = 'transportation';
      if (colorInputEl) colorInputEl.value = '#ff4d4f';
      if (textInputEl) textInputEl.value = '';
    }

    function openCreateModal() {
      if (!modalEl) return false;
      closeModal();
      modalEl.classList.remove('hidden');
      if (textInputEl) {
        setTimeout(function () {
          try {
            textInputEl.focus();
          } catch (_err) {}
        }, 0);
      }
      return true;
    }

    function handleSubmit(event) {
      event.preventDefault();
      var text = textInputEl ? String(textInputEl.value || '').trim() : '';
      if (!text) {
        if (textInputEl) textInputEl.focus();
        return;
      }
      createItemAtCenter({
        text: text,
        mode: modeSelectEl ? modeSelectEl.value : 'transportation',
        color: colorInputEl ? colorInputEl.value : '#ff4d4f'
      });
      closeModal();
    }

    function bindModal() {
      if (!modalEl || !formEl) return;

      formEl.addEventListener('submit', handleSubmit);
      modalEl.addEventListener('click', function (event) {
        if (event.target === modalEl) closeModal();
      });
      modalEl.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeModal();
        }
      });
      if (cancelBtnEl) {
        cancelBtnEl.addEventListener('click', function () {
          closeModal();
        });
      }
    }

    function loadFromBackend() {
      return fetch('/api/custom-objects', { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('load_failed');
          return res.json();
        })
        .then(function (data) {
          var features = data && Array.isArray(data.features) ? data.features : [];
          var nextItems = [];
          for (var i = 0; i < features.length; i++) {
            var item = featureToItem(features[i]);
            if (item) nextItems.push(item);
          }
          replaceAll(nextItems);
          return nextItems;
        })
        .catch(function (err) {
          onStatusChange('Failed to load custom objects');
          throw err;
        });
    }

    bindModal();

    return {
      getGeoJSON: getGeoJSON,
      isModalOpen: isModalOpen,
      isModeVisible: isModeVisible,
      loadFromBackend: loadFromBackend,
      openCreateModal: openCreateModal,
      getItems: getItems,
      findItemAtViewportPoint: findItemAtViewportPoint,
      setForcedActiveIds: setForcedActiveIds,
      setHighlightedIds: setHighlightedIds,
      setModeTextScale: setModeTextScale,
      setPresentationMode: setPresentationMode,
      getPresentationMode: function () { return presentationMode; },
      setModeVisible: setModeVisible,
      toggleMode: toggleMode,
      updateInteractionTags: updateInteractionTags
    };
  }

  window.CompactCustomMapObjects = { createCustomMapObjects: createCustomMapObjects };
})();
