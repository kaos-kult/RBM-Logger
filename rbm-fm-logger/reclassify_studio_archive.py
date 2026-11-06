#!/usr/bin/env python3
"""Move the archive recordings that were never off-air into the studio copy (one-off,
7 Nov 2026).

Everything in /mnt/storage/recordings before this logger's own FM recording began
(5 Nov 2026 21:35:46) came from studio-side recorders: the old logger on STUDIOB, then
BUTT on the streamer. It was filed as RBMFM_ ("off-air") when imported, which is
misleading. This renames each to RBMSTUDIO_ and moves it to /mnt/storage/studio. Where
the studio folder already has the same hour (the 4-6 Nov BUTT import), the RBMFM_ copy
is the same audio and goes to /mnt/storage/replaced/butt-duplicates instead. The logger's own first
off-air files (5 Nov 20:27-21:35, set aside in /mnt/storage/replaced when the streamer
copies replaced them) move back into recordings.

Usage: sudo reclassify_studio_archive.py [--apply]   (dry run by default)
Every move is logged to /var/lib/rbm-logger/reclassify-20261107.tsv (from, to), so it
can be undone. Same filesystem, so moves are instant renames; nothing is deleted.
"""
import datetime as dt
import os
from pathlib import Path
import re
import sys

MOUNT = Path("/mnt/storage")
FM, STUDIO, REPLACED = MOUNT / "recordings", MOUNT / "studio", MOUNT / "replaced"
DUPES = REPLACED / "butt-duplicates"
LOG = Path("/var/lib/rbm-logger/reclassify-20261107.tsv")
FIRST_OFFAIR = dt.datetime(2026, 11, 5, 21, 35, 46, tzinfo=dt.timezone(dt.timedelta(hours=11)))
LOGGER_START = dt.datetime(2026, 11, 5, 20, 27, 35, tzinfo=dt.timezone(dt.timedelta(hours=11)))
NAME = re.compile(r"^RBMFM_(\d{8}T\d{6}[+-]\d{4})\.mp3$")


def start(name):
    return dt.datetime.strptime(NAME.fullmatch(name).group(1), "%Y%m%dT%H%M%S%z")


def main():
    apply = "--apply" in sys.argv[1:]
    moves = []
    for name in sorted(os.listdir(FM)):
        if NAME.fullmatch(name) and start(name) < FIRST_OFFAIR:
            target = STUDIO / ("RBMSTUDIO_" + name.removeprefix("RBMFM_"))
            if target.exists() or any(t == target for _, t in moves):
                moves.append((FM / name, DUPES / name))  # Already in the studio copy.
            else:
                moves.append((FM / name, target))
    for name in sorted(os.listdir(REPLACED)):
        leaving = {f for f, _ in moves}
        if (NAME.fullmatch(name) and LOGGER_START <= start(name) < FIRST_OFFAIR
                and (not (FM / name).exists() or FM / name in leaving)):
            moves.append((REPLACED / name, FM / name))  # The logger's own off-air recording.
    to_studio = sum(1 for _, t in moves if t.parent == STUDIO)
    dupes = sum(1 for f, t in moves if t.parent == DUPES)
    back = sum(1 for f, t in moves if f.parent == REPLACED)
    print(f"{to_studio} files to the studio copy, {dupes} duplicates of the BUTT import to replaced/butt-duplicates/, "
          f"{back} off-air files back from replaced/")
    for f, t in moves[:3] + moves[-6:]:
        print(f"  {f.parent.name}/{f.name} -> {t.parent.name}/{t.name}")
    leaving = {f for f, _ in moves}
    clash = [t for f, t in moves if t.exists() and t not in leaving]
    if clash:
        raise SystemExit(f"Refusing: {len(clash)} targets already exist, e.g. {clash[0]}")
    if not apply:
        print("Dry run only; pass --apply to move.")
        return
    DUPES.mkdir(exist_ok=True)
    os.chown(DUPES, REPLACED.stat().st_uid, REPLACED.stat().st_gid)
    DUPES.chmod(0o750)
    with LOG.open("a") as log:
        for f, t in moves:
            os.rename(f, t)
            log.write(f"{f}\t{t}\n")
    print(f"Done. Logged to {LOG}.")


if __name__ == "__main__":
    main()
