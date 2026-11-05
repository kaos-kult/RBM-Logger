# Download page (RBM Off-Air Vault)

A password-protected web page where presenters can listen to, or download, any stretch of the off-air archive: pick a date and a start and end time, and the page joins the recordings for exactly that range.

| | |
|---|---|
| Address | **https://rbm.kaos.zone** through Cloudflare (temporary; planned: `logs.rbm.org.au`, see [Moving to rbm.org.au](#moving-to-rbmorgau)) |
| Runs on | The logger (Logger-PC), next to the recordings |
| Login | One shared presenter password |
| Software | `/usr/local/lib/rbm-web/` (service `rbm-web`), web server Caddy (`caddy`) |
| Config | `/etc/rbm-web.conf` (root and the web service only) |
| Source | `rbm-fm-logger/web/` in https://github.com/kaos-kult/RBM-Logger |

## For presenters

1. Open the address and enter the presenter password. You stay logged in on that device for 30 days. **LOCK** logs out.
2. Choose the **broadcast date**. The strip shows that day from midnight to 06:00 the next morning: green is recorded, red hatching is missing.
3. Drag across the strip to choose a range, or set **START** and **END** precisely by turning the dials (one turn = 2 hours, 5-minute clicks; hold Shift for 1-minute steps) or typing the times. An end earlier than the start means the next day, so 23:00–01:00 works.
4. **▶ LISTEN** plays the range in the browser, with a scrub bar, skip buttons and a clock showing when it went to air. Missing stretches are skipped automatically.
5. **DOWNLOAD** saves the range as one MP3, up to 6 hours long. If part of the range was never recorded, the page warns you first, and the file name ends in `_INCOMPLETE`.

All times are Blue Mountains local time.

## How it works

```
Presenter ──https──> Cloudflare proxy ──https :8443──> routers ──> Caddy :443 (TLS) ──> rbm-web 127.0.0.1:8080 ──read-only──> /mnt/storage/recordings
                     (origin rule)                                 on the logger
```

- **Listening** streams the original recording files one after another, with HTTP range requests so seeking is instant. Nothing is converted.
- **Downloading** joins the files for the range with ffmpeg. Where every file has the same format (all 48 kHz logger files, or all 44.1 kHz streamer files), the audio is copied unchanged and a 6-hour file takes seconds. A range crossing between the two formats is converted to 48 kHz, for that download only.
- Where two recordings overlap (for example, the streamer and logger copies on 5 Nov 2026), each one is used only up to where the next starts, so nothing plays twice.
- The timeline comes from the files' actual sizes, so a truncated recording shows only what really exists. Files under 5 seconds are ignored.

### Protecting the recorder

The page runs on the recording machine, so it is fenced off from it:

- It runs as its own user (`rbmweb`) with **read-only** access to the recordings, through the `rbmlogger` group. It cannot see the recorder's config or event log, and it can't write anywhere except its own private temp folder.
- Low CPU and disk priority, a 1 GB memory cap, at most **2 downloads being joined at once**, and a 6-hour maximum per range. A busy page can't starve the recorder.
- The browser only ever sends times, never file names or paths.
- Stalled or abandoned downloads are dropped after 60 seconds, and their join is killed.

### Security

- HTTPS only, with a Let's Encrypt certificate (see [Network and certificates](#network-and-certificates)).
- One shared password, stored only as a scrypt hash. Login sets a signed, HttpOnly, Secure, SameSite=Strict cookie.
- **Five wrong passwords from one address lock it out for 15 minutes**, with an alert to ntfy.
- The station's podcasts are already public, so the content is not secret. The password is there to keep bots and casual browsing out.

## Alerts

Problems are pushed to the same ntfy topic as the recorder's alerts (see [fm-logger.md](fm-logger.md#alerts)). Each kind of problem alerts at most once an hour.

| Alert | Meaning | What to do |
|---|---|---|
| Download page problem: web service | The page isn't answering on the logger (checked every 5 min, alerted after 2 failures) | `systemctl status rbm-web`; `journalctl -u rbm-web -n 50` |
| Download page problem: HTTPS certificate | Caddy isn't serving a valid certificate, or it expires within 14 days | `systemctl status caddy`. Usually the Cloudflare API token expired or was revoked; see [Certificates](#certificates) |
| Download page problem: public address | The page works on the logger but not from outside | Router port forward 8443, internet connection, or DNS |
| Download page recovered | The above is fixed | Nothing |
| Download page can't read the archive / sees no recordings | The RAID isn't mounted or readable | Check the recorder's alerts and `cat /proc/mdstat` |
| Download failed | ffmpeg failed to join a range | `journalctl -u rbm-web` for the error. Possibly a damaged recording file |
| Download page error | An unexpected error in the page (the listener got an error message) | `journalctl -u rbm-web` for the traceback |
| Repeated wrong passwords | An address was locked out | A one-off is probably a presenter. Repeats may be someone guessing; consider changing the password |

