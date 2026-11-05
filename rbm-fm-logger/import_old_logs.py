#!/usr/bin/env python3
"""Rename the old logger's recordings (2RBM_HH-MM-SS_DD-MM-YYYY[-N].mp3, station local
time, normally 30 minutes each) to RBMFM_ names, in place.

Usage: import_old_logs.py DIR [--apply]

- Normal files are renamed only; the audio is untouched.
- Files longer than an hour are split on the clock hour without re-encoding.
- "-N" duplicates are kept only if they contain audio; silent ones move to DIR/rejected/.
Dry run by default. Existing outputs are never overwritten.
"""
import datetime as dt
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Australia/Sydney")
OLD_NAME = re.compile(r"^2RBM_(\d\d)-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d{4})(-\d+)?\.mp3$")
SILENT_DB = -70.0  # Mean volume below this is treated as a dead input.


def probe_duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", str(path)], check=True, text=True,
                         stdout=subprocess.PIPE).stdout
    return float(out)


def mean_volume(path):
    result = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
                             "-af", "volumedetect", "-f", "null", "-"],
                            text=True, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL)
    match = re.search(r"mean_volume: (-?[\d.]+|-inf) dB", result.stderr)
    return float(match.group(1)) if match and match.group(1) != "-inf" else float("-inf")


def name_for(moment):
    return moment.strftime("RBMFM_%Y%m%dT%H%M%S%z.mp3")


def hour_pieces(start, seconds):
    pieces = [(0.0, start)]
    boundary = start.astimezone(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    end = start + dt.timedelta(seconds=seconds)
    while True:
        boundary += dt.timedelta(hours=1)
        if boundary >= end:
            return pieces
        pieces.append(((boundary - start).total_seconds(), boundary.astimezone(TZ)))


def split(path, out_dir, pieces):
    with tempfile.TemporaryDirectory(dir=out_dir) as tmp:
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path),
                        "-map", "0:a", "-c", "copy", "-f", "segment", "-reset_timestamps", "1",
                        "-segment_format", "mp3", "-segment_times",
                        ",".join(f"{offset:.3f}" for offset, _ in pieces[1:]),
                        str(Path(tmp) / "%04d.mp3")], check=True)
        parts = sorted(Path(tmp).glob("*.mp3"))
        if len(parts) != len(pieces):
            raise SystemExit(f"{path.name}: expected {len(pieces)} pieces, ffmpeg wrote {len(parts)}")
        for part, (_, moment) in zip(parts, pieces):
            part.rename(out_dir / name_for(moment))


def main():
    args = [a for a in sys.argv[1:] if a != "--apply"]
    apply = "--apply" in sys.argv
    if len(args) != 1:
        raise SystemExit(__doc__)
    folder = Path(args[0])
    rejected = folder / "rejected"
    counts = {"rename": 0, "split": 0, "reject": 0, "skip": 0}
    by_start = {}
    for path in sorted(folder.glob("2RBM_*.mp3")):
        match = OLD_NAME.fullmatch(path.name)
        if not match:
            print(f"ODD NAME, left alone: {path.name}")
            counts["skip"] += 1
            continue
        hh, mm, ss, day, month, year, _ = match.groups()
        start = dt.datetime(int(year), int(month), int(day), int(hh), int(mm), int(ss), tzinfo=TZ)
        by_start.setdefault(start, []).append(path)

    for start, paths in sorted(by_start.items()):
        if len(paths) > 1:
            # A second, silent BUTT instance sometimes ran alongside the real one, and either
            # copy (with or without "-N") can be the silent one. Keep the copy with audio.
            volumes = {p: mean_volume(p) for p in paths}
            keep = max(paths, key=volumes.get)
            for p in paths:
                if p == keep:
                    continue
                if volumes[p] >= SILENT_DB:
                    print(f"CHECK both copies have audio, keeping louder {keep.name} "
                          f"({volumes[keep]:.0f} dB) over {p.name} ({volumes[p]:.0f} dB)")
                else:
                    print(f"REJECT silent copy ({volumes[p]:.0f} dB): {p.name}, keeping {keep.name}")
                counts["reject"] += 1
                if apply:
                    rejected.mkdir(exist_ok=True)
                    p.rename(rejected / p.name)
            if volumes[keep] < SILENT_DB:
                print(f"CHECK every copy is silent at {start:%Y-%m-%d %H:%M}; keeping {keep.name}")
            paths = [keep]
        path = paths[0]
        seconds = probe_duration(path)
        pieces = hour_pieces(start, seconds) if seconds > 3660 else [(0.0, start)]
        names = [name_for(moment) for _, moment in pieces]
        clash = [n for n in names if (folder / n).exists()]
        if clash:
            print(f"SKIP {path.name}: {', '.join(clash)} already exists")
            counts["skip"] += 1
            continue
        if len(pieces) > 1:
            print(f"SPLIT {path.name} ({seconds / 3600:.1f} h) -> {names[0]} .. {names[-1]} ({len(names)} files)")
            counts["split"] += 1
            if apply:
                split(path, folder, pieces)
                path.unlink()
        else:
            counts["rename"] += 1
            if apply:
                path.rename(folder / names[0])
    print(", ".join(f"{k}: {v}" for k, v in counts.items()))
    if not apply:
        print("Dry run only; pass --apply to make changes.")


if __name__ == "__main__":
    main()
