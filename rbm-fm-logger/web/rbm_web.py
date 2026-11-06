#!/usr/bin/env python3
"""RBM off-air log download service. Python standard library only.

Serves the download page, and joins hourly/half-hourly RBMFM_ recordings into one MP3
for a requested station-local time range. Runs behind Caddy (TLS) on 127.0.0.1.

Security model:
- The browser only ever sends times, never file names or paths.
- Read-only access to the recordings (systemd sandbox + group read permission).
- One shared password (scrypt hash in config), signed HttpOnly session cookie,
  per-IP lockout after repeated wrong passwords.
- Limited range length and concurrent joins so downloads can't starve the recorder.

Resilience: every request is isolated (errors become a 500 and an alert, never a crash),
idle or stalled clients time out, and failures that need a human (joins failing, the
archive unreadable, password guessing) are pushed to the same ntfy topic as the recorder,
at most once an hour per kind of problem. The service itself is restarted by systemd and
watched from outside by rbm_web_check.py.

Run `rbm_web.py hash-password` to make WEB_PASSWORD_HASH, and
`python3 -c "import secrets; print(secrets.token_hex(32))"` for WEB_SECRET.
"""

import datetime as dt
import getpass
import hashlib
import hmac
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

RECORDINGS = Path(os.environ.get("RAID_MOUNT", "/mnt/storage")) / os.environ.get("WEB_RECORDINGS_SUBDIR", "recordings")
STATIC = Path(os.environ.get("WEB_STATIC", Path(__file__).resolve().parent / "static"))
TZ = ZoneInfo(os.environ.get("STATION_TZ", "Australia/Sydney"))
LISTEN_HOST, LISTEN_PORT = os.environ.get("WEB_LISTEN", "127.0.0.1:8080").rsplit(":", 1)
MAX_HOURS = float(os.environ.get("WEB_MAX_HOURS", "6"))
MAX_JOBS = int(os.environ.get("WEB_MAX_JOBS", "2"))
SESSION_DAYS = int(os.environ.get("WEB_SESSION_DAYS", "30"))
# Only for local testing over plain HTTP; never set in production.
INSECURE_COOKIE = os.environ.get("WEB_INSECURE_COOKIE") == "1"
BYTES_PER_SECOND = 192000 / 8  # All archive audio is 192 kbps CBR; good enough to place files.
FILE_NAME = re.compile(r"^RBMFM_(\d{8}T\d{6}[+-]\d{4})\.mp3$")
MIN_RECORDING_SECONDS = 5  # Shorter files are restart fragments or junk; leave them off the timeline.
MAX_FAILS, LOCKOUT_SECONDS = 5, 900
GUIDE_DIR = Path(os.environ.get("WEB_GUIDE_DIR", "/var/lib/rbm-guide"))
# A download is named after a show when the range and the show overlap this much.
SHOW_MATCH = 0.8
NTFY_URL = os.environ.get("NTFY_URL", "")
NTFY_TOKEN = os.environ.get("NTFY_TOKEN", "")
ALERT_REPEAT_SECONDS = 3600

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rbm-web")
jobs = threading.BoundedSemaphore(MAX_JOBS)
last_alert = {}
alert_lock = threading.Lock()


def alert(kind, title, message, priority="high"):
    """Push to ntfy in the background, at most once per ALERT_REPEAT_SECONDS per kind."""
    log.warning("ALERT %s: %s: %s", kind, title, message)
    with alert_lock:
        if time.monotonic() - last_alert.get(kind, -ALERT_REPEAT_SECONDS) < ALERT_REPEAT_SECONDS:
            return
        last_alert[kind] = time.monotonic()
    if not NTFY_URL:
        return

    def send():
        headers = {"Title": title, "Priority": priority, "Tags": "radio,globe_with_meridians"}
        if NTFY_TOKEN:
            headers["Authorization"] = "Bearer " + NTFY_TOKEN
        try:
            request = urllib.request.Request(NTFY_URL, data=message.encode(), headers=headers, method="POST")
            with urllib.request.urlopen(request, timeout=10) as response:
                response.read(64)
        except Exception as exc:
            log.error("Alert delivery failed: %s", exc)

    threading.Thread(target=send, daemon=True).start()


# --- Password and sessions -------------------------------------------------------

def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def check_password(password):
    _, salt, _ = PASSWORD_HASH.split("$")
    return hmac.compare_digest(hash_password(password, bytes.fromhex(salt)), PASSWORD_HASH)


