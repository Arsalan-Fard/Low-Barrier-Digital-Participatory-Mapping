import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import cloneDeep from 'lodash.clonedeep'
import type {
  ExpressionSpecification,
  FilterSpecification,
  Map,
  StyleSpecification,
  SymbolLayerSpecification,
} from 'maplibre-gl'
import {
  MdClose,
  MdDirectionsBus,
  MdSubway,
} from 'react-icons/md'
import type {
  OnStyleChangedCallback,
  StyleSpecificationWithId,
} from '../libs/definitions'
import {
  BUS_LAYER_ID,
  busFilter,
  DETAIL_METADATA_KEY,
  installTransitRuntime,
  METRO_MARKER_IMAGE_ID,
} from '../libs/transit-runtime'
import {upgradePoiCategoryLayers} from '../libs/poi-category-layers'

type PublicTransportToolsProps = {
  map: Map | null
  mapStyle: StyleSpecification
  onStyleChanged: OnStyleChangedCallback
};

type PopoverPosition = {
  left: number
  top: number
};

const METRO_STATION_LAYER_ID = "transit_metro_station";
const METRO_ENTRANCE_LAYER_ID = "transit_metro_entrance";

const BUS_DETAIL_LABELS = [
  "",
  "Key stops",
  "Major stops",
  "Most stops",
  "All stops",
];

const METRO_DETAIL_LABELS = [
  "",
  "Key stations",
  "All stations",
  "Stations + entrances",
];

function layerById(mapStyle: StyleSpecification, id: string) {
  const layer = mapStyle.layers.find(candidate => candidate.id === id);
  return layer?.type === "symbol" ? layer : undefined;
}

function isVisible(layer: SymbolLayerSpecification | undefined) {
  return Boolean(layer && layer.layout?.visibility !== "none");
}

function detailFromLayer(layer: SymbolLayerSpecification | undefined, fallback: number) {
  const metadata = layer?.metadata as Record<string, unknown> | undefined;
  const detail = Number(metadata?.[DETAIL_METADATA_KEY]);
  return Number.isInteger(detail) ? detail : fallback;
}

function pointGeometryFilter(): FilterSpecification {
  return [
    "match",
    ["geometry-type"],
    ["MultiPoint", "Point"],
    true,
    false,
  ];
}

function metroStationFilter(detail: number): FilterSpecification {
  const filters: unknown[] = [
    pointGeometryFilter(),
    [
      "all",
      ["==", ["get", "class"], "railway"],
      ["==", ["get", "subclass"], "subway"],
    ],
  ];
  if (detail === 1) {
    filters.push(["<=", ["get", "rank"], 1]);
  }
  return ["all", ...filters] as FilterSpecification;
}

function metroEntranceFilter(): FilterSpecification {
  return [
    "all",
    pointGeometryFilter(),
    [
      "all",
      ["==", ["get", "class"], "entrance"],
      ["==", ["get", "subclass"], "subway_entrance"],
    ],
  ] as FilterSpecification;
}

function transitExclusionFilter(): FilterSpecification {
  return [
    "!",
    [
      "any",
      [
        "all",
        ["==", ["get", "class"], "bus"],
        ["==", ["get", "subclass"], "bus_stop"],
      ],
      [
        "all",
        ["==", ["get", "class"], "railway"],
        ["==", ["get", "subclass"], "subway"],
      ],
      [
        "all",
        ["==", ["get", "class"], "entrance"],
        ["==", ["get", "subclass"], "subway_entrance"],
      ],
    ],
  ] as FilterSpecification;
}

function transportNameField(): ExpressionSpecification {
  return [
    "coalesce",
    ["get", "name_en"],
    ["get", "name"],
  ];
}

function createBusLayer(source: string): SymbolLayerSpecification {
  return {
    id: BUS_LAYER_ID,
    type: "symbol",
    metadata: {
      "paper:transport-kind": "bus",
      [DETAIL_METADATA_KEY]: 2,
    },
    source,
    "source-layer": "poi",
    minzoom: 0,
    maxzoom: 24,
    filter: busFilter(2),
    layout: {
      "icon-allow-overlap": true,
      "icon-image": "bus",
      "icon-ignore-placement": true,
      "icon-padding": 4,
      "icon-size": 0.62,
      "symbol-sort-key": ["coalesce", ["get", "rank"], 999],
      "text-anchor": "top",
      "text-field": transportNameField(),
      "text-font": ["Noto Sans Italic"],
      "text-max-width": 8,
      "text-offset": [0, 0.75],
      "text-optional": true,
      "text-size": 10,
    },
    paint: {
      "text-color": "#334f91",
      "text-halo-blur": 0.5,
      "text-halo-color": "#ffffff",
      "text-halo-width": 1,
    },
  };
}

