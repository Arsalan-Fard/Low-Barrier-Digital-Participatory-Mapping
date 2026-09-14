import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import cloneDeep from 'lodash.clonedeep'
import MapLibreGl, {
  GeoJSONSource,
  LngLatBounds,
  Map,
  StyleSpecification,
} from 'maplibre-gl'
import {
  MdAdd,
  MdClose,
  MdDescription,
  MdDirectionsWalk,
  MdPictureAsPdf,
  MdStayCurrentLandscape,
} from 'react-icons/md'
import {
  declutterPoiIcons,
  installPoiDeclutter,
} from '../libs/poi-declutter'
import {
  applyRoadLabelMode,
  installRoadLabelMode,
  ROAD_LABEL_MODES,
  RoadLabelMode,
} from '../libs/road-label-mode'
import {
  dedupeBusStops,
  installTransitRuntime,
} from '../libs/transit-runtime'
import {
  captureMapCanvasWithPinpoints,
  MapPinpoint,
} from '../libs/pinpoints'

type SheetLayout = {
  pageSize: "A4" | "A3"
  page: [number, number]
  mapFrame: [number, number, number, number]
  patchSize: number
  patches: [number, number][]
  tagIds: number[]
  badge: [number, number, number, number]
  // The side margin holding the ID plate; null while it is on the map.
  badgePanel?: PanelSide | null
};

type SheetLayouts = Record<"A4" | "A3", SheetLayout>;

type Viewport = {
  left: number
  top: number
  width: number
  height: number
};

type PreviewBox = {
  x: number
  y: number
  width: number
  height: number
  scale: number
};

// ------------------------------------------------------------- side margins
//
// A margin is a column of notes to the left or right of the map.
// The page keeps its outer margin; the map FRAME gives up the width, and the
// server derives the same frame from what we send (layout.mapFrame), so the
// tags in the preview are the tags on paper. The arithmetic below mirrors
// map_sheet_layout() and _clean_map_sheet_frame() in app.py.

type PanelSide = "left" | "right";
type SidePanel = {width: number; text: string};
type SidePanels = Record<PanelSide, SidePanel | null>;
type PanelUpdater = (panel: SidePanel) => SidePanel;
type PanelRegion = {x: number; y: number; width: number; height: number};

const PANEL_SIDES: PanelSide[] = ["left", "right"];
const PAGE_MARGIN_PT = 12;
const BADGE_W_PT = 70;
const BADGE_H_PT = 14;
const PANEL_MIN_PT = 36;
const PANEL_PAD_PT = 6;
const PANEL_FONT_PT: Record<"A4" | "A3", number> = {A4: 11, A3: 13};
// How close (screen px) the drag has to come to a square map before it snaps.
const SQUARE_SNAP_PX = 10;

function round3(value: number) {
  return Math.round(value * 1000) / 1000;
}

/** Widest the two margins may be together. The frame keeps the server's
 *  minimum width, so nothing we send is clamped into a different layout. */
function maxPanelTotal(base: SheetLayout) {
  const minFrame = Math.max(base.patchSize * 4.25, base.page[0] * 0.28);
  return base.page[0] - PAGE_MARGIN_PT * 2 - minFrame;
}

function clampPanelWidth(base: SheetLayout, width: number, otherWidth: number) {
  return Math.max(PANEL_MIN_PT, Math.min(width, maxPanelTotal(base) - otherWidth));
}

/** The margin width that makes the map frame square. The frame is always
 *  page height minus the two page margins tall, so it is square when the side
 *  margins together take page width minus page height. */
function squarePanelWidth(base: SheetLayout, otherWidth: number) {
  return base.page[0] - base.page[1] - otherWidth;
}

/** Clamp, and within a few screen pixels of a square map snap to it: a 1:1
 *  frame is a common wish and impossible to hit by hand. */
function snapPanelWidth(base: SheetLayout, raw: number, otherWidth: number, scale: number) {
  const width = clampPanelWidth(base, raw, otherWidth);
  const square = squarePanelWidth(base, otherWidth);
  const reachable = square >= PANEL_MIN_PT && square <= maxPanelTotal(base) - otherWidth;
  return reachable && Math.abs(width - square) * scale <= SQUARE_SNAP_PX ? square : width;
}

function isSquareFrame(layout: SheetLayout) {
  return Math.abs(layout.mapFrame[2] - layout.mapFrame[3]) < 0.01;
}

function panelWidths(base: SheetLayout, panels: SidePanels): Record<PanelSide, number> {
  let left = panels.left ? panels.left.width : 0;
  let right = panels.right ? panels.right.width : 0;
  const total = maxPanelTotal(base);
  if (left + right > total) {   // e.g. after switching A3 -> A4
    const k = total / (left + right);
    left *= k;
    right *= k;
  }
  return {left, right};
}

/** Where the ID plate goes: centred at the foot of a side margin wide enough
 *  to hold it, left before right, or else in the map's top-left corner beside
 *  the first tag. Worked from the rounded frame the server receives, so both
 *  sides reach the same answer. */
function placeBadge(
  base: SheetLayout, frame: [number, number, number, number], panels: SidePanels,
): Pick<SheetLayout, "badge" | "badgePanel"> {
  const [x, y, w, h] = frame;
  const spans: Record<PanelSide, [number, number]> = {
    left: [PAGE_MARGIN_PT, x - PAGE_MARGIN_PT],
    right: [x + w, base.page[0] - PAGE_MARGIN_PT - (x + w)],
  };
  for (const side of PANEL_SIDES) {
    const [left, width] = spans[side];
    if (panels[side] && width >= BADGE_W_PT + PANEL_PAD_PT * 2) {
      return {
        badge: [
          round3(left + (width - BADGE_W_PT) / 2),
          round3(y + h - PANEL_PAD_PT - BADGE_H_PT),
          BADGE_W_PT, BADGE_H_PT,
        ],
        badgePanel: side,
      };
    }
  }
  const p = base.patchSize;
  return {
    badge: [round3(x + p + 4), round3(y + (p - BADGE_H_PT) / 2), BADGE_W_PT, BADGE_H_PT],
    badgePanel: null,
  };
}

/** The sheet with the margins taken out of the frame: the eight tags and the
 *  ID plate follow the frame exactly as they do on the server. */
function layoutWithPanels(base: SheetLayout, panels: SidePanels): SheetLayout {
  const widths = panelWidths(base, panels);
  if (!widths.left && !widths.right) return base;
  const p = base.patchSize;
  const x = PAGE_MARGIN_PT + widths.left;
  const y = PAGE_MARGIN_PT;
  const w = base.page[0] - PAGE_MARGIN_PT * 2 - widths.left - widths.right;
  const h = base.page[1] - PAGE_MARGIN_PT * 2;
  const patches: [number, number][] = [
    [x, y], [x + (w - p) / 2, y], [x + w - p, y],
    [x, y + (h - p) / 2], [x + w - p, y + (h - p) / 2],
    [x, y + h - p], [x + (w - p) / 2, y + h - p], [x + w - p, y + h - p],
  ];
  const mapFrame: [number, number, number, number] =
    [round3(x), round3(y), round3(w), round3(h)];
  return {
    ...base,
    mapFrame,
    patches: patches.map(([px, py]) => [round3(px), round3(py)]),
    ...placeBadge(base, mapFrame, panels),
  };
}

