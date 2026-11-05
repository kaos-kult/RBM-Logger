"use strict";
// Cassette export animation: a blank tape slides in, giant VU meters bounce while the
// label prints, a rubber stamp slams down, and the cassette is ejected as the download
// starts. Skippable with a click or key; the download never waits on it.
// Approved mockup: mockups/cassette-export.html. Sound effects obey rbmSoundEffectsOn().
(() => {
const STAGE_HTML = `<div id="cas-stage" aria-hidden="true">
  <div class="spot"></div>
  <div class="cas-vu l"><canvas width="500" height="320"></canvas><b>L</b></div>
  <div class="cas-vu r"><canvas width="500" height="320"></canvas><b>R</b></div>
  <div class="deck">
    <div class="cassette" id="cas-cassette">
      <svg viewBox="0 0 640 405" aria-hidden="true">
        <defs>
          <linearGradient id="shell" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b3550"/><stop offset="1" stop-color="#17132a"/></linearGradient>
          <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffaf0"/><stop offset="1" stop-color="#f1e4c4"/></linearGradient>
          <linearGradient id="stripe" x1="0" x2="1"><stop offset="0" stop-color="#ff2bd6"/><stop offset=".5" stop-color="#ffcc33"/><stop offset="1" stop-color="#19f6ff"/></linearGradient>
          <radialGradient id="tape"><stop offset=".25" stop-color="#2a1608"/><stop offset="1" stop-color="#5a3318"/></radialGradient>
        </defs>
        <rect x="4" y="4" width="632" height="397" rx="26" fill="url(#shell)" stroke="#6d6590" stroke-width="3"/>
        <rect x="18" y="18" width="604" height="369" rx="18" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="2"/>
        <g fill="#8d86a8" stroke="#2a2638" stroke-width="2">
          <circle cx="34" cy="34" r="9"/><circle cx="606" cy="34" r="9"/><circle cx="34" cy="371" r="9"/><circle cx="606" cy="371" r="9"/><circle cx="320" cy="371" r="8"/>
        </g>
        <!-- label -->
        <rect x="58" y="34" width="524" height="208" rx="10" fill="url(#paper)"/>
        <rect x="58" y="34" width="524" height="16" rx="6" fill="url(#stripe)"/>
        <g stroke="rgba(29,42,107,0.18)" stroke-width="2"><line x1="78" y1="98" x2="562" y2="98"/><line x1="78" y1="134" x2="562" y2="134"/></g>
        <!-- window -->
        <rect x="150" y="160" width="340" height="74" rx="37" fill="#0b0814" stroke="#2a2638" stroke-width="4"/>
        <circle class="reel" cx="225" cy="197" r="44" fill="url(#tape)"/>
        <circle class="reel" cx="415" cy="197" r="30" fill="url(#tape)"/>
        <g class="reel"><circle cx="225" cy="197" r="20" fill="#f4ecff"/><g fill="#0b0814"><rect x="221" y="180" width="8" height="12"/><rect x="221" y="202" width="8" height="12"/><rect x="208" y="193" width="12" height="8"/><rect x="230" y="193" width="12" height="8"/></g></g>
        <g class="reel"><circle cx="415" cy="197" r="20" fill="#f4ecff"/><g fill="#0b0814"><rect x="411" y="180" width="8" height="12"/><rect x="411" y="202" width="8" height="12"/><rect x="398" y="193" width="12" height="8"/><rect x="420" y="193" width="12" height="8"/></g></g>
        <!-- bottom trapezoid with tape path -->
        <path d="M140 318 L170 270 L470 270 L500 318 Z" fill="#221d36" stroke="#4b4468" stroke-width="3"/>
        <g fill="#0b0814"><circle cx="205" cy="298" r="9"/><circle cx="435" cy="298" r="9"/><rect x="290" y="288" width="60" height="22" rx="4"/></g>
        <text x="320" y="355" text-anchor="middle" fill="#a89bc4" font-family="ui-monospace, Menlo, monospace" font-size="18" letter-spacing="5">RBM · C90 · SIDE A</text>
      </svg>
      <div class="printhead"></div>
      <div class="label"><div class="title" id="cas-title"></div><div class="when" id="cas-when"></div></div>
      <div class="ink" id="cas-ink"></div>
    </div>
    <div class="stamp" id="cas-stamp">
      <svg viewBox="0 0 220 300" aria-hidden="true">
        <defs><linearGradient id="wood" x1="0" x2="1"><stop offset="0" stop-color="#7a3d12"/><stop offset=".5" stop-color="#c47a3a"/><stop offset="1" stop-color="#6a3310"/></linearGradient>
          <linearGradient id="steel" x1="0" x2="1"><stop offset="0" stop-color="#666"/><stop offset=".5" stop-color="#eee"/><stop offset="1" stop-color="#555"/></linearGradient></defs>
        <ellipse cx="110" cy="46" rx="44" ry="40" fill="url(#wood)" stroke="#3a1a05" stroke-width="3"/>
        <rect x="96" y="80" width="28" height="120" fill="url(#steel)" stroke="#333" stroke-width="2"/>
        <rect x="20" y="196" width="180" height="56" rx="8" fill="url(#steel)" stroke="#333" stroke-width="3"/>
        <rect x="26" y="250" width="168" height="26" rx="4" fill="#c8102e" id="cas-pad"/>
      </svg>
    </div>
  </div>
  <canvas id="cas-sparks"></canvas>
  <div class="caption" id="cas-caption"></div>
  <div class="flash" id="cas-flash"></div>
  <div class="skip">CLICK OR PRESS ANY KEY TO SKIP</div>
</div>`;
document.body.insertAdjacentHTML("beforeend", STAGE_HTML);
// Stamp labels for complete recordings. One is chosen at random per download.
const STAMPS = [
  "Certified Radio Blue Mountains Broadcast Artefact",
  "Officially Went To Air", "Verified Off-Air Specimen", "Genuine Blue Mountains Airwaves",
  "Approved For Human Ears", "Contains 100% Real Radio", "Certified Audible",
  "Broadcast Authenticated", "Sealed At The Transmitter", "Hand-Caught From The Ether",
  "Fresh From The Antenna", "Mountain-Grown Radio", "Product Of The Blue Mountains",
  "Grade A Airwaves", "Premium Broadcast Content", "Pressed From Pure FM",
  "Wild-Caught Kilohertz", "Free-Range Frequencies", "Organically Modulated",
  "Ethically Sourced Audio", "No Artificial Silence Added", "Contains Actual Broadcasting",
  "Archive Quality Radio", "Museum-Grade Broadcast", "Exhibit A: Radio Happened",
  "Evidence Of Broadcasting", "Proof Of Transmission", "Officially Logged",
  "Logged, Labelled And Legendary", "Captured For Posterity", "Preserved For The Ages",
  "Future Historians, You're Welcome", "Time Capsule Approved", "Vaulted And Exalted",
  "Released From The Vault", "Liberated From The Archive", "Fetched From The Vault",
  "Authorised Excerpt", "Excerpt Of Record", "A True And Faithful Recording",
  "Witnessed By The Logger", "Notarised By The Logger", "Signed, Sealed, Delivered",
  "Stamped By A Very Big Stamp", "Rubber-Stamped With Enthusiasm", "Stamped Twice For Luck",
  "Quality Controlled (Loosely)", "Inspected By Inspector 7", "Passed Inspection",
  "Hi-Fi Certified", "Stereo In Both Ears", "Left And Right Channels Included",
  "Extra Hertz At No Cost", "Now With More Decibels", "Turned Up To Eleven",
  "Volume Not Included", "Best Heard Loud", "Play At Your Own Risk",
  "Do Not Expose To Static", "Keep Away From Magnets", "Rewind Before Returning",
  "Please Be Kind, Rewind", "Side A Of Something Great", "Includes Side B Feelings",
  "Mixtape Of Record", "Better Than A Mixtape", "Your Show, Immortalised",
  "Your Finest Hour (Or So)", "Certified Banger", "Peak Community Radio",
  "Community Radio At Its Finest", "Locally Made Radio", "Made In Katoomba-ish",
  "Brewed In The Blue Mountains", "Bottled At Altitude", "Recorded Above Sea Level",
  "Fog-Resistant Broadcast", "Eucalyptus-Scented Audio", "Lyrebird Approved",
  "Cockatoo Certified", "Wombat-Tested", "Kookaburra Laughed At This",
  "Echo Point Verified", "Three Sisters Seal Of Approval", "Scenic Railway Speed Audio",
  "Straight Off The Escarpment", "Valley-Wide Reception Achieved", "Transmitted With Love",
  "Broadcast With Gusto", "Aired With Panache", "Spoken Into A Real Microphone",
  "Contains Talking And/Or Music", "Contains Dead Air: None", "Zero Dead Air Detected",
  "Every Second Accounted For", "Complete And Unabridged", "Uncut Broadcast",
  "The Director's Cut", "Limited Edition Of One", "Collector's Item",
  "First Pressing", "Instant Classic", "Legendary Broadcast Artefact", "Fit For The National Archives",
];

// Shown instead when part of the range was never recorded.
const GAP_STAMP = "Incomplete — Some Radio May Be Missing";

const $ = (id) => document.getElementById(id);
const stage = $("cas-stage"), cassette = $("cas-cassette"), ink = $("cas-ink"), stamp = $("cas-stamp");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ctx, skipping = false, running = false;

// ---- Sound effects, synthesised ----
function audio() { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); return ctx; }
function tone(freq, dur, type = "square", gain = 0.05, slide = 0) {
  if (!window.rbmSoundEffectsOn()) return;
  try {
    const c = audio(), o = c.createOscillator(), g = c.createGain(), t = c.currentTime;
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur);
  } catch (_) {}
}
function noise(dur, gain = 0.3, lowpass = 800) {
  if (!window.rbmSoundEffectsOn()) return;
  try {
    const c = audio(), b = c.createBuffer(1, c.sampleRate * dur, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    f.type = "lowpass"; f.frequency.value = lowpass; g.gain.value = gain;
    s.buffer = b; s.connect(f).connect(g).connect(c.destination); s.start();
  } catch (_) {}
}
const clunk = () => { noise(0.12, 0.35, 1400); tone(120, 0.12, "triangle", 0.12); };
const thud = () => { noise(0.45, 0.9, 400); tone(70, 0.5, "sine", 0.4, 0.5); };
const whoosh = () => { noise(0.9, 0.35, 3000); tone(300, 0.8, "sawtooth", 0.03, 6); };
const tick = () => tone(2200 + Math.random() * 800, 0.012, "square", 0.025);

// ---- Giant VU meters ----
const vus = [...document.querySelectorAll("#cas-stage .cas-vu canvas")].map((el) => ({ el, v: 0, target: 0 }));
let vuMode = "idle";
function drawVU() {
  if (!stage.classList.contains("on")) return;
  for (const [i, m] of vus.entries()) {
    if (vuMode === "print") m.target = 0.45 + Math.random() * 0.6;
    else if (vuMode === "slam") m.target = 1.15;
    else m.target = 0.05 + 0.04 * Math.sin(performance.now() / (300 + i * 90));
    m.v += (m.target - m.v) * (m.target > m.v ? 0.4 : 0.12);
    const g = m.el.getContext("2d"), w = m.el.width, h = m.el.height, cx = w / 2, cy = h * 1.08, r = h * 0.92;
    g.clearRect(0, 0, w, h);
    for (let k = 0; k <= 30; k++) {
      const t = k / 30, a = Math.PI * (1.2 + 0.6 * t);
      g.strokeStyle = t > 0.72 ? "#c4001f" : "#3b2a00"; g.lineWidth = k % 5 ? 3 : 6;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r * 0.82, cy + Math.sin(a) * r * 0.82);
      g.lineTo(cx + Math.cos(a) * r * (k % 5 ? 0.9 : 0.97), cy + Math.sin(a) * r * (k % 5 ? 0.9 : 0.97)); g.stroke();
    }
    g.fillStyle = "#3b2a00"; g.font = "bold 34px ui-monospace, monospace"; g.fillText("VU", cx - 22, h * 0.6);
    const a = Math.PI * (1.2 + 0.6 * Math.min(1.06, m.v));
    g.strokeStyle = "#111"; g.lineWidth = 6; g.lineCap = "round";
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); g.stroke();
    if (m.v > 0.95) { g.fillStyle = "#ff1133"; g.shadowColor = "#ff1133"; g.shadowBlur = 20;
      g.beginPath(); g.arc(w * 0.9, h * 0.16, 16, 0, 7); g.fill(); g.shadowBlur = 0; }
  }
  requestAnimationFrame(drawVU);
}

