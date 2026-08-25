import type {
  Map,
  MapGeoJSONFeature,
  SymbolLayerSpecification,
} from 'maplibre-gl'

/**
 * Nudge overlapping POI icons apart until they just touch.
 *
 * MapLibre's collision system only ever hides symbols; it never moves them,
 * and the POI buckets deliberately draw every icon (icon-allow-overlap), so
 * dense blocks stack icons on top of each other. This pass projects every
 * rendered POI icon to screen pixels, relaxes the overlaps pairwise, and
 * applies the result as data-driven icon-offset/text-offset expressions keyed
 * on feature id. Re-running is idempotent: offsets are computed from the
 * un-offset anchors, so a second pass reproduces the same expressions and the
 * change guard leaves the style alone.
 *
 * The category bucket layers and curated workshop POIs move; curated icons on
 * a tighter leash, because hand-picked places deserve the least distortion.
 * Curated labels live on their own variable-anchor layer, so their whole
 * anchor system shifts along via text-variable-anchor-offset. Transit markers
 * (bus, metro, air/rail) stay put -- infrastructure must stay geographically
 * true on a paper map -- but they still take part as immovable obstacles the
 * other icons shuffle around. Curated features get their ids from the
 * source's generateId; without it they degrade to immovable obstacles.
 */

const MOVABLE_METADATA_KEY = "paper:poi-category";
const CURATED_SOURCE = "curated-poi";

// Fallback when neither sprite has the image yet (sprites load late).
const DEFAULT_ICON_PX = 24;
// Breathing room between separated icons, matching the buckets' icon-padding.
const PAD_PX = 1;
const PASSES = 60;
// An icon may travel at most this many of its own diameters. Past that the
// map starts lying about where the place is; residual overlap is preferable.
const MAX_SHIFT_DIAMETERS = 1.25;
// Curated icons move just far enough to resolve a coincident pair; their
// variable-anchor labels keep pointing at the true location.
const CURATED_MAX_SHIFT_DIAMETERS = 0.5;
// Below this the offset is noise and not worth a re-layout.
const APPLY_THRESHOLD_PX = 0.3;
// A view this crowded cannot be decluttered meaningfully.
const MAX_NODES = 3000;

type Node = {
  layerId: string;
  featureId: string | number | undefined;
  x: number;
  y: number;
  r: number;
  movable: boolean;
  cap: number;
  dx: number;
  dy: number;
};

function symbolLayer(layer: unknown): SymbolLayerSpecification | null {
  const candidate = layer as SymbolLayerSpecification;
  return candidate?.type === "symbol" ? candidate : null;
}

function isCuratedIconLayer(layer: SymbolLayerSpecification) {
  return layer.source === CURATED_SOURCE && Boolean(layer.layout?.["icon-image"]);
}

function isMovableLayer(layer: SymbolLayerSpecification) {
  const metadata = layer.metadata as Record<string, unknown> | undefined;
  return Boolean(metadata?.[MOVABLE_METADATA_KEY]) || isCuratedIconLayer(layer);
}

function isObstacleLayer(layer: SymbolLayerSpecification) {
  if (!layer.layout?.["icon-image"]) return false;
  return layer["source-layer"] === "poi" && !isMovableLayer(layer);
}

function numericLayoutValue(map: Map, layerId: string, name: string, fallback: number) {
  try {
    const value = map.getLayoutProperty(layerId, name as never);
    return typeof value === "number" ? value : fallback;
  } catch (_error) {
    return fallback;
  }
}

function constantOffset(map: Map, layerId: string, name: string): [number, number] {
  try {
    let value = map.getLayoutProperty(layerId, name as never);
    // A previous pass may have installed our match expression; its fallback
    // branch carries the layer's true base offset.
    if (Array.isArray(value) && value[0] === "match") {
      const fallback = value[value.length - 1];
      if (Array.isArray(fallback) && fallback[0] === "literal") value = fallback[1];
    }
    if (Array.isArray(value) && value.length === 2
      && typeof value[0] === "number" && typeof value[1] === "number") {
      return [value[0], value[1]];
    }
  } catch (_error) {
    // fall through
  }
  return [0, 0];
}

