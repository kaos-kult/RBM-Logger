# FM off-air logger

The logger records what Radio Blue Mountains actually puts to air, as received off-air by an FM receiver, 24/7. It is the station's record for complaints, ACMA requests and "what did we play at 8 pm on Tuesday".

Since 6 Nov 2026 it also records a clean copy of Studio-A's output straight off the Dante network, which is what presenters download: see [studio-recorder.md](studio-recorder.md). The two are separate services; this page is about the off-air recording.

## At a glance

| | |
|---|---|
| Machine | Logger-PC, Debian 13, `ssh logger` (see [ssh-access.md](ssh-access.md)) |
| Audio input | FM receiver → USB sound card `ICUSBAUDIO7D` (line in, stereo) |
| Recording | MP3, 192 kbps, 48 kHz stereo, one file per clock hour |
| Storage | 2 × 1 TB RAID1 (`/dev/md0`), mounted at `/mnt/storage` |
| Recordings | `/mnt/storage/recordings/` |
| Event log | `/var/lib/rbm-logger/events.log` (kept 10 years) |
| Config | `/etc/rbm-logger.conf` (root only) |
| Software | `/usr/local/lib/rbm-logger/rbm_logger.py`, service `rbm-logger` |
| Source and docs | **https://github.com/kaos-kult/RBM-Logger** (also in `~/rbm-fm-logger/docs/` on the logger) |
| Alerts | Push notifications via ntfy (see [Alerts](#alerts)) |
| Listening and downloads | Presenters use the download page: **https://rbm.kaos.zone**, see [download-page.md](download-page.md) |

About 2 GB of audio per day, or about 60 GB per month. The RAID holds well over a year.

## File names

```
RBMFM_20261105T210000+1100.mp3
```

`RBMFM_`, then the **local** start date and time in ISO 8601 basic format (`YYYYMMDDTHHMMSS`), then the UTC offset (`+1100` in daylight saving, `+1000` otherwise).

- Sorting by name sorts by date. **One exception per year:** on the day daylight saving ends, 2 am happens twice, and the two files list in swapped order (`T020000+1000` before `T020000+1100`). This is deliberate and harmless. The logger's own software sorts by real time.
- A file normally starts on the hour. One starting mid-hour (for example `T211553`) means recording restarted then, so **there is a gap just before it**. Check `events.log` for why.

## Normal behaviour

- Records continuously. Every hour, it closes the current file and starts a new one.
- **Silence does not stop recording.** It alerts after 15 minutes of silence and carries on.
- If the recorder stalls, crashes, or loses the sound card or storage, the supervisor restarts it automatically and alerts. It **never reboots the machine** and never touches broadcast equipment.
- When free space drops below 30 GiB, it deletes the oldest recordings until there is room again. It never deletes anything less than 2 hours old.
- It starts automatically at boot.

## Alerts

All alerts go to the **ntfy** app, on a private topic on ntfy.sh. The topic is `NTFY_URL` in `/etc/rbm-logger.conf` on the logger, and deliberately isn't written in these docs. Subscribe to it in the ntfy app (Android/iPhone) to receive them. Anyone who knows the topic name can read and send to it, so keep it private.

| Alert | Meaning | What to do |
|---|---|---|
| Received audio silent for 15 minutes | Receiver audio below −50 dB | Check the station is on air; check the receiver and its cable to the sound card |
| Received audio returned | Silence ended | Nothing |
| Recorder stalled | Files stopped growing; restarting | Usually fixes itself; a gap of seconds |
| Recording unavailable | Can't record (sound card missing, storage missing) | Check the USB sound card and RAID; `journalctl -u rbm-logger` |
| Recording restored | Back to normal after a fault | Nothing; note the gap |
| RAID DEGRADED / UNKNOWN | A RAID disk failed or vanished | Recording continues on one disk. **Replace the disk promptly.** `cat /proc/mdstat` |
| Disk warning: /dev/sdX (…) | A disk reports trouble before failing: new bad or pending sectors, SMART health failed, a failed self-test, or overheating (from `smartd`) | **Plan to replace that disk soon.** `sudo smartctl -a /dev/sdX` for details. Recording continues; the RAID still has the other disk |
| Storage critically low | Under 30 GiB free and nothing old enough to delete | Free space or add storage now |
| Archive below required retention | Low space forced deletion of recordings newer than 42 days | Add storage; the station may no longer meet its retention obligation |
| RBM logger offline *(from Breeze)* | Breeze RMM lost contact with the machine | Power, network or crash. Check the PC on site |
| RBM download page … / RBM download failed | A problem with the presenters' download page, not the recorder | See [download-page.md](download-page.md#alerts) |

### Offline monitoring depends on a personal server

The logger can't report its own death (power cut, crash, network down). That alert comes from **Breeze RMM**: its agent on the logger sends a heartbeat, and when it stops, Breeze sends a webhook to the ntfy topic.

**That Breeze service runs on a personal server belonging to Kaos, not on station infrastructure.** If that server is down, or Kaos is no longer involved, **nobody is told when the logger goes offline.** All the other alerts still work.

To remove this dependency, set `HEARTBEAT_URL` in `/etc/rbm-logger.conf` to a station-owned check-in monitor such as a Healthchecks.io account. The logger pings it every minute while recording, and the monitor alerts when the pings stop.

## Common tasks

Check it's running and recording:

```bash
ssh logger 'systemctl status rbm-logger --no-pager'
ssh -t logger 'sudo ls -l /mnt/storage/recordings | tail -5; sudo tail -20 /var/lib/rbm-logger/events.log'
```

Restart the logger (gap of a few seconds):

```bash
ssh -t logger 'sudo systemctl restart rbm-logger'
```

RAID health:

```bash
ssh logger 'cat /proc/mdstat'
```

`[UU]` means both disks are fine. `[U_]` or `[_U]` means one disk has failed.

Change settings: edit `/etc/rbm-logger.conf` with `sudo nano`, then restart. The main settings are:

| Setting | Default | Meaning |
|---|---|---|
| `ALSA_CARD_ID` / `ALSA_DEVICE` | `ICUSBAUDIO7D` | Sound card to record from |
| `BITRATE` | `192k` | MP3 bitrate |
| `SILENCE_DB` / `SILENCE_SECONDS` | `-50` / `900` | Silence alert threshold and duration |
| `MIN_FREE_GIB` | `30` | Free space to keep; oldest recordings are deleted below this |
| `REQUIRED_RETENTION_DAYS` | `42` | Minimum archive to keep; alerts if low space eats into it. Check against licence conditions |
| `NTFY_URL` | ntfy topic | Where alerts go |
| `HEARTBEAT_URL` | empty | Optional external check-in monitor |
| `BACKUP_DEST` | empty | rclone destination for off-site backup |
| `STATION_TZ` | `Australia/Sydney` | Time zone for file names |

## The archive

| Period | Source | Notes |
|---|---|---|
| 1 Jan 2026 00:00 → 7 May 2026 01:00 | Old logger (BUTT), portable drive folder `Logs 2026` | 30-minute files, 48 kHz. Imported 6 Nov 2026 |
| 7 May 2026 09:46 → 4 Nov 2026 20:00 | Old logger (BUTT), portable drive folder `LOGS 20260507` | 30-minute files, 48 kHz. Imported 6 Nov 2026. About 8¾ hours missing on the morning of 7 May, between the two folders |
| 4 Nov 2026 19:45 → 5 Nov 21:46 | Streamer (BUTT), split into hourly files | 44.1 kHz. Cut points corrected for the sound card's drift (about 2.5 min per day) |
| 5 Nov 2026 21:35 onward | This logger | 48 kHz. Overlaps the streamer by about 10 minutes |

### Known gaps in the old logger's recordings

Nothing was recorded during these periods (station local time):

| From | To | Length |
|---|---|---|
| 23 Jun 2026 18:00 | 25 Jun 2026 10:15 | ~40 h |
| 15 Aug 2026 14:30 | 16 Aug 2026 12:55 | ~22 h |
| 16 Aug 2026 13:00 | 16 Aug 2026 14:08 | ~1 h |
| 16 Aug 2026 21:30 | 17 Aug 2026 11:10 | ~14 h |
| 18 Aug 2026 06:00 | 24 Aug 2026 18:15 | ~6½ days, partly covered by one long file from 22 Aug 01:34 |

The download page shows these as red hatching. 4 Oct 2026 has no recording between 02:00 and 03:00 because that hour didn't exist (daylight saving began).

On 22–23 June 2026 the old logger ran two copies of BUTT, and one was recording silence. Wherever two files share a start time, the import keeps the one with audio and sets the silent copy aside.

### Older recordings not on the logger

The portable drive (on STUDIOB) also holds 2019, Jan–Apr 2020, a patchy Jul–Dec 2021, 22 Jul–8 Oct 2025 and 9–31 Dec 2025: about 1.1 TB, too much for the logger's RAID. They stay on the drive until the off-site backup exists.

### Importing the old recordings (done 6 Nov 2026)

14,336 files were imported. Both 2 am hours of 5 Apr 2026, the night daylight saving ended, are kept: the old logger named the second one `-1`. 40 silent copies (22–23 Jun) and 14 duplicate copies (16 Aug) were set aside in `/mnt/storage/import/rejected/`; delete that folder when you're happy. The steps, for any future import:

1. Copy from STUDIOB to `/mnt/storage/import` with `~/pull.sh` on the logger (a copy is `rbm-fm-logger/pull_old_logs.sh`). It can be re-run, and skips files already copied.
2. Rename to `RBMFM_` names with `import_old_logs.py /mnt/storage/import` (dry run first, then `--apply`). This also splits over-long files on the hour and sets silent duplicates aside in `import/rejected/`.
3. Move into `recordings/` and set ownership to `rbmlogger`, mode 0640.
4. If a temporary key was used for the copy, remove it from the source machine afterwards (done for STUDIOB, 6 Nov 2026).

Tonight's first logger recordings (5 Nov 20:27–21:35) were replaced by the streamer's copies, which have no reboot gaps. The originals are in `/mnt/storage/replaced/`.

### The streamer as a backup recorder

The streaming PC (CBAASTRM0908, `ssh streamer`) also records the stream with **BUTT**, into `C:\Users\Stream\Music\` as `rec_YYYYMMDD-HHMMSS.mp3`. It splits every 60 minutes, synced to the hour; set on BUTT's main window and saved. These recordings are independent of the logger, so they can fill gaps if the logger fails. (On 6 Nov 2026 BUTT was found recording one 25-hour file despite the hourly setting; the logger's own studio recorder now covers the clean copy, see [studio-recorder.md](studio-recorder.md).)

Its clock is kept in sync with `au.pool.ntp.org` by the Windows Time service (set to start automatically, 6 Nov 2026; before that it wasn't running and the clock could drift). Check it with `w32tm /query /status`. Splitting long BUTT files into the archive uses `split_butt_recordings.py` (in the logger package). The BUTT recordings are of the **stream**, not of what went to air, so they miss transmitter or RF faults.

## Weekly summary

Every **Monday at 09:00** the logger sends **"RBM weekly: all good"** to the ntfy topic, or **"RBM weekly: needs attention (…)"** saying what's wrong. It covers:

- the last 7 days: hours recorded, the longest gaps, recorder restarts, silences, and old-file cleanups;
- RAID state, each disk's health (bad sectors, temperature, age), free space, and how far back the archive goes;
- the download page and its certificate;
- whether security updates are waiting for a reboot;
- the age of the nightly [settings backup](rebuild-logger.md#settings-backup).

**If the Monday message doesn't arrive, treat that as an alert:** the logger, its internet connection, or ntfy isn't working. Run it by hand with `sudo systemctl start rbm-weekly`. It's `rbm_weekly.py`, run by `rbm-weekly.timer`.

## Disk health

`smartd` (smartmontools) watches every disk's own health data. It runs a **short self-test daily at 02:00** and a **long one on Sundays at 03:00**. It sends an urgent "disk warning" to ntfy when a disk:

- reports new reallocated, pending or uncorrectable sectors;
- fails a self-test, or fails its overall health check;
- passes 55°C.

These usually show up weeks before a disk drops out of the RAID, which is the time to buy a replacement. The weekly summary lists each disk's health, temperature and age.

The disks (checked 6 Nov 2026):

| Disk | Model | Role |
|---|---|---|
| SSD, 240 GB | Crucial BX500 (CT240BX500SSD1) | Debian system, `/boot/efi`, swap. **Not mirrored**: if it fails, recording stops until it's replaced and the system rebuilt ([rebuild-logger.md](rebuild-logger.md)). The recordings on the RAID are safe |
| HDD, 1 TB | WD Purple (WD11PURZ), serial **WD-WXB2D36MFRLP** | RAID1 member |
| HDD, 1 TB | WD Purple (WD11PURZ), serial **WD-WXB2D36MFL2R** | RAID1 member |

It's worth writing each serial on a label stuck to the visible end of its drive, so you can tell them apart without unplugging anything.

**The names `sda`, `sdb` and `sdc` can swap between reboots,** so identify a disk by the model and serial number in the alert, not by its letter. Before pulling a failed RAID disk, match its serial number with `sudo smartctl -i /dev/sdX` or `lsblk -o NAME,MODEL,SERIAL`.

```bash
ssh -t logger 'lsblk -o NAME,SIZE,MODEL,SERIAL; for d in /dev/sd?; do sudo smartctl -H -A $d; done'
```

## Replacing a failed RAID disk

### What happens when a disk dies

1. Usually you get a **"disk warning"** first (bad sectors, failed self-test). The RAID is still whole, but that disk is on its way out. **Order a replacement now.**
2. When the disk actually drops out, you get **"RBM RAID DEGRADED"** (urgent).
3. **Recording carries on** using the remaining disk. Nothing is lost, and the download page keeps working. But there's **no safety net** until the disk is replaced, so do it within days, not weeks.
4. The weekly summary shows `[U_]` or `[_U]` and "needs attention" until it's fixed.

If both disks fail, recording stops with a "recording unavailable" alert, and the recordings are gone except for whatever was backed up off-site.

### What to buy

A 3.5" SATA hard drive of **at least 1 TB**: the same WD Purple (WD11PURZ), or any 1–4 TB **CMR** drive such as WD Purple, WD Red Plus or Seagate IronWolf. Avoid **SMR** drives (most cheap "desktop" drives, and WD Red without "Plus"), which are slow to rebuild. A bigger disk works, but only 1 TB of it is used until both disks are bigger.

### Steps

Take about 20 minutes of work, then the RAID rebuilds by itself for **2–3 hours**. Recording stops only while the PC is switched off (about 5 minutes); pick a quiet time.

1. **Find out which disk failed,** by serial number:
   ```bash
   ssh -t logger 'cat /proc/mdstat; sudo mdadm --detail /dev/md0; lsblk -o NAME,SIZE,MODEL,SERIAL'
   ```
   The healthy member is listed as `active sync` with its `/dev/sdX1`. The failed one is shown as `faulty`, or missing. Note the **failed disk's serial**: it's the 1 TB WD whose serial isn't the healthy one's.
2. **If the failing disk is still in the array** (you only got a disk warning), take it out first. `sdX` is the failing disk *as it's named right now*:
   ```bash
   ssh -t logger 'sudo mdadm /dev/md0 --fail /dev/sdX1 --remove /dev/sdX1'
   ```
3. **Shut down:** `ssh -t logger 'sudo poweroff'`. Expect a Breeze "offline" alert and recorder alerts; that's normal.
4. **Swap the disk.** Unplug the drive **with the failed serial** and connect the new one with the same cables. Check the serial on the label before you pull it.
5. **Power on.** The logger boots from the SSD. The RAID starts on its one good disk (this takes about 30 seconds longer than usual), and recording resumes.
6. **Find the new disk's name.** It's the 1 TB+ disk with no partitions:
   ```bash
   ssh -t logger 'lsblk -o NAME,SIZE,MODEL,SERIAL'
   ```
   Below, `GOOD` is the surviving RAID disk and `NEW` is the new one, for example `sdb` and `sdc`. **Double-check them: getting these backwards destroys the good disk.**
7. **Copy the partition layout from the good disk to the new one, and give it its own IDs:**
   ```bash
   ssh -t logger 'sudo sgdisk --replicate=/dev/NEW /dev/GOOD && sudo sgdisk --randomize-guids /dev/NEW && lsblk /dev/NEW'
   ```
   (`sgdisk` is in the `gdisk` package: `sudo apt install gdisk`.) Note the order: the target, `NEW`, comes first in `--replicate=`.
8. **Add it to the RAID.** The rebuild starts immediately:
   ```bash
   ssh -t logger 'sudo mdadm /dev/md0 --add /dev/NEW1 && cat /proc/mdstat'
   ```
9. **Watch the rebuild** (`cat /proc/mdstat` shows a percentage). Recording continues meanwhile. When it reaches `[UU]`, you get **"RBM RAID recovered"**.
10. **Check the new disk** is being monitored and is healthy: `sudo smartctl -H -i /dev/NEW`. Update the serials in the table above, and label the new drive.

No other configuration changes are needed. The RAID and the recordings are found by their IDs, not by disk letters.

### If the logger won't boot after a disk failure

Since 6 Nov 2026, `/etc/fstab` mounts the RAID with `nofail,x-systemd.device-timeout=60`. If the array can't start at all (both disks gone, or a cable problem), the logger waits up to a minute, then **finishes booting without it**. It stays reachable over SSH and Breeze, and the recorder sends "recording unavailable" rather than recording onto the system SSD. The previous fstab is saved as `/etc/fstab.bak-20261106`.

## Security updates

Debian security updates install automatically every day (`unattended-upgrades`). **The logger never reboots by itself.** When an update needs a reboot (usually a kernel update), the weekly summary says so. Reboot at a quiet time: recording stops for about a minute and the gap is logged.

```bash
ssh -t logger 'sudo reboot'
```

**Caddy, the download page's web server, is not covered.** It's a separate official build (see [download-page.md](download-page.md#certificates)). Update it by re-running `web/caddy-dns-setup.sh` every few months, or when Caddy announces a security fix.

## Updating the logger software

Copy the `rbm-fm-logger/` folder to the logger and run `sudo ./update-logger.sh`. It installs the scripts, the weekly summary and the automatic-update settings, and restarts the recorder only if its code changed (a gap of a few seconds). The config in `/etc/rbm-logger.conf` is kept.

## Off-site backup

**Not set up yet.** Planned: copy recordings to the Radio Blue Mountains SharePoint with rclone, with old files there deleted automatically. The backup timer (`rbm-backup.timer`) is installed but disabled until then.

## Known limitations

- **Single receiver and sound card.** If the receiver drifts off frequency or the antenna fails, the logger faithfully records noise or silence. The silence alert catches silence, but not noise.
- **Clock:** file names rely on the logger's clock, kept in sync over the internet. If it has no internet at boot, the first names may be wrong until it syncs.
- **Gaps on restart:** each restart or reboot leaves a gap of seconds to about a minute, visible as a file starting mid-hour.
- **Hourly files sometimes open a moment before the hour,** because the sound card's clock runs slightly fast. Since 6 Nov 2026 the supervisor renames such a file to the hour (`T215959` → `T220000`, logged as `SEGMENT_RENAMED`). It only does this for files within 5 seconds of the hour, and never for the first file after a restart.
- **The download page runs on the logger.** It's sandboxed and runs at low priority so it can't disturb recording (see [download-page.md](download-page.md#protecting-the-recorder)), but a hardware failure of the logger takes both down.

## Known risks and open items

The setup records, recovers by itself, alerts, and is documented. These are the gaps that remain, most important first. Review this list when anything changes.

### 1. No off-site backup

**Most important.** The RAID protects against **one disk** failing. It doesn't protect against fire, theft, flood, a surge that kills both disks, accidental deletion, or the logger being compromised through the download page.

- Everything since 4 Nov 2026 exists **only on the logger**.
- 1 Jan–4 Nov 2026 exists on the logger and on **one portable drive** attached to STUDIOB, and 2019–2025 only on that drive.

**Plan:** rclone to the RBM SharePoint once there's access, with automatic deletion of old files there (see [Off-site backup](#off-site-backup)). **Until then,** copying `/mnt/storage/recordings` to a USB drive kept off-site every week or two would cover most of the risk.

### 2. Single points of failure

- **The system SSD isn't mirrored.** Only the recordings are on the RAID. If the SSD fails, the logger has to be reinstalled: about 2–3 hours with recording off, following [rebuild-logger.md](rebuild-logger.md). The settings are copied onto the RAID every night, so it comes back exactly as it was, with the same presenter password.
- **One logger PC, one FM receiver, one USB sound card.** If any of them fails, recording stops until it's fixed on site. The streamer's BUTT recordings are a partial fallback, but they capture the **stream**, not the off-air signal, so they miss transmitter and RF problems.
- **The receiver can record noise.** If it drifts off frequency or the antenna fails, the silence alert won't fire for hiss or a neighbouring station.
- **The UPS isn't monitored.** The logger and tuner are on a UPS, but nothing tells the logger when it's on battery. In a long outage the battery runs flat and the logger loses power abruptly. That's usually harmless (the RAID resyncs), but shutting down cleanly would be better. Most UPSs with a USB port can be connected with `nut` or `apcupsd`.
- **The download page runs on the logger,** so a logger failure takes both down.

### 3. It depends on one person

These belong to Kaos personally, not to the station. Move them before Kaos steps back, or if Kaos becomes unavailable:

| What | Depends on | Station-owned alternative |
|---|---|---|
| "Logger offline" alert | Breeze RMM on Kaos's personal server | A station Healthchecks.io account in `HEARTBEAT_URL` (see [Offline monitoring](#offline-monitoring-depends-on-a-personal-server)) |
| Download page address | `rbm.kaos.zone`, Kaos's domain | `logs.rbm.org.au` (see [download-page.md](download-page.md#moving-to-rbmorgau)) |
| HTTPS certificates | A Cloudflare API token from Kaos's account | A token from RBM's Cloudflare account |
| Admin access | Kaos's SSH key and the `logger` account's sudo password | A second admin key, and the password in the station's password manager |
| Alerts | A public ntfy.sh topic, free and with no guarantee | Keep, but make sure several people subscribe |
| Download traffic | Cloudflare's free proxy on Kaos's account | RBM's Cloudflare account, when the page moves to `logs.rbm.org.au` |

### 4. Alerts and recovery that have never fired for real

| What | Tested? |
|---|---|
| Reboot and power-up recovery, sound-card detection, ntfy delivery, Breeze offline alert | **Yes,** for real (5 Nov 2026) |
| Download page health checks, lockout alert, joining across gaps and sample rates | Yes |
| RAID-degraded alert | **No.** The logic was reviewed, but a disk has never failed. Don't test by pulling a disk |
| Disk health (SMART) warning | The alert path was tested with a simulated warning on 6 Nov 2026. A real disk fault hasn't happened |
| Low disk space and deletion of old recordings | Only in a simulation |
| Certificate renewal through Cloudflare DNS | **Not yet;** the first renewal is due about 60 days after 5 Nov 2026. The health check warns 14 days before expiry if it fails |
| Sound-card unplug while recording, silence alert | Not tested on site. Worth doing once at a quiet time |

### 5. Other open items

- **Older archives (2019–2025)** exist only on one portable drive. They need to go somewhere safe once the off-site backup exists.
- **Shared presenter password,** so the download page can't tell who listened to or downloaded what. Fine for now. Individual logins would be needed if there's ever a reason to audit access.
- **Listening and downloads go through Cloudflare's proxy,** because the ISP blocks 80 and 443 and the origin rule gives a clean address. That depends on Cloudflare's free plan and terms. The alternative, going direct with `:8443` in the address, is in [download-page.md](download-page.md#network-and-certificates).
- **The Caddy build needs manual updates** (see [Security updates](#security-updates)).
- **Archive capacity:** about 13–14 months of audio fits on the RAID. After that the oldest is deleted automatically. With off-site backup, older audio would survive there.
