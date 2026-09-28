"""The live camera: finding it, reading frames, exposure, controls and the MJPEG feed."""
import json
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

import cv2
import numpy as np
from flask import Blueprint, Response, jsonify, request, stream_with_context

from . import shutdown_event

bp = Blueprint("camera", __name__)

frame_lock = threading.Lock()
capture = None
camera_source = ""
latest_frame = None
latest_frame_seq = 0
latest_frame_width = 0
latest_frame_height = 0
latest_camera_fps = 0.0

video_feed_lock = threading.Lock()
video_feed_cache = {"seq": -1, "quality": -1, "data": None}

CAMERA_MANUAL_ISO = 100
CAMERA_FOCUS_AF_MODE = "continuous-video"
CAMERA_CONTROLS = {
    "exposureAuto": {"label": "Auto exposure", "type": "toggle", "default": 1},
    # 8 ms looks near-black but gives the decoder crisp, motion-free tag edges under a projector.
    "exposure": {"label": "Exposure (ms)", "type": "range", "min": 1, "max": 300, "step": 1, "default": 8},
    "focusAuto": {"label": "Autofocus", "type": "toggle", "default": 1},
    "focus": {"label": "Focus", "type": "range", "min": 0.5, "max": 3, "step": 0.1, "default": 1},
    "resolution": {"label": "Resolution", "type": "select", "default": "1920x1080",
                   "options": ["640x480", "1280x720", "1920x1080"]},
}
camera_control_values = {key: meta["default"] for key, meta in CAMERA_CONTROLS.items()}


def get_ipv4_candidates():
    out = set()
    for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
        if ip and not ip.startswith("127."):
            out.add(ip)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        out.add(sock.getsockname()[0])
    except Exception:
        pass
    sock.close()
    return sorted(out)


def lan_neighbours():
    """Every other address on the /24 networks this machine is on."""
    seen = set()
    out = []
    for ip in get_ipv4_candidates():
        parts = ip.split(".")
        if len(parts) != 4:
            continue
        prefix = ".".join(parts[:3])
        for host in range(1, 255):
            candidate = f"{prefix}.{host}"
            if candidate != ip and candidate not in seen:
                seen.add(candidate)
                out.append(candidate)
    return out


def is_tcp_port_open(ip, port, timeout=0.2):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        return sock.connect_ex((ip, port)) == 0
    except Exception:
        return False
    finally:
        sock.close()


def discover_ip_camera(port=8080, path="/video"):
    """URL of the first IP Webcam phone on the LAN whose stream opens, or None."""
    candidates = lan_neighbours()
    open_ips = []
    with ThreadPoolExecutor(max_workers=min(64, max(1, len(candidates)))) as pool:
        tasks = {pool.submit(is_tcp_port_open, ip, port): ip for ip in candidates}
        for future in as_completed(tasks):
            if future.result():
                open_ips.append(tasks[future])

    for ip in open_ips:
        source = f"http://{ip}:{port}{path}"
        cap = cv2.VideoCapture(source)
        ok = cap.isOpened() and cap.read()[0]
        cap.release()
        if ok:
            return source
    return None


def parse_source(raw):
    """--source value: a webcam index, a URL, or None when not given."""
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except ValueError:
        return raw


def init_camera(source):
    """Make `source` the live camera, closing the previous one; None leaves no camera."""
    global capture, camera_source
    previous = capture
    capture = None
    camera_source = ""
    if previous is not None:
        time.sleep(0.08)  # let camera_loop move off the old capture before it is released
        try:
            previous.release()
        except Exception:
            pass
    if source is None:
        return
    cap = cv2.VideoCapture(source)
    try:
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception:
        pass
    if not cap.isOpened():
        print(f"[Camera] Could not open source: {source} — continuing without a camera")
        return
    capture = cap
    camera_source = str(source)


def camera_loop():
    global latest_frame, latest_frame_seq, latest_frame_width, latest_frame_height, latest_camera_fps
    previous_time = None
    while not shutdown_event.is_set():
        cap = capture  # init_camera may swap it out while we read
        if cap is None:
            time.sleep(0.01)
            continue
        try:
            ok, frame = cap.read()
        except Exception:
            time.sleep(0.05)
            continue
        if not ok:
            time.sleep(0.002)
            continue

        with frame_lock:
            latest_frame = frame
            latest_frame_seq += 1
            latest_frame_height = int(frame.shape[0])
            latest_frame_width = int(frame.shape[1])

        now = time.monotonic()
        if previous_time is not None and now > previous_time:
            fps = 1.0 / (now - previous_time)
            if latest_camera_fps <= 0:
                latest_camera_fps = fps
            else:
                latest_camera_fps = latest_camera_fps * 0.9 + fps * 0.1
        previous_time = now


