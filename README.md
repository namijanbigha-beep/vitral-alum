# ویترال — سامانه مدیریت وزن و حساب

سامانه وب چندکاربره «ویترال آلومینیوم اراک». مشخصات کامل در [`docs/spec.md`](docs/spec.md)؛ گزارش هر فاز در `docs/phase-reports/`.

**وضعیت: فازهای ۰ تا ۵ ساخته شده و در حال اشکال‌زدایی با مالک.** فازها طبق بخش ۲۰ مشخصات:

| فاز | دامنه | گزارش |
| --- | --- | --- |
| ۰ | زیرساخت | [`phase-0.md`](docs/phase-reports/phase-0.md) |
| ۱ | محصول، فروش، بندیل، گزارش روزانه | [`phase-1.md`](docs/phase-reports/phase-1.md) |
| ۲ | کارگاه، مواد، رنگ | [`phase-2.md`](docs/phase-reports/phase-2.md) |
| ۳ | ارسال، صادرات، پول | [`phase-3.md`](docs/phase-reports/phase-3.md) |
| ۴ | سود و داشبورد | [`phase-4.md`](docs/phase-reports/phase-4.md) |
| ۵ | ربات تلگرام | [`phase-5.md`](docs/phase-reports/phase-5.md) |

## ساختار

```
apps/server     Fastify + Kysely + PostgreSQL  (src/modules، src/rules، src/db، test)
apps/web        React + Vite، راست‌به‌چپ، PWA (فونت وزیرمتن از خود سرور)
apps/bot        ربات تلگرام (long polling؛ از طریق API سرور کار می‌کند)
packages/shared schemaهای Zod، عدد (R19، R20)، تاریخ شمسی (R26)، مبلغ به حروف (R25)، مجوزها
ops             docker-compose، Dockerfile، Caddyfile، backup.sh، restore.sh، .env.example
docs            spec.md، گزارش فازها، راهنمای کار، قالب‌های اکسل
```

## نیازمندی‌ها

Node 20+، pnpm 10 (`corepack enable`)، PostgreSQL 15+ (برای توسعه و آزمون)، Docker Compose (برای استقرار).

## توسعه

```sh
pnpm install
createdb vitral && createdb vitral_test   # یا با psql
cp ops/.env.example ops/.env              # مقادیر را پر کنید

# سرور
cd apps/server
export DATABASE_URL=postgres://vitral:vitral@localhost:5432/vitral
export SESSION_SECRET=$(openssl rand -base64 48) FILE_STORAGE_DIR=/tmp/vitral-files COOKIE_SECURE=false APP_ENV=development
pnpm migrate                               # migrationها از صفر (در start هم خودکار اجرا می‌شود)
ADMIN_MOBILE=09xxxxxxxxx ADMIN_NAME="مدیر" ADMIN_PASSWORD='حداقل ۸ نویسه' pnpm create-admin
pnpm dev                                   # http://localhost:3000

# رابط (در ترمینال دوم؛ /api به سرور پروکسی می‌شود)
cd apps/web && pnpm dev                    # http://localhost:5173

# بات تلگرام (اختیاری؛ به سرور در حال اجرا وصل می‌شود)
cd apps/bot
export TELEGRAM_BOT_TOKEN=... SERVER_URL=http://localhost:3000 BOT_SERVICE_KEY=<همان مقدار سرور>
pnpm dev
```

متغیرهای محیطی سرور (همه در `ops/.env.example`): `DATABASE_URL`، `SESSION_SECRET`، `FILE_STORAGE_DIR`، `BACKUP_DIR`، `BACKUP_ENCRYPTION_KEY`، `APP_ORIGIN`، `PUBLIC_URL` (برای لینک مهمان و پیام بات)، `COOKIE_SECURE`، `WEB_DIST_DIR`، `CHROMIUM_PATH` (رندر PDF؛ پیش‌فرض مسیر Playwright)، `BOT_SERVICE_KEY` (کلید مشترک سرور و بات؛ بدون آن مسیرهای `/internal/bot/*` خاموش‌اند)، `DAILY_REPORT_TIME` (ساعت تهران، پیش‌فرض ۲۱:۰۰). بات: `TELEGRAM_BOT_TOKEN`، `SERVER_URL`، `BOT_SERVICE_KEY`، `DAILY_REPORT_TIME`، `ALERT_POLL_SECONDS`، `PUBLIC_URL` (اختیاری؛ لینک مستقیم «بیشتر › اتصال تلگرام» در پیام اتصال).

