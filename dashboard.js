"use strict";
/* =====================================================================================================
   SCU Smart Waste Dashboard: STARTER PROTOTYPE (PROG6002)

   WHAT THIS FILE DOES
     1. Connects to an MQTT broker over WebSockets and subscribes to your topic(s).
     2. Every message that arrives goes through handleMessage(), which decides what kind of message it is.
     3. The message updates the in-memory STATE (devices, bins, events).
     4. renderAll() redraws the page from STATE.  Data flows one way:   MQTT -> STATE -> screen.

   HOW TO READ IT (top to bottom)
     A. CONFIG        settings you are expected to change
     B. STATE         the data the dashboard holds
     C. MQTT          connect / subscribe / receive
     D. MESSAGES      turning JSON into STATE  <- edit this if you change the message format in app.js
     E. CALCULATIONS  bin level, statistics
     F. RENDERING     STATE -> HTML (bin cards, KPIs, tables, charts)
     G. MAP           Leaflet map
     H. SIMULATOR     fake data so you can work without a tablet
     I. WIRING        buttons, start-up

   MESSAGES THIS DASHBOARD UNDERSTANDS  (see also the long comment above buildPayload() in app.js)

     1. "waste_classification": published by the tablet each time it sorts an item.
        {
          "message_type": "waste_classification",
          "device_id": "team01-tablet01",
          "sequence": 12, "timestamp": "2026-03-10T02:15:00.000Z",
          "classification": "bottle", "confidence": 0.93,
          "bin": "yellow",                          // key of BINS in bins.js: red | yellow | green | ewaste | null
          "location": { "latitude": -28.8034, "longitude": 153.2886, "accuracy_m": 10 }   // or null
        }

     2. "bin_status": NOT sent by the tablet. This is what a real smart bin (ESP32 + ultrasonic sensor, or
        a second browser tab) would publish. It gives a MEASURED fill level. Your team decides who sends it.
        {
          "message_type": "bin_status",
          "device_id": "team01-tablet01",
          "timestamp": "2026-03-10T02:15:00.000Z",
          "bins": { "yellow": { "level_pct": 63 }, "red": { "level_pct": 20 } },
          "battery_pct": 87,                        // optional
          "location": { "latitude": -28.8034, "longitude": 153.2886 }   // optional
        }

   Without bin_status messages the dashboard ESTIMATES each bin's level from how many items were sorted into
   it (items / CONFIG.binCapacity). Estimated and measured levels are labelled differently on the cards.

   SECURITY NOTE: a public broker lets anyone publish to your topic. Never put message text into innerHTML.
   This file only uses textContent (through the el() helper), so a malicious "classification" cannot inject HTML.
   ===================================================================================================== */

// Optional university bins.js can override these standalone defaults.
const BIN_DEFS = typeof BINS !== "undefined" ? BINS : {
  red: {name:"Landfill", colour:"#d92d20", description:"Single bin mapping is configurable above."},
  yellow: {name:"Recycling", colour:"#e8a200", description:"Recyclable materials"},
  green: {name:"Organic", colour:"#12a150", description:"Organic waste"},
  ewaste: {name:"E-waste", colour:"#7560b5", description:"Electronic waste"}
};
const $ = (id) => document.getElementById(id);

/* =====================================================================================================
   A. CONFIG: the settings most likely to need changing
   ===================================================================================================== */
const CONFIG = {
  // Must match the tablet (index.html): "Broker WebSocket URL". Browsers need wss:// (or ws:// on http pages).
  brokerUrl: "wss://32e9cffe913242f1bcfa250b379e19aa.s1.eu.hivemq.cloud:8884/mqtt",

  // Must match (or be a wildcard of) the tablet's "Publish topic". Separate several topics with commas.
  // "prog6002/2026/team01-tablet01/#"  everything below one device's topic
  // "prog6002/2026/+/classification"   the classification topic of every device (+ = any one level)
  topicFilter: "smartbin/BIN001/#,prog6002/2026/team01-tablet01/classification",

  // Only used when a bin has NOT reported a measured level: how many items fill one bin (estimate).
  // Keys must exist in BINS (bins.js). Add a key here if you add a bin there.
  binCapacity: { red: 20, yellow: 20, green: 20, ewaste: 10 },

  // Traffic-light thresholds, as % full.
  warnPct: 70,     // amber at or above this
  fullPct: 85,     // red ("needs emptying") strictly above this

  // A device that has sent nothing for this long is shown as offline.
  offlineAfterMs: 5 * 60 * 1000,

  // Map start position (SCU Lismore campus). The map moves to your devices once they report a location.
  mapCentre: [-28.8034, 153.2886],
  mapZoom: 15,

  maxEvents: 2000,        // how many classifications to remember (oldest are dropped)
  timelineMinutes: 30     // width of the activity chart
};

/* =====================================================================================================
   B. STATE: everything the screen is drawn from
   ===================================================================================================== */
const BIN_KEYS = Object.keys(BIN_DEFS);      // ["red","yellow","green","ewaste"], from bins.js, so both pages agree

