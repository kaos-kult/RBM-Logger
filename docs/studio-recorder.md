# Studio recorder (Dante)

Alongside the FM off-air recording, the logger records **Studio-A's programme output straight off the Dante network**. That's the clean copy: what left the desk, before the link to the transmitter, the FM processing and the radio path. Presenters download it for podcasts. The off-air recording stays the station's record of what actually went to air.

Why both: on 6 Nov 2026 the IP codec link to the transmitter was cutting out (121 hard mutes in 2 minutes during Biig BoyZ). The off-air logger recorded those dropouts faithfully, and BUTT's stream copy proved the studio output itself was clean.

| | |
|---|---|
| Source | `Program-L` / `Program-R` @ `Studio-A` (AEQ Forum, 10.1.2.74), Dante, 48 kHz |
| Logger's Dante name | **RBM-Logger** (2 receive channels, 10.1.2.198) |
| Recording | MP3, 192 kbps, 48 kHz stereo, one file per clock hour |
| Files | `/mnt/storage/studio/RBMSTUDIO_YYYYMMDDTHHMMSS+HHMM.mp3` (same naming as `RBMFM_`) |
| Services | `rbm-ptp` (Dante clock), `rbm-studio` (recorder) |
| Software | `/usr/local/lib/rbm-dante/` (Statime, Inferno2pipe), `/usr/local/lib/rbm-logger/rbm_studio.py` |
| Config | `/etc/rbm-dante/statime.toml`, and settings in `/etc/rbm-logger.conf` |
| Install/update | `sudo ./install-studio.sh` in `rbm-fm-logger/` |

## How it works

```
Studio-A ──Dante multicast──> Inferno2pipe ──raw audio──> rbm_studio.py ──> ffmpeg ──> hourly MP3
              PTPv1 clock ──> Statime (virtual clock) ──/run/rbm-dante/usrvclock──┘
```

