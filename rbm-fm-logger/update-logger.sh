#!/usr/bin/env bash
# Update an installed logger to this folder's version, and set up automatic security
# updates, disk health and the weekly summary. Restarts the recorder only if its code changed. Run with sudo.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo 'Run this with sudo.' >&2
  exit 1
fi
cd "$(dirname "$0")"

# Automatic Debian security updates. Never reboots by itself: the weekly summary says
# when a reboot is needed, so it can be done at a quiet time.
apt-get install -y unattended-upgrades
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat > /etc/apt/apt.conf.d/52rbm-unattended-upgrades <<'EOF'
// RBM logger: install security updates daily, never reboot automatically.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

# Only restart the recorder (a gap of a few seconds) if its own code changed.
recorder_changed=1
cmp -s rbm_logger.py /usr/local/lib/rbm-logger/rbm_logger.py && recorder_changed=0
install -m 0755 rbm_logger.py rbm_studio.py rbm_backup.py rbm_weekly.py smart_report.py smart_alert.sh rbm_config_backup.sh /usr/local/lib/rbm-logger/

# Disk health: smartd watches every disk, runs a short self-test daily and a long one
# weekly, and calls smart_alert.sh (ntfy) on new bad sectors, failures or overheating.
apt-get install -y smartmontools gdisk
cat > /etc/smartd.conf <<'EOF'
# RBM logger. -a: monitor health, attributes and error logs. Self-tests: short daily at
# 02:00, long on Sundays at 03:00. -W: report +4°C changes, warn at 45°C, alarm at 55°C.
DEVICESCAN -a -o on -S on -n standby,q -s (S/../.././02|L/../../7/03) -W 4,45,55 -m <nomailer> -M exec /usr/local/lib/rbm-logger/smart_alert.sh
EOF
systemctl enable smartmontools
systemctl restart smartmontools
install -m 0644 rbm-weekly.service rbm-weekly.timer rbm-config-backup.service rbm-config-backup.timer /etc/systemd/system/
grep -q '^WEB_PUBLIC_HOSTS=' /etc/rbm-logger.conf || \
  printf '# Download page names whose certificates the weekly summary checks.\nWEB_PUBLIC_HOSTS=rbm.kaos.zone\n' >> /etc/rbm-logger.conf

systemctl daemon-reload
systemctl enable --now rbm-weekly.timer rbm-config-backup.timer
echo 'Saving the settings backup now:'
systemctl start rbm-config-backup.service
cat /var/lib/rbm-logger/config-backup.status
if (( recorder_changed )); then
  systemctl restart rbm-logger
  sleep 5
fi
systemctl is-active rbm-logger
unattended-upgrade --dry-run 2>&1 | tail -3
echo 'Sending a first weekly summary now as a test:'
systemctl start rbm-weekly.service
journalctl -u rbm-weekly -n 20 -o cat --no-pager
