"use strict";
// RBM Off-Air Vault. Times are minutes since station-local midnight on the chosen date;
// an end at or before the start means "the next day".

const $ = (id) => document.getElementById(id);
const STEP = 5;
const state = { date: "", start: 0, end: 60, spans: [], shows: [], maxHours: 6, source: "studio" };
// STUDIO (the desk's output off Dante, the default) or OFF-AIR (what the FM receiver
// heard). Remembered per device. A studio selection fills holes from off-air.
try { if (localStorage.getItem("rbm_source") === "fm") state.source = "fm"; } catch (_) {}
const srcQ = () => `source=${state.source}`;
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
// Sound effects (clicks, zaps, the cassette's thud) can be switched off per device, e.g.
// on studio computers whose audio goes to air. Remembered in a cookie; clearing cookies,
// or running rbmUnmuteEffects() in the console, turns them back on. Listening is unaffected.
window.rbmSoundEffectsOn = () => !/(?:^|;\s*)rbm_sfx=off/.test(document.cookie);
function setSoundEffects(on) {
  const secure = location.protocol === "https:" ? "; Secure" : "";  // Local testing is plain HTTP.
  document.cookie = on ? `rbm_sfx=; Max-Age=0; Path=/; SameSite=Strict${secure}`
                       : `rbm_sfx=off; Max-Age=315360000; Path=/; SameSite=Strict${secure}`;
  showSfxState();
  return on ? "Sound effects ON for this device." : "Sound effects OFF for this device (listening still works).";
}
window.rbmMuteEffects = () => setSoundEffects(false);
window.rbmUnmuteEffects = () => setSoundEffects(true);
function showSfxState() {
  const on = rbmSoundEffectsOn(), b = $("sfx");
  if (!b) return;
  b.textContent = on ? "🔊" : "🔇";
  b.title = on ? "Sound effects on (click to mute them on this device)" : "Sound effects muted on this device (click to turn on)";
  b.setAttribute("aria-label", b.title);
  b.classList.toggle("muted", !on);
}

let ctx;
function audioCtx() { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); return ctx; }
function blip(freq = 1800, dur = 0.025, type = "square", gain = 0.04) {
  if (!rbmSoundEffectsOn()) return;
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
  $("offline").hidden = true;
  // Start from a clean vault: no leftover "ACCESS GRANTED", nothing still playing.
  if (typeof setPlaying === "function" && player.playing) setPlaying(false);
  const msg = $("login-msg"); msg.textContent = ""; msg.className = "msg";
  $("door").classList.remove("open", "shake");
  $("password").value = "";
  $("console").hidden = true; $("login").hidden = false; $("password").focus();
}
function showConsole() { $("offline").hidden = true; $("login").hidden = true; $("console").hidden = false; loadCoverage(); loadInfo(); }
// Shown when the server can't be reached at all (offline, or the logger is down).
function showUnreachable() {
  if (!$("console").hidden || !$("login").hidden) return;  // Keep what's already on screen.
  $("offline").textContent = navigator.onLine
    ? "Can't reach the vault right now. It may be restarting; this page will retry by itself."
    : "You're offline. The vault will open as soon as you're back online.";
  $("offline").hidden = false;
}
function connect() {
  api(`/api/coverage?date=${state.date}&${srcQ()}`).then(showConsole).catch((err) => {
    if (err.message !== "login") { showUnreachable(); setTimeout(connect, 15000); }
  });
}

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
    const date = state.date;
    const [data, guide] = await Promise.all([
      api(`/api/coverage?date=${date}&${srcQ()}`),
      api(`/api/shows?date=${date}`).catch(() => ({ shows: [] })),  // Names are a bonus.
    ]);
    if (date !== state.date) return;  // The date changed while loading.
    state.spans = data.spans; state.maxHours = data.max_hours; state.shows = guide.shows;
    drawTimeline(); updateReadouts(); startMarquee();
  } catch (err) { if (err.message !== "login") status(err.message, true); }
}
function setDate(iso) { state.date = iso; $("date").value = iso; loadCoverage(); }
$("date").addEventListener("change", () => $("date").value && setDate($("date").value));
$("prev-day").addEventListener("click", () => { blip(900); setDate(shiftDate(state.date, -1)); });
$("next-day").addEventListener("click", () => { blip(1100); setDate(shiftDate(state.date, 1)); });

// ---------- Timeline ----------
// The strip runs from midnight to 06:00 the next morning, so overnight shows fit.
const SPAN = 1800;
const SHOW_BAND = 22;  // Height of the programme-guide row at the top of the strip.
const tl = $("timeline");
$("hours").innerHTML = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30]
  .map((h) => `<span class="${h > 24 ? "next" : ""}">${pad(h % 24)}</span>`).join("");
