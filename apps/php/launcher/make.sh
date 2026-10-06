#!/usr/bin/env bash
# Bake the company's app address into the staff launcher: bash apps/php/launcher/make.sh https://example.com/app/ [out.html]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="${1:?usage: make.sh https://example.com/app/ [out.html]}"
OUT="${2:-$HERE/../dist/vitral.html}"
[[ "$URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] || { echo "address must look like https://example.com/app/" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
sed "s#__APP_URL__#${URL}#" "$HERE/vitral.html" > "$OUT"
echo "wrote $OUT"
