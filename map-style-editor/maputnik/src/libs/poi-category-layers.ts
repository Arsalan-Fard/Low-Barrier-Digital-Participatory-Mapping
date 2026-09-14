import cloneDeep from 'lodash.clonedeep'
import type {
  FilterSpecification,
  StyleSpecification,
  SymbolLayerSpecification,
} from 'maplibre-gl'
import poiConfig from '../config/poi-categories.json'
import type {StyleSpecificationWithId} from './definitions'

const LEGACY_POI_LAYER_IDS = [
  "poi_r20",
  "poi_r7",
  "poi_r1",
  "poi_transit",
];

const TRANSIT_AIR_RAIL_LAYER_ID = "transit_air-rail";

function pointGeometryFilter(): FilterSpecification {
  return [
    "match",
    ["geometry-type"],
    ["MultiPoint", "Point"],
    true,
    false,
  ];
}

function categoryFilter(categoryId: string, classes: string[]): FilterSpecification {
  if (categoryId !== "other") {
    return [
      "match",
      ["get", "class"],
      classes,
      true,
      false,
    ] as FilterSpecification;
  }

  const claimedClasses = [
    ...poiConfig.categories.flatMap(category => category.classes),
    ...poiConfig.transportClasses,
  ];
  return [
    "!",
    [
      "match",
      ["get", "class"],
      claimedClasses,
      true,
      false,
    ],
  ] as FilterSpecification;
}

function rankFilter(min: number, max?: number): FilterSpecification {
  if (max === undefined) {
    return [">=", ["get", "rank"], min] as FilterSpecification;
  }
  return [
    "all",
    [">=", ["get", "rank"], min],
    ["<", ["get", "rank"], max],
  ] as FilterSpecification;
}

function createCategoryLayers(baseLayer: SymbolLayerSpecification) {
  return poiConfig.categories.flatMap(category => (
    poiConfig.rankLevels.map(rankLevel => ({
      ...cloneDeep(baseLayer),
      id: `${category.id}_${rankLevel.id}`,
      metadata: {
        ...(cloneDeep(baseLayer.metadata) as Record<string, unknown> | undefined),
        "paper:poi-category": category.id,
        "paper:poi-category-label": category.label,
        "paper:poi-rank-level": rankLevel.id,
        "paper:poi-rank-label": rankLevel.label,
      },
      minzoom: 0,
      maxzoom: 24,
      filter: [
        "all",
        pointGeometryFilter(),
        categoryFilter(category.id, category.classes),
        rankFilter(rankLevel.min, rankLevel.max),
      ] as FilterSpecification,
      layout: {
        ...cloneDeep(baseLayer.layout),
        "icon-allow-overlap": true,
        // Icons always draw but still reserve their space, so labels placed
        // later (street names sit below the POI layers) route around them.
        "icon-ignore-placement": false,
        "icon-padding": 2,
        "symbol-sort-key": ["coalesce", ["get", "rank"], 999],
        "text-optional": true,
        // A category can opt out of the rank default (health, education).
        visibility: rankLevel.visible && (category as {visible?: boolean}).visible !== false
          ? "visible"
          : "none",
      },
    } satisfies SymbolLayerSpecification))
  ));
}

function layerById(mapStyle: StyleSpecification, id: string) {
  const layer = mapStyle.layers.find(candidate => candidate.id === id);
  return layer?.type === "symbol" ? layer : undefined;
}

export function upgradePoiCategoryLayers(mapStyle: StyleSpecificationWithId) {
  if (!LEGACY_POI_LAYER_IDS.every(id => layerById(mapStyle, id))) {
    return false;
  }

  const baseLayer = layerById(mapStyle, "poi_r1");
  const legacyTransitLayer = layerById(mapStyle, "poi_transit");
  if (!baseLayer || !legacyTransitLayer || baseLayer["source-layer"] !== "poi") {
    return false;
  }

  const insertionIndex = Math.min(
    ...LEGACY_POI_LAYER_IDS.map(id => mapStyle.layers.findIndex(layer => layer.id === id)),
  );
  const removedIds = new Set([
    ...LEGACY_POI_LAYER_IDS,
    TRANSIT_AIR_RAIL_LAYER_ID,
  ]);
  mapStyle.layers = mapStyle.layers.filter(layer => !removedIds.has(layer.id));

  const transitLayer = {
    ...cloneDeep(legacyTransitLayer),
    id: TRANSIT_AIR_RAIL_LAYER_ID,
    minzoom: 0,
    maxzoom: 24,
    layout: {
      ...cloneDeep(legacyTransitLayer.layout),
      "icon-allow-overlap": true,
      "icon-ignore-placement": false,
      "text-optional": true,
    },
  } satisfies SymbolLayerSpecification;

  mapStyle.layers.splice(
    insertionIndex,
    0,
    ...createCategoryLayers(baseLayer),
    transitLayer,
  );
  return true;
}
