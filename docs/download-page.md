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

1. Open the address and enter the presenter password. You stay logged in on that device for 30 days. The **🔒** padlock button locks the vault (logs out).
2. Choose the **broadcast date**. The strip shows that day from midnight to 06:00 the next morning: green is recorded, red hatching is missing.
3. **Click a show** in the gold row along the top of the strip to select exactly that show (names too long for their box scroll). Or drag across the strip to choose any range, or set **START** and **END** precisely by turning the dials (one turn = 2 hours, 5-minute clicks; hold Shift for 1-minute steps) or typing the times. An end earlier than the start means the next day, so 23:00–01:00 works.
4. **▶ AUDITION** plays the range in the browser, with a scrub bar, skip buttons and a clock showing when it went to air. Missing stretches are skipped automatically.
   - **Trim it to the second:** drag the two **✂ scissors** (in the strip above the scrub bar) to where the programme really starts and ends. Dragging in the bar itself always moves the playhead, and the audio follows as you drag, so you can scrub to the spot by ear. The parts outside go dark. Or play through and press **✂ Cut here** (keys **I** and **O**) the moment you hear where it should start or end, and the scissors jump to the playhead. Fine-tune with **−1s / +1s**, or click the bar and use ← → (Shift for 10 seconds). **▶ From IN** plays from the start of the cut, **Hear OUT ◀** plays the last 5 seconds and stops exactly at the end, and normal playback stops at the end too. **DOWNLOAD**, under the player, then saves exactly the trimmed cut, so there's no need for Audacity. **Reset trim** goes back to the whole selection, and changing the selection clears the trim.
5. **● LIVE** plays what's on air right now, about 6 seconds behind, straight from the logger. It works like a DVR: **pause** and it waits for you, **−30s / −5m** or the scrub bar (the last 6 hours) to go back, and **⏭ LIVE** to catch up again. The clock shows when the audio you're hearing went to air, and "−0:02:31 behind live" when you're behind. It never runs out: it carries on across the hourly files by itself.
6. **DOWNLOAD** appears under the player once you've auditioned the selection. It saves the range, or the trimmed cut, as one MP3, up to 6 hours long, after a short and entirely unnecessary cassette ceremony: a tape is labelled, stamped and ejected. Click or press any key to skip it; the download never waits for it.
   - If the range is essentially one show (at least 80% overlap both ways), the file is named after it, for example `RBMFM_Strange-Brew-Breakfast_20261105_0700-0900.mp3`. Otherwise it's named by time, for example `RBMFM_20261105T0700-20261105T0930.mp3`.
   - If part of the range was never recorded, the page warns you first, the stamp reads **INCOMPLETE — SOME RADIO MAY BE MISSING**, and the file name ends in `_INCOMPLETE`.

**Show names** come from the station's programme guide (see [Programme guide](#programme-guide)). A name with **"probably"**, a `~` and a dashed outline is a guess from a later schedule: the show that is in that slot now, which may not be what was on that day. Overnight hours have no names, because there's no local programming then (that's usually the Community Radio Network).

**On studio computers whose audio goes to air:** tap the **🔊** button next to the 🔒 padlock so it shows **🔇**. That mutes the page's **sound effects** (the clicks, zaps, and the cassette's thud and whoosh) on that computer only, and it's remembered. **Listening still works normally,** so cue it to the monitors before pressing play. Clearing the browser's cookies turns the effects back on. An admin can also run `rbmMuteEffects()` or `rbmUnmuteEffects()` in the browser's developer console.

All times are Blue Mountains local time.

**Install it as an app** (optional). It then opens in its own window with the RBM Vault icon, and works with the phone's lock-screen and headphone media controls:
- **iPhone/iPad (Safari):** Share → **Add to Home Screen**.
- **Android (Chrome):** the **Install app** prompt, or ⋮ → **Add to Home screen**.
- **Windows/Mac (Chrome or Edge):** the install icon at the right of the address bar.

The app still needs a connection to play or download. Offline, it opens and says so, and reconnects by itself.

## How it works

```
Presenter ──https──> Cloudflare proxy ──https :8443──> routers ──> Caddy :443 (TLS) ──> rbm-web 127.0.0.1:8080 ──read-only──> /mnt/storage/recordings
                     (origin rule)                                 on the logger
```