// ---- Sparks ----
const sparks = $("cas-sparks"), sg = sparks.getContext("2d");
let parts = [];
function burst(x, y, n, hues) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = 3 + Math.random() * 12;
    parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 4, life: 1, hue: hues[i % hues.length] });
  }
  if (parts.length === n) requestAnimationFrame(drawSparks);
}
function drawSparks() {
  sparks.width = innerWidth; sparks.height = innerHeight; sg.globalCompositeOperation = "lighter";
  parts = parts.filter((p) => p.life > 0);
  for (const p of parts) {
    p.x += p.vx; p.y += p.vy; p.vy += 0.3; p.life -= 0.015;
    sg.fillStyle = `hsla(${p.hue},100%,65%,${p.life})`; sg.beginPath(); sg.arc(p.x, p.y, 2 + p.life * 3, 0, 7); sg.fill();
  }
  if (parts.length) requestAnimationFrame(drawSparks);
}

// ---- The show ----
async function step(ms) { if (!skipping) await wait(ms); }
async function typeInto(el, text, perChar) {
  el.innerHTML = "";
  for (let i = 0; i < text.length; i++) {
    if (skipping) { el.textContent = text; return; }
    el.innerHTML = text.slice(0, i + 1).replace(/&/g, "&amp;").replace(/</g, "&lt;") + '<span class="caret">&nbsp;</span>';
    tick(); await wait(perChar);
  }
  el.textContent = text;
}

