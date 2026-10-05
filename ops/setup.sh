#!/usr/bin/env bash
# One-shot install on a fresh Linux server (Ubuntu/Debian). Run from the repository root:
#   sudo bash ops/setup.sh
# Asks for the domain, the first manager and (optionally) the Telegram bot token,
# writes ops/.env with fresh secrets, starts everything and creates the manager account.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "نصب Docker…"
  curl -fsSL https://get.docker.com | sh
fi

if [ -f ops/.env ]; then
  echo "ops/.env از قبل هست؛ همان استفاده می‌شود."
else
  read -rp "دامنه (مثلاً app.vitral.ir): " DOMAIN
  read -rp "توکن بات تلگرام (خالی = بدون بات): " TOKEN
  secret() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }
  PG=$(secret)
  cat > ops/.env <<ENV
APP_ENV=production
POSTGRES_PASSWORD=$PG
DATABASE_URL=postgres://vitral:$PG@db:5432/vitral
SESSION_SECRET=$(secret)
FILE_STORAGE_DIR=/data/files
BACKUP_DIR=/backups
BACKUP_ENCRYPTION_KEY=$(secret)
APP_ORIGIN=https://$DOMAIN
DOMAIN=$DOMAIN
COOKIE_SECURE=true
PUBLIC_URL=https://$DOMAIN
DAILY_REPORT_TIME=21:00
TELEGRAM_BOT_TOKEN=$TOKEN
BOT_SERVICE_KEY=$(secret)
ALERT_POLL_SECONDS=30
COMPOSE_PROFILES=${TOKEN:+bot}
ENV
  chmod 600 ops/.env
  echo "کلید پشتیبان (BACKUP_ENCRYPTION_KEY) در ops/.env است؛ یک نسخه از آن را بیرون از سرور نگه دارید."
fi

set -a; . ops/.env; set +a
docker compose -f ops/docker-compose.yml --env-file ops/.env up -d --build

echo "منتظر بالا آمدن برنامه…"
for _ in $(seq 1 60); do
  if docker compose -f ops/docker-compose.yml --env-file ops/.env exec -T app \
      node -e 'fetch("http://localhost:3000/api/v1/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' 2>/dev/null; then
    break
  fi
  sleep 5
done

read -rp "آیا حساب مدیر ساخته شود؟ (y/n) " MK
if [ "$MK" = "y" ]; then
  read -rp "موبایل مدیر (09…): " M
  read -rp "نام مدیر: " N
  read -rsp "رمز (حداقل ۸ نویسه): " P; echo
  docker compose -f ops/docker-compose.yml --env-file ops/.env exec -T \
    -e ADMIN_MOBILE="$M" -e ADMIN_NAME="$N" -e ADMIN_PASSWORD="$P" app pnpm --filter @vitral/server create-admin
fi
echo "آماده است: https://${DOMAIN}"