function createMetroEntranceLayer(source: string): SymbolLayerSpecification {
  return {
    id: METRO_ENTRANCE_LAYER_ID,
    type: "symbol",
    metadata: {
      "paper:transport-kind": "metro-entrance",
    },
    source,
    "source-layer": "poi",
    filter: metroEntranceFilter(),
    layout: {
      "icon-allow-overlap": true,
      "icon-image": METRO_MARKER_IMAGE_ID,
      "icon-size": 0.5,
      visibility: "none",
    },
  };
}

function createMetroStationLayer(source: string): SymbolLayerSpecification {
  return {
    id: METRO_STATION_LAYER_ID,
    type: "symbol",
    metadata: {
      "paper:transport-kind": "metro",
      [DETAIL_METADATA_KEY]: 2,
    },
    source,
    "source-layer": "poi",
    filter: metroStationFilter(2),
    layout: {
      "icon-allow-overlap": true,
      "icon-image": METRO_MARKER_IMAGE_ID,
      "icon-size": 1,
      "text-anchor": "left",
      "text-field": transportNameField(),
      "text-font": ["Noto Sans Italic"],
      "text-max-width": 8,
      "text-offset": [0.85, 0],
      "text-optional": true,
      "text-size": 11,
    },
    paint: {
      "text-color": "#8d2535",
      "text-halo-blur": 0.5,
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.2,
    },
  };
}

function compatiblePoiSource(mapStyle: StyleSpecification) {
  const poiLayer = mapStyle.layers.find(layer => (
    layer.type === "symbol"
    && layer["source-layer"] === "poi"
    && typeof layer.source === "string"
  )) as SymbolLayerSpecification | undefined;
  if (!poiLayer || typeof poiLayer.source !== "string") return null;
  const source = mapStyle.sources[poiLayer.source];
  return source?.type === "vector" ? poiLayer.source : null;
}

function upgradeTransportLayers(mapStyle: StyleSpecificationWithId) {
  if (
    layerById(mapStyle, BUS_LAYER_ID)
    && layerById(mapStyle, METRO_STATION_LAYER_ID)
    && layerById(mapStyle, METRO_ENTRANCE_LAYER_ID)
  ) {
    return false;
  }

  const source = compatiblePoiSource(mapStyle);
  if (!source) return false;

  const newLayerIds = new Set([
    BUS_LAYER_ID,
    METRO_STATION_LAYER_ID,
    METRO_ENTRANCE_LAYER_ID,
  ]);
  mapStyle.layers = mapStyle.layers.filter(layer => !newLayerIds.has(layer.id));

  for (const layerId of ["poi_r1", "poi_r7", "poi_r20"]) {
    const layer = layerById(mapStyle, layerId);
    if (!layer?.filter) continue;
    if (!JSON.stringify(layer.filter).includes("subway_entrance")) {
      layer.filter = [
        "all",
        layer.filter,
        transitExclusionFilter(),
      ] as FilterSpecification;
    }
  }

  const originalTransit = (
    layerById(mapStyle, "transit_air-rail")
    || layerById(mapStyle, "poi_transit")
  );
  if (originalTransit) {
    originalTransit.filter = [
      "match",
      ["get", "class"],
      ["airport", "rail"],
      true,
      false,
    ];
  }

  const insertionIndex = Math.max(
    0,
    mapStyle.layers.reduce((lastPoiIndex, layer, index) => (
      layer.type === "symbol" && layer["source-layer"] === "poi"
        ? index
        : lastPoiIndex
    ), -1) + 1,
  );
  mapStyle.layers.splice(
    insertionIndex,
    0,
    createBusLayer(source),
    createMetroEntranceLayer(source),
    createMetroStationLayer(source),
  );
  return true;
}

function setVisibility(layer: SymbolLayerSpecification, visible: boolean) {
  layer.layout = {
    ...layer.layout,
    visibility: visible ? "visible" : "none",
  };
}

