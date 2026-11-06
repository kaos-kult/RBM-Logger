# Remote SSH access to station machines

All SSH access to station machines goes **through the logger** (Logger-PC), which is the only machine reachable from the internet. The router passes traffic between the station subnets (`10.1.1.x` and `10.1.2.x`), so the logger can reach machines on either one.

```
Mac ──internet──> router :2222 ──> logger (10.1.2.198) ──LAN──> streamer, other PCs
```

## Current hosts

| SSH name | Machine | Address | User | Notes |
|---|---|---|---|---|
| `logger` | Logger-PC (Debian) | Station public IP, port 2222; LAN 10.1.2.198 | `logger` | Router forwards port 2222 to it; DHCP reservation on the router |
| `streamer` | CBAASTRM0908 (Windows) | 10.1.2.41 | `Stream` | Reached via the logger |
| `studiob` | STUDIOB (Windows) | 10.1.2.98 | `Engineer` | Reached via the logger. Holds the old logger's recordings drive (`D:\LOGS 20260507`). SSH server installed from Microsoft's GitHub release (Windows Update install hung) |


## Router port forwards

The station has two routers in series: the ISP's NetComm modem, then the UniFi UDM.

| External port | NetComm → | UDM → | Purpose |
|---|---|---|---|
| 2222 | 192.168.1.3 (UDM) | 10.1.2.198:22 (logger) | SSH to the logger |
| 8443 | 192.168.1.3:8443 | 10.1.2.198:443 (logger) | Download page, see [download-page.md](download-page.md) |
| 80, 443 | | | **Unusable: the ISP (AAPT) blocks incoming 80 and 443.** These forwards can be deleted |

Key: `~/.ssh/psychic_paper` (the key labelled "Kaos: Whatever clearance you were about to ask for.").

## Adding a Windows machine

1. In an **administrator** PowerShell on the machine (for example through Breeze RMM):

   ```powershell
   $key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG19s9TsTjuwXvOyUQTW3C8qqsk34LujbeaQMyKof8zD Kaos: Whatever clearance you were about to ask for.'
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Set-Service sshd -StartupType Automatic
   Start-Service sshd
   $auth = 'C:\ProgramData\ssh\administrators_authorized_keys'
   Set-Content -Path $auth -Value $key -Encoding ascii
   icacls $auth /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F'
   Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -RemoteAddress 10.1.2.198
   ```

   This lets the key log in as any administrator account. The firewall line means SSH only accepts connections **from the logger's address**.

2. In `~/.ssh/config` on the Mac:

   ```
   Host <name>
       HostName <machine IP>
       User <account>
       ProxyJump logger
       IdentityFile ~/.ssh/psychic_paper
       IdentitiesOnly yes
   ```

3. Connect with `ssh <name>`. Copy files with `scp <name>:C:/path/file .`

If the connection is refused, the router may be NATing traffic between subnets, so the machine sees the router's address instead of the logger's. In that case, widen the firewall rule's `-RemoteAddress` accordingly.

## Changing the logger's address

The logger no longer uses Dante, so it can move off the Dante subnet (`10.1.2.x`). Everything above depends on its address, so update these **before** moving it:

1. **Each Windows machine's SSH firewall rule**: set it to the new address, or allow both old and new during the move:
   ```powershell
   Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -RemoteAddress 10.1.2.198, <new IP>
   ```
   Do this first. Afterwards you can only reach them through Breeze.
2. **The router's DHCP reservation** for the logger: change it to the new address.
3. **The UDM's port forwards** for 2222 (SSH) and 8443 (download page): point them at the new address. Otherwise `ssh logger` and the download page stop working from outside.
4. Move the logger and reboot it (or renew DHCP). Check `ssh logger` and `ssh streamer`.
5. Remove the old address from the Windows firewall rules, and update the table above.