The checks are run by `rbm-web-check.timer`, separately from the page itself, so they still report when the page is down. To run them by hand:

```bash
ssh -t logger 'sudo systemctl start rbm-web-check && journalctl -u rbm-web-check -n 6 -o cat'
```

## Network and certificates

**The ISP (AAPT) blocks incoming ports 80 and 443**, and that can't be turned off. So:

- The station is reached on **external port 8443**. Port forwards: NetComm modem `8443 → 192.168.1.3:8443` (the UDM), UDM `8443 → 10.1.2.198:443` (the logger). The 80 and 443 forwards on both devices do nothing and can be deleted.
- **`rbm.kaos.zone` is proxied through Cloudflare (orange cloud), with an origin rule** that sends visitors on to port 8443. This is [Option B](#option-b-cloudflare-proxy-with-an-origin-rule-no-8443-what-rbmkaoszone-uses), set up 6 Nov 2026. Presenters use the plain address `https://rbm.kaos.zone`. **All listening and download traffic passes through Cloudflare.** `https://rbm.kaos.zone:8443` also works, through Cloudflare too.
- Because of the proxy, Caddy trusts Cloudflare's servers (the `trusted_proxies` list in the Caddyfile) to say who the real visitor is. Without that, the password lockout would lock out everyone sharing a Cloudflare server. **If Cloudflare adds address ranges** (see cloudflare.com/ips), add them to the Caddyfile.
- Cloudflare's bot protection blocks scripts that don't look like browsers. The health check identifies itself as a browser for that reason. If presenters ever get a Cloudflare challenge page, look at **Security → Bots** for `kaos.zone`.
- Let's Encrypt can't reach the logger directly, so Caddy proves it owns the name through **Cloudflare DNS**: it briefly adds a DNS record using a Cloudflare API token. Cloudflare's SSL/TLS mode for the zone must be **Full (strict)**.
- **To take the audio off Cloudflare again:** set the record to DNS only (grey cloud), turn off the origin rule, and tell presenters to use `https://rbm.kaos.zone:8443`. Set `WEB_CHECK_PUBLIC_URL` in `/etc/rbm-web.conf` to match.

### Certificates

- Caddy is the official build with the Cloudflare DNS plugin, installed by `web/caddy-dns-setup.sh`. Debian's own `caddy` package lacks the plugin. It's kept from overwriting this build by a dpkg diversion: Debian's binary is at `/usr/bin/caddy.default`. **After a Caddy security update, re-run `caddy-dns-setup.sh`** to fetch the latest official build.
- The Cloudflare API token is in `/etc/caddy/cloudflare.env`, readable only by root and Caddy. It has **Zone → DNS → Edit** permission on `kaos.zone` only. If it's revoked or expires, renewals fail and the health check alerts 14 days before the certificate expires. To replace it: create a new token, `sudo nano /etc/caddy/cloudflare.env`, `sudo systemctl restart caddy`.

## Moving to rbm.org.au

The planned address is `logs.rbm.org.au`. This needs someone with access to RBM's Cloudflare account. There are two ways.

### Option A: DNS only (audio stays off Cloudflare)

Audio goes directly from the logger to the listener (not through Cloudflare), but the address keeps `:8443`.

1. **In RBM's Cloudflare** (`rbm.org.au` zone):
   - Add an **A** record `logs` → the station's public IP (the address `rbm.kaos.zone` pointed to before it was proxied, or from the router's WAN status), **Proxy status: DNS only (grey cloud)**.
   - Create an API token (**My Profile → API Tokens → Create Token → "Edit zone DNS"**) with **Zone Resources: Include → Specific zone → rbm.org.au**. A token from RBM's own account is better than one from a personal account, so the station owns the whole setup.
