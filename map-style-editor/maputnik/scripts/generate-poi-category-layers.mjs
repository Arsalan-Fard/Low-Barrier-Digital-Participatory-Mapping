import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");
const stylePath = path.join(projectDirectory, "public", "styles", "liberty.json");
const configPath = path.join(projectDirectory, "src", "config", "poi-categories.json");

const style = JSON.parse(fs.readFileSync(stylePath, "utf8"));
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const legacyIds = ["poi_r20", "poi_r7", "poi_r1", "poi_transit"];
const generatedIds = config.categories.flatMap(category => (
  config.rankLevels.map(level => `${category.id}_${level.id}`)
));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function categoryFilter(category) {
  if (category.id !== "other") {
    return ["match", ["get", "class"], category.classes, true, false];
  }
  const claimedClasses = [
    ...config.categories.flatMap(candidate => candidate.classes),
    ...config.transportClasses,
  ];
  return ["!", ["match", ["get", "class"], claimedClasses, true, false]];
}

function rankFilter(level) {
  const lower = [">=", ["get", "rank"], level.min];
  return level.max === undefined
    ? lower
    : ["all", lower, ["<", ["get", "rank"], level.max]];
}

function createCategoryLayers(baseLayer) {
  return config.categories.flatMap(category => (
    config.rankLevels.map(level => ({
      ...clone(baseLayer),
      id: `${category.id}_${level.id}`,
      metadata: {
        ...(clone(baseLayer.metadata || {})),
        "paper:poi-category": category.id,
        "paper:poi-category-label": category.label,
        "paper:poi-rank-level": level.id,
        "paper:poi-rank-label": level.label,
      },
      minzoom: 0,
      maxzoom: 24,
      filter: [
        "all",
        ["match", ["geometry-type"], ["MultiPoint", "Point"], true, false],
        categoryFilter(category),
        rankFilter(level),
      ],
      layout: {
        ...clone(baseLayer.layout || {}),
        "icon-allow-overlap": true,
        // Icons always draw but still reserve their space, so labels placed
        // later (street names sit below the POI layers) route around them.
        "icon-ignore-placement": false,
        "icon-padding": 2,
        "symbol-sort-key": ["coalesce", ["get", "rank"], 999],
        "text-optional": true,
        visibility: level.visible ? "visible" : "none",
      },
    }))
  ));
}

const hasLegacyLayers = legacyIds.every(id => style.layers.some(layer => layer.id === id));
const hasGeneratedLayers = (
  generatedIds.every(id => style.layers.some(layer => layer.id === id))
  && style.layers.some(layer => layer.id === "transit_air-rail")
);
if (!hasLegacyLayers && !hasGeneratedLayers) {
  throw new Error("The Liberty style does not contain a recognized POI layer set.");
}

const sourceIds = hasLegacyLayers
  ? legacyIds
  : [...generatedIds, "transit_air-rail"];
const baseLayer = style.layers.find(layer => (
  layer.id === (hasLegacyLayers ? "poi_r1" : generatedIds[0])
));
const legacyTransitLayer = style.layers.find(layer => (
  layer.id === (hasLegacyLayers ? "poi_transit" : "transit_air-rail")
));
const insertionIndex = Math.min(...sourceIds.map(
  id => style.layers.findIndex(layer => layer.id === id),
));
const removedIds = new Set([
  ...legacyIds,
  ...generatedIds,
  "transit_air-rail",
]);
style.layers = style.layers.filter(layer => !removedIds.has(layer.id));

const transitLayer = {
  ...clone(legacyTransitLayer),
  id: "transit_air-rail",
  minzoom: 0,
  maxzoom: 24,
  layout: {
    ...clone(legacyTransitLayer.layout || {}),
    "icon-allow-overlap": true,
    "icon-ignore-placement": false,
    "text-optional": true,
  },
};

style.layers.splice(
  insertionIndex,
  0,
  ...createCategoryLayers(baseLayer),
  transitLayer,
);

fs.writeFileSync(stylePath, `${JSON.stringify(style, null, 2)}\n`);
console.log("Generated independent POI category/rank layers in liberty.json.");