let marqueeActive = false, marqueeRunning = false;
function drawTimeline() {
  marqueeActive = false;
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
  for (const [a, b, offair] of state.spans) if (!offair) g.fillRect(x(a), SHOW_BAND + 4, Math.max(1.5, x(b) - x(a)), h - SHOW_BAND - 10);
  // Studio view: stretches only the off-air recording has, in blue.
  g.shadowColor = "#5b8cff";
  const blue = g.createLinearGradient(0, 0, 0, h);
  blue.addColorStop(0, "#c4d5ff"); blue.addColorStop(0.5, "#5b8cff"); blue.addColorStop(1, "#1d3a8a");
  g.fillStyle = blue;
  for (const [a, b, offair] of state.spans) if (offair) g.fillRect(x(a), SHOW_BAND + 4, Math.max(1.5, x(b) - x(a)), h - SHOW_BAND - 10);
  g.shadowBlur = 0;
  // Programme guide: one labelled block per show along the top. Click one to select it.
  g.font = "600 11px 'Avenir Next', 'Segoe UI', system-ui, sans-serif"; g.textBaseline = "middle";
  for (const show of state.shows) {
    const a = x(show.from) + 1, b = Math.min(w, x(show.to)) - 1;
    if (b - a < 2) continue;
    g.fillStyle = show.probable ? "rgba(255,204,51,0.14)" : "rgba(255,204,51,0.26)";
    g.fillRect(a, 2, b - a, SHOW_BAND - 2);
    g.strokeStyle = "rgba(255,204,51,0.8)"; g.lineWidth = 1;
    if (show.probable) g.setLineDash([3, 3]);
    g.strokeRect(a + 0.5, 2.5, b - a - 1, SHOW_BAND - 3); g.setLineDash([]);
    if (b - a > 14) {
      const label = (show.probable ? "~ " : "") + show.name, room = b - a - 8, textW = g.measureText(label).width;
      g.save(); g.beginPath(); g.rect(a + 3, 0, b - a - 6, SHOW_BAND); g.clip();
      g.fillStyle = "#ffe9a8";
      if (textW <= room) {
        g.fillText(label, a + 4, SHOW_BAND / 2 + 1);
      } else {
        // Too long for its box: scroll it like a marquee, with a pause at the start.
        const gap = 28, cycle = textW + gap, speed = 30;  // pixels per second
        const t = (performance.now() / 1000) * speed % (cycle + speed * 1.5);
        const shift = Math.max(0, t - speed * 1.5);
        g.fillText(label, a + 4 - shift, SHOW_BAND / 2 + 1);
        g.fillText(label, a + 4 - shift + cycle, SHOW_BAND / 2 + 1);
        marqueeActive = true;
      }
      g.restore();
    }
  }
  g.textBaseline = "alphabetic";
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

// Keep redrawing while any show name is scrolling, at about 30 frames a second.
function marqueeTick() {
  if (!marqueeActive || $("console").hidden) { marqueeRunning = false; return; }
  drawTimeline();
  setTimeout(() => requestAnimationFrame(marqueeTick), 33);
}
const startMarquee = () => { if (marqueeActive && !marqueeRunning) { marqueeRunning = true; requestAnimationFrame(marqueeTick); } };

let dragFrom = null, dragMoved = false;
const showAt = (m) => state.shows.find((s) => m >= s.from && m < s.to);
const tlMinute = (e) => {
  const r = tl.getBoundingClientRect();
  return Math.min(SPAN, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * SPAN / STEP) * STEP));
};
// A range must start on the chosen date; to start after midnight, pick the next date.
tl.addEventListener("pointerdown", (e) => {
  tl.setPointerCapture(e.pointerId); dragMoved = false;
  dragFrom = Math.min(tlMinute(e), 1440 - STEP); setRange(dragFrom, dragFrom + STEP);
});
tl.addEventListener("pointermove", (e) => {
  if (dragFrom === null) {
    const show = showAt(tlMinute(e));
    tl.title = show ? `${show.probable ? "Probably " : ""}${show.name}${show.presenter ? " — " + show.presenter : ""}`
      + `${show.probable ? ` (per the ${show.schedule} schedule)` : ""}. Click to select.` : "";
    return;
  }
  if (e.pointerType === "mouse" && !(e.buttons & 1)) { dragFrom = null; return; }  // Released elsewhere.
  const m = tlMinute(e);
  if (m !== dragFrom) dragMoved = true;
  if (m > dragFrom) setRange(dragFrom, m); else if (m < dragFrom) setRange(Math.min(m, 1440 - STEP), dragFrom);
});
tl.addEventListener("pointerup", (e) => {
  // A click (no drag) on a show selects the whole show.
  const show = !dragMoved && showAt(tlMinute(e));
  if (show) { setRange(Math.round(show.from), Math.round(show.to)); blip(1500); blip(2200); }
  dragFrom = null;
});
for (const ev of ["pointercancel", "lostpointercapture"]) tl.addEventListener(ev, () => { dragFrom = null; });

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
    // Only turn while the button is actually held: a release outside the window never
    // reaches us, and the dial mustn't carry on turning when the pointer comes back.
    if (lastAngle !== null && e.pointerType === "mouse" && !(e.buttons & 1)) lastAngle = null;
    if (lastAngle === null) return;
    const angle = angleOf(e);
    acc += ((angle - lastAngle + 540) % 360) - 180;
    lastAngle = angle;
    const step = e.shiftKey ? 1 : STEP, detent = step * DEG_PER_MINUTE;
    while (acc >= detent) { nudge(step); acc -= detent; }
    while (acc <= -detent) { nudge(-step); acc += detent; }
  });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) {
    knob.addEventListener(ev, () => { lastAngle = null; });
  }
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
  $("knob-start").querySelector(".knob-pointer").style.transform = `rotate(${state.start * DEG_PER_MINUTE}deg)`;
  $("knob-end").querySelector(".knob-pointer").style.transform = `rotate(${state.end * DEG_PER_MINUTE}deg)`;
  $("knob-start").setAttribute("aria-valuetext", hhmm(state.start));
  $("knob-end").setAttribute("aria-valuetext", hhmm(state.end));
  const len = lengthMinutes(), over = len > state.maxHours * 60;
  $("duration").textContent = `${Math.floor(len / 60)}h ${pad(len % 60)}m`;
  const note = $("duration-note");
  note.textContent = over ? `TOO LONG — vault limit is ${state.maxHours} hours`
    : state.end <= state.start ? "ends the next day" : "";
  note.style.color = over ? "var(--red)" : "";
  const show = matchedShow();
  $("show-note").textContent = show
    ? `♪ ${show.probable ? "probably " : ""}${show.name}${show.presenter ? " · " + show.presenter : ""}` : "";
  $("show-note").title = show && show.probable ? `Guessed from the ${show.schedule} programme guide` : "";
  $("download").disabled = over; $("audition").disabled = over;
  updateMarquee();
}
// ---------- Source switch ----------
function showSource() {
  for (const b of document.querySelectorAll(".source-switch button")) {
    const on = b.dataset.source === state.source;
    b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on));
  }
  $("legend-offair").hidden = state.source !== "studio";
}
for (const b of document.querySelectorAll(".source-switch button")) {
  b.addEventListener("click", () => {
    if (b.dataset.source === state.source) return;
    blip(b.dataset.source === "fm" ? 700 : 1300);
    state.source = b.dataset.source;
    try { localStorage.setItem("rbm_source", state.source); } catch (_) {}
    showSource();
    if (live.on) liveGo(livePos());  // Carry on from the same moment in the other source.
    else if (!$("transport").hidden) status("Switched source: press AUDITION to hear this one");
    loadCoverage();
  });
}
showSource();
function updateAll() { updateReadouts(); drawTimeline(); startMarquee(); showTrim(); }

