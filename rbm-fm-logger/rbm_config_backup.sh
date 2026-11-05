#!/bin/bash
# Nightly copy of the logger's own settings onto the RAID, so a dead system SSD can be
# replaced and the logger rebuilt exactly as it was (see docs/rebuild-logger.md).
# Run as root by rbm-config-backup.timer. The archive holds secrets (the download page's
# password hash, the Cloudflare token, SSH host keys), so it is readable by root only.
set -euo pipefail

MOUNT=/mnt/storage
DEST=$MOUNT/system-backup
STATUS=/var/lib/rbm-logger/config-backup.status
KEEP=30

fail() {
  echo "FAILED: $1" > "$STATUS"
  NTFY_URL=$(sed -n 's/^NTFY_URL=//p' /etc/rbm-logger.conf 2>/dev/null || true)
  NTFY_TOKEN=$(sed -n 's/^NTFY_TOKEN=//p' /etc/rbm-logger.conf 2>/dev/null || true)
  if [[ -n "$NTFY_URL" ]]; then
    args=(-fsS -m 20 -H "Title: RBM logger settings backup failed" -H "Priority: high" -H "Tags: radio,warning"
          --data-binary "$1. Without it, rebuilding after an SSD failure means re-entering settings by hand.")
    [[ -n "$NTFY_TOKEN" ]] && args+=(-H "Authorization: Bearer $NTFY_TOKEN")
    curl "${args[@]}" "$NTFY_URL" >/dev/null || true
  fi
  echo "$1" >&2
  exit 1
}

# Only ever write to the real RAID, never to the SSD under an empty mount point.
mountpoint -q "$MOUNT" || fail "$MOUNT is not mounted"

umask 077
install -d -m 0700 -o root -g root "$DEST"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Things that can't simply be copied: the package list, users and their numbers.
dpkg --get-selections > "$work/packages.txt"
getent passwd logger rbmlogger rbmweb > "$work/users.txt" || true
getent group rbmlogger rbmweb audio > "$work/groups.txt" || true
cat /proc/mdstat > "$work/mdstat.txt"
mdadm --detail --scan > "$work/mdadm-scan.txt" 2>/dev/null || true
lsblk -o NAME,SIZE,MODEL,SERIAL,FSTYPE,UUID,MOUNTPOINTS > "$work/disks.txt"
for disk in $(lsblk -dn -o NAME,TYPE | awk '$2 == "disk" {print $1}'); do
  sgdisk --backup="$work/partitions-$disk.gpt" "/dev/$disk" >/dev/null 2>&1 || true
done
systemctl list-unit-files --state=enabled --no-legend > "$work/enabled-units.txt"

# Everything that lives only on the SSD. Missing paths are skipped.
paths=(
  /etc/rbm-logger.conf /etc/rbm-web.conf
  /etc/caddy /etc/systemd/system/caddy.service.d
  /etc/systemd/system/rbm-*.service /etc/systemd/system/rbm-*.timer
  /usr/local/lib/rbm-logger /usr/local/lib/rbm-web
  /etc/mdadm/mdadm.conf /etc/fstab /etc/smartd.conf /etc/logrotate.d/rbm-logger
  /etc/apt/apt.conf.d/20auto-upgrades /etc/apt/apt.conf.d/52rbm-unattended-upgrades
  /etc/ssh/sshd_config /etc/ssh/sshd_config.d /etc/ssh/ssh_host_*
  /etc/hostname /etc/hosts /etc/network/interfaces /etc/network/interfaces.d
  /etc/timezone /etc/localtime /etc/sudoers.d
  /home/logger/.ssh /home/logger/rbm-fm-logger /home/logger/rbm-web
  /var/lib/rbm-logger /var/lib/rbm-web-check /var/lib/rbm-guide
)
existing=()
for p in "${paths[@]}"; do [[ -e $p ]] && existing+=("$p"); done

name="logger-config-$(date +%Y%m%d).tar.gz"
tar --create --gzip --file "$DEST/$name.part" --absolute-names "${existing[@]}" \
    --transform "s|^$work|/rbm-backup-info|" "$work" 2>"$work/tar.err" \
  || fail "tar failed: $(tail -c 300 "$work/tar.err")"
mv "$DEST/$name.part" "$DEST/$name"

# A plain, readable copy of the docs next to the archives: the rebuild guide is needed
# exactly when the system SSD is dead.
if [[ -d /home/logger/rbm-fm-logger/docs ]]; then
  rm -rf "$DEST/docs" && cp -r /home/logger/rbm-fm-logger/docs "$DEST/docs"
fi
ln -sfn "$name" "$DEST/logger-config-latest.tar.gz"

# Keep the newest $KEEP archives.
ls -1t "$DEST"/logger-config-2*.tar.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f

size=$(du -h "$DEST/$name" | cut -f1)
echo "OK $(date -Iseconds) $name $size" > "$STATUS"
chmod 0644 "$STATUS"
echo "Saved $DEST/$name ($size)"