// devices: Map of device_id -> {
//   id, lastSeen (ms), location: {lat,lng,accuracy}|null, battery (%)|null, unsorted (count),
//   bins: { red: { total, sinceEmptied, sensorLevel (%|null) }, yellow: {...}, ... }
// }
const devices = new Map();
// events: newest LAST. Each: { t (ms), device, label, bin, confidence }
let events = [];
const seenKeys = new Set();     // used to drop duplicate deliveries (MQTT QoS 1 can deliver a message twice)
let client = null;              // the MQTT client (null when disconnected)
let messageCount = 0;

function getDevice(id) {
  if (!devices.has(id)) {
    devices.set(id, {
      id, lastSeen: 0, location: null, battery: null, unsorted: 0,
      bins: Object.fromEntries(BIN_KEYS.map(k => [k, { total: 0, sinceEmptied: 0, sensorLevel: null }]))
    });
    refreshDeviceSelect();
  }
  return devices.get(id);
}

/* =====================================================================================================
   C. MQTT: connect, subscribe, receive
   ===================================================================================================== */
function setStatus(text, kind) {
  const pill = $("mqttStatus");
  pill.textContent = text;
  pill.className = "pill" + (kind ? " " + kind : "");
}

function connect() {
  if (client) {
    const old = client; client = null; old.end(true);
    setStatus("Disconnected"); $("connectButton").textContent = "Connect";
    scheduleRender(); return;
  }
  if (typeof mqtt === "undefined") { setStatus("MQTT library failed to load", "bad"); return; }
  const url = $("brokerUrl").value.trim();
  const topics = $("topicFilter").value.split(",").map(s => s.trim()).filter(Boolean);
  if (!url.startsWith("wss://") || !topics.length) {
    setStatus("Enter a wss:// broker URL and topic", "warn"); return;
  }
  saveInputs();
  setStatus("Connecting…", "warn");
  try {
    client = mqtt.connect(url, {
      clientId: "dashboard-" + Math.random().toString(16).slice(2),
      username: $("mqttUsername").value.trim(), password: $("mqttPassword").value,
      clean: true, queueQoSZero: false, reconnectPeriod: 3000, connectTimeout: 10000
    });
  } catch (err) { setStatus("Connection failed: " + err.message, "bad"); return; }
  const connection = client;
  $("connectButton").textContent = "Disconnect";
  connection.on("connect", () => {
    if (client !== connection) return;
    // Require a fresh heartbeat after a dashboard reconnect.
    for (const d of devices.values()) if (d.pico) d.pico.lastHeartbeat = 0;
    setStatus("Connected", "ok");
    connection.subscribe(topics, {qos:1}, (err, granted) => {
      if (client !== connection) return;
      if (err) setStatus("Subscribe failed: " + err.message, "bad");
      else if ((granted || []).some(g => g.qos === 128)) setStatus("Subscription denied: check topic permissions", "bad");
    });
  });
  for (const event of ["reconnect", "offline", "close"]) connection.on(event, () => {
    if (client === connection) { setStatus("Connection unavailable / reconnecting", "warn"); scheduleRender(); }
  });
  connection.on("error", err => {
    if (client === connection) setStatus("Error: " + err.message, "bad");
  });
  connection.on("message", (topic, message, packet) => {
    if (client === connection) handleMessage(topic, message.toString(), packet);
  });
}

/* =====================================================================================================
   D. MESSAGES: turn incoming JSON into STATE
   To support a NEW message type: add a case to the switch in handleMessage() and write a handler like
   handleBinStatus(). If you change field names in app.js buildPayload(), update the handlers here to match.
   ===================================================================================================== */
function handleMessage(topic, text, packet = {}) {
  messageCount += 1;
  logRaw(topic, text);
  latestPayloads.set(topic, text);
  if (latestPayloads.size > 100) latestPayloads.delete(latestPayloads.keys().next().value);

  let msg;
  try { msg = JSON.parse(text); } catch { return; }              // not JSON: ignore (it still shows in the raw log)
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;

  if (handleBinLocation(topic, msg)) { scheduleRender(); return; }
  if (handlePico(topic, msg, packet)) { scheduleRender(); return; }

  switch (msg.message_type) {
    case "waste_classification": handleClassification(msg); break;
    case "bin_status":           handleBinStatus(msg); break;
    // case "my_new_type":       handleMyNewType(msg); break;    // <- your own message types go here
    default: break;                                              // unknown type: ignore it, never crash on it
  }
  scheduleRender();
}

