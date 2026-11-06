#!/usr/bin/env python3
"""Health check for the RBM download page, run every 5 minutes by rbm-web-check.timer.

Independent of the web service, so it can report when that service is down. Checks:
- the web service answers on its local port;
- Caddy serves a valid certificate for each public name, not expiring within 14 days;
- optionally, the public address answers from outside (WEB_CHECK_PUBLIC_URL).

Alerts go to the recorder's ntfy topic when a check has failed CHECK_FAILURES_BEFORE_ALERT
times in a row, and again when it recovers. Python standard library only.
"""

import datetime as dt
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import urllib.error
import urllib.request

LOCAL_URL = "http://" + os.environ.get("WEB_LISTEN", "127.0.0.1:8080") + "/"
HOSTS = os.environ.get("WEB_PUBLIC_HOSTS", "rbm.kaos.zone").split()
PUBLIC_URL = os.environ.get("WEB_CHECK_PUBLIC_URL", "")
NTFY_URL = os.environ.get("NTFY_URL", "")
NTFY_TOKEN = os.environ.get("NTFY_TOKEN", "")
STATE = Path(os.environ.get("STATE_DIRECTORY", "/var/lib/rbm-web-check")) / "state.json"
CERT_WARN_DAYS = 14
CHECK_FAILURES_BEFORE_ALERT = 2  # 2 x 5 min, so a restart or a blip doesn't page anyone.


def check_local():
    with urllib.request.urlopen(LOCAL_URL, timeout=10) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")


def check_cert(host):
    context = ssl.create_default_context()
    with socket.create_connection(("127.0.0.1", 443), timeout=10) as raw:
        with context.wrap_socket(raw, server_hostname=host) as tls:
            not_after = tls.getpeercert()["notAfter"]
    expires = dt.datetime.fromtimestamp(ssl.cert_time_to_seconds(not_after), dt.timezone.utc)
    days = (expires - dt.datetime.now(dt.timezone.utc)).days
    if days < CERT_WARN_DAYS:
        raise RuntimeError(f"certificate expires in {days} days; Caddy should have renewed it "
                           "(check the Cloudflare API token)")


def check_public():
    # Identify as a normal client: Cloudflare's bot protection blocks Python's default
    # user agent, which would be a false alarm rather than a real outage.
    request = urllib.request.Request(PUBLIC_URL, headers={"User-Agent": "Mozilla/5.0 (RBM health check)"})
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")


def check_tunnel():
    """The Cloudflare Tunnel service, if this logger uses one, and its local entrance."""
    active = subprocess.run(["systemctl", "is-active", "--quiet", "rbm-tunnel"]).returncode == 0
    if not active:
        raise RuntimeError("the rbm-tunnel service (cloudflared) isn't running")
    with urllib.request.urlopen("http://127.0.0.1:8081/", timeout=10) as response:
        if response.status != 200:
            raise RuntimeError(f"Caddy's tunnel entrance answered HTTP {response.status}")


CHECKS = {"web service": check_local}
if Path("/etc/systemd/system/rbm-tunnel.service").exists():
    CHECKS["Cloudflare tunnel"] = check_tunnel
CHECKS.update({f"HTTPS certificate for {host}": (lambda h=host: check_cert(h)) for host in HOSTS})
if PUBLIC_URL:
    # Named without the URL, so changing the address keeps this check's history.
    CHECKS["public address"] = check_public


def notify(title, message, priority):
    print(f"ALERT: {title}: {message}")
    if not NTFY_URL:
        return
    headers = {"Title": title, "Priority": priority, "Tags": "radio,globe_with_meridians"}
    if NTFY_TOKEN:
        headers["Authorization"] = "Bearer " + NTFY_TOKEN
    request = urllib.request.Request(NTFY_URL, data=message.encode(), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=10) as response:
        response.read(64)


def main():
    try:
        state = json.loads(STATE.read_text())
    except (OSError, ValueError):
        state = {}
    # A check that no longer exists (renamed, or its setting removed) can't recover by
    # itself; close its alert instead of leaving it open forever.
    for name in [n for n in state if n not in CHECKS]:
        if state.pop(name).get("alerted"):
            notify(f"RBM download page: {name}", "No longer checked (the setting changed), so this "
                   "earlier alert is closed. Current checks follow their own alerts.", "default")
    for name, check in CHECKS.items():
        entry = state.setdefault(name, {"failures": 0, "alerted": False})
        try:
            check()
        except Exception as exc:
            entry["failures"] += 1
            entry["error"] = f"{type(exc).__name__}: {exc}"
            print(f"FAIL {name}: {entry['error']}")
            if entry["failures"] >= CHECK_FAILURES_BEFORE_ALERT and not entry["alerted"]:
                where = f" ({PUBLIC_URL})" if name == "public address" else ""
                notify(f"RBM download page problem: {name}",
                       f"{entry['error']}{where}. Presenters may not be able to listen or download. "
                       "Check: systemctl status rbm-web caddy", "high")
                entry["alerted"] = True
            continue
        if entry["alerted"]:
            notify(f"RBM download page recovered: {name}", "Working again.", "default")
        print(f"OK {name}")
        state[name] = {"failures": 0, "alerted": False}
    STATE.write_text(json.dumps(state, indent=1) + "\n")


if __name__ == "__main__":
    main()
