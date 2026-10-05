# Vitral — PHP + MySQL edition

A PHP 8.1+ / MySQL 5.7+ (MariaDB 10.3+) twin of `apps/server`. It exists so the owner can run Vitral on ordinary
shared cPanel hosting: no Node, no SSH, no Composer, files uploaded with File Manager into `public_html/app/`.

The React app (`apps/web`) is unchanged and talks to this API through the **same REST contract** as the Node
server: paths, JSON shapes, status codes, the error shape `{error:{code,message,fields?,current?}}`, headers (helmet
set, `x-ratelimit-*`) and the `vt_session` cookie. The conformance harness (below) runs the Node test files against
this implementation to keep it that way.

## Layout

```
apps/php/
  public/            what is served (in the zip these files sit at the app root, next to src/)
    index.php        front controller: /api/v1/* → API, anything else → web app file or index.html
    install.php      one-time installer (writes config.php, migrates, creates the manager, deletes itself)
    .htaccess        rewrites to index.php; denies src/, data/, migrations/, bin/, config.php, *.json …
    .user.ini        upload / memory limits for PHP-FPM hosts
    router-dev.php   router for `php -S` (dev + tests only, never shipped)
  src/
    bootstrap.php    PSR-4 autoloader (Vitral\ → src/), UTC, warnings → exceptions
    Core/            framework: App (pipeline), Router, Request/Response, Db, Schema/V (mini-zod), Auth, …
    Lib/             pure code: Decimal, Num, Jalali, Words, FileType (MIME sniffing), Zip, Image (GD)
    Modules/         one file per API module (Auth, Users, Settings, Backup, Files, Health, …)
  migrations/        0001_base.php … 0004_import_files.php (MySQL translation of apps/server/src/db/migrations)
  bin/               migrate.php, create-user.php, reset-test-db.php (CLI only)
  data/              default private storage (files/, backups/, logs/), denied by .htaccess
  dev/TestBridge.php test-only endpoints for the conformance harness
  tests/             php tests/run.php — Decimal / Jalali / Words / numbering against TS-generated fixtures
  build.sh           → dist/vitral-app.zip
```

## Request pipeline (`Core/App::handleApi`, same order as `apps/server/src/app.ts`)

1. not installed → 503; pending migrations are applied once after an upgrade (named lock + marker file in `LOG_DIR`)
2. user: `X-Bot-Key` + `X-Bot-User` (Telegram service) or the `vt_session` cookie (HMAC-SHA256 token hash)
3. CSRF for POST/PUT/PATCH/DELETE: same-origin `Origin`/`Referer`, or `X-Requested-With: vitral` (also before 404)
4. route match (404 `پیدا نشد`), rate limit (MySQL fixed window, table `rate_limits`), 1 MB JSON limit (→ 400 file-size message)
5. body parse like Fastify (bad JSON 400, unknown content type 415, `text/plain` → string, no body → zod «Required»)
6. handler → `Response` or a plain array (200 JSON)
7. confidential-key filter on every 2xx JSON response for users without `finance.view` (principle 6)
8. errors: `AppError` → its status/body; anything else → logged, 500 `خطای داخلی؛ شناسه درخواست <id>`

## Adding a module

Create `src/Modules/<Name>.php` with a static `register(Router, App)`. `App::loadModules()` picks up every file in
the folder, so modules never touch shared files and can be written in parallel.

