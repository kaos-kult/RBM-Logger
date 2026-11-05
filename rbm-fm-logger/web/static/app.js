"use strict";
// RBM Off-Air Vault. Times are minutes since station-local midnight on the chosen date;
// an end at or before the start means "the next day".

const $ = (id) => document.getElementById(id);
const STEP = 5;
const state = { date: "", start: 0, end: 60, spans: [], maxHours: 6 };
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (m) => `${pad(Math.floor(((m % 1440) + 1440) % 1440 / 60))}:${pad(((m % 60) + 60) % 60)}`;
const clampMin = (m) => ((Math.round(m) % 1440) + 1440) % 1440;

// ---------- API ----------
async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  if (res.status === 401 && !path.includes("login")) { showLogin(); throw new Error("login"); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { status: res.status, body });
  return body;
}

// ---------- Sound effects (synthesised, no files) ----------
let ctx;
function audioCtx() { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); return ctx; }
function blip(freq = 1800, dur = 0.025, type = "square", gain = 0.04) {
  try {
    const c = audioCtx(), o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq; g.gain.value = gain;
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + dur);
  } catch (_) { /* sound is optional */ }
}
function zap() { [220, 440, 880, 1760, 3520].forEach((f, i) => setTimeout(() => blip(f, 0.12, "sawtooth", 0.05), i * 45)); }

// ---------- Login ----------
function showLogin() {
  // Start from a clean vault: no leftover "ACCESS GRANTED", nothing still playing.
  if (typeof setPlaying === "function" && player.playing) setPlaying(false);
  const msg = $("login-msg"); msg.textContent = ""; msg.className = "msg";
  $("door").classList.remove("open", "shake");
  $("password").value = "";
  $("console").hidden = true; $("login").hidden = false; $("password").focus();
}
function showConsole() { $("login").hidden = true; $("console").hidden = false; loadCoverage(); }

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("login-msg"), door = $("door");
  msg.className = "msg"; msg.textContent = "VERIFYING…";
  try {
    await api("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ password: $("password").value }) });
    msg.textContent = "ACCESS GRANTED"; zap(); door.classList.add("open");
    $("password").value = "";
    setTimeout(() => { door.classList.remove("open"); showConsole(); burst(innerWidth / 2, innerHeight / 2, 160); }, 1500);
  } catch (err) {
    door.classList.remove("shake"); void door.offsetWidth; door.classList.add("shake");
    blip(120, 0.3, "sawtooth", 0.08);
    msg.className = "msg bad";
    msg.textContent = err.status === 429 ? `VAULT LOCKED — try again in ${Math.ceil(err.body.retry_after / 60)} min` : "ACCESS DENIED";
  }
});
$("logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); showLogin(); });

// ---------- Date and coverage ----------
function localToday() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function shiftDate(iso, days) {
  const [y, m, d] = iso.split("-").map(Number), t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}
async function loadCoverage() {
  try {
    const data = await api(`/api/coverage?date=${state.date}`);
    state.spans = data.spans; state.maxHours = data.max_hours;
    drawTimeline(); updateReadouts();
  } catch (err) { if (err.message !== "login") status(err.message, true); }
}
function setDate(iso) { state.date = iso; $("date").value = iso; loadCoverage(); }
$("date").addEventListener("change", () => $("date").value && setDate($("date").value));
$("prev-day").addEventListener("click", () => { blip(900); setDate(shiftDate(state.date, -1)); });
$("next-day").addEventListener("click", () => { blip(1100); setDate(shiftDate(state.date, 1)); });

// ---------- Timeline ----------
// The strip runs from midnight to 06:00 the next morning, so overnight shows fit.
const SPAN = 1800;
const tl = $("timeline");
$("hours").innerHTML = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30]
  .map((h) => `<span class="${h > 24 ? "next" : ""}">${pad(h % 24)}</span>`).join("");