/** The sprite names a feature's icon may resolve to, most specific first. */
function iconImageCandidates(
  layer: SymbolLayerSpecification,
  feature: MapGeoJSONFeature,
): string[] {
  const image = layer.layout?.["icon-image"];
  // Literal images (bus, the runtime metro marker) name themselves.
  if (typeof image === "string") return [image];
  if (layer.source === CURATED_SOURCE) {
    return [`curated:${String(feature.properties?.icon || "civic")}`];
  }
  // The buckets' coalesce(curated:X, X) with X = subclass override or class.
  const subclass = String(feature.properties?.subclass || "");
  const name = subclass === "florist" || subclass === "furniture"
    ? subclass
    : String(feature.properties?.class || "");
  return name ? [`curated:${name}`, name] : [];
}

function displayedIconPx(map: Map, layer: SymbolLayerSpecification, feature: MapGeoJSONFeature) {
  const iconSize = numericLayoutValue(map, layer.id, "icon-size", 1);
  for (const id of iconImageCandidates(layer, feature)) {
    try {
      const image = map.getImage(id);
      if (image?.data?.width) {
        return (image.data.width / (image.pixelRatio || 1)) * iconSize;
      }
    } catch (_error) {
      // sprite not loaded yet; keep trying
    }
  }
  return DEFAULT_ICON_PX * iconSize;
}

/** Deterministic push direction for exactly coincident points. */
function separationAngle(node: Node) {
  const seed = typeof node.featureId === "number"
    ? node.featureId
    : String(node.featureId ?? node.layerId).split("")
      .reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return (seed * 0.61803398875) % 1 * 2 * Math.PI;
}

function collectNodes(map: Map, layers: SymbolLayerSpecification[]): Node[] | null {
  const queryable = layers.filter(layer => {
    try {
      return Boolean(map.getLayer(layer.id));
    } catch (_error) {
      return false;
    }
  });
  if (!queryable.length) return null;

  let features: MapGeoJSONFeature[];
  try {
    features = map.queryRenderedFeatures({layers: queryable.map(layer => layer.id)});
  } catch (_error) {
    return null;
  }

  const byId = new globalThis.Map(queryable.map(layer => [layer.id, layer]));
  const nodes: Node[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    if (feature.geometry.type !== "Point") continue;
    const layer = byId.get(feature.layer.id);
    if (!layer) continue;
    const [lng, lat] = feature.geometry.coordinates;
    // Tiles repeat features at their borders; one node per symbol.
    const key = `${feature.layer.id}\n${feature.id ?? `${lng},${lat}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const point = map.project([lng, lat]);
    const r = displayedIconPx(map, layer, feature) / 2 + PAD_PX;
    const shiftDiameters = isCuratedIconLayer(layer)
      ? CURATED_MAX_SHIFT_DIAMETERS
      : MAX_SHIFT_DIAMETERS;
    nodes.push({
      layerId: layer.id,
      featureId: feature.id,
      x: point.x,
      y: point.y,
      r,
      // A feature without an id cannot be addressed by the offset expression.
      movable: isMovableLayer(layer) && feature.id !== undefined,
      cap: shiftDiameters * 2 * r,
      dx: 0,
      dy: 0,
    });
  }
  return nodes.length > 1 && nodes.length <= MAX_NODES ? nodes : null;
}

