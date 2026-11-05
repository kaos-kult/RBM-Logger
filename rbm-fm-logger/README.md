> **Source and current documentation: https://github.com/kaos-kult/RBM-Logger.** On the logger, the docs are in `docs/` next to this file (`fm-logger.md`, `download-page.md`, `ssh-access.md`, `rebuild-logger.md`). This README describes the original install and is partly out of date: files are now named in local time (`RBMFM_…`), not UTC.

# Radio Blue Mountains FM off-air logger for Debian (headless)

## Before installation

Designed for a *data-only* 2 × 1 TB mdadm RAID1 mounted at `/mnt/storage`.
The installer does **not** partition or format disks. The supervisor verifies the mounted filesystem is actually on `/dev/md0`,
and will not record to the boot/root filesystem or a substitute filesystem.

Check:

```sh
lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS
findmnt /mnt/storage
cat /proc/mdstat
cat /proc/asound/cards
arecord -l
arecord -L | grep -A4 -B1 -i usb
```

Find the identifier in square brackets in `/proc/asound/cards`, e.g.:

```
 2 [Device         ]: USB-Audio - USB PnP Sound Device
```

Then set `ALSA_CARD_ID=Device` and `ALSA_DEVICE=plughw:CARD=Device,DEV=0`.
*Do not rely on* `hw:2`: USB audio card indexes can change after a reboot.

**Test audio capture first.** With the example ID:

```sh
arecord -D plughw:CARD=Device,DEV=0 -f S16_LE -c 2 -r 48000 -d 10 /tmp/line-test.wav
ffmpeg -hide_banner -i /tmp/line-test.wav -af volumedetect -f null -
```

Listen to `/tmp/line-test.wav` on another device if the Debian box is headless.
Use `alsamixer -c 2` (replace 2 with the current card number), then F4
for Capture controls and select/enable Line rather than Microphone if supported.
Some extremely cheap USB dongles only have mono microphone inputs, **not true
line-level stereo capture**. Check the actual hardware and clipping level.
If the device only works with one capture channel, set `INPUT_CHANNELS=1`.

Check time sync: `timedatectl status` should indicate the system clock is
synchronised. Files are named in station local time with the UTC offset, so
the repeated hour when daylight saving ends is still unambiguous.

## Install

Extract the ZIP, `cd` into its `rbm-fm-logger` directory, then:

```sh
sudo ./install.sh
sudo nano /etc/rbm-logger.conf
sudo systemctl start rbm-logger
sudo systemctl status rbm-logger
sudo journalctl -u rbm-logger -f
```

The installer fills in `RAID_FS_UUID=` from `findmnt -no UUID /mnt/storage`, so the
check survives the array being renamed (e.g. `md0` -> `md127`) and works through
LVM/LUKS. The md array used for health checks is found automatically. Also pin the
array name so it is stable at boot:

```bash
sudo mdadm --detail --scan | sudo tee -a /etc/mdadm/mdadm.conf
sudo update-initramfs -u
```

The installer uses APT, creates an unprivileged `rbmlogger` account (with access
to the `audio` group), creates `/mnt/storage/recordings` and
`/var/lib/rbm-logger`, installs a hardened systemd service, and enables
startup on boot. It does **not** reboot or touch the broadcasting infrastructure.
It does **not** start the recorder until you edit the configuration and start it.

If you edit `/etc/rbm-logger.conf` later, run:

```sh
sudo systemctl restart rbm-logger
```

## Audio and files

Captures ALSA directly with FFmpeg, encodes at 192 kbps MP3, and uses the
FFmpeg segment muxer with `segment_atclocktime=1` and `strftime=1`.
Output: `/mnt/storage/recordings/RBMFM_20261105T210000+1100.mp3`
(`RBMFM_` + ISO 8601 basic local date/time + UTC offset; `STATION_TZ`, default
`Australia/Sydney`). Sorting by name sorts by date, except once a year: the two
files for 2 am on the day daylight saving ends (`T020000+1100`, then
`T020000+1000`) list in swapped order. The logger's own cleanup sorts by real
time, so this is cosmetic.

Segments are aligned to each *local clock hour*. On an initial startup halfway
through an hour, the first file is a short partial hour. An outage and restart
similarly result in a new partial-hour recording so **gaps are visible**.
Normally, one playable MP3 closes on the hour and a new one opens.

The current file remains accessible while being written, but copy only closed
files to offsite backup to avoid copying partially written files.

## Storage management

Once every minute, if available filesystem space falls below 30 GiB
(`MIN_FREE_GIB=30`), deletes the oldest `RBMFM_*.mp3` files (by real start time) until
there is enough free space. It skips any file modified within the previous
2 hours (protecting the active recording and recently completed ones), and
ignores all other files. If there is nothing safe to delete, it alerts. If it
has to delete a recording newer than `REQUIRED_RETENTION_DAYS` (default 42),
it logs `RETENTION_FLOOR_BREACHED` and sends one urgent alert, because the
archive no longer covers the required period.

`df -h /mnt/storage` shows filesystem consumption. On an ext4 filesystem
with default reserved blocks, more than 30 GiB of physical free space can
remain. This is an intentional safety reserve, not a malfunction.

If the expected RAID block device is missing, unmounted, or replaced by
a different filesystem at the same path, recording stops rather than filling
the OS partition or another disk. The monitor continues checking and attempts to start once the
RAID is available again.

