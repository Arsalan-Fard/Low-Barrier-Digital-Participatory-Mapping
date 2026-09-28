(function () {
  // The tag mask: white patches over the tags the camera sees, held a moment
  // after a tag disappears.
  function createOverlays(options) {
    const map = options.map;
    const maskSourceId = options.maskSourceId || 'tag-mask-source';
    const maskLayerId = options.maskLayerId || 'tag-mask-layer';
    const maskHoldMs = Number(options.maskHoldMs || 500);
    const maskScale = Number(options.maskScale || 1.8);
    const tagMaskCache = new Map(); // tag id -> { ring, lastSeenMs }
    let maskEnabled = false;

    function isFinitePoint(p) {
      return !!(p && Number.isFinite(p.x) && Number.isFinite(p.y));
    }

    function emptyFeatureCollection() {
      return { type: 'FeatureCollection', features: [] };
    }

    function ensureTagMaskLayer() {
      if (!map.getSource(maskSourceId)) {
        map.addSource(maskSourceId, {
          type: 'geojson',
          data: emptyFeatureCollection()
        });
      }
      if (!map.getLayer(maskLayerId)) {
        map.addLayer({
          id: maskLayerId,
          type: 'fill',
          source: maskSourceId,
          layout: {
            visibility: maskEnabled ? 'visible' : 'none'
          },
          paint: {
            'fill-color': '#ffffff',
            'fill-opacity': 1.0
          }
        });
      }
    }

    function updateTagMasks(tags, uvToLngLat) {
      const source = map.getSource(maskSourceId);
      if (!source) return;
      if (!maskEnabled) {
        source.setData(emptyFeatureCollection());
        return;
      }
      const nowMs = Date.now();

      for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        if (!tag || !Array.isArray(tag.uvCorners) || tag.uvCorners.length < 4) continue;
        const quad = tag.uvCorners.slice(0, 4);
        const complete = quad.every(function (c) { return c && Number.isFinite(c.u) && Number.isFinite(c.v); });
        if (!complete) continue;

        const centerU = (quad[0].u + quad[1].u + quad[2].u + quad[3].u) / 4;
        const centerV = (quad[0].v + quad[1].v + quad[2].v + quad[3].v) / 4;
        const ring = quad.map(function (c) {
          return uvToLngLat(centerU + (c.u - centerU) * maskScale, centerV + (c.v - centerV) * maskScale);
        });
        ring.push(ring[0]);
        tagMaskCache.set(String(tag.id), { ring, lastSeenMs: nowMs });
      }

      const features = [];
      for (const [key, entry] of tagMaskCache) {
        if (nowMs - entry.lastSeenMs > maskHoldMs) {
          tagMaskCache.delete(key);
          continue;
        }
        features.push({
          type: 'Feature',
          properties: { id: key },
          geometry: { type: 'Polygon', coordinates: [entry.ring] }
        });
      }

      source.setData({ type: 'FeatureCollection', features });
    }

    function toggleMaskEnabled() {
      maskEnabled = !maskEnabled;
      if (map.getLayer(maskLayerId)) {
        map.setLayoutProperty(maskLayerId, 'visibility', maskEnabled ? 'visible' : 'none');
      }
      if (!maskEnabled) {
        const source = map.getSource(maskSourceId);
        if (source) source.setData(emptyFeatureCollection());
      }
      return maskEnabled;
    }

    return {
      isFinitePoint,
      ensureTagMaskLayer,
      updateTagMasks,
      toggleMaskEnabled,
      isMaskEnabled: function () { return maskEnabled; }
    };
  }

  window.CompactOverlays = { createOverlays: createOverlays };
})();