export default function PublicTransportTools(props: PublicTransportToolsProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition>({left: 8, top: 44});
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const nextStyle = cloneDeep(props.mapStyle) as StyleSpecificationWithId;
    const poiChanged = upgradePoiCategoryLayers(nextStyle);
    if (poiChanged) {
      props.onStyleChanged(nextStyle);
    }
  }, [props.mapStyle, props.onStyleChanged]);

  useEffect(() => {
    if (!props.map) return;
    return installTransitRuntime(props.map);
  }, [props.map]);

  const busLayer = useMemo(
    () => layerById(props.mapStyle, BUS_LAYER_ID),
    [props.mapStyle],
  );
  const metroStationLayer = useMemo(
    () => layerById(props.mapStyle, METRO_STATION_LAYER_ID),
    [props.mapStyle],
  );
  const metroEntranceLayer = useMemo(
    () => layerById(props.mapStyle, METRO_ENTRANCE_LAYER_ID),
    [props.mapStyle],
  );

  const available = Boolean(busLayer && metroStationLayer && metroEntranceLayer);
  const upgradeAvailable = Boolean(compatiblePoiSource(props.mapStyle));
  const busEnabled = isVisible(busLayer);
  const metroEnabled = isVisible(metroStationLayer);
  const busDetail = detailFromLayer(busLayer, 2);
  const metroDetail = detailFromLayer(metroStationLayer, 2);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 300;
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: rect.bottom + 5,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target)
        && !popoverRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, updatePosition]);

  const changeStyle = useCallback((
    update: (
      bus: SymbolLayerSpecification,
      metroStation: SymbolLayerSpecification,
      metroEntrance: SymbolLayerSpecification,
    ) => void,
  ) => {
    const nextStyle = cloneDeep(props.mapStyle) as StyleSpecificationWithId;
    const nextBus = layerById(nextStyle, BUS_LAYER_ID);
    const nextMetroStation = layerById(nextStyle, METRO_STATION_LAYER_ID);
    const nextMetroEntrance = layerById(nextStyle, METRO_ENTRANCE_LAYER_ID);
    if (!nextBus || !nextMetroStation || !nextMetroEntrance) return;
    update(nextBus, nextMetroStation, nextMetroEntrance);
    props.onStyleChanged(nextStyle);
  }, [props.mapStyle, props.onStyleChanged]);

  const setBusEnabled = (enabled: boolean) => {
    changeStyle(bus => setVisibility(bus, enabled));
  };

  const setMetroEnabled = (enabled: boolean) => {
    changeStyle((_bus, station, entrance) => {
      setVisibility(station, enabled);
      setVisibility(entrance, enabled && metroDetail === 3);
    });
  };

  const setBusDetail = (detail: number) => {
    changeStyle(bus => {
      bus.filter = busFilter(detail);
      bus.metadata = {
        ...(bus.metadata as Record<string, unknown> | undefined),
        [DETAIL_METADATA_KEY]: detail,
      };
    });
  };

  const setMetroDetail = (detail: number) => {
    changeStyle((_bus, station, entrance) => {
      station.filter = metroStationFilter(detail);
      station.metadata = {
        ...(station.metadata as Record<string, unknown> | undefined),
        [DETAIL_METADATA_KEY]: detail,
      };
      setVisibility(entrance, metroEnabled && detail === 3);
    });
  };

  const popover = open ? <div
    ref={popoverRef}
    className="maputnik-transit-popover"
    role="dialog"
    aria-label="Public transport controls"
    style={position}
  >
    <div className="maputnik-transit-popover__header">
      <strong>Public transport</strong>
      <button
        type="button"
        aria-label="Close public transport controls"
        onClick={() => {
          setOpen(false);
          triggerRef.current?.focus();
        }}
      >
        <MdClose />
      </button>
    </div>

    {!available && <p className="maputnik-transit-popover__unavailable">
      {upgradeAvailable
        ? "Adding public transport layers\u2026"
        : "This style has no compatible OpenMapTiles POI layers."}
    </p>}

    {available && <>
      <section className="maputnik-transit-popover__mode">
        <div className="maputnik-transit-popover__mode-header">
          <MdSubway />
          <label>
            <input
              type="checkbox"
              checked={metroEnabled}
              onChange={event => setMetroEnabled(event.target.checked)}
            />
            <span>Metro</span>
          </label>
          <span>{METRO_DETAIL_LABELS[metroDetail]}</span>
        </div>
        <input
          type="range"
          min="1"
          max="3"
          step="1"
          value={metroDetail}
          disabled={!metroEnabled}
          aria-label="Metro detail"
          onChange={event => setMetroDetail(Number(event.target.value))}
        />
      </section>

      <section className="maputnik-transit-popover__mode">
        <div className="maputnik-transit-popover__mode-header">
          <MdDirectionsBus />
          <label>
            <input
              type="checkbox"
              checked={busEnabled}
              onChange={event => setBusEnabled(event.target.checked)}
            />
            <span>Bus stops</span>
          </label>
          <span>{BUS_DETAIL_LABELS[busDetail]}</span>
        </div>
        <input
          type="range"
          min="1"
          max="4"
          step="1"
          value={busDetail}
          disabled={!busEnabled}
          aria-label="Bus stop detail"
          onChange={event => setBusDetail(Number(event.target.value))}
        />
      </section>

      <p className="maputnik-transit-popover__hint">
        Icons stay visible; labels still avoid collisions.
      </p>
    </>}
  </div> : null;

  return <>
    <button
      ref={triggerRef}
      type="button"
      className={`maputnik-transit-trigger${open ? " is-open" : ""}`}
      aria-label="Public transport"
      aria-expanded={open}
      aria-haspopup="dialog"
      title="Public transport"
      onClick={() => {
        updatePosition();
        const nextOpen = !open;
        if (nextOpen && !available) {
          const nextStyle = cloneDeep(props.mapStyle) as StyleSpecificationWithId;
          if (upgradeTransportLayers(nextStyle)) {
            props.onStyleChanged(nextStyle);
          }
        }
        setOpen(nextOpen);
      }}
    >
      <MdDirectionsBus />
    </button>
    {popover && createPortal(popover, document.body)}
  </>;
}
