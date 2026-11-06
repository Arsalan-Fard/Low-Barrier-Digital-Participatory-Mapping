/* Digitizer page: upload photos, digitize them, fix the result by hand.
   The toolbox on the map holds the photo's list -- its pens and, per colour
   name, its mark shapes (the stickers on the paper) -- which both digitizing
   and hand placing use. Editing the list (the pencil) adds and removes marks and pens and takes
   colours from the photo with the eyedropper; Digitize looks for what is
   listed. With a handwriting model chosen in the top bar, the handwriting on
   the map is read too and placed where it was written (the Texts tab).
   Ctrl+Z undoes, Ctrl+Y redoes.
   Every URL is relative to the page, which the app serves at /digitizer/. */
'use strict';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const SHAPES = ['circle', 'triangle', 'star'];
const STAR_INNER = 0.48;   // inner / outer radius of the star, as stickers.py draws it
const ERASER_PX = 10;      // eraser radius on screen
const PEN_KEYS = { red: 'r', blue: 'b' };
const LOOK_MM = { sticker: 3, pen: 1.5 };   // eyedropper reach, as workshop.py samples
const ICONS = {
  move: '<path d="M5 2.5l13.5 10-6 1.2 3.4 6.4-2.6 1.3-3.3-6.4L5 19z" fill="currentColor"/>',
  eraser: '<path d="M14.5 3.6a2 2 0 0 1 2.8 0l3.1 3.1a2 2 0 0 1 0 2.8l-8.8 8.8H7.4l-3.8-3.8a2 2 0 0 1 0-2.8z" fill="#f4c2cf" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8.6 9.5l6 6M11.6 18.3H20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  undo: '<path d="M9 13.5L4 8.5l5-5M4 8.5h10.5a5.5 5.5 0 0 1 0 11H11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  redo: '<path d="M15 13.5l5-5-5-5M20 8.5H9.5a5.5 5.5 0 0 0 0 11H13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  edit: '<path d="M4 20l1.2-4.6L15.6 5a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.5 7l3.5 3.5" stroke="currentColor" stroke-width="1.8"/>',
  text: '<path d="M5 5h14M12 5v14M9 19h6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  dropper: '<path d="M14.6 4.4l5 5M16.5 6.3l2-2a1.8 1.8 0 0 0-2.5-2.5l-2 2M15.7 8.3L7 17l-3 1 1-3 8.7-8.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
};

const state = {
  legend: null,   // the workshop: shapes, and every colour and pen name with its colour
  runId: null, result: null,
  selected: null,
  tool: 'move', pen: null, stamp: null,   // stamp: the sticker a disk places, { shape, colour }
  look: null,     // the eyedropper's name: { kind: 'sticker' | 'pen', name, shape }
  editing: false, adding: null,           // editing the list; adding: the "new colour / pen" form
  busy: false,    // this sheet is being digitised
  gesture: null, hidden: new Set(), spaceDown: false,   // hidden: erased on screen, not yet saved
  view: { x: 0, y: 0, w: 1, h: 1 },
  tab: 'stickers',
  polling: null, statusTimer: null, statuses: {},
  queue: Promise.resolve(),   // edits reach the server one after another
  vlm: { models: [], server: {} },   // the handwriting models the server offers (api/vlm)
};
const VLM_KEY = 'digitizer-vlm';
const KIND_KEYS = { sticker: 's', route: 'r', text: 't' };   // hidden items: key prefix per kind

// ---------------------------------------------------------------- api
async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error || response.statusText);
  return body;
}
const post = (path, data) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});

// Only work in progress stays on screen; anything else fades after a moment.
function setStatus(text, sticky = false) {
  clearTimeout(state.statusTimer);
  $('runStatus').textContent = text || '';
  if (text && !sticky) state.statusTimer = setTimeout(() => { $('runStatus').textContent = ''; }, 4000);
}
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.');

async function loadLegend() {
  state.legend = (await api('api/legend')).legend;
  renderToolbox();
}

// A name's label and colour: the sheet's own list first (it keeps the names it
// uses), then the workshop's.
function nameOf(kind, id) {
  const own = state.result?.legend?.names?.[kind === 'pen' ? 'pens' : 'colours']?.[id];
  const known = (kind === 'pen' ? state.legend?.pens : state.legend?.colours)?.find((c) => c.id === id);
  return { id, label: id || (kind === 'pen' ? 'unknown pen' : '?'), display: kind === 'pen' ? '#7a7a7a' : '#9a9a9a',
    looks: 0, ...known, ...own };
}
const colourOf = (id) => nameOf('sticker', id);
const penOf = (id) => nameOf('pen', id);
// "Pink triangle": what a sticker is, by its name; what it means is on the printed legend.
function stickerName(s) {
  return s.colour ? `${colourOf(s.colour).label} ${s.shape}` : `${s.shape[0].toUpperCase()}${s.shape.slice(1)}, colour unknown`;
}
function sourceText(item) {
  return item.source === 'human' ? 'placed or corrected by hand' : 'detected';
}
const mmToM = () => state.result.map.groundMetresPerPx * state.result.map.pxPerMm;
const round1 = (value) => Math.round(value * 10) / 10;

// ---------------------------------------------------------------- runs
async function loadRuns(selectId) {
  const runs = await api('api/runs');
  const select = $('runSelect');
  select.innerHTML = '';
  state.statuses = Object.fromEntries(runs.map((run) => [run.id, run.status]));
  for (const run of runs) {
    const option = document.createElement('option');
    option.value = run.id;
    if (run.status === 'queued') {
      option.textContent = `${run.label} — waiting…`;
      option.disabled = true;
    } else if (run.status === 'running') {
      option.textContent = `${run.label} — preparing…`;
      option.disabled = true;
    } else if (run.status === 'error') {
      option.textContent = `${run.label} — failed`;
      option.disabled = true;
    } else {
      option.textContent = run.status === 'prepared' ? `${run.label} — to digitize`
        : run.status === 'digitizing' ? `${run.label} — digitizing…`
          : run.status === 'reading' ? `${run.label} — reading handwriting…` : run.label;
    }
    select.appendChild(option);
  }
  const wanted = selectId || state.runId || runs.find((r) => !['queued', 'running', 'error'].includes(r.status))?.id;
  if (wanted) {
    select.value = wanted;
    if (wanted !== state.runId || selectId) await loadRun(wanted);
  }
  return runs;
}

async function loadRun(id) {
  cancelGesture();
  const changed = id !== state.runId;
  state.runId = id;
  state.result = await api(`api/runs/${encodeURIComponent(id)}?t=${Date.now()}`);
  state.selected = null;
  state.hidden.clear();
  state.busy = ['digitizing', 'reading'].includes(state.statuses[id]);
  // a photo waiting for its list opens with the list being edited
  if (changed || state.result.stage === 'prepared') {
    state.editing = state.result.stage === 'prepared';
    state.adding = null;
    if (state.tool === 'look') setTool('move');
  }
  $('empty').style.display = 'none';
  const image = $('mapImage');
  image.setAttribute('href', `runs/${encodeURIComponent(id)}/map.jpg?v=${encodeURIComponent(state.result.created || '')}`);
  for (const node of [image, $('mapPaper')]) {   // white paper shows where the photo is faded
    node.setAttribute('width', state.result.map.width);
    node.setAttribute('height', state.result.map.height);
  }
  fitView();
  renderAll();
}

