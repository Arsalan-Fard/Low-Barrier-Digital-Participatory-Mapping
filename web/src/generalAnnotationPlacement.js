(function () {
  function createGeneralAnnotationPlacement(options) {
    var containerEl = options.containerEl;
    var lostHoldMs = Number(options.lostHoldMs || 500);

    var enabled = false;
    var rootEl = null;
    var wrapEl = null;
    var inputEl = null;
    var activeTagId = '';
    var activeSide = 'top';
    var activePoint = null;
    var activeLastSeenMs = 0;
    var storedByTag = {};

    function ensureStored(tagId) {
      var key = String(tagId);
      if (!Object.prototype.hasOwnProperty.call(storedByTag, key)) {
        storedByTag[key] = { tagId: key, text: '' };
      }
      return storedByTag[key];
    }

    function ensureDom() {
      if (rootEl) return;

      rootEl = document.createElement('div');
      rootEl.className = 'general-annotation-overlay hidden';

      wrapEl = document.createElement('div');
      wrapEl.className = 'general-annotation-wrap side-top';
      rootEl.appendChild(wrapEl);

      inputEl = document.createElement('textarea');
      inputEl.className = 'tag-annotation-input general-annotation-input';
      inputEl.placeholder = 'Enter a general note...';
      inputEl.maxLength = 320;
      inputEl.rows = 4;
      wrapEl.appendChild(inputEl);

      inputEl.addEventListener('input', function () {
        if (!activeTagId) return;
        ensureStored(activeTagId).text = String(inputEl.value || '');
      });

      inputEl.addEventListener('keydown', function (e) {
        e.stopPropagation();
      });

      inputEl.addEventListener('blur', function () {
        setTimeout(function () {
          ensureInputFocus(false);
        }, 0);
      });

      containerEl.appendChild(rootEl);
    }

    function setSide(side) {
      var nextSide = String(side || 'top');
      if (!wrapEl) return;
      if (activeSide === nextSide) return;
      wrapEl.className = 'general-annotation-wrap side-' + nextSide;
      activeSide = nextSide;
    }

    function focusInput() {
      if (!inputEl) return;
      setTimeout(function () {
        ensureInputFocus(true);
      }, 0);
    }

    function ensureInputFocus(moveCaretToEnd) {
      if (!inputEl || !activeTagId) return;
      if (rootEl && rootEl.classList.contains('hidden')) return;
      if (document.activeElement === inputEl) return;
      try {
        inputEl.focus({ preventScroll: true });
      } catch (_err) {
        try {
          inputEl.focus();
        } catch (_err2) {
          return;
        }
      }
      if (moveCaretToEnd && typeof inputEl.setSelectionRange === 'function') {
        try {
          var len = String(inputEl.value || '').length;
          inputEl.setSelectionRange(len, len);
        } catch (_err3) {}
      }
    }

    function show(tagId, side, point, nowMs) {
      ensureDom();
      var key = String(tagId);
      var wasHidden = rootEl.classList.contains('hidden');
      var tagChanged = activeTagId !== key;

      if (tagChanged) {
        activeTagId = key;
        inputEl.value = ensureStored(key).text || '';
      }

      activePoint = point || null;
      activeLastSeenMs = Number(nowMs) || Date.now();
      setSide(side);
      rootEl.classList.remove('hidden');
      if (wasHidden || tagChanged) focusInput();
    }

    function hide() {
      if (!rootEl) return;
      rootEl.classList.add('hidden');
      activeTagId = '';
      activePoint = null;
      if (inputEl) inputEl.readOnly = false;
    }

    function parsePoint(raw) {
      if (!raw) return null;
      var viewportX = Number(raw.viewportX);
      var viewportY = Number(raw.viewportY);
      if (!Number.isFinite(viewportX) || !Number.isFinite(viewportY)) return null;
      return { viewportX: viewportX, viewportY: viewportY };
    }

    function pointSide(point) {
      if (!point || !containerEl) return null;
      var w = Number(containerEl.clientWidth) || 0;
      var h = Number(containerEl.clientHeight) || 0;
      if (!w || !h) return null;

      var x = Number(point.viewportX);
      var y = Number(point.viewportY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (x < 0 || y < 0 || x > w || y > h) return null;

      var diagDown = (h / w) * x;
      var diagUp = h - ((h / w) * x);

      if (y <= diagDown && y <= diagUp) return 'top';
      if (y >= diagDown && y >= diagUp) return 'bottom';
      if (y >= diagDown && y <= diagUp) return 'left';
      return 'right';
    }

    function setEnabled(nextEnabled) {
      enabled = !!nextEnabled;
      ensureDom();
      if (!enabled) hide();
    }

    function update(pointsByTagId, nowMs, maybeEnabled) {
      if (typeof maybeEnabled === 'boolean') setEnabled(maybeEnabled);
      ensureDom();
      if (!enabled) return;

      var points = pointsByTagId || {};
      var candidateKey = null;
      var candidate = null;
      for (var key in points) {
        if (!Object.prototype.hasOwnProperty.call(points, key)) continue;
        var parsed = parsePoint(points[key]);
        if (!parsed) continue;
        candidateKey = key;
        candidate = parsed;
        break;
      }

      if (candidateKey && candidate) {
        var side = pointSide(candidate);
        if (side) {
          show(candidateKey, side, candidate, nowMs);
          ensureInputFocus(false);
          return;
        }
      }

      if (activeTagId && (Number(nowMs) - Number(activeLastSeenMs || 0)) <= lostHoldMs) {
        rootEl.classList.remove('hidden');
        ensureInputFocus(false);
        return;
      }

      hide();
    }

    function getData() {
      var out = [];
      for (var key in storedByTag) {
        if (!Object.prototype.hasOwnProperty.call(storedByTag, key)) continue;
        var entry = storedByTag[key];
        var text = String((entry && entry.text) || '');
        if (!text) continue;
        out.push({
          tagId: String(entry.tagId || key),
          text: text
        });
      }
      out.sort(function (a, b) { return String(a.tagId).localeCompare(String(b.tagId)); });
      return out;
    }

    function loadData(raw) {
      storedByTag = {};
      var list = Array.isArray(raw)
        ? raw
        : (raw && Array.isArray(raw.entries) ? raw.entries : []);

      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (!item) continue;
        var tagId = String(item.tagId || '');
        if (!tagId) continue;
        ensureStored(tagId).text = String(item.text || '');
      }

      if (inputEl && activeTagId) {
        inputEl.value = ensureStored(activeTagId).text || '';
      } else if (inputEl) {
        inputEl.value = '';
      }
    }

    function clearAll() {
      storedByTag = {};
      if (inputEl) inputEl.value = '';
      hide();
    }

    return {
      setEnabled: setEnabled,
      update: update,
      getData: getData,
      loadData: loadData,
      clearAll: clearAll
    };
  }

  window.CompactGeneralAnnotationPlacement = { createGeneralAnnotationPlacement: createGeneralAnnotationPlacement };
})();
