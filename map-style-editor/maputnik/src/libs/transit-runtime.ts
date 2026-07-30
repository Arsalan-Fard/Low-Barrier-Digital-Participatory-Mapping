import type {
  FilterSpecification,
  GeoJSONFeature,
  Map,
  MapStyleImageMissingEvent,
  SymbolLayerSpecification,
} from 'maplibre-gl'

export const BUS_LAYER_ID = "transit_bus";
export const DETAIL_METADATA_KEY = "paper:transport-detail";
export const METRO_MARKER_IMAGE_ID = "paper-metro-marker";

const BUS_PAIR_DISTANCE_METRES = 180;

function pointGeometryFilter(): FilterSpecification {
  return [
    "match",
    ["geometry-type"],
    ["MultiPoint", "Point"],
    true,
    false,
  ];
}

export function busFilter(detail: number): FilterSpecification {
  const filters: unknown[] = [
    pointGeometryFilter(),
    [
      "all",
      ["==", ["get", "class"], "bus"],
      ["==", ["get", "subclass"], "bus_stop"],
    ],
  ];
  const ceilings = [0, 1, 3, 6];
  if (detail < 4) {
    filters.push(["<=", ["get", "rank"], ceilings[detail]]);
  }
  return ["all", ...filters] as FilterSpecification;
}

function createMetroMarker() {
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");

  context.clearRect(0, 0, size, size);
  context.fillStyle = "#ffffff";
  context.fillRect(3, 3, size - 6, size - 6);
  context.lineWidth = 4;
  context.strokeStyle = "#1769aa";
  context.strokeRect(3, 3, size - 6, size - 6);
  context.fillStyle = "#1769aa";
  context.font = "700 29px Arial, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("M", size / 2, size / 2 + 1);
  return context.getImageData(0, 0, size, size);
}

function addMetroMarker(map: Map) {
  try {
    if (!map.hasImage(METRO_MARKER_IMAGE_ID)) {
      map.addImage(METRO_MARKER_IMAGE_ID, createMetroMarker(), {pixelRatio: 2});
    }
  } catch (_error) {
    // The style may be between unload and load; styleimagemissing retries it.
  }
}

function keepBusIconsVisible(map: Map) {
  if (!map.getLayer(BUS_LAYER_ID)) return;
  try {
    map.setLayerZoomRange(BUS_LAYER_ID, 0, 24);
    if (map.getLayoutProperty(BUS_LAYER_ID, "icon-allow-overlap") !== true) {
      map.setLayoutProperty(BUS_LAYER_ID, "icon-allow-overlap", true);
    }
  } catch (_error) {
    // The style may be between unload and load; style.load retries it.
  }
}

function normalizedStopName(feature: GeoJSONFeature) {
  const name = String(feature.properties?.name_en || feature.properties?.name || "");
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, " ");
}

function pointCoordinates(feature: GeoJSONFeature): [number, number] | null {
  if (feature.geometry.type !== "Point") return null;
  const coordinates = feature.geometry.coordinates;
  return [coordinates[0], coordinates[1]];
}

function distanceMetres(a: [number, number], b: [number, number]) {
  const latitude = (a[1] + b[1]) * Math.PI / 360;
  const x = (a[0] - b[0]) * 111320 * Math.cos(latitude);
  const y = (a[1] - b[1]) * 110540;
  return Math.hypot(x, y);
}

function featureRank(feature: GeoJSONFeature) {
  const rank = Number(feature.properties?.rank);
  return Number.isFinite(rank) ? rank : Number.MAX_SAFE_INTEGER;
}

export function dedupeBusStops(map: Map) {
  if (!map.isStyleLoaded() || !map.getLayer(BUS_LAYER_ID)) return false;
  const layer = map.getStyle().layers.find(candidate => (
    candidate.id === BUS_LAYER_ID && candidate.type === "symbol"
  )) as SymbolLayerSpecification | undefined;
  if (!layer || typeof layer.source !== "string") return false;

  const metadata = layer.metadata as Record<string, unknown> | undefined;
  const detail = Number(metadata?.[DETAIL_METADATA_KEY]) || 2;
  const baseFilter = busFilter(detail);
  let features: GeoJSONFeature[];
  try {
    features = map.querySourceFeatures(layer.source, {
      sourceLayer: layer["source-layer"] || "poi",
      filter: baseFilter,
    });
  } catch (_error) {
    return false;
  }
  if (!features.length || features.some(feature => feature.id === undefined)) {
    return false;
  }

  const keptIds: (string | number)[] = [];
  const seenIds = new Set<string>();
  const keptByName = new globalThis.Map<string, [number, number][]>();
  const ordered = [...features].sort((a, b) => (
    featureRank(a) - featureRank(b) ||
    String(a.id).localeCompare(String(b.id))
  ));

  for (const feature of ordered) {
    const idKey = String(feature.id);
    if (seenIds.has(idKey)) continue;
    seenIds.add(idKey);

    const name = normalizedStopName(feature);
    const coordinates = pointCoordinates(feature);
    const sameNameLocations = name ? keptByName.get(name) || [] : [];
    const isPairedStop = coordinates && sameNameLocations.some(location => (
      distanceMetres(coordinates, location) <= BUS_PAIR_DISTANCE_METRES
    ));
    if (isPairedStop) continue;

    keptIds.push(feature.id!);
    if (name && coordinates) {
      sameNameLocations.push(coordinates);
      keptByName.set(name, sameNameLocations);
    }
  }

  const nextFilter = [
    "all",
    baseFilter,
    ["match", ["id"], keptIds, true, false],
  ] as FilterSpecification;
  if (JSON.stringify(map.getFilter(BUS_LAYER_ID)) === JSON.stringify(nextFilter)) {
    return false;
  }
  map.setFilter(BUS_LAYER_ID, nextFilter);
  return true;
}

export function installTransitRuntime(map: Map) {
  let timer = 0;
  const scheduleBusDeduplication = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => dedupeBusStops(map), 40);
  };
  const onImageMissing = (event: MapStyleImageMissingEvent) => {
    if (event.id === METRO_MARKER_IMAGE_ID) addMetroMarker(map);
  };
  const onStyleLoad = () => {
    addMetroMarker(map);
    keepBusIconsVisible(map);
    scheduleBusDeduplication();
  };

  map.on("styleimagemissing", onImageMissing);
  map.on("style.load", onStyleLoad);
  map.on("sourcedata", scheduleBusDeduplication);
  map.on("moveend", scheduleBusDeduplication);
  map.on("idle", scheduleBusDeduplication);
  addMetroMarker(map);
  keepBusIconsVisible(map);
  scheduleBusDeduplication();

  return () => {
    window.clearTimeout(timer);
    map.off("styleimagemissing", onImageMissing);
    map.off("style.load", onStyleLoad);
    map.off("sourcedata", scheduleBusDeduplication);
    map.off("moveend", scheduleBusDeduplication);
    map.off("idle", scheduleBusDeduplication);
  };
}