function findItem(kind, id) {
  const list = { sticker: state.result.stickers, route: state.result.routes, text: state.result.texts || [] }[kind];
  return list.find((x) => x.id === id && !x.deleted) || null;
}

function applyResult(result) {
  state.result = result;
  if (state.selected && !findItem(state.selected.kind, state.selected.id)) state.selected = null;
  renderAll();
}

// Every edit goes through here, in order; the answer is the whole sheet again.
function send(path, body, done) {
  const run = state.runId;
  state.queue = state.queue.then(async () => {
    try {
      const data = await post(`api/runs/${encodeURIComponent(run)}/${path}`, body);
      if (state.runId === run) applyResult(data.result);
      if (done) done();
    } catch (error) {
      setStatus(sentence(error.message));
      if (state.result) renderMapOverlays();
    }
  });
  return state.queue;
}

const undo = () => state.result && send('undo', {}, () => setStatus('Undone.'));
const redo = () => state.result && send('redo', {}, () => setStatus('Redone.'));

// ---------------------------------------------------------------- view
function fitView() {
  const { width, height } = state.result.map;
  state.view = { x: 0, y: 0, w: width, h: height };
  applyView();
}
function applyView() {
  const v = state.view;
  $('map').setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
}
function zoomTo(x, y, size) {
  const svg = $('map').getBoundingClientRect();
  const aspect = svg.width / Math.max(1, svg.height);
  const h = size, w = size * aspect;
  state.view = { x: x - w / 2, y: y - h / 2, w, h };
  applyView();
}
function svgPoint(svg, event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}
const toMap = (event) => svgPoint($('map'), event);
// map units per screen pixel
function screenScale() {
  const rect = $('map').getBoundingClientRect();
  return Math.max(state.view.w / Math.max(1, rect.width), state.view.h / Math.max(1, rect.height));
}

function attachWheelZoom(svg, getView, setView, maxWidth) {
  svg.addEventListener('wheel', (event) => {
    const v = getView();
    if (!v) return;
    event.preventDefault();
    const p = svgPoint(svg, event);
    const factor = Math.exp(event.deltaY * 0.0015);
    const w = Math.min(Math.max(v.w * factor, 60), maxWidth() * 3);
    const f = w / v.w;
    setView({ x: p.x - (p.x - v.x) * f, y: p.y - (p.y - v.y) * f, w, h: v.h * f });
  }, { passive: false });
}

// ---------------------------------------------------------------- the map: tools
// Move: drag to pan, click to see a sticker or line. Any tool pans with the
// right or middle button, or with Space held down.
function installViewer() {
  const svg = $('map');
  attachWheelZoom(svg, () => (state.result ? state.view : null),
    (view) => { state.view = view; applyView(); }, () => state.result.map.width);
  svg.addEventListener('contextmenu', (event) => event.preventDefault());
  svg.addEventListener('pointerdown', mapDown);
  svg.addEventListener('pointermove', mapMove);
  svg.addEventListener('pointerup', mapUp);
  svg.addEventListener('pointercancel', cancelGesture);
  svg.addEventListener('pointerleave', () => { if (!state.gesture) renderGhost(null); });
}

function mapDown(event) {
  if (!state.result || state.gesture) return;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const p = toMap(event);
  const left = event.button === 0;
  if (event.button === 1 || event.button === 2 || (left && (state.spaceDown || state.tool === 'move'))) {
    state.gesture = { kind: 'pan', x: event.clientX, y: event.clientY, view: { ...state.view }, moved: false,
      pick: left && state.tool === 'move' && !state.spaceDown ? event.target : null };
    $('viewer').classList.add('panning');
  } else if (!left || state.busy) {
    return;
  } else if (state.tool === 'look') {
    state.gesture = { kind: 'look', x: event.clientX, y: event.clientY };
  } else if (state.tool === 'pen') {
    state.gesture = { kind: 'stroke', points: [[p.x, p.y]] };
  } else if (state.tool === 'eraser') {
    state.gesture = { kind: 'erase', x: event.clientX, y: event.clientY, moved: false, items: new Set() };
  } else if (state.tool === 'sticker' || state.tool === 'text') {
    state.gesture = { kind: 'place', x: event.clientX, y: event.clientY };
  } else {
    return;
  }
  event.preventDefault();
  $('map').setPointerCapture(event.pointerId);
}

function mapMove(event) {
  if (!state.result) return;
  const p = toMap(event);
  const g = state.gesture;
  renderGhost(g?.kind === 'pan' ? null : p);
  if (!g) return;
  if (g.kind === 'pan') {
    const dx = event.clientX - g.x, dy = event.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) <= 4) return;
    g.moved = true;
    const rect = $('map').getBoundingClientRect();
    const scale = Math.max(g.view.w / rect.width, g.view.h / rect.height);
    state.view = { ...g.view, x: g.view.x - dx * scale, y: g.view.y - dy * scale };
    applyView();
  } else if (g.kind === 'stroke') {
    const last = g.points[g.points.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) >= 2 * screenScale()) {
      g.points.push([p.x, p.y]);
      renderStroke(g.points);
    }
  } else if (g.kind === 'erase') {
    if (!g.moved && Math.hypot(event.clientX - g.x, event.clientY - g.y) <= 4) return;
    g.moved = true;
    for (const item of itemsNear(p, ERASER_PX * screenScale())) hide(g, item);
  }
}

function mapUp(event) {
  const g = state.gesture;
  if (!g) return;
  state.gesture = null;
  $('viewer').classList.remove('panning');
  const p = toMap(event);
  if (g.kind === 'pan') {
    if (g.pick && !g.moved) {
      const item = g.pick.closest?.('[data-kind]');
      select(item ? { kind: item.dataset.kind, id: Number(item.dataset.id) } : null, false);
    }
  } else if (g.kind === 'place') {
    if (Math.hypot(event.clientX - g.x, event.clientY - g.y) <= 6) (state.tool === 'text' ? placeText : placeSticker)(p);
  } else if (g.kind === 'look') {
    if (Math.hypot(event.clientX - g.x, event.clientY - g.y) <= 6) takeLook(p);
  } else if (g.kind === 'stroke') {
    finishStroke(g.points);
  } else if (g.kind === 'erase') {
    if (!g.moved) {   // a click erases the one thing under it: the top sticker, else the nearest line
      const hit = document.elementsFromPoint(event.clientX, event.clientY).find((el) => el.dataset?.kind);
      const item = hit ? { kind: hit.dataset.kind, id: Number(hit.dataset.id) }
        : itemsNear(p, ERASER_PX * screenScale()).sort((a, b) => a.d - b.d)[0];
      if (item) hide(g, item);
    }
    finishErase(g);
  }
}

function cancelGesture() {
  const g = state.gesture;
  state.gesture = null;
  $('viewer').classList.remove('panning');
  $('draftLayer').innerHTML = '';
  if (g?.kind === 'erase' && g.items.size) {
    for (const key of g.items) state.hidden.delete(key);
    renderMapOverlays();
  }
}

