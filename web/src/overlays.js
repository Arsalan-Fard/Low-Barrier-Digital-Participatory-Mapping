(function () {
  function createOverlays(options) {
    const map = options.map;
    const cameraStage = options.cameraStage;
    const cameraOverlay = options.cameraOverlay;
    const cameraCtx = cameraOverlay ? cameraOverlay.getContext('2d') : null;
    const maskSourceId = options.maskSourceId || 'tag-mask-source';
    const maskLayerId = options.maskLayerId || 'tag-mask-layer';
    const maskHoldMs = Number(options.maskHoldMs || 500);
    const maskScale = Number(options.maskScale || 1.8);
    const tagMaskCache = new Map(); // tagId -> { ring, lastSeenMs }
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
      const list = Array.isArray(tags) ? tags : [];

      for (let i = 0; i < list.length; i++) {
        const tag = list[i];
        if (!tag || !Array.isArray(tag.uvCorners) || tag.uvCorners.length < 4) continue;

        let sumU = 0;
        let sumV = 0;
        let count = 0;
        for (let ci = 0; ci < 4; ci++) {
          const c = tag.uvCorners[ci];
          if (!c || !Number.isFinite(c.u) || !Number.isFinite(c.v)) continue;
          sumU += c.u;
          sumV += c.v;
          count++;
        }
        if (count < 4) continue;
        const centerU = sumU / count;
        const centerV = sumV / count;

        const ring = [];
        let ok = true;
        for (let ci = 0; ci < 4; ci++) {
          const c = tag.uvCorners[ci];
          if (!c || !Number.isFinite(c.u) || !Number.isFinite(c.v)) {
            ok = false;
            break;
          }
          const scaledU = centerU + (c.u - centerU) * maskScale;
          const scaledV = centerV + (c.v - centerV) * maskScale;
          ring.push(uvToLngLat(scaledU, scaledV));
        }
        if (!ok || ring.length < 4) continue;
        ring.push(ring[0]);

        tagMaskCache.set(String(tag.id), { ring, lastSeenMs: nowMs });
      }

      const features = [];
      for (const [key, entry] of tagMaskCache) {
        if (!entry || !Array.isArray(entry.ring) || !Number.isFinite(entry.lastSeenMs)) {
          tagMaskCache.delete(key);
          continue;
        }
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

    function setMaskEnabled(enabled) {
      maskEnabled = !!enabled;
      if (map.getLayer(maskLayerId)) {
        map.setLayoutProperty(maskLayerId, 'visibility', maskEnabled ? 'visible' : 'none');
      }
      if (!maskEnabled) {
        const source = map.getSource(maskSourceId);
        if (source) source.setData(emptyFeatureCollection());
      }
      return maskEnabled;
    }

    function toggleMaskEnabled() {
      return setMaskEnabled(!maskEnabled);
    }

    function getCameraTransform(frame) {
      if (!cameraStage) return null;
      const fw = Number(frame && frame.width) || 0;
      const fh = Number(frame && frame.height) || 0;
      const sw = cameraStage.clientWidth;
      const sh = cameraStage.clientHeight;
      if (!fw || !fh || !sw || !sh) return null;

      const scale = Math.min(sw / fw, sh / fh);
      const dw = fw * scale;
      const dh = fh * scale;
      const ox = (sw - dw) * 0.5;
      const oy = (sh - dh) * 0.5;

      return { fw, fh, sw, sh, scale, dw, dh, ox, oy };
    }

    function frameToStage(x, y, transform) {
      return {
        x: transform.ox + x * transform.scale,
        y: transform.oy + y * transform.scale
      };
    }

    function clientToFrame(clientX, clientY, frame) {
      const t = getCameraTransform(frame);
      if (!t) return null;
      const rect = cameraStage.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      const lx = sx - t.ox;
      const ly = sy - t.oy;
      if (lx < 0 || ly < 0 || lx > t.dw || ly > t.dh) return null;
      return {
        x: Math.max(0, Math.min(t.fw - 1, lx / t.scale)),
        y: Math.max(0, Math.min(t.fh - 1, ly / t.scale))
      };
    }

    function resizeCameraOverlayIfNeeded() {
      const w = cameraStage.clientWidth;
      const h = cameraStage.clientHeight;
      if (cameraOverlay.width !== w) cameraOverlay.width = w;
      if (cameraOverlay.height !== h) cameraOverlay.height = h;
    }

    function drawCameraOverlay(state) {
      if (state.page !== 'camera') return;
      if (!cameraCtx || !cameraOverlay) return;
      resizeCameraOverlayIfNeeded();
      const w = cameraOverlay.width;
      const h = cameraOverlay.height;
      cameraCtx.clearRect(0, 0, w, h);

      const t = getCameraTransform(state.frame);
      if (!t) return;

      const tags = Array.isArray(state.tags) ? state.tags : [];
      for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        if (!tag || !Array.isArray(tag.corners) || tag.corners.length < 4) continue;

        cameraCtx.beginPath();
        for (let ci = 0; ci < 4; ci++) {
          const c = tag.corners[ci];
          if (!isFinitePoint(c)) continue;
          const p = frameToStage(c.x, c.y, t);
          if (ci === 0) cameraCtx.moveTo(p.x, p.y);
          else cameraCtx.lineTo(p.x, p.y);
        }
        cameraCtx.closePath();
        cameraCtx.lineWidth = 2;
        cameraCtx.strokeStyle = '#00ff66';
        cameraCtx.stroke();

        if (isFinitePoint(tag.center)) {
          const cp = frameToStage(tag.center.x, tag.center.y, t);
          cameraCtx.beginPath();
          cameraCtx.arc(cp.x, cp.y, 4, 0, Math.PI * 2);
          cameraCtx.fillStyle = '#ff2222';
          cameraCtx.fill();

          cameraCtx.font = '13px Arial';
          cameraCtx.lineWidth = 3;
          cameraCtx.strokeStyle = 'rgba(0,0,0,0.75)';
          cameraCtx.strokeText(`id ${tag.id}`, cp.x + 7, cp.y - 7);
          cameraCtx.fillStyle = '#ffffff';
          cameraCtx.fillText(`id ${tag.id}`, cp.x + 7, cp.y - 7);
        }
      }

      const corners = Array.isArray(state.corners) ? state.corners : [null, null, null, null];
      let allCornersSet = true;
      cameraCtx.lineWidth = 2;
      cameraCtx.strokeStyle = '#00d4ff';
      cameraCtx.fillStyle = '#ffd000';
      cameraCtx.font = 'bold 14px Arial';
      for (let i = 0; i < 4; i++) {
        const c = corners[i];
        if (!isFinitePoint(c)) {
          allCornersSet = false;
          continue;
        }
        const p = frameToStage(c.x, c.y, t);
        cameraCtx.beginPath();
        cameraCtx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        cameraCtx.fill();

        cameraCtx.lineWidth = 3;
        cameraCtx.strokeStyle = 'rgba(0,0,0,0.75)';
        cameraCtx.strokeText(String(i + 1), p.x + 8, p.y - 8);
        cameraCtx.fillStyle = '#ffd000';
        cameraCtx.fillText(String(i + 1), p.x + 8, p.y - 8);
      }

      if (allCornersSet) {
        cameraCtx.beginPath();
        for (let i = 0; i < 4; i++) {
          const p = frameToStage(corners[i].x, corners[i].y, t);
          if (i === 0) cameraCtx.moveTo(p.x, p.y);
          else cameraCtx.lineTo(p.x, p.y);
        }
        cameraCtx.closePath();
        cameraCtx.lineWidth = 2;
        cameraCtx.strokeStyle = '#00d4ff';
        cameraCtx.stroke();
      }

      if (state.mouseInsideCamera) {
        const rect = cameraStage.getBoundingClientRect();
        const mx = state.mouseClientX - rect.left;
        const my = state.mouseClientY - rect.top;
        cameraCtx.strokeStyle = 'rgba(255,255,255,0.85)';
        cameraCtx.lineWidth = 1;
        cameraCtx.beginPath();
        cameraCtx.moveTo(mx - 10, my);
        cameraCtx.lineTo(mx + 10, my);
        cameraCtx.moveTo(mx, my - 10);
        cameraCtx.lineTo(mx, my + 10);
        cameraCtx.stroke();
      }
    }

    return {
      isFinitePoint,
      ensureTagMaskLayer,
      updateTagMasks,
      setMaskEnabled,
      toggleMaskEnabled,
      isMaskEnabled: function () { return maskEnabled; },
      clientToFrame,
      drawCameraOverlay
    };
  }

  window.CompactOverlays = { createOverlays: createOverlays };
})();