// The show this selection is essentially a recording of (same 80% rule as the server).
function matchedShow() {
  const start = state.start, end = state.end <= state.start ? state.end + 1440 : state.end;
  let best = null, bestOverlap = 0;
  for (const s of state.shows) {
    const overlap = Math.min(end, s.to) - Math.max(start, s.from);
    if (overlap > bestOverlap) { best = s; bestOverlap = overlap; }
  }
  return best && bestOverlap >= 0.8 * (end - start) && bestOverlap >= 0.8 * (best.to - best.from) ? best : null;
}

function rangeQuery() {
  const endDate = state.end <= state.start ? shiftDate(state.date, 1) : state.date;
  return `start=${state.date}T${hhmm(state.start)}&end=${endDate}T${hhmm(state.end)}&${srcQ()}`;
}

// ---------- Trimming: IN/OUT handles in the LISTEN player, to the second ----------
// trim.in/out are seconds from the start of the selected range. They belong to the range
// they were set on; changing the selection drops them.
const trim = { key: null, in: 0, out: 0, len: 0, active: "out" };
const trimmed = () => trim.key !== null && trim.key === rangeQuery() && !live.on;
// Local "YYYY-MM-DDTHH:MM:SS" for a number of seconds after midnight on the chosen date.
function stampAt(seconds) {
  const d = new Date(`${state.date}T00:00:00`);
  d.setSeconds(d.getSeconds() + Math.round(seconds));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const hms = (seconds) => stampAt(seconds).slice(11);
// The query for what will actually be downloaded: the trimmed cut if there is one.
function cutQuery() {
  if (!trimmed() || (trim.in === 0 && trim.out === trim.len)) return rangeQuery();
  const base = state.start * 60;
  return `start=${stampAt(base + trim.in)}&end=${stampAt(base + trim.out)}&${srcQ()}`;
}
function setTrim(which, value) {
  const min = which === "in" ? 0 : trim.in + 1, max = which === "in" ? trim.out - 1 : trim.len;
  trim[which] = Math.round(Math.max(min, Math.min(max, value)));
  trim.active = which;
  showTrim();
}
function showTrim() {
  const on = trimmed();
  $("trim-row").hidden = !on;
  // DOWNLOAD appears once the current selection has been auditioned (not in live mode).
  const wasShown = !$("download").hidden;
  $("download").hidden = !on;
  if (!on && wasShown && !live.on) status("Selection changed: press ▶ AUDITION to check it, then download.");
  if (!on) return;
  const base = state.start * 60;
  $("trim-in").textContent = hms(base + trim.in);
  $("trim-out").textContent = hms(base + trim.out);
  const cut = trim.out - trim.in, whole = cut === trim.len;
  $("trim-len").textContent = whole ? `${fmt(cut)}\ndrag the ✂ to trim` : `cut ${fmt(cut)}\ntrimmed ${fmt(trim.len - cut)}`;
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

// ---------- Live mode: DVR-style listening from the recorder's newest audio ----------
// The server streams from any moment onward and keeps going as the recorder writes, so
// playback never runs out. Pausing drops the stream and remembers the moment; play picks
// up from there, so you can pause, rewind, then catch up with "⏭ LIVE".
const LIVE_WINDOW = 6 * 3600;   // the scrub bar covers the last 6 hours
const LIVE_DELAY = 6;           // seconds behind real time (the recorder's own buffering)
const live = { on: false, base: 0, pausedAt: null, retry: 0 };
const nowSec = () => Date.now() / 1000;
const liveWindowStart = () => nowSec() - LIVE_WINDOW;
const livePos = () => live.pausedAt ?? live.base + decks[0].currentTime;  // epoch seconds
const secondsOfDay = (epoch) => { const d = new Date(epoch * 1000); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); };
async function liveGo(epoch) {
  epoch = Math.max(liveWindowStart(), Math.min(epoch, nowSec() - LIVE_DELAY));
  const el = decks[0];
  el.pause();
  try {
    const point = await api(`/api/live?at=${epoch.toFixed(1)}&check=1&${srcQ()}`);
    if (state.source === "studio" && point.source === "fm") status("No studio copy from that moment, so this is the off-air recording");
    if (point.start > epoch + 5) status(`Nothing recorded at that moment, so jumped ahead to the next recording`);
    epoch = point.start;
  } catch (err) { if (err.message === "login") return; status(err.message, true); }
  live.base = epoch; live.pausedAt = null;
  delete el.dataset.id;
  el.volume = 1;
  el.src = `/api/live?at=${epoch.toFixed(1)}&${srcQ()}`;
  if (player.playing) await el.play().catch(() => {});
}
async function startLive() {
  wireAnalysers();
  decks.forEach((el) => { el.pause(); delete el.dataset.id; });
  Object.assign(player, { segs: [], duration: LIVE_WINDOW, seg: -1, deck: 0 });
  live.on = true; live.retry = 0; $("trim-row").hidden = true;
  $("live").classList.add("on");
  $("transport").hidden = false;
  status("Live from the logger, a few seconds behind the air. Pause and rewind as you like.");
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: "RBM FM, live", artist: "Radio Blue Mountains" });
  }
  player.playing = true;
  await liveGo(nowSec() - LIVE_DELAY);
  await setPlaying(true);
  $("transport").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function stopLive() { live.on = false; showTrim(); live.pausedAt = null; $("live").classList.remove("on"); $("golive").hidden = true; }
