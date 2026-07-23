"""YOLO vision engine.

Runs object detection over the camera streams and produces two things:
  1. live detections (normalized boxes) broadcast to the dashboard, which draws
     them as an overlay on each camera tile;
  2. edge-triggered alerts (e.g. a person near the hot equipment), debounced so
     a lingering object doesn't spam.

Each camera runs in its own thread (inference is CPU-heavy). Off-Pi — or
whenever ultralytics/OpenCV or the model aren't available — a `MockDetector`
emits synthetic detections so the overlay + alerting can be built and demoed.

Coordinates are normalized (x, y = top-left; w, h as fractions of the frame),
so the frontend scales them to whatever size the video tile is rendered at.
"""
from __future__ import annotations

import logging
import math
import threading
import time
from dataclasses import dataclass, asdict
from typing import Callable, Dict, List, Optional

log = logging.getLogger("vision")


@dataclass
class Detection:
    cls: str
    conf: float
    x: float
    y: float
    w: float
    h: float

    def to_dict(self) -> dict:
        d = asdict(self)
        d["conf"] = round(self.conf, 2)
        for k in ("x", "y", "w", "h"):
            d[k] = round(d[k], 4)
        return d


class Detector:
    """Per-camera detector interface."""

    def detect(self) -> List[Detection]:  # pragma: no cover - interface
        raise NotImplementedError

    def close(self) -> None:
        pass


class MockDetector(Detector):
    """Synthetic detections for dev: a person that paces across cam-1, plus a
    static object on other cameras, so overlays + person-alerts are exercisable.
    """

    def __init__(self, camera_id: str):
        self.camera_id = camera_id
        self._t0 = time.time()

    def detect(self) -> List[Detection]:
        t = time.time() - self._t0
        if self.camera_id.endswith("1"):
            # Person present for 15s out of every 25s, pacing left<->right.
            if (t % 25) < 15:
                x = 0.1 + 0.6 * (0.5 + 0.5 * math.sin(t / 3.0))
                return [Detection("person", 0.86, x, 0.45, 0.14, 0.4)]
            return []
        if self.camera_id.endswith("2"):
            return [Detection("truck", 0.72, 0.3, 0.35, 0.4, 0.45)]
        return []


class YoloDetector(Detector):
    """Real detector: ultralytics YOLO over an RTSP substream via OpenCV.

    Uses the camera's low-res substream to keep the Pi light. Grabs the latest
    frame each call (draining the buffer) and runs one inference.
    """

    def __init__(self, camera_id: str, rtsp_url: str, model_path: str, conf: float):
        import cv2  # lazy
        from ultralytics import YOLO  # lazy

        self.camera_id = camera_id
        self._conf = conf
        self._cap = cv2.VideoCapture(rtsp_url)
        self._model = YOLO(model_path)

    def detect(self) -> List[Detection]:
        import cv2  # noqa: F401

        # Drain buffered frames so we infer on the freshest one.
        ok, frame = self._cap.read()
        if not ok or frame is None:
            return []
        h, w = frame.shape[:2]
        results = self._model.predict(frame, conf=self._conf, verbose=False)
        out: List[Detection] = []
        for r in results:
            names = r.names
            for b in r.boxes:
                x1, y1, x2, y2 = b.xyxy[0].tolist()
                out.append(
                    Detection(
                        cls=names[int(b.cls[0])],
                        conf=float(b.conf[0]),
                        x=x1 / w,
                        y=y1 / h,
                        w=(x2 - x1) / w,
                        h=(y2 - y1) / h,
                    )
                )
        return out

    def close(self) -> None:
        try:
            self._cap.release()
        except Exception:
            pass


class VisionEngine:
    """Owns one detector thread per camera; exposes a snapshot + pending alerts."""

    def __init__(self, cameras: List[dict], cfg, on_alert: Callable[[dict], None]):
        self._cameras = cameras
        self._cfg = cfg
        self._on_alert = on_alert
        self._fps = max(0.2, float(cfg.VISION_FPS))
        self._alert_classes = {c.strip() for c in cfg.VISION_ALERT_CLASSES.split(",") if c.strip()}
        self._cooldown = cfg.VISION_ALERT_COOLDOWN_SEC
        self._latest: Dict[str, List[dict]] = {c["id"]: [] for c in cameras}
        self._last_alert: Dict[str, float] = {}   # key "cam:cls" -> ts
        self._present: Dict[str, bool] = {}        # key "cam:cls" -> present last frame
        self._pending: List[dict] = []
        self._lock = threading.Lock()
        self._threads: List[threading.Thread] = []
        self._stop = threading.Event()

    def _make_detector(self, cam: dict) -> Detector:
        if self._cfg.HARDWARE_MODE == "real" and self._cfg.VISION_ENABLED:
            try:
                return YoloDetector(cam["id"], cam.get("rtsp", ""), self._cfg.VISION_MODEL, self._cfg.VISION_CONF)
            except Exception as e:
                log.warning("YOLO unavailable for %s (%s); using mock", cam["id"], e)
        return MockDetector(cam["id"])

    def start(self) -> None:
        if not self._cfg.VISION_ENABLED:
            log.info("vision disabled")
            return
        for cam in self._cameras:
            t = threading.Thread(target=self._run, args=(cam,), daemon=True)
            t.start()
            self._threads.append(t)
        log.info("vision started for %d cameras", len(self._cameras))

    def _run(self, cam: dict) -> None:
        det = self._make_detector(cam)
        period = 1.0 / self._fps
        while not self._stop.is_set():
            t0 = time.time()
            try:
                dets = det.detect()
            except Exception as e:
                log.warning("detect error on %s: %s", cam["id"], e)
                dets = []
            with self._lock:
                self._latest[cam["id"]] = [d.to_dict() for d in dets]
            self._check_alerts(cam, dets)
            time.sleep(max(0.0, period - (time.time() - t0)))
        det.close()

    def _check_alerts(self, cam: dict, dets: List[Detection]) -> None:
        """Edge-trigger: alert when a watched class first appears, with cooldown."""
        seen = {d.cls for d in dets}
        now = time.time()
        for cls in self._alert_classes:
            key = f"{cam['id']}:{cls}"
            was = self._present.get(key, False)
            is_now = cls in seen
            self._present[key] = is_now
            if is_now and not was and now - self._last_alert.get(key, 0) > self._cooldown:
                self._last_alert[key] = now
                conf = max((d.conf for d in dets if d.cls == cls), default=0.0)
                alert = {
                    "ts": now, "zone": None, "severity": "warning", "kind": "vision",
                    "message": f"{cls.capitalize()} detected on {cam['name']} camera ({conf*100:.0f}%)",
                }
                try:
                    self._on_alert(alert)  # store + notify (blocking, in thread)
                except Exception as e:
                    log.warning("vision on_alert error: %s", e)
                with self._lock:
                    self._pending.append(alert)

    def snapshot(self) -> Dict[str, List[dict]]:
        with self._lock:
            return {k: list(v) for k, v in self._latest.items()}

    def drain_alerts(self) -> List[dict]:
        with self._lock:
            out, self._pending = self._pending, []
            return out

    def stop(self) -> None:
        self._stop.set()
