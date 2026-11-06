#!/usr/bin/env bash
# Install or update the studio recorder: Studio-A Program-L/R recorded straight off Dante.
# Needs Inferno2pipe and Statime built first as the logger user (no sudo):
#   git clone --recursive -b dev https://github.com/teodly/inferno ~/src/inferno
#   git clone --recurse-submodules -b inferno-dev https://github.com/teodly/statime ~/src/statime
#   (cd ~/src/inferno/inferno2pipe && cargo build --release)
#   (cd ~/src/statime && cargo build --release)
# Then: sudo ./install-studio.sh [path-to-src, default ~logger/src]
# Running it again updates the binaries and code. The FM recorder is not restarted.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo 'Run this with sudo.' >&2
  exit 1
fi
cd "$(dirname "$0")"
src=${1:-/home/${SUDO_USER:-logger}/src}
inferno=$src/inferno/target/release/inferno2pipe
statime=$src/statime/target/release/statime
for f in "$inferno" "$statime"; do
  [[ -x $f ]] || { echo "Missing $f: build it first (see the top of this script)." >&2; exit 1; }
done
mountpoint -q /mnt/storage || { echo '/mnt/storage is not mounted; aborting.' >&2; exit 1; }

install -d -m 0755 /usr/local/lib/rbm-dante /etc/rbm-dante
install -m 0755 "$inferno" "$statime" /usr/local/lib/rbm-dante/
install -m 0644 statime.toml /etc/rbm-dante/statime.toml
install -m 0755 rbm_studio.py /usr/local/lib/rbm-logger/rbm_studio.py
install -d -m 0750 -o rbmlogger -g rbmlogger /mnt/storage/studio
install -m 0644 rbm-ptp.service rbm-studio.service /etc/systemd/system/

# Keep the Dante routing made while testing as the logger user (Program-L/R@Studio-A ->
# RBM-Logger channels 1 and 2), so the service picks it up without Dante Controller.
state=/var/lib/rbm-logger/.local/state/inferno_aoip
user_state=/home/${SUDO_USER:-logger}/.local/state/inferno_aoip
if [[ ! -d $state && -d $user_state ]]; then
  install -d -m 0750 -o rbmlogger -g rbmlogger /var/lib/rbm-logger/.local /var/lib/rbm-logger/.local/state
  cp -r "$user_state" "$state"
  chown -R rbmlogger:rbmlogger "$state"
  echo "Copied Dante routing from $user_state"
fi

# Test copies started by hand hold the Dante ports; stop them.
pkill -x inferno2pipe 2>/dev/null || true
pkill -f "$statime" 2>/dev/null || true

systemctl daemon-reload
systemctl enable rbm-ptp rbm-studio
systemctl restart rbm-ptp
sleep 3
systemctl restart rbm-studio
sleep 12
systemctl --no-pager --lines=0 status rbm-ptp rbm-studio | grep -E '●|Active'
journalctl -u rbm-studio --since -1min -o cat --no-pager | tail -8
ls -l /mnt/storage/studio | tail -3