function setTool(tool, extra = {}) {
  if (!tool) return;
  cancelGesture();
  state.tool = tool;
  state.pen = tool === 'pen' ? extra.pen : null;
  state.stamp = tool === 'sticker' ? { shape: extra.shape, colour: extra.colour } : null;
  state.look = tool === 'look' ? extra.look : null;
  markTools();
  const viewer = $('viewer');
  viewer.classList.remove('tool-move', 'tool-eraser', 'tool-pen', 'tool-sticker', 'tool-look', 'tool-text');
  viewer.classList.add(`tool-${tool}`);
  renderGhost(null);
}

// The toolbox shows which tool (or which name's eyedropper) is in hand.
function markTools() {
  document.querySelectorAll('#toolbox [data-tool]').forEach((b) => {
    const on = b.dataset.tool === state.tool && (state.tool !== 'pen' || b.dataset.pen === state.pen)
      && (state.tool !== 'sticker' || (b.dataset.shape === state.stamp.shape && b.dataset.colour === state.stamp.colour));
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('#toolbox [data-action="look"]').forEach((b) => {
    b.classList.toggle('active', state.tool === 'look' && b.dataset.kind === state.look?.kind
      && b.dataset.name === state.look?.name);
  });
}

// ---------------------------------------------------------------- the map: edits
// A text typed by hand where something is written.
function placeText(p) {
  const text = window.prompt('What is written here?');
  if (text && text.trim()) send('texts', { x: round1(p.x), y: round1(p.y), text: text.trim() });
}

function placeSticker(p) {
  const { width, height } = state.result.map;
  if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) return setStatus('Marks go on the map.');
  send('stickers', { x: round1(p.x), y: round1(p.y), shape: state.stamp.shape, colour: state.stamp.colour });
}

// ---------------------------------------------------------------- the list
// The eyedropper: the colour under the click becomes a look of the name (a new
// name if it is new) and the name goes on the photo's list. It stays in hand
// for more of the same name: one colour can look different on one photo.
function takeLook(p) {
  const look = state.look;
  const { width, height } = state.result.map;
  if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) return setStatus('Click on the map.');
  send('looks', { kind: look.kind, name: look.name, shape: look.shape || null, x: round1(p.x), y: round1(p.y) },
    async () => {
      await loadLegend();
      const name = look.kind === 'pen' ? penOf(look.id || look.name) : colourOf(look.id || look.name);
      setStatus(`${name.label}: colour taken (${name.looks} look${name.looks === 1 ? '' : 's'}). Click another, or Esc.`, true);
    });
}

const listOf = () => state.result.legend;
const hasType = (shape, colour) => listOf().stickers.some((t) => t.shape === shape && t.colour === colour);

function sendList(stickers, pens) {
  send('list', { stickers, pens });
}
function toggleType(shape, colour) {
  const list = listOf();
  sendList(hasType(shape, colour) ? list.stickers.filter((t) => !(t.shape === shape && t.colour === colour))
    : [...list.stickers, { shape, colour }], list.pens);
}
function togglePen(id) {
  const list = listOf();
  sendList(list.stickers, list.pens.includes(id) ? list.pens.filter((p) => p !== id) : [...list.pens, id]);
}

function toggleEditing() {
  state.editing = !state.editing;
  state.adding = null;
  if (!state.editing && state.tool === 'look') setTool('move');
  renderToolbox();
}

// "+ Colour" / "+ Pen": a name, (for a sticker) its shape, then a click on it in the photo.
function openAdd(kind) {
  state.adding = { kind, name: '', shape: 'circle' };
  renderToolbox();
  $('addName')?.focus();
}
function pickForAdd() {
  const adding = state.adding;
  const name = (adding?.name || '').trim();
  if (!name) return setStatus('Type a name first.');
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  state.adding = null;
  renderToolbox();
  setTool('look', { look: { kind: adding.kind, name, id, shape: adding.kind === 'sticker' ? adding.shape : null } });
  setStatus(adding.kind === 'pen' ? `Click on a line drawn with the ${name.toLowerCase()} pen.`
    : `Click a ${name.toLowerCase()} mark on the photo.`, true);
}

async function digitize() {
  const run = state.runId;
  const label = state.result.sheet?.label || run;
  try {
    await post(`api/runs/${encodeURIComponent(run)}/digitize`, {});
  } catch (error) {
    return setStatus(sentence(error.message));
  }
  state.editing = false;
  state.adding = null;
  if (state.tool === 'look') setTool('move');
  state.busy = true;
  renderToolbox();
  watchRuns([{ runId: run, label }], 'Digitizing');
}

async function readHandwriting() {
  const model = chosenModel();
  const run = state.runId;
  const label = state.result.sheet?.label || run;
  if (!model) return;
  if (!(await modelReady(model))) return;
  try {
    await post(`api/runs/${encodeURIComponent(run)}/handwriting`, { model: model.id });
  } catch (error) {
    return setStatus(sentence(error.message));
  }
  state.busy = true;
  renderAll();
  watchRuns([{ runId: run, label }], 'Reading the handwriting on');
}

// ---------------------------------------------------------------- the handwriting model
function chosenModel() {
  const id = $('vlmSelect').value;
  return id ? state.vlm.models.find((m) => m.id === id) || null : null;
}

async function loadVlm() {
  state.vlm = await api('api/vlm');
  const select = $('vlmSelect');
  let saved = '';
  try { saved = localStorage.getItem(VLM_KEY) || ''; } catch (_error) { /* private window */ }
  select.innerHTML = state.vlm.models.map((m) => `<option value="${escapeHtml(m.id)}"${m.available ? '' : ' class="unavailable"'}>
    ${escapeHtml(m.label)}${m.where ? ` — ${escapeHtml(m.where)}` : ''}${m.available ? '' : ' (not ready)'}</option>`).join('');
  select.value = state.vlm.models.some((m) => m.id === saved) ? saved : '';
  syncVlm();
}

function syncVlm() {
  const model = chosenModel();
  $('vlmServerButton').hidden = !model || !model.id.endsWith('32b');
  if (state.result) renderTexts();
}

// The chosen model can be used now; else the reason is shown (and for the server, its settings).
async function modelReady(model) {
  await loadVlm().catch(() => {});
  const fresh = chosenModel();
  if (fresh && fresh.available) return true;
  setStatus(`${model.label} is not ready: ${(fresh || model).why}.`, true);
  if (model.id.endsWith('32b')) openVlmDialog();
  return false;
}

function openVlmDialog() {
  const form = $('vlmForm');
  form.elements.serverUrl.value = state.vlm.server.url || '';
  form.elements.serverModel.value = state.vlm.server.model || '';
  const model = state.vlm.models.find((m) => m.id.endsWith('32b'));
  $('vlmServerStatus').textContent = model ? (model.available ? 'The server answers.' : sentence(model.why)) : '';
  $('vlmDialog').showModal();
}

