// Heater WatchDog dashboard.
// - Prefers FastAPI: /api/config + /ws + /api/history|/api/alerts|/api/reset
// - Falls back to Node-RED polling: GET /temp (or /api/temp|/api/readings),
//   POST /reset (after trying /api/reset)
// - Synthetic demo only when every plant endpoint fails
//
// When embedded from Fleet Manager, pass ?api=<WATCHDOG_URL> so config/WS/reset
// hit the live backend while this static UI is served from nepportal.com.

const el = (id) => document.getElementById(id);
let appConfig = null;
/** @type {"fastapi"|"nodered"|"demo"|null} */
let linkMode = null;
let demoMode = false;
let pollTimer = null;
let lastControllers = [];

const _apiParam = new URLSearchParams(location.search).get("api");
const API_BASE = (_apiParam || location.origin).replace(/\/$/, "");

const DEFAULT_THRESHOLDS = {
  warn_low_f: 300,
  warn_high_f: 450,
  crit_low_f: 300,
  crit_high_f: 450,
};

const NODE_RED_TEMP_PATHS = ["/temp", "/api/temp", "/api/readings"];
const POLL_MS = 2000;

function apiUrl(path) {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

function wsUrl() {
  try {
    const u = new URL(API_BASE);
    const proto = u.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${u.host}/ws`;
  } catch {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws`;
  }
}

function thresholds() {
  return (appConfig && appConfig.thresholds) || DEFAULT_THRESHOLDS;
}

function statusForTemp(temp_f) {
  const th = thresholds();
  if (temp_f == null || Number.isNaN(temp_f)) return "offline";
  if (temp_f >= th.crit_high_f || temp_f <= th.crit_low_f) return "critical";
  if (temp_f >= th.warn_high_f || temp_f <= th.warn_low_f) return "warn";
  return "ok";
}

// ---------------------------------------------------------------------------
// Flexible plant payload → controller cards
// ---------------------------------------------------------------------------
function asNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickTemp(obj) {
  if (obj == null || typeof obj !== "object") return null;
  for (const key of ["temp_f", "temp", "temperature", "value", "payload", "t"]) {
    const n = asNumber(obj[key]);
    if (n != null) return n;
  }
  return null;
}

function zoneName(item, index, total) {
  if (item && typeof item === "object") {
    const n = item.name || item.label || item.id || item.zone || item.controller_id;
    if (n) return String(n);
  }
  if (total <= 1) return "Heater Controller";
  return index === 0 ? "Heater Controller" : `Zone ${index + 1}`;
}

function zoneId(item, index) {
  if (item && typeof item === "object") {
    const id = item.controller_id || item.id || item.zone_id;
    if (id != null) return String(id);
  }
  return `ctrl-${index + 1}`;
}

function toController(temp_f, item, index, total) {
  const online = temp_f != null;
  const status = online ? statusForTemp(temp_f) : "offline";
  return {
    controller_id: zoneId(item, index),
    name: zoneName(item, index, total),
    temp_f: online ? temp_f : 0,
    setpoint_f: item && item.setpoint_f != null ? asNumber(item.setpoint_f) : null,
    online,
    status,
  };
}

/** Normalize any plant temp JSON into FastAPI-shaped controller rows. */
function parseTempPayload(data) {
  if (data == null) return null;

  const direct = asNumber(data);
  if (direct != null) return [toController(direct, null, 0, 1)];

  if (typeof data !== "object") return null;

  // FastAPI-style: { controllers: [...] } or { type:"readings", controllers }
  const list =
    Array.isArray(data.controllers) ? data.controllers
    : Array.isArray(data.zones) ? data.zones
    : Array.isArray(data.readings) ? data.readings
    : Array.isArray(data) ? data
    : null;

  if (list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item == null) continue;
      const n = asNumber(item);
      const temp = n != null ? n : pickTemp(item);
      if (temp == null && !(item && typeof item === "object" && "online" in item)) continue;
      const online = item && typeof item === "object" && "online" in item
        ? Boolean(item.online)
        : temp != null;
      const status =
        (item && item.status) ||
        (online ? statusForTemp(temp) : "offline");
      out.push({
        controller_id: zoneId(item, i),
        name: zoneName(item, i, list.length),
        temp_f: temp != null ? temp : 0,
        setpoint_f: item && item.setpoint_f != null ? asNumber(item.setpoint_f) : null,
        online,
        status,
      });
    }
    return out.length ? out : null;
  }

  const single = pickTemp(data);
  if (single != null) return [toController(single, data, 0, 1)];

  // Nested payload: { payload: { temp_f } } already covered by pickTemp;
  // also accept { heater: number, tank: number } style maps of numbers.
  const numericEntries = Object.entries(data).filter(([, v]) => asNumber(v) != null);
  if (numericEntries.length >= 1 && numericEntries.length <= 4) {
    return numericEntries.map(([key, v], i, arr) =>
      toController(asNumber(v), { name: key, id: key }, i, arr.length)
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Temperature rendering
// ---------------------------------------------------------------------------
function renderReadings(controllers) {
  lastControllers = controllers;
  const container = el("controllers");
  const seen = new Set();
  for (const c of controllers) {
    seen.add(c.controller_id);
    let card = document.getElementById(`ctrl-${c.controller_id}`);
    if (!card) {
      card = document.createElement("div");
      card.id = `ctrl-${c.controller_id}`;
      card.className = "card";
      card.innerHTML = `
        <div class="name"></div>
        <div class="temp"><span class="val">--</span><span class="unit">°F</span></div>
        <div class="meta">
          <span class="status-pill"></span>
        </div>`;
      container.appendChild(card);
    }
    card.className = `card ${c.status}`;
    card.querySelector(".name").textContent = c.name;
    card.querySelector(".val").textContent = c.online ? Number(c.temp_f).toFixed(1) : "—";
    const pill = card.querySelector(".status-pill");
    pill.textContent = c.online ? c.status : "no signal";
    pill.className = `status-pill status-${c.status}`;
  }
  // Drop cards for zones that disappeared (e.g. plant reports 1 zone after 2).
  for (const child of [...container.children]) {
    const id = child.id && child.id.startsWith("ctrl-") ? child.id.slice(5) : null;
    if (id && !seen.has(id)) child.remove();
  }
}

// ---------------------------------------------------------------------------
// Link badge: live | node-red | demo | reconnecting
// ---------------------------------------------------------------------------
function setLink(state) {
  const b = el("link");
  const labels = {
    live: "live",
    "node-red": "node-red",
    demo: "demo",
    reconnecting: "reconnecting…",
  };
  b.textContent = labels[state] || state;
  const cls =
    state === "live" ? "link-up"
    : state === "node-red" ? "link-nodered"
    : state === "demo" ? "link-demo"
    : "link-down";
  b.className = `badge ${cls}`;
}

// ---------------------------------------------------------------------------
// WebSocket with auto-reconnect (FastAPI)
// ---------------------------------------------------------------------------
function connect() {
  const ws = new WebSocket(wsUrl());

  ws.onopen = () => setLink("live");
  ws.onclose = () => {
    if (linkMode === "fastapi") {
      setLink("reconnecting");
      setTimeout(connect, 2000);
    }
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "readings") {
      renderReadings(msg.controllers);
    }
    if (msg.type === "alert") prependAlert(msg);
    if (msg.type === "event" && msg.event === "reset") {
      setResetStatus("Reset pulse sent ✓");
    }
  };
}

// ---------------------------------------------------------------------------
// Temperature history chart (hand-rolled SVG — no external libs)
// ---------------------------------------------------------------------------
const ZONE_COLORS = ["#60a5fa", "#fb923c", "#34d399", "#f472b6"];
let currentHours = 6;

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDateTime(ts) {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function loadHistory(hours) {
  currentHours = hours;
  if (demoMode) {
    drawChart(buildDemoHistory(hours));
    return;
  }
  if (linkMode === "nodered") {
    // Node-RED has no history API yet — keep empty chart (or last in-memory samples).
    drawChart({ hours, zones: nodeRedHistoryZones(hours), thresholds: thresholds() });
    return;
  }
  try {
    const data = await (await fetch(apiUrl(`/api/history?hours=${hours}`))).json();
    drawChart(data);
  } catch {
    drawChart({ hours, zones: [], thresholds: thresholds() });
  }
}

/** Rolling samples collected while polling Node-RED (best-effort chart). */
const nodeRedSamples = new Map(); // id -> { name, points: [{ts, temp_f}] }

function recordNodeRedHistory(controllers) {
  const now = Date.now() / 1000;
  const keep = 24 * 3600;
  for (const c of controllers) {
    let z = nodeRedSamples.get(c.controller_id);
    if (!z) {
      z = { id: c.controller_id, name: c.name, points: [] };
      nodeRedSamples.set(c.controller_id, z);
    }
    z.name = c.name;
    if (c.online) z.points.push({ ts: now, temp_f: c.temp_f });
    z.points = z.points.filter((p) => p.ts >= now - keep);
  }
}

function nodeRedHistoryZones(hours) {
  const cutoff = Date.now() / 1000 - hours * 3600;
  return [...nodeRedSamples.values()].map((z) => ({
    id: z.id,
    name: z.name,
    points: z.points.filter((p) => p.ts >= cutoff),
  }));
}

function drawChart(data) {
  const host = el("chart");
  const compact = window.matchMedia("(max-width: 720px)").matches;
  // Mobile chart is 50% taller than the prior 253 so the history panel reads
  // larger on phones without changing desktop layout.
  const W = 900, H = compact ? 380 : 300;
  const m = compact
    ? { t: 14, r: 64, b: 36, l: 72 }
    : { t: 16, r: 52, b: 28, l: 44 };
  const zones = (data.zones || []).filter((z) => z.points.length);
  el("chart-legend").innerHTML = zones
    .map((z, i) => `<span class="lg"><span class="sw" style="background:${ZONE_COLORS[i % ZONE_COLORS.length]}"></span>${z.name}</span>`)
    .join("");
  if (!zones.length) {
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="chart-empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">Collecting data…</text></svg>`;
    return;
  }

  let tMin = Infinity, tMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const z of zones) for (const p of z.points) {
    if (p.temp_f == null) continue;
    tMin = Math.min(tMin, p.ts); tMax = Math.max(tMax, p.ts);
    yMin = Math.min(yMin, p.temp_f); yMax = Math.max(yMax, p.temp_f);
  }
  const th = data.thresholds || {};
  if (th.crit_high_f != null) yMax = Math.max(yMax, th.crit_high_f);
  if (th.crit_low_f != null) yMin = Math.min(yMin, th.crit_low_f);
  yMax += 8;
  yMin -= 8;
  if (tMax === tMin) tMax = tMin + 1;

  const px = (t) => m.l + ((t - tMin) / (tMax - tMin)) * (W - m.l - m.r);
  const py = (v) => m.t + (1 - (v - yMin) / (yMax - yMin)) * (H - m.t - m.b);

  const svg = [];
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (i / 4) * (yMax - yMin);
    const y = py(v);
    svg.push(`<line class="chart-grid" x1="${m.l}" y1="${y}" x2="${W - m.r}" y2="${y}"/>`);
    const yBaseline = compact ? y + 8 : y + 3;
    const axisFs = compact ? ' font-size="24"' : "";
    svg.push(`<text class="chart-axis-label" x="${m.l - 6}" y="${yBaseline}" text-anchor="end"${axisFs}>${v.toFixed(0)}</text>`);
  }
  for (let i = 0; i <= 3; i++) {
    const t = tMin + (i / 3) * (tMax - tMin);
    const x = px(t);
    const xBaseline = compact ? H - 12 : H - 8;
    const axisFs = compact ? ' font-size="24"' : "";
    svg.push(`<text class="chart-axis-label" x="${x}" y="${xBaseline}" text-anchor="middle"${axisFs}>${fmtTime(t)}</text>`);
  }
  const threshLines = [
    [th.crit_high_f, "#e0433f", "CRIT"],
    [th.warn_high_f, "#d98324", "WARN"],
    [th.warn_low_f, "#d98324", "WARN"],
    [th.crit_low_f, "#e0433f", "CRIT"],
  ];
  for (const [v, color, label] of threshLines) {
    if (v == null) continue;
    if (label === "WARN" && (v === th.crit_high_f || v === th.crit_low_f)) continue;
    const y = py(v);
    svg.push(`<line class="chart-thresh" x1="${m.l}" y1="${y}" x2="${W - m.r}" y2="${y}" stroke="${color}"/>`);
    svg.push(`<text class="chart-thresh-label" x="${W - m.r + 4}" y="${y + 3}" fill="${color}">${label}</text>`);
  }
  zones.forEach((z, i) => {
    const color = ZONE_COLORS[i % ZONE_COLORS.length];
    const pts = z.points.filter((p) => p.temp_f != null);
    const d = pts.map((p, j) => `${j ? "L" : "M"}${px(p.ts).toFixed(1)},${py(p.temp_f).toFixed(1)}`).join(" ");
    svg.push(`<path class="chart-line" d="${d}" stroke="${color}"/>`);
  });
  svg.push(`<line class="chart-crosshair" id="xhair" x1="0" y1="${m.t}" x2="0" y2="${H - m.b}" style="opacity:0"/>`);
  svg.push(`<rect id="hitarea" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/>`);

  host.innerHTML = `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}">${svg.join("")}</svg><div class="chart-tooltip" id="chart-tip"></div></div>`;
  wireCrosshair(host, zones, { px, py, tMin, tMax, W, m });
}

function wireCrosshair(host, zones, ctx) {
  const svg = host.querySelector("svg");
  const tip = el("chart-tip");
  const xhair = host.querySelector("#xhair");
  const hit = host.querySelector("#hitarea");
  const zoneMaps = zones.map((z) => {
    const map = new Map(z.points.filter((p) => p.temp_f != null).map((p) => [p.ts, p.temp_f]));
    return { name: z.name, ts: [...map.keys()], map };
  });
  hit.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * ctx.W;
    const t = ctx.tMin + ((sx - ctx.m.l) / (ctx.W - ctx.m.l - ctx.m.r)) * (ctx.tMax - ctx.tMin);
    const base = zoneMaps[0].ts;
    let nearest = base[0];
    for (const ti of base) if (Math.abs(ti - t) < Math.abs(nearest - t)) nearest = ti;
    xhair.setAttribute("x1", ctx.px(nearest)); xhair.setAttribute("x2", ctx.px(nearest));
    xhair.style.opacity = 1;
    const rows = zoneMaps.map((z, i) =>
      `<span style="color:${ZONE_COLORS[i % ZONE_COLORS.length]}">${z.name}: ${z.map.has(nearest) ? z.map.get(nearest).toFixed(1) + "°" : "—"}</span>`
    ).join("<br>");
    tip.innerHTML = `${fmtTime(nearest)}<br>${rows}`;
    tip.style.left = (ctx.px(nearest) / ctx.W * 100) + "%";
    tip.style.top = "10px";
    tip.style.opacity = 1;
  });
  hit.addEventListener("mouseleave", () => { tip.style.opacity = 0; xhair.style.opacity = 0; });
}