// Pico messages have no message_type; route them by their exact MQTT suffix.
// Only fresh, non-retained heartbeats prove liveness. Queued telemetry does not.
function handlePico(topic, msg, packet) {
  const match = /^smartbin\/([^/]+)\/(telemetry|heartbeat|status|lid\/status|command\/ack|alerts)$/.exec(topic);
  if (!match) return false;
  if (msg.bin_id !== match[1]) return true;
  const d = getDevice(msg.bin_id);
  const p = d.pico || (d.pico = {boot:null, seq:-1, lastHeartbeat:0,
    retired:new Set(), pending:new Map(), sample:null, sampleUptime:-1, lid:null});
  const kind = match[2];
  if (kind === "heartbeat" && msg.boot_id === undefined && msg.status === "alive" && Number.isFinite(msg.uptime_seconds)) {
    if (packet.retain) return true;
    p.legacy = true;
    if (p.lastHeartbeat && msg.uptime_seconds * 1000 < p.heartbeatUptime) {
      p.sample = null; p.sampleUptime = -1;
      if (pendingCommand?.device === d.id) {pendingCommand=null; commandNotice="Pico restarted; command outcome unknown.";}
    }
    p.heartbeatUptime = msg.uptime_seconds * 1000;
    p.lastHeartbeat = d.lastSeen = Date.now(); p.offline = false;
    return true;
  }
  if (kind === "telemetry" && msg.boot_id === undefined && Number.isFinite(msg.uptime_seconds)) {
    // This firmware puts its boot identifier inside message_id, not in a separate field.
    const id = typeof msg.message_id === "string" ? msg.message_id : "";
    const boot = id.includes("-") ? id.slice(0,id.lastIndexOf("-")) : null;
    if (boot && p.retired.has(boot)) return true;
    if (boot && p.sampleBoot !== boot) {
      if (p.sampleBoot) p.retired.add(p.sampleBoot);
      if (p.retired.size > 16) p.retired.delete(p.retired.values().next().value);
      p.sampleBoot=boot; p.sampleUptime=-1;
    }
    applyPicoTelemetry(d,msg); return true;
  }
  if (kind === "status" && msg.status === "offline") {p.offline=true; return true;}
  if (kind === "alerts") {p.condition=msg.condition; return true;}
  if (kind === "heartbeat") {
    if (packet.retain || msg.status !== "alive" || typeof msg.boot_id !== "string" ||
        !Number.isFinite(msg.uptime_ms) || !Number.isInteger(msg.seq) || p.retired.has(msg.boot_id)) return true;
    if (p.boot !== msg.boot_id) {
      if (p.boot) p.retired.add(p.boot);
      if (p.retired.size > 16) p.retired.delete(p.retired.values().next().value);
      p.boot = msg.boot_id; p.lastSentSeq = 0; p.seq = -1; p.sample = null; p.sampleUptime = -1; p.lid = null;
    }
    if (msg.seq <= p.seq) return true;
    p.legacy = false; p.offline = false;
    p.seq = msg.seq; p.heartbeatUptime = msg.uptime_ms;
    p.nextCommandSeq = msg.next_command_seq;
    p.lastHeartbeat = d.lastSeen = Date.now();
    const pending = p.pending.get(p.boot);
    if (pending) applyPicoTelemetry(d, pending);
    p.pending.clear();
  } else if (kind === "telemetry") {
    if (typeof msg.boot_id !== "string" || !Number.isFinite(msg.uptime_seconds) || p.retired.has(msg.boot_id)) return true;
    if (p.boot === msg.boot_id) applyPicoTelemetry(d, msg);
    else {
      const old = p.pending.get(msg.boot_id);
      if (!old || msg.uptime_seconds > old.uptime_seconds) p.pending.set(msg.boot_id, msg);
      if (p.pending.size > 4) p.pending.delete(p.pending.keys().next().value);
    }
  } else if (kind === "lid/status" && ["open", "closed"].includes(msg.state)) {
    if (!packet.retain && pendingCommand?.device === d.id && pendingCommand.payload.command_id === msg.command_id) {
      commandNotice = d.id+": Pico reports lid "+msg.state+" for this command.";
      pendingCommand=null;
    }
    p.lid = msg.state; // Reported command state, not a physical position sensor.
  } else if (kind === "command/ack") {
    p.ack = String(msg.status || "unknown");
    receiveCommandAck(d, msg);
    if (msg.boot_id === p.boot && ["open", "closed"].includes(msg.state)) p.lid = msg.state;
  }
  // Retained online/offline status is visible in raw messages, not used as proof of liveness.
  return true;
}
function applyPicoTelemetry(d, msg) {
  const p = d.pico;
  if (!Number.isFinite(msg.uptime_seconds) || msg.uptime_seconds<0 || msg.uptime_seconds <= p.sampleUptime) return;
  p.sampleUptime = msg.uptime_seconds; p.sample = msg;
}
function picoAge(p) {
  if (!p.sample || !p.lastHeartbeat) return Infinity;
  return Math.max(0, p.heartbeatUptime + Date.now() - p.lastHeartbeat - p.sampleUptime * 1000);
}
function fullestLevel(d) {
  const values = BIN_KEYS.map(k => binLevel(d,k).pct).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}
function deviceStatus(d) {
  if (d.location?.fix && !d.pico) return "GPS gateway only; awaiting Pico";
  if (d.pico && !client?.connected) return "Unknown (dashboard disconnected)";
  if (d.pico && !d.pico.lastHeartbeat) return "Awaiting heartbeat";
  return isOnline(d) ? "Online" : "Offline / heartbeat overdue";
}
function renderPicoDetails(list) {
  const rows = list.filter(d => d.pico).map(d => {
    const p = d.pico, m = p.sample || {};
    const num = (v, suffix) => Number.isFinite(v) ? v.toFixed(1) + suffix : "—";
    return el("tr", {}, ...[d.id, p.lid || m.lid_state || "unknown", m.sensor_status || "awaiting telemetry",
      num(m.distance?.smoothed_cm ?? m.distance_cm, " cm"), num(m.cpu_temperature_c," °C"),
      num(Number.isFinite(m.free_memory_bytes) ? m.free_memory_bytes/1024 : null," KiB"),
      num(m.uptime_seconds," s"), p.sample ? Math.round(picoAge(p)/1000)+" s" : "—",
      p.condition || m.condition || "—"].map(v => el("td",{},v)));
  });
  $("picoRows").replaceChildren(...(rows.length ? rows : [el("tr",{},el("td",{colspan:9},"Awaiting Pico messages."))]));
}