function installVlm() {
  $('vlmSelect').addEventListener('change', () => {
    try { localStorage.setItem(VLM_KEY, $('vlmSelect').value); } catch (_error) { /* private window */ }
    syncVlm();
    const model = chosenModel();
    if (model && !model.available) {
      setStatus(`${model.label} is not ready: ${model.why}.`, true);
      if (model.id.endsWith('32b')) openVlmDialog();
    }
  });
  $('vlmServerButton').addEventListener('click', openVlmDialog);
  $('closeVlm').addEventListener('click', () => $('vlmDialog').close());
  $('vlmForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    $('vlmServerStatus').textContent = 'Testing…';
    try {
      state.vlm = await post('api/vlm', { serverUrl: form.elements.serverUrl.value, serverModel: form.elements.serverModel.value });
    } catch (error) {
      $('vlmServerStatus').textContent = sentence(error.message);
      return;
    }
    const keep = $('vlmSelect').value;
    await loadVlm();
    $('vlmSelect').value = keep;
    syncVlm();
    const model = state.vlm.models.find((m) => m.id.endsWith('32b'));
    $('vlmServerStatus').textContent = model.available ? 'Saved. The server answers.' : `Saved, but: ${sentence(model.why)}`;
  });
}

function finishStroke(points) {
  const { width, height } = state.result.map;
  const scale = screenScale();
  const inside = points.map(([x, y]) => [Math.min(Math.max(x, 0), width), Math.min(Math.max(y, 0), height)]);
  const length = inside.slice(1).reduce((sum, q, i) => sum + Math.hypot(q[0] - inside[i][0], q[1] - inside[i][1]), 0);
  if (length < 6 * scale) {   // a click, not a line
    $('draftLayer').innerHTML = '';
    return;
  }
  const line = simplify(inside, 0.8 * scale).map(([x, y]) => [round1(x), round1(y)]);
  send('routes', { points: line, pen: state.pen }).then(() => {
    if (!state.gesture) $('draftLayer').innerHTML = '';
  });
}

// Erased items disappear at once; the server is told when the button goes up.
function hide(gesture, item) {
  const key = `${KIND_KEYS[item.kind]}${item.id}`;
  if (gesture.items.has(key)) return;
  gesture.items.add(key);
  state.hidden.add(key);
  renderMapOverlays();
}

function finishErase(gesture) {
  const keys = [...gesture.items];
  if (!keys.length) return;
  const ids = (prefix) => keys.filter((k) => k[0] === prefix).map((k) => Number(k.slice(1)));
  if (state.selected && keys.includes(`${KIND_KEYS[state.selected.kind]}${state.selected.id}`)) state.selected = null;
  send('erase', { stickers: ids('s'), routes: ids('r'), texts: ids('t') }).then(() => {
    for (const key of keys) state.hidden.delete(key);
    if (state.result) renderMapOverlays();
  });
}

function eraseSelected() {
  const sel = state.selected;
  if (!sel || !state.result) return;
  state.selected = null;
  send('erase', { stickers: sel.kind === 'sticker' ? [sel.id] : [], routes: sel.kind === 'route' ? [sel.id] : [],
    texts: sel.kind === 'text' ? [sel.id] : [] });
}

const isShown = (route) => !route.deleted && (route.kind === 'route' || $('showMarks').checked);

