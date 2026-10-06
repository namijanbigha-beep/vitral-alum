<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\AuthUser;
use Vitral\Core\Db;
use Vitral\Core\Log;
use Vitral\Core\Request;
use Vitral\Core\Router;
use Vitral\Core\V;
use Vitral\Lib\Zip;

/**
 * Self-update for shared hosting (PHP edition only): the manager installs a newer vitral-app.zip from the GitHub
 * releases of the project's repository without cPanel access. A release carries two assets, vitral-app.zip and
 * vitral-app.zip.sha256 (built by .github/workflows/release-php.yml); the zip is refused unless its SHA-256 matches.
 *
 * What an update never touches: config.php (secrets), data/ (files, logs, install lock) and install.php (the installer
 * stays deleted). Files that disappear from src/ and assets/ in the new release are removed, because modules are
 * auto-discovered and an old one would keep loading. The replaced code is kept as a zip in the update folder for a
 * manual rollback, and database migrations run on the next request (App::ensureSchema).
 */
final class Update
{
    public const ASSET = 'vitral-app.zip';
    public const DEFAULT_REPO = 'namijanbigha-beep/vitral-alum';
    private const MAX_BYTES = 52428800;
    private const KEEP_FILES = ['config.php', 'install.php'];
    private const KEEP_DIRS = ['data/'];
    private const OWNED_DIRS = ['src/', 'assets/'];
    private const REQUIRED = ['index.php', 'src/bootstrap.php', 'src/version.php'];
    private const BACKUPS_KEPT = 3;

    public static function register(Router $r, App $app): void
    {
        $r->get('/update', static function (Request $req) use ($app) {
            self::requireOwner($req);
            $s = self::settings($app);
            return [
                'current' => self::currentVersion(),
                'supported' => self::supported(),
                'repo' => $s['repo'],
                'has_token' => $s['token'] !== '',
                'writable' => self::supported() && self::writable(),
            ];
        });

        $r->post('/update/settings', static function (Request $req) use ($app) {
            $me = self::requireOwner($req);
            $body = V::object([
                'repo' => V::string()->trim()->regex('/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/', 'نام مخزن باید مثل owner/repo باشد'),
                'token' => V::string()->trim()->max(400)->nullable()->optional(),
            ])->parse($req->body());
            $s = self::settings($app);
            $s['repo'] = $body['repo'];
            if (array_key_exists('token', $body)) $s['token'] = (string) ($body['token'] ?? '');
            self::saveSettings($app, $s);
            $app->db()->transaction(static fn (Db $trx) => Audit::log($trx, ['userId' => $me->id, 'entity' => 'app', 'entityId' => null, 'action' => 'update_settings', 'after' => ['repo' => $s['repo'], 'has_token' => $s['token'] !== '']]));
            return ['repo' => $s['repo'], 'has_token' => $s['token'] !== ''];
        });

        $r->get('/update/latest', static function (Request $req) use ($app) {
            self::requireOwner($req);
            $s = self::settings($app);
            $rel = self::release($s, null);
            $current = self::currentVersion();
            return [
                'current' => $current,
                'tag' => $rel['tag'],
                'name' => $rel['name'],
                'notes' => $rel['notes'],
                'published_at' => $rel['published_at'],
                'size' => (string) $rel['size'],
                'is_newer' => $rel['tag'] !== $current,
            ];
        });

        $r->post('/update/apply', static function (Request $req) use ($app) {
            $me = self::requireOwner($req);
            $body = V::object(['tag' => V::string()->trim()->regex('/^[A-Za-z0-9._-]{1,64}$/', 'نسخه نامعتبر است')])->parse($req->body());
            if (!self::supported()) throw new AppError('validation', 'این نصب از راه برنامه به‌روز نمی‌شود');
            return self::apply($app, $me, $body['tag']);
        });
    }

    private static function requireOwner(Request $req): AuthUser
    {
        $me = $req->requirePermission('settings.manage');
        if ($me->role !== 'manager') throw new AppError('forbidden', 'فقط مدیر می‌تواند برنامه را به‌روز کند');
        return $me;
    }

    public static function currentVersion(): string
    {
        $f = VITRAL_ROOT . '/src/version.php';
        if (!is_file($f)) return 'dev';
        $v = require $f;
        return is_string($v) && $v !== '' ? $v : 'dev';
    }

    /** Only the zip layout (index.php next to src/, as unpacked into public_html/app) updates itself; never a checkout. */
    public static function supported(): bool
    {
        return is_file(VITRAL_ROOT . '/index.php') && is_file(VITRAL_ROOT . '/src/bootstrap.php') && !is_dir(VITRAL_ROOT . '/public');
    }

    private static function writable(): bool
    {
        foreach (['', '/src', '/assets'] as $d) {
            $p = VITRAL_ROOT . $d;
            if (is_dir($p) && !is_writable($p)) return false;
        }
        return true;
    }