$("live").addEventListener("click", () => { blip(1200); blip(1800); startLive(); });
for (const [id, which, delta] of [["in-minus", "in", -1], ["in-plus", "in", 1], ["out-minus", "out", -1], ["out-plus", "out", 1]]) {
  $(id).addEventListener("click", () => { blip(1600); setTrim(which, trim[which] + delta); });
}
$("hear-in").addEventListener("click", async () => { await seek(trim.in); await setPlaying(true); });
// The last 5 seconds before the cut; playback stops at OUT by itself.
$("hear-out").addEventListener("click", async () => { await seek(Math.max(trim.in, trim.out - 5)); await setPlaying(true); });
$("trim-reset").addEventListener("click", () => { trim.in = 0; trim.out = trim.len; showTrim(); });
// Snap a pair of scissors to the playhead: play through, and cut where you hear it.
function cutHere(which) {
  if (!trimmed()) return;
  const t = position(), other = which === "in" ? trim.out : trim.in;
  if ((which === "in" && t >= other - 1) || (which === "out" && t <= other + 1)) {
    status(which === "in" ? "IN must be before OUT. Move OUT later first, or pick an earlier spot."
                          : "OUT must be after IN. Move IN earlier first, or pick a later spot.", true);
    return;
  }
  setTrim(which, t);
  blip(1500); blip(2300);
  status(`${which.toUpperCase()} set to ${hms(state.start * 60 + trim[which])}.`);
}
$("in-here").addEventListener("click", () => cutHere("in"));
$("out-here").addEventListener("click", () => cutHere("out"));
addEventListener("keydown", (e) => {
  const typing = e.target instanceof Element && e.target.closest("input, textarea");
  if (!trimmed() || typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "i" || e.key === "I") { e.preventDefault(); cutHere("in"); }
  if (e.key === "o" || e.key === "O") { e.preventDefault(); cutHere("out"); }
});
// Stop at OUT, so what you hear ends where the download will.
function checkTrimEnd() {
  if (trimmed() && player.playing && trim.out < trim.len && position() >= trim.out - 0.05) {
    setPlaying(false);
    status(`Stopped at OUT (${hms(state.start * 60 + trim.out)}), where your download ends.`);
  }
}
$("golive").addEventListener("click", () => { blip(2000); liveGo(nowSec() - LIVE_DELAY); });
// If the stream ends or breaks (network blip, recorder restart), pick up where it was.
for (const ev of ["ended", "error", "stalled"]) {
  decks[0].addEventListener(ev, () => {
    if (!live.on || !player.playing || live.retry > 20) return;
    live.retry++;
    const at = livePos();
    setTimeout(() => { if (live.on && player.playing) liveGo(at); }, Math.min(10000, 1000 * live.retry));
  });
}
decks[0].addEventListener("playing", () => { live.retry = 0; });

