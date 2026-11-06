# RBM Logger

Off-air logger for Radio Blue Mountains: records what the station puts to air, 24/7, onto a mirrored RAID on a Debian PC, records a clean copy of Studio-A's output straight off the Dante network, alerts when anything goes wrong, and serves a password-protected page where presenters can listen to or download any time range.

Repository: https://github.com/kaos-kult/RBM-Logger

## Documentation

| Document | For |
|---|---|
| [docs/fm-logger.md](docs/fm-logger.md) | The logger: recording, file names, alerts, archive, disk health, updates, known risks |
| [docs/studio-recorder.md](docs/studio-recorder.md) | The studio (Dante) recorder: the clean copy presenters download, Inferno and Statime, retention of both sources |
| [docs/download-page.md](docs/download-page.md) | The presenters' listen/download page: use, security, alerts, certificates, moving to rbm.org.au |
| [docs/ssh-access.md](docs/ssh-access.md) | Remote access to station machines through the logger, and router port forwards |
| [docs/rebuild-logger.md](docs/rebuild-logger.md) | Rebuilding the logger after a system SSD failure |

## Layout

- `rbm-fm-logger/`: the recorder and its tools, all Python standard library plus ffmpeg.
  - Install: `install.sh`, then `update-logger.sh`.
  - Recorder and supervisor: `rbm_logger.py` (also the cleaner for both sources).
  - Studio (Dante) recorder: `rbm_studio.py`, `rbm-studio.service`, `rbm-ptp.service`, `statime.toml`; install with `install-studio.sh`.
  - Weekly summary: `rbm_weekly.py`. Disk health: `smart_report.py`, `smart_alert.sh`.
  - Nightly settings backup: `rbm_config_backup.sh`. Optional off-site backup: `rbm_backup.py`.
  - Archive import tools: `reclassify_studio_archive.py` (one-off, 7 Nov 2026: pre-logger recordings into the studio copy), `import_old_logs.py`, `split_butt_recordings.py` (also into the studio copy, `--prefix RBMSTUDIO`), `butt_align.py` (checks BUTT timing against FM), `rename_utc_recordings.py`, `pull_old_logs.sh`.
- `rbm-fm-logger/web/`: the download page.
  - Service: `rbm_web.py`. Health check: `rbm_web_check.py`. Front end: `static/`.
  - Install: `install-web.sh`, `caddy-dns-setup.sh`.

No secrets are kept in this repository. Passwords, API tokens and the alert topic live only in `/etc/rbm-logger.conf`, `/etc/rbm-web.conf` and `/etc/caddy/cloudflare.env` on the logger, and in its nightly settings backup.

## On the logger

A working copy lives in `~/rbm-fm-logger` on the logger, with the docs in `~/rbm-fm-logger/docs/`, and a copy of the docs on the RAID in `/mnt/storage/system-backup/docs/`. To update from this repository:

```bash
git clone https://github.com/kaos-kult/RBM-Logger.git   # or: git pull, in an existing clone
```
