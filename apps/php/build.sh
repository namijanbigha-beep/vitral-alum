#!/usr/bin/env bash
# Build dist/vitral-app.zip for shared hosting: unzip its contents into public_html/app/ with cPanel File Manager,
# then open https://<domain>/app/install.php.
#
# Zip layout (= public_html/app/):
#   index.php install.php .htaccess .user.ini     front controller, installer, Apache rules, PHP limits
#   src/ migrations/ bin/ data/                   code, schema, CLI tools, private data (all denied by .htaccess)
#   index.html assets/ ...                        the built web app (apps/web/dist)
# Left out: public/router-dev.php and dev/ (test bridge), tests/, README.md.
#
# TODO(web build): the web app must be built for the /app/ base path: VITE_BASE=/app/ pnpm --filter @vitral/web build
# (done below). apps/web/vite.config.ts reads VITE_BASE and src/api/client.ts derives /app/api/v1 from it, but a few
# calls still hard-code '/api/v1' (e.g. the photo upload in src/pages/Bundles.tsx) and break under /app/ — owned by the
# web worker. Set SKIP_WEB_BUILD=1 to zip whatever is already in apps/web/dist.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WEB_DIST="${WEB_DIST:-$REPO/apps/web/dist}"
OUT="$HERE/dist"
STAGE="$OUT/stage"

if [[ "${SKIP_WEB_BUILD:-0}" != "1" ]]; then
  (cd "$REPO" && VITE_BASE=/app/ pnpm --filter @vitral/web build)
fi
[[ -f "$WEB_DIST/index.html" ]] || { echo "web build not found at $WEB_DIST (build apps/web first)" >&2; exit 1; }

rm -rf "$STAGE" "$OUT/vitral-app.zip"
mkdir -p "$STAGE"
cp -R "$WEB_DIST"/. "$STAGE"/
cp "$HERE/public/index.php" "$HERE/public/install.php" "$HERE/public/.htaccess" "$HERE/public/.user.ini" "$STAGE"/
cp -R "$HERE/src" "$HERE/migrations" "$HERE/bin" "$STAGE"/
mkdir -p "$STAGE/data"
cp "$HERE/data/.htaccess" "$STAGE/data/.htaccess"
find "$STAGE" -name '.DS_Store' -delete

# every PHP file must parse on the target version
find "$STAGE" -name '*.php' -print0 | xargs -0 -n1 php -l >/dev/null

(cd "$STAGE" && zip -qr -X "$OUT/vitral-app.zip" .)
rm -rf "$STAGE"
echo "built $OUT/vitral-app.zip ($(du -h "$OUT/vitral-app.zip" | cut -f1))"
