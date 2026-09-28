(function () {
  function createCustomMapObjects(options) {
    var map = options.map;
    var onStatusChange = options.onStatusChange;

    var MODE_LABELS = {
      transportation: 'Transportation',
      landmark: 'Landmark',
      amenities: 'Amenities'
    };
    // Objects saved by older versions name a marker style (styleId) instead of a colour.
    var LEGACY_STYLE_COLORS = {
      'red-square': '#ff4d4f',
      'blue-circle': '#3b82f6',
      'green-diamond': '#22c55e',
      'blue-triangle': '#3b82f6'
    };

    var items = [];
    var markersById = {};
    // 'expanded' shows the objects, 'hidden' hides them.
    var presentationMode = 'hidden';
    var modeVisibility = {
      transportation: true,
      landmark: true,
      amenities: true
    };

    function makeId() {
      return 'custom_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function normalizeMode(mode) {
      var key = String(mode || '').toLowerCase();
      if (key === 'amenity') key = 'amenities';
      return Object.prototype.hasOwnProperty.call(MODE_LABELS, key) ? key : 'transportation';
    }

    function normalizeColor(color, legacyStyleId) {
      var raw = String(color || '').trim();
      if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
      var legacy = String(legacyStyleId || '').trim();
      if (Object.prototype.hasOwnProperty.call(LEGACY_STYLE_COLORS, legacy)) return LEGACY_STYLE_COLORS[legacy];
      return '#ff4d4f';
    }

    function normalizeItem(raw) {
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

    function applyMarkerState(item) {
      var visible = modeVisibility[item.mode] && presentationMode !== 'hidden';
      markersById[item.id].getElement().style.display = visible ? '' : 'none';
    }

    function createMarkerElement(item) {
      var el = document.createElement('div');
      el.className = 'custom-object-marker';
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
      fetch('/api/custom-objects', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'FeatureCollection', features: items.map(itemToFeature) })
      })
        .then(function (res) {
          if (!res.ok) throw new Error('save_failed');
          return res.json();
        })
        .then(function () {
          onStatusChange(successNote);
        })
        .catch(function () {
          onStatusChange('Failed to save custom objects');
        });
    }

    function attachMarker(item) {
      var markerEl = createMarkerElement(item);
      var marker = new mapboxgl.Marker({ element: markerEl, anchor: 'left', draggable: true })
        .setLngLat([item.lng, item.lat])
        .addTo(map);

      marker.on('dragstart', function () {
        markerEl.classList.add('dragging');
      });
      marker.on('dragend', function () {
        var lngLat = marker.getLngLat();
        item.lng = Number(lngLat.lng);
        item.lat = Number(lngLat.lat);
        markerEl.classList.remove('dragging');
        persist('Custom object saved');
      });
      markerEl.addEventListener('contextmenu', function (event) {
        event.preventDefault();
        removeItem(item.id);
      });

      markersById[item.id] = marker;
      applyMarkerState(item);
    }

    function removeItem(id) {
      var remaining = items.filter(function (item) { return item.id !== id; });
      if (remaining.length === items.length) return;
      markersById[id].remove();
      delete markersById[id];
      items = remaining;
      persist('Custom object deleted');
    }

    function clear() {
      items.forEach(function (item) { markersById[item.id].remove(); });
      items = [];
      markersById = {};
    }

    function toggleMode(mode) {
      var key = normalizeMode(mode);
      modeVisibility[key] = !modeVisibility[key];
      items.forEach(function (item) {
        if (item.mode === key) applyMarkerState(item);
      });
      return modeVisibility[key];
    }

    function isModeVisible(mode) {
      return !!modeVisibility[normalizeMode(mode)];
    }

    function setPresentationMode(mode) {
      presentationMode = mode;
      items.forEach(applyMarkerState);
    }

    function loadFromBackend() {
      return fetch('/api/custom-objects', { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('load_failed');
          return res.json();
        })
        .then(function (data) {
          var features = data && Array.isArray(data.features) ? data.features : [];
          clear();
          features.forEach(function (feature) {
            var item = featureToItem(feature);
            if (!item) return;
            items.push(item);
            attachMarker(item);
          });
        })
        .catch(function (err) {
          onStatusChange('Failed to load custom objects');
          throw err;
        });
    }

    return {
      isModeVisible: isModeVisible,
      loadFromBackend: loadFromBackend,
      setPresentationMode: setPresentationMode,
      getPresentationMode: function () { return presentationMode; },
      toggleMode: toggleMode
    };
  }

  window.CompactCustomMapObjects = { createCustomMapObjects: createCustomMapObjects };
})();
