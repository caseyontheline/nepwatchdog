// Heater Watchdog dashboard.
// - subscribes to /ws for live temperature readings
// - renders temp cards + camera tiles
// - guards the reset button behind a confirm dialog

const el = (id) => document.getElementById(id);
let appConfig = null;

// ---------------------------------------------------------------------------
// Temperature rendering
// ---------------------------------------------------------------------------
function renderReadings(controllers) {
  const container = el("controllers");
  for (const c of controllers) {
    let card = document.getElementById(`ctrl-${c.controller_id}`);
    if (!card) {
      card = document.createElement("div");
      card.id = `ctrl-${c.controller_id}`;
      card.className = "card";
      card.innerHTML = `
        <div class="name"></div>
        <div class="temp"><span class="val">--</span><span class="unit">°F</span></div>
        <div class="meta">
          <span class="setpoint"></span>
          <span class="status-pill"></span>
        </div>`;
      container.appendChild(card);
    }
    card.className = `card ${c.status}`;
    card.querySelector(".name").textContent = c.name;
    card.querySelector(".val").textContent = c.online ? c.temp_f.toFixed(1) : "—";
    card.querySelector(".setpoint").textContent = c.online
      ? `Setpoint ${c.setpoint_f.toFixed(0)}°F`
      : "no signal";
    const pill = card.querySelector(".status-pill");
    pill.textContent = c.status;
    pill.className = `status-pill status-${c.status}`;
  }
}

// ---------------------------------------------------------------------------
// WebSocket with auto-reconnect
// ---------------------------------------------------------------------------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => setLink(true);
  ws.onclose = () => {
    setLink(false);
    setTimeout(connect, 2000); // reconnect
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "readings") {
      renderReadings(msg.controllers);
      renderWeather(msg.weather);
    }
    if (msg.type === "vision") renderDetections(msg.cameras);
    if (msg.type === "alert") prependAlert(msg);
    if (msg.type === "event" && msg.event === "reset") {
      setResetStatus("Reset pulse sent ✓");
    }
  };
}

// Weather chip — informational readout only (does not gate the reset).
function renderWeather(w) {
  const chip = el("weather");
  if (!w) { chip.textContent = "weather –"; return; }
  if (!w.online) {
    chip.textContent = "weather offline";
    chip.className = "badge";
  } else {
    const rain = w.raining ? "🌧" : "☀";
    chip.textContent = `${rain} ${w.wind_mph} mph`;
    chip.className = "badge";
  }
}

function setLink(up) {
  const b = el("link");
  b.textContent = up ? "live" : "reconnecting…";
  b.className = `badge ${up ? "link-up" : "link-down"}`;
}

// ---------------------------------------------------------------------------
// Cameras (WebRTC via MediaMTX WHEP)
// ---------------------------------------------------------------------------
function renderCameras(cameras) {
  const container = el("cameras");
  for (const cam of cameras) {
    const tile = document.createElement("div");
    tile.className = "cam";
    tile.dataset.cam = cam.id;
    const aiBadge = appConfig.vision_enabled ? '<div class="cam-ai">AI</div>' : "";
    tile.innerHTML = `<video autoplay muted playsinline></video>
                      <div class="cam-overlay"></div>
                      ${aiBadge}
                      <div class="label">${cam.name}</div>`;
    container.appendChild(tile);
    startWhep(tile.querySelector("video"), cam, tile);
  }
}

// YOLO detection overlay. Boxes arrive in normalized coords, so we place them
// as percentages over the tile. Watched classes (e.g. person) are highlighted.
const DET_ALERT_CLASSES = new Set(["person"]);
function renderDetections(cameras) {
  for (const [camId, dets] of Object.entries(cameras || {})) {
    const tile = document.querySelector(`.cam[data-cam="${camId}"]`);
    if (!tile) continue;
    const overlay = tile.querySelector(".cam-overlay");
    overlay.innerHTML = dets
      .map((d) => {
        const alert = DET_ALERT_CLASSES.has(d.cls);
        return (
          `<div class="det ${alert ? "det-alert" : ""}" style="left:${d.x * 100}%;top:${d.y * 100}%;` +
          `width:${d.w * 100}%;height:${d.h * 100}%">` +
          `<span class="det-tag">${d.cls} ${Math.round(d.conf * 100)}%</span></div>`
        );
      })
      .join("");
  }
}

