#!/usr/bin/env python3
"""RBM FM off-air logger supervisor. Python standard library only.

Captures a named ALSA card with FFmpeg, segments MP3 on local clock-hour boundaries,
alerts without stopping on silence, and restarts recording after real faults.
Never reboots the machine or touches broadcast equipment.
"""

import datetime as dt
import logging
from logging.handlers import WatchedFileHandler
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

# Service settings are supplied via /etc/rbm-logger.conf (systemd EnvironmentFile).
MOUNT = Path(os.environ.get("RAID_MOUNT", "/mnt/storage"))
RECORDINGS = MOUNT / "recordings"
# Preferred: filesystem UUID (findmnt -no UUID /mnt/storage). It survives md0 -> md127
# renames and LVM/LUKS layers. RAID_BLOCK_DEVICE is only used when no UUID is set.
RAID_FS_UUID = os.environ.get("RAID_FS_UUID", "").strip()
RAID_BLOCK_DEVICE = Path(os.environ.get("RAID_BLOCK_DEVICE", "/dev/md0"))
CARD_ID = os.environ.get("ALSA_CARD_ID", "Device")
ALSA_DEVICE = os.environ.get("ALSA_DEVICE", f"plughw:CARD={CARD_ID},DEV=0")
INPUT_CHANNELS = int(os.environ.get("INPUT_CHANNELS", "2"))
SAMPLE_RATE = int(os.environ.get("SAMPLE_RATE", "48000"))
BITRATE = os.environ.get("BITRATE", "192k")
SILENCE_DB = int(os.environ.get("SILENCE_DB", "-50"))
SILENCE_SECONDS = int(os.environ.get("SILENCE_SECONDS", "900"))
MIN_FREE_GIB = int(os.environ.get("MIN_FREE_GIB", "30"))
# Legal/minimum archive the station must keep. Alert if storage pressure eats into it.
REQUIRED_RETENTION_DAYS = int(os.environ.get("REQUIRED_RETENTION_DAYS", "42"))
MIN_RETENTION_AGE_SECONDS = int(os.environ.get("MIN_RETENTION_AGE_SECONDS", "7200"))
STALL_SECONDS = int(os.environ.get("STALL_SECONDS", "90"))
ALERT_AFTER_SECONDS = int(os.environ.get("ALERT_AFTER_SECONDS", "60"))
NTFY_URL = os.environ.get("NTFY_URL", "")
NTFY_TOKEN = os.environ.get("NTFY_TOKEN", "")
HEARTBEAT_URL = os.environ.get("HEARTBEAT_URL", "")
# Optional override; normally the md array is found from the mounted filesystem.
RAID_DEGRADED_PATH = os.environ.get("RAID_DEGRADED_PATH", "").strip()
LOGFILE = Path("/var/lib/rbm-logger/events.log")
GIB = 1024 ** 3
# Station local time, ISO 8601 basic format with UTC offset, e.g.
# RBMFM_20261105T210000+1100.mp3. The offset keeps the repeated April DST hour unambiguous.
STATION_TZ = os.environ.get("STATION_TZ", "Australia/Sydney")
FILE_NAME = re.compile(r"^RBMFM_(\d{8}T\d{6}[+-]\d{4})\.mp3$")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rbm-logger")
LOGFILE.parent.mkdir(parents=True, exist_ok=True)
fh = WatchedFileHandler(LOGFILE, encoding="utf-8")
fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
log.addHandler(fh)

shutdown_requested = False


def shutdown_handler(signum, _frame):
    global shutdown_requested
    shutdown_requested = True


