/* Digitizer page: inspect a digitised sheet, correct it, teach the palette.
   Every URL is relative: the page lives at /digitizer/ in the workshop app and
   at / when run on its own (python -m digitizer serve). */
'use strict';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const SHAPES = ['circle', 'triangle', 'star'];
const SHAPE_LABELS = { circle: 'Circle', triangle: 'Triangle', star: 'Star' };
const FLAG_TEXT = {
  'shape-uncertain': 'shape unsure',
  'mostly-hidden': 'mostly hidden',
  'colour-uncertain': 'colour unsure',
  'colour-unknown': 'unknown colour',
  'no-legend-class': 'not in legend',
  'vlm-shape-disagrees': 'VLM: other shape',
  'vlm-colour-disagrees': 'VLM: other colour',
  'on-print': 'on printed map',
  'branch': 'branch',
  'faint': 'faint line',
  'colour-not-learned': 'colour not learned (looked like paper)',
};
// Flags that describe an item rather than doubt it: they never put it in "To check".
const INFO_FLAGS = new Set(['branch', 'colour-not-learned']);
const doubts = (flags) => (flags || []).filter((f) => !INFO_FLAGS.has(f));

const state = {
  legend: null, palette: null, session: 'default',
  runId: null, result: null,
  selected: null, mode: 'select', draft: null,
  view: { x: 0, y: 0, w: 1, h: 1 },
  tab: 'check', docs: [], info: { vlm: true, results: false },
  polling: null, statusTimer: null,
};

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

async function loadLegend(session) {
  const data = await api(`api/legend?session=${encodeURIComponent(session || 'default')}`);
  state.legend = data.legend;
  state.palette = data.palette;
  state.session = session || 'default';
}

function colourOf(id) {
  const found = (state.palette?.stickers || []).find((c) => c.id === id);
  return found || { id, label: id || '?', display: '#9a9a9a' };
}
function penOf(id) {
  const found = (state.palette?.pens || []).find((c) => c.id === id);
  return found || { id, label: id || 'unknown pen', display: '#7a7a7a' };
}
// The legend's name for a category ("Home"); results made before the labels
// were in English carry the French one, so it is looked up, not stored.
function categoryName(category, fallback) {
  const item = (state.legend?.stickers.classes || []).find((c) => c.category === category);
  return item ? item.label : (fallback || category);
}
function optionName(fieldId, optionId) {
  const field = (state.legend?.questionnaire?.fields || []).find((f) => f.id === fieldId);
  const option = (field?.options || []).find((o) => o.id === optionId);
  return option ? option.label : optionId;
}

// Shapes that come in one colour only (a star is gold) and colours only such a
// shape comes in (gold): read off the legend's classes, as the server does.
function fixedColours() {
  const colours = {};
  for (const c of state.legend.stickers.classes) (colours[c.shape] ||= new Set()).add(c.colour);
  return Object.fromEntries(Object.entries(colours)
    .filter(([, set]) => set.size === 1 && !set.has('*')).map(([shape, set]) => [shape, [...set][0]]));
}
function coloursFor(shape) {
  const fixed = fixedColours();
  if (fixed[shape]) return state.palette.stickers.filter((c) => c.id === fixed[shape]);
  const reserved = new Set(Object.entries(fixed)
    .filter(([s, colour]) => state.legend.stickers.classes.every((c) => c.colour !== colour || c.shape === s))
    .map(([, colour]) => colour));
  return state.palette.stickers.filter((c) => !reserved.has(c.id));
}
const mmToM = () => state.result.map.groundMetresPerPx * state.result.map.pxPerMm;