async function exportCassette({ title, when, gaps, onDownload }) {
  if (running) return;
  running = true; skipping = false;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Reset.
  cassette.className = "cassette"; ink.className = "ink"; stamp.className = "stamp";
  $("cas-title").textContent = ""; $("cas-when").textContent = ""; $("cas-caption").textContent = "";
  document.querySelectorAll("#cas-stage .cas-vu").forEach((v) => v.classList.remove("in"));
  stage.classList.add("on"); vuMode = "idle"; requestAnimationFrame(drawVU);
  // Sound is a bonus: never wait for the browser to allow it.
  if (window.rbmSoundEffectsOn()) { try { audio().resume().catch(() => {}); } catch (_) {} }
  try {

  // 1. A blank cassette slides into view.
  await wait(30);
  cassette.classList.add("enter"); clunk(); setTimeout(clunk, 420);
  $("cas-caption").textContent = "LOADING BLANK C90";
  await step(reduce ? 100 : 850);

  // 2. Two enormous VU meters bounce while the label is printed.
  document.querySelectorAll("#cas-stage .cas-vu").forEach((v) => v.classList.add("in"));
  vuMode = "print"; cassette.classList.add("spinning", "printing");
  $("cas-caption").textContent = "PRINTING LABEL";
  // Long show names shrink to fit the label rather than being cut off.
  $("cas-title").style.fontSize = title.length > 22 ? `${Math.max(0.55, 22 / title.length)}em` : "";
  await typeInto($("cas-title"), title, reduce ? 0 : 38);
  await typeInto($("cas-when"), when, reduce ? 0 : 30);
  cassette.classList.remove("printing");
  await step(250);

  // 3. A mechanical rubber stamp slams down.
  const text = gaps ? GAP_STAMP : STAMPS[Math.floor(Math.random() * STAMPS.length)];
  ink.innerHTML = `${text}<small>${gaps ? "Check the gaps before you rely on it" : "Radio Blue Mountains · Off-Air Vault"}</small>`;
  ink.classList.toggle("gap", gaps);
  $("cas-pad").setAttribute("fill", gaps ? "#ff7a00" : "#c8102e");
  $("cas-caption").textContent = "AUTHENTICATING";
  stamp.classList.add("slam");
  await step(reduce ? 0 : 520);
  // Impact.
  thud(); vuMode = "slam"; ink.classList.add("on");
  stage.classList.remove("shake"); void stage.offsetWidth; stage.classList.add("shake");
  const r = cassette.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height * 0.68, 90, gaps ? [25, 35, 45] : [350, 0, 45]);
  await step(250); vuMode = "print";
  await step(1000);

  // 4/5. Dramatic ejection as the download begins.
  $("cas-caption").textContent = gaps ? "DISPATCHING (WITH APOLOGIES)" : "DISPATCHING TO YOUR DEVICE";
  cassette.classList.add("fast"); await step(350);
  $("cas-flash").classList.remove("go"); void $("cas-flash").offsetWidth; $("cas-flash").classList.add("go");
  whoosh(); cassette.classList.add("eject");
  burst(r.left + r.width / 2, r.top + r.height / 2, 160, [320, 185, 45, 140, 270]);
  onDownload?.();
  await step(1100);
  $("cas-caption").textContent = "DOWNLOAD STARTED ✓";
  vuMode = "idle";
  await step(900);
  } finally {
    // Whatever happens, the download must still start and the overlay must go away.
    if (!cassette.classList.contains("eject")) onDownload?.();
    stage.classList.remove("on"); running = false;
  }
}

// Skipping: any click or key jumps to the download.
stage.addEventListener("click", () => { skipping = true; });
addEventListener("keydown", () => { if (running) skipping = true; });


window.exportCassette = exportCassette;
})();
