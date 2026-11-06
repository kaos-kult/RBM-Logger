#!/usr/bin/env python3
"""Weekly RBM logger summary to ntfy, run by rbm-weekly.timer (Monday 09:00).

A regular "all good" message, so that silence from the alerting itself gets noticed: if
this stops arriving, something is wrong with the logger, its internet, or ntfy.
Reports the past 7 days: recorded hours and gaps, faults and silences, RAID, free space
and how far back the archive goes, the download page's health and certificate.
Python standard library only.
"""

import datetime as dt
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import urllib.request

MOUNT = Path(os.environ.get("RAID_MOUNT", "/mnt/storage"))
RECORDINGS = MOUNT / "recordings"
EVENTS = Path("/var/lib/rbm-logger/events.log")
WEB_CHECK_STATE = Path("/var/lib/rbm-web-check/state.json")
SMART_REPORT = Path("/var/lib/rbm-logger/smart.txt")  # Written by smart_report.py just before.
CONFIG_BACKUP_STATUS = Path("/var/lib/rbm-logger/config-backup.status")  # From rbm_config_backup.sh.
WEB_HOSTS = os.environ.get("WEB_PUBLIC_HOSTS", "rbm.kaos.zone").split()
NTFY_URL = os.environ.get("NTFY_URL", "")
NTFY_TOKEN = os.environ.get("NTFY_TOKEN", "")
FILE_NAME = re.compile(r"^RBMFM_(\d{8}T\d{6}[+-]\d{4})\.mp3$")
STUDIO = MOUNT / "studio"
STUDIO_NAME = re.compile(r"^RBMSTUDIO_(\d{8}T\d{6}[+-]\d{4})\.mp3$")
BYTES_PER_SECOND = 192000 / 8
REQUIRED_DAYS = int(os.environ.get("REQUIRED_RETENTION_DAYS", "42"))
# This logger's own off-air recording began then; everything older is the studio copy
# (moved there on 7 Nov 2026). Coverage and archive length count from this moment.
OFFAIR_SINCE = dt.datetime(2026, 11, 5, 20, 27, 35, tzinfo=dt.timezone(dt.timedelta(hours=11)))
GAP_REPORT_SECONDS = 120


def recordings(folder=RECORDINGS, pattern=FILE_NAME):
    found = []
    for entry in os.scandir(folder):
        match = pattern.fullmatch(entry.name)
        if match and entry.is_file(follow_symlinks=False):
            start = dt.datetime.strptime(match.group(1), "%Y%m%dT%H%M%S%z")
            found.append((start, start + dt.timedelta(seconds=entry.stat().st_size / BYTES_PER_SECOND)))
    return sorted(found)


def coverage(recs, since, until):
    """(recorded seconds, [(gap_start, gap_end)]) between since and until."""
    covered, gaps, cursor = 0.0, [], since
    for start, end in recs:
        if end <= cursor or start >= until:
            continue
        if start > cursor and (start - cursor).total_seconds() >= GAP_REPORT_SECONDS:
            gaps.append((cursor, start))
        a, b = max(start, cursor), min(end, until)
        if b > a:
            covered += (b - a).total_seconds()
            cursor = b
    if (until - cursor).total_seconds() >= GAP_REPORT_SECONDS:
        gaps.append((cursor, until))
    return covered, gaps


def event_counts(since):
    counts = {"RECORDER_FAULT": 0, "FM_SILENCE_BEGIN": 0, "RETENTION removed": 0, "RAID": 0}
    try:
        for line in EVENTS.read_text(errors="replace").splitlines():
            try:
                when = dt.datetime.strptime(line[:19], "%Y-%m-%d %H:%M:%S").astimezone()
            except ValueError:
                continue
            if when < since:
                continue
            for key in ("RECORDER_FAULT", "FM_SILENCE_BEGIN", "RETENTION removed"):
                if key in line:
                    counts[key] += 1
            if "ALERT: RBM RAID" in line:
                counts["RAID"] += 1
    except OSError:
        pass
    return counts


def raid_line():
    try:
        mdstat = Path("/proc/mdstat").read_text()
    except OSError:
        return "RAID: unknown"
    arrays = re.findall(r"^(md\d+) : (\w+) (\w+).*\n.*\[([U_]+)\]", mdstat, re.M)
    if not arrays:
        return "RAID: no arrays found"
    return "RAID: " + ", ".join(f"{name} {state} [{disks}]" + ("" if "_" not in disks else " DEGRADED")
                                for name, state, _, disks in arrays)