## Failure monitoring and event log

- FFmpeg exits: supervisor logs and attempts to reopen after 10 seconds.
- USB disappears: FFmpeg is stopped; recording resumes when the same ALSA ID returns.
- USB remains absent / no recording after 60 seconds: send a push alert.
- New MP3 file/size stops changing for 90 seconds: alert (rate-limited) and restart FFmpeg.
- Input remains below -50 dB for 900 seconds: **alert only**. The original
  audio stream is still recorded; no audio is muted, altered, or discarded.
- Silence ends: log and push recovery.
- RAID `md/degraded` (auto-detected under the mount) changes state: alert immediately on the
  next check (up to 60s). A degraded RAID can still record normally.
- Offsite backup failure: optional timer; alerts after 3 failures in a row.
- Whole host offline: an **external** watcher must detect absent heartbeat.

Persistent event log: `/var/lib/rbm-logger/events.log` (not stored on the RAID).
There is also `journalctl -u rbm-logger`, but persistent journald itself is
configuration-dependent. Logrotate retains up to ten years of compressed event logs.

**Limitations:** A typical USB FM receiver capture cannot distinguish station
silence, an RF reception outage, an FM tuner fault, or muted/disconnected
analogue cables. The threshold is configurable and should be tested under
actual RF reception conditions. It also cannot distinguish distorted audio
from good audio merely by observing file size.

The file-growth monitor observes actual output size, not merely that FFmpeg
still has a live PID. Gaps in log are approximate by wall clock and should
be interpreted using both timestamps and audio files.

## Push notifications to Android (ntfy)

Install the ntfy app and subscribe to a long, unguessable topic.
Example *format only* (choose your own unique value):

```ini
NTFY_URL=https://ntfy.sh/rbm-fm-logger-long-random-private-topic
```

For a secured self-hosted ntfy server, also set `NTFY_TOKEN=`. Test:

```sh
curl -d 'Radio Blue Mountains logger test' \
  'https://ntfy.sh/your-unguessable-topic'
```

**Security:** Public ntfy topics are discoverable if someone guesses the name.
Use a long random identifier or a server with authentication. Push failures are
logged locally but do not stop recording. Where network is down, a notification
cannot be delivered until the network works; alerts are not durable-queued.

## Whole-computer offline monitoring

Create an external check at a service such as Healthchecks.io or a separate
Uptime Kuma instance. The recorder only pings if a recording file has grown
recently. Configure check period ≈2 minutes with grace ≈3–5 minutes, and put
its HTTPS URL into `HEARTBEAT_URL`:

```ini
HEARTBEAT_URL=https://hc-ping.com/<your-private-check-uuid>
```

If the machine loses power, storage, network, or the logger can't write,
those pings stop and the *external* service alerts you. If its own network
is lost, the watcher cannot distinguish that from a dead computer.

## Optional independent offsite backups

Backups are *not* configured without a destination. Set up a rclone remote
and test it first. The backup runs as `rbmlogger`, using its own rclone config
under `/var/lib/rbm-logger/.config/rclone/rclone.conf`, for example:

```sh
sudo apt install rclone
sudo -u rbmlogger -H rclone config
sudo -u rbmlogger -H rclone lsd yourremote:
```

Edit `/etc/rbm-logger.conf`, e.g.:

```ini
BACKUP_DEST=yourremote:rbm-archive/recordings
```

Start the optional timer (every six hours):

```sh
sudo systemctl enable --now rbm-backup.timer
sudo systemctl start rbm-backup.service
sudo journalctl -u rbm-backup.service -n 100
```

The timer uses **`rclone copy`**, not sync/move. It copies only completed
logger MP3s older than 2 hours; it does **not** delete remote files when
old local files are purged. It retries transfers internally and, after 3
consecutive failed timer runs, sends an alert through ntfy. The persistent
backup status is stored at `/var/lib/rbm-logger/backup-state.json`.

**Important:** The logger prioritises continuous recording. If disks reach
capacity during a backup outage, old local recordings can be deleted before
backup succeeds. Remote backup capacity and retention must be planned
separately; this configuration is not a guaranteed indefinite cloud archive.

## Checks and fault drills

```sh
systemctl status rbm-logger
sudo journalctl -u rbm-logger -n 100 --no-pager
sudo tail -100 /var/lib/rbm-logger/events.log
cat /proc/mdstat
sudo mdadm --detail /dev/md0
df -h /mnt/storage
ls -lh /mnt/storage/recordings | tail
```

Test after hours with a maintainer present:

1. Leave the FM receiver on, temporarily unplug the USB **sound card**
   (not the transmitter or anything in the on-air chain). Expect a recording
   unavailable alert after one minute, then automatic recovery on reconnect.
2. Stop FFmpeg only (find its child PID; `sudo pkill -INT -x ffmpeg` if no
   other FFmpeg jobs exist). Expect automatic restart and an event log entry.
3. Feed digital silence or adjust `SILENCE_SECONDS=15` temporarily to test
   an actual silent analogue input; **do not change broadcast levels**.
4. Temporarily stop the logger `sudo systemctl stop rbm-logger`; external
   heartbeat watcher should notify you. Restart afterwards.
5. RAID degraded alert test should be done with controlled simulation/code
   test, **not by pulling a disk from a working RAID**.

Avoid rebooting or changing audio sources as an automatic recovery action.