function wireRangeTabs() {
  el("range-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    [...el("range-tabs").children].forEach((b) => b.classList.toggle("active", b === btn));
    loadHistory(Number(btn.dataset.hours));
  });
}

// ---------------------------------------------------------------------------
// Alerts feed
// ---------------------------------------------------------------------------
function alertRow(a) {
  const li = document.createElement("li");
  const sev = a.severity || "info";
  li.innerHTML =
    `<span class="alert-time">${fmtDateTime(a.ts)}</span>` +
    `<span class="alert-sev sev-${sev}">${sev}</span>` +
    `<span class="alert-msg">${a.message}</span>`;
  return li;
}
async function loadAlerts() {
  if (demoMode || linkMode === "nodered") return;
  try {
    const { alerts } = await (await fetch(apiUrl("/api/alerts"))).json();
    const list = el("alerts-list");
    list.innerHTML = alerts.length ? "" : '<li class="alert-empty">No alerts yet.</li>';
    alerts.forEach((a) => list.appendChild(alertRow(a)));
  } catch {
    /* ignore — alerts are best-effort on FastAPI */
  }
}
function prependAlert(a) {
  const list = el("alerts-list");
  const empty = list.querySelector(".alert-empty");
  if (empty) empty.remove();
  list.insertBefore(alertRow(a), list.firstChild);
}