def make_session():
    expiry = str(int(time.time()) + SESSION_DAYS * 86400)
    return expiry + "." + hmac.new(SECRET, expiry.encode(), hashlib.sha256).hexdigest()


def valid_session(token):
    expiry, _, sig = (token or "").partition(".")
    good = hmac.new(SECRET, expiry.encode(), hashlib.sha256).hexdigest()
    return expiry.isdigit() and hmac.compare_digest(sig, good) and int(expiry) > time.time()


failures = {}  # ip -> (count, locked_until)
failures_lock = threading.Lock()


# --- Recording index ---------------------------------------------------------------

class Recording:
    __slots__ = ("path", "start", "end", "rate")

    def __init__(self, path, start, seconds):
        self.path, self.start = path, start
        self.end = start + dt.timedelta(seconds=seconds)
        self.rate = None


index = []
index_time = 0.0
index_lock = threading.Lock()


def recordings():
    """All archive recordings sorted by real start time, rescanned at most once a minute."""
    global index, index_time
    with index_lock:
        if time.monotonic() - index_time > 60:
            found = []
            try:
                with os.scandir(RECORDINGS) as entries:
                    for entry in entries:
                        match = FILE_NAME.fullmatch(entry.name)
                        if match and entry.is_file(follow_symlinks=False):
                            seconds = entry.stat().st_size / BYTES_PER_SECOND
                            if seconds < MIN_RECORDING_SECONDS:
                                continue
                            start = dt.datetime.strptime(match.group(1), "%Y%m%dT%H%M%S%z")
                            found.append(Recording(Path(entry.path), start, seconds))
            except OSError as exc:
                alert("archive", "RBM download page can't read the archive",
                      f"{RECORDINGS}: {exc}. The page will show no recordings until this is fixed.", "urgent")
                raise
            if not found:
                alert("empty", "RBM download page sees no recordings",
                      f"No RBMFM_ files found in {RECORDINGS}. Is the RAID mounted?", "urgent")
            found.sort(key=lambda r: r.start)
            old = {r.path: r.rate for r in index}
            for r in found:
                r.rate = old.get(r.path)
            index, index_time = found, time.monotonic()
        return index


def sample_rate(rec):
    if rec.rate is None:
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                              "stream=sample_rate", "-of", "csv=p=0", str(rec.path)],
                             text=True, stdout=subprocess.PIPE, check=True).stdout
        rec.rate = int(out.strip())
    return rec.rate


def pieces(start, end):
    """[(recording, in_seconds, out_seconds)] covering start..end, without overlaps."""
    recs = recordings()
    chosen = []
    cursor = start
    for i, rec in enumerate(recs):
        rec_end = rec.end
        # Where recordings overlap (e.g. two sources), stop this one where the next begins.
        if i + 1 < len(recs) and recs[i + 1].start < rec_end:
            rec_end = recs[i + 1].start
        if rec_end <= cursor or rec.start >= end:
            continue
        a = max(cursor, rec.start)
        b = min(end, rec_end)
        if b > a:
            chosen.append((rec, (a - rec.start).total_seconds(), (b - rec.start).total_seconds()))
            cursor = b
    return chosen


# Holes shorter than this between recordings aren't gaps: a restart or file change loses a
# second or so, and the streamer's slow sound card makes its hours ~6 s short of audio.
GAP_TOLERANCE = 15


def missing_seconds(start, end, parts):
    """Seconds of start..end with no recording, counting only holes over GAP_TOLERANCE."""
    missing, cursor = 0.0, start
    for rec, a, b in parts:
        piece_start = rec.start + dt.timedelta(seconds=a)
        hole = (piece_start - cursor).total_seconds()
        if hole > GAP_TOLERANCE:
            missing += hole
        cursor = max(cursor, rec.start + dt.timedelta(seconds=b))
    tail = (end - cursor).total_seconds()
    if tail > GAP_TOLERANCE:
        missing += tail
    return missing


