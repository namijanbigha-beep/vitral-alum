#!/usr/bin/env bash
# Build dist/vitral-app.zip for shared hosting: unzip its contents into public_html/app/ with cPanel File Manager,
# then open https://<domain>/app/install.php.
#
# Zip layout (= public_html/app/):
#   index.php install.php .htaccess .user.ini     front controller, installer, Apache rules, PHP limits
#   telegram.php cron.php                        Telegram webhook, scheduled jobs for cPanel Cron Jobs
#   src/ migrations/ bin/ data/                   code, schema, CLI tools, private data (all denied by .htaccess)
#   index.html assets/ ...                        the built web app (apps/web/dist)
# Left out: public/router-dev.php and dev/ (test bridge), tests/, README.md.
#
# The web app is built for the /app/ base path (VITE_BASE=/app/) into dist/web, so apps/web/dist (served from / by the
# Node server) is left alone. Set SKIP_WEB_BUILD=1 and WEB_DIST=<dir> to zip an existing /app/ build instead.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/dist"
WEB_DIST="${WEB_DIST:-$OUT/web}"
STAGE="$OUT/stage"

if [[ "${SKIP_WEB_BUILD:-0}" != "1" ]]; then
  (cd "$REPO/apps/web" && VITE_BASE=/app/ npx tsc --noEmit -p . && VITE_BASE=/app/ npx vite build --outDir "$WEB_DIST" --emptyOutDir)
fi
[[ -f "$WEB_DIST/index.html" ]] || { echo "web build not found at $WEB_DIST (build apps/web first)" >&2; exit 1; }

rm -rf "$STAGE" "$OUT/vitral-app.zip"
mkdir -p "$STAGE"
cp -R "$WEB_DIST"/. "$STAGE"/
cp "$HERE/public/index.php" "$HERE/public/install.php" "$HERE/public/telegram.php" "$HERE/public/cron.php" "$HERE/public/.htaccess" "$HERE/public/.user.ini" "$STAGE"/
cp -R "$HERE/src" "$HERE/migrations" "$HERE/bin" "$STAGE"/
# Version the in-app updater compares with GitHub releases (VITRAL_VERSION = the release tag in CI).
VERSION="${VITRAL_VERSION:-dev-$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo local)}"
[[ "$VERSION" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "bad VITRAL_VERSION: $VERSION" >&2; exit 1; }
printf "<?php\nreturn '%s';\n" "$VERSION" > "$STAGE/src/version.php"
mkdir -p "$STAGE/data"
cp "$HERE/data/.htaccess" "$STAGE/data/.htaccess"
find "$STAGE" -name '.DS_Store' -delete

# every PHP file must parse on the target version
find "$STAGE" -name '*.php' -print0 | xargs -0 -n1 php -l >/dev/null

(cd "$STAGE" && zip -qr -X "$OUT/vitral-app.zip" .)
rm -rf "$STAGE"
(cd "$OUT" && sha256sum vitral-app.zip > vitral-app.zip.sha256)
echo "built $OUT/vitral-app.zip $VERSION ($(du -h "$OUT/vitral-app.zip" | cut -f1))"