// Common to every message: which device sent it, and where it is.
function touchDevice(msg) {
  const id = String(msg.device_id || "unknown").slice(0, 64);
  const dev = getDevice(id);
  dev.lastSeen = Date.now();                                     // use arrival time; device clocks can be wrong
  const loc = msg.location;
  if (loc && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude)
      && Math.abs(loc.latitude) <= 90 && Math.abs(loc.longitude) <= 180) {
    dev.location = { lat: loc.latitude, lng: loc.longitude, accuracy: Number.isFinite(loc.accuracy_m) ? loc.accuracy_m : null };
  }
  return dev;
}

const isBin = (k) => typeof k === "string" && Object.hasOwn(BIN_DEFS, k);   // is k a bin defined in bins.js?

function handleClassification(msg) {
  if (msg.source === "manual_test" || msg.classification === "TEST_ONLY") return;   // "Publish test message" button on the tablet

  // Drop duplicates (same device + sequence + timestamp).
  const key = `${msg.device_id}|${msg.sequence}|${msg.timestamp}`;
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  if (seenKeys.size > CONFIG.maxEvents * 2) seenKeys.delete(seenKeys.values().next().value);

  const dev = touchDevice(msg);
  const bin = isBin(msg.bin) ? msg.bin : null;
  if (bin) { dev.bins[bin].total += 1; dev.bins[bin].sinceEmptied += 1; } else dev.unsorted += 1;

  events.push({
    t: Date.now(), device: dev.id, bin,
    label: String(msg.classification ?? "unknown").slice(0, 40),
    confidence: Number.isFinite(msg.confidence) ? msg.confidence : null
  });
  if (events.length > CONFIG.maxEvents) events.shift();
}

function handleBinStatus(msg) {
  const dev = touchDevice(msg);
  if (Number.isFinite(msg.battery_pct)) dev.battery = Math.round(msg.battery_pct);
  for (const [bin, info] of Object.entries(msg.bins ?? {})) {
    if (isBin(bin) && Number.isFinite(info?.level_pct)) {
      dev.bins[bin].sensorLevel = Math.max(0, Math.min(100, info.level_pct));   // clamp: never trust incoming numbers
    }
  }
}

/* =====================================================================================================
   E. CALCULATIONS: values derived from STATE (kept separate from drawing so they are easy to test)
   ===================================================================================================== */
const selectedDevices = () => {
  const id = $("deviceSelect").value;
  return id ? [devices.get(id)].filter(Boolean) : [...devices.values()];
};

// Fill level of ONE bin on ONE device. A measured value beats an estimate.
function binLevel(dev, bin) {
  if (dev.pico) {
    const p = dev.pico, m = p.sample;
    if (bin !== $("sensorBin").value || !m || m.sensor_status !== "ok" || !Number.isFinite(m.fill_percentage) || m.fill_percentage<0 || m.fill_percentage>100)
      return {pct:null, source:"unavailable"};
    return {pct:Math.max(0, Math.min(100, m.fill_percentage)),
      source:picoAge(p) > 120000 || !isOnline(dev) ? "last measured / stale" : "measured"};
  }
  const b = dev.bins[bin];
  if (b.sensorLevel !== null) return { pct: b.sensorLevel, source: "measured" };
  return {pct:null,source:"unavailable (classification is not a fill measurement)"};
}

// One bin across the devices being shown: total items, and the WORST (fullest) level, because that is
// the one a collection crew needs to know about.
function summariseBin(list, bin) {
  let total = 0, worst = { pct: null, source: "unavailable" };
  for (const d of list) {
    total += d.bins[bin].total;
    const lv = binLevel(d, bin);
    if (lv.pct !== null && (worst.pct === null || lv.pct >= worst.pct)) worst = lv;
  }
  return { total, ...worst };
}

function levelState(pct) {
  if (pct === null) return {text:"No measurement", kind:"", colour:"#98a2b3"};
  if (pct > CONFIG.fullPct) return { text: "Needs emptying", kind: "bad", colour: "#d92d20" };
  if (pct >= CONFIG.warnPct) return { text: "Filling up", kind: "warn", colour: "#e8a200" };
  return { text: "OK", kind: "ok", colour: "#12a150" };
}

const isOnline = (dev) => dev.pico
  ? Boolean(client?.connected && dev.pico.lastHeartbeat && !dev.pico.offline && Date.now() - dev.pico.lastHeartbeat < (dev.pico.legacy ? 90000 : 30000))
  : Boolean(dev.lastSeen && Date.now() - dev.lastSeen < CONFIG.offlineAfterMs);

function eventsFor(list) {
  const ids = new Set(list.map(d => d.id));
  return events.filter(e => ids.has(e.device));
}

