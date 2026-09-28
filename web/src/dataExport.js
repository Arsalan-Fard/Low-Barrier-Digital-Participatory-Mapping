(function () {
  function createDataExport(options) {
    var drawing = options.drawing;
    var stickerPlacement = options.stickerPlacement;
    var annotationPlacement = options.annotationPlacement;
    var getBasemap = options.getBasemap;
    var getWorkshopMeta = options.getWorkshopMeta;

    function collectAll(opts) {
      if (!(opts && opts.commitActive === false)) annotationPlacement.commitAllActive();
      var payload = {
        timestamp: new Date().toISOString(),
        drawings: drawing.getDrawnGeoJSON(),
        stickers: stickerPlacement.getPlacedGeoJSON(),
        annotations: annotationPlacement.getPlacedGeoJSON()
      };
      var basemap = getBasemap();
      if (basemap) payload.basemap = String(basemap);
      var meta = getWorkshopMeta();
      if (meta) {
        if (meta.workshopId) payload.workshopId = String(meta.workshopId);
        if (meta.workshopName) payload.workshopName = String(meta.workshopName);
      }
      return payload;
    }

    function sendJson(method, url, data, callback) {
      fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
        .then(function (res) { return res.json(); })
        .then(function (result) { callback(null, result); })
        .catch(function (err) { callback(err, null); });
    }

    function saveToBackend(callback) {
      sendJson('POST', '/api/session', collectAll(), callback);
    }

    function updateSession(filename, data, callback) {
      sendJson('PUT', '/api/session/' + encodeURIComponent(filename), data || collectAll(), callback);
    }

    function saveTimelineToBackend(data, callback) {
      sendJson('POST', '/api/timeline-session', data, callback);
    }

    return {
      collectAll: collectAll,
      saveToBackend: saveToBackend,
      updateSession: updateSession,
      saveTimelineToBackend: saveTimelineToBackend
    };
  }

  window.CompactDataExport = { createDataExport: createDataExport };
})();