function panelRegions(
  base: SheetLayout, layout: SheetLayout, panels: SidePanels,
): Record<PanelSide, PanelRegion> {
  const widths = panelWidths(base, panels);
  const frame = layout.mapFrame;
  return {
    left: {x: PAGE_MARGIN_PT, y: frame[1], width: widths.left, height: frame[3]},
    right: {x: frame[0] + frame[2], y: frame[1], width: widths.right, height: frame[3]},
  };
}

function serialisePanels(panels: SidePanels) {
  const out: Record<PanelSide, {text: string} | null> = {left: null, right: null};
  PANEL_SIDES.forEach(side => {
    const panel = panels[side];
    if (panel) out[side] = {text: panel.text};
  });
  return out;
}

type PaperMapToolsProps = {
  map: Map | null
  mapStyle: StyleSpecification
  pinpoints: MapPinpoint[]
  replaceAccessTokens(mapStyle: StyleSpecification): StyleSpecification
};

const REACH_SOURCE_ID = "paper-walk-reach";
const REACH_FILL_ID = "paper-walk-reach-fill";
const REACH_LINE_ID = "paper-walk-reach-line";

// ------------------------------------------------------------------ printing
//
// Fixing the SCALE rather than the zoom is what makes sheets comparable between
// workshops: a centimetre of pencil is then the same distance on every sheet.
// The frame's ground coverage follows from its physical size, so the map's zoom
// is derived from the scale rather than the other way round.
// "Fix zoom" holds the RENDER zoom constant while the frame's coverage is free.
// Web zoom normally welds the two together: widen the view and the style drops
// to a coarser level, shedding labels and detail. Pinning the zoom and sizing
// the canvas to ground/resolution instead keeps z15.5's detail and label
// selection whatever area the sheet ends up covering -- the cost is that
// everything prints physically smaller as the coverage grows.

// Render size comes from a target dpi against the frame's physical width. The
// old fixed 1000px height printed at only ~87 dpi on A3.
const DPI_OPTIONS = [150, 300, 600];
const LABEL_MM_OPTIONS = [0, 1.5, 2, 2.5, 3, 4];
const RENDER_MAX_WIDTH = 8192;
// toDataURL is the bottleneck, not the GPU: past this the encode takes minutes.
const RENDER_MAX_PIXELS = 30e6;
const RENDER_TIMEOUT_MS = 120000;

const PT_TO_MM = 25.4 / 72;
const REF_LABEL_PX = 12;      // a nominal street label in the style

function frameWidthMm(layout: SheetLayout) {
  return layout.mapFrame[2] * PT_TO_MM;
}

/** Pixel width for a target dpi, capped by what this machine can encode. */
function renderWidthFor(layout: SheetLayout, dpi: number, maxTexture: number) {
  const aspect = layout.mapFrame[2] / layout.mapFrame[3];
  let limit = Math.min(RENDER_MAX_WIDTH, maxTexture > 0 ? maxTexture : 4096);
  if (limit * (limit / aspect) > RENDER_MAX_PIXELS) {
    limit = Math.floor(Math.sqrt(RENDER_MAX_PIXELS * aspect));
  }
  const wanted = Math.round(dpi * frameWidthMm(layout) / 25.4);
  return Math.max(512, Math.min(wanted, limit));
}

/** Multiply a size, scaling an expression's OUTPUT stops rather than wrapping
 *  it: ["*", expr, k] demotes a top-level ["zoom"] interpolate, which the spec
 *  forbids and which silently invalidates the layer. */
function scaleSize(v: any, k: number): any {
  if (typeof v === "number") return v * k;
  if (!Array.isArray(v) || !v.length) return v;
  const op = v[0];
  const out: any[] = [];
  if (op === "interpolate" || op === "interpolate-hcl" || op === "interpolate-lab") {
    out.push(v[0], v[1], v[2]);
    for (let i = 3; i < v.length; i += 2) out.push(v[i], scaleSize(v[i + 1], k));
    return out;
  }
  if (op === "step") {
    out.push(v[0], v[1], scaleSize(v[2], k));
    for (let i = 3; i < v.length; i += 2) out.push(v[i], scaleSize(v[i + 1], k));
    return out;
  }
  if (op === "case") {
    out.push(v[0]);
    for (let i = 1; i < v.length - 1; i += 2) out.push(v[i], scaleSize(v[i + 1], k));
    out.push(scaleSize(v[v.length - 1], k));
    return out;
  }
  if (op === "match") {
    out.push(v[0], v[1]);
    for (let i = 2; i < v.length - 1; i += 2) out.push(v[i], scaleSize(v[i + 1], k));
    out.push(scaleSize(v[v.length - 1], k));
    return out;
  }
  if (op === "literal") return v;
  if (JSON.stringify(v).indexOf('"zoom"') !== -1) return v;   // cannot wrap
  return ["*", v, k];
}

/** Scale every pixel-measured symbol property so the print keeps the on-screen
 *  layout with more pixels. Ems (text-offset, text-max-width) must NOT be
 *  touched: they already follow text-size. */
function styleForPrint(
  style: StyleSpecification, renderWidth: number, viewWidth: number,
  layout: SheetLayout, labelMm: number,
): StyleSpecification {
  const k = labelMm > 0
    ? (labelMm * renderWidth) / (REF_LABEL_PX * frameWidthMm(layout))
    : renderWidth / Math.max(1, viewWidth);   // no target: keep what is on screen
  if (!(k > 0) || Math.abs(k - 1) < 1e-6) return style;
  (style.layers || []).forEach((layer: any) => {
    if (layer.type !== "symbol") return;
    const lay = layer.layout || (layer.layout = {});
    const paint = layer.paint || (layer.paint = {});
    if (lay["text-field"] !== undefined) {
      lay["text-size"] = scaleSize(lay["text-size"] ?? 16, k);
      lay["text-padding"] = scaleSize(lay["text-padding"] ?? 2, k);
    }
    if (lay["icon-image"] !== undefined) {
      lay["icon-size"] = scaleSize(lay["icon-size"] ?? 1, k);
      lay["icon-padding"] = scaleSize(lay["icon-padding"] ?? 2, k);
    }
    if (paint["text-halo-width"] !== undefined) {
      paint["text-halo-width"] = scaleSize(paint["text-halo-width"], k);
    }
  });
  return style;
}