def coverage(day):
    """Recorded spans from local midnight to 06:00 the next day (so overnight shows are
    visible), as minutes since local midnight."""
    day_start = dt.datetime.combine(day, dt.time(), TZ)
    day_end = dt.datetime.combine(day + dt.timedelta(days=1), dt.time(6), TZ)
    spans = []
    for rec, a, b in pieces(day_start, day_end):
        lo = (rec.start + dt.timedelta(seconds=a) - day_start).total_seconds() / 60
        hi = (rec.start + dt.timedelta(seconds=b) - day_start).total_seconds() / 60
        if spans and lo - spans[-1][1] < 0.5:
            spans[-1][1] = hi
        else:
            spans.append([lo, hi])
    return [[round(lo, 2), round(hi, 2)] for lo, hi in spans]


# --- Programme guide ---------------------------------------------------------------
# rbm_guide_fetch.py saves the station's weekly guide every day. A date inside a
# snapshot's week gets exact show names; any other date borrows the weekly pattern from
# the nearest snapshot and marks it "probably". Overnight hours have no local shows.

guide_cache = {"mtime": None, "snapshots": []}
guide_lock = threading.Lock()


def guide_snapshots():
    """[(snapshot_date, [show, ...]), ...] oldest first, reloaded when a file changes."""
    with guide_lock:
        try:
            files = sorted(GUIDE_DIR.glob("guide-*.json"))
            mtime = max((f.stat().st_mtime for f in files), default=None), len(files)
        except OSError:
            return []
        if mtime != guide_cache["mtime"]:
            snapshots = []
            for f in files:
                try:
                    shows = json.loads(f.read_text())
                    day = dt.datetime.strptime(f.stem.removeprefix("guide-"), "%Y%m%d").date()
                    for show in shows:
                        show["_start"] = parse_local(show["start"])
                        show["_end"] = parse_local(show["end"])
                    snapshots.append((day, shows))
                except (OSError, ValueError, KeyError) as exc:
                    log.warning("Skipping guide snapshot %s: %s", f.name, exc)
            guide_cache.update(mtime=mtime, snapshots=snapshots)
        return guide_cache["snapshots"]


def shows_between(start, end):
    """Shows overlapping start..end: [{name, presenter, url, start, end, probable, schedule}]."""
    snapshots = guide_snapshots()
    if not snapshots:
        return []
    found, covered_days = {}, set()
    # Exact: the newest snapshot that actually lists each show at that moment.
    for day, shows in snapshots:
        for show in shows:
            covered_days.add(show["_start"].date())
            if show["_end"] > start and show["_start"] < end:
                found[show["_start"]] = dict(show, probable=False, schedule=f"{day:%-d %b %Y}")
    # Probable: days no snapshot covers take their weekday's shows from the nearest snapshot.
    day = start.date()
    while dt.datetime.combine(day, dt.time(), TZ) < end:
        if day not in covered_days:
            snap_day, shows = min(snapshots, key=lambda sn: abs((sn[0] - day).days))
            for show in shows:
                if show["_start"].weekday() != day.weekday():
                    continue
                offset = day - show["_start"].date()
                s_start = dt.datetime.combine(show["_start"].date() + offset, show["_start"].time(), TZ)
                s_end = s_start + (show["_end"] - show["_start"])
                if s_end > start and s_start < end and s_start not in found:
                    found[s_start] = dict(show, _start=s_start, _end=s_end, probable=True,
                                          schedule=f"{snap_day:%b %Y}")
        day += dt.timedelta(days=1)
    return [found[k] for k in sorted(found)]


def show_for_range(start, end):
    """The one show this range is essentially a recording of, or None."""
    best, best_overlap = None, 0.0
    for show in shows_between(start, end):
        overlap = (min(end, show["_end"]) - max(start, show["_start"])).total_seconds()
        if overlap > best_overlap:
            best, best_overlap = show, overlap
    if not best:
        return None
    length = (end - start).total_seconds()
    show_length = (best["_end"] - best["_start"]).total_seconds()
    return best if best_overlap >= SHOW_MATCH * length and best_overlap >= SHOW_MATCH * show_length else None


def slug(text):
    text = re.sub(r"['’]", "", text)  # "Pro's & Con's" -> "Pros-Cons", not "Pro-s-Con-s".
    return re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-")[:60] or "Show"


def parse_local(text):
    """'2026-11-05T20:00' (station local) -> aware datetime."""
    return dt.datetime.strptime(text, "%Y-%m-%dT%H:%M").replace(tzinfo=TZ)