function drawTimeline() {
  const dpr = devicePixelRatio || 1, w = tl.clientWidth, h = tl.clientHeight;
  tl.width = w * dpr; tl.height = h * dpr;
  const g = tl.getContext("2d"); g.scale(dpr, dpr);
  const x = (m) => (m / SPAN) * w;
  // No-recording hatching underneath everything.
  g.fillStyle = "#14040a"; g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(255,51,85,0.55)"; g.lineWidth = 2;
  for (let i = -h; i < w; i += 9) { g.beginPath(); g.moveTo(i, h); g.lineTo(i + h, 0); g.stroke(); }
  // Recorded spans, glowing.
  g.shadowColor = "#39ff88"; g.shadowBlur = 14;
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#9dffc6"); grad.addColorStop(0.5, "#39ff88"); grad.addColorStop(1, "#0b7a3c");
  g.fillStyle = grad;
  for (const [a, b] of state.spans) g.fillRect(x(a), 8, Math.max(1.5, x(b) - x(a)), h - 16);
  g.shadowBlur = 0;
  // Hour ticks.
  g.fillStyle = "rgba(255,255,255,0.25)";
  for (let hr = 1; hr < SPAN / 60; hr++) g.fillRect(x(hr * 60), 0, 1, hr % 3 ? 8 : 16);
  // Next morning: dimmed, with a bright midnight line.
  g.fillStyle = "rgba(25,246,255,0.10)"; g.fillRect(x(1440), 0, w - x(1440), h);
  g.fillStyle = "#19f6ff"; g.fillRect(x(1440) - 1, 0, 2, h);
  g.font = "bold 11px ui-monospace, monospace"; g.fillText("NEXT DAY", x(1440) + 6, h - 6);
  // Selection.
  const end = state.end <= state.start ? state.end + 1440 : state.end;
  g.fillStyle = "rgba(255,43,214,0.35)"; g.fillRect(x(state.start), 0, x(end) - x(state.start), h);
  g.fillStyle = "#ff2bd6"; g.shadowColor = "#ff2bd6"; g.shadowBlur = 16;
  g.fillRect(x(state.start) - 1.5, 0, 3, h);
  g.fillRect(x(end) - 1.5, 0, 3, h);
  g.shadowBlur = 0;
}
addEventListener("resize", drawTimeline);

let dragFrom = null;
const tlMinute = (e) => {
  const r = tl.getBoundingClientRect();
  return Math.min(SPAN, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * SPAN / STEP) * STEP));
};
// A range must start on the chosen date; to start after midnight, pick the next date.
tl.addEventListener("pointerdown", (e) => {
  tl.setPointerCapture(e.pointerId); dragFrom = Math.min(tlMinute(e), 1440 - STEP); setRange(dragFrom, dragFrom + STEP);
});
tl.addEventListener("pointermove", (e) => {
  if (dragFrom === null) return;
  const m = tlMinute(e);
  if (m > dragFrom) setRange(dragFrom, m); else if (m < dragFrom) setRange(Math.min(m, 1440 - STEP), dragFrom);
});
tl.addEventListener("pointerup", () => { dragFrom = null; });

// ---------- Knobs ----------
// One full turn of a knob = 2 hours, so each 5-minute detent is 15 degrees.
const MINUTES_PER_TURN = 120;
const DEG_PER_MINUTE = 360 / MINUTES_PER_TURN;

function bindKnob(knob, key) {
  let lastAngle = null, acc = 0;
  const nudge = (delta) => {
    const next = clampMin(state[key] + delta);
    if (next === state[key]) return;
    state[key] = next; blip(key === "start" ? 1600 : 2100); updateAll();
  };
  const angleOf = (e) => {
    const r = knob.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
  };
  // Turn it like a real knob: drag around the centre, clockwise = later.
  knob.addEventListener("pointerdown", (e) => { knob.setPointerCapture(e.pointerId); lastAngle = angleOf(e); acc = 0; });
  knob.addEventListener("pointermove", (e) => {
    if (lastAngle === null) return;
    const angle = angleOf(e);
    acc += ((angle - lastAngle + 540) % 360) - 180;
    lastAngle = angle;
    const step = e.shiftKey ? 1 : STEP, detent = step * DEG_PER_MINUTE;
    while (acc >= detent) { nudge(step); acc -= detent; }
    while (acc <= -detent) { nudge(-step); acc += detent; }
  });
  knob.addEventListener("pointerup", () => { lastAngle = null; });
  knob.addEventListener("wheel", (e) => { e.preventDefault(); nudge((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 1 : STEP)); }, { passive: false });
  knob.addEventListener("keydown", (e) => {
    const map = { ArrowUp: STEP, ArrowRight: STEP, ArrowDown: -STEP, ArrowLeft: -STEP, PageUp: 60, PageDown: -60 };
    if (map[e.key]) { e.preventDefault(); nudge(map[e.key]); }
  });
}
bindKnob($("knob-start"), "start");
bindKnob($("knob-end"), "end");
for (const key of ["start", "end"]) {
  $(key).addEventListener("change", () => {
    const [h, m] = $(key).value.split(":").map(Number);
    if (!Number.isNaN(h)) { state[key] = h * 60 + m; updateAll(); }
  });
}

