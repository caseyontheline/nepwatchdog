"""Central configuration for Heater Watchdog.

Values are read from environment variables so the same code runs on your Mac
(development, mock hardware) and on the Raspberry Pi (real hardware). See
`.env.example` for the full list.

Hardware topology:
  Heatec controllers --(4-20mA/0-10V)--> MINI MCR isolators --> Siemens LOGO! 8.3
  Raspberry Pi 5 <--Modbus TCP--> LOGO!  (reads temps, commands reset)
  LOGO! --> Phoenix Contact relay --> heater reset circuit
  Hikvision cameras --PoE--> Pi (RTSP -> MediaMTX -> WebRTC)
  Ambient Weather WS-2902 --> weather readout (informational, does not gate reset)
"""
import os


def _get(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _get_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _get_bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).lower() in ("1", "true", "yes")


# --- Hardware mode ---------------------------------------------------------
# "mock"  -> simulated temps + fake reset + fake weather (safe anywhere)
# "real"  -> talk to the LOGO! over Modbus TCP + real weather (on the Pi)
HARDWARE_MODE = _get("HW_MODE", "mock").lower()

# --- Siemens LOGO! 8.3 (Modbus TCP) ----------------------------------------
# The LOGO! is the single control point: the Pi reads analog temps from it and
# commands the reset through it. All addresses below match YOUR LOGO! program.
LOGO_HOST = _get("LOGO_HOST", "192.168.1.10")
LOGO_PORT = _get_int("LOGO_PORT", 502)
LOGO_UNIT_ID = _get_int("LOGO_UNIT_ID", 1)

# --- Temperature controllers ----------------------------------------------
# Each controller's process value is read from a LOGO! holding register (VW).
# Set reg + scale to match how your LOGO! program stores the isolated analog
# input (e.g. LOGO! often stores 0-1000 for 0-10V; scale maps that to degrees F).
CONTROLLERS = [
    {
        "id": "ctrl-1",
        "name": _get("CTRL1_NAME", "Heater Zone 1"),
        "reg": _get_int("CTRL1_REG", 0),        # Modbus holding-register address
        "scale": float(_get("CTRL1_SCALE", "1.0")),
        "offset": float(_get("CTRL1_OFFSET", "0.0")),
    },
    {
        "id": "ctrl-2",
        "name": _get("CTRL2_NAME", "Heater Zone 2"),
        "reg": _get_int("CTRL2_REG", 1),
        "scale": float(_get("CTRL2_SCALE", "1.0")),
        "offset": float(_get("CTRL2_OFFSET", "0.0")),
    },
]
SETPOINT_F = _get_int("SETPOINT_F", 400)

# How often (seconds) the backend polls the LOGO!.
POLL_INTERVAL_SEC = _get_int("POLL_INTERVAL_SEC", 2)

# Safety thresholds (degrees F) used to color the UI and raise alerts.
TEMP_WARN_F = _get_int("TEMP_WARN_F", 375)
TEMP_CRIT_F = _get_int("TEMP_CRIT_F", 425)

# --- Reset (via LOGO!) -----------------------------------------------------
# The Pi sets a network input / marker coil on the LOGO!; the LOGO! program
# does the timed pulse to the Phoenix Contact relay (the reliable industrial
# part owns the timing). RESET_COIL is the Modbus coil address of that marker.
RESET_COIL = _get_int("RESET_COIL", 0)
# How long the Pi holds the coil set (LOGO! may also enforce its own pulse).
RESET_HOLD_SEC = float(_get("RESET_HOLD_SEC", "1.0"))
# Minimum seconds between resets (server-side guard).
RESET_COOLDOWN_SEC = _get_int("RESET_COOLDOWN_SEC", 10)

# --- Weather (Ambient Weather WS-2902) -------------------------------------
# Informational readout only (wind + rain in the header). Does NOT gate reset.
WEATHER_ENABLED = _get_bool("WEATHER_ENABLED", True)
# Ambient Weather cloud API (station -> ambientweather.net). Local options exist
# too; the driver falls back to mock if keys are missing.
AMBIENT_API_KEY = _get("AMBIENT_API_KEY", "")
AMBIENT_APP_KEY = _get("AMBIENT_APP_KEY", "")

# --- History storage -------------------------------------------------------
DB_PATH = _get("DB_PATH", str(os.path.join(os.path.dirname(__file__), "..", "data", "watchdog.db")))
HISTORY_RETENTION_DAYS = _get_int("HISTORY_RETENTION_DAYS", 30)

# --- Alerting (email via Resend, optional) ---------------------------------
RESEND_API_KEY = _get("RESEND_API_KEY", "")
ALERT_EMAIL_FROM = _get("ALERT_EMAIL_FROM", "watchdog@heater.local")
ALERT_EMAIL_TO = _get("ALERT_EMAIL_TO", "")          # comma-separated
ALERT_EMAIL_MIN_SEVERITY = _get("ALERT_EMAIL_MIN_SEVERITY", "warning")  # warning | critical

# --- Cameras ---------------------------------------------------------------
# Three Hikvision RTSP cameras, re-served as WebRTC by MediaMTX (config/mediamtx.yml).
MEDIAMTX_BASE = _get("MEDIAMTX_BASE", "http://localhost:8889")
CAMERAS = [
    {"id": "cam-1", "name": _get("CAM1_NAME", "Burner"), "path": _get("CAM1_PATH", "cam1"), "rtsp": _get("CAM1_RTSP", "")},
    {"id": "cam-2", "name": _get("CAM2_NAME", "Tank"), "path": _get("CAM2_PATH", "cam2"), "rtsp": _get("CAM2_RTSP", "")},
    {"id": "cam-3", "name": _get("CAM3_NAME", "Belt"), "path": _get("CAM3_PATH", "cam3"), "rtsp": _get("CAM3_RTSP", "")},
]

# --- YOLO vision (runs on the Pi 5) ----------------------------------------
# In mock mode the engine emits synthetic detections so the overlay is demoable.
VISION_ENABLED = _get_bool("VISION_ENABLED", True)
VISION_MODEL = _get("VISION_MODEL", "yolov8n.pt")   # nano; upgrade for accuracy
VISION_FPS = float(_get("VISION_FPS", "2"))          # inference rate per camera
VISION_CONF = float(_get("VISION_CONF", "0.4"))      # min confidence
# Classes that raise an alert when they appear (COCO names). Note: fire/smoke
# need a custom-trained model — the stock YOLO does not include them.
VISION_ALERT_CLASSES = _get("VISION_ALERT_CLASSES", "person")
VISION_ALERT_COOLDOWN_SEC = _get_int("VISION_ALERT_COOLDOWN_SEC", 30)
# How often (seconds) to push the detection overlay to the dashboard.
VISION_BROADCAST_SEC = float(_get("VISION_BROADCAST_SEC", "0.5"))
