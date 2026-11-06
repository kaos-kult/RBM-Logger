#!/bin/bash
# Called by smartd (-M exec) when a disk reports a problem: failing health, new bad
# sectors, failed self-test, overheating. Sends it to the recorder's ntfy topic.
# smartd provides SMARTD_DEVICE, SMARTD_FAILTYPE and SMARTD_MESSAGE.
set -u
NTFY_URL=$(sed -n 's/^NTFY_URL=//p' /etc/rbm-logger.conf)
NTFY_TOKEN=$(sed -n 's/^NTFY_TOKEN=//p' /etc/rbm-logger.conf)
message="${SMARTD_MESSAGE:-no details}
Disk: ${SMARTD_DEVICEINFO:-unknown} (sdX letters can change between reboots; go by model and serial)

A failing disk usually gets worse. Check: sudo smartctl -a ${SMARTD_DEVICE:-/dev/sdX} and cat /proc/mdstat. Plan to replace the disk."
logger -t rbm-smart "${SMARTD_DEVICE:-?} ${SMARTD_FAILTYPE:-?}: ${SMARTD_MESSAGE:-}"
[[ -z "$NTFY_URL" ]] && exit 0
args=(-fsS -m 20 -H "Title: RBM logger disk warning: ${SMARTD_DEVICE:-?} (${SMARTD_FAILTYPE:-?})"
      -H "Priority: urgent" -H "Tags: radio,floppy_disk,warning" --data-binary "$message")
[[ -n "$NTFY_TOKEN" ]] && args+=(-H "Authorization: Bearer $NTFY_TOKEN")
curl "${args[@]}" "$NTFY_URL" >/dev/null