function setRange(a, b) { state.start = clampMin(a); state.end = clampMin(b); updateAll(); }
function lengthMinutes() { return ((state.end - state.start) + 1440) % 1440 || 1440; }
function updateReadouts() {
  $("start").value = hhmm(state.start); $("end").value = hhmm(state.end);
  $("knob-start").firstElementChild.style.transform = `rotate(${state.start * DEG_PER_MINUTE}deg)`;
  $("knob-end").firstElementChild.style.transform = `rotate(${state.end * DEG_PER_MINUTE}deg)`;
  $("knob-start").setAttribute("aria-valuetext", hhmm(state.start));
  $("knob-end").setAttribute("aria-valuetext", hhmm(state.end));
  const len = lengthMinutes(), over = len > state.maxHours * 60;
  $("duration").textContent = `${Math.floor(len / 60)}h ${pad(len % 60)}m`;
  const note = $("duration-note");
  note.textContent = over ? `TOO LONG — vault limit is ${state.maxHours} hours`
    : state.end <= state.start ? "ends the next day" : "";
  note.style.color = over ? "var(--red)" : "";
  $("download").disabled = over; $("audition").disabled = over;
  $("marquee").textContent = `★ ${state.date} ★ ${hhmm(state.start)} → ${hhmm(state.end)} ★ ${$("duration").textContent} OF PURE RADIO ★`;
}
function updateAll() { updateReadouts(); drawTimeline(); }

function rangeQuery() {
  const endDate = state.end <= state.start ? shiftDate(state.date, 1) : state.date;
  return `start=${state.date}T${hhmm(state.start)}&end=${endDate}T${hhmm(state.end)}`;
}
function status(text, bad = false) { const s = $("status"); s.textContent = text; s.className = bad ? "msg bad" : "msg"; }

// ---------- Listen: stream the original recordings as one seekable timeline ----------
// The range is played file by file straight from the archive (with HTTP range requests,
// so seeking is instant). Two audio elements take turns, so the next file is already
// loading when the current one ends. Gaps in the recording are skipped automatically.
const decks = [$("player-a"), $("player-b")];
const player = { segs: [], duration: 0, seg: -1, deck: 0, playing: false, busy: false, startSec: 0 };
let analysers = null;
function wireAnalysers() {
  if (analysers) return;
  const c = audioCtx(), split = c.createChannelSplitter(2);
  analysers = [c.createAnalyser(), c.createAnalyser()];
  analysers.forEach((a) => { a.fftSize = 1024; });
  for (const el of decks) { const src = c.createMediaElementSource(el); src.connect(c.destination); src.connect(split); }
  split.connect(analysers[0], 0); split.connect(analysers[1], 1);
}
const fileUrl = (seg) => `/api/file?id=${encodeURIComponent(seg.id)}`;
const deck = () => decks[player.deck];
const segEnd = (s) => s.at + (s.out - s.in);
const fmt = (t) => { t = Math.max(0, Math.floor(t)); return `${Math.floor(t / 3600)}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`; };
const clockAt = (t) => { const x = Math.floor(player.startSec + t); return `${pad(Math.floor(x / 3600) % 24)}:${pad(Math.floor(x / 60) % 60)}:${pad(x % 60)}`; };