def cert_days(host):
    context = ssl.create_default_context()
    with socket.create_connection(("127.0.0.1", 443), timeout=10) as raw:
        with context.wrap_socket(raw, server_hostname=host) as tls:
            not_after = tls.getpeercert()["notAfter"]
    return int((ssl.cert_time_to_seconds(not_after) - dt.datetime.now().timestamp()) // 86400)


def service_active(name):
    return subprocess.run(["systemctl", "is-active", "--quiet", name]).returncode == 0


def main():
    now = dt.datetime.now().astimezone()
    since = now - dt.timedelta(days=7)
    problems, lines = [], []

    recorder = service_active("rbm-logger")
    lines.append(f"Recorder: {'running' if recorder else 'NOT RUNNING'}")
    if not recorder:
        problems.append("recorder not running")

    try:
        recs = recordings()
        window = max(since, OFFAIR_SINCE)
        covered, gaps = coverage(recs, window, now)
        hours = (now - window).total_seconds() / 3600
        pct = covered / (now - window).total_seconds() * 100
        lines.append(f"Recorded off-air: {covered / 3600:.1f} of {hours:.0f} h ({pct:.1f}%)")
        if gaps:
            lines.append(f"Gaps over {GAP_REPORT_SECONDS // 60} min: {len(gaps)}")
            for a, b in sorted(gaps, key=lambda g: g[0] - g[1])[:3]:
                lines.append(f"  {a:%a %d %b %H:%M} for {(b - a).total_seconds() / 60:.0f} min")
        if pct < 99:
            problems.append(f"only {pct:.0f}% recorded")
        if recs:
            oldest_days = (now - recs[0][0]).days
            lines.append(f"Off-air archive: {recs[0][0]:%d %b %Y} to now ({oldest_days} days, "
                         f"{len(recs)} files)")
            # Only a problem once the logger has been recording long enough to have it.
            if oldest_days < REQUIRED_DAYS and (now - OFFAIR_SINCE).days >= REQUIRED_DAYS:
                problems.append(f"off-air archive covers only {oldest_days} days")
    except OSError as exc:
        lines.append(f"Recordings: UNREADABLE ({exc})")
        problems.append("recordings unreadable")

    counts = event_counts(since)
    lines.append(f"Recorder restarts: {counts['RECORDER_FAULT']}, silences: {counts['FM_SILENCE_BEGIN']}, "
                 f"old-file cleanups: {counts['RETENTION removed']}")

    raid = raid_line()
    lines.append(raid)
    if "DEGRADED" in raid or "unknown" in raid or "no arrays" in raid:
        problems.append("RAID needs attention")

    try:
        for line in SMART_REPORT.read_text().splitlines():
            lines.append("Disk: " + line.removeprefix("PROBLEM "))
            if line.startswith("PROBLEM"):
                problems.append("disk health warning")
    except OSError:
        lines.append("Disk health: no report")
        problems.append("disk health unknown")

    # Studio (Dante) copy: only reported once it exists.
    studio_on = service_active("rbm-studio")
    if studio_on or STUDIO.is_dir():
        lines.append(f"Studio recorder: {'running' if studio_on else 'NOT RUNNING'}")
        if not studio_on:
            problems.append("studio recorder not running")
        try:
            srecs = recordings(STUDIO, STUDIO_NAME)
            scovered, _ = coverage(srecs, max(since, srecs[0][0]) if srecs else since, now)
            span = (now - max(since, srecs[0][0])).total_seconds() if srecs else 0
            spct = scovered / span * 100 if span else 0
            lines.append(f"Studio copy: {scovered / 3600:.1f} h this week ({spct:.1f}% since it started)")
            if srecs:
                lines.append(f"Studio archive: {srecs[0][0]:%d %b %Y} to now ({len(srecs)} files)")
            if studio_on and spct < 95:
                problems.append(f"studio copy only {spct:.0f}%")
        except OSError as exc:
            lines.append(f"Studio copy: can't read {STUDIO} ({exc})")

    usage = shutil.disk_usage(MOUNT)
    # About 2 GB per day per source at 192 kbps; 30 GiB is kept free.
    per_day = 2.07 * (2 if studio_on else 1)
    days_left = max(0, usage.free / 1024 ** 3 - 30) / per_day
    lines.append(f"Free space: {usage.free / 1024 ** 3:.0f} GiB (about {days_left:.0f} days before old "
                 "recordings start being deleted)")

    web = service_active("rbm-web")
    lines.append(f"Download page: {'running' if web else 'NOT RUNNING'}")
    if not web:
        problems.append("download page not running")
    try:
        failing = [name for name, s in json.loads(WEB_CHECK_STATE.read_text()).items() if s.get("failures")]
        if failing:
            lines.append("Page checks failing: " + ", ".join(failing))
            problems.append("download page checks failing")
    except (OSError, ValueError):
        pass
    for host in WEB_HOSTS:
        try:
            days = cert_days(host)
            lines.append(f"Certificate {host}: {days} days left")
            if days < 14:
                problems.append(f"certificate for {host} expiring")
        except Exception as exc:
            lines.append(f"Certificate {host}: CHECK FAILED ({exc})")
            problems.append(f"certificate check failed for {host}")

    if Path("/run/reboot-required").exists():
        lines.append("Security updates installed that need a reboot: restart the logger at a quiet time "
                     "(a gap of about a minute)")
        problems.append("reboot needed for updates")
    try:
        status = CONFIG_BACKUP_STATUS.read_text().strip()
        age_days = (now.timestamp() - CONFIG_BACKUP_STATUS.stat().st_mtime) / 86400
        if status.startswith("OK"):
            lines.append(f"Settings backup: {age_days:.0f} days old ({status.split()[2]})")
            if age_days > 2:
                problems.append("settings backup is stale")
        else:
            lines.append(f"Settings backup: {status}")
            problems.append("settings backup failing")
    except OSError:
        lines.append("Settings backup: never run")
        problems.append("settings backup missing")
    lines.append("Off-site backup: not set up")
    title = "RBM weekly: all good" if not problems else "RBM weekly: needs attention (" + "; ".join(problems) + ")"
    message = "\n".join(lines)
    print(title)
    print(message)
    if NTFY_URL:
        headers = {"Title": title, "Priority": "low" if not problems else "high",
                   "Tags": "radio," + ("white_check_mark" if not problems else "warning")}
        if NTFY_TOKEN:
            headers["Authorization"] = "Bearer " + NTFY_TOKEN
        request = urllib.request.Request(NTFY_URL, data=message.encode(), headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=15) as response:
            response.read(64)


if __name__ == "__main__":
    main()
