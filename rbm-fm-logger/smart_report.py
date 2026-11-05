#!/usr/bin/env python3
"""Disk health snapshot for the weekly summary. Runs as root (smartctl needs it) just
before rbm_weekly.py, and writes /var/lib/rbm-logger/smart.txt for it to read.

One line per disk; lines starting "PROBLEM" make the weekly summary say "needs attention".
"""

import json
from pathlib import Path
import subprocess

OUT = Path("/var/lib/rbm-logger/smart.txt")
# ATA attributes that mean the disk is losing sectors (any non-zero raw value matters).
BAD_SECTOR_ATTRIBUTES = {5: "reallocated", 197: "pending", 198: "uncorrectable"}
HOT_CELSIUS = 50


def disks():
    out = subprocess.run(["lsblk", "-dn", "-o", "NAME,TYPE"], text=True, stdout=subprocess.PIPE).stdout
    return [f"/dev/{name}" for name, kind in (line.split() for line in out.splitlines()) if kind == "disk"]


def report(device):
    result = subprocess.run(["smartctl", "-H", "-A", "-i", "-j", device], text=True, stdout=subprocess.PIPE)
    try:
        data = json.loads(result.stdout)
    except ValueError:
        return f"PROBLEM {device}: smartctl gave no readable output"
    model = data.get("model_name", "unknown model")
    if not data.get("smart_support", {}).get("enabled", True):
        return f"{device} {model}: SMART not available"
    problems, facts = [], []
    passed = data.get("smart_status", {}).get("passed")
    if passed is False:
        problems.append("SMART health FAILED")
    hours = data.get("power_on_time", {}).get("hours")
    if hours is not None:
        facts.append(f"{hours / 8766:.1f} years powered on")
    temp = data.get("temperature", {}).get("current")
    if temp is not None:
        facts.append(f"{temp}°C")
        if temp >= HOT_CELSIUS:
            problems.append(f"running hot ({temp}°C)")
    for attr in data.get("ata_smart_attributes", {}).get("table", []):
        name = BAD_SECTOR_ATTRIBUTES.get(attr.get("id"))
        raw = attr.get("raw", {}).get("value", 0)
        if name and raw:
            problems.append(f"{raw} {name} sectors")
    nvme = data.get("nvme_smart_health_information_log")
    if nvme:
        if nvme.get("media_errors"):
            problems.append(f"{nvme['media_errors']} media errors")
        if nvme.get("percentage_used", 0) >= 90:
            problems.append(f"{nvme['percentage_used']}% of rated life used")
    summary = f"{device} {model}: " + ", ".join(facts or ["no details"])
    return ("PROBLEM " + summary + " — " + "; ".join(problems)) if problems else summary + ", healthy"


def main():
    lines = [report(device) for device in disks()]
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