// Minimal WHEP (WebRTC-HTTP Egress Protocol) client — MediaMTX serves this at
// <webrtc-url>/whep. Keeps the page dependency-free.
async function startWhep(video, cam, tile) {
  try {
    const pc = new RTCPeerConnection();
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.ontrack = (e) => { video.srcObject = e.streams[0]; };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const res = await fetch(`${cam.webrtc}/whep`, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (!res.ok) throw new Error(`WHEP ${res.status}`);
    const answer = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  } catch (err) {
    const msg = document.createElement("div");
    msg.className = "offline-msg";
    msg.textContent = `Camera offline (${cam.name}) — check RTSP → MediaMTX`;
    tile.appendChild(msg);
  }
}

// ---------------------------------------------------------------------------
// Reset button
// ---------------------------------------------------------------------------
function setResetStatus(text) {
  el("reset-status").textContent = text;
}

function wireReset() {
  const btn = el("reset-btn");
  const dialog = el("confirm");
  btn.addEventListener("click", () => dialog.showModal());
  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "confirm") return;
    btn.disabled = true;
    setResetStatus("Sending reset…");
    try {
      const res = await fetch("/api/reset", { method: "POST" });
      const data = await res.json();
      if (!data.ok) setResetStatus(`Reset failed: ${data.error}`);
    } catch (e) {
      setResetStatus("Reset failed: network error");
    } finally {
      setTimeout(() => { btn.disabled = false; }, 5000);
    }
  });
}

// ---------------------------------------------------------------------------
// Temperature history chart (hand-rolled SVG — no external libs)
// Two zones as a colorblind-safe categorical pair, each direct-labeled;
// warn/critical drawn as recessive dashed reference lines.
// ---------------------------------------------------------------------------
const ZONE_COLORS = ["#3366cc", "#ee7733"]; // fixed order, validated CVD-safe
let currentHours = 6;