```php
<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\{App, AppError, Audit, Db, Idempotency, Request, Response, Router, V, Versioning};

final class Parties
{
    public static function register(Router $r, App $app): void
    {
        $r->get('/parties/:id', static function (Request $req) use ($app) {
            $req->requirePermission('parties.view');
            ['id' => $id] = V::idParam()->parse($req->params);
            $row = $app->db()->find('parties', $id) ?? throw new AppError('not_found');
            return self::present($row);                     // array → 200 JSON
        });

        $r->post('/parties', static function (Request $req) use ($app) {
            $me = $req->requirePermission('parties.manage');
            $body = V::object(['name' => V::string()->trim()->min(1, 'نام لازم است')->max(200)])->parse($req->body());
            $key = Idempotency::requireKey($req);
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /parties', static function (Db $trx) use ($body, $me) {
                $row = $trx->insert('parties', $body + ['created_by' => $me->id]);   // uuid id + INSERT_DEFAULTS added
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'parties', 'entityId' => $row['id'], 'action' => 'create', 'after' => $row]);
                return ['status' => 201, 'body' => self::present($row)];
            });
            return Response::json($res['body'], $res['status']);
        }, ['rateLimit' => ['max' => 60, 'window' => 60]]);
    }
}
```

Plain list/get/create/patch resources can use `Core/Crud::routes($r, $app, [...])`, the port of `lib/crud.ts`
(cursor pages, version check with 409 + `current`, audit, optional idempotency). Name clashes with core classes:
alias them (`use Vitral\Core\Auth as Session;` inside `Modules\Auth`).

Porting checklist for a Node module: same paths and status codes; same Persian messages and `fields` keys; the
same order of checks (permission → idempotency key → body validation, as in the Node handler); `present*()`
functions with identical keys; numbers that are `numeric`/`bigint` in Postgres stay **strings**.

## Validation: `V` and `Schema` (mini-zod)

`V::object([...])->parse($input)` behaves like zod v3 `parse` and throws the same 400:
`{"code":"validation","message":"اطلاعات واردشده درست نیست","fields":{"path.to.field":"<zod message>"}}` (last
issue per path wins, root issues under `_`). Zod's English default messages, abort/dirty semantics (type errors
abort, failed checks and refinements continue, transforms do not run on dirty values) and coercion are reproduced.
Shared schemas from `packages/shared` live in `V` (`mobile`, `password`, `decimalString`, `uuid`, `dateOnly`,
`isoDate`, `listQuery`, `idParam`, `versionField`, …). Missing keys come back absent (like `undefined`); use
`array_key_exists` for «was it sent?». An empty JSON object arrives as `\stdClass`, a top-level `[]` as a
`JsonList` marker that only `Schema` understands.

## Database rules (MySQL 5.7+ / MariaDB 10.3+)

- PDO with native prepared statements only; never interpolate values. Identifiers via `Db::ident()`.
- No CTEs, window functions, `JSON_TABLE`, `RETURNING`, partial indexes, `ILIKE`, `::casts`, `FILTER (WHERE …)`.
  `utf8mb4_unicode_ci` makes `LIKE` case-insensitive; escape with `Db::like()`.
- ids: `VARCHAR(36) ascii` (`Migrator::UUID`), generated in PHP (`Db::uuid()`, added by `Db::insert`).
- timestamps: `DATETIME(3)` in UTC (session `time_zone = '+00:00'`); returned as ISO `…T…Z` strings; DATE as
  `YYYY-MM-DDT00:00:00.000Z` (what node-pg + JSON gives). Write with `Db::dt()` / DateTime objects.
- money / weights: `DECIMAL(p,s)`, returned as strings; compute with `Lib/Decimal`, never floats.
- JSON: `LONGTEXT`; register the column in `Db::JSON_COLUMNS` so reads decode it; writes accept arrays/objects.
  TEXT/JSON defaults and `CURRENT_DATE` go in `Db::INSERT_DEFAULTS` (MySQL 5.7 cannot declare them).
- booleans: `TINYINT(1)` → PHP bool; `COUNT(*)`/BIGINT → string; reserved words used as columns must be
  backticked: `` `key` ``, `` `rows` ``, `` `sensitive` ``, `` `before` ``, `` `after` ``, `` `last_value` ``, `` `date` ``, `` `text` ``.
