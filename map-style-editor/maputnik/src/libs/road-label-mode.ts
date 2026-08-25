import type {ExpressionSpecification, Map} from 'maplibre-gl'

/**
 * Road-name collision handling, selectable from the paper toolbar.
 *
 * The style ships with highway-name-minor bypassing collision entirely
 * (text-allow-overlap / text-ignore-placement / text-overlap: always), which
 * is what lets minor names lie across other streets and POIs. These modes
 * override that at runtime -- the style document itself stays untouched, and
 * "styled" restores it exactly.
 *
 *   styled  -- whatever the style says (minor names always draw).
 *   hide    -- all road names collide at the style's normal padding; at a
 *              contested spot the less important class loses and is hidden.
 *              A name is only dropped for an actual overlap, never for a
 *              near miss.
 *   shift   -- hide, plus denser candidate anchors along the line, so a
 *              blocked name usually reappears at the nearest free stretch
 *              of its road instead of disappearing.
 */
export type RoadLabelMode = "styled" | "hide" | "shift";

export const ROAD_LABEL_MODES: RoadLabelMode[] = ["styled", "hide", "shift"];

const ROAD_NAME_LAYERS = [
  "highway-name-major",
  "highway-name-minor",
  "highway-name-path",
];

// Lower sorts first and wins placement within a layer; ties fall to MapLibre.
const ROAD_CLASS_RANK: ExpressionSpecification = [
  "match", ["get", "class"],
  ["motorway", "trunk"], 0,
  "primary", 1,
  "secondary", 2,
  "tertiary", 3,
  ["minor", "street"], 4,
  ["service", "track"], 5,
  6,
];

const TUNED_PROPS = [
  "text-allow-overlap",
  "text-ignore-placement",
  "text-overlap",
  "text-padding",
  "symbol-sort-key",
  "symbol-spacing",
] as const;

type BaseState = Record<string, Partial<Record<(typeof TUNED_PROPS)[number], unknown>>>;

// Keyed per map instance so "styled" can restore the pristine values even
// after several mode switches. Cleared when the map loads a fresh style.
const baseByMap = new WeakMap<Map, BaseState>();

function readLayout(map: Map, layerId: string, name: string) {
  try {
    return map.getLayoutProperty(layerId, name as never);
  } catch (_error) {
    return undefined;
  }
}

function writeLayout(map: Map, layerId: string, name: string, value: unknown) {
  const current = readLayout(map, layerId, name);
  if (JSON.stringify(current ?? null) === JSON.stringify(value ?? null)) return false;
  try {
    map.setLayoutProperty(layerId, name as never, value);
    return true;
  } catch (_error) {
    return false;
  }
}

function baseFor(map: Map, layerId: string) {
  let state = baseByMap.get(map);
  if (!state) {
    state = {};
    baseByMap.set(map, state);
  }
  if (!state[layerId]) {
    const captured: BaseState[string] = {};
    for (const name of TUNED_PROPS) captured[name] = readLayout(map, layerId, name);
    state[layerId] = captured;
  }
  return state[layerId];
}

/** Apply a mode to every road-name layer. Returns true when anything changed
 *  (the caller should then wait for idle before capturing). */
export function applyRoadLabelMode(map: Map, mode: RoadLabelMode) {
  let changed = false;
  for (const layerId of ROAD_NAME_LAYERS) {
    try {
      if (!map.getLayer(layerId)) continue;
    } catch (_error) {
      continue;
    }
    const base = baseFor(map, layerId);
    if (mode === "styled") {
      for (const name of TUNED_PROPS) {
        changed = writeLayout(map, layerId, name, base[name]) || changed;
      }
      continue;
    }

    const baseSpacing = typeof base["symbol-spacing"] === "number" ? base["symbol-spacing"] : 250;
    changed = writeLayout(map, layerId, "text-allow-overlap", false) || changed;
    changed = writeLayout(map, layerId, "text-ignore-placement", false) || changed;
    changed = writeLayout(map, layerId, "text-overlap", "never") || changed;
    changed = writeLayout(map, layerId, "text-padding", base["text-padding"]) || changed;
    changed = writeLayout(map, layerId, "symbol-sort-key", ROAD_CLASS_RANK) || changed;
    changed = writeLayout(map, layerId, "symbol-spacing",
      mode === "shift" ? Math.max(80, Math.round(baseSpacing * 0.6)) : base["symbol-spacing"]) || changed;
  }
  return changed;
}

/** Keep a live map in the given mode. Maputnik pushes editor changes as
 *  style diffs that revert runtime overrides without firing style.load, so a
 *  debounced idle re-apply keeps the mode sticky; the change guards make it
 *  free when nothing drifted. */
export function installRoadLabelMode(map: Map, mode: RoadLabelMode) {
  let timer = 0;
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => applyRoadLabelMode(map, mode), 80);
  };
  const reset = () => {
    baseByMap.delete(map);
    schedule();
  };
  map.on("style.load", reset);
  map.on("idle", schedule);
  applyRoadLabelMode(map, mode);
  return () => {
    window.clearTimeout(timer);
    map.off("style.load", reset);
    map.off("idle", schedule);
  };
}
