#!/usr/bin/env sh
# Encrypted backup of the database and the file store.
#   backup.sh [daily|weekly|monthly|manual]
# Needs: pg_dump, tar, openssl; env DATABASE_URL, FILE_STORAGE_DIR, BACKUP_DIR, BACKUP_ENCRYPTION_KEY.
# Output: $BACKUP_DIR/vitral-<kind>-<utc timestamp>.tar.enc  (AES-256-CBC, PBKDF2, key from the environment)
# Retention: 7 daily, 4 weekly, 3 monthly. A "daily" run also produces the weekly (Sunday) and monthly (1st) copies.
# Copy the newest file off the server (rclone/scp) from your own cron; this script only writes locally.
set -eu

KIND="${1:-manual}"
: "${DATABASE_URL:?}" "${FILE_STORAGE_DIR:?}" "${BACKUP_DIR:?}" "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$BACKUP_DIR"

pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$WORK/db.dump"
tar -C "$FILE_STORAGE_DIR" -cf "$WORK/files.tar" .
( cd "$FILE_STORAGE_DIR" && find . -type f -exec sha256sum {} + | sort -k2 ) > "$WORK/files.sha256"
printf 'created_at=%s\nkind=%s\nformat=1\n' "$STAMP" "$KIND" > "$WORK/manifest.txt"

write_one() {
  out="$BACKUP_DIR/vitral-$1-$STAMP.tar.enc"
  tar -C "$WORK" -cf - db.dump files.tar files.sha256 manifest.txt \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_ENCRYPTION_KEY -out "$out"
  echo "wrote $out ($(du -h "$out" | cut -f1))"
}

prune() { # prune <kind> <keep>
  ls -1t "$BACKUP_DIR"/vitral-"$1"-*.tar.enc 2>/dev/null | tail -n +"$(( $2 + 1 ))" | xargs -r rm -f
}

write_one "$KIND"
if [ "$KIND" = daily ]; then
  [ "$(date -u +%u)" = 7 ] && write_one weekly
  [ "$(date -u +%d)" = 01 ] && write_one monthly
  prune daily 7; prune weekly 4; prune monthly 3
fi