def new_frame(last_seq):
    """(seq, copy of the latest frame) when it is newer than last_seq, else (last_seq, None)."""
    with frame_lock:
        if latest_frame is None or latest_frame_seq == last_seq:
            return last_seq, None
        return latest_frame_seq, latest_frame.copy()


def frame_copy():
    with frame_lock:
        if latest_frame is None:
            return None
        return latest_frame.copy()


def frame_info():
    with frame_lock:
        return {
            "width": int(latest_frame_width),
            "height": int(latest_frame_height),
            "seq": int(latest_frame_seq),
            "fps": round(float(latest_camera_fps), 1),
        }


def camera_base_url():
    """scheme://host:port of an HTTP camera (the IP Webcam app), else None."""
    if not camera_source.startswith("http"):
        return None
    parts = urllib.parse.urlparse(camera_source)
    if not parts.scheme or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}"


class AutoExposure:
    """Highlight-metered exposure for the IP Webcam phone.

    The phone meters the whole frame, so a bright projection clips and erases tag borders. This
    drives the highlights (p95) just below clipping, but never darkens once the bright content
    (p75) is under a floor, so a glare spot can't spiral the scene to black. It converges in a
    few damped steps, then holds and only rechecks every few seconds. ISO stays at its floor.
    """

    def __init__(self, target_hi=205.0, mid_floor=90.0, iso=100, start_ms=8.0, exp_min_ms=0.5,
                 exp_max_ms=40.0, hi_pct=95.0, mid_pct=75.0, tol=6.0, gain=0.6, min_step=0.6,
                 max_step=1.6, settle_s=0.5, recheck_s=5.0):
        self.target_hi = float(target_hi)
        self.mid_floor = float(mid_floor)
        self.iso = int(iso)
        self.exp_ms = float(start_ms)
        self.exp_min_ms = float(exp_min_ms)
        self.exp_max_ms = float(exp_max_ms)
        self.hi_pct = float(hi_pct)
        self.mid_pct = float(mid_pct)
        self.tol = float(tol)
        self.gain = float(gain)
        self.min_step = float(min_step)
        self.max_step = float(max_step)
        self.settle_s = float(settle_s)
        self.recheck_s = float(recheck_s)
        self.base = None
        self.next_time = 0.0
        self.holding = False
        self.hold_time = 0.0

    def reset(self):
        self.base = None
        self.holding = False

    @staticmethod
    def send(base, path):
        try:
            urllib.request.urlopen(f"{base}/{path}", timeout=2.0)
        except Exception as exc:
            print(f"[AutoExposure] {path} failed: {exc}", flush=True)

    def apply(self, base):
        self.exp_ms = min(self.exp_max_ms, max(self.exp_min_ms, self.exp_ms))
        self.send(base, f"settings/exposure_ns?set={int(self.exp_ms * 1e6)}")
        self.next_time = time.time() + self.settle_s

    def update(self, base, frame):
        now = time.time()
        if self.base != base:
            self.send(base, "settings/manual_sensor?set=on")
            self.send(base, f"settings/iso?set={self.iso}")
            self.base = base
            self.holding = False
            self.apply(base)
            return
        if now < self.next_time:
            return
        if self.holding and now - self.hold_time < self.recheck_s:
            return

        gray = frame if frame.ndim == 2 else cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        hi = float(np.percentile(gray, self.hi_pct))
        mid = float(np.percentile(gray, self.mid_pct))
        if abs(hi - self.target_hi) <= self.tol:
            factor = 1.0
        else:
            factor = (self.target_hi / max(hi, 1.0)) ** self.gain
        if factor < 1.0 and mid <= self.mid_floor:
            factor = 1.0
        factor = min(self.max_step, max(self.min_step, factor))

        new_exp = min(self.exp_max_ms, max(self.exp_min_ms, self.exp_ms * factor))
        if abs(new_exp - self.exp_ms) > 0.02 * self.exp_ms:
            self.exp_ms = new_exp
            self.holding = False
            self.apply(base)
            return
        if not self.holding:
            print("[AutoExposure] settled hi=%.0f mid=%.0f exp=%.2f ms" % (hi, mid, self.exp_ms), flush=True)
        self.holding = True
        self.hold_time = now