// Stickers, shown lines and texts within `radius` of p (map units), with their distance.
function itemsNear(p, radius) {
  const found = [];
  for (const s of state.result.stickers) {
    if (s.deleted) continue;
    const d = Math.max(0, Math.hypot(s.x - p.x, s.y - p.y) - s.diameter_px * 0.45);
    if (d <= radius) found.push({ kind: 'sticker', id: s.id, d });
  }
  for (const route of state.result.routes) {
    if (!isShown(route)) continue;
    const d = distanceToLine([p.x, p.y], route.points);
    if (d <= radius) found.push({ kind: 'route', id: route.id, d });
  }
  for (const text of state.result.texts || []) {
    if (text.deleted) continue;
    const [x1, y1, x2, y2] = text.box;
    const d = Math.hypot(Math.max(x1 - p.x, 0, p.x - x2), Math.max(y1 - p.y, 0, p.y - y2));
    if (d <= radius) found.push({ kind: 'text', id: text.id, d });
  }
  return found;
}

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function distanceToLine(p, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, segmentDistance(p, points[i - 1], points[i]));
  return points.length === 1 ? Math.hypot(p[0] - points[0][0], p[1] - points[0][1]) : best;
}
// Fewer points, same line: Ramer-Douglas-Peucker within `epsilon`.
function simplify(points, epsilon) {
  if (points.length < 3) return points;
  const keep = points.map((_, i) => i === 0 || i === points.length - 1);
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let index = -1, worst = epsilon;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(points[i], points[a], points[b]);
      if (d > worst) { worst = d; index = i; }
    }
    if (index >= 0) {
      keep[index] = true;
      stack.push([a, index], [index, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------- the toolbox
function shapePoints(shape, radius, cx, cy) {
  const n = shape === 'triangle' ? 3 : 10;
  return Array.from({ length: n }, (_, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const r = shape === 'star' && i % 2 ? radius * STAR_INNER : radius;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  });
}
function shapeNode(shape, diameter, cx, cy, attributes) {
  if (shape === 'circle') return svgEl('circle', { cx, cy, r: diameter / 2, ...attributes });
  const points = shapePoints(shape, diameter / 2, cx, cy).map((q) => q.join(',')).join(' ');
  return svgEl('polygon', { points, ...attributes });
}

const svgIcon = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
function diskIcon(shape, fill) {
  const body = shape === 'circle' ? '<circle cx="12" cy="12" r="8.5"/>'
    : `<polygon points="${shapePoints(shape, shape === 'star' ? 11 : 10, 12, shape === 'star' ? 12.5 : 13.5)
      .map((q) => q.map((v) => v.toFixed(2)).join(',')).join(' ')}"/>`;
  return svgIcon(`<g fill="${fill}" stroke="#0006" stroke-width="1" stroke-linejoin="round">${body}</g>`);
}
const penIcon = (colour) => svgIcon(`<path d="M3 17c2.5-5 5-6 7-3s4.5 2 6.5-2.5S19 6 21 5" fill="none" stroke="${colour}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`);

const toolButton = (attributes, title, inner, cls = '') => `<button type="button" class="${cls}" ${attributes} title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${inner}</button>`;

// Names in the workshop's order (the stock's first), then any others.
function inOrder(ids, known) {
  return [...new Set([...known.map((n) => n.id).filter((id) => ids.includes(id)), ...ids])];
}

// One row per name: pens, then sticker colours with a cell per shape. The
// list (on the photo or not) is what Digitize looks for; editing shows every
// name the workshop knows, faded where it is not on this photo's list.
function renderToolbox() {
  const box = $('toolbox');
  if (!state.legend || !state.result) { box.innerHTML = ''; return; }
  const list = listOf();
  const editing = state.editing && !state.busy;
  const prepared = state.result.stage === 'prepared';
  const penIds = inOrder(editing ? [...list.pens, ...state.legend.pens.map((p) => p.id)] : list.pens, state.legend.pens);
  const colourIds = inOrder(editing ? [...list.stickers.map((t) => t.colour), ...state.legend.colours.map((c) => c.id)]
    : list.stickers.map((t) => t.colour), state.legend.colours);
  const shapes = editing ? SHAPES : SHAPES.filter((s) => list.stickers.some((t) => t.shape === s));
  const columns = Math.max(1, shapes.length);
  const looks = (item) => `${item.looks} look${item.looks === 1 ? '' : 's'}`;
  const nameCell = (kind, item) => (editing
    ? toolButton(`data-action="look" data-kind="${kind}" data-name="${escapeHtml(item.id)}"`,
      `${item.label} (${looks(item)}): click, then click ${kind === 'pen' ? 'a line drawn with it' : 'one of its marks'} on the photo to take its colour`,
      `${svgIcon(ICONS.dropper)}<span>${escapeHtml(item.label)}</span>`, 'name')
    : `<span class="name" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>`);
  const rows = [`<div class="row">
    ${toolButton('data-tool="move"', 'Move (S): drag the map, click a mark or line to see it', svgIcon(ICONS.move))}
    ${toolButton('data-tool="eraser"', 'Eraser (E): click or drag over marks, lines and texts', svgIcon(ICONS.eraser))}
    ${toolButton('data-tool="text"', 'Text (T): click where something is written and type it', svgIcon(ICONS.text))}
    <span class="grow"></span>
    ${toolButton('data-action="undo"', 'Undo (Ctrl+Z)', svgIcon(ICONS.undo))}
    ${toolButton('data-action="redo"', 'Redo (Ctrl+Y)', svgIcon(ICONS.redo))}</div>`];
  if (penIds.length || editing) rows.push('<span class="sep"></span>');
  for (const id of penIds) {
    const pen = penOf(id);
    const on = list.pens.includes(id);
    const key = PEN_KEYS[id];
    rows.push(nameCell('pen', pen) + (editing
      ? toolButton(`data-action="toggle-pen" data-pen="${escapeHtml(id)}"`,
        `${pen.label} pen: ${on ? "on this photo's list (click to take it off)" : "not on this photo's list (click to add it)"}`,
        penIcon(pen.display), on ? '' : 'off')
      : toolButton(`data-tool="pen" data-pen="${escapeHtml(id)}"`,
        `${pen.label} pen${key ? ` (${key.toUpperCase()})` : ''}: drag to draw a line`, penIcon(pen.display)))
      + '<span></span>'.repeat(columns - 1));
  }
  if (editing) rows.push(addRow('pen'));
  if (colourIds.length || editing) rows.push('<span class="sep"></span>');
  for (const id of colourIds) {
    const colour = colourOf(id);
    rows.push(nameCell('sticker', colour) + shapes.map((shape) => {
      const on = hasType(shape, id);
      const what = `${colour.label} ${shape}`;
      if (editing) {
        return toolButton(`data-action="toggle-type" data-shape="${shape}" data-colour="${escapeHtml(id)}"`,
          `${what}: ${on ? "on this photo's list (click to take it off)" : "not on this photo's list (click to add it)"}`,
          diskIcon(shape, colour.display), on ? '' : 'off');
      }
      return on ? toolButton(`data-tool="sticker" data-shape="${shape}" data-colour="${escapeHtml(id)}"`,
        `${what}: click the map to place one`, diskIcon(shape, colour.display)) : '<span></span>';
    }).join(''));
  }
  if (editing) rows.push(addRow('sticker'));
  rows.push('<span class="sep"></span>');
  const pending = prepared || state.result.listChanged;
  rows.push(`<div class="row">
    ${toolButton('data-action="edit"', editing ? 'Done with the list' : "Edit this photo's list: which marks and pens are on it, and their colours",
    svgIcon(ICONS.edit), editing ? 'active' : '')}
    ${editing || pending ? toolButton('data-action="digitize"', prepared ? 'Find the listed marks and pens on this photo'
    : 'Digitize again with this list: what you placed, drew or erased by hand stays',
    prepared ? 'Digitize' : 'Digitize again', `wide${pending ? ' primary' : ''}`) : ''}</div>`);
  box.innerHTML = rows.join('');
  box.style.setProperty('--cols', columns);
  box.classList.toggle('editing', editing);
  box.classList.toggle('busy', state.busy);
  wireAdd();
  // a tool for something no longer on the list is put down
  if ((state.tool === 'sticker' && !hasType(state.stamp.shape, state.stamp.colour))
    || (state.tool === 'pen' && !list.pens.includes(state.pen))) setTool('move');
  markTools();
}

function addRow(kind) {
  if (state.adding?.kind !== kind) {
    return `<div class="row">${toolButton(`data-action="add" data-kind="${kind}"`, kind === 'pen'
      ? 'A pen not listed yet: name it, then click a line drawn with it'
      : 'A mark colour not listed yet: name it, pick its shape, then click one of its marks on the photo',
    kind === 'pen' ? '+ Pen' : '+ Colour', 'add')}</div>`;
  }
  const known = (kind === 'pen' ? state.legend.pens : state.legend.colours)
    .map((n) => `<option value="${escapeHtml(n.label)}"></option>`).join('');
  const shapes = kind === 'sticker' ? SHAPES.map((s) => toolButton(`data-action="add-shape" data-shape="${s}"`, `A ${s}`,
    diskIcon(s, '#b9b9b9'), state.adding.shape === s ? 'active' : '')).join('') : '';
  return `<div class="row add-form">
    <input id="addName" list="addNames" placeholder="${kind === 'pen' ? 'Pen name' : 'Colour name'}" value="${escapeHtml(state.adding.name)}" autocomplete="off">
    <datalist id="addNames">${known}</datalist>
    ${shapes}
    <span class="grow"></span>
    ${toolButton('data-action="add-pick"', kind === 'pen' ? 'Then click a line drawn with it (Enter)' : 'Then click one of its marks on the photo (Enter)', svgIcon(ICONS.dropper))}
    ${toolButton('data-action="add-cancel"', 'Cancel (Esc)', '×')}</div>`;
}

function wireAdd() {
  const input = $('addName');
  if (!input) return;
  input.addEventListener('input', () => { state.adding.name = input.value; });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); pickForAdd(); }
    if (event.key === 'Escape') { event.preventDefault(); state.adding = null; renderToolbox(); }
  });
}

// ---------------------------------------------------------------- rendering
function renderAll() {
  renderToolbox();
  renderMapOverlays();
  renderLists();
  renderExport();
  renderInspector();
}