function position() {
  if (live.on) return livePos() - liveWindowStart();
  const s = player.segs[player.seg];
  return s ? s.at + (deck().currentTime - s.in) : 0;
}
function load(el, seg, offset) {
  return new Promise((resolve) => {
    // Off-air pieces among studio audio are turned down to match (seg.gain, in dB).
    el.volume = Math.min(1, 10 ** ((seg.gain || 0) / 20));
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
  if (live.on) return liveGo(liveWindowStart() + t);
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
  if (live.on) {
    if (on) {
      await audioCtx().resume();
      if (live.pausedAt !== null) await liveGo(live.pausedAt); else await decks[0].play().catch(() => {});
    } else {
      // Drop the stream while paused; play resumes from this exact moment.
      live.pausedAt = livePos();
      decks[0].pause(); decks[0].removeAttribute("src"); decks[0].load();
    }
  } else if (on) { await audioCtx().resume(); await deck().play().catch(() => {}); } else deck().pause();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = on ? "playing" : "paused";
}

$("audition").addEventListener("click", async () => {
  blip(1400);
  try {
    const data = await api(`/api/segments?${rangeQuery()}`);
    stopLive();
    wireAnalysers();
    decks.forEach((el) => { el.pause(); delete el.dataset.id; });
    Object.assign(player, { segs: data.segments, duration: data.duration, seg: -1, deck: 0, startSec: state.start * 60 });
    if (trim.key !== rangeQuery()) Object.assign(trim, { key: rangeQuery(), in: 0, out: data.duration, len: data.duration });
    showTrim();
    $("transport").hidden = false;
    status([data.missing > 0 ? `Heads up: ${howLong(data.missing)} of this range was never recorded` : "",
            offairNote(data.offair, data.duration)].filter(Boolean).join(". "));
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: `RBM ${state.source === "fm" ? "FM off-air" : "studio"} ${state.date} ${hhmm(state.start)}–${hhmm(state.end)}`, artist: "Radio Blue Mountains" });
    }
    await seek(Math.max(0, data.segments[0].at));
    await setPlaying(true);
    // Bring the whole player into view, down to the DOWNLOAD button.
    $("download").scrollIntoView({ behavior: "smooth", block: "end" });
  } catch (err) { if (err.message !== "login") status(err.message, true); }
});
$("play").addEventListener("click", () => setPlaying(!player.playing));
for (const [id, delta] of [["back300", -300], ["back30", -30], ["fwd30", 30], ["fwd300", 300]]) {
  $(id).addEventListener("click", () => { blip(1300); seek(position() + delta); });
}
// Hand over to the next file at this piece's out point. Checked on timeupdate as well as
// every frame, because background tabs stop animation frames but keep playing audio.
function checkHandover() {
  if (live.on) return;
  const s = player.segs[player.seg];
  if (player.playing && !player.busy && s && deck().currentTime >= s.out - 0.04) advance();
}
decks.forEach((el) => {
  el.addEventListener("ended", () => { if (!live.on && el === deck() && !player.busy) advance(); });
  el.addEventListener("timeupdate", () => { if (!live.on && el === deck()) { checkHandover(); checkTrimEnd(); } });
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
const scrubTime = (e) => {
  const r = scrub.getBoundingClientRect();
  const pad = scrubPad(), inner = r.width - 2 * pad;
  return Math.max(0, Math.min(1, (e.clientX - r.left - pad) / inner)) * player.duration;
};
let draggingHandle = null;
const HANDLE_GRAB_PX = 26;
// The strip above the bar holds the scissors: pointing there grabs the nearest pair.
// Anywhere in the audio bar itself always moves the playhead, even right at a cut.
function handleNear(e) {
  if (!trimmed()) return null;
  const r = scrub.getBoundingClientRect();
  if (e.clientY - r.top > SCISSOR_BAND) return null;
  const pad = scrubPad(), px = (v) => r.left + pad + (v / player.duration) * (r.width - 2 * pad);
  const dIn = Math.abs(e.clientX - px(trim.in)), dOut = Math.abs(e.clientX - px(trim.out));
  if (Math.min(dIn, dOut) > HANDLE_GRAB_PX) return null;
  return dIn <= dOut ? "in" : "out";
}
// While dragging in the bar, the audio follows (a few times a second), so you can scrub
// to the right spot by ear. Live mode only seeks on release: each seek opens a new stream.
let lastScrubSeek = 0;
function scrubTo(t, final) {
  scrubbing = t;
  if (final) {
    // The seek on release must happen even if a scrub seek is still loading.
    const go = () => (player.busy ? setTimeout(go, 40) : seek(t).finally(() => { if (scrubbing === t) scrubbing = null; }));
    go();
    return;
  }
  if (!live.on && performance.now() - lastScrubSeek > 200) { lastScrubSeek = performance.now(); seek(t); }
}
scrub.addEventListener("pointerdown", (e) => {
  scrub.setPointerCapture(e.pointerId);
  draggingHandle = handleNear(e);
  if (draggingHandle) { trim.active = draggingHandle; return; }
  lastScrubSeek = 0;
  scrubTo(scrubTime(e), false);
});
scrub.addEventListener("pointermove", (e) => {
  if (draggingHandle) {
    if (e.pointerType === "mouse" && !(e.buttons & 1)) { draggingHandle = null; return; }
    setTrim(draggingHandle, scrubTime(e));
    return;
  }
  scrub.style.cursor = handleNear(e) ? "ew-resize" : "pointer";
  if (scrubbing === null) return;
  if (e.pointerType === "mouse" && !(e.buttons & 1)) { scrubTo(scrubbing, true); return; }  // Released elsewhere.
  scrubTo(scrubTime(e), false);
});
scrub.addEventListener("pointerup", (e) => {
  if (draggingHandle) { blip(1500); draggingHandle = null; return; }
  if (scrubbing !== null) scrubTo(scrubTime(e), true);
});
for (const ev of ["pointercancel", "lostpointercapture"]) scrub.addEventListener(ev, () => {
  draggingHandle = null;
  if (scrubbing !== null) scrubTo(scrubbing, true);
});
scrub.addEventListener("keydown", (e) => {
  if (!trimmed() || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  e.preventDefault();
  setTrim(trim.active, trim[trim.active] + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 10 : 1));
});
const SCISSOR_BAND = 52;
const scrubPad = () => (trimmed() ? 28 : 0);  // half the scissors' width, so they always fit  // room above the scrub bar for the trim scissors
// An open pair of scissors pointing down at the cut line, drawn with paths so it looks
// the same everywhere: two finger rings at the top, two blades crossing at the pivot in
// an X, their points opening either side of the line.
function drawScissors(g, cx, cy, hot) {
  g.save();
  g.translate(cx, cy);
  g.scale(1.9, 1.9);
  g.lineCap = "round"; g.lineJoin = "round";
  g.shadowColor = "#ffcc33"; g.shadowBlur = hot ? 14 : 6;
  const steel = hot ? "#fffbe6" : "#ece6ff", edge = "#6b6390", ring = hot ? "#ffcc33" : "#ff2bd6";
  // Each blade: a shank from its ring to the pivot, then a tapering blade out to its point.
  for (const side of [-1, 1]) {
    g.fillStyle = steel; g.strokeStyle = edge; g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(side * 7.5, -7);          // shank top, by the ring
    g.lineTo(side * 4.5, -7.5);
    g.lineTo(-side * 1.2, 1.5);         // past the pivot...
    g.lineTo(-side * 8.5, 15.5);        // ...out to the point on the other side
    g.lineTo(-side * 6.2, 15);
    g.lineTo(side * 1.6, 3.2);
    g.closePath(); g.fill(); g.stroke();
  }
  // Finger rings.
  g.strokeStyle = ring; g.lineWidth = 2.6;
  for (const side of [-1, 1]) {
    g.beginPath(); g.ellipse(side * 8, -11.5, 4.6, 4.2, side * 0.5, 0, Math.PI * 2); g.stroke();
  }
  // Pivot screw.
  g.shadowBlur = 0; g.fillStyle = "#2a2140"; g.strokeStyle = steel; g.lineWidth = 0.8;
  g.beginPath(); g.arc(0, 2.2, 2, 0, Math.PI * 2); g.fill(); g.stroke();
  g.restore();
}
function drawTransport() {
  requestAnimationFrame(drawTransport);
  if ($("transport").hidden) return;
  checkHandover(); checkTrimEnd();
  if (live.on) player.startSec = secondsOfDay(liveWindowStart());
  const t = scrubbing ?? position();
  $("pos-clock").textContent = clockAt(t);
  if (live.on) {
    const behind = nowSec() - (scrubbing !== null ? liveWindowStart() + scrubbing : livePos());
    const atLive = behind < LIVE_DELAY + 12 && live.pausedAt === null;
    $("pos-elapsed").textContent = atLive ? "● LIVE" : `−${fmt(behind)} behind live`;
    $("golive").hidden = atLive;
  } else {
    $("pos-elapsed").textContent = `${fmt(t)} / ${fmt(player.duration)}`;
  }
  const dpr = devicePixelRatio || 1, w = scrub.clientWidth, h = scrub.clientHeight;
  if (scrub.width !== w * dpr || scrub.height !== h * dpr) { scrub.width = w * dpr; scrub.height = h * dpr; }
  const g = scrub.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  // While trimming, the bar is inset so scissors at the very start or end sit on their
  // cut line instead of being clipped by the edge.
  const pad = scrubPad(), x = (v) => pad + (v / player.duration) * (w - 2 * pad);
  // When trimming, the scissors live in a band above the audio bar.
  const top = trimmed() ? SCISSOR_BAND : 0, barTop = top + 8, barH = h - top - 16;
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#14040a"; g.fillRect(0, top, w, h - top);
  g.save(); g.beginPath(); g.rect(0, top, w, h - top); g.clip();
  g.strokeStyle = "rgba(255,51,85,0.45)"; g.lineWidth = 2;
  for (let i = -h; i < w; i += 9) { g.beginPath(); g.moveTo(i, h); g.lineTo(i + h, 0); g.stroke(); }
  g.restore();
  if (live.on) {
    // The last 6 hours: listened-to part in cyan, the rest available up to now.
    g.fillStyle = "#123a24"; g.fillRect(0, barTop, w, barH);
    g.fillStyle = "#19f6ff"; g.fillRect(0, barTop, Math.max(0, x(t)), barH);
    g.fillStyle = "#ff3355"; g.fillRect(w - 3, 4, 3, h - 8);
    g.font = "bold 10px ui-monospace, monospace"; g.fillStyle = "#ffb3c1"; g.fillText("NOW", w - 30, 12);
  }
  for (const seg of player.segs) {
    g.fillStyle = "#123a24"; g.fillRect(x(seg.at), barTop, x(segEnd(seg)) - x(seg.at), barH);
    const done = Math.min(segEnd(seg), t);
    if (done > seg.at) { g.fillStyle = "#19f6ff"; g.fillRect(x(seg.at), barTop, x(done) - x(seg.at), barH); }
  }
  if (trimmed()) {
    // Outside the cut: dimmed. Each end of the cut is a pair of scissors over a dashed line.
    // The parts being cut away: almost black, so it's obvious they won't be in the download.
    g.fillStyle = "rgba(3,1,8,0.88)";
    g.fillRect(0, top, x(trim.in), h - top); g.fillRect(x(trim.out), top, w - x(trim.out), h - top);
    for (const which of ["in", "out"]) {
      const hx = x(trim[which]), hot = trim.active === which || draggingHandle === which;
      g.strokeStyle = hot ? "#ffe066" : "#ffcc33"; g.lineWidth = 2; g.setLineDash([5, 4]);
      g.shadowColor = "#ffcc33"; g.shadowBlur = hot ? 12 : 4;
      g.beginPath(); g.moveTo(hx, top - 4); g.lineTo(hx, h); g.stroke();
      g.setLineDash([]); g.shadowBlur = 0;
      drawScissors(g, hx, top / 2 + 5, hot);
    }
  }
  g.fillStyle = "#fff"; g.shadowColor = "#19f6ff"; g.shadowBlur = 18;
  g.fillRect(x(t) - 2, top, 4, h - top); g.shadowBlur = 0;
  if ("mediaSession" in navigator && navigator.mediaSession.setPositionState && player.duration) {
    try { navigator.mediaSession.setPositionState({ duration: player.duration, position: Math.min(player.duration, Math.max(0, t)) }); } catch (_) {}
  }
}
requestAnimationFrame(drawTransport);

// Studio selections that had to use the off-air recording for part of the time.
function offairNote(offair, total) {
  if (!offair || offair < 2) return "";
  return offair >= total - 2 ? "There's no studio copy of this, so it's the off-air recording"
    : `${howLong(offair)} of this is the off-air recording (no studio copy then, shown in blue)`;
}
function gapNote(check) {
  return `heads up: ${howLong(check.requested - check.covered)} of that range was never recorded, so the file is shorter`;
}
// "40 seconds", "12 min", "2 h 5 min"
function howLong(seconds) {
  seconds = Math.round(seconds);
  if (seconds < 90) return `${seconds} seconds`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
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
    const query = cutQuery(), cut = query !== rangeQuery();
    const check = await api(`/api/audio?${query}&check=1`);
    const gaps = check.covered < check.requested;
    const href = `/api/audio?${query}&download=1`;
    const startDownload = () => {
      const a = document.createElement("a");
      a.href = href; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      status([gaps ? `Downloading… ${gapNote(check)}` : "Downloading… your file is on its way",
              offairNote(check.offair, check.requested)].filter(Boolean).join(". "));
    };
    btn.classList.add("sending"); btn.disabled = true;  // One cassette at a time.
    const show = check.show;
    const endDate = state.end <= state.start ? shiftDate(state.date, 1) : state.date;
    const day = new Date(`${state.date}T12:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    const title = show ? `${show.probable ? "Probably: " : ""}${show.name}`
      : state.source === "fm" || check.offair >= check.requested - 2 ? "RBM FM · Off-Air" : "RBM · Studio";
    const when = cut
      ? `${day} · ${hms(state.start * 60 + trim.in)} → ${hms(state.start * 60 + trim.out)}`
      : `${day} · ${hhmm(state.start)} → ${hhmm(state.end)}${endDate !== state.date ? " (+1)" : ""}`;
    if (window.exportCassette) {
      // The show: stamp, label, ejection. The download starts as the cassette flies off.
      await window.exportCassette({ title, when, gaps, onDownload: startDownload });
    } else {
      startDownload();
    }
    btn.classList.remove("sending"); btn.disabled = false;
  } catch (err) {
    btn.classList.remove("sending"); updateReadouts();
    if (err.message !== "login") status(err.message, true);
  }
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

// ---------- Marquee: on air now, the selection, and a rotating fact or tip ----------
const TIPS = [
  "CLICK A SHOW IN THE GOLD ROW TO SELECT IT",
  "TURN THE DIALS FOR 5-MINUTE STEPS · HOLD SHIFT FOR 1 MINUTE",
  "AN END TIME BEFORE THE START MEANS THE NEXT DAY",
  "INSTALL THE VAULT AS AN APP FROM YOUR BROWSER'S MENU",
  "DOWNLOADS ARE NAMED AFTER THE SHOW WHEN THE TIMES MATCH",
  "AUDITION YOUR SELECTION, TRIM IT WITH THE ✂ SCISSORS, THEN DOWNLOAD",
  "ON AN ON-AIR COMPUTER? TAP 🔊 TO MUTE THE SOUND EFFECTS",
  "CLICK OR PRESS ANY KEY TO SKIP THE CASSETTE",
  "RADIO BLUE MOUNTAINS · ON AIR 24/7",
  "UP TO 6 HOURS PER DOWNLOAD",
];
const info = { onAir: null, oldest: null, hours: 0 };
let tipIndex = Math.floor(Math.random() * TIPS.length);
const niceDate = (iso, opts = { weekday: "short", day: "numeric", month: "short" }) =>
  new Date(`${iso}T12:00`).toLocaleDateString("en-AU", opts).replace(",", "").toUpperCase();
const ampm = (m) => {
  m = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = pad(m % 60), h12 = h % 12 || 12;
  return `${h12}:${mm} ${h < 12 ? "AM" : "PM"}`;
};
function updateMarquee() {
  const parts = [];
  if (info.onAir) parts.push(`ON AIR NOW: ${info.onAir.name.toUpperCase()}${info.onAir.presenter ? " WITH " + info.onAir.presenter.toUpperCase() : ""}`);
  const show = matchedShow(), len = lengthMinutes();
  const lenText = len % 60 ? (len >= 60 ? `${Math.floor(len / 60)} H ${len % 60} MIN` : `${len} MIN`) : `${len / 60} HOUR${len === 60 ? "" : "S"}`;
  parts.push(`SELECTED: ${show ? show.name.toUpperCase() + ", " : ""}${niceDate(state.date)} · ${ampm(state.start)}–${ampm(state.end)} · ${lenText}`);
  const facts = [...TIPS];
  if (info.oldest) facts.push(`THE VAULT GOES BACK TO ${niceDate(info.oldest, { day: "numeric", month: "short", year: "numeric" })}`);
  if (info.hours) facts.push(`${info.hours.toLocaleString("en-AU")} HOURS OF RADIO IN THE VAULT`);
  parts.push(facts[tipIndex % facts.length]);
  // New text waits for the next pass, so it never pops in mid-scroll.
  marquee.pending = parts.join("   ✦   ");
  if (!marquee.running) { marquee.running = true; requestAnimationFrame(marqueeFrame); }
}
// Each pass enters fully from the right and leaves fully off the left, at a steady speed.
const marquee = { pending: "", x: null, last: 0, running: false };
const MARQUEE_SPEED = 90;  // pixels per second
function marqueeFrame(now) {
  const el = $("marquee"), box = el.parentElement.clientWidth;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // No scrolling: just show the latest text, updated now and then.
    if (el.textContent !== marquee.pending) el.textContent = marquee.pending;
    el.style.transform = "none";
    marquee.x = null;
    setTimeout(() => requestAnimationFrame(marqueeFrame), 1000);
    return;
  }
  if (marquee.x === null || marquee.x < -el.offsetWidth) {
    // Start of a pass: a different tip each time round, then any updated text.
    if (marquee.x !== null) { tipIndex++; updateMarquee(); }
    if (marquee.pending && el.textContent !== marquee.pending) el.textContent = marquee.pending;
    marquee.x = box;
    marquee.last = now;
  }
  const dt = Math.min(0.1, (now - marquee.last) / 1000);  // No leap after a hidden tab.
  marquee.last = now;
  marquee.x -= MARQUEE_SPEED * dt;
  el.style.transform = `translateX(${marquee.x}px)`;
  requestAnimationFrame(marqueeFrame);
}
async function loadInfo() {
  try {
    const d = await api("/api/info");
    Object.assign(info, { onAir: d.on_air, oldest: d.oldest, hours: d.hours });
    updateMarquee();
  } catch (_) { /* The marquee is decoration. */ }
}
setInterval(() => { if (!$("console").hidden) loadInfo(); }, 5 * 60 * 1000);

// ---------- Installable app (PWA) ----------
// The service worker only makes the page installable and lets it open offline; it never
// caches logins, recordings or downloads.
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
addEventListener("offline", () => status("You're offline. The vault needs a connection to play or download.", true));
addEventListener("online", () => { status("Back online."); if (!$("console").hidden) loadCoverage(); else connect(); });

$("sfx").addEventListener("click", () => { const on = !rbmSoundEffectsOn(); setSoundEffects(on); if (on) blip(1800); });
showSfxState();

// ---------- Start ----------
(function init() {
  // Default to the most recent complete hour.
  const now = new Date(), last = now.getHours() * 60 - 60;
  state.start = clampMin(last); state.end = clampMin(last + 60);
  state.date = last < 0 ? shiftDate(localToday(), -1) : localToday();
  $("date").value = state.date;
  updateReadouts();
  connect();
})();
