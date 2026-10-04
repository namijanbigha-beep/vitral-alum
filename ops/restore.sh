#!/usr/bin/env sh
# Restore a backup made by backup.sh into an EMPTY database and file directory.
#   restore.sh <backup.tar.enc>
# Needs: pg_restore, tar, openssl, sha256sum; env DATABASE_URL, FILE_STORAGE_DIR, BACKUP_ENCRYPTION_KEY.
# Refuses to run if the target database already has tables or the file directory is not empty.
set -eu
FILE="${1:?usage: restore.sh <backup.tar.enc>}"
: "${DATABASE_URL:?}" "${FILE_STORAGE_DIR:?}" "${BACKUP_ENCRYPTION_KEY:?}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

tables="$(psql "$DATABASE_URL" -Atc "select count(*) from pg_tables where schemaname='public'")"
[ "$tables" = 0 ] || { echo "target database is not empty ($tables tables); refusing" >&2; exit 2; }
mkdir -p "$FILE_STORAGE_DIR"
[ -z "$(ls -A "$FILE_STORAGE_DIR")" ] || { echo "file directory is not empty; refusing" >&2; exit 2; }

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENCRYPTION_KEY -in "$FILE" | tar -C "$WORK" -xf -
cat "$WORK/manifest.txt"
pg_restore --no-owner --no-privileges --dbname="$DATABASE_URL" "$WORK/db.dump"
tar -C "$FILE_STORAGE_DIR" -xf "$WORK/files.tar"
( cd "$FILE_STORAGE_DIR" && sha256sum --quiet -c "$WORK/files.sha256" ) && echo "files verified: $(wc -l < "$WORK/files.sha256") files"
echo "restored. Log the restore test (date, duration, result) in the app under تنظیمات › پشتیبان."