def auto_exposure_loop(target, floor):
    """Drive an IP Webcam's exposure from its frames; idles while the source is anything else."""
    control = AutoExposure(target_hi=target, mid_floor=floor)
    last_seq = -1
    while not shutdown_event.is_set():
        base = camera_base_url()
        if not base:
            control.reset()
            time.sleep(0.5)
            continue
        seq, frame = new_frame(last_seq)
        if frame is None:
            time.sleep(0.05)
            continue
        last_seq = seq
        try:
            control.update(base, frame)
        except Exception as exc:
            print(f"[AutoExposure] update failed: {exc}", flush=True)
        time.sleep(0.1)


def _ip_cam_set(query):
    """GET {base}/{query} on the IP Webcam; the result (with its status) goes back to the page."""
    base = camera_base_url()
    if not base:
        return {"url": query, "ok": False, "error": "no_ip_base"}
    url = f"{base}/{query}"
    try:
        with urllib.request.urlopen(url, timeout=2.0) as resp:
            status = int(resp.status)
            print(f"[Camera] GET {url} -> {status}", flush=True)
            return {"url": url, "ok": 200 <= status < 300, "status": status}
    except urllib.error.HTTPError as exc:
        print(f"[Camera] GET {url} -> HTTP {exc.code}", flush=True)
        return {"url": url, "ok": False, "status": int(exc.code)}
    except Exception as exc:
        print(f"[Camera] GET {url} failed: {exc}", flush=True)
        return {"url": url, "ok": False, "error": str(exc)}


def _manual_exposure_requests(ms):
    ns = int(ms * 1e6)
    return [
        _ip_cam_set("settings/manual_sensor?set=on"),
        _ip_cam_set(f"settings/iso?set={CAMERA_MANUAL_ISO}"),
        _ip_cam_set(f"settings/exposure_ns?set={ns}"),
        # frame_duration caps the exposure (33 ms at 30 fps), so it is raised to match
        _ip_cam_set(f"settings/frame_duration?set={ns}"),
    ]


def apply_camera_control(name, value):
    """Set one of CAMERA_CONTROLS. Returns (ok, value or error, the IP Webcam requests made)."""
    base = camera_base_url()
    sent = []

    if name == "resolution":
        size = str(value or "").lower().replace(" ", "")
        if "x" not in size:
            return False, "invalid_value", sent
        if base:
            sent.append(_ip_cam_set(f"settings/video_size?set={size}"))
            if camera_source:
                init_camera(camera_source)  # reconnect so the new size takes effect
        elif capture is not None:
            try:
                width, height = (int(v) for v in size.split("x"))
                capture.set(cv2.CAP_PROP_FRAME_WIDTH, width)
                capture.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            except Exception:
                return False, "set_failed", sent
        else:
            return False, "no_camera", sent
        camera_control_values[name] = size
        return True, size, sent

    try:
        number = float(value)
    except (TypeError, ValueError):
        return False, "invalid_value", sent

    if name == "exposureAuto":
        auto = round(number) != 0
        if base:
            if auto:
                sent.append(_ip_cam_set("settings/manual_sensor?set=off"))
            else:
                sent += _manual_exposure_requests(float(camera_control_values["exposure"]))
        camera_control_values[name] = 1 if auto else 0
        return True, camera_control_values[name], sent

    if name == "focusAuto":
        auto = round(number) != 0
        if base:
            if auto:
                sent.append(_ip_cam_set(f"settings/focusmode?set={CAMERA_FOCUS_AF_MODE}"))
            else:
                sent.append(_ip_cam_set("settings/focusmode?set=off"))
                sent.append(_ip_cam_set(f"settings/focus_distance?set={float(camera_control_values['focus'])}"))
        camera_control_values[name] = 1 if auto else 0
        return True, camera_control_values[name], sent

    # "exposure" (ms) or "focus" (diopters, only applies with autofocus off); moving either slider means manual
    if base:
        if name == "exposure":
            sent += _manual_exposure_requests(number)
            camera_control_values["exposureAuto"] = 0
        else:
            sent.append(_ip_cam_set("settings/focusmode?set=off"))
            sent.append(_ip_cam_set(f"settings/focus_distance?set={number}"))
            camera_control_values["focusAuto"] = 0
    elif capture is not None:
        prop = cv2.CAP_PROP_EXPOSURE if name == "exposure" else cv2.CAP_PROP_FOCUS
        try:
            capture.set(prop, number)
        except Exception:
            return False, "set_failed", sent
    else:
        return False, "no_camera", sent
    camera_control_values[name] = number
    return True, number, sent