function svgEl(name, attributes) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function renderMapOverlays() {
  const r = state.result;
  const opacity = Number($('overlayOpacity').value) / 100;
  const routes = $('routesLayer');
  const stickers = $('stickersLayer');
  const texts = $('textsLayer');
  routes.innerHTML = '';
  stickers.innerHTML = '';
  texts.innerHTML = '';
  if (!r) return;
  routes.setAttribute('opacity', opacity);
  stickers.setAttribute('opacity', Math.min(1, opacity + 0.1));
  for (const route of r.routes) {
    if (!isShown(route) || state.hidden.has(`r${route.id}`)) continue;
    const points = route.points.map((p) => p.join(',')).join(' ');
    routes.appendChild(svgEl('polyline', { class: 'route-halo', points }));
    routes.appendChild(svgEl('polyline', {
      class: `route ${route.kind}${isSelected('route', route.id) ? ' selected' : ''}`,
      points, stroke: penOf(route.pen).display, 'data-kind': 'route', 'data-id': route.id,
    }));
  }
  for (const s of r.stickers) {
    if (s.deleted || state.hidden.has(`s${s.id}`)) continue;
    const colour = colourOf(s.colour);
    stickers.appendChild(svgEl('polygon', {
      class: `sticker${isSelected('sticker', s.id) ? ' selected' : ''}`,
      points: s.polygon.map((p) => p.join(',')).join(' '),
      fill: colour.display, 'fill-opacity': 0.28, stroke: colour.display,
      'data-kind': 'sticker', 'data-id': s.id,
    }));
    const label = svgEl('text', { class: 'sticker-label', x: s.x, y: s.y + 8, 'text-anchor': 'middle' });
    label.textContent = s.id;
    stickers.appendChild(label);
  }
  texts.setAttribute('opacity', Math.min(1, opacity + 0.1));
  const size = 4 * r.map.pxPerMm;   // the words as about 4 mm letters on the paper
  for (const t of r.texts || []) {
    if (t.deleted || state.hidden.has(`t${t.id}`)) continue;
    const [x1, y1, x2, y2] = t.box;
    texts.appendChild(svgEl('rect', {
      class: `text-box${isSelected('text', t.id) ? ' selected' : ''}`, x: x1, y: y1, width: x2 - x1, height: y2 - y1,
      rx: 4, 'data-kind': 'text', 'data-id': t.id,
    }));
    const label = svgEl('text', { class: 'text-label', x: (x1 + x2) / 2, y: y1 - size * 0.35, 'text-anchor': 'middle',
      'font-size': size });
    label.textContent = t.text;
    texts.appendChild(label);
  }
}

// The line being drawn, in its pen's colour.
function renderStroke(points) {
  const layer = $('draftLayer');
  layer.innerHTML = '';
  const line = points.map((p) => p.join(',')).join(' ');
  layer.appendChild(svgEl('polyline', { class: 'route-halo', points: line }));
  layer.appendChild(svgEl('polyline', { class: 'route', points: line, stroke: penOf(state.pen).display }));
}

// What the pointer would do: the sticker a disk places, or the eraser's reach.
function renderGhost(p) {
  const layer = $('ghostLayer');
  layer.innerHTML = '';
  if (!p || !state.result || state.spaceDown) return;
  if (state.tool === 'sticker') {
    const { shape, colour } = state.stamp;
    const diameter = state.legend.shapes[shape] * state.result.map.pxPerMm;
    layer.appendChild(shapeNode(shape, diameter, p.x, p.y, { class: 'ghost', fill: colourOf(colour).display }));
  } else if (state.tool === 'eraser') {
    layer.appendChild(svgEl('circle', { class: 'eraser-ring', cx: p.x, cy: p.y, r: ERASER_PX * screenScale() }));
  } else if (state.tool === 'look') {   // what the eyedropper reads
    layer.appendChild(svgEl('circle', { class: 'look-ring', cx: p.x, cy: p.y, r: LOOK_MM[state.look.kind] * state.result.map.pxPerMm }));
  }
}

const isSelected = (kind, id) => state.selected?.kind === kind && state.selected?.id === id;

function stickerSwatch(s) {
  return `<span class="swatch ${s.shape}" style="background:${colourOf(s.colour).display}"></span>`;
}
function sourceShort(item) {
  return item.source === 'human' ? 'by hand' : '';
}

function renderLists() {
  const r = state.result;
  $('stickerList').innerHTML = r.stickers.filter((s) => !s.deleted).map((s) => `
    <li data-kind="sticker" data-id="${s.id}" class="${isSelected('sticker', s.id) ? 'selected' : ''}">
      ${stickerSwatch(s)}<span>#${s.id} ${escapeHtml(stickerName(s))}</span>
      <span class="meta">${sourceShort(s)}</span>
    </li>`).join('') || '<li class="done">No marks.</li>';
  const factor = mmToM();
  $('routeList').innerHTML = r.routes.filter(isShown).map((route) => `
    <li data-kind="route" data-id="${route.id}" class="${isSelected('route', route.id) ? 'selected' : ''}">
      <span class="swatch line" style="background:${penOf(route.pen).display}"></span>
      <span>#${route.id} ${escapeHtml(penOf(route.pen).label)}${route.kind === 'mark' ? ' (short stroke)' : ''}</span>
      <span class="meta">${Math.round(route.length_px / r.map.pxPerMm * factor)} m</span>
    </li>`).join('') || '<li class="done">No routes.</li>';
  renderTexts();
}

// The Texts tab: the handwriting on the map, read by the chosen model or typed by hand.
function renderTexts() {
  const r = state.result;
  const model = chosenModel();
  const read = r.handwriting ? ` Last read with ${escapeHtml(r.handwriting.model)}.` : '';
  $('textTools').innerHTML = `
    <button type="button" id="readHandwriting" class="primary" ${model && !state.busy ? '' : 'disabled'}
      title="${model ? `Read the handwriting on this map with ${escapeHtml(model.label)}; texts typed or fixed by hand stay`
        : 'Choose a handwriting model in the top bar first'}">Read handwriting</button>
    <span class="muted">${model ? `with ${escapeHtml(model.label)}` : 'No model chosen'}.${read}</span>`;
  $('readHandwriting').addEventListener('click', readHandwriting);
  $('textList').innerHTML = (r.texts || []).filter((t) => !t.deleted).map((t) => `
    <li data-kind="text" data-id="${t.id}" class="${isSelected('text', t.id) ? 'selected' : ''}">
      <span>#${t.id} ${escapeHtml(t.text)}</span>
      <span class="meta">${sourceShort(t)}</span>
    </li>`).join('') || '<li class="done">No handwriting yet.</li>';
}

