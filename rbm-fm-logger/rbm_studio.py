#!/usr/bin/env python3
"""RBM studio recorder: records Studio-A's Program-L/R straight off the Dante network.
Python standard library only.

Inferno2pipe (an unofficial, open-source Dante receiver) delivers the audio as raw 32-bit
samples; this script cuts it into hourly MP3 files on the station-local clock hour, named
RBMSTUDIO_YYYYMMDDTHHMMSS+HHMM.mp3 like the FM off-air files.

Inferno only produces audio while a Dante flow is arriving. A short dropout (under
STUDIO_GAP_SECONDS) is filled with silence so the file stays on the clock. A longer
outage closes the file instead: the studio copy then has an honest hole, which the
download page fills from the FM off-air recording, rather than a stretch of fake
silence. This script also restarts Inferno and alerts. The FM off-air recorder is a
separate service and is never touched by this one.

The Dante clock and the logger's clock drift apart by a fraction of a second an hour.
Each hourly split snaps back to the exact hour, so the drift never builds up.
"""

import datetime as dt
import logging
import os
from pathlib import Path
import queue
import signal
import subprocess
import threading
import time
import urllib.request
from zoneinfo import ZoneInfo

MOUNT = Path(os.environ.get("RAID_MOUNT", "/mnt/storage"))
STUDIO = MOUNT / os.environ.get("STUDIO_SUBDIR", "studio")
INFERNO = os.environ.get("INFERNO_BIN", "/usr/local/lib/rbm-dante/inferno2pipe")
DANTE_NAME = os.environ.get("DANTE_NAME", "RBM-Logger")
CHANNELS = 2
RATE = int(os.environ.get("DANTE_SAMPLE_RATE", "48000"))
BITRATE = os.environ.get("STUDIO_BITRATE", os.environ.get("BITRATE", "192k"))
STATION_TZ = ZoneInfo(os.environ.get("STATION_TZ", "Australia/Sydney"))
# No Dante audio for this long: restart Inferno. For this long: alert.
RESTART_AFTER = int(os.environ.get("STUDIO_RESTART_SECONDS", "30"))
ALERT_AFTER = int(os.environ.get("STUDIO_ALERT_SECONDS", "120"))
# Dropouts shorter than this are filled with silence (a splice of off-air audio would be
# more noticeable); longer ones end the file, and the page fills the hole from off-air.
GAP_AFTER = float(os.environ.get("STUDIO_GAP_SECONDS", "2"))
NTFY_URL = os.environ.get("NTFY_URL", "")
NTFY_TOKEN = os.environ.get("NTFY_TOKEN", "")
FRAME = 4 * CHANNELS  # bytes per sample frame (s32le, interleaved)
# Fill with silence once the audio is this far behind the clock; if it gets this far
# ahead (a burst after a stall) drop the excess.
PAD_AFTER, DROP_AFTER = 0.5, 2.0

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rbm-studio")
stopping = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stopping.set())
signal.signal(signal.SIGINT, lambda *_: stopping.set())


def notify(title, message, priority="high"):
    log.warning("ALERT: %s: %s", title, message)
    if not NTFY_URL:
        return
    headers = {"Title": title, "Priority": priority, "Tags": "radio,studio_microphone"}
    if NTFY_TOKEN:
        headers["Authorization"] = "Bearer " + NTFY_TOKEN
    try:
        req = urllib.request.Request(NTFY_URL, data=message.encode(), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read(64)
    except Exception as exc:
        log.error("Notification delivery failed: %s", exc)


def storage_ok():
    return MOUNT.is_mount() and STUDIO.is_dir()


def next_hour(t):
    """Epoch seconds of the next station-local clock hour after epoch t."""
    local = dt.datetime.fromtimestamp(t, STATION_TZ)
    return (local.replace(minute=0, second=0, microsecond=0) + dt.timedelta(hours=1)).timestamp()


class Encoder:
    """One hourly MP3 file being written by FFmpeg."""

    def __init__(self, start):
        name = dt.datetime.fromtimestamp(start, STATION_TZ).strftime("RBMSTUDIO_%Y%m%dT%H%M%S%z.mp3")
        self.path = STUDIO / name
        self.proc = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error",
             "-f", "s32le", "-ar", str(RATE), "-ac", str(CHANNELS), "-i", "pipe:0",
             "-c:a", "libmp3lame", "-b:a", BITRATE, "-f", "mp3", "-n", str(self.path)],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            start_new_session=True)  # Ctrl-C/stop signals are ours to handle: close cleanly.
        log.info("FILE_OPENED %s", name)

    def write(self, data):
        self.proc.stdin.write(data)

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            code = self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            code = self.proc.wait()
        if code:
            log.error("ENCODER_FAILED %s code=%s %s", self.path.name, code,
                      self.proc.stderr.read(1000).decode("utf-8", "replace").strip())