// ---------------------------------------------------------------------------
// Reset button — FastAPI /api/reset first, then Node-RED /reset
// ---------------------------------------------------------------------------
function setResetStatus(text) {
  el("reset-status").textContent = text;
}

async function postReset(path) {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: "{}",
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text ? { raw: text } : null;
  }
  return { res, data };
}

function resetSucceeded(res, data) {
  if (!res.ok) return false;
  if (data && data.ok === false) return false;
  if (data && data.error) return false;
  // Node-RED often returns {} / "ok" / {ok:true} / empty 200
  return true;
}

async function sendReset() {
  const paths =
    linkMode === "nodered"
      ? ["/reset", "/api/reset"]
      : ["/api/reset", "/reset"];
  let lastErr = "unknown error";
  for (const path of paths) {
    try {
      const { res, data } = await postReset(path);
      if (resetSucceeded(res, data)) {
        return { ok: true, path };
      }
      lastErr = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    } catch (e) {
      lastErr = "network error";
    }
  }
  return { ok: false, error: lastErr };
}

function wireReset() {
  const btn = el("reset-btn");
  const dialog = el("confirm");
  btn.addEventListener("click", () => dialog.showModal());
  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "confirm") return;
    if (demoMode) {
      setResetStatus("Demo reset (no plant relay)");
      setTimeout(() => { btn.disabled = false; }, 1500);
      return;
    }
    btn.disabled = true;
    setResetStatus("Sending reset…");
    try {
      const result = await sendReset();
      if (result.ok) setResetStatus("Reset pulse sent ✓");
      else setResetStatus(`Reset failed: ${result.error || "unknown error"}`);
    } catch (e) {
      setResetStatus("Reset failed: network error");
    } finally {
      setTimeout(() => { btn.disabled = false; }, 5000);
    }
  });
}