def _read_ip_cam_settings():
    """Copy the IP Webcam's current settings (status.json "curvals") into camera_control_values."""
    try:
        with urllib.request.urlopen(f"{camera_base_url()}/status.json", timeout=2.0) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception:
        return
    current = data.get("curvals") if isinstance(data, dict) else None
    if not isinstance(current, dict):
        return
    try:
        if "exposure_ns" in current:
            camera_control_values["exposure"] = max(1, min(300, int(round(float(current["exposure_ns"]) / 1e6))))
        if "manual_sensor" in current:
            camera_control_values["exposureAuto"] = 0 if str(current["manual_sensor"]).lower() == "on" else 1
        if "focus_distance" in current:
            camera_control_values["focus"] = max(0.5, min(3.0, float(current["focus_distance"])))
        if "focusmode" in current:
            camera_control_values["focusAuto"] = 0 if str(current["focusmode"]).lower() == "off" else 1
        if "video_size" in current:
            camera_control_values["resolution"] = str(current["video_size"])
    except (TypeError, ValueError):
        pass


@bp.route("/api/camera/status")
def api_camera_status():
    return jsonify({"ok": True, "connected": capture is not None, "source": camera_source})


@bp.route("/api/camera/connect", methods=["POST"])
def api_camera_connect():
    """{"kind": "webcam", "index": 0} | {"kind": "smartphone"} (IP Webcam on :8080) | {"kind": "url", "url": "..."}"""
    payload = request.get_json(silent=True) or {}
    kind = str(payload.get("kind") or "").strip().lower()
    if kind == "webcam":
        try:
            source = int(payload.get("index", 0))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "invalid_index"}), 400
    elif kind == "smartphone":
        source = discover_ip_camera()
        if source is None:
            return jsonify({"ok": False, "error": "ip_camera_not_found"}), 404
    elif kind == "url":
        source = str(payload.get("url") or "").strip()
        if not source:
            return jsonify({"ok": False, "error": "missing_url"}), 400
    else:
        return jsonify({"ok": False, "error": "invalid_kind"}), 400
    init_camera(source)
    return jsonify({"ok": capture is not None, "source": camera_source})


@bp.route("/api/camera/controls", methods=["GET"])
def api_camera_controls_get():
    if camera_base_url():
        kind = "ip"
        _read_ip_cam_settings()
    elif capture is not None:
        kind = "uvc"
    else:
        kind = "none"

    controls = []
    for key, meta in CAMERA_CONTROLS.items():
        control = {"key": key, "label": meta["label"], "type": meta["type"],
                   "value": camera_control_values.get(key, meta["default"]), "default": meta["default"]}
        if meta["type"] == "range":
            control.update(min=meta["min"], max=meta["max"], step=meta["step"])
        elif meta["type"] == "select":
            options = list(meta["options"])
            current = camera_control_values.get(key)
            if current and current not in options:
                options.insert(0, current)
            control["options"] = options
        controls.append(control)
    return jsonify({"ok": True, "kind": kind, "controls": controls})


@bp.route("/api/camera/control", methods=["POST"])
def api_camera_control_set():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "")
    if name not in CAMERA_CONTROLS:
        return jsonify({"ok": False, "error": "unknown_control"}), 400
    ok, result, sent = apply_camera_control(name, payload.get("value"))
    # Always 200, so the requests list stays inspectable in DevTools.
    return jsonify({"ok": bool(ok), "name": name, "value": result if ok else None,
                    "error": None if ok else result, "requests": sent})


def _jpeg(seq, quality, params):
    """The latest frame as JPEG, encoded once per frame and quality however many clients watch."""
    with video_feed_lock:
        if video_feed_cache["seq"] == seq and video_feed_cache["quality"] == quality:
            return video_feed_cache["data"]
        frame = frame_copy()
        if frame is None:
            return None
        ok, jpg = cv2.imencode(".jpg", frame, params)
        if not ok:
            return None
        data = jpg.tobytes()
        video_feed_cache.update(seq=seq, quality=quality, data=data)
        return data


@bp.route("/video_feed")
def video_feed():
    quality = max(40, min(95, int(request.args.get("q", "75"))))
    params = [int(cv2.IMWRITE_JPEG_QUALITY), quality]

    def stream():
        last_seq = -1
        while not shutdown_event.is_set():
            with frame_lock:
                seq = latest_frame_seq
                have_frame = latest_frame is not None
            if not have_frame or seq == last_seq:
                time.sleep(0.005)
                continue
            last_seq = seq
            data = _jpeg(seq, quality, params)
            if data is not None:
                yield b"--frame\r\nContent-Type: image/jpeg\r\nCache-Control: no-store\r\n\r\n" + data + b"\r\n"

    return Response(
        stream_with_context(stream()),
        mimetype="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache"},
    )
