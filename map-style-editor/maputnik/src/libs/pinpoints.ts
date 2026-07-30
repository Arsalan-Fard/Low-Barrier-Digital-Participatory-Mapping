import type {
  GeoJSONSource,
  Map,
} from 'maplibre-gl'

export type MapPinpoint = {
  id: string
  coordinates: [number, number]
};

export const PINPOINT_LAYER_ID = "paper-pinpoints";

const PINPOINT_SOURCE_ID = "paper-pinpoints-source";
const PINPOINT_IMAGE_ID = "paper-blue-pin";
const PINPOINT_IMAGE_WIDTH = 44;
const PINPOINT_IMAGE_HEIGHT = 56;
const PINPOINT_PIXEL_RATIO = 2;

function createPinImage() {
  const canvas = document.createElement("canvas");
  canvas.width = PINPOINT_IMAGE_WIDTH;
  canvas.height = PINPOINT_IMAGE_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");

  context.clearRect(0, 0, PINPOINT_IMAGE_WIDTH, PINPOINT_IMAGE_HEIGHT);
  context.beginPath();
  context.moveTo(22, 53);
  context.bezierCurveTo(18, 45, 5, 32, 5, 21);
  context.bezierCurveTo(5, 11, 12.6, 3, 22, 3);
  context.bezierCurveTo(31.4, 3, 39, 11, 39, 21);
  context.bezierCurveTo(39, 32, 26, 45, 22, 53);
  context.closePath();
  context.fillStyle = "#1976d2";
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = "#0d47a1";
  context.stroke();

  context.beginPath();
  context.arc(22, 20, 7, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = "#0d47a1";
  context.stroke();

  return context.getImageData(
    0,
    0,
    PINPOINT_IMAGE_WIDTH,
    PINPOINT_IMAGE_HEIGHT,
  );
}

function pinpointGeoJson(pinpoints: MapPinpoint[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: pinpoints.map(pinpoint => ({
      type: "Feature",
      id: pinpoint.id,
      properties: {pinpointId: pinpoint.id},
      geometry: {
        type: "Point",
        coordinates: pinpoint.coordinates,
      },
    })),
  };
}

export function drawPinpoints(map: Map, pinpoints: MapPinpoint[]) {
  if (!map.isStyleLoaded()) return;
  try {
    if (!map.hasImage(PINPOINT_IMAGE_ID)) {
      map.addImage(PINPOINT_IMAGE_ID, createPinImage(), {
        pixelRatio: PINPOINT_PIXEL_RATIO,
      });
    }

    const data = pinpointGeoJson(pinpoints);
    const source = map.getSource(PINPOINT_SOURCE_ID) as GeoJSONSource | undefined;
    if (source) {
      source.setData(data);
    } else {
      map.addSource(PINPOINT_SOURCE_ID, {
        type: "geojson",
        data,
      });
    }

    if (!map.getLayer(PINPOINT_LAYER_ID)) {
      map.addLayer({
        id: PINPOINT_LAYER_ID,
        type: "symbol",
        source: PINPOINT_SOURCE_ID,
        layout: {
          "icon-allow-overlap": true,
          "icon-anchor": "bottom",
          "icon-image": PINPOINT_IMAGE_ID,
          "icon-ignore-placement": true,
          "icon-size": 1,
        },
      });
    }
    map.triggerRepaint();
  } catch (_error) {
    // style.load retries if the style is currently being replaced.
  }
}

/**
 * Capture MapLibre's backing canvas and paint the runtime-only pinpoints onto
 * a normal 2D canvas. The hidden print map can report `idle` before a
 * dynamically registered symbol image reaches its WebGL backing buffer, so
 * compositing here makes the exported PNG deterministic.
 */
export function captureMapCanvasWithPinpoints(
  map: Map,
  pinpoints: MapPinpoint[],
) {
  const mapCanvas = map.getCanvas();
  const cssWidth = mapCanvas.clientWidth || mapCanvas.width;
  const cssHeight = mapCanvas.clientHeight || mapCanvas.height;
  const scaleX = mapCanvas.width / cssWidth;
  const scaleY = mapCanvas.height / cssHeight;
  const pinWidth = PINPOINT_IMAGE_WIDTH / PINPOINT_PIXEL_RATIO;
  const pinHeight = PINPOINT_IMAGE_HEIGHT / PINPOINT_PIXEL_RATIO;

  const output = document.createElement("canvas");
  output.width = mapCanvas.width;
  output.height = mapCanvas.height;
  const context = output.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.drawImage(mapCanvas, 0, 0);

  if (pinpoints.length > 0) {
    const pinCanvas = document.createElement("canvas");
    pinCanvas.width = PINPOINT_IMAGE_WIDTH;
    pinCanvas.height = PINPOINT_IMAGE_HEIGHT;
    const pinContext = pinCanvas.getContext("2d");
    if (!pinContext) throw new Error("Canvas is unavailable");
    pinContext.putImageData(createPinImage(), 0, 0);

    for (const pinpoint of pinpoints) {
      const point = map.project(pinpoint.coordinates);
      context.drawImage(
        pinCanvas,
        (point.x - pinWidth / 2) * scaleX,
        (point.y - pinHeight) * scaleY,
        pinWidth * scaleX,
        pinHeight * scaleY,
      );
    }
  }

  return output.toDataURL("image/png");
}