2. **Token on the logger:** put the new token in `/etc/caddy/cloudflare.env` (`CF_API_TOKEN=…`). One token can cover both zones while `rbm.kaos.zone` is still in use. If the two zones are in different Cloudflare accounts, see [Two tokens](#two-tokens).
3. **Caddyfile** (`web/Caddyfile` in this project), change the site line to:
   ```
   logs.rbm.org.au, rbm.kaos.zone {
   ```
4. **`/etc/rbm-web.conf`** on the logger:
   ```
   WEB_PUBLIC_HOSTS=logs.rbm.org.au rbm.kaos.zone
   WEB_CHECK_PUBLIC_URL=https://logs.rbm.org.au:8443/
   ```
5. **Deploy:** copy `web/` to the logger and run `sudo ./install-web.sh`. Then check `https://logs.rbm.org.au:8443` and tell presenters the new address.
6. **Later:** remove `rbm.kaos.zone` from both files, redeploy, and delete its DNS record.

### Option B: Cloudflare proxy with an origin rule (no `:8443`; what rbm.kaos.zone uses)

Gives the clean address `https://logs.rbm.org.au`. Cloudflare receives visitors on the normal port 443, and an **origin rule** sends them on to the station's port 8443, which AAPT doesn't block.

**Trade-off: all listening and download traffic then goes through Cloudflare.** That's hours of audio, which is what we chose to avoid for `rbm.kaos.zone`. Cloudflare's free plan handles it, but it's subject to Cloudflare's terms and availability.

1. Do steps 1–4 of Option A, but make the `logs` record **Proxied (orange cloud)**.
2. **Origin rule:** in the `rbm.org.au` zone, go to **Rules → Origin Rules → Create rule**:
   - **If:** Hostname equals `logs.rbm.org.au`.
   - **Then:** Destination Port → **Rewrite to** `8443`.
3. **TLS between Cloudflare and the logger:** set **SSL/TLS → Overview → Full (strict)**, or a **Configuration Rule** for that hostname setting SSL to Full (strict) if the rest of rbm.org.au must stay as it is. Caddy has a real certificate, so strict mode works.
4. **Caddy already trusts Cloudflare** (the `servers { trusted_proxies … }` block in the Caddyfile, added for `rbm.kaos.zone`), so nothing to do here.
5. In `/etc/rbm-web.conf`: `WEB_CHECK_PUBLIC_URL=https://logs.rbm.org.au/`. Deploy as in Option A.
6. **Caching:** listening responses are marked `private`, so Cloudflare doesn't cache recordings. Leave it that way. Don't add a "Cache Everything" rule for this hostname.

### Two tokens

If `kaos.zone` and `rbm.org.au` are in different Cloudflare accounts, one token can't cover both. Either finish the move and drop `rbm.kaos.zone` at the same time, or give each site its own token in the Caddyfile (`dns cloudflare {env.CF_API_TOKEN_RBM}` in a separate `logs.rbm.org.au { … }` block) and add `CF_API_TOKEN_RBM=…` to `/etc/caddy/cloudflare.env`.

## Common tasks

**Change the presenter password:**
```bash
ssh -t logger 'sudo python3 -I /usr/local/lib/rbm-web/rbm_web.py hash-password'
```
Paste the printed `scrypt$…` line over `WEB_PASSWORD_HASH=` in `/etc/rbm-web.conf` (`sudo nano`), then `sudo systemctl restart rbm-web`. Existing logins stay valid. To log everyone out, also replace `WEB_SECRET` with the output of `python3 -c "import secrets; print(secrets.token_hex(32))"`.

**Update the page after changing its files:** copy `rbm-fm-logger/web/` to `~/rbm-web` on the logger, then:
```bash
ssh -t logger 'cd ~/rbm-web && sudo ./install-web.sh'
```
It keeps the existing password and settings.

**Status and logs:**
```bash
ssh logger 'systemctl status rbm-web caddy rbm-web-check.timer --no-pager'
ssh -t logger 'sudo journalctl -u rbm-web -n 50'
```

**Settings** in `/etc/rbm-web.conf`:

| Setting | Default | Meaning |
|---|---|---|
| `WEB_PASSWORD_HASH` | | scrypt hash of the presenter password |
| `WEB_SECRET` | random | Signs login cookies; changing it logs everyone out |
| `WEB_MAX_HOURS` | `6` | Longest range per listen or download |
| `WEB_MAX_JOBS` | `2` | Downloads joined at once; more get "busy, try again" |
| `WEB_SESSION_DAYS` | `30` | How long a login lasts |
| `NTFY_URL` / `NTFY_TOKEN` | copied from the recorder | Where alerts go |
| `WEB_PUBLIC_HOSTS` | `rbm.kaos.zone` | Names whose certificates the health check verifies |
| `WEB_CHECK_PUBLIC_URL` | `https://rbm.kaos.zone/` | Public address the health check fetches (through Cloudflare) |