// ---------------------------------------------------------------------------
// Node-RED / plant HTTP polling
// ---------------------------------------------------------------------------
async function fetchJson(path) {
  const res = await fetch(apiUrl(path), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const n = asNumber(text.trim());
    if (n != null) return n;
    throw new Error("non-json");
  }
}

async function probeNodeRedTemp() {
  for (const path of NODE_RED_TEMP_PATHS) {
    try {
      const data = await fetchJson(path);
      const controllers = parseTempPayload(data);
      if (controllers && controllers.length) {
        return { path, controllers };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

async function pollNodeRedOnce(preferredPath) {
  const order = preferredPath
    ? [preferredPath, ...NODE_RED_TEMP_PATHS.filter((p) => p !== preferredPath)]
    : NODE_RED_TEMP_PATHS;
  for (const path of order) {
    try {
      const data = await fetchJson(path);
      const controllers = parseTempPayload(data);
      if (controllers && controllers.length) {
        return { path, controllers };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function startNodeRed(initial) {
  linkMode = "nodered";
  demoMode = false;
  appConfig = appConfig || { hardware_mode: "nodered", thresholds: DEFAULT_THRESHOLDS };
  setLink("node-red");
  wireReset();
  wireRangeTabs();
  renderReadings(initial.controllers);
  recordNodeRedHistory(initial.controllers);
  drawChart({ hours: currentHours, zones: nodeRedHistoryZones(currentHours), thresholds: thresholds() });

  let preferred = initial.path;
  let misses = 0;
  pollTimer = setInterval(async () => {
    const hit = await pollNodeRedOnce(preferred);
    if (hit) {
      preferred = hit.path;
      misses = 0;
      setLink("node-red");
      renderReadings(hit.controllers);
      recordNodeRedHistory(hit.controllers);
    } else {
      misses += 1;
      setLink("reconnecting");
      if (lastControllers.length) {
        renderReadings(
          lastControllers.map((c) => ({ ...c, online: false, status: "offline" }))
        );
      }
      // After sustained failure we stay on node-red reconnecting — do not flip to demo mid-session.
      void misses;
    }
  }, POLL_MS);

  // Refresh the in-memory chart periodically.
  setInterval(() => {
    if (linkMode === "nodered") {
      drawChart({ hours: currentHours, zones: nodeRedHistoryZones(currentHours), thresholds: thresholds() });
    }
  }, 15000);
}

// ---------------------------------------------------------------------------
// Demo mode — used only when there is no backend to talk to (e.g. the static
// Vercel preview). It renders live temps + history from synthetic data so the
// dashboard is viewable without the Pi. It never runs when the backend responds.
// ---------------------------------------------------------------------------
const DEMO_CONFIG = {
  hardware_mode: "mock",
  weather_enabled: true,
  thresholds: { warn_low_f: 300, warn_high_f: 450, crit_low_f: 300, crit_high_f: 450 },
};
const ZONE_META = [
  { id: "ctrl-1", name: "Heater Controller" },
  { id: "ctrl-2", name: "Tank 1 Heat" },
];

function demoReadings(t) {
  return ZONE_META.map((z, i) => {
    const temp = 350 + 9 * Math.sin(t / 12 + i * 2) + (Math.random() - 0.5) * 3;
    const th = DEMO_CONFIG.thresholds;
    const status =
      temp >= th.crit_high_f || temp <= th.crit_low_f ? "critical"
      : temp >= th.warn_high_f || temp <= th.warn_low_f ? "warn"
      : "ok";
    return { controller_id: z.id, name: z.name, temp_f: temp, setpoint_f: 350, online: true, status };
  });
}

function buildDemoHistory(hours) {
  const now = Date.now() / 1000;
  const span = hours * 3600;
  const n = Math.max(40, Math.min(180, Math.round(hours * 20)));
  const zones = ZONE_META.map((z, i) => ({
    id: z.id,
    name: z.name,
    points: Array.from({ length: n }, (_, k) => {
      const ts = now - span + (k / Math.max(n - 1, 1)) * span;
      return { ts, temp_f: 350 + 9 * Math.sin(k / 6 + i * 2) + (Math.random() - 0.5) * 4 };
    }),
  }));
  return { hours, zones, thresholds: DEMO_CONFIG.thresholds };
}

function startDemo() {
  linkMode = "demo";
  demoMode = true;
  setLink("demo");
  wireReset();
  wireRangeTabs();
  renderReadings(demoReadings(0));
  drawChart(buildDemoHistory(currentHours));

  const now = Date.now() / 1000;
  [
    { ts: now - 120, severity: "warning", message: "Person detected on Burner camera (86%)" },
    { ts: now - 300, severity: "info", message: "Heater reset commanded via LOGO!" },
    { ts: now - 900, severity: "critical", message: "Tank 1 Heat entered CRITICAL at 431°F" },
    { ts: now - 1100, severity: "info", message: "Tank 1 Heat cooled to WARN (398°F)" },
  ].forEach((a) => prependAlert(a));

  let t = 0;
  setInterval(() => {
    t += 1;
    renderReadings(demoReadings(t));
  }, 2000);
}

function startFastApi() {
  linkMode = "fastapi";
  demoMode = false;
  setLink("reconnecting");
  wireReset();
  wireRangeTabs();
  loadHistory(currentHours);
  loadAlerts();
  connect();
  setInterval(() => loadHistory(currentHours), 15000);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  // 1) Prefer FastAPI when /api/config answers.
  try {
    const res = await fetch(apiUrl("/api/config"), { headers: { Accept: "application/json" } });
    if (res.ok) {
      appConfig = await res.json();
      startFastApi();
      return;
    }
  } catch {
    /* fall through to Node-RED */
  }

  // 2) Node-RED / plant HTTP: GET /temp (and aliases).
  setLink("reconnecting");
  const plant = await probeNodeRedTemp();
  if (plant) {
    startNodeRed(plant);
    return;
  }

  // 3) Nothing reachable — synthetic demo only.
  appConfig = DEMO_CONFIG;
  startDemo();
}

boot();
