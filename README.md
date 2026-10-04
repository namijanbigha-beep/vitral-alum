# ویترال — سامانه مدیریت وزن و حساب

سامانه وب چندکاربره «ویترال آلومینیوم اراک». مشخصات کامل در [`docs/spec.md`](docs/spec.md)؛ گزارش هر فاز در `docs/phase-reports/`.

**وضعیت: فاز ۰ (زیرساخت) تمام شده.** فازهای بعد: ۱ محصول و فروش و بندیل · ۲ کارگاه و مواد و رنگ · ۳ ارسال و صادرات و پول · ۴ سود و داشبورد · ۵ ربات تلگرام.

## ساختار

```
apps/server     Fastify + Kysely + PostgreSQL  (src/modules، src/rules، src/db، test)
apps/web        React + Vite، راست‌به‌چپ، PWA (فونت وزیرمتن از خود سرور)
apps/bot        ربات تلگرام (فاز ۵)
packages/shared schemaهای Zod، عدد (R19، R20)، تاریخ شمسی (R26)، مبلغ به حروف (R25)، مجوزها
ops             docker-compose، Dockerfile، Caddyfile، backup.sh، restore.sh، .env.example
docs            spec.md، گزارش فازها، قالب‌های اکسل (فاز ۱)
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
```

برای سرو کردن رابط ساخته‌شده از خود سرور: `pnpm --filter @vitral/web build` و `WEB_DIST_DIR=apps/web/dist`.

## آزمون، تایپ، لینت

```sh
pnpm test        # Vitest؛ آزمون‌های سرور به دیتابیس vitral_test نیاز دارند
                 # (TEST_DATABASE_URL و برای T53 TEST_RESTORE_DATABASE_URL قابل تنظیم است)
pnpm typecheck   # TypeScript strict، بدون any
pnpm lint
```

آزمون‌های ثابت بخش ۱۱ با همان شناسه (T01 …) در `packages/shared/test` و `apps/server/test` هستند.

## استقرار (Docker Compose)

```sh
cp ops/.env.example ops/.env && nano ops/.env     # SESSION_SECRET، POSTGRES_PASSWORD، BACKUP_ENCRYPTION_KEY، DOMAIN
docker compose -f ops/docker-compose.yml --env-file ops/.env up -d --build
docker compose -f ops/docker-compose.yml --env-file ops/.env exec \
  -e ADMIN_MOBILE=09xxxxxxxxx -e ADMIN_NAME="مدیر" -e ADMIN_PASSWORD='...' app pnpm --filter @vitral/server create-admin
```

سرویس‌ها: `db` (PostgreSQL 16)، `app` (API و رابط روی یک پورت)، `caddy` (HTTPS خودکار برای `DOMAIN`)، `backup` (پشتیبان روزانه ۰۲:۳۰). محیط `staging` با `APP_ENV=staging` و دیتابیس و پوشه فایل جدا بالا می‌آید؛ در رابط برچسب «محیط آزمایشی» دارد.

## پشتیبان و بازیابی

- `ops/backup.sh daily|manual` → `BACKUP_DIR/vitral-<kind>-<زمان>.tar.enc` شامل `pg_dump`، tar فایل‌ها و sha256 هر فایل؛ رمزگذاری AES-256 با `BACKUP_ENCRYPTION_KEY`. نگهداری ۷ روزانه، ۴ هفتگی، ۳ ماهانه.
- یک کپی بیرون از سرور را خودتان با rclone/scp از `BACKUP_DIR` بردارید (اسکریپت فقط محلی می‌نویسد).
- `ops/restore.sh <file.tar.enc>` فقط در دیتابیس و پوشه خالی اجرا می‌شود، بعد از بازیابی sha256 همه فایل‌ها را تطبیق می‌دهد. سپس نتیجه آزمون بازیابی را در «تنظیمات › پشتیبان» ثبت کنید.
- سلامت: `GET /api/v1/health` (دیتابیس و درصد پر بودن دیسک؛ بالای ۸۰٪ در صفحه خلاصه مدیر هشدار می‌دهد).

## قرارداد API (خلاصه)

پیشوند `/api/v1`، کوکی نشست HttpOnly، درخواست‌های تغییردهنده با هدر `X-Requested-With: vitral` (CSRF)، ثبت قطعی با هدر `Idempotency-Key` (UUID)، ویرایش با فیلد `version` (نسخه قدیمی → 409 با رکورد فعلی در `error.current`). خطاها: `{ "error": { "code", "message", "fields" } }`. پول و وزن رشته اعشاری‌اند، تاریخ ISO-8601 UTC.