    // ------------------------------------------------------------------ settings (kept out of the database and web root)

    private static function stateDir(App $app): string
    {
        $backup = $app->config->str('BACKUP_DIR');
        $dir = $backup !== '' ? dirname(rtrim($backup, '/')) . '/update' : VITRAL_ROOT . '/data/update';
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new \RuntimeException("update folder {$dir} could not be created");
        return $dir;
    }

    /** @return array{repo:string,token:string} */
    private static function settings(App $app): array
    {
        $raw = @file_get_contents(self::stateDir($app) . '/settings.php');
        $s = $raw !== false ? json_decode((string) preg_replace('/^<\?php exit; \?>\n/', '', $raw), true) : null;
        return [
            'repo' => is_array($s) && is_string($s['repo'] ?? null) && $s['repo'] !== '' ? $s['repo'] : self::DEFAULT_REPO,
            'token' => is_array($s) && is_string($s['token'] ?? null) ? $s['token'] : '',
        ];
    }

    /** @param array{repo:string,token:string} $s */
    private static function saveSettings(App $app, array $s): void
    {
        // a .php file that exits first: even if the folder were ever served, the token would not be readable
        $file = self::stateDir($app) . '/settings.php';
        $tmp = $file . '.tmp';
        if (@file_put_contents($tmp, "<?php exit; ?>\n" . json_encode($s, JSON_UNESCAPED_SLASHES), LOCK_EX) === false || !@rename($tmp, $file)) {
            throw new \RuntimeException('update settings could not be written');
        }
        @chmod($file, 0600);
    }

    // ------------------------------------------------------------------ GitHub

    /**
     * @param array{repo:string,token:string} $s
     * @return array{tag:string,name:string,notes:string,published_at:?string,size:int,zip_url:string,sha_url:string}
     */
    private static function release(array $s, ?string $tag): array
    {
        $path = $tag === null ? 'releases/latest' : 'releases/tags/' . rawurlencode($tag);
        $res = self::http('https://api.github.com/repos/' . $s['repo'] . '/' . $path, 'application/vnd.github+json', $s['token'], 1048576);
        if ($res['status'] === 404) {
            throw new AppError('not_found', $s['token'] === ''
                ? "نسخه‌ای در مخزن {$s['repo']} پیدا نشد. اگر مخزن خصوصی است، توکن دسترسی را وارد کنید."
                : "نسخه‌ای در مخزن {$s['repo']} پیدا نشد.");
        }
        if ($res['status'] === 401 || $res['status'] === 403) throw new AppError('validation', 'GitHub اجازه نداد (' . $res['status'] . '). توکن یا نام مخزن را بررسی کنید.');
        if ($res['status'] !== 200) throw new AppError('validation', 'پاسخ GitHub نامعتبر بود (' . $res['status'] . ')');
        $j = json_decode($res['body'], true);
        if (!is_array($j) || !is_string($j['tag_name'] ?? null)) throw new AppError('validation', 'پاسخ GitHub نامعتبر بود');
        $zip = $sha = null;
        foreach (is_array($j['assets'] ?? null) ? $j['assets'] : [] as $a) {
            if (($a['name'] ?? null) === self::ASSET) $zip = $a;
            if (($a['name'] ?? null) === self::ASSET . '.sha256') $sha = $a;
        }
        if (!$zip || !$sha || !is_string($zip['url'] ?? null) || !is_string($sha['url'] ?? null)) {
            throw new AppError('validation', "نسخه‌ی {$j['tag_name']} فایل " . self::ASSET . ' و ' . self::ASSET . '.sha256 را ندارد');
        }
        return [
            'tag' => $j['tag_name'],
            'name' => is_string($j['name'] ?? null) && $j['name'] !== '' ? $j['name'] : $j['tag_name'],
            'notes' => is_string($j['body'] ?? null) ? mb_substr($j['body'], 0, 4000) : '',
            'published_at' => is_string($j['published_at'] ?? null) ? $j['published_at'] : null,
            'size' => (int) ($zip['size'] ?? 0),
            'zip_url' => $zip['url'],
            'sha_url' => $sha['url'],
        ];
    }