- **[Inferno](https://github.com/teodly/inferno)** is an unofficial, open-source implementation of the Dante protocol. `inferno2pipe` shows up on the network as an ordinary Dante receiver, `RBM-Logger`, and writes what it receives as raw 32-bit samples. It's alpha software ("not for serious purposes", says its author), which is why the off-air recording stays independent of it.
- **[Statime](https://github.com/teodly/statime/tree/inferno-dev)** (Inferno's fork) follows the Dante PTPv1 clock. It keeps a **virtual clock** and never changes the logger's real clock, which names the FM recordings. It hands the clock to Inferno over a Unix socket in `/run/rbm-dante`.
- **`rbm_studio.py`** cuts the audio into files on each station-local clock hour. The Dante clock and the logger's clock drift apart by a fraction of a second an hour; each hourly split snaps back to the exact hour, so that never builds up.
- **Dropouts:** up to 2 seconds without audio is filled with silence, so the file stays on the clock (`STUDIO_GAP_SECONDS`). A longer outage ends the file, and a new one starts when audio comes back. The studio copy then has an honest hole, which the download page fills from the off-air recording, instead of minutes of fake silence.
- **Restarts and alerts:** if no audio arrives for 30 seconds, Inferno is restarted. After 2 minutes without audio, an ntfy alert ("RBM studio recording has no audio"), and another when it's back.
- **Routing:** the subscription (Program-L → RBM-Logger 1, Program-R → 2) is stored by Inferno in `/var/lib/rbm-logger/.local/state/inferno_aoip/` and restored after restarts. It can also be seen and changed in Dante Controller like any other device.
- **Levels:** the studio copy is the unprocessed desk output, about −27 LUFS, against about −10 LUFS for the processed FM. It's kept that way; presenters can raise it when making a podcast.

The FM off-air recorder (`rbm-logger`) doesn't depend on any of this. If the Dante side fails completely, FM recording carries on.

## On the download page

A **STUDIO / OFF-AIR** switch sits under the timeline, remembered per device. STUDIO is the default.

- **STUDIO:** the studio copy, with any holes filled from the off-air recording. Those stretches are **blue** on the timeline, the page says how much of a selection is off-air, and the off-air parts play and download **16 dB quieter** to roughly match the studio level (`WEB_OFFAIR_GAIN_DB` in `/etc/rbm-web.conf`). A download that mixes the two is re-encoded and named `…_PARTLY-OFFAIR.mp3`; with no studio copy at all it's just the off-air recording, named `RBMFM_…`. Everything before 6 Nov 2026 23:41 is off-air only.
- **OFF-AIR:** only what the FM receiver heard, gaps and faults included. Use this for complaints, ACMA, or checking what went to air.

## Retention

One cleaner (in `rbm_logger.py`) handles both folders, so they can't fight over the disk. Settings in `/etc/rbm-logger.conf`:

| Setting | Default | Meaning |
|---|---|---|
| `FM_KEEP_DAYS` | 0 | Delete off-air recordings older than this (0 = no limit) |
| `STUDIO_KEEP_DAYS` | 0 | Delete studio recordings older than this (0 = no limit) |
| `REQUIRED_RETENTION_DAYS` | 42 | Off-air recordings this new are deleted for space only as a last resort, with an urgent alert |
| `STUDIO_MIN_DAYS` | 0 | Same, for the studio copy |

With the limits at 0, nothing is deleted until free space drops below `MIN_FREE_GIB` (30 GiB); then the oldest recordings of either kind go first. Both sources together use about 4 GB a day: with 288 GB free on 6 Nov 2026, that's roughly 2 months before the oldest recordings (Jan 2026 off-air) start going.

**Still to decide:** how long to keep each. A suggestion: studio copy 1 year (what presenters want), off-air 90 days (the legal requirement is short: check the current Broadcasting Services Act and community licence conditions; it has been 6 weeks, or 60 days after a complaint). A year of studio plus 90 days of off-air is about 940 GB, which only just fits on the 1 TB RAID, so a lower studio bitrate (`STUDIO_BITRATE=160k`) or bigger disks would give headroom. Changing `FM_KEEP_DAYS` deletes old recordings straight away: copy anything worth keeping first.

## Common tasks

```bash
systemctl status rbm-ptp rbm-studio
journalctl -u rbm-studio -f                    # what the recorder is doing
journalctl -u rbm-ptp -n 30                     # the Dante clock
ls -lt /mnt/storage/studio | head               # newest studio files
~/netaudio-venv/bin/netaudio device list        # Dante devices, from the logger
~/netaudio-venv/bin/netaudio subscription list
```

The logger user is in the `rbmlogger` and `systemd-journal` groups, so it can read the recordings and the logs without sudo.

**Re-route the subscription** (if RBM-Logger lost it, or to record a different source), from the logger or in Dante Controller:

```bash
~/netaudio-venv/bin/netaudio subscription add --tx "Program-L@Studio-A" --rx "1@RBM-Logger"
~/netaudio-venv/bin/netaudio subscription add --tx "Program-R@Studio-A" --rx "2@RBM-Logger"
```

**Update Inferno or Statime:** as the logger user, `git -C ~/src/inferno pull --recurse-submodules` (and the same for `~/src/statime`), rebuild with `cargo build --release` in `~/src/inferno/inferno2pipe` and `~/src/statime`, then `sudo ./install-studio.sh`. Test a new version for a while before trusting it; the old binaries are replaced.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `can't subscribe, clock not ready` in `journalctl -u rbm-studio` | Inferno isn't getting the clock. Check `rbm-ptp` is running and `/run/rbm-dante/usrvclock` exists. (Fixed on install day: the two services need the shared `/run/rbm-dante` folder, and `rbm-ptp` needs `CAP_DAC_OVERRIDE` to answer the recorder's private socket.) |
| `GUARD: detected abrupt change … delaying send` in `journalctl -u rbm-ptp` | Statime holding back a clock jump of over 1 ms; it sends it anyway after 5 seconds. Harmless unless the recorder keeps saying "clock not ready". |
| `got DelayReq, master operation not implemented yet` | Other Dante devices asking for the clock leader; Statime only follows. Harmless. |
| `Address already in use` from Inferno | A second copy is running (for example a test started by hand): `pgrep -a inferno2pipe`. |
| No `RBMSTUDIO_` files for a stretch | Dante audio stopped. The alert says so; FM covers the gap on the download page. |
| `Lost … samples (reorder buffer timeout)` | Normal for a moment when a subscription starts. Repeated, it means packet loss on the Dante network. |

## Fallback: BUTT on the streamer

BUTT on the streamer (CBAASTRM0908) also records the stream, in `C:\Users\Stream\Music\`. It doesn't reliably split hourly: on 6 Nov 2026 it ran one 25-hour file despite the setting being saved. If someone needs a clean copy from a time the studio recorder missed, cut it out of the BUTT file by hand (`split_butt_recordings.py` in the logger package, or ffmpeg). BUTT's recordings are of the stream, which leaves the studio before the transmitter link, so they're clean of link faults too.