// ---------------------------------------------------------------- runs
async function loadRuns(selectId) {
  const runs = await api('api/runs');
  const select = $('runSelect');
  select.innerHTML = '';
  for (const run of runs) {
    const option = document.createElement('option');
    option.value = run.id;
    if (run.status === 'queued' || run.status === 'running') {
      option.textContent = `${run.label} — digitising…`;
      option.disabled = true;
    } else if (run.status === 'error') {
      option.textContent = `${run.label} — failed`;
      option.disabled = true;
    } else {
      option.textContent = run.label;
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
  state.runId = id;
  state.result = await api(`api/runs/${encodeURIComponent(id)}?t=${Date.now()}`);
  if (state.result.session && state.result.session !== state.session) await loadLegend(state.result.session);
  state.selected = null;
  state.draft = null;
  $('empty').style.display = 'none';
  const image = $('mapImage');
  image.setAttribute('href', `runs/${encodeURIComponent(id)}/map.jpg`);
  image.setAttribute('width', state.result.map.width);
  image.setAttribute('height', state.result.map.height);
  fitView();
  renderAll();
  if (state.tab === 'answers') showDocs();
}

function applyResult(result) {
  state.result = result;
  renderAll();
}

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

// Wheel zoom and drag pan on an <svg> whose viewBox is `view`; used by the map
// and by each photographed page in the Answers view.
function attachPanZoom(svg, getView, setView, maxWidth, onClick) {
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
  let drag = null;
  svg.addEventListener('pointerdown', (event) => {
    if (!getView() || event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, view: { ...getView() }, moved: false, target: event.target };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    const rect = svg.getBoundingClientRect();
    const scale = Math.max(drag.view.w / rect.width, drag.view.h / rect.height);
    setView({ ...drag.view, x: drag.view.x - dx * scale, y: drag.view.y - dy * scale });
  });
  svg.addEventListener('pointerup', (event) => {
    if (!drag) return;
    const click = !drag.moved;
    const target = drag.target;
    drag = null;
    if (click && onClick) onClick(event, target);
  });
}

function installViewer() {
  const svg = $('map');
  attachPanZoom(svg, () => (state.result ? state.view : null),
    (view) => { state.view = view; applyView(); }, () => state.result.map.width, handleClick);
  svg.addEventListener('dblclick', (event) => {
    if (state.mode === 'route' && state.draft?.type === 'route') {
      event.preventDefault();
      finishDraftRoute();
    }
  });
}

function handleClick(event, target) {
  const p = toMap(event);
  if (state.mode === 'sticker') {
    state.draft = { type: 'sticker', x: p.x, y: p.y, shape: 'circle', colour: null };
    state.selected = { kind: 'draft-sticker' };
    renderMapOverlays();
    renderInspector();
    return;
  }
  if (state.mode === 'route') {
    if (!state.draft || state.draft.type !== 'route') state.draft = { type: 'route', points: [], pen: null, done: false };
    if (!state.draft.done) state.draft.points.push([p.x, p.y]);
    state.selected = { kind: 'draft-route' };
    renderMapOverlays();
    renderInspector();
    return;
  }
  const kind = target?.dataset?.kind;
  const id = Number(target?.dataset?.id);
  select(kind ? { kind, id } : null, false);
}

// ---------------------------------------------------------------- the pages (Answers)
// The questionnaire side as cut from the map photo: what the answers on the
// right were read from.
function docList() {
  return [{ title: 'Questionnaire (checkbox side)', url: `runs/${encodeURIComponent(state.runId)}/panel.jpg` }];
}

function showDocs() {
  const box = $('docs');
  box.innerHTML = '';
  state.docs = [];
  if (!state.result) return;
  for (const doc of docList()) {
    const pane = document.createElement('div');
    pane.className = 'doc';
    const title = document.createElement('div');
    title.className = 'doc-title';
    title.textContent = doc.title;
    pane.appendChild(title);
    box.appendChild(pane);
    const entry = { view: null, size: null, svg: null };
    state.docs.push(entry);
    const probe = new Image();
    probe.onload = () => {
      entry.size = { w: probe.naturalWidth, h: probe.naturalHeight };
      // wider pages get more of the room; at least 1, so one page fills it all
      pane.style.flexGrow = String(Math.max(1, 2 * entry.size.w / entry.size.h));
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.appendChild(svgEl('image', { href: doc.url, x: 0, y: 0, width: entry.size.w, height: entry.size.h }));
      pane.appendChild(svg);
      entry.svg = svg;
      attachPanZoom(svg, () => entry.view, (view) => { entry.view = view; applyDocView(entry); }, () => entry.size.w);
      fitDoc(entry);
    };
    probe.onerror = () => {
      const missing = document.createElement('div');
      missing.className = 'missing';
      missing.textContent = 'No image for this sheet.';
      pane.appendChild(missing);
    };
    probe.src = doc.url;
  }
}
function applyDocView(entry) {
  const v = entry.view;
  entry.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
}
function fitDoc(entry) {
  if (!entry.size) return;
  entry.view = { x: 0, y: 0, w: entry.size.w, h: entry.size.h };
  applyDocView(entry);
}

// ---------------------------------------------------------------- rendering
function renderAll() {
  renderMapOverlays();
  renderLists();
  renderAnswers();
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
  const showMarks = $('showMarks').checked;
  const routes = $('routesLayer');
  const stickers = $('stickersLayer');
  const draft = $('draftLayer');
  routes.innerHTML = '';
  stickers.innerHTML = '';
  draft.innerHTML = '';
  if (!r) return;
  routes.setAttribute('opacity', opacity);
  stickers.setAttribute('opacity', Math.min(1, opacity + 0.1));
  for (const route of r.routes) {
    if (route.deleted || (route.kind === 'mark' && !showMarks)) continue;
    const points = route.points.map((p) => p.join(',')).join(' ');
    routes.appendChild(svgEl('polyline', { class: 'route-halo', points }));
    const line = svgEl('polyline', {
      class: `route ${route.kind}${doubts(route.flags).length && !route.reviewed ? ' flagged' : ''}${isSelected('route', route.id) ? ' selected' : ''}`,
      points, stroke: penOf(route.pen).display, 'data-kind': 'route', 'data-id': route.id,
    });
    routes.appendChild(line);
  }
  for (const s of r.stickers) {
    if (s.deleted) continue;
    const colour = colourOf(s.colour);
    const flagged = s.flags.length && !s.reviewed;
    stickers.appendChild(svgEl('polygon', {
      class: `sticker${flagged ? ' flagged' : ''}${isSelected('sticker', s.id) ? ' selected' : ''}`,
      points: s.polygon.map((p) => p.join(',')).join(' '),
      fill: colour.display, 'fill-opacity': 0.28, stroke: colour.display,
      'data-kind': 'sticker', 'data-id': s.id,
    }));
    const label = svgEl('text', { class: 'sticker-label', x: s.x, y: s.y + 8, 'text-anchor': 'middle' });
    label.textContent = s.id;
    stickers.appendChild(label);
  }
  if (state.draft?.type === 'sticker') {
    const size = state.legend.stickers.sizesMm.circle * r.map.pxPerMm;
    draft.appendChild(svgEl('circle', { class: 'draft', cx: state.draft.x, cy: state.draft.y, r: size / 2 }));
  } else if (state.draft?.type === 'route' && state.draft.points.length) {
    draft.appendChild(svgEl('polyline', { class: 'draft', points: state.draft.points.map((p) => p.join(',')).join(' ') }));
    for (const [x, y] of state.draft.points) draft.appendChild(svgEl('circle', { class: 'draft-dot', cx: x, cy: y, r: 5 }));
  }
}

const isSelected = (kind, id) => state.selected?.kind === kind && state.selected?.id === id;

function flagChips(flags) {
  return (flags || []).map((f) => `<span class="chip">${FLAG_TEXT[f] || f}</span>`).join('');
}

function stickerSwatch(s) {
  return `<span class="swatch ${s.shape}" style="background:${colourOf(s.colour).display}"></span>`;
}

function renderLists() {
  const r = state.result;
  const checks = [];
  for (const s of r.stickers) {
    if (s.deleted || s.reviewed || !s.flags.length) continue;
    checks.push(`<li data-kind="sticker" data-id="${s.id}">${stickerSwatch(s)}<span>Sticker #${s.id} · ${SHAPE_LABELS[s.shape]}, ${colourOf(s.colour).label}<br>${flagChips(s.flags)}</span></li>`);
  }
  for (const route of r.routes) {
    if (route.deleted || route.reviewed || route.kind !== 'route') continue;
    if (!doubts(route.flags).length && route.pen) continue;
    checks.push(`<li data-kind="route" data-id="${route.id}"><span class="swatch line" style="background:${penOf(route.pen).display}"></span><span>Route #${route.id} · ${penOf(route.pen).label}<br>${flagChips(route.pen ? doubts(route.flags) : ['colour-unknown'])}</span></li>`);
  }
  const q = r.questionnaire;
  if (q && !q.reviewed) {
    const unclear = [];
    for (const [fid, value] of Object.entries(q.fields || {})) {
      if (value && typeof value === 'object') {
        for (const [option, v] of Object.entries(value)) if (v === 'unclear') unclear.push(optionName(fid, option));
      }
    }
    const disagreements = (q.disagreements || []).map((d) => optionName(d.field, d.option));
    const notes = [];
    if (unclear.length) notes.push(`unclear: ${unclear.join(', ')}`);
    if (disagreements.length) notes.push(`two readings differ: ${disagreements.join(', ')}`);
    checks.push(`<li data-tab-link="answers"><span class="swatch" style="background:#bbb"></span><span>Questionnaire${notes.length ? '<br><span class="muted">' + notes.join(' · ') + '</span>' : '<br><span class="muted">read by the VLM — give it a glance</span>'}</span></li>`);
  }
  $('checkList').innerHTML = checks.join('') || '<li class="done">Nothing left to check.</li>';
  $('checkCount').textContent = checks.length || '';

  $('stickerList').innerHTML = r.stickers.filter((s) => !s.deleted).map((s) => `
    <li data-kind="sticker" data-id="${s.id}" class="${isSelected('sticker', s.id) ? 'selected' : ''}">
      ${stickerSwatch(s)}<span>#${s.id} ${categoryLabel(s)}</span>
      <span class="meta">${s.source === 'human' ? '<span class="chip ok">checked</span>' : s.colour ? Math.round(100 * s.colour_confidence) + '%' : '?'}</span>
    </li>`).join('') || '<li class="done">No stickers.</li>';

  const factor = mmToM();
  $('routeList').innerHTML = r.routes.filter((x) => !x.deleted && (x.kind === 'route' || $('showMarks').checked)).map((route) => `
    <li data-kind="route" data-id="${route.id}" class="${isSelected('route', route.id) ? 'selected' : ''}">
      <span class="swatch line" style="background:${penOf(route.pen).display}"></span>
      <span>#${route.id} ${penOf(route.pen).label}${route.kind === 'mark' ? ' (short stroke)' : ''}</span>
      <span class="meta">${Math.round(route.length_px / r.map.pxPerMm * factor)} m</span>
    </li>`).join('') || '<li class="done">No routes.</li>';
}

function categoryLabel(s) {
  if (s.category) return categoryName(s.category, s.label);
  return s.colour ? `${SHAPE_LABELS[s.shape]} ${colourOf(s.colour).label}` : `${SHAPE_LABELS[s.shape]}, colour unknown`;
}

// ---------------------------------------------------------------- selection + inspector
function select(item, zoom) {
  state.selected = item;
  if (item && state.draft) state.draft = null;
  if (item && zoom) {
    const r = state.result;
    if (item.kind === 'sticker') {
      const s = r.stickers.find((x) => x.id === item.id);
      if (s) zoomTo(s.x, s.y, s.diameter_px * 6);
    } else if (item.kind === 'route') {
      const route = r.routes.find((x) => x.id === item.id);
      if (route) {
        const xs = route.points.map((p) => p[0]), ys = route.points.map((p) => p[1]);
        const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        zoomTo((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, span * 1.3 + 200);
      }
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
  if (!sel || !state.result) { box.innerHTML = ''; return; }
  if (sel.kind === 'sticker') return renderStickerInspector(box, state.result.stickers.find((s) => s.id === sel.id));
  if (sel.kind === 'route') return renderRouteInspector(box, state.result.routes.find((r) => r.id === sel.id));
  if (sel.kind === 'draft-sticker') return renderDraftSticker(box);
  if (sel.kind === 'draft-route') return renderDraftRoute(box);
}

function colourButtons(current, list, pens = false) {
  return list.map((c) => `<button type="button" class="choice${c.id === current ? ' on' : ''}" data-value="${c.id}">
      <span class="swatch${pens ? ' line' : ''}" style="background:${c.display}"></span>${c.label}</button>`).join('');
}

function vlmOpinion(v) {
  const shape = SHAPE_LABELS[v.shape] || v.shape;
  const colour = v.colour && v.colour !== 'unclear' ? colourOf(v.colour).label : v.colour;
  return `<p class="note">VLM second opinion: ${shape}, ${colour}</p>`;
}

function renderStickerInspector(box, s) {
  if (!s) { box.innerHTML = ''; return; }
  const alternatives = (s.colour_alternatives || []).map((a) => `${colourOf(a.colour).label} ${Math.round(a.p * 100)}% (Δ${a.distance})`).join(' · ');
  const fixed = fixedColours()[s.shape];
  const colourNote = fixed
    ? `A ${SHAPE_LABELS[s.shape].toLowerCase()} is always ${colourOf(fixed).label.toLowerCase()}: its colour is not measured.`
    : s.colour
      ? `Measured colour confidence ${Math.round(100 * s.colour_confidence)}%${alternatives ? ' — ' + alternatives : ''}.
         Picking a colour teaches this session's palette and re-checks the other stickers on this sheet.`
      : `No palette colour is close${s.colour_alternatives?.length ? ` (nearest: ${colourOf(s.colour_alternatives[0].colour).label}, Δ${s.colour_alternatives[0].distance})` : ''} — a new stock or lighting.
         Picking a colour teaches this session's palette and re-checks the other stickers on this sheet.`;
  box.innerHTML = `
    <h3>Sticker #${s.id} — ${categoryLabel(s)}</h3>
    ${previewSvg(s.x, s.y, s.diameter_px * 3)}
    <div>${flagChips(s.reviewed ? [] : s.flags)}${s.source === 'human' ? '<span class="chip ok">checked by you</span>' : ''}</div>
    <div class="row"><span class="label">Shape</span>${SHAPES.map((shape) => `<button type="button" class="choice${shape === s.shape ? ' on' : ''}" data-shape="${shape}">${SHAPE_LABELS[shape]}</button>`).join('')}</div>
    <div class="row"><span class="label">Colour</span><span id="colourChoices">${colourButtons(s.colour, coloursFor(s.shape))}</span></div>
    <p class="note">${colourNote}</p>
    ${s.vlm ? vlmOpinion(s.vlm) : ''}
    <div class="actions">
      <button type="button" class="primary" id="confirmSticker">Looks right</button>
      <button type="button" class="danger" id="deleteSticker">Not a sticker</button>
    </div>`;
  box.querySelectorAll('[data-shape]').forEach((b) => b.addEventListener('click', () => editSticker(s.id, { shape: b.dataset.shape })));
  box.querySelectorAll('#colourChoices [data-value]').forEach((b) => b.addEventListener('click', () => editSticker(s.id, { colour: b.dataset.value })));
  $('confirmSticker').addEventListener('click', () => editSticker(s.id, { confirm: true }, true));
  $('deleteSticker').addEventListener('click', () => editSticker(s.id, { deleted: true }, true));
}

function renderRouteInspector(box, route) {
  if (!route) { box.innerHTML = ''; return; }
  const metres = Math.round(route.length_px / state.result.map.pxPerMm * mmToM());
  const pen = penOf(route.pen);
  const mode = (state.legend.pens.find((p) => p.id === route.pen) || {}).modeLabel;
  box.innerHTML = `
    <h3>Route #${route.id} — ${pen.label}${mode ? ' (' + mode + ')' : ''}</h3>
    <p class="muted">${metres} m on the ground${route.bridged_gaps ? ` · ${route.bridged_gaps} gap(s) bridged` : ''}</p>
    <div>${flagChips(route.reviewed ? [] : route.flags)}</div>
    <div class="row"><span class="label">Pen</span><span id="penChoices">${colourButtons(route.pen, state.palette.pens, true)}</span></div>
    <p class="note">Picking a pen teaches this session which ink colours mean which pen.${route.kind === 'mark'
      ? ' This is a short stroke (under 25 mm on paper), not counted as a route.' : ''}</p>
    <div class="actions">
      <button type="button" class="primary" id="confirmRoute">Looks right</button>
      <button type="button" id="toggleKind">${route.kind === 'route' ? 'Not a route (short stroke)' : 'It is a route'}</button>
      <button type="button" class="danger" id="deleteRoute">Delete</button>
    </div>`;
  box.querySelectorAll('#penChoices [data-value]').forEach((b) => b.addEventListener('click', () => editRoute(route.id, { pen: b.dataset.value })));
  $('confirmRoute').addEventListener('click', () => editRoute(route.id, {}, true));
  $('toggleKind').addEventListener('click', () => editRoute(route.id, { kind: route.kind === 'route' ? 'mark' : 'route' }));
  $('deleteRoute').addEventListener('click', () => editRoute(route.id, { deleted: true }, true));
}

function renderDraftSticker(box) {
  const d = state.draft;
  const choices = coloursFor(d.shape);
  if (choices.length === 1) d.colour = choices[0].id;            // a star: gold, nothing to pick
  else if (!choices.some((c) => c.id === d.colour)) d.colour = null;
  box.innerHTML = `
    <h3>Add a missed sticker</h3>
    ${previewSvg(d.x, d.y, state.legend.stickers.sizesMm.circle * state.result.map.pxPerMm * 3)}
    <div class="row"><span class="label">Shape</span>${SHAPES.map((shape) => `<button type="button" class="choice${shape === d.shape ? ' on' : ''}" data-shape="${shape}">${SHAPE_LABELS[shape]}</button>`).join('')}</div>
    <div class="row"><span class="label">Colour</span><span id="colourChoices">${colourButtons(d.colour, choices)}</span></div>
    <p class="note">Its colour is measured where you clicked and added to the session palette.</p>
    <div class="actions"><button type="button" class="primary" id="addSticker" ${d.colour ? '' : 'disabled'}>Add sticker</button>
      <button type="button" id="cancelDraft">Cancel</button></div>`;
  box.querySelectorAll('[data-shape]').forEach((b) => b.addEventListener('click', () => { d.shape = b.dataset.shape; renderDraftSticker(box); }));
  box.querySelectorAll('#colourChoices [data-value]').forEach((b) => b.addEventListener('click', () => { d.colour = b.dataset.value; renderDraftSticker(box); }));
  $('addSticker').addEventListener('click', async () => {
    const body = await post(`api/runs/${state.runId}/stickers`, { x: d.x, y: d.y, shape: d.shape, colour: d.colour });
    state.draft = null;
    const added = body.result.stickers[body.result.stickers.length - 1];
    state.selected = { kind: 'sticker', id: added.id };
    applyResult(body.result);
    await refreshPalette();
  });
  $('cancelDraft').addEventListener('click', cancelDraft);
}

function renderDraftRoute(box) {
  const d = state.draft;
  box.innerHTML = `
    <h3>Draw a missed route</h3>
    <p class="muted">${d.points.length} point(s). Click along the line; double-click or press Enter to finish.</p>
    <div class="row"><span class="label">Pen</span><span id="penChoices">${colourButtons(d.pen, state.palette.pens, true)}</span></div>
    <div class="actions"><button type="button" class="primary" id="addRoute" ${d.pen && d.points.length > 1 ? '' : 'disabled'}>Add route</button>
      <button type="button" id="undoPoint" ${d.points.length ? '' : 'disabled'}>Undo point</button>
      <button type="button" id="cancelDraft">Cancel</button></div>`;
  box.querySelectorAll('#penChoices [data-value]').forEach((b) => b.addEventListener('click', () => { d.pen = b.dataset.value; renderDraftRoute(box); }));
  $('undoPoint').addEventListener('click', () => { d.points.pop(); d.done = false; renderMapOverlays(); renderDraftRoute(box); });
  $('addRoute').addEventListener('click', async () => {
    const body = await post(`api/runs/${state.runId}/routes`, { points: d.points, pen: d.pen });
    state.draft = null;
    const added = body.result.routes[body.result.routes.length - 1];
    state.selected = { kind: 'route', id: added.id };
    applyResult(body.result);
  });
  $('cancelDraft').addEventListener('click', cancelDraft);
}

function finishDraftRoute() {
  if (state.draft?.type !== 'route') return;
  state.draft.done = true;
  renderInspector();
}

function cancelDraft() {
  state.draft = null;
  state.selected = null;
  renderMapOverlays();
  renderInspector();
}

async function editSticker(id, changes, advance) {
  try {
    const body = await post(`api/runs/${state.runId}/stickers/${id}`, changes);
    applyResult(body.result);
    if (changes.colour) await refreshPalette();
    if (advance) nextToCheck(id);
  } catch (error) { alert(error.message); }
}

async function editRoute(id, changes, advance) {
  try {
    const body = await post(`api/runs/${state.runId}/routes/${id}`, changes);
    applyResult(body.result);
    if (changes.pen) await refreshPalette();
    if (advance) nextToCheck(id);
  } catch (error) { alert(error.message); }
}

async function refreshPalette() {
  await loadLegend(state.session);
  renderAll();
}

function nextToCheck() {
  const first = document.querySelector('#checkList li[data-kind]');
  if (first) select({ kind: first.dataset.kind, id: Number(first.dataset.id) }, true);
  else select(null);
}

// ---------------------------------------------------------------- answers
function renderAnswers() {
  const r = state.result;
  const panel = $('answersPanel');
  const form = state.legend.questionnaire || { fields: [] };
  const q = r.questionnaire;
  const fields = q?.fields || {};
  const disagreements = new Set((q?.disagreements || []).map((d) => `${d.field}.${d.option}`));
  let html = '<div class="answers">';
  if (q) {
    html += '<h4>Questionnaire</h4>';
    for (const field of form.fields) {
      if (field.kind === 'checkboxes') {
        html += `<div class="field"><b>${field.label}</b><div class="boxes">`;
        for (const option of field.options) {
          const value = (fields[field.id] || {})[option.id] || 'unclear';
          const flag = disagreements.has(`${field.id}.${option.id}`) ? ' <span class="disagree" title="the readings differ (the VLM overview and close-up, and the ink measured in the box)">⚠</span>' : '';
          html += `<span>${option.label}${flag}</span><span class="seg" data-field="${field.id}" data-option="${option.id}">
            ${['checked', 'empty', 'unclear'].map((v) => `<button type="button" class="${v === value ? 'on' : ''}" data-value="${v}">${v === 'checked' ? '✓' : v === 'empty' ? '—' : '?'}</button>`).join('')}</span>`;
        }
        html += '</div></div>';
      } else {
        const alternatives = (q.alternatives || {})[field.id] || [];
        html += `<label class="field">${field.label}
          <input type="text" data-text-field="${field.id}" value="${escapeHtml(fields[field.id] || '')}"></label>`;
        if (alternatives.length) html += `<p class="note">Other reading: ${alternatives.map((a) => `<button type="button" class="choice" data-alt-field="${field.id}" data-alt="${escapeHtml(a)}">${escapeHtml(a)}</button>`).join(' ')}</p>`;
      }
    }
  } else {
    html += '<p class="muted">The questionnaire was not read.</p>';
  }
  html += '<div class="actions"><button type="button" class="primary" id="saveAnswers">Save answers</button></div></div>';
  panel.innerHTML = html;
  panel.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  panel.querySelectorAll('[data-alt-field]').forEach((b) => b.addEventListener('click', () => {
    panel.querySelector(`[data-text-field="${b.dataset.altField}"]`).value = b.dataset.alt;
  }));
  $('saveAnswers').addEventListener('click', saveAnswers);
}

async function saveAnswers() {
  const panel = $('answersPanel');
  const payload = {};
  if (state.result.questionnaire) {
    const fields = {};
    panel.querySelectorAll('[data-text-field]').forEach((input) => { fields[input.dataset.textField] = input.value.trim(); });
    panel.querySelectorAll('.seg').forEach((seg) => {
      const on = seg.querySelector('button.on');
      (fields[seg.dataset.field] ||= {})[seg.dataset.option] = on ? on.dataset.value : 'unclear';
    });
    payload.questionnaire = fields;
  }
  try {
    const body = await post(`api/runs/${state.runId}/answers`, payload);
    applyResult(body.result);
    setStatus('Answers saved.');
  } catch (error) { alert(error.message); }
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
    ${state.info.results ? `<div class="actions">
      <button type="button" id="moveSheet">Move to Results</button>
      <button type="button" id="moveAll">Move all to Results</button>
    </div>` : ''}`;
  if (!state.info.results) return;
  $('moveSheet').addEventListener('click', () => moveToResults(`api/runs/${run}/to-results`));
  $('moveAll').addEventListener('click', () => moveToResults('api/to-results'));
}

// A sheet goes to the Results page as a session of its own (moving it again
// updates it there); it stays here to be corrected.
async function moveToResults(path) {
  try {
    const body = await post(path, {});
    setStatus(body.moved.length === 1 ? `Sheet ${body.moved[0]} moved to Results.`
      : `${body.moved.length} sheets moved to Results.`);
  } catch (error) { alert(error.message); }
}

// ---------------------------------------------------------------- new run
function installNewRun() {
  const dialog = $('newRunDialog');
  $('newRunButton').addEventListener('click', () => dialog.showModal());
  $('cancelNewRun').addEventListener('click', () => dialog.close());
  $('newRunForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    data.set('vlm', form.vlm.checked ? '1' : '0');
    $('submitNewRun').disabled = true;
    try {
      const body = await api('api/runs', { method: 'POST', body: data });
      dialog.close();
      form.reset();
      watchRun(body.runId, body.label);
    } catch (error) {
      alert(error.message);
    } finally {
      $('submitNewRun').disabled = false;
    }
  });
}

function watchRun(runId, label = runId) {
  clearInterval(state.polling);
  const started = Date.now();
  setStatus(`Digitising ${label}…`, true);
  loadRuns();
  state.polling = setInterval(async () => {
    const job = await api(`api/runs/${runId}/status`).catch(() => ({ status: 'unknown' }));
    const seconds = Math.round((Date.now() - started) / 1000);
    if (job.status === 'done') {
      clearInterval(state.polling);
      setStatus(`${label} done in ${seconds} s.`);
      await loadRuns(runId);
    } else if (job.status === 'error') {
      clearInterval(state.polling);
      setStatus(`${label} failed: ${job.error}`, true);
      await loadRuns();
    } else {
      setStatus(`Digitising ${label}… ${job.status}, ${seconds} s`, true);
    }
  }, 2000);
}

// ---------------------------------------------------------------- wiring
function setMode(mode) {
  if (state.tab === 'answers') return;
  state.mode = mode;
  document.querySelectorAll('.tools .mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('viewer').className = `viewer mode-${mode}`;
  if (mode === 'select' && state.draft) cancelDraft();
}

function fit() {
  if (state.tab === 'answers') state.docs.forEach(fitDoc);
  else if (state.result) fitView();
}

function installUi() {
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
  document.querySelectorAll('.tools .mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('fitButton').addEventListener('click', fit);
  $('overlayOpacity').addEventListener('input', () => state.result && renderMapOverlays());
  $('showMarks').addEventListener('change', () => state.result && (renderMapOverlays(), renderLists()));
  $('runSelect').addEventListener('change', (event) => loadRun(event.target.value));
  for (const list of ['checkList', 'stickerList', 'routeList']) {
    $(list).addEventListener('click', (event) => {
      const item = event.target.closest('li');
      if (!item) return;
      if (item.dataset.tabLink) return showTab(item.dataset.tabLink);
      if (item.dataset.kind) select({ kind: item.dataset.kind, id: Number(item.dataset.id) }, true);
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input, textarea, select, dialog')) return;
    const key = event.key.toLowerCase();
    if (key === 'escape') { state.draft ? cancelDraft() : select(null); }
    else if (key === 'enter' && state.draft?.type === 'route') finishDraftRoute();
    else if ((key === 'delete' || key === 'backspace') && state.selected?.kind === 'sticker') editSticker(state.selected.id, { deleted: true }, true);
    else if ((key === 'delete' || key === 'backspace') && state.selected?.kind === 'route') editRoute(state.selected.id, { deleted: true }, true);
    else if (key === 's') setMode('select');
    else if (key === 'a') setMode('sticker');
    else if (key === 'r') setMode('route');
    else if (key === 'f') fit();
  });
}

// The Answers tab swaps the map for the photographed pages it was read from.
function showTab(name) {
  const wasAnswers = state.tab === 'answers';
  state.tab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  const answers = name === 'answers';
  $('viewer').hidden = answers;
  $('docs').hidden = !answers;
  document.querySelector('.tools').classList.toggle('off', answers);
  if (answers && !wasAnswers) {
    if (state.draft) cancelDraft();
    showDocs();
  }
}

// Inside the workshop app the page links back to its main menu.
function installHomeLink() {
  const home = document.body.dataset.home;
  if (!home) return;
  $('homeLink').href = home;
  $('homeLink').hidden = false;
}

async function loadInfo() {
  state.info = await api('api/info').catch(() => ({ vlm: true, results: false }));
  if (state.info.vlm) return;
  const box = $('newRunForm').vlm;
  box.checked = false;
  box.disabled = true;
  $('vlmHint').textContent = 'The VLM is not installed here (see digitizer/README.md): stickers and routes are '
    + 'digitised, the questionnaire is not read.';
}

(async function start() {
  installHomeLink();
  installUi();
  installViewer();
  installNewRun();
  await loadInfo();
  try {
    await loadLegend('default');
    await loadRuns();
  } catch (error) {
    setStatus(`Could not reach the server: ${error.message}`, true);
  }
})();
