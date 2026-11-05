#!/usr/bin/env python3
"""Save today's Radio Blue Mountains programme guide, run daily by rbm-guide-fetch.timer.

The station website (WordPress + MetaRadio) only publishes the current week's schedule,
so keeping a snapshot every day builds up a history of what was scheduled when. The
download page uses the snapshots to put show names on the timeline and on downloads.

Writes GUIDE_DIR/guide-YYYYMMDD.json: [{"name", "presenter", "url", "start", "end"}],
with start/end as station-local "YYYY-MM-DDTHH:MM". Python standard library only.
"""

import datetime as dt
import html
import json
import os
from pathlib import Path
import re
import sys
import urllib.request

GUIDE_URL = os.environ.get("GUIDE_URL", "https://www.rbm.org.au/wp-json/metaradio/v1/stationguide?station=1")
GUIDE_DIR = Path(os.environ.get("STATE_DIRECTORY", os.environ.get("GUIDE_DIR", "/var/lib/rbm-guide")))
NTFY_URL = os.environ.get("NTFY_URL", "")
NTFY_TOKEN = os.environ.get("NTFY_TOKEN", "")


def clean(text):
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    return re.sub(r"\s+", " ", text).strip()


def local(text):
    return dt.datetime.strptime(text, "%Y-%m-%d %H:%M:%S").strftime("%Y-%m-%dT%H:%M")


def fetch():
    request = urllib.request.Request(GUIDE_URL, headers={"User-Agent": "Mozilla/5.0 (RBM logger guide snapshot)"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.load(response)
    shows = []
    for entry in data.get("guide", []):
        presenter = clean(entry.get("presenter"))
        # Some shows have a blurb in the presenter field; it isn't a name, so drop it.
        if len(presenter) > 60:
            presenter = ""
        shows.append({"name": clean(entry["name"]), "presenter": presenter, "url": entry.get("url", ""),
                      "start": local(entry["startDateTime"]), "end": local(entry["endDateTime"])})
    if not shows:
        raise RuntimeError("the guide came back empty")
    return sorted(shows, key=lambda s: s["start"])


def alert(message):
    print(f"ALERT: {message}", file=sys.stderr)
    if not NTFY_URL:
        return
    headers = {"Title": "RBM programme guide snapshot failed", "Priority": "default", "Tags": "radio,calendar"}
    if NTFY_TOKEN:
        headers["Authorization"] = "Bearer " + NTFY_TOKEN
    try:
        request = urllib.request.Request(NTFY_URL, data=message.encode(), headers=headers, method="POST")
        urllib.request.urlopen(request, timeout=10).read(64)
    except Exception as exc:
        print(f"Alert delivery failed: {exc}", file=sys.stderr)


def main():
    try:
        shows = fetch()
    except Exception as exc:
        # Not urgent: one missed day just means that day's names come from a nearby snapshot.
        alert(f"Couldn't fetch {GUIDE_URL}: {exc}. Show names on the download page may be less exact "
              "until it works again.")
        return 1
    GUIDE_DIR.mkdir(parents=True, exist_ok=True)
    path = GUIDE_DIR / f"guide-{dt.date.today():%Y%m%d}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(shows, indent=1, ensure_ascii=False) + "\n")
    tmp.replace(path)
    print(f"Saved {len(shows)} shows to {path} ({shows[0]['start']} to {shows[-1]['end']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
