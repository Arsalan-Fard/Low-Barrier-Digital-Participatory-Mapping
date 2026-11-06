(function () {
  // The tag tools for the mouse, for a facilitator at the computer: draw, erase, place a sticker,
  // write a comment, the 15-minute walking reach and the shortest path. One tool is on at a time.
  // Its buttons can sit in several toolbars (the Project panel under Visualization, the running
  // workshop's bar), which all show the same state; clicking the tool again or Esc puts it down.
  // What the mouse adds goes where the tags' input goes, marked input: 'mouse'.
  'use strict';

  // The mouse's key among the tags' in drawing.js and annotationPlacement.js.
  var MOUSE_KEY = 'mouse';
  var INPUT = 'mouse';
  // A press that moves further than this is a pan of the map, not a click.
  var CLICK_TOLERANCE_PX = 5;
  var REACH_MINUTES = 15;

  // Icons: 24 x 24, drawn in the button's text colour.
  var TOOLS = [
    {
      key: 'draw', label: 'Draw', title: 'Draw lines on the map',
      hint: 'Drag on the map to draw in the picked colour. Right-click a colour to choose any other.',
      icon: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>'
    },
    {
      key: 'erase', label: 'Erase', title: 'Rub out lines, stickers and comments',
      hint: 'Drag over lines, stickers and comments to rub them out.',
      icon: '<path d="M8 20h12"/><path d="M4.6 14.6l9.2-9.2a2 2 0 0 1 2.8 0l2 2a2 2 0 0 1 0 2.8L11 18H8z"/><path d="M9 10l5 5"/>'
    },
    {
      key: 'sticker', label: 'Sticker', title: 'Place stickers on the map',
      hint: 'Click the map to place a sticker in the picked colour. Right-click a colour to choose any other.',
      icon: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>'
    },
    {
      key: 'comment', label: 'Comment', title: 'Write comments on the map',
      hint: 'Click the map, type, then press Enter. Click a comment to change it.',
      icon: '<path d="M4 5h16v11h-9l-5 4v-4H4z"/>'
    },
    {
      key: 'reach', label: '15-min walk', title: 'Show how far one walks in 15 minutes',
      hint: 'Click the map to see how far one walks from there in 15 minutes.',
      icon: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M10 2h4"/>'
    },
    {
      key: 'route', label: 'Shortest path', title: 'Show the shortest walking path between two points',
      hint: 'Click where the path starts, then where it ends.',
      icon: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7"/>'
    }
  ];
  var IDLE_HINT = 'Draw, mark and measure on the map with the mouse. Esc puts the tool down.';
  var TOOL_BY_KEY = {};
  TOOLS.forEach(function (t) { TOOL_BY_KEY[t.key] = t; });
  var COLOR_TOOLS = { draw: true, sticker: true };
  var CLEAR_TOOLS = { reach: true, route: true };
  // Draw and Erase drag on the map, so they hold it still; the click tools leave it free to pan.
  var DRAG_TOOLS = { draw: true, erase: true };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function svgIcon(paths) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }

  // options: map, mapView (the element the eraser ring goes in), drawing, stickerPlacement,
  // annotationPlacement, isochrone, routing, eraserRadiusPx, clientToMapPx (a screen point to the map
  // pixel under it, through the page warp), mapPxToLngLat, colors ([{ key, label, color }], the
  // pointers' colours; a sticker takes its pointer's mark type).
  function createMouseTools(options) {
    var map = options.map;
    var mapView = options.mapView;
    var drawing = options.drawing;
    var stickers = options.stickerPlacement;
    var notes = options.annotationPlacement;
    var reach = options.isochrone;
    var routing = options.routing;
    var clientToMapPx = options.clientToMapPx;
    var mapPxToLngLat = options.mapPxToLngLat;
    var eraserRadiusPx = Number(options.eraserRadiusPx) || 32;
    var colors = [];
    // One swatch per colour: pointers that share one share its swatch.
    (options.colors || []).forEach(function (c) {
      if (!c || !c.color) return;
      var color = String(c.color);
      if (colors.some(function (o) { return o.color.toLowerCase() === color.toLowerCase(); })) return;
      colors.push({ key: String(c.key), label: String(c.label || 'Pointer'), color: color });
    });
    if (!colors.length) colors.push({ key: 'draw-1', label: 'Red', color: '#ff5b5b' });
    // A right-click on a swatch picks any colour for it, kept in this browser.
    var PICKED_COLORS_KEY = 'compact.mouseTools.pickedColors';
    var pickedColors = readPickedColors();
    colors.forEach(function (c) {
      c.own = c.color;
      if (/^#[0-9a-f]{6}$/i.test(pickedColors[c.key] || '')) c.color = pickedColors[c.key];
    });
    var colorInput = null; // the browser's colour picker, shared by every swatch

    var container = map.getCanvasContainer();
    var tool = '';
    var colorKey = colors[0].key;
    var status = '';       // replaces the tool's hint while there is news (a path being found, a failure)
    var routeNext = 'a';   // which end of the path the next click sets
    var reachSeq = 0;      // the latest walking reach asked for; older answers are ignored
    var press = null;      // the button held down on the map: { pointerId, tool, startX, startY, lastX, lastY, moved }
    var mapDefaults = null; // the map's drag-pan and double-click zoom from before a tool took over
    var toolbars = [];
    var eraserRing = null;

    function currentColor() {
      for (var i = 0; i < colors.length; i++) {
        if (colors[i].key === colorKey) return colors[i].color;
      }
      return colors[0].color;
    }

    // ---------------------------------------------------------------- picked colours
    function colorEntry(key) {
      for (var i = 0; i < colors.length; i++) {
        if (colors[i].key === key) return colors[i];
      }
      return null;
    }

    function readPickedColors() {
      try {
        var saved = JSON.parse(window.localStorage.getItem(PICKED_COLORS_KEY) || '{}');
        return saved && typeof saved === 'object' ? saved : {};
      } catch (_err) {
        return {};
      }
    }

    function savePickedColors() {
      var changed = {};
      colors.forEach(function (c) {
        if (c.color !== c.own) changed[c.key] = c.color;
      });
      try {
        window.localStorage.setItem(PICKED_COLORS_KEY, JSON.stringify(changed));
      } catch (_err) {
        // Storage refused (a private window): the colour holds until the page reloads.
      }
    }

    // The colour picker takes #rrggbb only.
    function hexColor(color) {
      var match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
      if (!match) return '#000000';
      var hex = match[1].length === 3 ? match[1].replace(/./g, '$&$&') : match[1];
      return '#' + hex.toLowerCase();
    }

    function setPickedColor(key, value) {
      var entry = colorEntry(key);
      if (!entry || !/^#[0-9a-f]{6}$/i.test(String(value))) return;
      entry.color = String(value);
      colorKey = entry.key;
      savePickedColors();
      renderAll();
    }

    // Opens the browser's colour picker at the swatch, starting from its colour; the swatch is picked too.
    function pickColor(key, swatchEl) {
      var entry = colorEntry(key);
      if (!entry) return;
      if (!colorInput) {
        colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.tabIndex = -1;
        colorInput.setAttribute('aria-hidden', 'true');
        Object.assign(colorInput.style, {
          position: 'fixed', width: '1px', height: '1px', padding: '0', border: '0',
          opacity: '0', pointerEvents: 'none'
        });
        var onPick = function () { setPickedColor(colorInput.getAttribute('data-key'), colorInput.value); };
        colorInput.addEventListener('input', onPick);
        colorInput.addEventListener('change', onPick);
        document.body.appendChild(colorInput);
      }
      var rect = swatchEl.getBoundingClientRect();
      colorInput.style.left = rect.left + 'px';
      colorInput.style.top = rect.bottom + 'px';
      colorInput.setAttribute('data-key', entry.key);
      colorInput.value = hexColor(entry.color);
      colorKey = entry.key;
      renderAll();
      try {
        if (typeof colorInput.showPicker === 'function') {
          colorInput.showPicker();
          return;
        }
      } catch (_err) {
        // showPicker refused: fall back to a click.
      }
      colorInput.click();
    }

    function pointAt(clientX, clientY) {
      var px = clientToMapPx(clientX, clientY);
      var ll = mapPxToLngLat(px.x, px.y);
      return { clientX: clientX, clientY: clientY, x: px.x, y: px.y, lng: ll[0], lat: ll[1] };
    }

    // ---------------------------------------------------------------- the map under a tool
    function setHandler(handler, on) {
      if (on) handler.enable();
      else handler.disable();
    }

    function applyMapInteractions() {
      if (!mapDefaults) {
        mapDefaults = { dragPan: map.dragPan.isEnabled(), doubleClickZoom: map.doubleClickZoom.isEnabled() };
      }
      setHandler(map.dragPan, mapDefaults.dragPan && !DRAG_TOOLS[tool]);
      setHandler(map.doubleClickZoom, mapDefaults.doubleClickZoom && !tool);
      if (!tool) mapDefaults = null;
      if (tool) container.setAttribute('data-mouse-tool', tool);
      else container.removeAttribute('data-mouse-tool');
    }

    // The eraser's reach, a ring under the pointer, in map pixels like the erasing itself.
    function moveRing(point) {
      if (!eraserRing) {
        eraserRing = el('div', 'mouse-eraser-ring');
        eraserRing.style.width = (eraserRadiusPx * 2) + 'px';
        eraserRing.style.height = (eraserRadiusPx * 2) + 'px';
        eraserRing.hidden = true;
        mapView.appendChild(eraserRing);
      }
      if (!point || tool !== 'erase') {
        eraserRing.hidden = true;
        return;
      }
      eraserRing.hidden = false;
      eraserRing.style.left = point.x + 'px';
      eraserRing.style.top = point.y + 'px';
    }

    // ---------------------------------------------------------------- what each tool does
    function drawAt(point) {
      drawing.holdStroke(MOUSE_KEY, { lng: point.lng, lat: point.lat, color: currentColor(), input: INPUT }, Date.now());
    }

    function eraseAt(point) {
      drawing.eraseAtPoint(point.lng, point.lat, eraserRadiusPx);
      stickers.eraseAtPoint(point.lng, point.lat, eraserRadiusPx);
      notes.eraseAtClientCircle(point.clientX, point.clientY, eraserRadiusPx);
    }

    // Erases every half radius along the drag, so a quick sweep leaves no gaps between pointer events.
    function eraseAlong(fromX, fromY, toX, toY) {
      var dx = toX - fromX;
      var dy = toY - fromY;
      var steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / (eraserRadiusPx / 2)));
      for (var i = 1; i <= steps; i++) {
        eraseAt(pointAt(fromX + dx * i / steps, fromY + dy * i / steps));
      }
    }

    // A click away from an open textbox places what it holds; an empty one moves to the click.
    function clickComment(point) {
      if (notes.hasActive(MOUSE_KEY) && notes.closeActive(MOUSE_KEY, true)) return;
      var index = notes.placedIndexAtClient(point.clientX, point.clientY);
      if (index >= 0) notes.editPlacedAt(MOUSE_KEY, index, { input: INPUT });
      else notes.openAt(MOUSE_KEY, point.lng, point.lat, { input: INPUT });
    }

    function clickReach(point) {
      var seq = ++reachSeq;
      setStatus('Finding the 15-minute walk…');
      reach.showAt(point.lng, point.lat, REACH_MINUTES, function (ok) {
        if (seq !== reachSeq || tool !== 'reach') return;
        setStatus(ok ? '' : 'No walk found from there. It may be outside the street network.');
      });
    }

    // The first click sets the start, the second the end; the next starts a new path.
    function clickRoute(point) {
      if (routeNext === 'a') {
        routing.clear();
        routing.setEnd('a', point.lng, point.lat);
        routeNext = 'b';
        setStatus('Now click where the path ends.');
        return;
      }
      routeNext = 'a';
      setStatus('Finding the shortest path…');
      routing.setEnd('b', point.lng, point.lat, function (ok) {
        if (tool !== 'route' || routeNext !== 'a') return;
        setStatus(ok ? '' : 'No path found between those points.');
      });
    }

    function click(point) {
      if (tool === 'sticker') {
        stickers.placeAt({ lng: point.lng, lat: point.lat, color: currentColor(), tagId: 'drawpair:' + colorKey, input: INPUT });
      } else if (tool === 'comment') {
        clickComment(point);
      } else if (tool === 'reach') {
        clickReach(point);
      } else if (tool === 'route') {
        clickRoute(point);
      }
    }

    function clearResult() {
      if (tool === 'reach') {
        reachSeq++;
        reach.clear();
      } else if (tool === 'route') {
        routing.clear();
        routeNext = 'a';
      }
      setStatus('');
    }

    // ---------------------------------------------------------------- the pointer on the map
    // The comment textbox and any control on the map keep their own clicks.
    function isOwnControl(target) {
      return !!(target && target.closest && target.closest('.tag-annotation-live, input, textarea, select, button, a'));
    }

    function onPointerDown(e) {
      if (!tool || press || e.button !== 0 || !e.isPrimary || isOwnControl(e.target)) return;
      var point = pointAt(e.clientX, e.clientY);
      if (!Number.isFinite(point.lng) || !Number.isFinite(point.lat)) return;
      press = {
        pointerId: e.pointerId, tool: tool,
        startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false
      };
      if (DRAG_TOOLS[tool]) {
        // The press is the tool's, not the map's: no pan, no text selection.
        e.preventDefault();
        if (tool === 'draw') drawAt(point);
        else eraseAt(point);
      }
      window.addEventListener('pointermove', onPressMove, true);
      window.addEventListener('pointerup', onPressEnd, true);
      window.addEventListener('pointercancel', onPressEnd, true);
    }

    function onPressMove(e) {
      if (!press || e.pointerId !== press.pointerId) return;
      // The points the browser merged into this event too, for smooth lines.
      var events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      if (!events.length) events = [e];
      if (press.tool === 'draw') {
        events.forEach(function (ev) { drawAt(pointAt(ev.clientX, ev.clientY)); });
      } else if (press.tool === 'erase') {
        events.forEach(function (ev) {
          eraseAlong(press.lastX, press.lastY, ev.clientX, ev.clientY);
          press.lastX = ev.clientX;
          press.lastY = ev.clientY;
        });
        moveRing(pointAt(e.clientX, e.clientY));
      } else if (Math.abs(e.clientX - press.startX) > CLICK_TOLERANCE_PX || Math.abs(e.clientY - press.startY) > CLICK_TOLERANCE_PX) {
        press.moved = true;
      }
    }

    function endPress() {
      if (!press) return;
      if (press.tool === 'draw') drawing.releaseStroke(MOUSE_KEY);
      press = null;
      window.removeEventListener('pointermove', onPressMove, true);
      window.removeEventListener('pointerup', onPressEnd, true);
      window.removeEventListener('pointercancel', onPressEnd, true);
    }

    function onPressEnd(e) {
      if (!press || e.pointerId !== press.pointerId) return;
      var ended = press;
      endPress();
      if (e.type !== 'pointerup' || DRAG_TOOLS[ended.tool] || ended.tool !== tool || ended.moved) return;
      if (Math.abs(e.clientX - ended.startX) > CLICK_TOLERANCE_PX || Math.abs(e.clientY - ended.startY) > CLICK_TOLERANCE_PX) return;
      click(pointAt(e.clientX, e.clientY));
    }

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', function (e) {
      if (tool === 'erase' && !press) moveRing(pointAt(e.clientX, e.clientY));
    });
    container.addEventListener('pointerleave', function () {
      if (!press) moveRing(null);
    });
    window.addEventListener('blur', endPress);
    // Esc puts the tool down, except while typing (the comment textbox handles its own Esc).
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !tool) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      setTool('');
    });

    // ---------------------------------------------------------------- state
    // Picking the tool that is on puts it down.
    function setTool(next) {
      next = String(next || '');
      if (next === tool) next = '';
      if (next && !TOOL_BY_KEY[next]) return;
      endPress();
      // Leaving Comment keeps what its open textbox holds.
      if (tool === 'comment' && next !== 'comment') notes.closeActive(MOUSE_KEY, true);
      tool = next;
      status = '';
      routeNext = 'a';
      reachSeq++;
      applyMapInteractions();
      moveRing(null);
      renderAll();
    }

    function setColor(key) {
      colorKey = String(key);
      renderAll();
    }

    function setStatus(text) {
      status = String(text || '');
      renderAll();
    }

    // ---------------------------------------------------------------- toolbars
    // compact: one row, for the workshop bar; the full toolbar (the Project panel) has two columns
    // and a line of help even with no tool on.
    function createToolbar(opts) {
      var compact = !!(opts && opts.compact);
      var root = el('div', 'mouse-tools' + (compact ? ' mouse-tools--compact' : ''));
      root.setAttribute('role', 'group');
      root.setAttribute('aria-label', 'Mouse tools');

      var grid = el('div', 'mt-grid');
      var buttons = {};
      TOOLS.forEach(function (t) {
        var b = el('button', 'mt-btn');
        b.type = 'button';
        b.innerHTML = svgIcon(t.icon);
        b.appendChild(el('span', '', t.label));
        b.title = t.title;
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', function () { setTool(t.key); });
        buttons[t.key] = b;
        grid.appendChild(b);
      });
      root.appendChild(grid);

      var optionsRow = el('div', 'mt-options');
      var swatches = el('div', 'mt-colors');
      swatches.setAttribute('role', 'group');
      swatches.setAttribute('aria-label', 'Colour');
      var swatchEls = {};
      colors.forEach(function (c) {
        var s = el('button', 'mt-swatch');
        s.type = 'button';
        s.style.setProperty('--swatch', c.color);
        s.title = c.label + ' colour (right-click to pick another)';
        s.setAttribute('aria-label', c.label + ' colour');
        s.addEventListener('click', function () { setColor(c.key); });
        s.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          pickColor(c.key, s);
        });
        swatchEls[c.key] = s;
        swatches.appendChild(s);
      });
      optionsRow.appendChild(swatches);
      var clear = el('button', 'mt-clear', 'Clear');
      clear.type = 'button';
      clear.addEventListener('click', clearResult);
      optionsRow.appendChild(clear);
      root.appendChild(optionsRow);

      var hint = el('div', 'mt-hint');
      hint.setAttribute('aria-live', 'polite');
      root.appendChild(hint);

      var bar = {
        compact: compact, buttons: buttons, optionsRow: optionsRow,
        swatches: swatches, swatchEls: swatchEls, clear: clear, hint: hint
      };
      toolbars.push(bar);
      render(bar);
      return root;
    }

    function render(bar) {
      TOOLS.forEach(function (t) {
        bar.buttons[t.key].setAttribute('aria-pressed', t.key === tool ? 'true' : 'false');
      });
      var showColors = !!COLOR_TOOLS[tool];
      var showClear = !!CLEAR_TOOLS[tool];
      bar.optionsRow.hidden = !showColors && !showClear;
      bar.swatches.hidden = !showColors;
      colors.forEach(function (c) {
        bar.swatchEls[c.key].setAttribute('aria-pressed', c.key === colorKey ? 'true' : 'false');
        bar.swatchEls[c.key].style.setProperty('--swatch', c.color);
      });
      bar.clear.hidden = !showClear;
      bar.clear.title = tool === 'route' ? 'Remove the path' : 'Remove the walking reach';
      var text = status || (tool ? TOOL_BY_KEY[tool].hint : (bar.compact ? '' : IDLE_HINT));
      bar.hint.textContent = text;
      bar.hint.hidden = !text;
    }

    function renderAll() {
      toolbars.forEach(render);
    }

    return {
      createToolbar: createToolbar,
      setTool: setTool,
      getTool: function () { return tool; },
      isActive: function () { return !!tool; }
    };
  }

  window.CompactMouseToolsModule = { createMouseTools: createMouseTools };
})();
