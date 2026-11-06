#!/usr/bin/env python3
"""Check BUTT timing: where real moments fall in a BUTT file, found by matching its loudness envelope
against the FM off-air recording. Usage: butt_align.py BUTT_FILE NEXT_START HH:MM ..."""
import datetime as dt, subprocess, sys, array, re
from pathlib import Path
from zoneinfo import ZoneInfo
TZ = ZoneInfo("Australia/Sydney"); FM = Path("/mnt/storage/recordings"); W = 0.05
def env(path, ss, t):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{ss:.2f}", "-t", f"{t:.2f}", "-i", str(path),
                          "-ac", "1", "-ar", "2000", "-f", "f32le", "-"], stdout=subprocess.PIPE).stdout
    a = array.array("f"); a.frombytes(raw[:len(raw) // 4 * 4]); n = int(W * 2000)
    return [sum(abs(v) for v in a[i:i + n]) / n for i in range(0, len(a) - n, n)]
def corr(x, y):
    n = len(x); mx = sum(x) / n; my = sum(y) / n
    num = sum((a - mx) * (b - my) for a, b in zip(x, y))
    den = (sum((a - mx) ** 2 for a in x) * sum((b - my) ** 2 for b in y)) ** .5
    return num / den if den else 0
def dur(p):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                                stdout=subprocess.PIPE, text=True).stdout)
butt = Path(sys.argv[1]); start = dt.datetime.strptime(re.search(r"(\d{8}-\d{6})", butt.name).group(1), "%Y%m%d-%H%M%S").replace(tzinfo=TZ)
end = dt.datetime.strptime(sys.argv[2], "%Y%m%d-%H%M%S").replace(tzinfo=TZ)
audio = dur(butt); scale = audio / (end - start).total_seconds()
print(f"{butt.name}: audio {audio:.1f}s, clock {(end - start).total_seconds():.1f}s, drift {audio - (end - start).total_seconds():+.1f}s")
fm = sorted((dt.datetime.strptime(m.group(1), "%Y%m%dT%H%M%S%z"), p) for p in FM.iterdir() if (m := re.fullmatch(r"RBMFM_(\S+)\.mp3", p.name)))
for hm in sys.argv[3:]:
    day, hh = hm.split("T"); T = dt.datetime.strptime(day + hh, "%Y%m%d%H:%M").replace(tzinfo=TZ)
    f0, fp = [x for x in fm if x[0] <= T][-1]
    ref = env(fp, (T - f0).total_seconds(), 30)
    pred = (T - start).total_seconds() * scale
    S = 60; probe = env(butt, pred - S, 30 + 2 * S)
    best = max(range(0, len(probe) - len(ref)), key=lambda k: corr(ref, probe[k:k + len(ref)]))
    c = corr(ref, probe[best:best + len(ref)]); err = best * W - S
    # err: BUTT audio for moment T is `err` s after the linear prediction (minus the FM link delay)
    print(f"  {T:%a %H:%M}  predicted {pred:8.1f}s  measured {pred + err:8.1f}s  error {err:+6.2f}s  corr {c:.2f}")