- **Live** (`/api/live?at=<time>`) streams the archive from any moment and **never ends**: at the end of the file the recorder is still writing, it waits for more, and at the top of the hour it carries on into the next file. Each stream starts on an MP3 frame boundary. Pausing on the page drops the stream and remembers the moment; play opens a new stream from there. Up to 12 live listeners at once (`WEB_MAX_LIVE`), each stream capped at 12 hours, and a stream gives up if the recorder writes nothing for 2 minutes.
- **Listening** streams the original recording files one after another, with HTTP range requests so seeking is instant. Nothing is converted.
- **Downloading** joins the files for the range with ffmpeg. Where every file has the same format (all 48 kHz logger files, or all 44.1 kHz streamer files), the audio is copied unchanged and a 6-hour file takes seconds. A range crossing between the two formats is converted to 48 kHz, for that download only.
- Where two recordings overlap (for example, the streamer and logger copies on 5 Nov 2026), each one is used only up to where the next starts, so nothing plays twice.
- **Installable app (PWA):** `manifest.webmanifest` and the service worker `sw.js` make the page installable. The service worker caches only the page itself (HTML, CSS, JS, icons), always fetching fresh copies when online. It **never caches anything under `/api/`**, so logins, recordings and downloads always come from the server. After changing the page's files, bump `CACHE` in `sw.js` (`rbm-vault-shell-vN`) so installed copies drop their old cache.
- **Cassette animation:** `static/cassette.js` and `cassette.css`, built from `mockups/cassette-export.html`, with 104 stamp labels. It plays after the download is checked, and starts the download as the cassette is ejected. Skipping, reduced-motion settings, or any error go straight to the download.
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

## Programme guide

The station website's guide (WordPress with the MetaRadio plugin) is public at `https://www.rbm.org.au/wp-json/metaradio/v1/stationguide?station=1`, but it only covers **the coming 7 days**. So the logger saves a snapshot **every day** (`rbm_guide_fetch.py`, run by `rbm-guide-fetch.timer` at about 04:20, and at boot) into `/var/lib/rbm-guide/guide-YYYYMMDD.json`. The snapshots are tiny and are kept forever; they're also in the nightly settings backup.

- **Exact names:** a date that some snapshot covered gets the shows that snapshot listed, the newest snapshot winning.
- **Probable names:** a date before the first snapshot (6 Nov 2026), or any day no snapshot covered, borrows that weekday's shows from the nearest snapshot. These are marked "probably … (per the *Mon YYYY* schedule)".
- **If a snapshot fails** (the website is down, or the plugin changes), ntfy gets **"RBM programme guide snapshot failed"**. One missed day doesn't matter; nearby snapshots fill in. If it keeps failing, check that the URL above still returns JSON.

To take one by hand: `ssh -t logger 'sudo systemctl start rbm-guide-fetch && sudo ls /var/lib/rbm-guide'`.

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
| Programme guide snapshot failed | The daily guide couldn't be fetched from rbm.org.au | Nothing, if it's a one-off. If it repeats, check the guide URL in [Programme guide](#programme-guide) |
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

## Cloudflare Tunnel (the way in from now on)

The page is reached through a **Cloudflare Tunnel**: `cloudflared` on the logger (service `rbm-tunnel`) keeps an outgoing connection to Cloudflare, and visitors arrive down it.

- **Nothing at the station is open to the internet.** Once a tunnel is serving a name, the 8443 port forwards on both routers can be deleted.
- **No certificates to manage for it.** Cloudflare handles HTTPS for visitors. The tunnel hands requests to Caddy's **local-only entrance on port 8081** (plain HTTP, localhost only), which passes on the real visitor's address (`CF-Connecting-IP`) for the password lockout.
- **No dependency on the station's IP or ISP,** and it keeps working behind carrier-grade NAT.
- The tunnel token is in `/etc/cloudflared/rbm-tunnel.env` (root only). `cloudflared` comes from Cloudflare's Debian repository, so automatic security updates cover it. It runs sandboxed, with no access to the recordings or configs.
- The health check alerts if the tunnel service stops, as **"Download page problem: Cloudflare tunnel"**, and checks the public address through it.

**To set up or switch a tunnel:**
1. In the Cloudflare account for the domain: **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**, and name it (e.g. `rbm-logger`). Copy the **token**, the long string after `--token`, from the install screen.
2. **Public Hostname:** the name, for example `vault` + `rbm.org.au`, with **Service: HTTP**, **URL: `localhost:8081`**. If a DNS record already exists for that name, delete it first; Cloudflare creates its own.
3. On the logger: copy `web/` to `~/rbm-web`, run `sudo ./tunnel-setup.sh`, and paste the token. Look for "Registered tunnel connection" in the status.
4. Update `WEB_CHECK_PUBLIC_URL` in `/etc/rbm-web.conf` to the new address, then `sudo systemctl start rbm-web-check`.

Running the script again with a new token switches the logger to that tunnel.

## Moving to rbm.org.au (older notes: port forwarding)

Superseded by the tunnel above, which needs neither the port forwards nor a certificate. Kept for reference.

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