// ---------------------------------------------------------------- selection + inspector
function select(item, zoom) {
  state.selected = item;
  if (item && zoom) {
    const found = findItem(item.kind, item.id);
    if (found && item.kind === 'sticker') zoomTo(found.x, found.y, found.diameter_px * 6);
    if (found && item.kind === 'text') {
      const [x1, y1, x2, y2] = found.box;
      zoomTo((x1 + x2) / 2, (y1 + y2) / 2, Math.max(x2 - x1, y2 - y1) * 2.5 + 150);
    }
    if (found && item.kind === 'route') {
      const xs = found.points.map((p) => p[0]), ys = found.points.map((p) => p[1]);
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      zoomTo((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, span * 1.3 + 200);
    }
  }
  renderMapOverlays();
  renderLists();
  renderInspector();
}

function previewSvg(x, y, size) {
  const href = `runs/${encodeURIComponent(state.runId)}/map.jpg`;
  const { width, height } = state.result.map;
  return `<svg class="preview" viewBox="${x - size / 2} ${y - size / 2} ${size} ${size}" preserveAspectRatio="xMidYMid meet">
    <image href="${href}" x="0" y="0" width="${width}" height="${height}"></image></svg>`;
}

function renderInspector() {
  const box = $('inspector');
  const sel = state.selected;
  const item = sel && state.result ? findItem(sel.kind, sel.id) : null;
  if (!item) { box.innerHTML = ''; return; }
  if (sel.kind === 'sticker') {
    box.innerHTML = `
      <h3>Mark #${item.id} — ${escapeHtml(stickerName(item))}</h3>
      ${previewSvg(item.x, item.y, item.diameter_px * 3)}
      <p class="muted">${sourceText(item)}</p>`;
  } else if (sel.kind === 'text') {
    const [x1, y1, x2, y2] = item.box;
    box.innerHTML = `
      <h3>Text #${item.id}</h3>
      ${previewSvg((x1 + x2) / 2, (y1 + y2) / 2, Math.max(x2 - x1, y2 - y1) * 1.6 + 60)}
      <form class="text-edit" id="textEdit"><input name="text" value="${escapeHtml(item.text)}" aria-label="The text">
        <button type="submit">Save</button></form>
      <p class="muted">${item.source === 'human' ? 'typed or fixed by hand' : `read by ${escapeHtml(state.result.handwriting?.model || 'the model')}`}</p>`;
    $('textEdit').addEventListener('submit', (event) => {
      event.preventDefault();
      const text = event.target.elements.text.value.trim();
      if (!text) return eraseSelected();
      send('texts', { id: item.id, text }, () => setStatus('Text saved.'));
    });
  } else {
    const pen = penOf(item.pen);
    const metres = Math.round(item.length_px / state.result.map.pxPerMm * mmToM());
    const notes = [];
    if (item.kind === 'mark') notes.push('A short stroke (under 25 mm on paper): not counted as a route.');
    if ((item.flags || []).includes('labelled-metro')) notes.push('The child wrote METRO along it: a metro trip, not a bike route.');
    box.innerHTML = `
      <h3>Route #${item.id} — ${escapeHtml(pen.label)} pen</h3>
      <p class="muted">${metres} m on the ground · ${sourceText(item)}</p>
      ${notes.map((note) => `<p class="note">${note}</p>`).join('')}`;
  }
  box.insertAdjacentHTML('beforeend',
    '<div class="actions"><button type="button" class="danger" id="eraseSelected" title="Delete">Erase</button></div>');
  $('eraseSelected').addEventListener('click', eraseSelected);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- export
function renderExport() {
  const run = encodeURIComponent(state.runId);
  $('exportPanel').innerHTML = `
    <div class="actions">
      <a href="api/runs/${run}/export.geojson" download><button type="button" class="primary">Download GeoJSON</button></a>
      <a href="api/export.geojson" download><button type="button">Download all</button></a>
    </div>
    <p class="note" id="resultsFile"></p>`;
  // A digitised sheet is in the Results panel of Run a Workshop: every save rewrites its GeoJSON
  // in the results folder the two share.
  api(`api/runs/${run}/results-file`).then((body) => {
    const note = $('resultsFile');
    if (!note) return;
    note.textContent = body.exists
      ? `In Results (Run a Workshop), kept up to date on every save: ${body.path}`
      : 'It will be in Results (Run a Workshop) once digitized.';
  }).catch(() => {});
}

// ---------------------------------------------------------------- upload
// Photos come from the drop zone (click to browse, or drop them on it) or are dropped anywhere on the
// page; they are listed with a preview, each removable, and sent together. A name like 2_05_map.jpg
// fills in the map ID when it is empty and gives the sheet its number.
const PHOTO_NAME = /^(\d+)[_-](\d+)/;
const upload = { files: [], urls: new Map(), autoId: '' };

const isImage = (file) => file.type.startsWith('image/') || /\.(jpe?g|png|webp|tiff?|bmp|heic)$/i.test(file.name);
const sameFile = (a, b) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

function fileSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function showUploadError(text) {
  $('uploadError').textContent = text;
  $('uploadError').hidden = !text;
}

function addUploadFiles(list) {
  const files = [...(list || [])];
  const images = files.filter(isImage);
  for (const file of images) {
    if (!upload.files.some((known) => sameFile(known, file))) upload.files.push(file);
  }
  const mapId = $('newRunForm').elements.mapId;
  if (!mapId.value.trim() || mapId.value === upload.autoId) {
    const ids = new Set(upload.files.map((file) => (PHOTO_NAME.exec(file.name) || [])[1]).filter(Boolean));
    if (ids.size === 1) {
      upload.autoId = [...ids][0];
      mapId.value = upload.autoId;
      mapId.classList.remove('invalid');
    }
  }
  const skipped = files.length - images.length;
  showUploadError(!skipped ? '' : skipped === 1 ? 'One file is not a photo and was left out.'
    : `${skipped} files are not photos and were left out.`);
  renderUploadList();
}

function removeUploadFile(index) {
  const [file] = upload.files.splice(index, 1);
  const url = upload.urls.get(file);
  if (url) URL.revokeObjectURL(url);
  upload.urls.delete(file);
  renderUploadList();
}

function clearUpload() {
  upload.urls.forEach((url) => URL.revokeObjectURL(url));
  upload.urls.clear();
  upload.files = [];
  const form = $('newRunForm');
  form.elements.sheetNumber.value = '';
  form.elements.mapId.classList.remove('invalid');
  showUploadError('');
  renderUploadList();
}

function renderUploadList() {
  const list = $('uploadList');
  const files = upload.files;
  const mapId = $('newRunForm').elements.mapId.value.trim();
  list.innerHTML = '';
  files.forEach((file, index) => {
    if (!upload.urls.has(file)) upload.urls.set(file, URL.createObjectURL(file));
    const match = PHOTO_NAME.exec(file.name);
    const numbered = match && match[1] === mapId && Number(match[2]) > 0 && files.length > 1;
    const item = document.createElement('li');
    item.innerHTML = `<img alt="" src="${upload.urls.get(file)}">
      <span class="file"><b title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</b>
        <span>${fileSize(file.size)}${numbered ? ` · sheet ${Number(match[2])}` : ''}</span></span>
      <button type="button" class="icon-button" data-remove="${index}" aria-label="Remove ${escapeHtml(file.name)}" title="Remove">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>`;
    list.appendChild(item);
  });
  list.hidden = !files.length;
  // Once photos are chosen the zone shrinks to an "add more" strip.
  const zone = $('dropZone');
  zone.classList.toggle('compact', files.length > 0);
  zone.querySelector('.drop-title').innerHTML = files.length
    ? '<b>Add more photos</b> <span class="muted">drop or</span> <span class="drop-link">browse</span>'
    : '<b>Drop photos here</b> or <span class="drop-link">browse</span>';
  // A sheet number only makes sense for a single photo.
  $('sheetNumberField').hidden = files.length > 1;
  const button = $('submitNewRun');
  button.disabled = !files.length;
  button.textContent = files.length > 1 ? `Upload and digitise ${files.length} photos` : 'Upload and digitise';
}

const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');

function installNewRun() {
  const dialog = $('newRunDialog');
  const form = $('newRunForm');
  const zone = $('dropZone');
  const input = $('mapPhotoInput');
  const open = () => { if (!dialog.open) dialog.showModal(); };
  // Closing forgets the chosen photos. Escape closes it too, which only the close event tells; that
  // event can come late, so it clears only while the card is still shut.
  const close = () => { dialog.close(); clearUpload(); };

  $('newRunButton').addEventListener('click', open);
  $('cancelNewRun').addEventListener('click', close);
  $('closeNewRun').addEventListener('click', close);
  dialog.addEventListener('close', () => { if (!dialog.open) clearUpload(); });
  form.elements.mapId.addEventListener('input', () => {
    form.elements.mapId.classList.remove('invalid');
    renderUploadList();
  });

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => { addUploadFiles(input.files); input.value = ''; });
  zone.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', (event) => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove('over');
  });
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.remove('over');
    addUploadFiles(event.dataTransfer.files);
  });
  $('uploadList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove]');
    if (button) removeUploadFile(Number(button.dataset.remove));
  });

  // Photos dropped anywhere on the page open the upload with them.
  const cover = $('pageDrop');
  let depth = 0;
  document.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    depth += 1;
    if (!dialog.open) cover.hidden = false;
  });
  document.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) cover.hidden = true;
  });
  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    cover.hidden = true;
    open();
    addUploadFiles(event.dataTransfer.files);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const mapId = form.elements.mapId.value.trim();
    if (!mapId) {
      form.elements.mapId.classList.add('invalid');
      form.elements.mapId.focus();
      return showUploadError('Give the map ID the photos are of.');
    }
    if (!upload.files.length) return showUploadError('Add at least one photo.');
    const number = upload.files.length === 1 ? form.elements.sheetNumber.value.trim() : '';
    if (number && !/^\d+$/.test(number)) return showUploadError('The sheet number must be a whole number.');
    const model = chosenModel();
    if (model && !(await modelReady(model))) return;
    const data = new FormData();
    data.append('mapId', mapId);
    data.append('sheetNumber', number);
    upload.files.forEach((file) => data.append('mapPhoto', file, file.name));
    data.append('vlm', model ? model.id : '');
    const button = $('submitNewRun');
    button.disabled = true;
    button.textContent = 'Uploading…';
    try {
      const body = await api('api/runs', { method: 'POST', body: data });
      close();
      watchRuns(body.runs, 'Digitizing', body.failed || []);
    } catch (error) {
      showUploadError(sentence(error.message));
      renderUploadList();
    }
  });
}