function position() {
  const s = player.segs[player.seg];
  return s ? s.at + (deck().currentTime - s.in) : 0;
}
function load(el, seg, offset) {
  return new Promise((resolve) => {
    const go = () => { el.currentTime = offset; resolve(); };
    if (el.dataset.id === seg.id && el.readyState >= 1) return go();
    el.dataset.id = seg.id; el.src = fileUrl(seg);
    el.addEventListener("loadedmetadata", go, { once: true });
  });
}
function preloadNext() {
  const next = player.segs[player.seg + 1], other = decks[1 - player.deck];
  if (next && other.dataset.id !== next.id) { other.dataset.id = next.id; other.src = fileUrl(next); }
}
async function goTo(index, offset) {
  const s = player.segs[index];
  deck().pause();
  if (decks[1 - player.deck].dataset.id === s.id) player.deck = 1 - player.deck;
  player.seg = index;
  await load(deck(), s, offset);
  if (player.playing) await deck().play().catch(() => {});
  preloadNext();
}
async function seek(t) {
  if (!player.segs.length || player.busy) return;
  player.busy = true;
  try {
    t = Math.max(0, Math.min(player.duration - 0.5, t));
    let i = player.segs.findIndex((s) => t < segEnd(s));
    if (i < 0) i = player.segs.length - 1;
    const s = player.segs[i];
    if (t < s.at) status(`Nothing recorded at ${clockAt(t)} — jumped to ${clockAt(s.at)}`);
    await goTo(i, s.in + Math.max(0, t - s.at));
  } finally { player.busy = false; }
}
async function advance() {
  const cur = player.segs[player.seg], next = player.segs[player.seg + 1];
  if (!next) { setPlaying(false); return seek(0); }
  player.busy = true;
  try {
    const gap = next.at - segEnd(cur);
    await goTo(player.seg + 1, next.in);
    if (gap > 2) status(`${Math.round(gap / 60)} min never recorded — skipped to ${clockAt(next.at)}`);
  } finally { player.busy = false; }
}
async function setPlaying(on) {
  player.playing = on;
  $("play").textContent = on ? "❚❚" : "▶";
  $("play").setAttribute("aria-label", on ? "Pause" : "Play");
  if (on) { await audioCtx().resume(); await deck().play().catch(() => {}); } else deck().pause();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = on ? "playing" : "paused";
}

$("audition").addEventListener("click", async () => {
  try {
    const data = await api(`/api/segments?${rangeQuery()}`);
    wireAnalysers();
    decks.forEach((el) => { el.pause(); delete el.dataset.id; });
    Object.assign(player, { segs: data.segments, duration: data.duration, seg: -1, deck: 0, startSec: state.start * 60 });
    $("transport").hidden = false;
    const covered = data.segments.reduce((sum, s) => sum + (s.out - s.in), 0);
    status(covered < data.duration - 5 ? `Heads up: ${Math.round((data.duration - covered) / 60)} min of this range was never recorded` : "");
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: `RBM FM ${state.date} ${hhmm(state.start)}–${hhmm(state.end)}`, artist: "Radio Blue Mountains" });
    }
    await seek(Math.max(0, data.segments[0].at));
    await setPlaying(true);
    $("transport").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) { if (err.message !== "login") status(err.message, true); }
});
$("play").addEventListener("click", () => setPlaying(!player.playing));
for (const [id, delta] of [["back300", -300], ["back30", -30], ["fwd30", 30], ["fwd300", 300]]) {
  $(id).addEventListener("click", () => { blip(1300); seek(position() + delta); });
}
// Hand over to the next file at this piece's out point. Checked on timeupdate as well as
// every frame, because background tabs stop animation frames but keep playing audio.
function checkHandover() {
  const s = player.segs[player.seg];
  if (player.playing && !player.busy && s && deck().currentTime >= s.out - 0.04) advance();
}
decks.forEach((el) => {
  el.addEventListener("ended", () => { if (el === deck() && !player.busy) advance(); });
  el.addEventListener("timeupdate", () => { if (el === deck()) checkHandover(); });
});
addEventListener("keydown", (e) => {
  if (e.key !== " " || $("transport").hidden || e.target.closest("input, button, [role=slider]")) return;
  e.preventDefault(); setPlaying(!player.playing);
});
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => setPlaying(true));
  navigator.mediaSession.setActionHandler("pause", () => setPlaying(false));
  navigator.mediaSession.setActionHandler("seekbackward", () => seek(position() - 30));
  navigator.mediaSession.setActionHandler("seekforward", () => seek(position() + 30));
  navigator.mediaSession.setActionHandler("seekto", (d) => seek(d.seekTime));
}