function computeStats(list) {
  const evs = eventsFor(list);
  const perBin = Object.fromEntries(BIN_KEYS.map(k => [k, 0]));
  const perLabel = Object.create(null);
  let confSum = 0, confN = 0;
  for (const e of evs) {
    if (e.bin) perBin[e.bin] += 1;
    perLabel[e.label] = (perLabel[e.label] || 0) + 1;
    if (e.confidence !== null) { confSum += e.confidence; confN += 1; }
  }
  const total = evs.length;
  const hourAgo = Date.now() - 3600_000;
  return {
    total, perBin, perLabel, recent: evs.slice(-10).reverse(),
    lastHour: evs.filter(e => e.t >= hourAgo).length,
    // "Diversion rate" = share of items NOT going to landfill (yellow recycling + green organics). Change the
    // definition to whatever your team decides is a useful measure.
    diversion: total ? (perBin.yellow + perBin.green) / total : null,
    avgConfidence: confN ? confSum / confN : null,
    // Items per minute for the last CONFIG.timelineMinutes minutes (oldest first).
    timeline: (() => {
      const n = CONFIG.timelineMinutes, now = Date.now(), buckets = new Array(n).fill(0);
      for (const e of evs) { const age = Math.floor((now - e.t) / 60000); if (age < n) buckets[n - 1 - age] += 1; }
      return buckets;
    })()
  };
}

/* =====================================================================================================
   F. RENDERING: STATE -> HTML
   scheduleRender() batches many messages into a single redraw per animation frame.
   ===================================================================================================== */
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderAll(); });
}

// renderAll() is the table of contents of the page. Add your own render functions here.
function renderAll() {
  const list = selectedDevices(), stats = computeStats(list);
  renderKpis(list, stats);
  renderBinCards(list);
  renderDevices();
  renderPicoDetails(list);
  renderControls();
  renderPayloads();
  renderBinCounts(stats);
  renderTopItems(stats);
  renderTimeline(stats);
  renderRecent(stats);
  renderMap();
}

// Small helper to build elements safely (textContent only, never innerHTML).
// el("div", {class:"x", style:{color:"red"}}, "text", childElement)
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "style") Object.assign(node.style, v);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter(c => c !== null && c !== undefined));
  return node;
}

const pct = (v) => v === null ? "—" : Math.round(v * 100) + "%";
const timeAgo = (ms) => {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

function renderKpis(list, s) {
  const online = list.filter(isOnline).length;
  const tiles = [
    ["Items sorted", s.total],
    ["Last hour", s.lastHour],
    ["Diverted from landfill", pct(s.diversion)],
    ["Average confidence", pct(s.avgConfidence)],
    ["Devices online", `${online} / ${list.length}`],
    ["Messages received", messageCount]
  ];
  $("kpis").replaceChildren(...tiles.map(([label, value]) => el("div", { class: "kpi" }, el("span", {}, label), el("strong", {}, String(value)))));
}

// One card per bin type (colours and names come from bins.js).
function renderBinCards(list) {
  $("binCards").replaceChildren(...[$("sensorBin").value].map(k => {
    const info = BIN_DEFS[k], sum = summariseBin(list, k), st = levelState(sum.pct);
    const gauge = el("div", { class: "gauge" }, el("div", { style: { width: (sum.pct ?? 0) + "%", background: st.colour } }));
    const card = el("div", { class: "bin-card", style: { borderTopColor: info.colour } },
      el("h3", {}, info.name),
      el("div", { class: "sub" }, info.description),
      gauge,
      el("div", { class: "row" }, el("span", {}, sum.pct === null ? "No sensor data" : `${Math.round(sum.pct)}% full (${sum.source})`), el("span", { class: "state " + st.kind }, st.text)),
      el("div", { class: "row" }, el("span", {}, "Items sorted"), el("strong", {}, String(sum.total)))
    );
    return card;
  }));
}

function renderDevices() {
  const rows = [...devices.values()].map(d => {
    const fullest = fullestLevel(d);
    const on = isOnline(d);
    const items = BIN_KEYS.reduce((n, k) => n + d.bins[k].total, d.unsorted);
    return el("tr", {},
      el("td", {}, d.id),
      el("td", {}, el("span", { class: "dot " + (on ? "ok" : "bad") }), deviceStatus(d)),
      el("td", {}, timeAgo(d.lastSeen)),
      el("td", {}, String(items)),
      el("td", {}, fullest === null ? "—" : Math.round(fullest) + "%"),
      el("td", {}, d.location ? `${d.location.lat.toFixed(4)}, ${d.location.lng.toFixed(4)}${d.location.fix && !GeoRules.fresh(d.location.fix) ? " (stale)" : ""}` : "no GPS")
    );
  });
  $("deviceRows").replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { colspan: 6, class: "note-empty" }, "No devices yet. Connect, or start the simulator."))]));
}

// Generic horizontal bar list, reused for bins and items.
function barRows(entries, colourFor) {
  const max = Math.max(1, ...entries.map(e => e[1]));
  if (!entries.length) return [el("p", { class: "note-empty" }, "No data yet.")];
  return entries.map(([label, n]) => el("div", { class: "barrow" },
    el("span", {}, label),
    el("div", { class: "bar" }, el("div", { style: { width: (n / max) * 100 + "%", background: colourFor(label) } })),
    el("span", {}, String(n))));
}

