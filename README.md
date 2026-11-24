# Heater Watchdog

Web dashboard for monitoring a Heatec asphalt heater: two temperature zones,
three camera feeds, a weather readout, and a **Reset Heater** button. Runs on
a Raspberry Pi 5 on-site, and anywhere in **mock mode** for development.

The static page prefers **FastAPI** when available (`/api/config`, `/ws`,
`/api/reset`, history, alerts). Otherwise it polls plant **Node-RED**
(`GET /temp` and aliases, `POST /reset`). Synthetic **demo** mode runs only
when nothing answers. For live plant data from nepwatchdog.com, set a tunnel
URL and open with `?api=` (or host the API on this domain).

## Hardware topology

```
Heatec controllers ──4-20mA/0-10V──► MINI MCR isolators ──► Siemens LOGO! 8.3
                                                                  │  (Modbus TCP)
Raspberry Pi 5 ◄──────────────────── Modbus TCP ──────────────────┘
   │   reads zone temps + commands reset
   └─► LOGO! ──► Phoenix Contact PLC-REL relay ──► heater reset circuit

3x Hikvision cams ──PoE (TP-Link SG1005P)──► Pi ──► MediaMTX ──► WebRTC ──► browser
Ambient Weather WS-2902 ──► weather readout (informational; does not gate reset)
GL.iNet Flint 2 (Starlink) ──► network
```

The **LOGO! is the single control point**: the Pi reads both temperatures from
it and commands the reset through it, all over Modbus TCP. No Pi GPIO wiring.

## App architecture

- **backend/** — FastAPI. Polls the LOGO! + weather, streams over `/ws`,
  exposes `POST /api/reset` (rate-limited), `GET /api/history`, `GET /api/alerts`.
- **backend/drivers/** — `temperature.py` (LOGO! Modbus read / mock),
  `relay.py` (LOGO! reset command / mock), `weather.py` (Ambient Weather / mock).
- **backend/store.py** — SQLite history (readings + alerts) with retention/prune.
- **backend/alerts.py** — edge-triggered alert engine + notifiers (log + Resend email).
- **frontend/** — dependency-free dashboard: temp cards, temperature-history
  chart (hand-rolled SVG, 1H/6H/24H), 3 camera tiles, live alerts feed, weather
  chip, guarded reset. NEP Fleet Manager theme.
- **config/mediamtx.yml** — Hikvision RTSP → browser WebRTC.

## History & alerting

- Every poll is logged to SQLite (`DB_PATH`, default `data/watchdog.db`), kept
  `HISTORY_RETENTION_DAYS` days. The chart reads downsampled series per zone.
- Alerts fire on **state changes** (not every poll): a zone crossing
  warn/critical, a controller going offline (and recovery), a vision detection
  (e.g. person), and reset commands. They show in the live feed and are stored.
- **Email**: set `RESEND_API_KEY` + `ALERT_EMAIL_TO` to get warning/critical
  alerts emailed via Resend. Without keys it's log-only.

## Run locally (mock hardware)

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000 — simulated temps, fair-weather chip, mock reset.

## Deploy on the Raspberry Pi 5

1. `cp .env.example .env`, set `HW_MODE=real` and fill in real values.
2. `pip install pymodbus` (Modbus TCP to the LOGO!).
3. In the **LOGO! program**, expose: two analog values in holding registers
   (set `CTRL*_REG`/`SCALE`/`OFFSET` to match) and a reset marker coil
   (`RESET_COIL`) that fires the timed relay pulse.
4. Set the LOGO!'s IP in `LOGO_HOST` (LOGO! Modbus/TCP enabled on the Ethernet port).
5. Cameras: put the 3 Hikvision RTSP URLs in `config/mediamtx.yml`, run MediaMTX.
6. Weather: put Ambient Weather API + app keys in `.env` (from ambientweather.net).
7. Run the backend (a `systemd` service is recommended for boot-start).

## Still to wire up / confirm

- **LOGO! register + coil map** — the exact holding-register addresses for each
  zone temp and the reset coil, from your LOGO! program.
- **Analog scaling** — `CTRL*_SCALE`/`OFFSET` so raw LOGO! counts read out in °F.
- **Hikvision RTSP URLs** and **Ambient Weather API keys**.

## YOLO vision

- **backend/vision.py** runs a YOLO detector per camera (one thread each) over
  the RTSP substreams. Detections are pushed to the dashboard as a live
  bounding-box **overlay** on each tile, and watched classes (default
  `person`) raise a debounced **alert** into the same feed/email pipeline.
- Real mode uses `ultralytics` + `opencv-python-headless` (install on the Pi);
  off-Pi a mock detector emits synthetic boxes so the overlay is demoable.
- Tuning: `VISION_MODEL`, `VISION_FPS`, `VISION_CONF`, `VISION_ALERT_CLASSES`,
  `VISION_ALERT_COOLDOWN_SEC` (see `.env.example`).
- **Note:** stock YOLO (COCO) detects `person`, `truck`, etc. — **not fire or
  smoke**. Flame/smoke detection needs a custom-trained model; point
  `VISION_MODEL` at it and add its class names to `VISION_ALERT_CLASSES`.
- **Performance:** a Pi 5 runs yolov8n on CPU at a few fps; for higher rates or
  bigger models add a Hailo-8 or Coral accelerator.

## Future ideas

- Auto-reset-on-critical rule, quiet hours, SMS.
- Custom flame/smoke model for burner-out detection.

## Configuration

All settings are environment variables — see `.env.example`.
