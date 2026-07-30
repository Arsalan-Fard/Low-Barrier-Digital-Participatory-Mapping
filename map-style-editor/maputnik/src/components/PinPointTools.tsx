import {useEffect, useRef, useState} from 'react'
import type {
  Map,
  MapMouseEvent,
} from 'maplibre-gl'
import {MdLocationOn} from 'react-icons/md'
import {
  drawPinpoints,
  MapPinpoint,
} from '../libs/pinpoints'

type PinPointToolsProps = {
  map: Map | null
  pinpoints: MapPinpoint[]
  onPinpointAdded(pinpoint: MapPinpoint): void
  onPinpointRemoved(pinpointId: string): void
};

let nextPinpointId = 1;
const MAX_CLICK_TRAVEL = 5;

export default function PinPointTools(props: PinPointToolsProps) {
  const [active, setActive] = useState(false);
  const pinpointsRef = useRef(props.pinpoints);
  pinpointsRef.current = props.pinpoints;

  useEffect(() => {
    const map = props.map;
    if (!map) return;
    const restorePinpoints = () => drawPinpoints(map, pinpointsRef.current);
    restorePinpoints();
    map.on("style.load", restorePinpoints);
    return () => {
      map.off("style.load", restorePinpoints);
    };
  }, [props.map]);

  useEffect(() => {
    const map = props.map;
    if (!map || !active) return;
    const canvas = map.getCanvas();
    const container = map.getContainer();
    container.classList.add("maputnik-pinpoint-mode");
    let pointerDown: {x: number; y: number} | null = null;

    const onMapMouseDown = (event: MapMouseEvent) => {
      if (event.originalEvent.button !== 0) return;
      pointerDown = {x: event.point.x, y: event.point.y};
    };

    const suppressInspectorClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const onMapMouseUp = (event: MapMouseEvent) => {
      const start = pointerDown;
      pointerDown = null;
      if (!start || event.originalEvent.button !== 0) return;
      if (Math.hypot(event.point.x - start.x, event.point.y - start.y) > MAX_CLICK_TRAVEL) {
        return;
      }

      const hit = [...pinpointsRef.current].reverse().find(pinpoint => {
        const point = map.project(pinpoint.coordinates);
        const offsetX = event.point.x - point.x;
        const offsetY = event.point.y - point.y;
        return Math.abs(offsetX) <= 16 && offsetY >= -30 && offsetY <= 8;
      });
      if (hit) {
        const nextPinpoints = pinpointsRef.current.filter(pinpoint => pinpoint.id !== hit.id);
        pinpointsRef.current = nextPinpoints;
        drawPinpoints(map, nextPinpoints);
        props.onPinpointRemoved(hit.id);
        return;
      }

      const pinpoint = {
        id: `pin-${Date.now()}-${nextPinpointId++}`,
        coordinates: [event.lngLat.lng, event.lngLat.lat],
      } satisfies MapPinpoint;
      const nextPinpoints = [...pinpointsRef.current, pinpoint];
      pinpointsRef.current = nextPinpoints;
      drawPinpoints(map, nextPinpoints);
      props.onPinpointAdded(pinpoint);
    };

    map.on("mousedown", onMapMouseDown);
    map.on("mouseup", onMapMouseUp);
    canvas.addEventListener("click", suppressInspectorClick, true);
    return () => {
      map.off("mousedown", onMapMouseDown);
      map.off("mouseup", onMapMouseUp);
      canvas.removeEventListener("click", suppressInspectorClick, true);
      container.classList.remove("maputnik-pinpoint-mode");
      canvas.style.removeProperty("cursor");
    };
  }, [
    active,
    props.map,
    props.onPinpointAdded,
    props.onPinpointRemoved,
  ]);

  return <button
    type="button"
    className={`maputnik-pinpoint-trigger${active ? " is-active" : ""}`}
    aria-label="Place blue map pins"
    aria-pressed={active}
    title={active
      ? "Pin mode active: click the map to add; click a pin to remove"
      : "Place blue map pins"}
    onClick={() => setActive(current => !current)}
  >
    <MdLocationOn />
    {props.pinpoints.length > 0 && <span aria-hidden="true">
      {props.pinpoints.length}
    </span>}
  </button>;
}