// Uploaded photos are prepared (straightened, colour-corrected) and digitized one after another, and
// Digitize again redoes one. The status line counts them down; the first sheet done opens, and so
// does the open sheet when it is done again. failed: uploads the server refused ({ file, error }).
function watchRuns(runs, verb, failed = []) {
  clearInterval(state.polling);
  const started = Date.now();
  const pending = new Map(runs.map((run) => [run.runId, run.label]));
  const refused = failed.map((item) => `${item.file}: ${item.error}`);
  const errors = [];   // sheets that failed while being prepared or digitized
  const what = runs.length > 1 ? `${runs.length} sheets` : runs[0].label;
  let opened = false;
  setStatus(`${verb} ${what}…${refused.length ? ` Not uploaded: ${refused.join('; ')}` : ''}`, true);
  loadRuns();
  state.polling = setInterval(async () => {
    for (const [runId, label] of [...pending]) {
      const job = await api(`api/runs/${runId}/status`).catch(() => ({ status: 'unknown' }));
      if (job.status !== 'done' && job.status !== 'error') continue;
      pending.delete(runId);
      if (job.status === 'error') errors.push(`${label}: ${job.error}`);
      if (state.runId === runId) state.busy = false;
      if (job.status === 'done' && (!opened || state.runId === runId)) {
        opened = true;
        await loadRuns(runId);
      }
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    if (pending.size) {
      await loadRuns();   // the list shows each sheet waiting, being prepared or being digitized
      const done = runs.length - pending.size;
      setStatus(`${verb} ${runs.length > 1 ? `${what}: ${done} done` : what}… ${seconds} s`, true);
      return;
    }
    clearInterval(state.polling);
    await loadRuns();
    const ok = runs.length - errors.length;
    const problems = refused.concat(errors);
    setStatus([
      ok ? `${runs.length > 1 ? `${ok} sheets` : what} digitized in ${seconds} s.` : '',
      problems.length ? `Failed: ${problems.join('; ')}` : ''
    ].filter(Boolean).join(' '), problems.length > 0);
  }, 2000);
}

// ---------------------------------------------------------------- wiring
function fit() {
  if (state.result) fitView();
}

function installUi() {
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
  $('toolbox').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || state.busy) return;
    const { action, kind, name, shape, colour, pen } = button.dataset;
    if (action === 'undo') return undo();
    if (action === 'redo') return redo();
    if (action === 'edit') return toggleEditing();
    if (action === 'digitize') return digitize();
    if (action === 'toggle-type') return toggleType(shape, colour);
    if (action === 'toggle-pen') return togglePen(pen);
    if (action === 'add') return openAdd(kind);
    if (action === 'add-shape') { state.adding.shape = shape; return renderToolbox(); }
    if (action === 'add-pick') return pickForAdd();
    if (action === 'add-cancel') { state.adding = null; return renderToolbox(); }
    if (action === 'look') {
      const named = kind === 'pen' ? penOf(name) : colourOf(name);
      setTool('look', { look: { kind, name, id: name } });
      return setStatus(kind === 'pen' ? `Click on a line drawn with the ${named.label.toLowerCase()} pen.`
        : `Click a ${named.label.toLowerCase()} mark on the photo.`, true);
    }
    setTool(button.dataset.tool, { pen, shape, colour });
  });
  $('fitButton').addEventListener('click', fit);
  $('overlayOpacity').addEventListener('input', () => state.result && renderMapOverlays());
  $('mapOpacity').addEventListener('input', () => $('mapImage').setAttribute('opacity', Number($('mapOpacity').value) / 100));
  $('showMarks').addEventListener('change', () => state.result && (renderMapOverlays(), renderLists()));
  $('runSelect').addEventListener('change', (event) => loadRun(event.target.value));
  for (const list of ['stickerList', 'routeList', 'textList']) {
    $(list).addEventListener('click', (event) => {
      const item = event.target.closest('li');
      if (item?.dataset.kind) select({ kind: item.dataset.kind, id: Number(item.dataset.id) }, true);
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.target.closest?.('input, textarea, select, dialog')) return;
    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;
    if (command && key === 'z') { event.preventDefault(); return event.shiftKey ? redo() : undo(); }
    if (command && key === 'y') { event.preventDefault(); return redo(); }
    if (command || event.altKey) return;
    if (key === ' ') {
      event.preventDefault();
      if (!state.spaceDown) { state.spaceDown = true; $('viewer').classList.add('space'); renderGhost(null); }
      return;
    }
    if (key === 'escape') {
      if (state.gesture) cancelGesture();
      else if (state.tool !== 'move') { setTool('move'); setStatus(''); }
      else select(null);
    } else if (key === 'delete' || key === 'backspace') {
      event.preventDefault();
      eraseSelected();
    } else if (key === 's' || key === 'v') setTool('move');
    else if (key === 'e') setTool('eraser');
    else if (key === 't') setTool('text');
    else if (key === 'f') fit();
    else if (state.result) {
      const pen = listOf().pens.find((id) => PEN_KEYS[id] === key);
      if (pen) setTool('pen', { pen });
    }
  });
  document.addEventListener('keyup', (event) => {
    if (event.key !== ' ') return;
    state.spaceDown = false;
    $('viewer').classList.remove('space');
  });
}

function showTab(name) {
  state.tab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
}

(async function start() {
  installUi();
  installViewer();
  installNewRun();
  installVlm();
  try {
    await loadLegend();
    await Promise.all([loadRuns(), loadVlm()]);
  } catch (error) {
    setStatus(`Could not reach the server: ${error.message}`, true);
  }
})();
