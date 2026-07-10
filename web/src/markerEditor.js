// Marker editor — shared by /settings (Marker pane) and /marker.
// Extracted verbatim from settings.html; edit here, both pages update.
    (function () {
      var els = {
        family: document.getElementById('markerFamily'),
        size: document.getElementById('markerSizeCm'),
        download: document.getElementById('markerDownload'),
        body: document.getElementById('markerBody'),
        status: document.getElementById('markerSaveStatus')
      };
      if (!els.family || !els.body) return;

      var state = {
        family: 'tag36h11',
        tagSizeCm: 3,
        slots: [],
        availableFamilies: []
      };
      var saveTimer = 0;
      var colorTools = { draw: true };
      var defaultDrawOffsetCm = 3;

      // Delete button shows for freely-removable draw slots and for ADDED
      // post-its (extra-*). The keyboard location and the first post-it are
      // fixed defaults and never get a delete button.
      function canDeleteSlot(slot) {
        if (!slot) return false;
        if (slot.tool === 'draw') return true;
        return String(slot.key || '').indexOf('extra-') === 0;
      }

      function setMarkerStatus(text, kind) {
        els.status.textContent = text || '';
        els.status.className = 'status-line' + (kind ? ' ' + kind : '');
      }

      function normalizeOffsetCm(raw) {
        var n = Number(raw);
        if (!Number.isFinite(n)) n = defaultDrawOffsetCm;
        return Math.max(0, Math.min(20, n));
      }

      function cloneSlot(slot) {
        var tool = String(slot.tool || '');
        return {
          key: String(slot.key || ''),
          group: String(slot.group || ''),
          tool: tool,
          label: String(slot.label || ''),
          tagId: slot.tagId == null || slot.tagId === '' ? null : Number(slot.tagId),
          tagId2: slot.tagId2 == null || slot.tagId2 === '' ? null : Number(slot.tagId2),
          color: String(slot.color || ''),
          offsetCm: tool === 'draw' || tool === 'eraser' ? normalizeOffsetCm(slot.offsetCm) : undefined
        };
      }

      function applyMarkerData(data) {
        data = data && typeof data === 'object' ? data : {};
        state.family = String(data.family || state.family || 'tag36h11');
        state.tagSizeCm = Number(data.tagSizeCm) || 3;
        state.slots = Array.isArray(data.slots) ? data.slots.map(cloneSlot) : [];
        state.availableFamilies = Array.isArray(data.availableFamilies) ? data.availableFamilies : state.availableFamilies;
        els.size.value = String(state.tagSizeCm);
      }

      function familyIds() {
        for (var i = 0; i < state.availableFamilies.length; i++) {
          if (state.availableFamilies[i].family === state.family) {
            return Array.isArray(state.availableFamilies[i].ids) ? state.availableFamilies[i].ids : [];
          }
        }
        return [];
      }

      function usedByTagId() {
        var used = {};
        state.slots.forEach(function (slot) {
          if (slot.tagId != null && slot.tagId !== '') used[String(Number(slot.tagId))] = slot.key;
          if (slot.tagId2 != null && slot.tagId2 !== '') used[String(Number(slot.tagId2))] = slot.key;
        });
        return used;
      }

      function clearTagIdFromOtherSlots(ownerSlot, tagId) {
        if (tagId == null) return;
        state.slots.forEach(function (other) {
          if (!other || other.key === ownerSlot.key) return;
          ['tagId', 'tagId2'].forEach(function (prop) {
            if (Number(other[prop]) === Number(tagId)) other[prop] = null;
          });
        });
      }

      function clearMatchingTagIdOnSlot(slot, ownerProp, tagId) {
        if (tagId == null || !slot) return;
        ['tagId', 'tagId2'].forEach(function (prop) {
          if (prop !== ownerProp && Number(slot[prop]) === Number(tagId)) slot[prop] = null;
        });
      }

      function scheduleMarkerSave() {
        setMarkerStatus('Saving...', '');
        if (saveTimer) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(saveMarkerSettings, 250);
      }

      function saveMarkerSettings() {
        saveTimer = 0;
        var httpStatus = 0;
        fetch('/api/marker-settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            family: state.family,
            tagSizeCm: Number(state.tagSizeCm) || 3,
            slots: state.slots
          })
        }).then(function (r) {
          httpStatus = r.status;
          // Read the body even on error so we can surface the server's reason.
          return r.json().catch(function () { return null; });
        })
          .then(function (data) {
            if (!data || !data.ok) {
              var reason = (data && (data.detail || data.error)) || ('HTTP ' + (httpStatus || '?'));
              throw new Error(reason);
            }
            applyMarkerData(data);
            renderMarkerEditor();
            setMarkerStatus('Saved', 'ok');
            window.setTimeout(function () {
              if (els.status.textContent === 'Saved') setMarkerStatus('', '');
            }, 1200);
          })
          .catch(function (err) {
            // Surface the real reason (server detail / HTTP status / network) so
            // failures are diagnosable instead of a blank "Save failed".
            var msg = (err && err.message) ? String(err.message) : 'network error';
            setMarkerStatus('Save failed: ' + msg, 'err');
          });
      }

      function renderFamilyOptions() {
        els.family.innerHTML = '';
        state.availableFamilies.forEach(function (entry) {
          var opt = document.createElement('option');
          opt.value = entry.family;
          opt.textContent = entry.family;
          els.family.appendChild(opt);
        });
        els.family.value = state.family;
      }

      function markerSvgPath(tagId) {
        return '/api/apriltag-svg/' + encodeURIComponent(state.family) + '/' + Number(tagId) + '.svg';
      }

      function renderMarkerCard(slot) {
        var card = document.createElement('div');
        card.className = 'marker-card';

        var preview = document.createElement('div');
        preview.className = 'marker-preview';
        if (canDeleteSlot(slot)) {
          var del = document.createElement('button');
          del.className = 'marker-delete';
          del.type = 'button';
          del.title = 'Delete marker';
          del.setAttribute('aria-label', 'Delete marker');
          del.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
            '<path fill="currentColor" d="M9 3v1H4v2h16V4h-5V3H9zM6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13H6zm4 3h1.5v8H10v-8zm2.5 0H14v8h-1.5v-8z"/></svg>';
          del.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            state.slots = state.slots.filter(function (candidate) { return candidate.key !== slot.key; });
            renderMarkerEditor();
            scheduleMarkerSave();
          });
          preview.appendChild(del);
        }
        if (slot.tagId == null || slot.tagId === '') {
          var empty = document.createElement('div');
          empty.className = 'marker-empty';
          empty.textContent = 'Empty';
          preview.appendChild(empty);
        } else {
          var img = document.createElement('img');
          img.alt = 'AprilTag ' + slot.tagId;
          img.src = markerSvgPath(slot.tagId);
          img.onerror = function () {
            preview.innerHTML = '';
            var missing = document.createElement('div');
            missing.className = 'marker-empty';
            missing.textContent = 'Missing';
            preview.appendChild(missing);
          };
          preview.appendChild(img);
        }
        card.appendChild(preview);

        var label = document.createElement('div');
        label.className = 'marker-card-label';
        label.textContent = slot.label || slot.tool || '';
        card.appendChild(label);

        // Two-tag tools (draw / eraser) get a wider card so both tag dropdowns
        // show their numbers instead of clipping. Comment tools are single-tag.
        var twoTag = (slot.tool === 'draw' || slot.tool === 'eraser');
        if (twoTag) card.classList.add('wide');

        var controls = document.createElement('div');
        var controlClasses = ['marker-controls'];
        if (slot.tool === 'draw') controlClasses.push('draw-controls');
        else if (slot.tool === 'eraser') controlClasses.push('eraser-controls');
        else controlClasses.push('no-color');
        controls.className = controlClasses.join(' ');

        var select = document.createElement('select');
        select.className = 'marker-tag-select';
        select.title = slot.tool === 'comment-keyboard' ? 'Keyboard location tag'
          : (slot.tool === 'comment-postit' ? 'Post-it tag' : 'Marker ID');

        var emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = 'Empty';
        select.appendChild(emptyOpt);

        var used = usedByTagId();
        familyIds().forEach(function (id) {
          var opt = document.createElement('option');
          opt.value = String(id);
          opt.textContent = String(id);
          if (used[String(id)] && used[String(id)] !== slot.key) {
            opt.className = 'taken';
            opt.title = 'Already used by another marker';
          }
          select.appendChild(opt);
        });
        select.value = slot.tagId == null ? '' : String(slot.tagId);
        select.addEventListener('change', function () {
          var next = select.value === '' ? null : Number(select.value);
          if (next != null) {
            clearTagIdFromOtherSlots(slot, next);
            clearMatchingTagIdOnSlot(slot, 'tagId', next);
          }
          slot.tagId = next;
          renderMarkerEditor();
          scheduleMarkerSave();
        });
        controls.appendChild(select);

        if (slot.tool === 'draw' || slot.tool === 'eraser') {
          var select2 = document.createElement('select');
          select2.className = 'marker-tag-select';
          select2.title = slot.tool === 'eraser'
            ? 'Fold-partner ID (second tag of the eraser pair)'
            : 'Fold-partner ID (second tag of the drawing pair)';
          var emptyOpt2 = document.createElement('option');
          emptyOpt2.value = '';
          emptyOpt2.textContent = 'Empty';
          select2.appendChild(emptyOpt2);
          familyIds().forEach(function (id) {
            var opt = document.createElement('option');
            opt.value = String(id);
            opt.textContent = String(id);
            if (used[String(id)] && used[String(id)] !== slot.key) {
              opt.className = 'taken';
              opt.title = 'Already used by another marker';
            }
            select2.appendChild(opt);
          });
          select2.value = slot.tagId2 == null ? '' : String(slot.tagId2);
          select2.addEventListener('change', function () {
            var next = select2.value === '' ? null : Number(select2.value);
            if (next != null) {
              clearTagIdFromOtherSlots(slot, next);
              clearMatchingTagIdOnSlot(slot, 'tagId2', next);
            }
            slot.tagId2 = next;
            renderMarkerEditor();
            scheduleMarkerSave();
          });
          controls.appendChild(select2);
        }

        if (colorTools[slot.tool]) {
          var color = document.createElement('input');
          color.className = 'marker-color';
          color.type = 'color';
          color.value = /^#[0-9a-fA-F]{6}$/.test(slot.color || '') ? slot.color : '#ff5b5b';
          color.title = 'Tool color';
          color.addEventListener('input', function () {
            slot.color = color.value;
            scheduleMarkerSave();
          });
          controls.appendChild(color);
        }
        if (slot.tool === 'draw' || slot.tool === 'eraser') {
          var offsetWrap = document.createElement('label');
          offsetWrap.className = 'marker-offset-wrap';
          offsetWrap.title = (slot.tool === 'eraser' ? 'Eraser' : 'Drawing') + ' offset from each tag in centimeters';

          var offset = document.createElement('input');
          offset.className = 'marker-offset';
          offset.type = 'number';
          offset.min = '0';
          offset.max = '20';
          offset.step = '0.1';
          offset.inputMode = 'decimal';
          offset.value = String(normalizeOffsetCm(slot.offsetCm));
          offset.setAttribute('aria-label', 'Drawing offset in centimeters');
          offset.addEventListener('input', function () {
            var next = Number(offset.value);
            if (!Number.isFinite(next)) return;
            slot.offsetCm = Math.max(0, Math.min(20, next));
            scheduleMarkerSave();
          });
          offset.addEventListener('change', function () {
            slot.offsetCm = normalizeOffsetCm(offset.value);
            offset.value = String(slot.offsetCm);
            scheduleMarkerSave();
          });

          var offsetUnit = document.createElement('span');
          offsetUnit.className = 'marker-offset-unit';
          offsetUnit.textContent = 'cm';

          offsetWrap.appendChild(offset);
          offsetWrap.appendChild(offsetUnit);
          controls.appendChild(offsetWrap);
        }
        card.appendChild(controls);
        return card;
      }

      function addMarkerSlot(tool) {
        var count = state.slots.filter(function (slot) { return slot.tool === tool; }).length + 1;
        var isDraw = tool === 'draw';
        var slot = {
          key: 'extra-' + tool + '-' + Date.now().toString(36),
          group: isDraw ? 'Drawing' : 'Comment',
          tool: tool,
          label: (isDraw ? 'Drawing ' : 'Post-it ') + count,
          tagId: null,
          tagId2: null,
          color: isDraw ? '#ff5b5b' : ''
        };
        if (isDraw) slot.offsetCm = defaultDrawOffsetCm;
        state.slots.push(slot);
        renderMarkerEditor();
        scheduleMarkerSave();
      }

      // Build one titled group: its cards in a row, plus an "+" add button for
      // the addable groups (Drawing = draw tools, Comment = keyboard-annotation).
      function buildGroup(groupName) {
        var wrap = document.createElement('div');
        wrap.className = 'marker-group';
        var title = document.createElement('h3');
        title.textContent = groupName;
        wrap.appendChild(title);

        var row = document.createElement('div');
        row.className = 'marker-card-row';
        state.slots.filter(function (slot) { return slot.group === groupName; }).forEach(function (slot) {
          row.appendChild(renderMarkerCard(slot));
        });

        if (groupName === 'Drawing' || groupName === 'Comment') {
          var add = document.createElement('button');
          add.className = 'marker-add-card';
          add.type = 'button';
          add.textContent = '+';
          add.title = groupName === 'Drawing' ? 'Add drawing tool' : 'Add post-it';
          add.addEventListener('click', function () {
            addMarkerSlot(groupName === 'Drawing' ? 'draw' : 'comment-postit');
          });
          row.appendChild(add);
        }
        wrap.appendChild(row);
        return wrap;
      }

      function renderMarkerEditor() {
        renderFamilyOptions();
        els.body.innerHTML = '';
        // Top: the two addable tool groups, each in its own bordered section.
        ['Drawing', 'Comment'].forEach(function (groupName) {
          var section = document.createElement('section');
          section.className = 'marker-section';
          section.appendChild(buildGroup(groupName));
          els.body.appendChild(section);
        });
        // Bottom: fixed tool groups in a compact grid.
        var section = document.createElement('section');
        section.className = 'marker-section';
        var grid = document.createElement('div');
        grid.className = 'marker-bottom-grid';
        ['Tools', 'Shortest-path', 'Analysis'].forEach(function (groupName) {
          if (state.slots.some(function (slot) { return slot.group === groupName; })) {
            grid.appendChild(buildGroup(groupName));
          }
        });
        section.appendChild(grid);
        els.body.appendChild(section);
      }

      function escapeHtml(text) {
        return String(text == null ? '' : text)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      function svgDataUri(svg) {
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      }

      function selectedMarkerEntries() {
        var entries = [];
        var seen = {};
        function add(slot, prop, suffix) {
          if (!slot || slot[prop] == null || slot[prop] === '') return;
          var id = Number(slot[prop]);
          if (!Number.isFinite(id) || seen[String(id)]) return;
          seen[String(id)] = true;
          entries.push({
            slot: slot,
            tagId: id,
            label: String(slot.label || slot.group || 'Marker') + (suffix ? ' ' + suffix : '')
          });
        }
        state.slots.forEach(function (slot) {
          add(slot, 'tagId', '');
          if (slot.tool === 'draw' || slot.tool === 'eraser') add(slot, 'tagId2', 'fold');
          if (slot.tool === 'keyboard-annotation') {
            add(slot, 'tagId2', 'keyboard');
          }
        });
        return entries;
      }

      function downloadMarkerSheet() {
        var entries = selectedMarkerEntries();
        if (!entries.length) {
          window.alert('No marker IDs selected.');
          return;
        }
        var size = Math.max(1, Math.min(20, Number(state.tagSizeCm) || 3));
        setMarkerStatus('Preparing sheet...', '');
        Promise.all(entries.map(function (entry) {
          return fetch(markerSvgPath(entry.tagId), { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('missing'); return r.text(); })
            .then(function (svg) { return { entry: entry, uri: svgDataUri(svg) }; })
            .catch(function () { return { entry: entry, uri: '' }; });
        })).then(function (items) {
          var cards = items.map(function (item) {
            var id = item.entry.tagId;
            var img = item.uri
              ? '<img src="' + item.uri + '" alt="AprilTag ' + escapeHtml(id) + '">'
              : '<div class="missing">Missing SVG</div>';
            return '<div class="tag">' + img +
              '<div class="label">' + escapeHtml(item.entry.label) + ' - ID ' + escapeHtml(id) + '</div></div>';
          }).join('');
          var html = '<!doctype html><html><head><meta charset="utf-8"><title>Markers</title>' +
            '<style>@page{margin:1cm}body{font-family:Arial,sans-serif;color:#111}' +
            '.sheet{display:grid;grid-template-columns:repeat(auto-fill,minmax(' + (size + 1.2) + 'cm,1fr));gap:.8cm;align-items:start}' +
            '.tag{text-align:center;break-inside:avoid}.tag img{width:' + size + 'cm;height:' + size + 'cm;object-fit:contain}' +
            '.label{font-size:10pt;margin-top:.2cm}.missing{width:' + size + 'cm;height:' + size + 'cm;border:1px solid #999;display:flex;align-items:center;justify-content:center;margin:0 auto;color:#777}' +
            '</style></head><body><div class="sheet">' + cards + '</div></body></html>';
          var blob = new Blob([html], { type: 'text/html' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'markers_' + state.family + '_' + String(size).replace('.', '_') + 'cm.html';
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          setMarkerStatus('', '');
        }).catch(function () {
          setMarkerStatus('Download failed', 'err');
        });
      }

      els.family.addEventListener('change', function () {
        state.family = els.family.value || state.family;
        var allowed = {};
        familyIds().forEach(function (id) { allowed[String(id)] = true; });
        state.slots.forEach(function (slot) {
          if (slot.tagId != null && !allowed[String(slot.tagId)]) slot.tagId = null;
          if (slot.tagId2 != null && !allowed[String(slot.tagId2)]) slot.tagId2 = null;
        });
        renderMarkerEditor();
        scheduleMarkerSave();
      });
      els.size.addEventListener('change', function () {
        state.tagSizeCm = Math.max(1, Math.min(20, Number(els.size.value) || 3));
        els.size.value = String(state.tagSizeCm);
        scheduleMarkerSave();
      });
      els.download.addEventListener('click', downloadMarkerSheet);

      fetch('/api/marker-settings', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) { applyMarkerData(data); renderMarkerEditor(); })
        .catch(function () {
          var cfg = (window.CompactMapConfig && window.CompactMapConfig.CONFIG && window.CompactMapConfig.CONFIG.markerSettings) || {};
          applyMarkerData(cfg);
          renderMarkerEditor();
          setMarkerStatus('Load failed', 'err');
        });
    })();
  