// Scrub bar: recorded parts, gaps, progress and a glowing playhead. Click or drag to seek.
const scrub = $("scrub");
let scrubbing = null;
const scrubTime = (e) => { const r = scrub.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * player.duration; };
scrub.addEventListener("pointerdown", (e) => { scrub.setPointerCapture(e.pointerId); scrubbing = scrubTime(e); });
scrub.addEventListener("pointermove", (e) => { if (scrubbing !== null) scrubbing = scrubTime(e); });
scrub.addEventListener("pointerup", () => { if (scrubbing !== null) seek(scrubbing); scrubbing = null; });
function drawTransport() {
  requestAnimationFrame(drawTransport);
  if ($("transport").hidden) return;
  checkHandover();
  const t = scrubbing ?? position();
  $("pos-clock").textContent = clockAt(t);
  $("pos-elapsed").textContent = `${fmt(t)} / ${fmt(player.duration)}`;
  const dpr = devicePixelRatio || 1, w = scrub.clientWidth, h = scrub.clientHeight;
  if (scrub.width !== w * dpr) { scrub.width = w * dpr; scrub.height = h * dpr; }
  const g = scrub.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = (v) => (v / player.duration) * w;
  g.fillStyle = "#14040a"; g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(255,51,85,0.45)"; g.lineWidth = 2;
  for (let i = -h; i < w; i += 9) { g.beginPath(); g.moveTo(i, h); g.lineTo(i + h, 0); g.stroke(); }
  for (const seg of player.segs) {
    g.fillStyle = "#123a24"; g.fillRect(x(seg.at), 10, x(segEnd(seg)) - x(seg.at), h - 20);
    const done = Math.min(segEnd(seg), t);
    if (done > seg.at) { g.fillStyle = "#19f6ff"; g.fillRect(x(seg.at), 10, x(done) - x(seg.at), h - 20); }
  }
  g.fillStyle = "#fff"; g.shadowColor = "#19f6ff"; g.shadowBlur = 18;
  g.fillRect(x(t) - 2, 0, 4, h); g.shadowBlur = 0;
  if ("mediaSession" in navigator && navigator.mediaSession.setPositionState && player.duration) {
    try { navigator.mediaSession.setPositionState({ duration: player.duration, position: Math.min(player.duration, Math.max(0, t)) }); } catch (_) {}
  }
}
requestAnimationFrame(drawTransport);

function gapNote(check) {
  const missing = Math.round((check.requested - check.covered) / 60);
  return `heads up: ${missing} min of that range was never recorded, so the file is shorter`;
}

const needles = [{ v: 0, el: $("vu-l") }, { v: 0, el: $("vu-r") }];
const buf = new Float32Array(1024);
function drawVU() {
  const playing = analysers && player.playing;
  needles.forEach((n, i) => {
    let target;
    if (playing) {
      analysers[i].getFloatTimeDomainData(buf);
      let sum = 0; for (const s of buf) sum += s * s;
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-6);
      target = Math.min(1.05, Math.max(0, (db + 40) / 40));
    } else {
      target = 0.08 + 0.05 * Math.sin(performance.now() / (700 + i * 230)) + Math.random() * 0.03;
    }
    // VU ballistics: quick rise, slower fall.
    n.v += (target - n.v) * (target > n.v ? 0.35 : 0.08);
    const g = n.el.getContext("2d"), w = n.el.width, h = n.el.height, cx = w / 2, cy = h * 1.05, r = h * 0.85;
    g.clearRect(0, 0, w, h);
    g.lineWidth = 3;
    for (let k = 0; k <= 20; k++) {
      const t = k / 20, a = Math.PI * (1.2 + 0.6 * t);
      g.strokeStyle = t > 0.75 ? "#c4001f" : "#3b2a00";
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r * 0.86, cy + Math.sin(a) * r * 0.86);
      g.lineTo(cx + Math.cos(a) * r * (k % 5 ? 0.92 : 0.98), cy + Math.sin(a) * r * (k % 5 ? 0.92 : 0.98)); g.stroke();
    }
    g.fillStyle = "#3b2a00"; g.font = "bold 13px ui-monospace, monospace"; g.fillText("VU", cx - 10, h * 0.62);
    g.fillStyle = "#c4001f"; g.fillText("+", w * 0.84, h * 0.3);
    const a = Math.PI * (1.2 + 0.6 * Math.min(1, n.v));
    g.strokeStyle = "#111"; g.lineWidth = 2.5; g.shadowColor = "rgba(0,0,0,0.4)"; g.shadowBlur = 4;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); g.stroke();
    g.shadowBlur = 0;
    if (n.v > 0.95) { g.fillStyle = "#ff1133"; g.beginPath(); g.arc(w * 0.9, h * 0.15, 7, 0, 7); g.fill(); }
  });
  requestAnimationFrame(drawVU);
}
requestAnimationFrame(drawVU);

