"""Heater Watchdog backend.

FastAPI app that:
  - polls zone temperatures + weather from the Siemens LOGO! / Ambient Weather
  - pushes live readings to the dashboard over a WebSocket
  - exposes POST /api/reset which commands the LOGO! (weather-gated)
  - serves the static frontend and camera config

Run (dev):  uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config as cfg
from . import store
from .alerts import AlertEngine, build_notifier
from .drivers.relay import make_reset
from .drivers.temperature import make_driver
from .drivers.weather import make_weather
from .vision import VisionEngine

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("watchdog")

app = FastAPI(title="Heater Watchdog")

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
_LOGO = {"host": cfg.LOGO_HOST, "port": cfg.LOGO_PORT, "unit_id": cfg.LOGO_UNIT_ID}

# --- Hardware ---------------------------------------------------------------
temp_driver = make_driver(cfg.HARDWARE_MODE, cfg.CONTROLLERS, cfg.SETPOINT_F, _LOGO)
reset_driver = make_reset(cfg.HARDWARE_MODE, _LOGO, cfg.RESET_COIL, cfg.RESET_HOLD_SEC)
weather_driver = make_weather(cfg.HARDWARE_MODE, cfg.AMBIENT_API_KEY, cfg.AMBIENT_APP_KEY)

# --- History + alerting -----------------------------------------------------
store.init(cfg.DB_PATH, cfg.HISTORY_RETENTION_DAYS)
_notify = build_notifier(cfg)


def _emit_alert(alert: dict) -> None:
    # Runs inside a worker thread (blocking DB write + possible email send).
    store.record_alert(alert)
    _notify(alert)


alert_engine = AlertEngine(_emit_alert, high_f=cfg.TEMP_EMAIL_HIGH_F, low_f=cfg.TEMP_EMAIL_LOW_F)

# --- Vision (YOLO) ----------------------------------------------------------
vision_engine = VisionEngine(cfg.CAMERAS, cfg, _emit_alert)

# Shared latest snapshot + set of connected websocket clients.
_latest: dict = {"controllers": [], "weather": None, "ts": 0}
_clients: set[WebSocket] = set()
_reset_lock = asyncio.Lock()
_last_reset_ts: float = 0.0


# Two-sided guardrails: safe inside [LOW, HIGH], warn within the margin of a
# bound, critical at/beyond it. Derived from the email guardrails so the UI and
# the alert emails always agree.
_CRIT_HIGH_F = cfg.TEMP_EMAIL_HIGH_F
_CRIT_LOW_F = cfg.TEMP_EMAIL_LOW_F
_WARN_HIGH_F = _CRIT_HIGH_F - cfg.TEMP_WARN_MARGIN_F
_WARN_LOW_F = _CRIT_LOW_F + cfg.TEMP_WARN_MARGIN_F
_THRESHOLDS = {
    "warn_low_f": _WARN_LOW_F,
    "warn_high_f": _WARN_HIGH_F,
    "crit_low_f": _CRIT_LOW_F,
    "crit_high_f": _CRIT_HIGH_F,
}


def _classify(temp_f: float, online: bool) -> str:
    if not online:
        return "offline"
    if temp_f >= _CRIT_HIGH_F or temp_f <= _CRIT_LOW_F:
        return "critical"
    if temp_f >= _WARN_HIGH_F or temp_f <= _WARN_LOW_F:
        return "warn"
    return "ok"


def _read_weather() -> dict:
    # Informational only — weather no longer gates the reset.
    return weather_driver.read().to_dict()


async def _poll_loop() -> None:
    """Background task: read all zones + weather, broadcast to clients."""
    names = {c["id"]: c["name"] for c in cfg.CONTROLLERS}
    while True:
        readings = []
        for c in cfg.CONTROLLERS:
            r = temp_driver.read(c["id"])
            d = r.to_dict()
            d["name"] = names[c["id"]]
            d["status"] = _classify(r.temp_f, r.online)
            readings.append(d)
        _latest["controllers"] = readings
        _latest["weather"] = await asyncio.to_thread(_read_weather)
        _latest["ts"] = time.time()

        # Persist history + evaluate alerts off the event loop.
        await asyncio.to_thread(store.record_readings, readings, _latest["ts"])
        alerts = await asyncio.to_thread(alert_engine.evaluate, readings)

        await _broadcast({"type": "readings", **_latest})
        for a in alerts:
            await _broadcast({"type": "alert", **a})
        await asyncio.sleep(cfg.POLL_INTERVAL_SEC)


async def _prune_loop() -> None:
    while True:
        await asyncio.sleep(3600)  # hourly
        await asyncio.to_thread(store.prune)


async def _vision_loop() -> None:
    """Broadcast the detection overlay + any vision alerts to dashboards."""
    if not cfg.VISION_ENABLED:
        return
    while True:
        snap = vision_engine.snapshot()
        await _broadcast({"type": "vision", "cameras": snap, "ts": time.time()})
        for a in vision_engine.drain_alerts():
            await _broadcast({"type": "alert", **a})
        await asyncio.sleep(cfg.VISION_BROADCAST_SEC)


async def _broadcast(msg: dict) -> None:
    dead = []
    for ws in _clients:
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _clients.discard(ws)


@app.on_event("startup")
async def _startup() -> None:
    vision_engine.start()
    asyncio.create_task(_poll_loop())
    asyncio.create_task(_prune_loop())
    asyncio.create_task(_vision_loop())
    log.info("Heater Watchdog started in %s mode", cfg.HARDWARE_MODE.upper())


# --- API --------------------------------------------------------------------
@app.get("/api/config")
async def get_config() -> JSONResponse:
    """Static config the frontend needs to render (cameras, thresholds)."""
    return JSONResponse(
        {
            "cameras": [
                {"id": c["id"], "name": c["name"], "webrtc": f"{cfg.MEDIAMTX_BASE}/{c['path']}"}
                for c in cfg.CAMERAS
            ],
            "thresholds": _THRESHOLDS,
            "hardware_mode": cfg.HARDWARE_MODE,
            "poll_interval_sec": cfg.POLL_INTERVAL_SEC,
            "weather_enabled": cfg.WEATHER_ENABLED,
            "vision_enabled": cfg.VISION_ENABLED,
        }
    )


@app.get("/api/vision")
async def get_vision() -> JSONResponse:
    """Latest detection overlay per camera (also pushed over the websocket)."""
    return JSONResponse({"cameras": vision_engine.snapshot()})


@app.get("/api/readings")
async def get_readings() -> JSONResponse:
    """Current snapshot (also available live over the websocket)."""
    return JSONResponse(_latest)


@app.get("/api/history")
async def get_history(hours: float = 6.0) -> JSONResponse:
    """Per-zone temperature time series for charting (downsampled)."""
    hours = max(0.1, min(hours, 24 * cfg.HISTORY_RETENTION_DAYS))
    names = {c["id"]: c["name"] for c in cfg.CONTROLLERS}
    series = await asyncio.to_thread(store.history, hours)
    return JSONResponse(
        {
            "hours": hours,
            "zones": [
                {"id": zid, "name": names.get(zid, zid), "points": pts}
                for zid, pts in series.items()
            ],
            "thresholds": _THRESHOLDS,
        }
    )


@app.get("/api/alerts")
async def get_alerts(limit: int = 50) -> JSONResponse:
    rows = await asyncio.to_thread(store.recent_alerts, min(limit, 200))
    return JSONResponse({"alerts": rows})


@app.post("/api/reset")
async def reset_heater() -> JSONResponse:
    """Command the LOGO! to pulse the reset relay. Rate-limited only."""
    global _last_reset_ts
    if _reset_lock.locked():
        return JSONResponse({"ok": False, "error": "reset already in progress"}, status_code=409)
    if time.time() - _last_reset_ts < cfg.RESET_COOLDOWN_SEC:
        return JSONResponse({"ok": False, "error": "cooldown active"}, status_code=429)

    async with _reset_lock:
        log.warning("RESET requested -> LOGO!")
        await asyncio.to_thread(reset_driver.pulse)
        _last_reset_ts = time.time()
        alert = {"ts": _last_reset_ts, "zone": None, "severity": "info",
                 "kind": "reset", "message": "Heater reset commanded via LOGO!"}
        await asyncio.to_thread(_emit_alert, alert)
        await _broadcast({"type": "event", "event": "reset", "ts": _last_reset_ts})
        await _broadcast({"type": "alert", **alert})
    return JSONResponse({"ok": True, "ts": _last_reset_ts})


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    _clients.add(ws)
    if _latest["controllers"]:
        await ws.send_json({"type": "readings", **_latest})
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _clients.discard(ws)


# --- Static frontend (mounted last so /api and /ws win) ---------------------
@app.get("/")
async def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR)), name="static")
