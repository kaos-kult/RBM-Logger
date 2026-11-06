#!/usr/bin/env bash
# Serve the download page through a Cloudflare Tunnel instead of port forwarding.
# The logger connects out to Cloudflare, so nothing at the station needs to be reachable
# from the internet and no certificate has to be renewed. Run with sudo.
#
# You need a tunnel token: in the Cloudflare account for the domain, Zero Trust ->
# Networks -> Tunnels -> Create (Cloudflared), and a Public Hostname pointing to
#   Service: HTTP   URL: localhost:8081
# Re-run with a new token to switch tunnels (e.g. from rbm.kaos.zone to vault.rbm.org.au).
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo 'Run this with sudo.' >&2
  exit 1
fi
cd "$(dirname "$0")"

# cloudflared from Cloudflare's own Debian repository, so it gets security updates.
if ! command -v cloudflared >/dev/null; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update
  apt-get install -y cloudflared
fi
cloudflared --version

echo 'Paste the tunnel token (the long string after --token). It will not echo.'
read -rs token
echo
[[ ${#token} -gt 50 ]] || { echo 'That does not look like a tunnel token.' >&2; exit 1; }
install -d -m 0700 /etc/cloudflared
umask 077
printf 'TUNNEL_TOKEN=%s\n' "$token" > /etc/cloudflared/rbm-tunnel.env
chmod 0600 /etc/cloudflared/rbm-tunnel.env

# Caddy's local tunnel entrance (port 8081) is in the Caddyfile.
(set -a; [[ -f /etc/caddy/cloudflare.env ]] && . /etc/caddy/cloudflare.env
 caddy validate --config Caddyfile --adapter caddyfile >/dev/null)
install -m 0644 Caddyfile /etc/caddy/Caddyfile
systemctl reload-or-restart caddy
install -m 0644 rbm-tunnel.service /etc/systemd/system/rbm-tunnel.service
systemctl daemon-reload
systemctl enable rbm-tunnel
systemctl restart rbm-tunnel
sleep 6
systemctl --no-pager --lines=8 status rbm-tunnel
echo
echo 'If the status shows "Registered tunnel connection", the tunnel is up.'