async function loadHistory(hours) {
  currentHours = hours;
  const data = await (await fetch(`/api/history?hours=${hours}`)).json();
  drawChart(data);
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function drawChart(data) {
  const host = el("chart");
  const W = 900, H = 300, m = { t: 16, r: 52, b: 28, l: 44 };
  const zones = data.zones.filter((z) => z.points.length);
  // Legend (identity in text, not color-alone — covers the orange contrast WARN)
  el("chart-legend").innerHTML = zones
    .map((z, i) => `<span class="lg"><span class="sw" style="background:${ZONE_COLORS[i % ZONE_COLORS.length]}"></span>${z.name}</span>`)
    .join("");
  if (!zones.length) {
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="chart-empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">Collecting data…</text></svg>`;
    return;
  }

  // Domains
  let tMin = Infinity, tMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const z of zones) for (const p of z.points) {
    if (p.temp_f == null) continue;
    tMin = Math.min(tMin, p.ts); tMax = Math.max(tMax, p.ts);
    yMin = Math.min(yMin, p.temp_f); yMax = Math.max(yMax, p.temp_f);
  }
  const warn = data.thresholds.warn_f, crit = data.thresholds.crit_f;
  yMax = Math.max(yMax, crit) + 8;
  yMin = Math.min(yMin, warn) - 8;
  if (tMax === tMin) tMax = tMin + 1;

  const px = (t) => m.l + ((t - tMin) / (tMax - tMin)) * (W - m.l - m.r);
  const py = (v) => m.t + (1 - (v - yMin) / (yMax - yMin)) * (H - m.t - m.b);

  const svg = [];
  // Horizontal gridlines + y labels (5 ticks)
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (i / 4) * (yMax - yMin);
    const y = py(v);
    svg.push(`<line class="chart-grid" x1="${m.l}" y1="${y}" x2="${W - m.r}" y2="${y}"/>`);
    svg.push(`<text class="chart-axis-label" x="${m.l - 6}" y="${y + 3}" text-anchor="end">${v.toFixed(0)}°</text>`);
  }
  // X time labels (4 ticks)
  for (let i = 0; i <= 3; i++) {
    const t = tMin + (i / 3) * (tMax - tMin);
    const x = px(t);
    svg.push(`<text class="chart-axis-label" x="${x}" y="${H - 8}" text-anchor="middle">${fmtTime(t)}</text>`);
  }
  // Threshold reference lines
  for (const [v, color, label] of [[warn, "#d98324", "WARN"], [crit, "#e0433f", "CRIT"]]) {
    const y = py(v);
    svg.push(`<line class="chart-thresh" x1="${m.l}" y1="${y}" x2="${W - m.r}" y2="${y}" stroke="${color}"/>`);
    svg.push(`<text class="chart-thresh-label" x="${W - m.r + 4}" y="${y + 3}" fill="${color}">${label}</text>`);
  }
  // Zone lines + end labels
  zones.forEach((z, i) => {
    const color = ZONE_COLORS[i % ZONE_COLORS.length];
    const pts = z.points.filter((p) => p.temp_f != null);
    const d = pts.map((p, j) => `${j ? "L" : "M"}${px(p.ts).toFixed(1)},${py(p.temp_f).toFixed(1)}`).join(" ");
    svg.push(`<path class="chart-line" d="${d}" stroke="${color}"/>`);
  });
  // Crosshair + hover targets
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
    const sx = ((e.clientX - r.left) / r.width) * ctx.W; // svg-space x
    const t = ctx.tMin + ((sx - ctx.m.l) / (ctx.W - ctx.m.l - ctx.m.r)) * (ctx.tMax - ctx.tMin);
    // nearest ts from first zone
    const base = zoneMaps[0].ts;
    let nearest = base[0];
    for (const ti of base) if (Math.abs(ti - t) < Math.abs(nearest - t)) nearest = ti;
    xhair.setAttribute("x1", ctx.px(nearest)); xhair.setAttribute("x2", ctx.px(nearest));
    xhair.style.opacity = 1;
    const rows = zoneMaps.map((z, i) =>
      `<span style="color:${ZONE_COLORS[i]}">${z.name}: ${z.map.has(nearest) ? z.map.get(nearest).toFixed(1) + "°" : "—"}</span>`
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
const SEV_ICON = { critical: "🔴", warning: "🟠", info: "•" };
function alertRow(a) {
  const li = document.createElement("li");
  const sev = a.severity || "info";
  li.innerHTML =
    `<span class="alert-time">${fmtTime(a.ts)}</span>` +
    `<span class="alert-sev sev-${sev}">${SEV_ICON[sev] || ""} ${sev}</span>` +
    `<span class="alert-msg">${a.message}</span>`;
  return li;
}
async function loadAlerts() {
  const { alerts } = await (await fetch("/api/alerts")).json();
  const list = el("alerts-list");
  list.innerHTML = alerts.length ? "" : '<li class="alert-empty">No alerts yet.</li>';
  alerts.forEach((a) => list.appendChild(alertRow(a)));
}
function prependAlert(a) {
  const list = el("alerts-list");
  const empty = list.querySelector(".alert-empty");
  if (empty) empty.remove();
  list.insertBefore(alertRow(a), list.firstChild);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  appConfig = await (await fetch("/api/config")).json();
  el("mode").textContent = appConfig.hardware_mode === "real" ? "live hw" : "mock hw";
  renderCameras(appConfig.cameras);
  wireReset();
  wireRangeTabs();
  await loadHistory(currentHours);
  await loadAlerts();
  connect();
  // Refresh the chart periodically so it keeps extending.
  setInterval(() => loadHistory(currentHours), 15000);
}

boot();
