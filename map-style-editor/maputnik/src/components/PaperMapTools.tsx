import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import cloneDeep from 'lodash.clonedeep'
import MapLibreGl, {
  GeoJSONSource,
  LngLatBounds,
  Map,
  StyleSpecification,
} from 'maplibre-gl'
import {
  MdDirectionsWalk,
  MdPictureAsPdf,
  MdStayCurrentLandscape,
} from 'react-icons/md'
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

type PaperMapToolsProps = {
  map: Map | null
  mapStyle: StyleSpecification
  pinpoints: MapPinpoint[]
  replaceAccessTokens(mapStyle: StyleSpecification): StyleSpecification
};

const REACH_SOURCE_ID = "paper-walk-reach";
const REACH_FILL_ID = "paper-walk-reach-fill";
const REACH_LINE_ID = "paper-walk-reach-line";

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
}: {
  layout: SheetLayout
  viewport: Viewport
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
      className="maputnik-paper-preview__frame"
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
    <rect
      className="maputnik-paper-preview__badge"
      x={box.x + badge[0] * box.scale}
      y={box.y + badge[1] * box.scale}
      width={badge[2] * box.scale}
      height={badge[3] * box.scale}
    />
    <text className="maputnik-paper-preview__caption" x={box.x + 6} y={captionY}>
      {layout.pageSize} landscape · export area
    </text>
  </svg>;
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
  const [participants, setParticipants] = useState("1");
  const [usedSheetIds, setUsedSheetIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const [exportKind, setExportKind] = useState<"idle" | "busy" | "ok" | "warn" | "error">("idle");
  const reachRequest = useRef(0);

  const layout = layouts ? layouts[pageSize] : null;

  const plannedSheetIds = useCallback(() => {
    const type = mapType.trim();
    if (!/^[1-9][0-9]{0,8}$/.test(type)) {
      throw new Error("Enter a map ID of 1 or higher.");
    }
    const count = participants.trim() === "" ? 1 : Number.parseInt(participants, 10);
    if (!Number.isFinite(count) || count < 1) {
      throw new Error("Copies must be 1 or more.");
    }
    if (count > 200) {
      throw new Error("The maximum is 200 copies.");
    }
    if (count === 1) return [type];
    return Array.from({length: count}, (_value, index) => `${type}_${index + 1}`);
  }, [mapType, participants]);

  const conflictingIds = useMemo(() => {
    try {
      return plannedSheetIds().filter(id => usedSheetIds.has(id));
    } catch (_error) {
      return [];
    }
  }, [plannedSheetIds, usedSheetIds]);

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

  const capturePrintableMap = useCallback(async () => {
    const map = props.map;
    if (!map || !layout) throw new Error("The map is not ready.");
    const container = map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) throw new Error("The map has no printable area.");

    const box = previewBox(layout, width, height);
    const frame = layout.mapFrame;
    const left = box.x + frame[0] * box.scale;
    const top = box.y + frame[1] * box.scale;
    const right = left + frame[2] * box.scale;
    const bottom = top + frame[3] * box.scale;
    const captureBounds = new LngLatBounds();
    [[left, top], [right, top], [right, bottom], [left, bottom]].forEach(point => {
      captureBounds.extend(map.unproject(point as [number, number]));
    });

    const renderHeight = 1000;
    const renderWidth = Math.round(renderHeight * frame[2] / frame[3]);
    const host = document.createElement("div");
    host.className = "maputnik-paper-render-host";
    host.style.width = `${renderWidth}px`;
    host.style.height = `${renderHeight}px`;
    document.body.appendChild(host);

    const printableStyle = props.replaceAccessTokens(cloneDeep(props.mapStyle));
    const printMap = new MapLibreGl.Map({
      container: host,
      style: printableStyle,
      bounds: captureBounds,
      fitBoundsOptions: {padding: 0, duration: 0},
      interactive: false,
      attributionControl: false,
      canvasContextAttributes: {preserveDrawingBuffer: true},
      fadeDuration: 0,
    });
    const removeTransitRuntime = installTransitRuntime(printMap);

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          reject(new Error("Printable map tiles timed out."));
        }, 20000);
        printMap.once("style.load", () => {
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
  ]);

  const exportPdf = useCallback(async () => {
    setExporting(true);
    setExportKind("busy");
    try {
      const ids = plannedSheetIds();
      setExportStatus("Rendering map…");
      const printable = await capturePrintableMap();
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index];
        setExportStatus(`Saving ${index + 1}/${ids.length}…`);
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
          }),
        });
        const data = await response.json();
        if (!response.ok || !data?.ok) {
          throw new Error(data?.error || "PDF export failed");
        }
        const link = document.createElement("a");
        link.href = data.pdfUrl;
        link.download = `map-sheet-${id}.pdf`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      await refreshUsedSheetIds();
      setExportKind("ok");
      setExportStatus(ids.length === 1
        ? `Downloaded map ${ids[0]}`
        : `Downloaded ${ids.length} maps`);
    } catch (error) {
      const message = error instanceof DOMException && error.name === "SecurityError"
        ? "The tile server blocked map capture."
        : messageFromError(error);
      setExportKind("error");
      setExportStatus(message);
    } finally {
      setExporting(false);
    }
  }, [
    capturePrintableMap,
    pageSize,
    plannedSheetIds,
    refreshUsedSheetIds,
  ]);

  useEffect(() => {
    if (conflictingIds.length > 0 && (exportKind === "idle" || exportKind === "warn")) {
      setExportKind("warn");
      setExportStatus(conflictingIds.length === 1
        ? `Map ${conflictingIds[0]} will be replaced`
        : `${conflictingIds.length} maps will be replaced`);
    } else if (conflictingIds.length === 0 && exportKind === "warn") {
      setExportKind("idle");
      setExportStatus("");
    }
  }, [conflictingIds, exportKind]);

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
          className={`maputnik-paper-tools__map-id${conflictingIds.length ? " is-used" : ""}`}
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
        <input
          className="maputnik-paper-tools__copies"
          type="number"
          min="1"
          max="200"
          step="1"
          placeholder="Copies"
          aria-label="Number of copies"
          title="Number of participant copies"
          value={participants}
          onChange={event => {
            setParticipants(event.target.value);
            if (exportKind === "error" || exportKind === "ok") {
              setExportKind("idle");
              setExportStatus("");
            }
          }}
        />
        <button
          className="maputnik-paper-tools__pdf"
          type="button"
          disabled={!mapReady || exporting}
          onClick={() => void exportPdf()}
        >
          <MdPictureAsPdf />
          <span>{exporting ? "Working…" : "Export PDF"}</span>
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

    {previewEnabled && layout && viewport && viewport.width > 0 && viewport.height > 0
      ? <PaperPreview layout={layout} viewport={viewport} />
      : null}
  </>;
}
