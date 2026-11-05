#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo 'Run this installer with sudo.' >&2
  exit 1
fi
if ! mountpoint -q /mnt/storage; then
  echo 'ERROR: /mnt/storage is not a mounted filesystem; aborting.' >&2
  exit 1
fi
apt-get update
apt-get install -y ffmpeg alsa-utils mdadm python3 logrotate

id -u rbmlogger &>/dev/null || useradd --system --home-dir /var/lib/rbm-logger \
  --create-home --shell /usr/sbin/nologin --groups audio rbmlogger
usermod -aG audio rbmlogger
install -d -m 0750 -o rbmlogger -g rbmlogger /var/lib/rbm-logger
install -d -m 0750 -o rbmlogger -g rbmlogger /mnt/storage/recordings
install -d -m 0755 /usr/local/lib/rbm-logger
install -m 0755 rbm_logger.py /usr/local/lib/rbm-logger/rbm_logger.py
install -m 0755 rbm_backup.py /usr/local/lib/rbm-logger/rbm_backup.py
install -m 0644 rbm-logger.service /etc/systemd/system/rbm-logger.service
install -m 0644 rbm-backup.service /etc/systemd/system/rbm-backup.service
install -m 0644 rbm-backup.timer /etc/systemd/system/rbm-backup.timer
install -m 0644 rbm-logger.logrotate /etc/logrotate.d/rbm-logger
if [[ ! -f /etc/rbm-logger.conf ]]; then
  install -m 0600 rbm-logger.conf.example /etc/rbm-logger.conf
fi
if ! grep -q '^ARRAY' /etc/mdadm/mdadm.conf 2>/dev/null; then
  echo 'WARNING: no ARRAY line in /etc/mdadm/mdadm.conf; the array may come up as md127 after reboot.' >&2
  echo '  Fix: mdadm --detail --scan >> /etc/mdadm/mdadm.conf && update-initramfs -u' >&2
fi
uuid=$(findmnt -no UUID /mnt/storage || true)
if [[ -n "$uuid" ]] && ! grep -q '^RAID_FS_UUID=.' /etc/rbm-logger.conf; then
  sed -i "s/^RAID_FS_UUID=.*/RAID_FS_UUID=$uuid/" /etc/rbm-logger.conf
  echo "Set RAID_FS_UUID=$uuid in /etc/rbm-logger.conf"
fi
systemctl daemon-reload
systemctl enable rbm-logger
printf '\nInstalled. Next: sudo nano /etc/rbm-logger.conf\n'
printf 'Confirm ALSA_CARD_ID/ALSA_DEVICE and set NTFY_URL before starting.\n'
printf 'Start with: sudo systemctl start rbm-logger\n'
printf 'Optional rclone backup timer is installed but NOT enabled.\n'