    /**
     * HTTPS GET with redirects followed by hand, so the token goes only to api.github.com and never to the storage
     * host a release download redirects to.
     * @return array{status:int,body:string}
     */
    private static function http(string $url, string $accept, string $token, int $maxBytes): array
    {
        $origin = (string) parse_url($url, PHP_URL_HOST);
        for ($hop = 0; $hop < 5; $hop++) {
            if (!str_starts_with($url, 'https://')) throw new AppError('validation', 'آدرس دانلود امن نیست');
            $headers = ['User-Agent' => 'vitral-updater', 'Accept' => $accept, 'X-GitHub-Api-Version' => '2022-11-28'];
            if ($token !== '' && parse_url($url, PHP_URL_HOST) === $origin) $headers['Authorization'] = 'Bearer ' . $token;
            $res = self::get($url, $headers, $maxBytes);
            if ($res['status'] >= 300 && $res['status'] < 400 && $res['location'] !== null) {
                $url = $res['location'];
                continue;
            }
            return ['status' => $res['status'], 'body' => $res['body']];
        }
        throw new AppError('validation', 'تعداد تغییر مسیرهای دانلود زیاد بود');
    }

    /**
     * @param array<string,string> $headers
     * @return array{status:int,body:string,location:?string}
     */
    private static function get(string $url, array $headers, int $maxBytes): array
    {
        $location = null;
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            if ($ch === false) throw new AppError('validation', 'curl در دسترس نیست');
            $h = [];
            foreach ($headers as $k => $v) $h[] = "{$k}: {$v}";
            $body = '';
            curl_setopt_array($ch, [
                CURLOPT_HTTPHEADER => $h,
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_TIMEOUT => 120,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
                CURLOPT_HEADERFUNCTION => static function ($c, string $line) use (&$location): int {
                    if (stripos($line, 'location:') === 0) $location = trim(substr($line, 9));
                    return strlen($line);
                },
                CURLOPT_WRITEFUNCTION => static function ($c, string $chunk) use (&$body, $maxBytes): int {
                    if (strlen($body) + strlen($chunk) > $maxBytes) return 0; // aborts the transfer
                    $body .= $chunk;
                    return strlen($chunk);
                },
            ]);
            $ok = curl_exec($ch);
            $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $err = curl_error($ch);
            curl_close($ch);
            if ($ok === false) {
                if (strlen($body) >= $maxBytes) throw new AppError('validation', 'فایل نسخه‌ی تازه بزرگ‌تر از حد مجاز است');
                throw new AppError('validation', 'اتصال هاست به GitHub برقرار نشد: ' . $err);
            }
            return ['status' => $status, 'body' => $body, 'location' => $location];
        }
        $h = '';
        foreach ($headers as $k => $v) $h .= "{$k}: {$v}\r\n";
        $ctx = stream_context_create(['http' => ['method' => 'GET', 'header' => $h, 'timeout' => 120, 'ignore_errors' => true, 'follow_location' => 0]]);
        $out = @file_get_contents($url, false, $ctx, 0, $maxBytes + 1);
        if ($out === false) throw new AppError('validation', 'اتصال هاست به GitHub برقرار نشد');
        if (strlen($out) > $maxBytes) throw new AppError('validation', 'فایل نسخه‌ی تازه بزرگ‌تر از حد مجاز است');
        $status = 0;
        foreach ($http_response_header ?? [] as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) $status = (int) $m[1];
            elseif (stripos($line, 'location:') === 0) $location = trim(substr($line, 9));
        }
        return ['status' => $status, 'body' => $out, 'location' => $location];
    }

    // ------------------------------------------------------------------ install

    /** @return array{from:string,to:string,files:int,removed:int} */
    private static function apply(App $app, AuthUser $me, string $tag): array
    {
        $dir = self::stateDir($app);
        $lock = fopen($dir . '/update.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) throw new AppError('conflict', 'به‌روزرسانی دیگری در حال انجام است');
        try {
            $s = self::settings($app);
            $rel = self::release($s, $tag);
            $zipRes = self::http($rel['zip_url'], 'application/octet-stream', $s['token'], self::MAX_BYTES);
            $shaRes = self::http($rel['sha_url'], 'application/octet-stream', $s['token'], 4096);
            if ($zipRes['status'] !== 200 || $shaRes['status'] !== 200) throw new AppError('validation', 'دانلود نسخه‌ی تازه کامل نشد');
            if (!preg_match('/^([0-9a-f]{64})\b/i', trim($shaRes['body']), $m) || !hash_equals(strtolower($m[1]), hash('sha256', $zipRes['body']))) {
                throw new AppError('validation', 'فایل دانلودشده با امضای نسخه نمی‌خواند؛ چیزی نصب نشد');
            }
            $files = self::entries($zipRes['body']);
            $from = self::currentVersion();
            self::backup($dir, $from, array_keys($files));
            $removed = self::install($files);
            if (function_exists('opcache_reset')) @opcache_reset();
            Log::info('app updated', ['from' => $from, 'to' => $rel['tag'], 'files' => count($files), 'removed' => $removed]);
            $app->db()->transaction(static fn (Db $trx) => Audit::log($trx, ['userId' => $me->id, 'entity' => 'app', 'entityId' => null, 'action' => 'app_update', 'before' => ['version' => $from], 'after' => ['version' => $rel['tag']]]));
            return ['from' => $from, 'to' => $rel['tag'], 'files' => count($files), 'removed' => $removed];
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    /** @return array<string,string> relative path → bytes, minus what an update must never touch. */
    public static function entries(string $zip): array
    {
        try {
            $raw = Zip::read($zip);
        } catch (\RuntimeException $e) {
            throw new AppError('validation', 'فایل نسخه‌ی تازه خراب است: ' . $e->getMessage());
        }
        $out = [];
        foreach ($raw as $name => $data) {
            $name = (string) $name;
            if (str_ends_with($name, '/')) continue;
            if ($name === '' || str_contains($name, "\0") || str_contains($name, '\\') || str_starts_with($name, '/') || preg_match('#(^|/)\.\.(/|$)#', $name) || preg_match('/^[A-Za-z]:/', $name)) {
                throw new AppError('validation', 'فایل نسخه‌ی تازه مسیر نامعتبر دارد');
            }
            if (in_array($name, self::KEEP_FILES, true)) continue;
            foreach (self::KEEP_DIRS as $d) if (str_starts_with($name, $d)) continue 2;
            $out[$name] = $data;
        }
        foreach (self::REQUIRED as $f) if (!isset($out[$f])) throw new AppError('validation', "فایل نسخه‌ی تازه کامل نیست ({$f} ندارد)");
        return $out;
    }

    /** Zip of the code about to be replaced or removed, for a manual rollback; keeps the last few. @param list<string> $incoming */
    private static function backup(string $dir, string $version, array $incoming): void
    {
        $paths = $incoming;
        foreach (self::OWNED_DIRS as $d) foreach (self::listFiles(VITRAL_ROOT . '/' . $d) as $rel) $paths[] = $d . $rel;
        $entries = [];
        foreach (array_unique($paths) as $p) {
            $abs = VITRAL_ROOT . '/' . $p;
            if (is_file($abs)) $entries[] = ['name' => $p, 'data' => (string) file_get_contents($abs)];
        }
        $name = $dir . '/before-' . preg_replace('/[^A-Za-z0-9._-]/', '_', $version) . '-' . gmdate('Ymd-His') . '.zip';
        if (@file_put_contents($name, Zip::buildZip($entries)) === false) throw new AppError('validation', 'نسخه‌ی پشتیبان کد ساخته نشد؛ چیزی نصب نشد');
        $old = glob($dir . '/before-*.zip') ?: [];
        usort($old, static fn ($a, $b) => filemtime($b) <=> filemtime($a));
        foreach (array_slice($old, self::BACKUPS_KEPT) as $f) @unlink($f);
    }

    /**
     * Writes every file beside its target first, then renames them into place, so a failed write leaves the old
     * version running. @param array<string,string> $files @return int files removed
     */
    public static function install(array $files, string $root = VITRAL_ROOT): int
    {
        $staged = [];
        try {
            foreach ($files as $rel => $data) {
                $abs = $root . '/' . $rel;
                $d = dirname($abs);
                if (!is_dir($d) && !@mkdir($d, 0755, true) && !is_dir($d)) throw new AppError('validation', "پوشه {$rel} ساخته نشد");
                $tmp = $abs . '.vitral-new';
                if (@file_put_contents($tmp, $data) === false) throw new AppError('validation', "فایل {$rel} نوشته نشد؛ چیزی نصب نشد");
                $staged[$tmp] = $abs;
            }
        } catch (\Throwable $e) {
            foreach (array_keys($staged) as $tmp) @unlink($tmp);
            throw $e;
        }
        // bootstrap and the front controller last: until then requests keep entering through the old ones
        $last = [$root . '/index.php', $root . '/src/bootstrap.php'];
        uksort($staged, static fn ($a, $b) => (int) in_array($staged[$a], $last, true) <=> (int) in_array($staged[$b], $last, true));
        foreach ($staged as $tmp => $abs) {
            if (!@rename($tmp, $abs)) throw new AppError('validation', "فایل {$abs} جایگزین نشد");
            if (function_exists('opcache_invalidate')) @opcache_invalidate($abs, true);
        }
        $removed = 0;
        foreach (self::OWNED_DIRS as $d) {
            foreach (self::listFiles($root . '/' . $d) as $rel) {
                if (!isset($files[$d . $rel]) && @unlink($root . '/' . $d . $rel)) $removed++;
            }
        }
        return $removed;
    }

    /** @return list<string> files under $dir, relative to it */
    private static function listFiles(string $dir): array
    {
        if (!is_dir($dir)) return [];
        $out = [];
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS));
        foreach ($it as $f) {
            if ($f->isFile()) $out[] = str_replace('\\', '/', substr($f->getPathname(), strlen(rtrim($dir, '/')) + 1));
        }
        return $out;
    }
}