- Partial unique indexes → a `_g_*` STORED generated column + a two-column UNIQUE key (`Db` hides `_g_*` columns).
- Triggers / CHECK changes go through `$m->optional()` (some hosts forbid them; they become warnings).
- Transactions: `$db->transaction(fn (Db $trx) => …)` (nested = savepoints), `SELECT … FOR UPDATE` via
  `$trx->find($t, $id, true)` / `Versioning::lockForUpdate`. Isolation is READ COMMITTED like Postgres.
- Text ordering follows `utf8mb4_unicode_ci`, which may differ from Postgres collation for mixed scripts.

## Decimal

```php
use Vitral\Lib\Decimal;
$total = Decimal::of('1250.5')->mul('3')->add(Decimal::of('0.25'));   // exact, string-based, no bcmath/gmp
$total->toFixed(2);            // "3751.75" — ROUND_HALF_UP like decimal.js
$total->div('7', 3);           // fixed scale, half-up; div('7') = 40 significant digits (decimal.js precision 40)
Decimal::of('2')->gte('1.999'); Decimal::sum(['1.1', '2.2']); Num::round($x, 'weight');
```

Accepts strings, ints, Decimals and finite floats (converted through their shortest JSON form, as JavaScript would print them); prefer strings. `Num` holds `parseNumber` (Persian/Arabic digits),
`formatNumber`, `places`, `percent`, mirroring `packages/shared/src/number.ts`.

## Tests

Unit tests (no database): `php apps/php/tests/run.php [filter]`. Fixtures come from the TypeScript code:
`cd apps/server && node --import tsx ../php/tests/fixtures/generate.ts`.

Conformance tests: the Node test files run against PHP when `VITRAL_TARGET=php`:

```bash
service mariadb start                                  # user vitral/vitral, database vitral_php_test
cd apps/server
VITRAL_TARGET=php npx vitest run test/auth.test.ts     # one file
pnpm --filter @vitral/server test:php                  # every file
```

Per file, `test/helpers.ts` resets the database (`bin/reset-test-db.php`, refuses names not ending in `_test`),
starts `php -S 127.0.0.1:<free port> public/router-dev.php` with the config in env (`VITRAL_CONFIG_FROM_ENV=1`,
overrides such as `BOT_SERVICE_KEY` forwarded), and sends real HTTP requests. `t.db` is a Kysely (MySQL dialect)
whose queries go through the test bridge: inserts get a uuid `id` and the `INSERT_DEFAULTS`, datetimes come back as
`Date`, `t.db.transaction()` is refused. DB connection: `TEST_PHP_DB_HOST/PORT/NAME/USER/PASS`.
Debugging: `TEST_PHP_SERVER_LOG=1` shows PHP's stderr; each run's app log is in `$TMPDIR/vitral-php-files-*/logs/`.
Tests that import Node code directly (`numbering.test.ts` calls `nextNumber`, `backup.test.ts` runs the Postgres
ops scripts) cannot pass in PHP mode.

## Deployment

1. `./build.sh` (builds the web app with `VITE_BASE=/app/`, then zips) → `dist/vitral-app.zip`.
2. cPanel: create a MySQL database + user (all privileges), upload the zip to `public_html/app/`, extract.
3. Open `https://<domain>/app/install.php`: host checks, database, first manager, optional Telegram token, data folder
   (defaults to `~/vitral-data`, outside the web root, when writable). It writes `config.php` (0600) with fresh
   `SESSION_SECRET`, `BOT_SERVICE_KEY` and `BACKUP_ENCRYPTION_KEY`, migrates, creates the manager, deletes itself.
4. Upgrades: upload the new zip over the old files (keep `config.php` and the data folder); the next API request
   applies new migrations. Lost manager password without SSH: a one-off cPanel cron job
   `VITRAL_PASSWORD='…' php ~/public_html/app/bin/create-user.php 0912… manager`.

Secrets live only in `config.php` (never in URLs or the database). Uploaded files are stored under random names
outside the web root (or in `data/`, denied by `.htaccess`) and are only served by the API after permission checks.
