<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * The kernel: configuration, lazy database/storage, the router filled by every module in src/Modules,
 * and the request pipeline of apps/server/src/app.ts:
 *   session/bot user → CSRF → route match (404) → rate limit → body parse → handler →
 *   confidential-key filter (users without finance.view) → JSON, with the same error shapes and headers.
 */
final class App
{
    public readonly Router $router;
    private ?Db $db = null;
    private ?Storage $storage = null;
    private bool $modulesLoaded = false;

    private const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];
    private const JSON_BODY_LIMIT = 1048576;

    public function __construct(public readonly Config $config, ?Db $db = null)
    {
        $this->router = new Router();
        $this->db = $db;
        Log::init($config->str('LOG_DIR'));
    }

    public static function fromRoot(string $root): self
    {
        return new self(Config::load($root));
    }

    public function db(): Db
    {
        return $this->db ??= Db::fromConfig($this->config);
    }

    public function storage(): Storage
    {
        return $this->storage ??= new Storage($this->config->str('FILE_STORAGE_DIR'));
    }

    /** Every src/Modules/<Name>.php defines Vitral\Modules\<Name>::register(Router, App). */
    public function loadModules(): void
    {
        if ($this->modulesLoaded) return;
        $this->modulesLoaded = true;
        $files = glob(VITRAL_SRC . '/Modules/*.php') ?: [];
        sort($files);
        foreach ($files as $file) {
            $class = 'Vitral\\Modules\\' . basename($file, '.php');
            if (class_exists($class) && method_exists($class, 'register')) $class::register($this->router, $this);
        }
    }

    // ---------------------------------------------------------------- front controller

    /** Entry point of public/index.php: /api/* → API, anything else → the web app. */
    public function run(string $base): void
    {
        $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
        $path = (string) parse_url($uri, PHP_URL_PATH);
        if ($base !== '' && str_starts_with($path, $base)) $path = substr($path, strlen($base));
        if ($path === '' || $path[0] !== '/') $path = '/' . $path;
        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));

        if (str_starts_with($path, '/api/')) {
            $res = $this->handleApi(fn () => Request::fromGlobals($this, $path));
        } else {
            $res = $this->serveWeb($path);
        }
        $this->securityHeaders($res);
        $res->send($method === 'HEAD');
        // Shared hosting has no daemon: the scheduled jobs run here, after the response, at most once a minute
        // (Lib/Scheduler; cPanel Cron Jobs can call public/cron.php instead).
        if (str_starts_with($path, '/api/')) \Vitral\Lib\Scheduler::afterResponse($this);
    }

    // ---------------------------------------------------------------- API pipeline

    /** @param callable():Request $makeRequest */
    public function handleApi(callable $makeRequest): Response
    {
        $req = null;
        $limits = null;
        try {
            if (!$this->config->installed()) {
                return Response::json(['error' => ['code' => 'validation', 'message' => 'برنامه هنوز نصب نشده است؛ install.php را باز کنید']], 503);
            }
            $this->ensureSchema();
            $req = $makeRequest();
            $this->loadModules();
            $this->resolveUser($req);
            $this->checkCsrf($req);
            $match = $this->router->match($req->method, $req->path);
            if ($match === null) throw new AppError('not_found');
            $req->params = $match['params'];
            $opts = $match['route']['opts'];
            if (isset($opts['rateLimit'])) {
                $max = (int) $opts['rateLimit']['max'];
                $limits = RateLimit::hit($this->db(), $match['route']['method'] . ' ' . $match['route']['url'] . ' ' . $req->ip, $max, (int) ($opts['rateLimit']['window'] ?? 60));
                if ($limits['exceeded']) throw new HttpError(429);
            }
            if (!$req->isMultipart() && strlen($req->rawBody) > self::JSON_BODY_LIMIT) throw new HttpError(413);
            $req->parseBody();
            $result = ($match['route']['handler'])($req, $this);
            $res = $result instanceof Response ? $result : Response::json($result);
            if ($res->isJson && $res->status < 400) $res->data = $this->filterConfidential($req, $res->data);
        } catch (\Throwable $e) {
            $res = $this->errorResponse($e, $req);
        }
        if ($limits) {
            $res->header('x-ratelimit-limit', (string) $limits['limit'])
                ->header('x-ratelimit-remaining', (string) $limits['remaining'])
                ->header('x-ratelimit-reset', (string) $limits['reset']);
            if ($res->status === 429) $res->header('retry-after', (string) $limits['reset']);
        }
        return $res;
    }

    /**
     * Upgrades without SSH: after new files are uploaded, the first API request applies pending migrations
     * (under a MySQL named lock). A marker file in LOG_DIR keeps this to one stat + one read per request.
     */
    private function ensureSchema(): void
    {
        $dir = $this->config->str('ROOT') . '/migrations';
        $files = glob($dir . '/[0-9][0-9][0-9][0-9]_*.php') ?: [];
        if (!$files) return;
        sort($files);
        $latest = basename((string) end($files), '.php');
        $logDir = $this->config->str('LOG_DIR');
        $marker = $logDir . '/.schema-' . substr(hash('sha256', $this->config->str('DB_HOST') . '/' . $this->config->str('DB_NAME')), 0, 16);
        if (is_file($marker) && @file_get_contents($marker) === $latest) return;
        $db = $this->db();
        try {
            $db->pdo();
        } catch (\PDOException) {
            return; // database unreachable: /health reports it (503), other routes fail on their own
        }
        if ((int) $db->value('SELECT GET_LOCK(?, 60)', ['vitral_migrate']) !== 1) throw new \RuntimeException('could not acquire the migration lock');
        try {
            $m = new Migrator($db, $dir);
            $ran = $m->migrate();
            if ($ran) Log::info('migrations applied', ['names' => $ran, 'warnings' => $m->warnings]);
        } finally {
            $db->value('SELECT RELEASE_LOCK(?)', ['vitral_migrate']);
        }
        if (is_dir($logDir) || @mkdir($logDir, 0700, true)) @file_put_contents($marker, $latest);
    }

    private function resolveUser(Request $req): void
    {
        // Telegram bot service acts for a linked user: service key + user id headers (spec §16), never a session.
        $botKey = $req->header('x-bot-key');
        $serviceKey = (string) ($this->config->get('BOT_SERVICE_KEY') ?? '');
        if ($botKey !== null && $serviceKey !== '' && strlen($botKey) === strlen($serviceKey) && hash_equals($serviceKey, $botKey)) {
            $uid = $req->header('x-bot-user');
            $req->user = $uid !== null ? Auth::loadBotUser($this->db(), $uid) : null;
            return;
        }
        $token = $req->cookies[Auth::SESSION_COOKIE] ?? null;
        $req->user = $token === null ? null : Auth::loadSessionUser($this->db(), $this->config->str('SESSION_SECRET'), $token);
    }

    /** A mutating API call must come from our own origin, or carry `X-Requested-With: vitral` when there is no Origin. */
    private function checkCsrf(Request $req): void
    {
        if (!in_array($req->method, self::MUTATING, true)) return;
        $origin = $req->header('origin');
        if ($origin === null && ($ref = $req->header('referer')) !== null) {
            $p = parse_url($ref);
            if (!$p || !isset($p['scheme'], $p['host'])) throw new HttpError(500);
            $origin = $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
        }
        if ($origin === null) {
            if ($req->header('x-requested-with') !== 'vitral') throw new AppError('forbidden', 'درخواست از مبدأ نامعتبر');
            return;
        }
        $allowed = [];
        $host = $req->header('host');
        if ($host) {
            $allowed[] = "https://{$host}";
            if (!$this->config->bool('COOKIE_SECURE')) $allowed[] = "http://{$host}";
        }
        if ($this->config->get('APP_ORIGIN')) $allowed[] = rtrim((string) $this->config->get('APP_ORIGIN'), '/');
        if (!in_array($origin, $allowed, true)) throw new AppError('forbidden', 'درخواست از مبدأ نامعتبر');
    }

    /** Principle 6 safety net: no confidential key reaches a user without finance.view, whatever the route. */
    private function filterConfidential(Request $req, mixed $data): mixed
    {
        $data = Json::normalize($data);
        if ($req->can('finance.view')) return $data;
        $leaks = Confidential::find($data);
        if ($leaks) {
            Log::error('confidential key stripped from response', ['leaks' => $leaks, 'url' => $req->path, 'reqId' => $req->id]);
            return Confidential::strip($data);
        }
        return $data;
    }

    private function errorResponse(\Throwable $e, ?Request $req): Response
    {
        if ($e instanceof AppError) return Response::json($e->body(), $e->status);
        if ($e instanceof HttpError) {
            if ($e->status === 429) return Response::json(['error' => ['code' => 'rate_limited', 'message' => 'درخواست‌ها زیاد است؛ کمی بعد تلاش کنید']], 429);
            if ($e->status === 413) {
                return Response::json(['error' => ['code' => 'validation', 'message' => 'حجم فایل بیش از ۲۰ مگابایت است', 'fields' => ['file' => 'حداکثر ۲۰ مگابایت']]], 400);
            }
            if ($e->status >= 400 && $e->status < 500) return Response::json(['error' => ['code' => 'validation', 'message' => 'درخواست نامعتبر است']], $e->status);
        }
        $id = $req?->id ?? Db::uuid();
        Log::error('unhandled error', [
            'reqId' => $id,
            'method' => $req?->method,
            'url' => $req?->path,
            'err' => ['message' => $e->getMessage(), 'class' => get_class($e), 'file' => $e->getFile() . ':' . $e->getLine(), 'stack' => $e->getTraceAsString()],
        ]);
        return Response::json(['error' => ['code' => 'validation', 'message' => "خطای داخلی؛ شناسه درخواست {$id}"]], 500);
    }

    // ---------------------------------------------------------------- web app

    private const STATIC_TYPES = [
        'js' => 'text/javascript; charset=utf-8', 'mjs' => 'text/javascript; charset=utf-8', 'css' => 'text/css; charset=utf-8',
        'html' => 'text/html; charset=utf-8', 'svg' => 'image/svg+xml', 'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
        'webp' => 'image/webp', 'ico' => 'image/x-icon', 'gif' => 'image/gif', 'woff2' => 'font/woff2', 'woff' => 'font/woff', 'ttf' => 'font/ttf',
        'webmanifest' => 'application/manifest+json', 'txt' => 'text/plain; charset=utf-8', 'map' => 'application/json',
    ];

    /** The built SPA: an existing file is sent as is, every other path gets index.html (client-side routes). */
    public function serveWeb(string $path): Response
    {
        $dir = $this->config->get('WEB_DIST_DIR') ?: (defined('VITRAL_WEB_DIR') ? VITRAL_WEB_DIR : $this->config->str('ROOT'));
        $dir = rtrim((string) $dir, '/');
        $rel = ltrim(rawurldecode($path), '/');
        if ($rel !== '' && !preg_match('#(^|/)\.|^(src|data|migrations|bin|dev|tests)(/|$)|\.php$#i', $rel)) {
            $abs = realpath($dir . '/' . $rel);
            $ext = strtolower(pathinfo($rel, PATHINFO_EXTENSION));
            $root = realpath($dir);
            if ($abs !== false && $root !== false && str_starts_with($abs, $root . DIRECTORY_SEPARATOR) && is_file($abs) && isset(self::STATIC_TYPES[$ext])) {
                return Response::file($abs, self::STATIC_TYPES[$ext])
                    ->header('cache-control', str_starts_with($rel, 'assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
            }
        }
        $index = $dir . '/index.html';
        if (!is_file($index)) return Response::raw('Not found', 'text/plain; charset=utf-8', 404);
        return Response::file($index, 'text/html; charset=utf-8')->header('cache-control', 'no-cache');
    }

    /** The headers @fastify/helmet sets in apps/server/src/app.ts. */
    public function securityHeaders(Response $res): void
    {
        $h = [
            'content-security-policy' => "default-src 'self';script-src 'self';style-src 'self';img-src 'self' blob: data:;font-src 'self';connect-src 'self';media-src 'self' blob:;manifest-src 'self';worker-src 'self';frame-ancestors 'none';base-uri 'self';form-action 'self';object-src 'none'",
            'cross-origin-opener-policy' => 'same-origin',
            'cross-origin-resource-policy' => 'same-origin',
            'origin-agent-cluster' => '?1',
            'referrer-policy' => 'no-referrer',
            'x-content-type-options' => 'nosniff',
            'x-dns-prefetch-control' => 'off',
            'x-download-options' => 'noopen',
            'x-frame-options' => 'SAMEORIGIN',
            'x-permitted-cross-domain-policies' => 'none',
            'x-xss-protection' => '0',
        ];
        if ($this->config->bool('COOKIE_SECURE')) $h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
        foreach ($h as $k => $v) $res->headers[$k] ??= $v;
    }
}