class Inferno:
    """Inferno2pipe, writing raw audio to our pipe; a thread queues what arrives."""

    def __init__(self):
        env = dict(os.environ, INFERNO_NAME=DANTE_NAME, INFERNO_SAMPLE_RATE=str(RATE),
                   RUST_LOG=os.environ.get("RUST_LOG", "info"))
        self.proc = subprocess.Popen([INFERNO, "-c", str(CHANNELS), "-o", "/dev/stdout"], env=env,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                     start_new_session=True)
        self.chunks = queue.Queue(maxsize=2000)  # ~20 s of audio at most
        self.last_data = None
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._log, daemon=True).start()
        log.info("INFERNO_STARTED pid=%d name=%s", self.proc.pid, DANTE_NAME)

    def _read(self):
        while chunk := self.proc.stdout.read1(65536):
            self.last_data = time.monotonic()
            try:
                self.chunks.put_nowait(chunk)
            except queue.Full:
                pass  # The writer is stuck; the pad/drop logic sorts out the timing.

    def _log(self):
        for line in self.proc.stderr:
            text = line.decode("utf-8", "replace").rstrip()
            # Inferno is chatty at startup; keep what matters.
            if any(w in text for w in ("ERROR", "WARN", "panicked", "subscription", "receiving data")):
                log.info("INFERNO %s", text[:300])

    def alive(self):
        return self.proc.poll() is None

    def stop(self):
        if self.alive():
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()


def main():
    log.info("STUDIO_BOOT dir=%s dante_name=%s rate=%d bitrate=%s", STUDIO, DANTE_NAME, RATE, BITRATE)
    inferno = Inferno()
    started = time.monotonic()
    enc = None
    pos = None            # epoch time of the next sample frame to be written
    boundary = None       # epoch time at which the current file ends
    leftover = b""        # partial frame carried between chunks
    silent_since = time.monotonic()  # no Dante audio since (monotonic)
    alerted = storage_alerted = False
    last_restart = time.monotonic()
    padded = 0.0

    def write(data):
        """Write whole frames, splitting files at each clock hour."""
        nonlocal enc, pos, boundary
        while data:
            if enc is None:
                enc, boundary = Encoder(pos), next_hour(pos)
            room = max(0, round((boundary - pos) * RATE)) * FRAME
            part, data = data[:room], data[room:]
            if part:
                enc.write(part)
                pos += len(part) / FRAME / RATE
            if data or pos >= boundary - 0.5 / RATE:
                enc.close()
                # Absorb the drift between the Dante clock and the logger's clock here.
                pos, enc = boundary, None

    try:
        while not stopping.is_set():
            now_m, now = time.monotonic(), time.time()

            if not storage_ok():
                if enc:
                    enc.close()
                    enc = None
                pos = None
                if not storage_alerted:
                    notify("RBM studio recording stopped", f"{STUDIO} is not available (RAID not mounted?).", "urgent")
                    storage_alerted = True
                time.sleep(5)
                continue
            if storage_alerted:
                notify("RBM studio recording restored", "The archive is available again.", "default")
                storage_alerted = False
            # Audio that has arrived. A new file starts when audio does.
            got = 0
            while True:
                try:
                    chunk = inferno.chunks.get_nowait()
                except queue.Empty:
                    break
                chunk = leftover + chunk
                cut = len(chunk) - len(chunk) % FRAME
                leftover = chunk[cut:]
                if pos is None:
                    pos = now - cut / FRAME / RATE
                if pos - now > DROP_AFTER:
                    continue  # Far ahead of the clock: drop it.
                write(chunk[:cut])
                got += cut

            if got:
                if silent_since is not None:
                    gap = now_m - silent_since
                    if gap > 2 and now_m - started > 5:
                        log.warning("DANTE_AUDIO_BACK after %.0fs (%.1fs filled with silence)", gap, padded)
                    if alerted:
                        notify("RBM studio audio is back",
                               f"Dante audio is arriving again after about {gap / 60:.0f} min.", "default")
                    silent_since, alerted, padded = None, False, 0.0
            elif silent_since is None and (inferno.last_data is None or now_m - inferno.last_data > 1):
                silent_since = now_m

            if silent_since is not None and pos is not None:
                if now_m - silent_since > GAP_AFTER:
                    # A real outage: end the file here rather than record fake silence.
                    if enc:
                        enc.close()
                        log.warning("FILE_CLOSED_NO_AUDIO %s after %.0fs without Dante audio",
                                    enc.path.name, now_m - silent_since)
                    enc = pos = None
                elif now - pos > PAD_AFTER:
                    # A short dropout: fill with silence to stay on the clock.
                    frames = int((now - pos - 0.1) * RATE)
                    padded += frames / RATE
                    write(bytes(frames * FRAME))

            if silent_since is not None:
                quiet = now_m - silent_since
                if quiet > ALERT_AFTER and not alerted:
                    why = "Inferno keeps exiting" if not inferno.alive() else "no Dante flow is arriving"
                    notify("RBM studio recording has no audio",
                           f"No Dante audio from Studio-A for {quiet / 60:.0f} min ({why}). The studio copy has a "
                           f"gap (the download page uses the off-air recording there); FM recording is unaffected. Check journalctl -u rbm-studio, "
                           f"and that Program-L/R@Studio-A is routed to {DANTE_NAME} in Dante Controller.", "high")
                    alerted = True
                if (not inferno.alive() or quiet > RESTART_AFTER) and now_m - last_restart > RESTART_AFTER:
                    log.warning("INFERNO_RESTART alive=%s quiet=%.0fs", inferno.alive(), quiet)
                    inferno.stop()
                    inferno = Inferno()
                    last_restart = now_m
            time.sleep(0.2)
    finally:
        inferno.stop()
        if enc:
            enc.close()
        log.info("STUDIO_STOP")


if __name__ == "__main__":
    main()
