#!/bin/bash
# Runs on the logger: copy old logs from STUDIOB, skipping files already copied at full size.
set -u
SRC='Engineer@10.1.2.98'
DIR='D:/LOGS 20260507'
cd /mnt/storage/import
ssh -i ~/.ssh/studiob_import -o IdentitiesOnly=yes -o BatchMode=yes "$SRC" 'powershell -NoProfile -ExecutionPolicy Bypass -File list.ps1' | tr -d '\r' > list.tsv
total=$(wc -l < list.tsv); n=0; fail=0
while IFS=$'\t' read -r name size; do
  n=$((n + 1))
  [ -f "$name" ] && [ "$(stat -c %s "$name")" = "$size" ] && continue
  if ! scp -q -p -i ~/.ssh/studiob_import -o IdentitiesOnly=yes -o BatchMode=yes "$SRC:$DIR/$name" "$name.part" < /dev/null || [ "$(stat -c %s "$name.part")" != "$size" ]; then
    echo "FAILED $name"; fail=$((fail + 1)); continue
  fi
  mv "$name.part" "$name"
  [ $((n % 250)) = 0 ] && echo "$n/$total $(date +%T)"
done < list.tsv
echo "DONE $n/$total files, $fail failed, $(du -sh . | cut -f1)"
