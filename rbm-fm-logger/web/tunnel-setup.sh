#!/usr/bin/env bash
# Serve the download page through a Cloudflare Tunnel instead of port forwarding.
# The logger connects out to Cloudflare, so nothing at the station needs to be reachable
# from the internet and no certificate has to be renewed. Run with sudo, one of:
#
#   sudo ./tunnel-setup.sh --create vault.rbm.org.au
#       Locally-managed tunnel (no Zero Trust sign-up, no card). Prints a link: whoever
#       owns the domain opens it, logs in to Cloudflare and approves the domain. The
#       script then creates the tunnel, points the name at it, keeps only the tunnel's own
#       credentials (which can run this one tunnel and nothing else) and deletes the
#       Cloudflare login certificate it was given.
#
#   sudo ./tunnel-setup.sh --credentials <tunnel-id>.json vault.rbm.org.au
#       Same, but the domain owner ran `cloudflared tunnel login / create / route dns`
#       on their own computer and sent just the <tunnel-id>.json file.
#
#   sudo ./tunnel-setup.sh --token
#       Dashboard-managed tunnel (Zero Trust -> Networks -> Tunnels, public hostname
#       Service HTTP, URL localhost:8081). Paste the token when asked.
#
# Running it again switches the logger to the new tunnel.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo 'Run this with sudo.' >&2
  exit 1
fi
cd "$(dirname "$0")"
mode=${1:-}
case "$mode" in
  --create) host=${2:?give the public name, e.g. vault.rbm.org.au} ;;
  --credentials) creds_in=${2:?give the tunnel credentials .json file}; host=${3:?give the public name} ;;
  --token) ;;
  *) sed -n '2,24p' "$0"; exit 1 ;;
esac

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
# The folder is readable so the unprivileged service can read its config (no secrets in
# it); the credentials and token files inside stay root-only (0600).
install -d -m 0755 /etc/cloudflared
umask 077
dropin=/etc/systemd/system/rbm-tunnel.service.d
install -d -m 0755 "$dropin"

if [[ $mode == --token ]]; then
  echo 'Paste the tunnel token (the long string after --token). It will not echo.'
  read -rs token
  echo
  [[ ${#token} -gt 50 ]] || { echo 'That does not look like a tunnel token.' >&2; exit 1; }
  printf 'TUNNEL_TOKEN=%s\n' "$token" > /etc/cloudflared/rbm-tunnel.env
  rm -f "$dropin/credentials.conf"
else
  if [[ $mode == --create ]]; then
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    echo
    echo "Open the link below in a browser, log in to the Cloudflare account for ${host#*.},"
    echo "and approve that domain. This machine only uses the approval to create the tunnel."
    echo
    # login saves its certificate under $HOME/.cloudflared; keep that in the temporary folder.
    HOME="$work" cloudflared tunnel login
    cert="$work/.cloudflared/cert.pem"
    [[ -s "$cert" ]] || { echo 'Login was not completed.' >&2; exit 1; }
    name="rbm-logger-${host//./-}"
    cloudflared tunnel --origincert "$cert" create --credentials-file "$work/tunnel.json" "$name"
    # Point the public name at the tunnel, replacing any record it has now.
    cloudflared tunnel --origincert "$cert" route dns --overwrite-dns "$name" "$host"
    creds_in="$work/tunnel.json"
    # The login certificate can manage the whole zone: it is not kept.
  fi
  tunnel_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["TunnelID"])' "$creds_in")
  install -m 0600 "$creds_in" /etc/cloudflared/rbm-tunnel.json
  cat > /etc/cloudflared/rbm-tunnel.yml <<EOF
# Locally-managed Cloudflare Tunnel for the RBM download page (made by tunnel-setup.sh).
tunnel: $tunnel_id
ingress:
  - hostname: $host
    service: http://localhost:8081
  - service: http_status:404
EOF
  chmod 0644 /etc/cloudflared/rbm-tunnel.yml
  # The service runs as an unprivileged dynamic user; systemd hands it the credentials.
  cat > "$dropin/credentials.conf" <<'EOF'
[Service]
EnvironmentFile=
LoadCredential=tunnel.json:/etc/cloudflared/rbm-tunnel.json
ExecStart=
ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel --metrics 127.0.0.1:8099 --config /etc/cloudflared/rbm-tunnel.yml --credentials-file %d/tunnel.json run
EOF
  chmod 0644 "$dropin/credentials.conf"
  rm -f /etc/cloudflared/rbm-tunnel.env
fi

# Caddy's local tunnel entrance (port 8081) is in the Caddyfile.
(set -a; [[ -f /etc/caddy/cloudflare.env ]] && . /etc/caddy/cloudflare.env
 caddy validate --config Caddyfile --adapter caddyfile >/dev/null)
install -m 0644 Caddyfile /etc/caddy/Caddyfile
systemctl reload-or-restart caddy
install -m 0644 rbm-tunnel.service /etc/systemd/system/rbm-tunnel.service
install -m 0755 rbm_web_check.py /usr/local/lib/rbm-web/rbm_web_check.py
systemctl daemon-reload
systemctl enable rbm-tunnel
systemctl restart rbm-tunnel
sleep 8
systemctl --no-pager --lines=6 status rbm-tunnel || true
echo
if journalctl -u rbm-tunnel --since "-1min" -o cat | grep -q "Registered tunnel connection"; then
  echo "Tunnel is up.${host:+ Try https://$host}"
else
  echo 'No "Registered tunnel connection" yet: check journalctl -u rbm-tunnel -n 30'
fi