function relax(nodes: Node[]) {
  const cell = Math.max(8, ...nodes.map(node => node.r * 2));
  for (let pass = 0; pass < PASSES; pass++) {
    const grid = new globalThis.Map<string, number[]>();
    nodes.forEach((node, index) => {
      const key = `${Math.floor((node.x + node.dx) / cell)}:${Math.floor((node.y + node.dy) / cell)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(index); else grid.set(key, [index]);
    });

    let maxMove = 0;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const ax = a.x + a.dx;
      const ay = a.y + a.dy;
      const cx = Math.floor(ax / cell);
      const cy = Math.floor(ay / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          for (const j of grid.get(`${gx}:${gy}`) || []) {
            if (j <= i) continue;
            const b = nodes[j];
            if (!a.movable && !b.movable) continue;
            const minDist = a.r + b.r;
            let ux = (b.x + b.dx) - ax;
            let uy = (b.y + b.dy) - ay;
            const dist = Math.hypot(ux, uy);
            if (dist >= minDist) continue;
            if (dist < 1e-6) {
              const angle = separationAngle(a.movable ? a : b);
              ux = Math.cos(angle);
              uy = Math.sin(angle);
            } else {
              ux /= dist;
              uy /= dist;
            }
            const overlap = minDist - dist;
            const shareA = a.movable ? (b.movable ? 0.5 : 1) : 0;
            const shareB = b.movable ? 1 - shareA : 0;
            a.dx -= ux * overlap * shareA;
            a.dy -= uy * overlap * shareA;
            b.dx += ux * overlap * shareB;
            b.dy += uy * overlap * shareB;
            maxMove = Math.max(maxMove, overlap);
          }
        }
      }
    }

    for (const node of nodes) {
      if (!node.movable) continue;
      const length = Math.hypot(node.dx, node.dy);
      if (length > node.cap) {
        node.dx *= node.cap / length;
        node.dy *= node.cap / length;
      }
    }
    if (maxMove < 0.02) break;
  }
}

function offsetExpression(
  pairs: [string | number, [number, number]][],
  base: [number, number],
) {
  if (!pairs.length) return base;
  const expression: unknown[] = ["match", ["id"]];
  for (const [id, offset] of pairs) {
    expression.push(id, ["literal", offset]);
  }
  expression.push(["literal", base]);
  return expression;
}

function setIfChanged(map: Map, layerId: string, name: string, value: unknown) {
  try {
    const current = map.getLayoutProperty(layerId, name as never);
    // Writing a spec default onto a layer that never set the property would
    // force a pointless re-layout of every bucket on the first run.
    if (current === undefined && !Array.isArray(value)) return false;
    if (current === undefined && Array.isArray(value) && value[0] !== "match") return false;
    if (JSON.stringify(current ?? null) === JSON.stringify(value)) return false;
    map.setLayoutProperty(layerId, name as never, value);
    return true;
  } catch (_error) {
    return false;
  }
}

const round = (value: number) => Math.round(value * 100) / 100;

/** MapLibre's text-radial-offset geometry in em space. The renderer's ±7px
 *  baseline shift is applied identically on the radial and the
 *  anchor-offset code paths, so it cancels and does not appear here. */
function radialAnchorOffsetEm(anchor: string, radial: number): [number, number] {
  const diagonal = radial / Math.SQRT2;
  switch (anchor) {
  case "top": return [0, radial];
  case "bottom": return [0, -radial];
  case "left": return [radial, 0];
  case "right": return [-radial, 0];
  case "top-left": return [diagonal, diagonal];
  case "top-right": return [-diagonal, diagonal];
  case "bottom-left": return [diagonal, -diagonal];
  case "bottom-right": return [-diagonal, -diagonal];
  default: return [0, 0];
  }
}

function shiftedAnchorCollection(
  anchors: string[], radial: number, dx: number, dy: number,
): (string | [number, number])[] {
  const collection: (string | [number, number])[] = [];
  for (const anchor of anchors) {
    const [x, y] = radialAnchorOffsetEm(anchor, radial);
    collection.push(anchor, [round(x + dx), round(y + dy)]);
  }
  return collection;
}

/** Shift a curated label's whole variable-anchor system by its icon's
 *  displacement. text-variable-anchor-offset takes priority over the layer's
 *  untouched text-variable-anchor, and removing it restores the original
 *  behaviour, so undisplaced views stay byte-identical to the style. */
function applyCuratedLabelOffsets(
  map: Map,
  layer: SymbolLayerSpecification,
  displacedById: globalThis.Map<string | number, [number, number]>,
) {
  let anchors: unknown;
  try {
    anchors = map.getLayoutProperty(layer.id, "text-variable-anchor" as never);
  } catch (_error) {
    return false;
  }
  if (!Array.isArray(anchors) || !anchors.length) return false;
  const radial = numericLayoutValue(map, layer.id, "text-radial-offset", 0);
  const textSize = numericLayoutValue(map, layer.id, "text-size", 16) || 16;

  const pairs = [...displacedById.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  let value: unknown;
  if (pairs.length) {
    const expression: unknown[] = ["match", ["id"]];
    for (const [id, [dx, dy]] of pairs) {
      expression.push(id, ["literal", shiftedAnchorCollection(
        anchors as string[], radial, dx / textSize, dy / textSize)]);
    }
    expression.push(["literal", shiftedAnchorCollection(anchors as string[], radial, 0, 0)]);
    value = expression;
  }
  try {
    const current = map.getLayoutProperty(layer.id, "text-variable-anchor-offset" as never);
    if (current === undefined && value === undefined) return false;
    if (JSON.stringify(current ?? null) === JSON.stringify(value ?? null)) return false;
    map.setLayoutProperty(layer.id, "text-variable-anchor-offset" as never, value);
    return true;
  } catch (_error) {
    return false;
  }
}

/** One declutter pass. Returns true when layout properties changed, in which
 *  case the caller should wait for the next idle before capturing. */
export function declutterPoiIcons(map: Map) {
  if (!map.isStyleLoaded()) return false;
  let allLayers: unknown[];
  try {
    allLayers = map.getStyle().layers || [];
  } catch (_error) {
    return false;
  }
  const symbols = allLayers
    .map(symbolLayer)
    .filter((layer): layer is SymbolLayerSpecification => layer !== null);
  const movableLayers = symbols.filter(isMovableLayer);
  const obstacleLayers = symbols.filter(isObstacleLayer);
  if (!movableLayers.length) return false;

  const nodes = collectNodes(map, [...movableLayers, ...obstacleLayers]);
  let changed = false;
  const displaced = new globalThis.Map<string, [string | number, [number, number]][]>();
  if (nodes) {
    relax(nodes);
    for (const node of nodes) {
      if (!node.movable || node.featureId === undefined) continue;
      if (Math.hypot(node.dx, node.dy) < APPLY_THRESHOLD_PX) continue;
      const list = displaced.get(node.layerId) || [];
      list.push([node.featureId, [node.dx, node.dy]]);
      displaced.set(node.layerId, list);
    }
  }

  // Every movable layer gets written -- an empty result must also clear the
  // expressions a previous view left behind, or stale offsets stick around.
  for (const layer of movableLayers) {
    if (!map.getLayer(layer.id)) continue;
    const pairs = (displaced.get(layer.id) || [])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const iconSize = numericLayoutValue(map, layer.id, "icon-size", 1) || 1;
    const textSize = numericLayoutValue(map, layer.id, "text-size", 12) || 12;
    const iconBase = constantOffset(map, layer.id, "icon-offset");
    const textBase = constantOffset(map, layer.id, "text-offset");

    // icon-offset is measured in icon-size units, text-offset in ems; both
    // therefore stay correct when styleForPrint scales the style for paper.
    const iconPairs = pairs.map(([id, [dx, dy]]): [string | number, [number, number]] => (
      [id, [round(iconBase[0] + dx / iconSize), round(iconBase[1] + dy / iconSize)]]
    ));
    changed = setIfChanged(map, layer.id, "icon-offset",
      offsetExpression(iconPairs, iconBase)) || changed;
    // Curated icons carry no text of their own; their separate label layer is
    // handled below via applyCuratedLabelOffsets.
    if (layer.layout?.["text-field"]) {
      const textPairs = pairs.map(([id, [dx, dy]]): [string | number, [number, number]] => (
        [id, [round(textBase[0] + dx / textSize), round(textBase[1] + dy / textSize)]]
      ));
      changed = setIfChanged(map, layer.id, "text-offset",
        offsetExpression(textPairs, textBase)) || changed;
    }
  }

  // The curated labels live on their own layer; move each label's anchor
  // system with its icon so the pair stays visually attached.
  const curatedDisplaced = new globalThis.Map<string | number, [number, number]>();
  for (const layer of movableLayers) {
    if (!isCuratedIconLayer(layer)) continue;
    for (const [id, shift] of displaced.get(layer.id) || []) {
      curatedDisplaced.set(id, shift);
    }
  }
  for (const layer of symbols) {
    if (layer.source !== CURATED_SOURCE) continue;
    if (layer.layout?.["icon-image"] || !layer.layout?.["text-field"]) continue;
    if (!map.getLayer(layer.id)) continue;
    changed = applyCuratedLabelOffsets(map, layer, curatedDisplaced) || changed;
  }
  return changed;
}

/** Keep the live map decluttered: recompute after every settle. Applying the
 *  offsets triggers another idle, where the identical result hits the change
 *  guard and the loop stops. */
export function installPoiDeclutter(map: Map) {
  let timer = 0;
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => declutterPoiIcons(map), 80);
  };
  map.on("style.load", schedule);
  map.on("idle", schedule);
  map.on("moveend", schedule);
  schedule();
  return () => {
    window.clearTimeout(timer);
    map.off("style.load", schedule);
    map.off("idle", schedule);
    map.off("moveend", schedule);
  };
}