function renderBinCounts(s) {
  $("binCounts").replaceChildren(...barRows(BIN_KEYS.map(k => [BIN_DEFS[k].name, s.perBin[k]]),
    name => BIN_DEFS[BIN_KEYS.find(k => BIN_DEFS[k].name === name)].colour));
}

function renderTopItems(s) {
  const top = Object.entries(s.perLabel).sort((a, b) => b[1] - a[1]).slice(0, 8);
  $("topItems").replaceChildren(...barRows(top, () => "var(--brand)"));
}

// A tiny hand-drawn SVG bar chart. For richer charts, try Chart.js (https://www.chartjs.org).
function renderTimeline(s) {
  $("timelineMinutes").textContent = CONFIG.timelineMinutes;
  const W = 600, H = 120, n = s.timeline.length, max = Math.max(1, ...s.timeline), bw = W / n;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Items sorted per minute");
  s.timeline.forEach((v, i) => {
    const h = (v / max) * (H - 10), r = document.createElementNS(NS, "rect");
    r.setAttribute("x", i * bw + 1); r.setAttribute("y", H - h); r.setAttribute("width", bw - 2); r.setAttribute("height", h);
    r.setAttribute("fill", "#2b6d94");
    svg.append(r);
  });
  $("timeline").replaceChildren(svg);
}

function renderRecent(s) {
  const rows = s.recent.map(e => el("tr", {},
    el("td", {}, new Date(e.t).toLocaleTimeString()),
    el("td", {}, e.device),
    el("td", {}, e.label),
    el("td", {}, e.bin ? BIN_DEFS[e.bin].name : "—"),
    el("td", {}, pct(e.confidence))));
  $("recentRows").replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { colspan: 5, class: "note-empty" }, "Nothing yet."))]));
}

// Raw message log (newest first, capped). The first thing to check when the display looks wrong.
function logRaw(topic, text) {
  const li = el("li", {}, `${new Date().toLocaleTimeString()} ${topic} ${text.slice(0, 300)}`);
  $("rawLog").prepend(li);
  while ($("rawLog").children.length > 40) $("rawLog").lastChild.remove();
}

function refreshDeviceSelect() {
  const sel = $("deviceSelect"), current = sel.value;
  sel.replaceChildren(el("option", { value: "" }, "All devices"), ...[...devices.keys()].map(id => el("option", { value: id }, id)));
  sel.value = devices.has(current) ? current : "";
}

/* =====================================================================================================
   G. MAP (Leaflet). One coloured circle per device that has reported a location.
   Colour = worst bin on that device (green / amber / red), grey if the device is offline.
   ===================================================================================================== */
let map = null, mapFitted = false;
const markers = new Map();     // device id -> Leaflet marker

function initMap() {
  if (typeof L === "undefined") { $("mapNote").textContent = "Map library failed to load (check the internet connection)."; return; }
  map = L.map("map").setView(CONFIG.mapCentre, CONFIG.mapZoom);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
}

function renderMap() {
  if (!map) return;
  const located = [...devices.values()].filter(d => d.location && (!d.location.fix || GeoRules.fresh(d.location.fix)));
  const ids=new Set(located.map(d=>d.id));
  for (const [id,marker] of markers) if(!ids.has(id)){marker.remove();markers.delete(id);}
  $("mapNote").textContent = located.length
    ? ""
    : "No device has sent a location yet. On the tablet tick “Include GPS location in messages” (needs HTTPS), or use the simulator.";

  for (const d of located) {
    const fullest = fullestLevel(d);
    const colour = isOnline(d) ? levelState(fullest).colour : "#98a2b3";
    let m = markers.get(d.id);
    if (!m) { m = L.circleMarker([d.location.lat, d.location.lng], { radius: 11, weight: 2, color: "#123047", fillOpacity: 0.85 }).addTo(map); markers.set(d.id, m); }
    m.setLatLng([d.location.lat, d.location.lng]).setStyle({ fillColor: colour });
    // Popup content is a DOM element (not an HTML string) so device names cannot inject markup.
    m.bindPopup(el("div", {}, el("strong", {}, d.id),
      ...BIN_KEYS.map(k => el("div", {}, `${BIN_DEFS[k].name}: ${binLevel(d,k).pct === null ? "—" : Math.round(binLevel(d,k).pct)+"%"}`)),
      el("div", {}, "Last seen " + timeAgo(d.lastSeen))));
  }
  // Zoom to fit the devices the first time (not every update, or the map would fight the user's panning).
  if (located.length && !mapFitted) {
    map.fitBounds(L.latLngBounds(located.map(d => [d.location.lat, d.location.lng])).pad(0.3), { maxZoom: 17 });
    mapFitted = true;
  }
}

/* =====================================================================================================
   H. SIMULATOR: pushes made-up messages through handleMessage(), exactly as if they came from MQTT.
   Handy for building the dashboard before anyone has a working tablet or bin.
   To test with real MQTT instead, publish these same JSON shapes from the tablet's "Publish test message" box.
   ===================================================================================================== */
