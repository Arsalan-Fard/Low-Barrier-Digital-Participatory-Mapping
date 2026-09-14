/**
 * Random sub-sample of one POI bucket layer.
 *
 * A "Detailed" or "Everything" bucket over a dense arrondissement puts far
 * more icons on the sheet than a participant can read. Rather than hand-pick,
 * the facilitator asks for 5, 10 or 15 of whatever is in view right now and
 * the layer keeps only those.
 *
 * The pick is written into the layer's own filter as a trailing
 * `["in", ["id"], ["literal", [...]]]` clause, so it is part of the style:
 * it survives a reload, and the frozen snapshot and the print renderer --
 * which both build from the style -- show exactly the icons the screen does.
 * The clause is the last element of the layer's `all` filter and nothing
 * else in the buckets tests `["id"]`, so it can be found and stripped again
 * without keeping a copy of the base filter anywhere.
 */
import type {
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
  Map,
  SymbolLayerSpecification,
} from "maplibre-gl";

export const SAMPLE_METADATA_KEY = "paper:poi-sample";
export const SAMPLE_SIZES = [5, 10, 15] as const;

type FeatureId = string | number;

function isIdClause(value: unknown): value is ExpressionSpecification {
  return Array.isArray(value)
    && value[0] === "in"
    && Array.isArray(value[1])
    && value[1].length === 1
    && value[1][0] === "id";
}

/** The layer's filter with any sample clause of ours removed. */
export function baseFilter(layer: LayerSpecification): FilterSpecification | undefined {
  const filter = (layer as SymbolLayerSpecification).filter as unknown;
  if (!Array.isArray(filter)) return filter as FilterSpecification | undefined;
  if (filter[0] === "all" && isIdClause(filter[filter.length - 1])) {
    const rest = filter.slice(1, -1);
    if (rest.length === 0) return undefined;
    if (rest.length === 1) return rest[0] as FilterSpecification;
    return ["all", ...rest] as FilterSpecification;
  }
  return filter as FilterSpecification;
}

/** Active sample size, or null when the layer shows everything. */
export function sampleSize(layer: LayerSpecification): number | null {
  const metadata = layer.metadata as Record<string, unknown> | undefined;
  const size = metadata?.[SAMPLE_METADATA_KEY];
  return typeof size === "number" && size > 0 ? size : null;
}

function withSampleClause(base: FilterSpecification | undefined, ids: FeatureId[]): FilterSpecification {
  const clause: ExpressionSpecification = ["in", ["id"], ["literal", ids]];
  if (base === undefined) return clause;
  if (Array.isArray(base) && base[0] === "all") {
    return [...(base as unknown[]), clause] as FilterSpecification;
  }
  return ["all", base, clause] as FilterSpecification;
}

/**
 * Every feature the bucket would show inside the current viewport, one per
 * id. querySourceFeatures answers from loaded tiles rather than the screen,
 * and repeats a feature on every tile that carries it, so both the bounds
 * test and the de-duplication are done here.
 */
export function featureIdsInView(map: Map, layer: SymbolLayerSpecification): FeatureId[] {
  const sourceLayer = layer["source-layer"];
  if (!layer.source) return [];
  const bounds = map.getBounds();
  const filter = baseFilter(layer);
  let features;
  try {
    features = map.querySourceFeatures(layer.source, {
      ...(sourceLayer ? {sourceLayer} : {}),
      ...(filter ? {filter} : {}),
    });
  } catch (_error) {
    return [];
  }
  const ids = new Set<FeatureId>();
  for (const feature of features) {
    if (feature.id === undefined || feature.id === null) continue;
    if (feature.geometry.type !== "Point") continue;
    const [lng, lat] = feature.geometry.coordinates;
    if (!bounds.contains([lng, lat])) continue;
    ids.add(feature.id as FeatureId);
  }
  return [...ids];
}

function shuffled<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The layer with a fresh random pick of `size` features from the current
 * view, or with the pick cleared when `size` is null or nothing of the bucket
 * is in view. Always returns a new object; never mutates the input.
 */
export function sampledLayer(
  map: Map,
  layer: SymbolLayerSpecification,
  size: number | null,
): SymbolLayerSpecification {
  const metadata = {...(layer.metadata as Record<string, unknown> | undefined)};
  const base = baseFilter(layer);
  // Nothing of this bucket in view means nothing to keep: an empty pick would
  // blank the layer while the count lit up as though it had worked.
  const pool = size === null ? [] : featureIdsInView(map, layer);
  if (size === null || pool.length === 0) {
    delete metadata[SAMPLE_METADATA_KEY];
    const cleared: SymbolLayerSpecification = {...layer, metadata};
    if (base === undefined) delete (cleared as {filter?: unknown}).filter;
    else cleared.filter = base;
    return cleared;
  }
  const ids = shuffled(pool).slice(0, size);
  // Numeric ids sort numerically so the style diff stays readable.
  ids.sort((a, b) => (typeof a === "number" && typeof b === "number"
    ? a - b
    : String(a).localeCompare(String(b))));
  metadata[SAMPLE_METADATA_KEY] = size;
  return {...layer, metadata, filter: withSampleClause(base, ids)};
}
