(function () {
  function createDataExport(options) {
    var drawing = options.drawing;
    var stickerPlacement = options.stickerPlacement;
    var annotationPlacement = options.annotationPlacement;
    var keyboardAnnotationPlacement = options.keyboardAnnotationPlacement;
    var generalAnnotationPlacement = options.generalAnnotationPlacement;
    var getBasemap = typeof options.getBasemap === 'function' ? options.getBasemap : null;
    var getWorkshopMeta = typeof options.getWorkshopMeta === 'function' ? options.getWorkshopMeta : null;

    function emptyFeatureCollection() {
      return { type: 'FeatureCollection', features: [] };
    }

    function collectAll(options) {
      var shouldCommitActive = !(options && options.commitActive === false);
      if (shouldCommitActive && annotationPlacement && typeof annotationPlacement.commitAllActive === 'function') {
        annotationPlacement.commitAllActive();
      }
      var payload = {
        timestamp: new Date().toISOString(),
        drawings: drawing.getDrawnGeoJSON(),
        stickers: stickerPlacement.getPlacedGeoJSON(),
        annotations: annotationPlacement.getPlacedGeoJSON(),
        keyboardAnnotations: keyboardAnnotationPlacement && typeof keyboardAnnotationPlacement.getGeoJSON === 'function'
          ? keyboardAnnotationPlacement.getGeoJSON()
          : emptyFeatureCollection(),
        generalAnnotations: generalAnnotationPlacement ? generalAnnotationPlacement.getData() : []
      };
      if (getBasemap) {
        var bm = getBasemap();
        if (bm) payload.basemap = String(bm);
      }
      if (getWorkshopMeta) {
        var meta = getWorkshopMeta();
        if (meta && typeof meta === 'object') {
          if (meta.workshopId) payload.workshopId = String(meta.workshopId);
          if (meta.workshopName) payload.workshopName = String(meta.workshopName);
        }
      }
      return payload;
    }

    function saveToBackend(dataOrCallback, maybeCallback) {
      var callback = null;
      var data = null;
      if (typeof dataOrCallback === 'function') {
        callback = dataOrCallback;
        data = collectAll();
      } else {
        data = (dataOrCallback && typeof dataOrCallback === 'object') ? dataOrCallback : collectAll();
        callback = typeof maybeCallback === 'function' ? maybeCallback : null;
      }
      fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
        .then(function (res) { return res.json(); })
        .then(function (result) { if (callback) callback(null, result); })
        .catch(function (err) { if (callback) callback(err, null); });
    }

    function updateSession(filename, data, callback) {
      var safeName = String(filename || '');
      if (!safeName) { if (callback) callback(new Error('invalid_filename'), null); return; }
      var payload = (data && typeof data === 'object') ? data : collectAll();
      fetch('/api/session/' + encodeURIComponent(safeName), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (res) { return res.json(); })
        .then(function (result) { if (callback) callback(null, result); })
        .catch(function (err) { if (callback) callback(err, null); });
    }

    function listSessions(callback) {
      fetch('/api/sessions')
        .then(function (res) { return res.json(); })
        .then(function (result) { if (callback) callback(null, result); })
        .catch(function (err) { if (callback) callback(err, null); });
    }

    function loadSession(filename, callback) {
      fetch('/api/session/' + encodeURIComponent(filename))
        .then(function (res) { return res.json(); })
        .then(function (data) { if (callback) callback(null, data); })
        .catch(function (err) { if (callback) callback(err, null); });
    }

    function saveTimelineToBackend(data, callback) {
      var payload = (data && typeof data === 'object') ? data : {};
      fetch('/api/timeline-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (res) { return res.json(); })
        .then(function (result) { if (callback) callback(null, result); })
        .catch(function (err) { if (callback) callback(err, null); });
    }

    function listTimelines(callback) {
      fetch('/api/timeline-sessions')
        .then(function (res) { return res.json(); })
        .then(function (result) { if (callback) callback(null, result); })
        .catch(function (err) { if (callback) callback(err, null); });
    }

    function loadTimeline(filename, callback) {
      fetch('/api/timeline-session/' + encodeURIComponent(filename))
        .then(function (res) { return res.json(); })
        .then(function (data) { if (callback) callback(null, data); })
        .catch(function (err) { if (callback) callback(err, null); });
    }

    return {
      collectAll: collectAll,
      saveToBackend: saveToBackend,
      updateSession: updateSession,
      listSessions: listSessions,
      loadSession: loadSession,
      saveTimelineToBackend: saveTimelineToBackend,
      listTimelines: listTimelines,
      loadTimeline: loadTimeline
    };
  }

  window.CompactDataExport = { createDataExport: createDataExport };
})();