let simTimer = null;
const SIM_DEVICES = [
  { id: "sim-bin-01", lat: -28.8034, lng: 153.2886, count: 0 },
  { id: "sim-bin-02", lat: -28.8042, lng: 153.2899, count: 0 },
  { id: "sim-bin-03", lat: -28.8027, lng: 153.2871, count: 0 }
];
// Items a simulated bin can "see", taken from bins.js (skipping labels mapped to "ignore").
const SIM_LABELS = Object.entries(typeof DEFAULT_COCO_BINS !== "undefined" ? DEFAULT_COCO_BINS : {bottle:"yellow",banana:"green",wrapper:"red",phone:"ewaste"}).filter(([, bin]) => bin !== "ignore");

function simulateTick() {
  const sim = SIM_DEVICES[Math.floor(Math.random() * SIM_DEVICES.length)];
  const [label, bin] = SIM_LABELS[Math.floor(Math.random() * SIM_LABELS.length)];
  sim.count += 1;
  const location = { latitude: sim.lat, longitude: sim.lng, accuracy_m: 10 };
  handleMessage("sim/classification", JSON.stringify({
    schema_version: 2, message_type: "waste_classification", device_id: sim.id, sequence: sim.count,
    timestamp: new Date().toISOString(), source: "simulator", bin, classification: label,
    confidence: Number((0.6 + Math.random() * 0.4).toFixed(2)), location
  }));
  if (sim.count % 6 === 0) {       // now and then a "smart bin" reports a measured level too
    handleMessage("sim/binstatus", JSON.stringify({
      schema_version: 1, message_type: "bin_status", device_id: sim.id, timestamp: new Date().toISOString(),
      bins: Object.fromEntries(BIN_KEYS.map(k => [k, { level_pct: Math.min(100, Math.round(Math.random() * 60 + sim.count)) }])),
      battery_pct: Math.max(5, 100 - sim.count), location
    }));
  }
}

function toggleSimulator() {
  if (simTimer) { clearInterval(simTimer); simTimer = null; $("simButton").textContent = "Start simulator"; return; }
  simTimer = setInterval(simulateTick, 1200);
  $("simButton").textContent = "Stop simulator";
}

function resetData() {
  latestPayloads.clear(); pendingCommand = null; commandNotice = "Display reset; any active lid timer continues on the Pico.";
  devices.clear(); events = []; seenKeys.clear(); messageCount = 0;
  SIM_DEVICES.forEach(s => { s.count = 0; });
  markers.forEach(m => m.remove()); markers.clear(); mapFitted = false;
  $("rawLog").replaceChildren();
  refreshDeviceSelect(); renderAll();
}

// Dashboard commands use the Pico's existing replay protection and application ACK.
const latestPayloads = new Map();
let pendingCommand = null;
let commandNotice = "Waiting for a live Pico heartbeat.";
function controlReady(d) {
  if (d?.pico?.legacy) return isOnline(d);
  return Boolean(d?.pico && isOnline(d) && Date.now()-d.pico.lastHeartbeat < 15000 &&
    Number.isInteger(d.pico.nextCommandSeq) && d.pico.nextCommandSeq > 0);
}
function renderControls() {
  const sel = $("controlBin"), current = sel.value;
  const list = [...devices.values()].filter(d => d.pico);
  sel.replaceChildren(...list.map(d => el("option",{value:d.id},d.id)));
  sel.value = list.some(d => d.id === current) ? current : (list[0]?.id || "");
  const d = devices.get(sel.value);
  $("openLid").disabled = !controlReady(d) || Boolean(pendingCommand);
  // Close can supersede an unacknowledged open.
  $("closeLid").disabled = !controlReady(d);
  $("commandState").textContent = commandNotice +
    (!controlReady(d) ? " Controls need a connected broker and a fresh heartbeat matching the running firmware." : "");
}
function sendLidCommand(action) {
  const d = devices.get($("controlBin").value);
  if (!controlReady(d) || !["open_timed","close"].includes(action)) return;
  if (pendingCommand && action !== "close") return;
  const p = d.pico;
  const seq = Math.max(p.nextCommandSeq, (p.lastSentSeq || 0)+1);
  p.lastSentSeq = seq;
  const payload = {command_id:"web-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,10),
    action, boot_id:p.boot, seq, issued_uptime_ms:p.heartbeatUptime, duration_s:5};
  if (p.legacy) {delete payload.boot_id; delete payload.seq; delete payload.issued_uptime_ms;}
  pendingCommand = {legacy:Boolean(p.legacy), device:d.id, payload, text:JSON.stringify(payload), attempts:0, lastSent:0};
  publishCommand(); renderControls();
}
function publishCommand() {
  const c = pendingCommand, d = c && devices.get(c.device);
  if (!c) return;
  if (!controlReady(d) || (!c.legacy && d.pico.boot !== c.payload.boot_id)) {
    commandNotice = "Command delivery uncertain: connection/heartbeat changed. No further retries.";
    pendingCommand = null; return;
  }
  c.attempts++; c.lastSent = Date.now();
  commandNotice = c.legacy ? c.device+": sent; waiting for matching lid/status." : c.device+": waiting for Pico acknowledgement (attempt "+c.attempts+"/3).";
  // QoS 0 avoids broker/client replay queues for actuator commands. Application retries
  // reuse the exact ID and body, so Pico deduplication prevents extending the lid timer.
  try { client.publish("smartbin/"+c.device+"/command/lid",c.text,{qos:0,retain:false}); }
  catch (err) { commandNotice="Publish failed: "+err.message; pendingCommand=null; }
}
function tickCommands() {
  if (!pendingCommand || Date.now()-pendingCommand.lastSent < 3000) return;
  if (pendingCommand.legacy) {
    if (Date.now()-pendingCommand.lastSent < 10000) return;
    commandNotice="No matching lid/status within 10 seconds. Outcome unknown; inspect Wokwi. Command was not resent.";
    pendingCommand=null; renderControls(); return;
  }
  if (pendingCommand.attempts >= 3) {
    commandNotice = "No Pico acknowledgement after 3 attempts. Outcome unknown; check lid state. The Pico owns the closing timer.";
    pendingCommand = null;
  } else publishCommand();
  renderControls();
}
function receiveCommandAck(d,msg) {
  const c = pendingCommand;
  if (!c || c.device !== d.id || msg.boot_id !== c.payload.boot_id || msg.command_id !== c.payload.command_id) return;
  commandNotice = d.id+": "+String(msg.status)+(msg.reason ? " — "+msg.reason : "")+
    (msg.status === "accepted" ? ". Pico will close after 5 seconds." : "");
  pendingCommand = null;
}
function renderPayloads() {
  const expanded = new Set([...$("topicPayloads").children].filter(n => n.open).map(n => n.topicName));
  $("topicPayloads").replaceChildren(...[...latestPayloads].map(([topic,text]) => {
    let formatted = text; try { formatted=JSON.stringify(JSON.parse(text),null,2); } catch {}
    const node = el("details",{},el("summary",{},topic),el("pre",{style:{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}},formatted));
    node.topicName = topic; node.open = expanded.has(topic); return node;
  }));
}