// Normalised web-mercator: linear in screen space, which is what lets the
// frozen-view overlay map pixels to ground with plain arithmetic.
function mercatorX(lng: number) { return (lng + 180) / 360; }
function mercatorY(lat: number) {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}
function invMercatorX(x: number) { return x * 360 - 180; }
function invMercatorY(y: number) {
  const n = Math.PI * (1 - 2 * y);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function removeReach(map: Map) {
  try {
    if (map.getLayer(REACH_LINE_ID)) map.removeLayer(REACH_LINE_ID);
    if (map.getLayer(REACH_FILL_ID)) map.removeLayer(REACH_FILL_ID);
    if (map.getSource(REACH_SOURCE_ID)) map.removeSource(REACH_SOURCE_ID);
  } catch (_error) {
    // A concurrent style replacement may already have removed the overlay.
  }
}

function drawReach(map: Map, geojson: GeoJSON.FeatureCollection) {
  if (!map.isStyleLoaded()) return;
  try {
    const source = map.getSource(REACH_SOURCE_ID) as GeoJSONSource | undefined;
    if (source) {
      source.setData(geojson);
    } else {
      map.addSource(REACH_SOURCE_ID, {
        type: "geojson",
        data: geojson,
      });
    }
    if (!map.getLayer(REACH_FILL_ID)) {
      map.addLayer({
        id: REACH_FILL_ID,
        type: "fill",
        source: REACH_SOURCE_ID,
        paint: {
          "fill-color": "#2faaa0",
          "fill-opacity": 0.22,
        },
      });
    }
    if (!map.getLayer(REACH_LINE_ID)) {
      map.addLayer({
        id: REACH_LINE_ID,
        type: "line",
        source: REACH_SOURCE_ID,
        paint: {
          "line-color": "#32c7bb",
          "line-width": 2,
          "line-opacity": 0.96,
        },
      });
    }
  } catch (_error) {
    // style.load will retry when a style replacement is complete.
  }
}

function previewBox(layout: SheetLayout, width: number, height: number): PreviewBox {
  const pageRatio = layout.page[0] / layout.page[1];
  const margin = 0.94;
  let boxWidth = width * margin;
  let boxHeight = boxWidth / pageRatio;
  if (boxHeight > height * margin) {
    boxHeight = height * margin;
    boxWidth = boxHeight * pageRatio;
  }
  return {
    x: (width - boxWidth) / 2,
    y: (height - boxHeight) / 2,
    width: boxWidth,
    height: boxHeight,
    scale: boxWidth / layout.page[0],
  };
}

function PaperPreview({
  layout,
  viewport,
  showBadge,
}: {
  layout: SheetLayout
  viewport: Viewport
  showBadge: boolean
}) {
  const box = previewBox(layout, viewport.width, viewport.height);
  const pagePath = [
    `M0,0H${viewport.width}V${viewport.height}H0Z`,
    `M${box.x},${box.y}h${box.width}v${box.height}h${-box.width}Z`,
  ].join(" ");
  const frame = layout.mapFrame;
  const frameX = box.x + frame[0] * box.scale;
  const frameY = box.y + frame[1] * box.scale;
  const patchSize = layout.patchSize * box.scale;
  const badge = layout.badge;
  const captionY = box.y < 22 ? box.y + 18 : box.y - 7;
  const square = isSquareFrame(layout);

  return <svg
    className="maputnik-paper-preview"
    aria-hidden="true"
    width={viewport.width}
    height={viewport.height}
    viewBox={`0 0 ${viewport.width} ${viewport.height}`}
    style={{
      left: viewport.left,
      top: viewport.top,
      width: viewport.width,
      height: viewport.height,
    }}
  >
    <path className="maputnik-paper-preview__shade" d={pagePath} fillRule="evenodd" />
    <rect
      className={`maputnik-paper-preview__frame${square ? " is-square" : ""}`}
      x={frameX}
      y={frameY}
      width={frame[2] * box.scale}
      height={frame[3] * box.scale}
      rx="2"
    />
    {layout.patches.map((position, index) => {
      const x = box.x + position[0] * box.scale;
      const y = box.y + position[1] * box.scale;
      const href = `/api/apriltag-svg/tag16h5/${layout.tagIds[index]}.svg`;
      return <g key={layout.tagIds[index]}>
        <rect
          className="maputnik-paper-preview__tag"
          x={x}
          y={y}
          width={patchSize}
          height={patchSize}
        />
        <image
          className="maputnik-paper-preview__tag-image"
          href={href}
          x={x}
          y={y}
          width={patchSize}
          height={patchSize}
          preserveAspectRatio="none"
        />
      </g>;
    })}
    {/* The layout from /api/map-sheet-layout carries the default geometry and
        knows nothing of this switch, so the switch decides here; the export
        sends the same flag on so the PDF agrees with the preview. A plate
        in a side margin is drawn by the margin, above its white paper. */}
    {showBadge && !layout.badgePanel ? <rect
      className="maputnik-paper-preview__badge"
      x={box.x + badge[0] * box.scale}
      y={box.y + badge[1] * box.scale}
      width={badge[2] * box.scale}
      height={badge[3] * box.scale}
    /> : null}
    <text className="maputnik-paper-preview__caption" x={box.x + 6} y={captionY}>
      {layout.pageSize} landscape · export area{square ? " · map 1:1" : ""}
    </text>
  </svg>;
}

function PanelTextArea({
  value,
  placeholder,
  onChange,
}: {
  value: string
  placeholder?: string
  onChange(text: string): void
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Grow with the text so the column reads like the printed one, not like a
  // box with a scrollbar of its own. Runs every render: the scale changes too.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  });
  return <textarea
    ref={ref}
    className="maputnik-paper-panel__text"
    rows={1}
    value={value}
    placeholder={placeholder}
    spellCheck={false}
    aria-label="Margin text"
    onChange={event => onChange(event.target.value)}
  />;
}

function MarginPanel({
  side,
  base,
  box,
  region,
  panel,
  otherWidth,
  pageSize,
  badge,
  onUpdate,
  onRemove,
}: {
  side: PanelSide
  base: SheetLayout
  box: PreviewBox
  region: PanelRegion
  panel: SidePanel
  otherWidth: number
  pageSize: "A4" | "A3"
  badge: [number, number, number, number] | null
  onUpdate(update: PanelUpdater): void
  onRemove(): void
}) {
  const resize = useRef<{x: number; width: number} | null>(null);
  const px = (pt: number) => pt * box.scale;
  // The text stops above the plate, as it does in the PDF.
  const padBottom = PANEL_PAD_PT + (badge ? BADGE_H_PT + PANEL_PAD_PT : 0);

  return <div
    className={`maputnik-paper-panel is-${side}`}
    style={{
      left: box.x + px(region.x),
      top: box.y + px(region.y),
      width: px(region.width),
      height: px(region.height),
      fontSize: px(PANEL_FONT_PT[pageSize]),
    }}
  >
    <div
      className="maputnik-paper-panel__body"
      style={{padding: `${px(PANEL_PAD_PT)}px ${px(PANEL_PAD_PT)}px ${px(padBottom)}px`}}
    >
      <PanelTextArea
        value={panel.text}
        placeholder="Type notes here"
        onChange={text => onUpdate(current => ({...current, text}))}
      />
    </div>
    {badge ? <div
      className="maputnik-paper-panel__badge"
      style={{
        left: px(badge[0] - region.x),
        top: px(badge[1] - region.y),
        width: px(badge[2]),
        height: px(badge[3]),
      }}
    /> : null}
    <div className="maputnik-paper-panel__tools">
      <button
        type="button"
        className="maputnik-paper-panel__button"
        title="Remove this margin"
        aria-label="Remove this margin"
        onClick={onRemove}
      >
        <MdClose />
      </button>
    </div>
    <div
      className={`maputnik-paper-panel__handle is-${side}`}
      title="Drag to change the margin's width. Snaps where the map becomes square."
      onPointerDown={event => {
        event.preventDefault();
        resize.current = {x: event.clientX, width: region.width};
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (!resize.current) return;
        const delta = (event.clientX - resize.current.x) / box.scale;
        const raw = side === "left"
          ? resize.current.width + delta
          : resize.current.width - delta;
        const width = snapPanelWidth(base, raw, otherWidth, box.scale);
        onUpdate(current => ({...current, width}));
      }}
      onPointerUp={() => { resize.current = null; }}
      onPointerCancel={() => { resize.current = null; }}
    />
  </div>;
}

function PaperMargins({
  base,
  layout,
  viewport,
  panels,
  pageSize,
  showBadge,
  onUpdate,
  onAdd,
  onRemove,
}: {
  base: SheetLayout
  layout: SheetLayout
  viewport: Viewport
  panels: SidePanels
  pageSize: "A4" | "A3"
  showBadge: boolean
  onUpdate(side: PanelSide, update: PanelUpdater): void
  onAdd(side: PanelSide): void
  onRemove(side: PanelSide): void
}) {
  const box = previewBox(layout, viewport.width, viewport.height);
  const regions = panelRegions(base, layout, panels);
  const widths = panelWidths(base, panels);
  const buttonSize = 26;
  const inset = 8;
  return <div
    className="maputnik-paper-margins"
    style={{
      left: viewport.left,
      top: viewport.top,
      width: viewport.width,
      height: viewport.height,
    }}
  >
    {PANEL_SIDES.map(side => {
      const panel = panels[side];
      if (panel) {
        return <MarginPanel
          key={side}
          side={side}
          base={base}
          box={box}
          region={regions[side]}
          panel={panel}
          otherWidth={side === "left" ? widths.right : widths.left}
          pageSize={pageSize}
          badge={showBadge && layout.badgePanel === side ? layout.badge : null}
          onUpdate={update => onUpdate(side, update)}
          onRemove={() => onRemove(side)}
        />;
      }
      return <button
        key={side}
        type="button"
        className={`maputnik-paper-margins__add is-${side}`}
        style={{
          left: side === "left"
            ? box.x + inset
            : box.x + box.width - inset - buttonSize,
          // A third of the way down: the vertical centre is where the
          // mid-left and mid-right tags sit, and the button would cover them.
          top: box.y + box.height / 3 - buttonSize / 2,
        }}
        title={`Add a ${side} margin for notes`}
        aria-label={`Add a ${side} margin`}
        onClick={() => onAdd(side)}
      >
        <MdAdd />
      </button>;
    })}
  </div>;
}

export default function PaperMapTools(props: PaperMapToolsProps) {
  const [layouts, setLayouts] = useState<SheetLayouts | null>(null);
  const [pageSize, setPageSize] = useState<"A4" | "A3">("A4");
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [reachEnabled, setReachEnabled] = useState(false);
  const [reachMinutes, setReachMinutes] = useState(10);
  const [reachData, setReachData] = useState<GeoJSON.FeatureCollection | null>(null);
  const [reachStatus, setReachStatus] = useState("");
  const [reachError, setReachError] = useState(false);
  const [mapType, setMapType] = useState(() => {
    try {
      return window.localStorage.getItem("paperTestMapType") || "";
    } catch (_error) {
      return "";
    }
  });
  // Printing the ID is the default: it is what tells the scans apart later.
  const [showBadge, setShowBadge] = useState(true);
  const [fixZoom, setFixZoom] = useState(false);
  const [renderZoom, setRenderZoom] = useState(15.5);
  const [dpi, setDpi] = useState<number>(300);
  const [labelMm, setLabelMm] = useState<number>(2.5);
  const [roadLabelMode, setRoadLabelMode] = useState<RoadLabelMode>(() => {
    try {
      const stored = window.localStorage.getItem("paperRoadLabelMode") as RoadLabelMode;
      return ROAD_LABEL_MODES.includes(stored) ? stored : "hide";
    } catch (_error) {
      return "hide";
    }
  });
  const [maxTexture, setMaxTexture] = useState<number>(0);
  const [usedSheetIds, setUsedSheetIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState<"" | "pdf" | "docx">("");
  const [panels, setPanels] = useState<SidePanels>({left: null, right: null});
  const [exportStatus, setExportStatus] = useState("");
  const [exportKind, setExportKind] = useState<"idle" | "busy" | "ok" | "warn" | "error">("idle");
  const reachRequest = useRef(0);

  const baseLayout = layouts ? layouts[pageSize] : null;
  // Everything downstream -- preview, capture, export -- sees the frame with
  // the margins already taken out of it.
  const layout = useMemo(
    () => (baseLayout ? layoutWithPanels(baseLayout, panels) : null),
    [baseLayout, panels],
  );

  const updatePanel = useCallback((side: PanelSide, update: PanelUpdater) => {
    setPanels(current => {
      const panel = current[side];
      return panel ? {...current, [side]: update(panel)} : current;
    });
  }, []);

  const addPanel = useCallback((side: PanelSide) => {
    if (!baseLayout) return;
    setPanels(current => {
      if (current[side]) return current;
      const other = current[side === "left" ? "right" : "left"];
      const width = clampPanelWidth(
        baseLayout, Math.round(baseLayout.page[0] * 0.2), other ? other.width : 0);
      return {...current, [side]: {width, text: ""}};
    });
  }, [baseLayout]);

  const removePanel = useCallback((side: PanelSide) => {
    setPanels(current => ({...current, [side]: null}));
  }, []);

  /**
   * "Fix zoom": freeze the level the sheet renders at, then compose coverage
   * like paper.
   *
   * Clicking the button renders a snapshot of the current view at the current
   * zoom -- TWICE the viewport in each direction, so there is saved margin to
   * widen into -- and lays it over the map. Scrolling scales that snapshot and
   * dragging pans it; the content never re-evaluates, exactly like moving a
   * printed sheet. Driving the live map instead (inflating its container under
   * a CSS transform) fought Maputnik's layout and MapLibre's resize handling,
   * which is why scroll did nothing and the viewport broke.
   *
   * The overlay's own geometry is the single source of truth at export: frame
   * corners map to ground through it, never through the live map underneath.
   */
  const fixRef = useRef<{
    zoom: number;
    rect: {left: number; top: number; width: number; height: number};
    overlay: HTMLCanvasElement;
    snapshot: HTMLCanvasElement;
    snapX0: number; snapY0: number; snapX1: number; snapY1: number;
    mercPerSnapPx: number;      // mercator units per snapshot CSS px
    centerMx: number;           // mercator at the viewport centre
    centerMy: number;
    mercPerVis: number;         // mercator units per visual px (the paper scale)
    drag: {x: number; y: number; mx: number; my: number} | null;
  } | null>(null);
  const freezeBusy = useRef(false);

  /** Offscreen render of an exact centre/zoom at a given CSS size. */
  const renderSnapshot = useCallback(async (
    center: {lng: number; lat: number},
    zoom: number,
    cssWidth: number,
    cssHeight: number,
  ) => {
    const limit = maxTexture > 0 ? maxTexture : 4096;
    const ratio = Math.min(
      window.devicePixelRatio || 1, limit / cssWidth, limit / cssHeight);
    const host = document.createElement("div");
    host.className = "maputnik-paper-render-host";
    host.style.width = `${cssWidth}px`;
    host.style.height = `${cssHeight}px`;
    document.body.appendChild(host);
    const shot = new MapLibreGl.Map({
      container: host,
      style: props.replaceAccessTokens(cloneDeep(props.mapStyle)),
      center: [center.lng, center.lat],
      zoom,
      interactive: false,
      attributionControl: false,
      canvasContextAttributes: {preserveDrawingBuffer: true},
      fadeDuration: 0,
      pixelRatio: ratio,
    });
    const removeTransitRuntime = installTransitRuntime(shot);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          reject(new Error("The frozen view timed out while rendering."));
        }, RENDER_TIMEOUT_MS);
        shot.once("error", (event: {error?: Error}) => {
          window.clearTimeout(timeout);
          reject(new Error(event?.error?.message || "Snapshot render failed."));
        });
        shot.once("style.load", () => {
          applyRoadLabelMode(shot, roadLabelMode);
          if (reachEnabled && reachData) drawReach(shot, reachData);
          shot.once("idle", () => {
            window.clearTimeout(timeout);
            resolve();
          });
        });
      });
      if (dedupeBusStops(shot)) {
        await new Promise<void>(resolve => shot.once("idle", () => resolve()));
      }
      if (declutterPoiIcons(shot)) {
        await new Promise<void>(resolve => shot.once("idle", () => resolve()));
      }
      // Copy before remove(): the WebGL canvas dies with the map.
      const source = shot.getCanvas();
      const copy = document.createElement("canvas");
      copy.width = source.width;
      copy.height = source.height;
      const context = copy.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable");
      context.drawImage(source, 0, 0);
      return {canvas: copy, bounds: shot.getBounds()};
    } finally {
      removeTransitRuntime();
      shot.remove();
      host.remove();
    }
  }, [maxTexture, props.mapStyle, props.replaceAccessTokens, reachData, reachEnabled, roadLabelMode]);

  const releaseFixZoom = useCallback(() => {
    const map = props.map;
    const st = fixRef.current;
    fixRef.current = null;
    setFixZoom(false);
    setExportKind("idle");
    setExportStatus("");
    if (!st) return;
    st.overlay.remove();
    if (map) {
      // Fold the composed coverage into a real zoom so the view does not jump;
      // labels re-evaluate at that level, which is what unfixing means.
      map.jumpTo({
        center: [invMercatorX(st.centerMx), invMercatorY(st.centerMy)],
        zoom: st.zoom - Math.log2(st.mercPerVis / st.mercPerSnapPx),
      });
    }
  }, [props.map]);

  const activateFixZoom = useCallback(async () => {
    const map = props.map;
    if (!map || fixRef.current || freezeBusy.current) return;
    const container = map.getContainer();
    const r = container.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const zoom = Math.round(map.getZoom() * 100) / 100;
    freezeBusy.current = true;
    setExportKind("busy");
    setExportStatus(`Freezing z${zoom}…`);
    try {
      const centre = map.getCenter();
      const shot = await renderSnapshot(
        centre, zoom, Math.round(r.width * 2), Math.round(r.height * 2));

      const overlay = document.createElement("canvas");
      const dpr = window.devicePixelRatio || 1;
      overlay.width = Math.round(r.width * dpr);
      overlay.height = Math.round(r.height * dpr);
      overlay.style.cssText =
        `position:fixed;left:${r.left}px;top:${r.top}px;` +
        `width:${r.width}px;height:${r.height}px;` +
        `z-index:60;cursor:grab;touch-action:none;background:#fff;`;
      document.body.appendChild(overlay);

      const snapX0 = mercatorX(shot.bounds.getWest());
      const snapX1 = mercatorX(shot.bounds.getEast());
      const snapY0 = mercatorY(shot.bounds.getNorth());
      const snapY1 = mercatorY(shot.bounds.getSouth());
      const mercPerSnapPx = (snapX1 - snapX0) / (r.width * 2);
      const st = {
        zoom,
        rect: {left: r.left, top: r.top, width: r.width, height: r.height},
        overlay,
        snapshot: shot.canvas,
        snapX0, snapY0, snapX1, snapY1,
        mercPerSnapPx,
        centerMx: mercatorX(centre.lng),
        centerMy: mercatorY(centre.lat),
        mercPerVis: mercPerSnapPx,   // 1:1 with the snapshot at the freeze
        drag: null as {x: number; y: number; mx: number; my: number} | null,
      };

      const draw = () => {
        const ctx = st.overlay.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, st.rect.width, st.rect.height);
        const x0 = st.rect.width / 2 + (st.snapX0 - st.centerMx) / st.mercPerVis;
        const y0 = st.rect.height / 2 + (st.snapY0 - st.centerMy) / st.mercPerVis;
        const x1 = st.rect.width / 2 + (st.snapX1 - st.centerMx) / st.mercPerVis;
        const y1 = st.rect.height / 2 + (st.snapY1 - st.centerMy) / st.mercPerVis;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(st.snapshot, x0, y0, x1 - x0, y1 - y0);
      };

      overlay.addEventListener("wheel", event => {
        event.preventDefault();
        const cx = event.clientX - st.rect.left;
        const cy = event.clientY - st.rect.top;
        const before = st.mercPerVis;
        // Out is capped at x2 -- exactly what the snapshot rendered ("twice
        // the viewport ... margin to widen into"). The old x6 let the frame
        // reach ground the snapshot never covered, which showed as a white
        // void on screen, and spread the locked zoom's line weights so thin
        // the exported sheet printed as blank paper.
        const next = Math.max(st.mercPerSnapPx / 2,
          Math.min(st.mercPerSnapPx * 2, before * Math.exp(event.deltaY * 0.0012)));
        if (next === before) return;
        // Keep the ground under the cursor where it is while scaling.
        st.centerMx += (cx - st.rect.width / 2) * (before - next);
        st.centerMy += (cy - st.rect.height / 2) * (before - next);
        st.mercPerVis = next;
        draw();
      }, {passive: false});
      overlay.addEventListener("pointerdown", event => {
        st.drag = {x: event.clientX, y: event.clientY, mx: st.centerMx, my: st.centerMy};
        overlay.setPointerCapture(event.pointerId);
        overlay.style.cursor = "grabbing";
      });
      overlay.addEventListener("pointermove", event => {
        if (!st.drag) return;
        st.centerMx = st.drag.mx - (event.clientX - st.drag.x) * st.mercPerVis;
        st.centerMy = st.drag.my - (event.clientY - st.drag.y) * st.mercPerVis;
        draw();
      });
      const stopDrag = () => {
        st.drag = null;
        overlay.style.cursor = "grab";
      };
      overlay.addEventListener("pointerup", stopDrag);
      overlay.addEventListener("pointercancel", stopDrag);

      fixRef.current = st;
      draw();
      setRenderZoom(zoom);
      setFixZoom(true);
      setExportKind("ok");
      setExportStatus(`z${zoom} locked`);
    } catch (error) {
      setExportKind("error");
      setExportStatus(messageFromError(error));
    } finally {
      freezeBusy.current = false;
    }
  }, [props.map, renderSnapshot]);

  // Never leave a stale overlay if the component goes away.
  useEffect(() => () => {
    if (fixRef.current) releaseFixZoom();
  }, [releaseFixZoom]);

  // A render past MAX_TEXTURE_SIZE fails or clamps silently, so cap to it.
  useEffect(() => {
    try {
      const probe = document.createElement("canvas");
      const gl = (probe.getContext("webgl2") || probe.getContext("webgl")) as
        WebGLRenderingContext | null;
      if (gl) setMaxTexture(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    } catch (_error) { setMaxTexture(0); }
  }, []);



  // Only the map is stored. Every printed copy is the same map, however many
  // people fill one in; each page gets its own sheet number when it is
  // digitised, not here.
  const plannedMapId = useCallback(() => {
    const type = mapType.trim();
    if (!/^[1-9][0-9]{0,8}$/.test(type)) {
      throw new Error("Enter a map ID of 1 or higher.");
    }
    return type;
  }, [mapType]);

  // Exporting onto a stored map ID replaces that map. Numbered copies an older
  // export left behind ("7_1", ...) are the same map ID too.
  const mapIdInUse = useMemo(() => {
    try {
      const id = plannedMapId();
      return [...usedSheetIds].some(used => used === id || used.startsWith(`${id}_`));
    } catch (_error) {
      return false;
    }
  }, [plannedMapId, usedSheetIds]);

  const refreshUsedSheetIds = useCallback(async () => {
    try {
      const response = await fetch("/api/map-sheets", {cache: "no-store"});
      const data = await response.json();
      const items = data?.items || data?.sheets || data?.records || [];
      setUsedSheetIds(new Set(items.map((item: {id: unknown}) => String(item.id))));
    } catch (_error) {
      setUsedSheetIds(new Set());
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/map-sheet-layout", {cache: "no-store"})
      .then(response => response.json())
      .then(data => {
        if (active && data?.ok && data.layouts) setLayouts(data.layouts as SheetLayouts);
      })
      .catch(() => {
        if (active) {
          setExportKind("error");
          setExportStatus("Page layout unavailable");
        }
      });
    refreshUsedSheetIds();
    return () => {
      active = false;
    };
  }, [refreshUsedSheetIds]);

  useEffect(() => {
    try {
      if (mapType) window.localStorage.setItem("paperTestMapType", mapType);
    } catch (_error) {
      // Persistence is optional.
    }
  }, [mapType]);

  useEffect(() => {
    const map = props.map;
    if (!map) {
      setViewport(null);
      return;
    }
    const container = map.getContainer();
    const updateViewport = () => {
      const rect = container.getBoundingClientRect();
      setViewport({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(container);
    window.addEventListener("resize", updateViewport);
    map.on("resize", updateViewport);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateViewport);
      map.off("resize", updateViewport);
    };
  }, [props.map]);

  const updateReach = useCallback(async () => {
    const map = props.map;
    if (!map || !reachEnabled) return;
    const requestId = ++reachRequest.current;
    const center = map.getCenter();
    setReachError(false);
    setReachStatus("Computing…");
    try {
      const response = await fetch("/api/walk-reach", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          origin: {lng: center.lng, lat: center.lat},
          minutes: reachMinutes,
        }),
      });
      const data = await response.json();
      if (requestId !== reachRequest.current) return;
      if (!response.ok || !data?.ok || !data.geojson) {
        throw new Error(data?.error === "no_local_network"
          ? "No online or cached walking network"
          : (data?.error || "Walking reach failed"));
      }
      const geojson = data.geojson as GeoJSON.FeatureCollection;
      setReachData(geojson);
      drawReach(map, geojson);
      setReachStatus(`${reachMinutes} min ready`);
    } catch (error) {
      if (requestId !== reachRequest.current) return;
      setReachData(null);
      removeReach(map);
      setReachError(true);
      setReachStatus(messageFromError(error));
    }
  }, [props.map, reachEnabled, reachMinutes]);

  useEffect(() => {
    const map = props.map;
    if (!map) return;
    if (!reachEnabled) {
      ++reachRequest.current;
      setReachData(null);
      setReachStatus("");
      setReachError(false);
      removeReach(map);
      return;
    }
    let timer = 0;
    const scheduleReach = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void updateReach(), 350);
    };
    scheduleReach();
    map.on("moveend", scheduleReach);
    return () => {
      window.clearTimeout(timer);
      map.off("moveend", scheduleReach);
    };
  }, [props.map, reachEnabled, reachMinutes, updateReach]);

  useEffect(() => {
    const map = props.map;
    if (!map || !reachEnabled || !reachData) return;
    const restoreReach = () => drawReach(map, reachData);
    restoreReach();
    map.on("style.load", restoreReach);
    return () => {
      map.off("style.load", restoreReach);
    };
  }, [props.map, reachEnabled, reachData]);

  useEffect(() => {
    const map = props.map;
    return () => {
      if (map) removeReach(map);
    };
  }, [props.map]);

  // Keep the editing view honest about what the sheet will show: the same
  // declutter pass that runs before capture also runs on the live map.
  useEffect(() => {
    if (!props.map) return;
    return installPoiDeclutter(props.map);
  }, [props.map]);

  useEffect(() => {
    if (!props.map) return;
    return installRoadLabelMode(props.map, roadLabelMode);
  }, [props.map, roadLabelMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem("paperRoadLabelMode", roadLabelMode);
    } catch (_error) {
      // Private browsing; the mode simply will not persist.
    }
  }, [roadLabelMode]);

  const capturePrintableMap = useCallback(async () => {
    const map = props.map;
    if (!map || !layout) throw new Error("The map is not ready.");
    const container = map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) throw new Error("The map has no printable area.");

    const frozen = fixRef.current;
    const frame = layout.mapFrame;
    let captureBounds: LngLatBounds;
    let viewFrameWidth: number;
    if (frozen) {
      // While frozen, the overlay is the truth. The live map has not moved
      // since the freeze, so unprojecting through it would export whatever was
      // on screen back then -- which is exactly the mismatch this replaces.
      const fbox = previewBox(layout, frozen.rect.width, frozen.rect.height);
      const l = fbox.x + frame[0] * fbox.scale;
      const t = fbox.y + frame[1] * fbox.scale;
      const r = l + frame[2] * fbox.scale;
      const b = t + frame[3] * fbox.scale;
      const mx = (x: number) =>
        frozen.centerMx + (x - frozen.rect.width / 2) * frozen.mercPerVis;
      const my = (y: number) =>
        frozen.centerMy + (y - frozen.rect.height / 2) * frozen.mercPerVis;
      captureBounds = new LngLatBounds(
        [invMercatorX(mx(l)), invMercatorY(my(b))],   // south-west
        [invMercatorX(mx(r)), invMercatorY(my(t))],   // north-east
      );
      viewFrameWidth = frame[2] * fbox.scale;
    } else {
      const box = previewBox(layout, width, height);
      const left = box.x + frame[0] * box.scale;
      const top = box.y + frame[1] * box.scale;
      const right = left + frame[2] * box.scale;
      const bottom = top + frame[3] * box.scale;
      captureBounds = new LngLatBounds();
      [[left, top], [right, top], [right, bottom], [left, bottom]].forEach(point => {
        captureBounds.extend(map.unproject(point as [number, number]));
      });
      viewFrameWidth = right - left;
    }

    // Target pixels for the sheet: dpi against the frame's physical width.
    const targetWidth = renderWidthFor(layout, dpi, maxTexture);
    const targetHeight = Math.round(targetWidth * frame[3] / frame[2]);

    // How many CSS pixels the map is given, and how many real pixels it draws.
    //
    // Free zoom: they are the same, and fitBounds picks whatever zoom suits.
    //
    // Fix zoom: the map is laid out at ground/resolution(renderZoom) CSS px so
    // the STYLE evaluates at that zoom -- same labels, same detail, same line
    // weights, whatever area the frame covers. pixelRatio then multiplies the
    // framebuffer up to the target, which is what gives full print resolution
    // without changing the zoom. Sizing the canvas directly instead, as this
    // did at first, pinned the detail correctly but capped the sheet at ~83 dpi.
    let cssWidth = targetWidth;
    let cssHeight = targetHeight;
    let pixelRatio = 1;
    let pinnedZoom = 0;
    let pinnedCentre: [number, number] | null = null;
    if (frozen) {
      // Exact, straight from MapLibre's own convention: the mercator square
      // [0,1] spans 512 * 2^zoom CSS px. The previous metres detour used the
      // 256-tile constant (156543/2^z), which is HALF MapLibre's resolution --
      // the canvas came out half size, so at the pinned zoom it covered half
      // the frame's ground per axis and the PDF was the frame's central
      // quarter. This is why the export did not match the screen.
      const world = 512 * (2 ** frozen.zoom);
      const mercW = mercatorX(captureBounds.getEast())
        - mercatorX(captureBounds.getWest());
      const mercH = mercatorY(captureBounds.getSouth())
        - mercatorY(captureBounds.getNorth());
      cssWidth = Math.max(64, Math.round(mercW * world));
      cssHeight = Math.max(64, Math.round(mercH * world));
      // The centre must be the mercator midpoint too, not the arithmetic-mean
      // latitude of getCenter(), so the render sits exactly on the frame.
      pinnedCentre = [
        invMercatorX((mercatorX(captureBounds.getWest())
          + mercatorX(captureBounds.getEast())) / 2),
        invMercatorY((mercatorY(captureBounds.getNorth())
          + mercatorY(captureBounds.getSouth())) / 2),
      ];
      pixelRatio = targetWidth / cssWidth;
      pinnedZoom = frozen.zoom;
    }

    // The backing canvas is css size TIMES pixelRatio; both dimensions must fit
    // the texture limit or the render fails with nothing to say for itself.
    // Below 1 is legal and right for huge coverage at a high pinned zoom: the
    // sheet keeps that zoom's labels and simply prints with fewer dots.
    const limit = maxTexture > 0 ? maxTexture : 4096;
    pixelRatio = Math.min(pixelRatio, limit / cssWidth, limit / cssHeight);
    const renderWidth = Math.round(cssWidth * pixelRatio);
    const renderHeight = Math.round(cssHeight * pixelRatio);

    const host = document.createElement("div");
    host.className = "maputnik-paper-render-host";
    host.style.width = `${cssWidth}px`;
    host.style.height = `${cssHeight}px`;
    document.body.appendChild(host);

    // Pinned: the style goes in untouched. The canvas CSS size equals the
    // frame's on-screen extent at the pinned zoom, so MapLibre reproduces the
    // live placement exactly, and pixelRatio alone supplies the dpi. Running
    // styleForPrint on top would scale text a second time.
    const printableStyle = pinnedZoom
      ? props.replaceAccessTokens(cloneDeep(props.mapStyle))
      : styleForPrint(
        props.replaceAccessTokens(cloneDeep(props.mapStyle)),
        renderWidth, viewFrameWidth, layout, labelMm);
    const printMap = new MapLibreGl.Map({
      container: host,
      style: printableStyle,
      ...(pinnedZoom
        ? {center: pinnedCentre as [number, number], zoom: pinnedZoom}
        : {bounds: captureBounds, fitBoundsOptions: {padding: 0, duration: 0}}),
      interactive: false,
      attributionControl: false,
      canvasContextAttributes: {preserveDrawingBuffer: true},
      fadeDuration: 0,
      // Explicit, never devicePixelRatio: on a HiDPI screen that silently
      // doubles the framebuffer past the texture limit and toDataURL never
      // returns. Here it is also the lever that buys resolution at a fixed zoom.
      pixelRatio,
    });
    const removeTransitRuntime = installTransitRuntime(printMap);

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          reject(new Error(
            `Render timed out at ${renderWidth}x${renderHeight}px.`));
        }, RENDER_TIMEOUT_MS);
        printMap.once("style.load", () => {
          applyRoadLabelMode(printMap, roadLabelMode);
          if (reachEnabled && reachData) drawReach(printMap, reachData);
          printMap.once("idle", () => {
            window.clearTimeout(timeout);
            resolve();
          });
        });
      });
      if (dedupeBusStops(printMap)) {
        await new Promise<void>(resolve => printMap.once("idle", () => resolve()));
      }
      // After the bus filter settles: shuffle overlapping POI icons apart, then
      // let MapLibre re-place labels around the shifted icons.
      if (declutterPoiIcons(printMap)) {
        await new Promise<void>(resolve => printMap.once("idle", () => resolve()));
      }
      const canvas = printMap.getCanvas();
      const cssWidth = canvas.clientWidth || renderWidth;
      const cssHeight = canvas.clientHeight || renderHeight;
      const corners = [[0, 0], [cssWidth, 0], [cssWidth, cssHeight], [0, cssHeight]]
        .map(point => {
          const lngLat = printMap.unproject(point as [number, number]);
          return [lngLat.lng, lngLat.lat];
        });
      const center = printMap.getCenter();
      return {
        image: captureMapCanvasWithPinpoints(printMap, props.pinpoints),
        corners,
        camera: {
          center: [center.lng, center.lat],
          zoom: printMap.getZoom(),
          bearing: 0,
          pitch: 0,
        },
      };
    } finally {
      removeTransitRuntime();
      printMap.remove();
      host.remove();
    }
  }, [
    layout,
    props.map,
    props.mapStyle,
    props.pinpoints,
    props.replaceAccessTokens,
    reachData,
    reachEnabled,
    fixZoom,
    renderZoom,
    dpi,
    labelMm,
    maxTexture,
    roadLabelMode,
  ]);

  /** Save the map and download it as PDF or Word. Both formats save the same
   *  record -- the printed sheet has to be registered later whichever file it
   *  was printed from -- only the download differs. Print as many copies as
   *  there are people; they all carry the same map ID. */
  const exportSheets = useCallback(async (format: "pdf" | "docx") => {
    setExporting(format);
    setExportKind("busy");
    try {
      const id = plannedMapId();
      setExportStatus("Rendering map…");
      const printable = await capturePrintableMap();
      const sidePanels = serialisePanels(panels);
      setExportStatus("Saving…");
      const response = await fetch("/api/map-sheets", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          id,
          title: `Map ${id}`,
          image: printable.image,
          corners: printable.corners,
          camera: printable.camera,
          theme: "maplibre",
          pageSize,
          layout: {
            showBadge,
            mapFrame: layout ? layout.mapFrame : undefined,
            sidePanels,
          },
        }),
      });
      const data = await response.json();
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "Export failed");
      }
      const url = format === "docx" ? data.docxUrl : data.pdfUrl;
      if (!url) {
        throw new Error(format === "docx"
          ? "Word export unavailable; the PDF was saved"
          : "PDF export failed");
      }
      const link = document.createElement("a");
      link.href = url;
      link.download = `map-sheet-${id}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      await refreshUsedSheetIds();
      setExportKind("ok");
      setExportStatus(`Downloaded map ${id}`);
    } catch (error) {
      const message = error instanceof DOMException && error.name === "SecurityError"
        ? "The tile server blocked map capture."
        : messageFromError(error);
      setExportKind("error");
      setExportStatus(message);
    } finally {
      setExporting("");
    }
  }, [
    capturePrintableMap,
    layout,
    pageSize,
    panels,
    plannedMapId,
    refreshUsedSheetIds,
    showBadge,
  ]);

  useEffect(() => {
    if (mapIdInUse && (exportKind === "idle" || exportKind === "warn")) {
      setExportKind("warn");
      setExportStatus(`Map ${mapType.trim()} will be replaced`);
    } else if (!mapIdInUse && exportKind === "warn") {
      setExportKind("idle");
      setExportStatus("");
    }
  }, [mapIdInUse, mapType, exportKind]);

  const mapReady = Boolean(props.map && layout);

  return <>
    <div className="maputnik-paper-tools" aria-label="Paper map tools">
      <div className="maputnik-paper-tools__group" title={reachStatus || "Show walking reach"}>
        <MdDirectionsWalk />
        <label className="maputnik-paper-tools__check">
          <input
            type="checkbox"
            checked={reachEnabled}
            disabled={!mapReady}
            onChange={event => setReachEnabled(event.target.checked)}
          />
          <span>Walk</span>
        </label>
        <input
          className="maputnik-paper-tools__minutes"
          type="number"
          min="1"
          max="60"
          step="1"
          aria-label="Walking minutes"
          value={reachMinutes}
          disabled={!mapReady}
          onChange={event => {
            const value = Number(event.target.value);
            setReachMinutes(Math.max(1, Math.min(60, Number.isFinite(value) ? value : 10)));
          }}
        />
        <span className="maputnik-paper-tools__unit">min</span>
        <span
          className={`maputnik-paper-tools__state${reachError ? " is-error" : ""}${reachData ? " is-ok" : ""}`}
          aria-label={reachStatus || "Walking reach off"}
        />
      </div>

      <div className="maputnik-paper-tools__group">
        <MdStayCurrentLandscape />
        <select
          className="maputnik-select maputnik-paper-tools__page-size"
          aria-label="Paper size"
          value={pageSize}
          disabled={!layouts}
          onChange={event => setPageSize(event.target.value as "A4" | "A3")}
        >
          <option value="A4">A4</option>
          <option value="A3">A3</option>
        </select>
        <button
          className={`maputnik-paper-tools__fix${fixZoom ? " is-active" : ""}`}
          type="button"
          disabled={!mapReady}
          title={fixZoom
            ? `Rendering locked at z${renderZoom}. Scrolling changes how much map is in the frame, not the detail. Click to release.`
            : "Freeze the current zoom level. Scrolling then changes how much map fits in the frame -- like scaling paper -- while labels and detail stay as they are now."}
          onClick={() => (fixZoom ? releaseFixZoom() : activateFixZoom())}
        >
          {fixZoom ? `z${renderZoom} locked` : "Fix zoom"}
        </button>
        <select
          className="maputnik-select maputnik-paper-tools__page-size"
          aria-label="Print quality"
          title="Render resolution of the exported sheet"
          value={dpi}
          disabled={!mapReady}
          onChange={event => setDpi(Number(event.target.value))}
        >
          {DPI_OPTIONS.map(value => (
            <option key={value} value={value}>{value} dpi</option>
          ))}
        </select>
        <select
          className="maputnik-select maputnik-paper-tools__page-size"
          aria-label="Printed label size"
          title={fixZoom
            ? "Inactive while the zoom is locked -- the sheet reproduces the labels exactly as shown"
            : "Physical height of street labels on the exported sheet. The on-screen view is not affected."}
          value={labelMm}
          disabled={!mapReady || fixZoom}
          onChange={event => setLabelMm(Number(event.target.value))}
        >
          {LABEL_MM_OPTIONS.map(mm => (
            <option key={mm} value={mm}>
              {mm === 0 ? "as shown" : `${mm.toFixed(1)} mm`}
            </option>
          ))}
        </select>
        <select
          className="maputnik-select maputnik-paper-tools__page-size"
          aria-label="Road label collisions"
          title="When road names collide: keep the style's behaviour, hide the less important name, or also shift names along their road to a free spot"
          value={roadLabelMode}
          disabled={!mapReady}
          onChange={event => setRoadLabelMode(event.target.value as RoadLabelMode)}
        >
          <option value="styled">roads: as styled</option>
          <option value="hide">roads: hide clash</option>
          <option value="shift">roads: shift</option>
        </select>
        <label className="maputnik-paper-tools__check">
          <input
            type="checkbox"
            checked={previewEnabled}
            disabled={!mapReady}
            onChange={event => setPreviewEnabled(event.target.checked)}
          />
          <span>Preview</span>
        </label>
      </div>

      <div className="maputnik-paper-tools__group maputnik-paper-tools__export">
        <input
          className={`maputnik-paper-tools__map-id${mapIdInUse ? " is-used" : ""}`}
          type="number"
          min="1"
          max="999999999"
          step="1"
          placeholder="Map ID"
          aria-label="Map ID"
          value={mapType}
          onChange={event => {
            setMapType(event.target.value);
            if (exportKind === "error" || exportKind === "ok") {
              setExportKind("idle");
              setExportStatus("");
            }
          }}
        />
        <label
          className="maputnik-paper-tools__check"
          title="Print the MAP ID plate in the sheet's top-left corner, or at the foot of a side margin when one is open. Off leaves that spot blank -- the ID still names the stored map and still has to be typed in to digitize the scan."
        >
          <input
            type="checkbox"
            checked={showBadge}
            disabled={!mapReady}
            onChange={event => setShowBadge(event.target.checked)}
          />
          <span>Map ID</span>
        </label>
        <button
          className="maputnik-paper-tools__pdf"
          type="button"
          disabled={!mapReady || exporting !== ""}
          onClick={() => void exportSheets("pdf")}
        >
          <MdPictureAsPdf />
          <span>{exporting === "pdf" ? "Working…" : "Export PDF"}</span>
        </button>
        <button
          className="maputnik-paper-tools__pdf maputnik-paper-tools__doc"
          type="button"
          disabled={!mapReady || exporting !== ""}
          title="Save the same sheet as a Word document. The map and its tags are one picture; the margin notes stay editable text."
          onClick={() => void exportSheets("docx")}
        >
          <MdDescription />
          <span>{exporting === "docx" ? "Working…" : "Export DOC"}</span>
        </button>
        <span
          className={`maputnik-paper-tools__message is-${exportKind}`}
          role="status"
          title={exportStatus}
        >
          {exportStatus}
        </span>
      </div>
    </div>

    {previewEnabled && layout && baseLayout && viewport && viewport.width > 0 && viewport.height > 0
      ? <>
        <PaperPreview layout={layout} viewport={viewport} showBadge={showBadge} />
        <PaperMargins
          base={baseLayout}
          layout={layout}
          viewport={viewport}
          panels={panels}
          pageSize={pageSize}
          showBadge={showBadge}
          onUpdate={updatePanel}
          onAdd={addPanel}
          onRemove={removePanel}
        />
      </>
      : null}
  </>;
}