signal.signal(signal.SIGTERM, shutdown_handler)
signal.signal(signal.SIGINT, shutdown_handler)


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def notify(title, message, priority="high"):
    # All local events are logged, even if push notification is not configured.
    log.warning("ALERT: %s: %s", title, message)
    if not NTFY_URL:
        return
    try:
        headers = {"Title": title, "Priority": priority, "Tags": "radio,warning"}
        if NTFY_TOKEN:
            headers["Authorization"] = "Bearer " + NTFY_TOKEN
        request = urllib.request.Request(
            NTFY_URL, data=message.encode("utf-8"), headers=headers, method="POST"
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            response.read(64)
    except Exception as exc:
        log.error("Notification delivery failed: %s", exc)


def heartbeat():
    if not HEARTBEAT_URL:
        return
    try:
        with urllib.request.urlopen(HEARTBEAT_URL, timeout=5) as response:
            response.read(64)
    except Exception as exc:
        log.warning("External heartbeat failed: %s", exc)


def card_present():
    try:
        contents = Path("/proc/asound/cards").read_text()
    except OSError:
        return False
    # ALSA assigns a durable textual card ID (within a single machine), while
    # numerical card indexes are subject to change on reconnect/reboot.
    return re.search(r"\[\s*" + re.escape(CARD_ID) + r"\s*\]", contents) is not None


def expected_device():
    if RAID_FS_UUID:
        return Path("/dev/disk/by-uuid") / RAID_FS_UUID
    return RAID_BLOCK_DEVICE


def md_degraded_paths():
    """Find md arrays under the mounted filesystem, through LVM/LUKS layers."""
    if RAID_DEGRADED_PATH:
        return [Path(RAID_DEGRADED_PATH)]
    try:
        dev = MOUNT.stat().st_dev
    except OSError:
        return []
    found, seen = [], set()
    pending = [Path(f"/sys/dev/block/{os.major(dev)}:{os.minor(dev)}").resolve()]
    while pending:
        node = pending.pop()
        if node in seen:
            continue
        seen.add(node)
        # A partition's md/ and slaves/ live on its parent device.
        for candidate in (node, node.parent):
            if (candidate / "md" / "degraded").exists():
                found.append(candidate / "md" / "degraded")
        slaves = node / "slaves"
        if slaves.is_dir():
            pending.extend(child.resolve() for child in slaves.iterdir())
    return sorted(set(found))


def raid_state():
    paths = md_degraded_paths()
    if not paths:
        return "unknown"
    try:
        counts = [int(path.read_text().strip()) for path in paths]
    except (ValueError, OSError):
        return "unknown"
    return "degraded" if any(counts) else "healthy"


def storage_mounted():
    # Protect the OS/root filesystem when RAID mount is missing.
    if not (MOUNT.is_mount() and RECORDINGS.is_dir()):
        return False
    try:
        # Ensure this is actually the expected filesystem, not an
        # accidentally mounted USB stick or other substitute filesystem.
        return MOUNT.stat().st_dev == expected_device().stat().st_rdev
    except OSError:
        return False


def recording_start(name):
    """Real start time of a recording, from its name (name sort is wrong for one DST hour)."""
    return dt.datetime.strptime(FILE_NAME.fullmatch(name).group(1), "%Y%m%dT%H%M%S%z")


def recording_files():
    # Ignore every non-RBM file. Never follow symlinks for the cleaner.
    with os.scandir(RECORDINGS) as entries:
        for entry in entries:
            if FILE_NAME.fullmatch(entry.name) and entry.is_file(follow_symlinks=False):
                yield entry.name, entry.stat(follow_symlinks=False)


def newest_file_signature():
    """Detect actual file-size/mtime progression, rather than just PID health."""
    latest = None
    for name, stat in recording_files():
        value = (stat.st_mtime_ns, name, stat.st_size)
        if latest is None or value > latest:
            latest = value
    return latest


retention_warned = False


def check_retention_floor(removed_young):
    """Alert once when storage pressure has deleted audio inside the required period."""
    global retention_warned
    if removed_young and not retention_warned:
        notify("RBM archive below required retention",
               f"Low disk space forced deletion of recordings newer than {REQUIRED_RETENTION_DAYS} days "
               f"(newest deleted: {removed_young}). Add storage or reduce BITRATE.", "urgent")
        retention_warned = True


def purge_old():
    free = shutil.disk_usage(MOUNT).free
    threshold = MIN_FREE_GIB * GIB
    if free >= threshold:
        return True

    now = time.time()
    eligible = []
    mtimes = {}
    for name, stat in recording_files():
        # Never delete the active MP3 or anything created in the last two hours.
        if now - stat.st_mtime >= MIN_RETENTION_AGE_SECONDS:
            eligible.append((name, stat.st_size))
            mtimes[name] = stat.st_mtime

    # Sort by real start time, so the repeated DST hour is handled correctly.
    eligible.sort(key=lambda item: recording_start(item[0]))
    removed = 0
    reclaimed = 0
    required_cutoff = now - REQUIRED_RETENTION_DAYS * 86400
    removed_young = None
    for name, byte_count in eligible:
        if free >= threshold:
            break
        path = RECORDINGS / name
        try:
            path.unlink()
        except OSError as exc:
            log.error("Unable to delete %s: %s", path, exc)
            continue
        removed += 1
        reclaimed += byte_count
        if mtimes[name] >= required_cutoff:
            removed_young = name
        free = shutil.disk_usage(MOUNT).free
    if removed:
        log.info("RETENTION removed %d oldest files, reclaimed %.2f GiB, free now %.2f GiB",
                 removed, reclaimed / GIB, free / GIB)
    if removed_young:
        log.error("RETENTION_FLOOR_BREACHED required_days=%d newest_deleted=%s",
                  REQUIRED_RETENTION_DAYS, removed_young)
    check_retention_floor(removed_young)
    return free >= threshold


def ffmpeg_command():
    return [
        "ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info",
        "-thread_queue_size", "1024", "-f", "alsa",
        "-sample_rate", str(SAMPLE_RATE), "-channels", str(INPUT_CHANNELS),
        "-i", ALSA_DEVICE,
        "-af", f"silencedetect=noise={SILENCE_DB}dB:d={SILENCE_SECONDS}",
        "-c:a", "libmp3lame", "-b:a", BITRATE,
        "-ar", str(SAMPLE_RATE), "-ac", "2",
        "-f", "segment", "-segment_format", "mp3",
        "-segment_time", "3600", "-segment_atclocktime", "1",
        "-reset_timestamps", "1", "-strftime", "1",
        str(RECORDINGS / "RBMFM_%Y%m%dT%H%M%S%z.mp3"),
    ]


SNAP_SECONDS = 5
OPENING = re.compile(r"Opening '([^']+\.mp3)' for writing")


def snap_to_hour(path):
    """FFmpeg names each hourly file from the clock when it opens it, which can be a moment
    before the hour (the sound card's clock runs slightly fast), giving T215959 instead of
    T220000. Rename such a file to the hour. Linux lets FFmpeg keep writing the open file."""
    path = Path(path)
    match = FILE_NAME.fullmatch(path.name)
    if not match or path.parent != RECORDINGS:
        return
    start = recording_start(path.name)
    hour = (start + dt.timedelta(seconds=SNAP_SECONDS)).replace(minute=0, second=0)
    if start == hour or abs((start - hour).total_seconds()) > SNAP_SECONDS:
        return
    target = path.with_name(hour.astimezone(ZoneInfo(STATION_TZ)).strftime("RBMFM_%Y%m%dT%H%M%S%z.mp3"))
    try:
        if not target.exists():
            path.rename(target)
            log.info("SEGMENT_RENAMED %s -> %s", path.name, target.name)
    except OSError as exc:
        log.warning("SEGMENT_RENAME_FAILED %s: %s", path.name, exc)


def start_ffmpeg(messages):
    env = os.environ.copy()
    env["TZ"] = STATION_TZ  # Filename clock and hourly segment boundaries are station local time.
    proc = subprocess.Popen(ffmpeg_command(), stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                            env=env, start_new_session=True)

    def read_stderr():
        with proc.stderr:
            for line in proc.stderr:
                text = line.decode("utf-8", "replace").strip()
                try:
                    messages.put_nowait((proc.pid, text))
                except queue.Full:
                    pass  # Avoid unbounded RAM usage if ALSA produces an error flood.

    threading.Thread(target=read_stderr, name=f"ffmpeg-{proc.pid}-stderr", daemon=True).start()
    log.info("RECORDER_STARTED pid=%d source=%s UTC=%s", proc.pid, ALSA_DEVICE, utc_now())
    return proc


def stop_ffmpeg(proc, reason):
    if proc is None or proc.poll() is not None:
        return
    log.warning("RECORDER_STOPPING pid=%s reason=%s", proc.pid, reason)
    try:
        proc.send_signal(signal.SIGINT)  # Allow MP3 trailer to be written.
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def main():
    if not NTFY_URL:
        log.warning("Push notifications disabled: configure NTFY_URL to enable remote alerts")
    if not HEARTBEAT_URL:
        log.warning("External offline monitoring disabled: configure HEARTBEAT_URL")
    log.info("LOGGER_BOOT source=%s card_id=%s mount=%s bitrate=%s silence=%sdB/%ss",
             ALSA_DEVICE, CARD_ID, MOUNT, BITRATE, SILENCE_DB, SILENCE_SECONDS)

    proc = None
    messages = queue.Queue(maxsize=1000)
    signature = None
    last_progress = time.monotonic()
    down_since = time.monotonic()
    down_message = "Waiting for recorder startup"
    down_notified = False
    next_start = 0
    next_cleanup = 0
    next_raid_check = 0
    next_heartbeat = 0
    raid_previous = None
    disk_full_warned = False
    last_stall_alert = float("-inf")
    silence_active = False
    segments_opened = 0
    ever_healthy = False
    had_audio = False

    def mark_down(reason):
        nonlocal down_since, down_message, down_notified, had_audio
        if had_audio:
            log.error("RECORDING_GAP_BEGIN time=%s reason=%s", utc_now(), reason)
        if down_since is None:
            down_since = time.monotonic()
        down_message = reason
        down_notified = False if had_audio else down_notified
        had_audio = False

    try:
        while not shutdown_requested:
            now = time.monotonic()
            mounted = storage_mounted()
            card = card_present()

            # Housekeeping must run whether recording is up or down.
            if now >= next_raid_check:
                next_raid_check = now + 60
                state = raid_state()
                if state != raid_previous:
                    if state == "healthy":
                        log.info("RAID_HEALTHY time=%s", utc_now())
                        if raid_previous in ("degraded", "unknown"):
                            notify("RBM RAID recovered", "RAID health reports healthy again.", "default")
                    else:
                        notify("RBM RAID " + state.upper(),
                               f"RAID state is {state}; inspect cat /proc/mdstat and mdadm --detail immediately.",
                               "urgent")
                    raid_previous = state

            if mounted and now >= next_cleanup:
                next_cleanup = now + 60
                try:
                    enough_space = purge_old()
                    if not enough_space and not disk_full_warned:
                        notify("RBM storage critically low",
                               "Storage below free-space threshold and no eligible old recordings remain.",
                               "urgent")
                        disk_full_warned = True
                    if enough_space and disk_full_warned:
                        log.info("STORAGE_RECOVERED time=%s", utc_now())
                        disk_full_warned = False
                except OSError as exc:
                    log.error("RETENTION_ERROR %s", exc)
            elif not mounted:
                next_cleanup = 0

            if proc is not None:
                reason = None
                if proc.poll() is not None:
                    reason = f"FFmpeg exited code={proc.returncode}"
                elif not card:
                    reason = "USB ALSA sound card disappeared"
                elif not mounted:
                    reason = "RAID recording filesystem is not mounted"
                else:
                    try:
                        new_signature = newest_file_signature()
                        if new_signature is not None and new_signature != signature:
                            signature = new_signature
                            last_progress = now
                            if not had_audio:
                                if down_since is not None:
                                    delta = int(now - down_since)
                                    if ever_healthy:
                                        log.info("RECORDING_GAP_END time=%s approx_duration=%ds", utc_now(), delta)
                                        if down_notified:
                                            notify("RBM recording restored",
                                                   f"Recording files are growing again after about {delta} seconds.",
                                                   "default")
                                    else:
                                        log.info("RECORDER_HEALTHY time=%s", utc_now())
                                down_since = None
                                down_notified = False
                                had_audio = True
                                ever_healthy = True
                        if now - last_progress > STALL_SECONDS:
                            reason = f"Recording file has not grown for {int(now - last_progress)}s"
                    except OSError as exc:
                        reason = f"Unable to inspect recording files: {exc}"
                if reason:
                    stall_notified = False
                    log.error("RECORDER_FAULT %s", reason)
                    if reason.startswith("Recording file has not grown") and now - last_stall_alert > 3600:
                        notify("RBM recorder stalled",
                               reason + ". Restarting FFmpeg; recording may contain a gap.",
                               "urgent")
                        last_stall_alert = now
                        stall_notified = True
                    stop_ffmpeg(proc, reason)
                    proc = None
                    signature = None
                    silence_active = False
                    mark_down(reason)
                    if stall_notified:
                        down_notified = True  # Alert was already sent for this outage.
                    next_start = now + 10
                    last_progress = now

            if proc is None and mounted and card and now >= next_start:
                try:
                    signature = newest_file_signature()
                    last_progress = now
                    proc = start_ffmpeg(messages)
                    segments_opened = 0
                    next_start = now + 15
                except (OSError, ValueError) as exc:
                    log.error("RECORDER_START_FAILED %s", exc)
                    mark_down(f"Cannot start FFmpeg: {exc}")
                    next_start = now + 15

            if proc is None:
                if not mounted:
                    down_message = f"Expected RAID {expected_device()} missing or not mounted at {MOUNT}"
                elif not card:
                    down_message = f"USB sound card {CARD_ID} not present"
                if down_since is None:
                    down_since = now
                if now - down_since >= ALERT_AFTER_SECONDS and not down_notified:
                    notify("RBM recording unavailable",
                           f"{down_message}. No automatic reboot. Check journalctl -u rbm-logger.",
                           "urgent")
                    down_notified = True

            # FFmpeg emits silencedetect events on stderr. This filter does not
            # remove, change, or interrupt the actual recording stream.
            while True:
                try:
                    pid, line = messages.get_nowait()
                except queue.Empty:
                    break
                if proc is None or pid != proc.pid:
                    continue  # Ignore stale messages from previous FFmpeg process.
                if "silence_start:" in line and not silence_active:
                    silence_active = True
                    log.warning("FM_SILENCE_BEGIN time=%s details=%s", utc_now(), line)
                    notify(f"RBM received audio silent for {SILENCE_SECONDS // 60} minutes",
                           f"FM receiver audio has remained below {SILENCE_DB} dB for "
                           f"{SILENCE_SECONDS} seconds. Recording continues. Receiver/RF may also be at fault.",
                           "high")
                elif "silence_end:" in line and silence_active:
                    silence_active = False
                    log.info("FM_SILENCE_END time=%s details=%s", utc_now(), line)
                    notify("RBM received audio returned", line, "default")
                elif "No space left on device" in line:
                    log.error("FFMPEG_DISK_FULL %s", line)
                elif "Opening '" in line and ".mp3'" in line:
                    log.info("SEGMENT_OPENED %s", line)
                    opened = OPENING.search(line)
                    # The first file of a run starts whenever recording started; only the
                    # hourly splits after it belong exactly on the hour.
                    if opened and segments_opened:
                        snap_to_hour(opened.group(1))
                    segments_opened += 1
                elif any(word in line.lower() for word in ("error", "xrun", "overrun", "failed")):
                    log.warning("FFMPEG %s", line)

            if had_audio and now >= next_heartbeat:
                next_heartbeat = now + 60
                # Only ping on confirmed output progress. Do not send an 'I'm fine'
                # heartbeat from an idle, stopped, or failing recorder.
                if now - last_progress < 45 and mounted:
                    heartbeat()

            time.sleep(2)
    finally:
        stop_ffmpeg(proc, "service shutdown")
        log.info("LOGGER_STOP time=%s", utc_now())


if __name__ == "__main__":
    main()