// ---------- Download ----------
$("download").addEventListener("click", async () => {
  const btn = $("download");
  try {
    const check = await api(`/api/audio?${rangeQuery()}&check=1`);
    btn.classList.add("sending"); zap();
    $("flash").classList.remove("go"); void $("flash").offsetWidth; $("flash").classList.add("go");
    const r = btn.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, 260);
    status(check.covered < check.requested ? `Downloading… ${gapNote(check)}` : "Downloading… your file is on its way");
    const a = document.createElement("a");
    a.href = `/api/audio?${rangeQuery()}&download=1`; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => btn.classList.remove("sending"), 2500);
  } catch (err) { if (err.message !== "login") status(err.message, true); }
});

// ---------- Sky: stars and drifting radio waves ----------
const sky = $("sky"), sg = sky.getContext("2d");
const stars = Array.from({ length: 160 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() }));
function drawSky(t) {
  const w = (sky.width = innerWidth), h = (sky.height = innerHeight);
  const bg = sg.createRadialGradient(w * 0.5, h * 1.1, 0, w * 0.5, h * 1.1, h * 1.3);
  bg.addColorStop(0, "#3a0a5c"); bg.addColorStop(0.5, "#120326"); bg.addColorStop(1, "#05010b");
  sg.fillStyle = bg; sg.fillRect(0, 0, w, h);
  for (const s of stars) {
    sg.fillStyle = `rgba(255,255,255,${0.3 + 0.7 * Math.abs(Math.sin(t / 900 + s.z * 20))})`;
    sg.fillRect(s.x * w, s.y * h, 1 + s.z * 1.5, 1 + s.z * 1.5);
  }
  const colours = ["rgba(255,43,214,0.35)", "rgba(25,246,255,0.3)", "rgba(255,204,51,0.22)"];
  colours.forEach((c, i) => {
    sg.strokeStyle = c; sg.lineWidth = 2; sg.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const y = h * (0.72 + i * 0.07) + Math.sin(x / (90 + i * 40) + t / (700 - i * 120)) * (26 + i * 10)
        * Math.sin(t / 4000 + i);
      x ? sg.lineTo(x, y) : sg.moveTo(x, y);
    }
    sg.stroke();
  });
  requestAnimationFrame(drawSky);
}
requestAnimationFrame(drawSky);

// ---------- Sparks ----------
const sparks = $("sparks"), pg = sparks.getContext("2d");
let particles = [];
function burst(x, y, n) {
  const hues = [320, 185, 45, 140, 270];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 9;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 3, life: 1, hue: hues[i % hues.length] });
  }
  if (particles.length === n) requestAnimationFrame(drawSparks);
}
function drawSparks() {
  sparks.width = innerWidth; sparks.height = innerHeight;
  pg.globalCompositeOperation = "lighter";
  particles = particles.filter((p) => p.life > 0);
  for (const p of particles) {
    p.x += p.vx; p.y += p.vy; p.vy += 0.18; p.vx *= 0.99; p.life -= 0.012;
    pg.fillStyle = `hsla(${p.hue},100%,65%,${p.life})`;
    pg.beginPath(); pg.arc(p.x, p.y, 2.5 + p.life * 2, 0, 7); pg.fill();
  }
  if (particles.length) requestAnimationFrame(drawSparks);
}

// ---------- The Konami code, obviously ----------
const konami = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
let kpos = 0;
addEventListener("keydown", (e) => {
  kpos = e.key === konami[kpos] ? kpos + 1 : (e.key === konami[0] ? 1 : 0);
  if (kpos === konami.length) { kpos = 0; document.body.classList.toggle("disco"); zap(); burst(innerWidth / 2, innerHeight / 3, 400); }
});

// ---------- Start ----------
(function init() {
  // Default to the most recent complete hour.
  const now = new Date(), last = now.getHours() * 60 - 60;
  state.start = clampMin(last); state.end = clampMin(last + 60);
  state.date = last < 0 ? shiftDate(localToday(), -1) : localToday();
  $("date").value = state.date;
  updateReadouts();
  api(`/api/coverage?date=${state.date}`).then(showConsole).catch(() => {});
})();
