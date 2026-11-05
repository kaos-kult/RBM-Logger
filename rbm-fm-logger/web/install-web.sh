#!/usr/bin/env bash
# Install the RBM log download page on the logger. Run from this folder with sudo.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo 'Run this installer with sudo.' >&2
  exit 1
fi
cd "$(dirname "$0")"

apt-get install -y caddy

id -u rbmweb &>/dev/null || useradd --system --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin rbmweb
usermod -aG rbmlogger rbmweb

install -d -m 0755 /usr/local/lib/rbm-web /usr/local/lib/rbm-web/static /usr/local/lib/rbm-web/static/icons
install -m 0755 rbm_web.py rbm_web_check.py /usr/local/lib/rbm-web/
install -m 0644 static/index.html static/app.css static/app.js static/sw.js static/manifest.webmanifest /usr/local/lib/rbm-web/static/
install -m 0644 static/icons/*.png /usr/local/lib/rbm-web/static/icons/
install -m 0644 rbm-web.service rbm-web-check.service rbm-web-check.timer /etc/systemd/system/

if [[ ! -f /etc/rbm-web.conf ]]; then
  echo 'Choose the presenter password for the download page.'
  hash=$(python3 -I /usr/local/lib/rbm-web/rbm_web.py hash-password)
  umask 027
  cat > /etc/rbm-web.conf <<EOF
# RBM log download page. Change the password with:
#   sudo python3 -I /usr/local/lib/rbm-web/rbm_web.py hash-password
# then replace WEB_PASSWORD_HASH and: sudo systemctl restart rbm-web
WEB_PASSWORD_HASH=$hash
# Signs login cookies. Changing it logs everyone out.
WEB_SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
WEB_LISTEN=127.0.0.1:8080
WEB_MAX_HOURS=6
WEB_MAX_JOBS=2
STATION_TZ=Australia/Sydney
EOF
  chown root:rbmweb /etc/rbm-web.conf
  chmod 0640 /etc/rbm-web.conf
fi

# Settings added after the first install: alerts and health checks.
add_setting() {
  grep -q "^$1=" /etc/rbm-web.conf || printf '%s=%s\n' "$1" "$2" >> /etc/rbm-web.conf
}
add_setting NTFY_URL "$(sed -n 's/^NTFY_URL=//p' /etc/rbm-logger.conf 2>/dev/null)"
add_setting NTFY_TOKEN "$(sed -n 's/^NTFY_TOKEN=//p' /etc/rbm-logger.conf 2>/dev/null)"
# Names Caddy serves (space separated); the health check verifies each certificate.
add_setting WEB_PUBLIC_HOSTS "rbm.kaos.zone"
# Full public address, checked from here through the router (needs NAT loopback).
add_setting WEB_CHECK_PUBLIC_URL "https://rbm.kaos.zone/"

# This folder's Caddyfile is the master copy; the Debian default is kept once as .orig.
[[ -f /etc/caddy/Caddyfile && ! -f /etc/caddy/Caddyfile.orig ]] && cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig
# Validate the new config before it replaces the running one.
(set -a; [[ -f /etc/caddy/cloudflare.env ]] && . /etc/caddy/cloudflare.env
 caddy validate --config Caddyfile --adapter caddyfile >/dev/null)
install -m 0644 Caddyfile /etc/caddy/Caddyfile

systemctl daemon-reload
systemctl enable rbm-web
systemctl restart rbm-web
systemctl enable --now rbm-web-check.timer
systemctl reload-or-restart caddy
systemctl --no-pager --lines=3 status rbm-web
echo
systemctl start rbm-web-check.service || true
journalctl -u rbm-web-check --no-pager -n 6 -o cat
echo
echo 'Installed. Re-run this script to update the page after changing its files.'