def ffmpeg_join(parts):
    """Return (Popen, tempdir) streaming MP3 to stdout."""
    tmp = tempfile.TemporaryDirectory(prefix="rbm-web-")
    rates = {sample_rate(rec) for rec, _, _ in parts}
    base = ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error"]
    if len(rates) == 1:
        # Same format throughout: copy the audio as it is, no re-encoding.
        listing = Path(tmp.name) / "list.txt"
        with listing.open("w") as f:
            for rec, a, b in parts:
                f.write(f"file '{rec.path}'\ninpoint {a:.3f}\noutpoint {b:.3f}\n")
        cmd = base + ["-f", "concat", "-safe", "0", "-i", str(listing),
                      "-map", "0:a", "-c", "copy", "-f", "mp3", "pipe:1"]
    else:
        # Mixed 44.1/48 kHz sources: resample and re-encode only this download.
        cmd = list(base)
        for rec, a, b in parts:
            cmd += ["-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", str(rec.path)]
        graph = "".join(f"[{i}:a]aresample=48000[a{i}];" for i in range(len(parts)))
        graph += "".join(f"[a{i}]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=0:a=1[out]"
        cmd += ["-filter_complex", graph, "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "192k",
                "-f", "mp3", "pipe:1"]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL), tmp


# --- HTTP ------------------------------------------------------------------------

STATIC_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
                ".webmanifest": "application/manifest+json", ".png": "image/png"}
# A fixed list: the browser can never ask for any other file.
STATIC_FILES = {"/": "index.html", "/app.css": "app.css", "/app.js": "app.js",
                "/cassette.css": "cassette.css", "/cassette.js": "cassette.js",
                "/sw.js": "sw.js", "/manifest.webmanifest": "manifest.webmanifest",
                "/icons/icon-180.png": "icons/icon-180.png", "/icons/icon-192.png": "icons/icon-192.png",
                "/icons/icon-512.png": "icons/icon-512.png"}


