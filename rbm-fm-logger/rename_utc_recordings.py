#!/usr/bin/env python3
"""One-off: rename old RBM_YYYY-MM-DDTHH-MM-SSZ.mp3 files to RBMFM_ local-time names.

Dry run by default; pass --apply to rename. Stop rbm-logger first so no file is open.
"""
import datetime as dt
from pathlib import Path
import re
import sys
from zoneinfo import ZoneInfo

RECORDINGS = Path("/mnt/storage/recordings")
OLD = re.compile(r"^RBM_(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ)\.mp3$")
TZ = ZoneInfo("Australia/Sydney")

apply = "--apply" in sys.argv
for path in sorted(RECORDINGS.iterdir()):
    match = OLD.fullmatch(path.name)
    if not match:
        continue
    start = dt.datetime.strptime(match.group(1), "%Y-%m-%dT%H-%M-%SZ").replace(tzinfo=dt.timezone.utc)
    target = path.with_name(start.astimezone(TZ).strftime("RBMFM_%Y%m%dT%H%M%S%z.mp3"))
    if target.exists():
        print(f"SKIP {path.name}: {target.name} already exists")
        continue
    print(f"{path.name} -> {target.name}")
    if apply:
        path.rename(target)
if not apply:
    print("Dry run only; pass --apply to rename.")
