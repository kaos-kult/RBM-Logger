# Rebuilding the logger after a system SSD failure

Use this when the logger's **system SSD** has died or been replaced and Debian has to be reinstalled. The recordings are on the RAID (two separate disks) and survive. So do the logger's settings: they're copied onto the RAID every night at 03:30 (see [Settings backup](#settings-backup)).

**Expect 2–3 hours, mostly waiting. Recording is off for all of it.** Steps 1–3 need someone at the station with a screen, keyboard and USB stick. From step 4 it can all be done remotely.

For a failed **RAID** disk instead, see [fm-logger.md → Replacing a failed RAID disk](fm-logger.md#replacing-a-failed-raid-disk).

## What you need

- A replacement SSD, 120 GB or more (the old one was a 240 GB Crucial BX500).
- A USB stick with the **Debian 13 "trixie" amd64 netinst** image (debian.org → Download).
- A screen and USB keyboard for the logger.
- This project (**https://github.com/kaos-kult/RBM-Logger**, with `rbm-fm-logger/` and `docs/`) on a laptop, and the admin SSH key. Copies of these docs also live on the logger (`~/rbm-fm-logger/docs/`, gone with the SSD) and on the RAID (`/mnt/storage/system-backup/docs/`, root only, refreshed nightly). The RAID copy can be read from any Linux machine the RAID disks are plugged into. **Keep a copy off the logger too,** for example printed, or in the station's shared files.

## 1. Fit the SSD and install Debian

1. Power off, swap the SSD, and **leave both RAID disks connected**.
2. Boot from the USB stick and run the installer with these choices:
   - Hostname **`Logger-PC`**, no domain.
   - Leave the root password empty (this gives the user sudo). Create user **`logger`**, with the password from the station's password manager.
   - **Partitioning: "Guided – use entire disk" on the SSD only.** Check the disk's size and model (about 240 GB) before confirming. **Don't touch the two 1 TB disks**, which hold the RAID with the recordings.
   - Software: deselect any desktop environment. Select only **SSH server** and **standard system utilities**.
3. Reboot into the new system, remove the USB stick, and log in as `logger` on the screen.

## 2. Get the network and SSH working

The router gives the logger its address by DHCP reservation (10.1.2.198) on its network port, so nothing needs setting up. Check with `ip -br addr`.

For a moment, password logins over SSH are allowed (Debian's default). From the admin laptop, on the station network or over the router's port 2222:

```bash
ssh-keygen -R '[STATION-PUBLIC-IP]:2222'   # the address in your ~/.ssh/config for logger
ssh-copy-id -i ~/.ssh/psychic_paper.pub logger
```

The first line clears the old system's identity from your laptop. You won't need it again once the old host keys are restored in step 5.

## 3. Reattach the RAID and find the backup

```bash
sudo apt install -y mdadm
sudo mdadm --assemble --scan
cat /proc/mdstat
```

`md0` should show `[UU]`. Then mount it **read-only** for now and find the newest settings backup:

```bash
sudo mkdir -p /mnt/storage && sudo mount -o ro /dev/md0 /mnt/storage
sudo ls -l /mnt/storage/system-backup/
```

If there's no `system-backup` folder, or it's empty, skip step 5 and set things up from scratch with the install docs ([fm-logger.md](fm-logger.md), [download-page.md](download-page.md)): choose a new presenter password, create a new Cloudflare token, and so on.

## 4. Recreate the users with their old numbers

The recordings belong to `rbmlogger` by **number**, not by name, so the users must get their old numbers back. The backup records them:

```bash
sudo tar -xzOf /mnt/storage/system-backup/logger-config-latest.tar.gz /rbm-backup-info/users.txt
```

That prints lines such as `rbmlogger:x:988:988:…`. Create the users with those numbers: `988` for `rbmlogger` and `986` for `rbmweb` as of Nov 2026. Use whatever the file says.

```bash
sudo groupadd --system -g 988 rbmlogger && sudo useradd --system -u 988 -g 988 -G audio --home-dir /var/lib/rbm-logger --shell /usr/sbin/nologin rbmlogger
sudo groupadd --system -g 986 rbmweb && sudo useradd --system -u 986 -g 986 -G rbmlogger --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin rbmweb
```

If a number is already taken by something the new install created, check with `getent passwd 988`. If so, use a free number instead, and fix the recordings afterwards with `sudo chown -R rbmlogger:rbmlogger /mnt/storage/recordings`.

## 5. Restore the settings

```bash
sudo tar -xzf /mnt/storage/system-backup/logger-config-latest.tar.gz -C / --absolute-names \
  --exclude='/rbm-backup-info*' --exclude='/etc/fstab' --exclude='/etc/network/*' --exclude='/etc/hostname' --exclude='/etc/hosts'
```

This puts back the configs, the download page's password and secret, the Cloudflare token, the SSH host keys and key-only login, the installed scripts, the event log and the systemd units.

It deliberately **doesn't** restore:
- `/etc/fstab`: it names the old SSD's partitions;
- the network files: the new install's are correct.

Add the RAID to the new `fstab` instead:

```bash
echo 'UUID=bd4cf156-5905-4803-9561-2d1d082a0f42 /mnt/storage ext4 defaults,nofail,x-systemd.device-timeout=60 0 2' | sudo tee -a /etc/fstab
sudo umount /mnt/storage && sudo systemctl daemon-reload && sudo mount /mnt/storage
sudo update-initramfs -u
```

Check the RAID's filesystem UUID first with `sudo blkid /dev/md0`, and use that if it's different. The backup's `mdadm.conf` is restored too, which keeps the array named `md0`; that's why `update-initramfs` is there.

## 6. Reinstall the software

From the admin laptop, copy the project and run the installers. (Or, on the logger itself: `sudo apt install -y git && git clone https://github.com/kaos-kult/RBM-Logger.git && cp -r RBM-Logger/rbm-fm-logger ~/`.) They reuse the restored settings and don't ask for anything already set.

```bash
scp -r rbm-fm-logger logger:~/
ssh -t logger 'cd ~/rbm-fm-logger && sudo ./install.sh && sudo ./update-logger.sh'
ssh -t logger 'cd ~/rbm-fm-logger/web && sudo ./install-web.sh && sudo ./caddy-dns-setup.sh'
```

`install.sh` installs ffmpeg and the recorder. `update-logger.sh` adds security updates, disk monitoring, the weekly summary and the settings backup. `install-web.sh` and `caddy-dns-setup.sh` set up the download page. The Cloudflare token is already restored, so it isn't asked for.

Then start the recorder, and restart SSH so it uses the restored host keys and key-only login:

```bash
ssh -t logger 'sudo systemctl start rbm-logger && sudo systemctl restart ssh'
```

## 7. Check everything

```bash
ssh logger 'systemctl is-active rbm-logger rbm-web caddy smartmontools; cat /proc/mdstat'
ssh -t logger 'sudo ls -l /mnt/storage/recordings | tail -3; sudo tail -5 /var/lib/rbm-logger/events.log'
ssh -t logger 'sudo systemctl start rbm-web-check rbm-weekly'
```

- `RECORDER_HEALTHY` should appear in the event log, and the newest `RBMFM_…mp3` should be growing.
- The download page should load at its address, and log in with the **same presenter password** as before.
- The weekly summary should arrive on ntfy, ideally saying "all good" apart from the gap.

**Last:**
- **Breeze:** reinstall the Breeze RMM agent, because offline alerts depend on it.
- **Other machines:** they only accept the logger by its address (10.1.2.198), which hasn't changed. STUDIOB's temporary import key is restored with `~/.ssh`. Remove it if the import is long finished.
- **The gap:** note the outage in the archive history in [fm-logger.md](fm-logger.md#the-archive).

## Settings backup

`rbm_config_backup.sh`, run by `rbm-config-backup.timer` every night at 03:30, saves `/mnt/storage/system-backup/logger-config-YYYYMMDD.tar.gz`. It keeps the last 30, and `logger-config-latest.tar.gz` points to the newest. It contains:

- the recorder and download page configs, including the password hash, cookie secret and Cloudflare token;
- the installed scripts and systemd units, the Caddy config, `mdadm.conf`, `smartd.conf`, the automatic-update settings and the logrotate rule;
- SSH: host keys, server settings, and the `logger` user's `~/.ssh`;
- the event log (`/var/lib/rbm-logger`) and the health-check state;
- `/rbm-backup-info/`: the package list, user and group numbers, the disk layout and partition tables, RAID details and enabled services.

**It contains secrets,** so the folder and archives are readable only by root. It isn't an off-site backup: it's on the same RAID as the recordings. When off-site backup is set up, include `system-backup/`.

If a nightly backup fails, ntfy gets **"RBM logger settings backup failed"**. The weekly summary shows the newest backup's age and says "needs attention" if it's more than 2 days old. To run it by hand:

```bash
ssh -t logger 'sudo systemctl start rbm-config-backup && cat /var/lib/rbm-logger/config-backup.status'
```