/* =====================================================================================================
   I. WIRING + START-UP
   ===================================================================================================== */
const INPUT_KEY = "prog6002-dashboard-gps-v2";
function saveInputs() {
  try { localStorage.setItem(INPUT_KEY, JSON.stringify({ brokerUrl: $("brokerUrl").value, topicFilter: $("topicFilter").value })); } catch {}
}
function loadInputs() {
  $("brokerUrl").value = CONFIG.brokerUrl; $("topicFilter").value = CONFIG.topicFilter;
  try {
    const saved = JSON.parse(localStorage.getItem(INPUT_KEY) || "{}");
    if (saved.brokerUrl) $("brokerUrl").value = saved.brokerUrl;
    if (saved.topicFilter) $("topicFilter").value = saved.topicFilter;
  } catch {}
}

$("connectButton").addEventListener("click", connect);
$("simButton").addEventListener("click", toggleSimulator);
$("resetButton").addEventListener("click", resetData);
$("deviceSelect").addEventListener("change", renderAll);

$("sensorBin").replaceChildren(...BIN_KEYS.map(k => el("option", {value:k}, BIN_DEFS[k].name)));
$("sensorBin").value="green";
$("sensorBin").addEventListener("change", renderAll);
$("openLid").addEventListener("click", () => sendLidCommand("open_timed"));
$("closeLid").addEventListener("click", () => sendLidCommand("close"));
$("controlBin").addEventListener("change", renderControls);
setInterval(tickCommands, 500);
loadInputs();
initMap();
renderAll();
// Redraw every 1 s so "last seen", online/offline and the activity chart stay correct when no messages arrive.
setInterval(renderAll, 1000);

/* =====================================================================================================
   IDEAS FOR YOUR OWN DASHBOARD (pick some, invent more)
     - Save events to localStorage or IndexedDB so a page reload keeps the history.
     - Alerts: play a sound / show a banner when a bin passes CONFIG.fullPct.
     - A "Mark emptied" button that sets dev.bins[k].sinceEmptied = 0 and sensorLevel = 0.
     - Fill-level history chart per bin (store {t, level} in a list each time a bin_status arrives).
     - Collection route: order the full bins by distance from the depot and draw a Leaflet polyline.
     - Contamination view: highlight low-confidence items or bins with many "unsorted" items.
     - Publish commands BACK to a device (e.g. topic ".../command") using client.publish().
     - Replace the hand-made SVG chart with Chart.js, or the raw JSON log with a searchable table.
   ===================================================================================================== */


// GPS updates do not mark the Pico online: only its own heartbeat does that.
function handleBinLocation(topic,msg) {
  const match=/^smartbin\/([A-Za-z0-9_-]{1,64})\/location$/.exec(topic);
  if(!match) return false;
  if(msg.bin_id!==match[1] || msg.message_type!=="bin_location" || typeof msg.device_id!=="string" || !GeoRules.fresh(msg.location)) return true;
  const d=getDevice(msg.bin_id), fix=msg.location;
  if(d.location?.fix && Date.parse(fix.timestamp)<=Date.parse(d.location.fix.timestamp)) return true;
  d.location={lat:fix.latitude,lng:fix.longitude,accuracy:fix.accuracy_m,fix,source:msg.device_id};
  return true;
}

