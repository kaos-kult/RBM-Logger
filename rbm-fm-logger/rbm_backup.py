#!/usr/bin/env python3
"""Optional independent rclone offsite copy, triggered by systemd timer."""
import json
import logging
from logging.handlers import WatchedFileHandler
import os
from pathlib import Path
import subprocess
import urllib.request

MOUNT = Path(os.environ.get("RAID_MOUNT", "/mnt/storage"))
SOURCE = MOUNT / "recordings"
DEST = os.environ.get("BACKUP_DEST", "")
NTFY_URL = os.environ.get("NTFY_URL", "")
NTFY_TOKEN = os.environ.get("NTFY_TOKEN", "")
STATE = Path("/var/lib/rbm-logger/backup-state.json")
LOG = Path("/var/lib/rbm-logger/events.log")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rbm-backup")
LOG.parent.mkdir(parents=True, exist_ok=True)
handler = WatchedFileHandler(LOG, encoding="utf-8")
handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
log.addHandler(handler)


def alert(title, message):
    log.warning("BACKUP_ALERT: %s: %s", title, message)
    if not NTFY_URL:
        return
    headers = {"Title": title, "Priority": "high", "Tags": "radio,warning"}
    if NTFY_TOKEN:
        headers["Authorization"] = "Bearer " + NTFY_TOKEN
    try:
        req = urllib.request.Request(NTFY_URL, data=message.encode(), headers=headers,
                                     method="POST")
        with urllib.request.urlopen(req, timeout=5) as response:
            response.read(64)
    except Exception as exc:
        log.error("BACKUP_NOTIFICATION_FAILED %s", exc)


def main():
    if not DEST:
        log.error("BACKUP_NOT_CONFIGURED: set BACKUP_DEST in /etc/rbm-logger.conf")
        return 2
    previous_failures = 0
    try:
        previous_failures = json.loads(STATE.read_text()).get("failures", 0)
    except (OSError, ValueError):
        pass

    cmd = [
        "rclone", "copy", str(SOURCE), DEST,
        "--min-age", "2h", "--filter", "+ RBMFM_*.mp3", "--filter", "- **",
        "--transfers", "2", "--checkers", "4", "--retries", "3",
        "--low-level-retries", "2", "--log-level", "ERROR",
    ]
    try:
        if not MOUNT.is_mount() or not SOURCE.is_dir():
            raise RuntimeError("Recording RAID filesystem is not mounted")
        log.info("BACKUP_START destination=%s", DEST)
        result = subprocess.run(cmd, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, check=False)
        if result.returncode:
            raise RuntimeError(f"rclone exit={result.returncode}: {result.stderr[-2000:]}")
        STATE.write_text(json.dumps({"failures": 0}) + "\n")
        log.info("BACKUP_SUCCESS destination=%s", DEST)
        if previous_failures >= 3:
            alert("RBM backup recovered", "The offsite backup is working again.")
        return 0
    except (OSError, RuntimeError) as exc:
        failures = previous_failures + 1
        STATE.write_text(json.dumps({"failures": failures}) + "\n")
        log.error("BACKUP_FAILURE consecutive=%d error=%s", failures, exc)
        if failures == 3 or failures % 6 == 0:
            alert("RBM offsite backup failing", f"{failures} consecutive failed backup attempts. {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