class Handler(BaseHTTPRequestHandler):
    server_version = "RBM-Vault"
    sys_version = ""
    # Drop clients that stall (slow requests, or listeners that stop reading a download).
    timeout = 60

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception as exc:
            self.close_connection = True
            log.error("UNHANDLED %s\n%s", exc, traceback.format_exc())
            alert("error", "RBM download page error",
                  f"{type(exc).__name__}: {exc} (on {getattr(self, 'path', '?')}). See journalctl -u rbm-web.")
            try:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "something went wrong; the station has been notified"})
            except Exception:
                pass

    def log_message(self, fmt, *args):
        log.info("%s %s", self.client_ip(), fmt % args)

    def client_ip(self):
        # Caddy is the only client (we listen on localhost). It sets X-Real-IP to the real
        # visitor, already resolved through Cloudflare if the page is ever proxied.
        real = self.headers.get("X-Real-IP", "").strip()
        forwarded = self.headers.get("X-Forwarded-For", "").split(",")[-1].strip()
        return real or forwarded or self.client_address[0]

    def common_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; media-src 'self' blob:; img-src 'self' data:; "
                         "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

    def send_json(self, status, body, cookie=None):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.common_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def authed(self):
        for part in self.headers.get("Cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == "rbm_session" and valid_session(value):
                return True
        return False

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path in STATIC_FILES:
            return self.static(STATIC_FILES[url.path])
        if not self.authed():
            return self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "login"})
        query = dict(urllib.parse.parse_qsl(url.query))
        try:
            if url.path == "/api/coverage":
                day = dt.date.fromisoformat(query["date"])
                return self.send_json(HTTPStatus.OK, {"date": day.isoformat(), "spans": coverage(day),
                                                      "max_hours": MAX_HOURS})
            if url.path == "/api/audio":
                return self.audio(parse_local(query["start"]), parse_local(query["end"]),
                                  query.get("download") == "1", query.get("check") == "1")
            if url.path == "/api/info":
                # For the marquee: what's on air now, and how far back the archive goes.
                now = dt.datetime.now(TZ)
                recs = recordings()
                on_air = next((sh for sh in shows_between(now, now + dt.timedelta(minutes=1)) if not sh["probable"]), None)
                return self.send_json(HTTPStatus.OK, {
                    "on_air": on_air and {"name": on_air["name"], "presenter": on_air["presenter"]},
                    "oldest": recs[0].start.date().isoformat() if recs else None,
                    "hours": round(sum((r.end - r.start).total_seconds() for r in recs) / 3600)})
            if url.path == "/api/shows":
                day = dt.date.fromisoformat(query["date"])
                day_start = dt.datetime.combine(day, dt.time(), TZ)
                # Same window as the timeline: midnight to 06:00 the next day.
                shows = shows_between(day_start, day_start + dt.timedelta(hours=30))
                return self.send_json(HTTPStatus.OK, {"date": day.isoformat(), "shows": [{
                    "name": sh["name"], "presenter": sh["presenter"], "url": sh["url"],
                    "from": round((sh["_start"] - day_start).total_seconds() / 60, 2),
                    "to": round((sh["_end"] - day_start).total_seconds() / 60, 2),
                    "probable": sh["probable"], "schedule": sh["schedule"]} for sh in shows]})
            if url.path == "/api/segments":
                return self.segments(parse_local(query["start"]), parse_local(query["end"]))
            if url.path == "/api/file":
                return self.recording_file(query["id"])
        except (KeyError, ValueError):
            return self.send_json(HTTPStatus.BAD_REQUEST, {"error": "bad request"})
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/api/logout":
            return self.send_json(HTTPStatus.OK, {"ok": True}, self.cookie("", 0))
        if url.path != "/api/login" or self.headers.get("Content-Type") != "application/json":
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        ip = self.client_ip()
        with failures_lock:
            count, until = failures.get(ip, (0, 0))
            if until > time.time():
                return self.send_json(HTTPStatus.TOO_MANY_REQUESTS,
                                      {"error": "locked", "retry_after": int(until - time.time())})
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            password = json.loads(self.rfile.read(length)).get("password", "")
        except (ValueError, AttributeError):
            return self.send_json(HTTPStatus.BAD_REQUEST, {"error": "bad request"})
        if isinstance(password, str) and check_password(password):
            with failures_lock:
                failures.pop(ip, None)
            log.info("LOGIN_OK %s", ip)
            return self.send_json(HTTPStatus.OK, {"ok": True}, self.cookie(make_session(), SESSION_DAYS * 86400))
        with failures_lock:
            count += 1
            failures[ip] = (count, time.time() + LOCKOUT_SECONDS if count >= MAX_FAILS else 0)
        log.warning("LOGIN_FAILED %s attempt=%d", ip, count)
        if count == MAX_FAILS:
            alert("lockout", "RBM download page: repeated wrong passwords",
                  f"{ip} was locked out for {LOCKOUT_SECONDS // 60} min after {MAX_FAILS} wrong passwords. "
                  "One-off is probably a presenter; repeats may be someone guessing.", "default")
        time.sleep(1)  # Slow down guessing.
        self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "wrong password"})

    def cookie(self, value, max_age):
        flags = "" if INSECURE_COOKIE else "; Secure"
        return f"rbm_session={value}; Max-Age={max_age}; Path=/; HttpOnly; SameSite=Strict{flags}"

    def static(self, name):
        data = (STATIC / name).read_bytes()
        self.send_response(HTTPStatus.OK)
        self.common_headers()
        self.send_header("Content-Type", STATIC_TYPES[Path(name).suffix])
        # Icons rarely change; everything else is revalidated so updates show at once.
        self.send_header("Cache-Control", "public, max-age=604800" if name.startswith("icons/") else "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def segments(self, start, end):
        """The pieces of the range, for the in-browser player to stream file by file."""
        if end <= start:
            end += dt.timedelta(days=1)
        if (end - start).total_seconds() > MAX_HOURS * 3600:
            return self.send_json(HTTPStatus.BAD_REQUEST, {"error": f"maximum {MAX_HOURS:g} hours"})
        parts = pieces(start, end)
        if not parts:
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "nothing recorded in that range"})
        self.send_json(HTTPStatus.OK, {
            "duration": (end - start).total_seconds(),
            "missing": missing_seconds(start, end, parts),
            "segments": [{"id": rec.path.name, "in": round(a, 3), "out": round(b, 3),
                          "at": round((rec.start - start).total_seconds() + a, 3)}
                         for rec, a, b in parts]})

    def recording_file(self, name):
        """One recording, with HTTP Range support so the browser can seek within it.
        The name is only used to look the file up in the index, never as a path."""
        rec = next((r for r in recordings() if r.path.name == name), None)
        if rec is None:
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        size = rec.path.stat().st_size
        first, last = 0, size - 1
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if match and (match.group(1) or match.group(2)):
            if match.group(1):
                first = int(match.group(1))
                last = min(int(match.group(2)), size - 1) if match.group(2) else size - 1
            else:
                first = max(0, size - int(match.group(2)))
            if first > last:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
        partial = match is not None and (first, last) != (0, size - 1)
        self.send_response(HTTPStatus.PARTIAL_CONTENT if partial else HTTPStatus.OK)
        self.common_headers()
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, max-age=3600")
        self.send_header("Content-Length", str(last - first + 1))
        if partial:
            self.send_header("Content-Range", f"bytes {first}-{last}/{size}")
        self.end_headers()
        try:
            with rec.path.open("rb") as f:
                f.seek(first)
                remaining = last - first + 1
                while remaining and (chunk := f.read(min(65536, remaining))):
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # The browser seeks by dropping one request and starting another.

    def audio(self, start, end, download, check_only):
        if end <= start:
            end += dt.timedelta(days=1)  # e.g. 23:00 -> 01:00 runs past midnight.
        requested = (end - start).total_seconds()
        if requested > MAX_HOURS * 3600:
            return self.send_json(HTTPStatus.BAD_REQUEST, {"error": f"maximum {MAX_HOURS:g} hours"})
        parts = pieces(start, end)
        if not parts:
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "nothing recorded in that range"})
        show = show_for_range(start, end)
        if check_only:
            return self.send_json(HTTPStatus.OK, {
                "requested": requested, "covered": requested - missing_seconds(start, end, parts),
                "show": show and {"name": show["name"], "presenter": show["presenter"],
                                  "probable": show["probable"], "schedule": show["schedule"]}})
        if not jobs.acquire(blocking=False):
            return self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "busy, try again shortly"})
        proc = tmp = None
        try:
            proc, tmp = ffmpeg_join(parts)
            covered = requested - missing_seconds(start, end, parts)
            # Say so in the file name too, so a saved file can't pass as complete.
            incomplete = "_INCOMPLETE" if covered < requested else ""
            if show:
                # e.g. RBMFM_Strange-Brew-Breakfast_20261105_0700-0900.mp3
                name = f"RBMFM_{slug(show['name'])}_{start:%Y%m%d_%H%M}-{end:%H%M}{incomplete}.mp3"
            else:
                name = f"RBMFM_{start:%Y%m%dT%H%M}-{end:%Y%m%dT%H%M}{incomplete}.mp3"
            self.send_response(HTTPStatus.OK)
            self.common_headers()
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-RBM-Covered-Seconds", f"{covered:.0f}")
            if download:
                self.send_header("Content-Disposition", f'attachment; filename="{name}"')
            self.end_headers()
            log.info("AUDIO %s %s -> %s files=%d covered=%ds", self.client_ip(), start, end, len(parts), covered)
            sent = 0
            while chunk := proc.stdout.read(65536):
                self.wfile.write(chunk)
                sent += len(chunk)
            if proc.wait() != 0 or sent == 0:
                error = proc.stderr.read(2000).decode("utf-8", "replace").strip()
                log.error("JOIN_FAILED %s -> %s code=%s bytes=%d %s", start, end, proc.returncode, sent, error)
                alert("join", "RBM download failed",
                      f"Joining {start:%Y-%m-%d %H:%M} to {end:%H:%M} failed (ffmpeg exit {proc.returncode}, "
                      f"{sent} bytes sent): {error or 'no error output'}")
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass  # Listener closed the page, stopped the download, or stalled.
        finally:
            if proc:
                proc.kill()
                proc.wait()
            if tmp:
                tmp.cleanup()
            jobs.release()


def main():
    global PASSWORD_HASH, SECRET
    if sys.argv[1:] == ["hash-password"]:
        first = getpass.getpass("New presenter password: ")
        if first != getpass.getpass("Again: ") or len(first) < 8:
            raise SystemExit("Passwords differ or are shorter than 8 characters.")
        print(hash_password(first))
        return
    PASSWORD_HASH = os.environ["WEB_PASSWORD_HASH"]
    SECRET = bytes.fromhex(os.environ["WEB_SECRET"])
    server = ThreadingHTTPServer((LISTEN_HOST, int(LISTEN_PORT)), Handler)
    server.daemon_threads = True
    log.info("RBM web listening on %s:%s, recordings=%s", LISTEN_HOST, LISTEN_PORT, RECORDINGS)
    server.serve_forever()


if __name__ == "__main__":
    main()