برای سرو کردن رابط ساخته‌شده از خود سرور: `pnpm --filter @vitral/web build` و `WEB_DIST_DIR=apps/web/dist`.

## آزمون، تایپ، لینت

```sh
pnpm test        # Vitest؛ آزمون‌های سرور به دیتابیس vitral_test نیاز دارند
                 # (TEST_DATABASE_URL و برای T53 TEST_RESTORE_DATABASE_URL قابل تنظیم است)
pnpm typecheck   # TypeScript strict، بدون any
pnpm lint
pnpm --filter @vitral/web e2e   # Playwright: سه مسیر اصلی رابط روی سرور در حال اجرا (E2E_URL, E2E_MOBILE, E2E_PASSWORD)
```

آزمون‌های ثابت بخش ۱۱ با همان شناسه (T01 …) در `packages/shared/test` و `apps/server/test` هستند؛ سناریوی طلایی بخش ۱۲ در `apps/server/test/golden.test.ts`، آزمون‌های PDF و بات در `apps/server/test/pdf-bot.test.ts` و `apps/bot/test`. آزمون‌های سرور هر بار اسکیمای `vitral_test` را از نو می‌سازند و پشت سر هم اجرا می‌شوند. PDF با Chromium بدون سر رندر می‌شود؛ اگر Chromium نباشد فقط آزمون‌های PDF رد می‌شوند.

## استقرار (Docker Compose)

```sh
cp ops/.env.example ops/.env && nano ops/.env     # SESSION_SECRET، POSTGRES_PASSWORD، BACKUP_ENCRYPTION_KEY، DOMAIN
docker compose -f ops/docker-compose.yml --env-file ops/.env up -d --build
docker compose -f ops/docker-compose.yml --env-file ops/.env exec \
  -e ADMIN_MOBILE=09xxxxxxxxx -e ADMIN_NAME="مدیر" -e ADMIN_PASSWORD='...' app pnpm --filter @vitral/server create-admin
```

سرویس‌ها: `db` (PostgreSQL 16)، `app` (API، رابط و PDF روی یک پورت؛ Chromium داخل تصویر)، `bot` (بات تلگرام؛ فقط با `TELEGRAM_BOT_TOKEN`)، `caddy` (HTTPS خودکار برای `DOMAIN`)، `backup` (پشتیبان روزانه ۰۲:۳۰). محیط `staging` با `APP_ENV=staging` و دیتابیس و پوشه فایل جدا بالا می‌آید؛ در رابط برچسب «محیط آزمایشی» دارد.

## پشتیبان و بازیابی

- `ops/backup.sh daily|manual` → `BACKUP_DIR/vitral-<kind>-<زمان>.tar.enc` شامل `pg_dump`، tar فایل‌ها و sha256 هر فایل؛ رمزگذاری AES-256 با `BACKUP_ENCRYPTION_KEY`. نگهداری ۷ روزانه، ۴ هفتگی، ۳ ماهانه.
- یک کپی بیرون از سرور را خودتان با rclone/scp از `BACKUP_DIR` بردارید (اسکریپت فقط محلی می‌نویسد).
- `ops/restore.sh <file.tar.enc>` فقط در دیتابیس و پوشه خالی اجرا می‌شود، بعد از بازیابی sha256 همه فایل‌ها را تطبیق می‌دهد. سپس نتیجه آزمون بازیابی را در «تنظیمات › پشتیبان» ثبت کنید.
- سلامت: `GET /api/v1/health` (دیتابیس و درصد پر بودن دیسک؛ بالای ۸۰٪ در صفحه خلاصه مدیر هشدار می‌دهد).

## مستندات

`docs/spec.md` مشخصات کامل، `docs/phase-reports/` گزارش هر فاز، `docs/user-guide.md` راهنمای کار روزانه، `docs/templates/` قالب‌های ورود اکسل.

## قرارداد API (خلاصه)

پیشوند `/api/v1`، کوکی نشست HttpOnly، درخواست‌های تغییردهنده با هدر `X-Requested-With: vitral` (CSRF)، ثبت قطعی با هدر `Idempotency-Key` (UUID)، ویرایش با فیلد `version` (نسخه قدیمی → 409 با رکورد فعلی در `error.current`). خطاها: `{ "error": { "code", "message", "fields" } }`. پول و وزن رشته اعشاری‌اند، تاریخ ISO-8601 UTC.
