<?php
declare(strict_types=1);

/**
 * One-time installer for shared hosting (no SSH): checks the host, writes config.php with fresh secrets,
 * creates the tables, creates the first manager, then deletes itself (or, if the host forbids that,
 * locks itself with data/install.lock). Refuses to run again once config.php exists.
 */
$root = is_file(__DIR__ . '/src/bootstrap.php') ? __DIR__ : dirname(__DIR__);
require $root . '/src/bootstrap.php';

use Vitral\Core\Auth;
use Vitral\Core\Config;
use Vitral\Core\Db;
use Vitral\Core\Migrator;
use Vitral\Core\V;

header('Content-Type: text/html; charset=utf-8');
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');
header('Cache-Control: no-store');
header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'");

$lock = VITRAL_ROOT . '/data/install.lock';
$configFile = Config::file(VITRAL_ROOT);
$h = static fn (?string $s): string => htmlspecialchars((string) $s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
$base = rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/install.php'))), '/');

$page = static function (string $title, string $body) use ($h): void {
    echo '<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
        '<meta name="robots" content="noindex"><title>', $h($title), '</title><style>',
        'body{font-family:Vazirmatn,Tahoma,sans-serif;background:#f4f5f7;color:#1f2328;margin:0;padding:16px;line-height:1.7}',
        'main{max-width:640px;margin:24px auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px #0002}',
        'h1{font-size:1.3rem;margin-top:0}fieldset{border:1px solid #d0d7de;border-radius:8px;margin:0 0 16px;padding:12px 16px}',
        'legend{font-weight:bold;padding:0 6px}label{display:block;margin:8px 0 2px;font-size:.92rem}',
        'input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #c4c9d0;border-radius:6px;font:inherit;direction:ltr;text-align:left}',
        'button{background:#0b5cad;color:#fff;border:0;border-radius:8px;padding:10px 20px;font:inherit;cursor:pointer}',
        '.err{background:#ffebe9;border:1px solid #ff8182;padding:8px 12px;border-radius:8px}.ok{background:#dafbe1;border:1px solid #4ac26b;padding:8px 12px;border-radius:8px}',
        '.warn{background:#fff8c5;border:1px solid #d4a72c;padding:8px 12px;border-radius:8px}small{color:#57606a}li{margin:2px 0}code{direction:ltr;unicode-bidi:embed}',
        '</style></head><body><main>', $body, '</main></body></html>';
};

if (is_file($lock) || (is_file($configFile) && Config::load(VITRAL_ROOT)->installed())) {
    @unlink(__FILE__);
    http_response_code(403);
    $page('نصب شده است', '<h1>برنامه قبلاً نصب شده است</h1><p>نصب‌کننده غیرفعال است. برای نصب دوباره، فایل <code>config.php</code> و <code>data/install.lock</code> را پاک کنید.</p><p><a href="' . $h($base . '/') . '">ورود به برنامه</a></p>');
    exit;
}

// --- host checks -------------------------------------------------------------------------------------------
$checks = [
    ['PHP 8.1 یا بالاتر', PHP_VERSION_ID >= 80100, PHP_VERSION, true],
    ['PDO MySQL', extension_loaded('pdo_mysql'), '', true],
    ['mbstring', extension_loaded('mbstring'), '', true],
    ['GD (پردازش عکس)', function_exists('imagecreatefromstring'), '', false],
    ['GD با WebP (پیش‌نمایش عکس)', function_exists('imagewebp'), '', false],
    ['zlib (فایل XLSX)', function_exists('gzinflate'), '', false],
    ['Argon2id (رمزها)', defined('PASSWORD_ARGON2ID'), defined('PASSWORD_ARGON2ID') ? '' : 'از bcrypt استفاده می‌شود', false],
    ['نوشتن در پوشه برنامه', is_writable(VITRAL_ROOT), VITRAL_ROOT, true],
];
$fatal = array_filter($checks, static fn ($c) => !$c[1] && $c[3]);

// Prefer a data folder outside the web root (the parent of public_html), else data/ (denied by .htaccess).
$docRoot = rtrim(str_replace('\\', '/', (string) ($_SERVER['DOCUMENT_ROOT'] ?? '')), '/');
$outside = $docRoot !== '' ? dirname($docRoot) . '/vitral-data' : '';
$defaultData = ($outside !== '' && (is_dir($outside) ? is_writable($outside) : is_writable(dirname($outside)))) ? $outside : VITRAL_ROOT . '/data';

$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
$host = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
$origin = ($https ? 'https://' : 'http://') . $host;

session_name('vt_install');
session_set_cookie_params(['httponly' => true, 'samesite' => 'Strict', 'secure' => $https, 'path' => $base . '/']);
session_start();
$_SESSION['csrf'] ??= bin2hex(random_bytes(32));

$f = [
    'db_host' => 'localhost', 'db_port' => '3306', 'db_name' => '', 'db_user' => '', 'db_pass' => '',
    'mobile' => '', 'name' => '', 'password' => '', 'password2' => '', 'telegram' => '', 'data_dir' => $defaultData,
];
$errors = [];

if ($_SERVER['REQUEST_METHOD'] === 'POST' && !$fatal) {
    foreach ($f as $k => $v) $f[$k] = trim((string) ($_POST[$k] ?? ''));
    if (!hash_equals($_SESSION['csrf'], (string) ($_POST['csrf'] ?? ''))) $errors[] = 'فرم منقضی شده است؛ صفحه را دوباره باز کنید.';
    foreach (['db_host' => 'میزبان پایگاه داده', 'db_name' => 'نام پایگاه داده', 'db_user' => 'کاربر پایگاه داده', 'name' => 'نام مدیر', 'data_dir' => 'پوشه داده‌ها'] as $k => $label) {
        if ($f[$k] === '') $errors[] = "«{$label}» لازم است.";
    }
    $mobile = V::mobile()->safeParse($f['mobile']);
    if (!$mobile['success']) $errors[] = 'شماره موبایل باید ۱۱ رقم و با ۰۹ شروع شود.';
    $password = (string) ($_POST['password'] ?? '');
    if (mb_strlen($password) < 8) $errors[] = 'رمز مدیر باید حداقل ۸ نویسه باشد.';
    if ($password !== (string) ($_POST['password2'] ?? '')) $errors[] = 'تکرار رمز با خود رمز یکی نیست.';
    if ($f['telegram'] !== '' && !preg_match('/^\d{5,15}:[A-Za-z0-9_-]{30,}$/', $f['telegram'])) $errors[] = 'توکن ربات تلگرام درست نیست.';
    if (!preg_match('/^[A-Za-z0-9_$-]{1,64}$/', $f['db_name'])) $errors[] = 'نام پایگاه داده فقط حروف لاتین، عدد و _ باشد.';

    $dataDir = rtrim($f['data_dir'], '/');
    if (!$errors) {
        foreach (['', '/files', '/backups', '/logs'] as $sub) {
            $d = $dataDir . $sub;
            if (!is_dir($d) && !@mkdir($d, 0700, true)) $errors[] = "پوشه «{$d}» ساخته نشد.";
        }
        if (!$errors && !is_writable($dataDir)) $errors[] = "پوشه «{$dataDir}» قابل نوشتن نیست.";
        if (!$errors && str_starts_with(realpath($dataDir) ?: $dataDir, (realpath(VITRAL_ROOT) ?: VITRAL_ROOT) . '/')) {
            // inside the app folder: make sure Apache denies it even if it is not data/
            if (!is_file($dataDir . '/.htaccess')) @file_put_contents($dataDir . '/.htaccess', "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n");
        }
    }

    if (!$errors) {
        $values = [
            'APP_ENV' => 'production',
            'DB_HOST' => $f['db_host'],
            'DB_PORT' => $f['db_port'] !== '' ? $f['db_port'] : '3306',
            'DB_NAME' => $f['db_name'],
            'DB_USER' => $f['db_user'],
            'DB_PASS' => (string) ($_POST['db_pass'] ?? ''), // not trimmed: a password may contain spaces
            'SESSION_SECRET' => bin2hex(random_bytes(32)),
            'BOT_SERVICE_KEY' => bin2hex(random_bytes(24)),
            'BACKUP_ENCRYPTION_KEY' => bin2hex(random_bytes(32)),
            'FILE_STORAGE_DIR' => $dataDir . '/files',
            'BACKUP_DIR' => $dataDir . '/backups',
            'LOG_DIR' => $dataDir . '/logs',
            'COOKIE_SECURE' => $https,
            'APP_ORIGIN' => $origin,
            'PUBLIC_URL' => $origin . $base,
            'TELEGRAM_BOT_TOKEN' => $f['telegram'] !== '' ? $f['telegram'] : null,
        ];
        try {
            $db = Db::fromConfig(Config::fromArray($values, VITRAL_ROOT));
            $db->pdo();
        } catch (\Throwable $e) {
            $errors[] = 'اتصال به پایگاه داده برقرار نشد: ' . ($e instanceof \PDOException ? ($e->errorInfo[2] ?? $e->getMessage()) : $e->getMessage());
        }
    }

    if (!$errors) {
        try {
            $m = new Migrator($db, VITRAL_ROOT . '/migrations');
            $m->migrate();
            $hasUsers = (int) $db->value('SELECT COUNT(*) FROM users') > 0;
            if (!$hasUsers) {
                $db->insertNoReturn('users', [
                    'mobile' => $mobile['data'],
                    'name' => $f['name'],
                    'password_hash' => Auth::hashPassword($password),
                    'role' => 'manager',
                    'permissions' => [],
                ]);
            }
            $php = "<?php\n// Written by install.php on " . gmdate('Y-m-d H:i') . " UTC. Secret: database password and keys. Never share or publish this file.\nreturn " . var_export($values, true) . ";\n";
            $tmp = $configFile . '.tmp';
            if (@file_put_contents($tmp, $php, LOCK_EX) === false || !@rename($tmp, $configFile)) throw new \RuntimeException('config.php could not be written');
            @chmod($configFile, 0600);
            @file_put_contents($lock, gmdate('c') . "\n");
            $deleted = @unlink(__FILE__);
            $_SESSION = [];
            session_destroy();
            $warn = $m->warnings ? '<div class="warn"><p>این موارد روی این هاست فعال نشد (برنامه بدون آن‌ها هم کار می‌کند):</p><ul><li>' . implode('</li><li>', array_map($h, $m->warnings)) . '</li></ul></div>' : '';
            $page('نصب انجام شد', '<h1>نصب انجام شد</h1><div class="ok"><p>جدول‌ها ساخته شد' . ($hasUsers ? '؛ کاربر مدیر از قبل وجود داشت و تغییری نکرد.' : ' و مدیر ساخته شد.') . '</p></div>' . $warn
                . ($deleted ? '<p>فایل نصب‌کننده پاک شد.</p>' : '<div class="warn"><p>فایل <code>install.php</code> پاک نشد؛ قفل شده است، ولی بهتر است آن را از File Manager پاک کنید.</p></div>')
                . '<p>پوشه داده‌ها: <code>' . $h($dataDir) . '</code></p><p><a href="' . $h($base . '/') . '">ورود به برنامه</a></p>');
            exit;
        } catch (\Throwable $e) {
            $errors[] = 'نصب کامل نشد: ' . $e->getMessage();
        }
    }
}

// --- form ----------------------------------------------------------------------------------------------------
$rows = '';
foreach ($checks as [$label, $ok, $note, $required]) {
    $rows .= '<li>' . ($ok ? '✔' : ($required ? '✘' : '⚠')) . ' ' . $h($label) . ($note !== '' ? ' <small>(' . $h($note) . ')</small>' : '') . '</li>';
}
$field = static fn (string $name, string $label, string $type = 'text', string $hint = '') => '<label for="' . $name . '">' . $label . '</label><input id="' . $name . '" name="' . $name . '" type="' . $type . '" value="' . ($type === 'password' ? '' : $h($f[$name])) . '" autocomplete="off">' . ($hint !== '' ? '<small>' . $hint . '</small>' : '');

$body = '<h1>نصب ویترال</h1><p>پیش‌نیازهای هاست:</p><ul>' . $rows . '</ul>';
if ($fatal) {
    $body .= '<div class="err">پیش‌نیازهای لازم (✘) روی این هاست نیست؛ از پنل هاست نسخه PHP یا افزونه‌ها را تنظیم کنید.</div>';
} else {
    if ($errors) $body .= '<div class="err"><ul><li>' . implode('</li><li>', array_map($h, $errors)) . '</li></ul></div>';
    $body .= '<form method="post" autocomplete="off"><input type="hidden" name="csrf" value="' . $h($_SESSION['csrf']) . '">'
        . '<fieldset><legend>پایگاه داده MySQL</legend><small>از بخش MySQL Databases در cPanel یک پایگاه داده و کاربر بسازید و کاربر را با همه دسترسی‌ها به آن اضافه کنید.</small>'
        . $field('db_host', 'میزبان') . $field('db_port', 'پورت') . $field('db_name', 'نام پایگاه داده') . $field('db_user', 'کاربر') . $field('db_pass', 'رمز', 'password') . '</fieldset>'
        . '<fieldset><legend>مدیر اصلی</legend>' . $field('mobile', 'شماره موبایل', 'text', 'مثل 09121234567') . $field('name', 'نام') . $field('password', 'رمز (حداقل ۸ نویسه)', 'password') . $field('password2', 'تکرار رمز', 'password') . '</fieldset>'
        . '<fieldset><legend>اختیاری</legend>' . $field('telegram', 'توکن ربات تلگرام', 'text', 'می‌توانید خالی بگذارید')
        . $field('data_dir', 'پوشه فایل‌ها، پشتیبان‌ها و گزارش‌ها', 'text', 'بهتر است بیرون از public_html باشد (پیشنهاد خودکار).') . '</fieldset>'
        . ($https ? '' : '<div class="warn">این صفحه با HTTPS باز نشده است. پیش از استفاده واقعی، گواهی SSL را در cPanel فعال کنید و برنامه را با https باز کنید.</div><p></p>')
        . '<button type="submit">نصب</button></form>';
}
$page('نصب ویترال', $body);
