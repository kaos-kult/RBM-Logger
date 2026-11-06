#!/usr/bin/env bash
# The ISP (AAPT) blocks incoming ports 80 and 443, so Let's Encrypt can't reach the logger.
# This swaps Debian's Caddy for the official Caddy build with the Cloudflare DNS plugin,
# so certificates are proved through DNS instead. The page is then served on external
# port 8443 (router forwards 8443 -> logger 443). Only DNS records go through Cloudflare;
# the audio goes directly from the logger to the listener. Run with sudo.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo 'Run this with sudo.' >&2
  exit 1
fi
cd "$(dirname "$0")"

# Keep apt from putting Debian's plugin-less binary back on upgrade.
if ! dpkg-divert --list /usr/bin/caddy | grep -q caddy.default; then
  dpkg-divert --divert /usr/bin/caddy.default --rename /usr/bin/caddy
fi
curl -fsSL -o /tmp/caddy-cf \
  'https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com%2Fcaddy-dns%2Fcloudflare'
chmod 0755 /tmp/caddy-cf
/tmp/caddy-cf list-modules | grep -q '^dns.providers.cloudflare$'
install -m 0755 /tmp/caddy-cf /usr/bin/caddy
rm -f /tmp/caddy-cf
/usr/bin/caddy version

if [[ ! -s /etc/caddy/cloudflare.env ]]; then
  echo 'Paste the Cloudflare API token (Zone > DNS > Edit, kaos.zone only). It will not echo.'
  read -rs token
  echo
  umask 027
  printf 'CF_API_TOKEN=%s\n' "$token" > /etc/caddy/cloudflare.env
  chown root:caddy /etc/caddy/cloudflare.env
  chmod 0640 /etc/caddy/cloudflare.env
fi

install -d /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/cloudflare.conf <<'EOF'
[Service]
EnvironmentFile=/etc/caddy/cloudflare.env
EOF
install -m 0644 Caddyfile /etc/caddy/Caddyfile

systemctl daemon-reload
systemctl restart caddy
sleep 5
systemctl --no-pager --lines=0 status caddy
echo
echo 'Caddy restarted. The certificate usually arrives within a minute or two:'
echo '  https://rbm.kaos.zone:8443'
