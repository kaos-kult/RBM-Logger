#!/usr/bin/env python3
"""Split long BUTT recordings (rec_YYYYMMDD-HHMMSS.mp3, station local time) into
clock-hour RBMFM_ files, without re-encoding.

Usage: split_butt_recordings.py OUT_DIR FILE... [--ends-at YYYYMMDD-HHMMSS] [--apply]
Dry run by default: prints the planned output files. Existing outputs are never overwritten.

The sound card's clock drifts from the PC clock, so a long file's audio can be a few
minutes shorter or longer than the wall-clock time it covered. When the real end time is
known (the next file's start, or --ends-at for the last file), cut points are spread
evenly over the drift so each cut lands on the real clock hour.
"""
import datetime as dt
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Australia/Sydney")
BUTT_NAME = re.compile(r"^rec_(\d{8}-\d{6})\.mp3$")


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", str(path)], check=True, text=True,
                         stdout=subprocess.PIPE).stdout
    return float(out)


def butt_start(name):
    match = BUTT_NAME.fullmatch(name)
    if not match:
        raise SystemExit(f"Not a BUTT recording name: {name}")
    return parse_local(match.group(1))


def parse_local(text):
    return dt.datetime.strptime(text, "%Y%m%d-%H%M%S").replace(tzinfo=TZ)


def plan(path, real_end=None):
    """Return (start, end, scale, [(audio_offset_seconds, start_time), ...])."""
    start = butt_start(path.name)
    audio = duration(path)
    end = real_end or start + dt.timedelta(seconds=audio)
    # Audio seconds per real second; 1.0 when the real end is unknown.
    scale = audio / (end - start).total_seconds()
    pieces = [(0.0, start)]
    # Walk real (UTC) hours so DST changes don't double or skip an hour.
    boundary = start.astimezone(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    while True:
        boundary += dt.timedelta(hours=1)
        if boundary >= end:
            break
        pieces.append(((boundary - start).total_seconds() * scale, boundary.astimezone(TZ)))
    return start, end, scale, pieces


def name_for(moment):
    return moment.strftime("RBMFM_%Y%m%dT%H%M%S%z.mp3")


def split(path, out_dir, pieces):
    with tempfile.TemporaryDirectory(dir=out_dir) as tmp:
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path),
               "-map", "0:a", "-c", "copy", "-f", "segment", "-reset_timestamps", "1",
               "-segment_format", "mp3"]
        if len(pieces) > 1:
            cmd += ["-segment_times", ",".join(f"{offset:.3f}" for offset, _ in pieces[1:])]
        else:
            cmd += ["-segment_time", "999999"]
        cmd.append(str(Path(tmp) / "%04d.mp3"))
        subprocess.run(cmd, check=True)
        parts = sorted(Path(tmp).glob("*.mp3"))
        if len(parts) != len(pieces):
            raise SystemExit(f"{path.name}: expected {len(pieces)} pieces, ffmpeg wrote {len(parts)}")
        for part, (_, moment) in zip(parts, pieces):
            part.rename(out_dir / name_for(moment))


def main():
    args = sys.argv[1:]
    apply = "--apply" in args
    args = [a for a in args if a != "--apply"]
    last_end = None
    if "--ends-at" in args:
        i = args.index("--ends-at")
        last_end = parse_local(args[i + 1])
        del args[i:i + 2]
    if len(args) < 2:
        raise SystemExit(__doc__)
    out_dir = Path(args[0])
    paths = sorted(map(Path, args[1:]), key=lambda p: butt_start(p.name))
    for i, path in enumerate(paths):
        real_end = butt_start(paths[i + 1].name) if i + 1 < len(paths) else last_end
        start, end, scale, pieces = plan(path, real_end)
        names = [name_for(moment) for _, moment in pieces]
        clashes = [n for n in names if (out_dir / n).exists()]
        drift = (scale - 1) * (end - start).total_seconds()
        print(f"{path.name}: {start:%Y-%m-%d %H:%M:%S} -> {end:%Y-%m-%d %H:%M:%S}, {len(pieces)} files, "
              f"audio vs clock {drift:+.0f}s")
        print(f"  first {names[0]}  last {names[-1]}")
        if clashes:
            print(f"  SKIP: already exists: {', '.join(clashes)}")
            continue
        if apply:
            split(path, out_dir, pieces)
            print("  done")
    if not apply:
        print("Dry run only; pass --apply to split.")


if __name__ == "__main__":
    main()
