<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * Configuration — the same keys as apps/server/src/config.ts plus the MySQL connection.
 * Source: `config.php` (written by install.php, returns an array) next to src/; in development and in the
 * conformance tests, environment variables override it when VITRAL_CONFIG_FROM_ENV=1.
 * Secrets live only here, never in URLs or the database.
 */
final class Config
{
    public const DEFAULTS = [
        'APP_ENV' => 'production',
        'DB_HOST' => 'localhost',
        'DB_PORT' => '3306',
        'DB_NAME' => '',
        'DB_USER' => '',
        'DB_PASS' => '',
        'DB_SOCKET' => '',
        'SESSION_SECRET' => '',
        'FILE_STORAGE_DIR' => '',
        'BACKUP_DIR' => '',
        'BACKUP_ENCRYPTION_KEY' => null,
        'APP_ORIGIN' => null,
        'COOKIE_SECURE' => true,
        'SESSION_TTL_DAYS' => 14,
        'LOG_LEVEL' => 'info',
        'LOG_DIR' => '',
        'LOGIN_RATE_LIMIT_PER_MINUTE' => 20,
        'CHROMIUM_PATH' => null,
        'VAZIRMATN_PATH' => null,
        'BOT_SERVICE_KEY' => null,
        'TELEGRAM_BOT_TOKEN' => null,
        'PUBLIC_URL' => null,
        'DAILY_REPORT_TIME' => '21:00',
        /** Secret Telegram echoes on every webhook call; derived from BOT_SERVICE_KEY when empty. */
        'TELEGRAM_WEBHOOK_SECRET' => null,
        /** Proxy for api.telegram.org when the host cannot reach it directly, e.g. socks5h://127.0.0.1:1080. */
        'TELEGRAM_PROXY' => null,
        /** Bot API base; only for tests and self-hosted Bot API servers. */
        'TELEGRAM_API_URL' => null,
        /** Scheduled jobs after the response is sent: 'auto' (default), true, 'always' or false (use cron.php only). */
        'LAZY_CRON' => 'auto',
        /** Key that lets public/cron.php run from a URL (?key=…); CLI cron needs none. */
        'CRON_KEY' => null,
        /** Trust X-Forwarded-For for the client IP (only behind a proxy you control). */
        'TRUST_PROXY' => false,
        /** Directory of the built web app (index.html + assets); default: the front controller's directory. */
        'WEB_DIST_DIR' => null,
    ];

    private const BOOL_KEYS = ['COOKIE_SECURE', 'TRUST_PROXY'];
    private const INT_KEYS = ['SESSION_TTL_DAYS', 'LOGIN_RATE_LIMIT_PER_MINUTE'];

    /** @param array<string,mixed> $values */
    private function __construct(private array $values)
    {
    }

    /** Path of config.php for an installation root (the folder holding src/). */
    public static function file(string $root): string
    {
        return $root . '/config.php';
    }

    public static function load(string $root): self
    {
        $values = self::DEFAULTS;
        $file = self::file($root);
        if (is_file($file)) {
            $fromFile = require $file;
            if (is_array($fromFile)) $values = array_merge($values, $fromFile);
        }
        if (getenv('VITRAL_CONFIG_FROM_ENV') === '1') {
            foreach (array_keys(self::DEFAULTS) as $key) {
                $env = getenv($key);
                if ($env !== false) $values[$key] = $env;
            }
        }
        foreach (self::BOOL_KEYS as $k) {
            if (is_string($values[$k])) $values[$k] = $values[$k] === 'true' || $values[$k] === '1';
        }
        foreach (self::INT_KEYS as $k) $values[$k] = (int) $values[$k];
        foreach (['APP_ORIGIN', 'BOT_SERVICE_KEY', 'BACKUP_ENCRYPTION_KEY', 'PUBLIC_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_PROXY', 'TELEGRAM_API_URL', 'CRON_KEY', 'WEB_DIST_DIR'] as $k) {
            if ($values[$k] === '') $values[$k] = null;
        }
        if ($values['FILE_STORAGE_DIR'] === '') $values['FILE_STORAGE_DIR'] = $root . '/data/files';
        if ($values['BACKUP_DIR'] === '') $values['BACKUP_DIR'] = $root . '/data/backups';
        if ($values['LOG_DIR'] === '') $values['LOG_DIR'] = $root . '/data/logs';
        $values['ROOT'] = $root;
        return new self($values);
    }

    /** @param array<string,mixed> $values for tests and the installer */
    public static function fromArray(array $values, string $root): self
    {
        return new self(array_merge(self::DEFAULTS, $values, ['ROOT' => $root]));
    }

    public function installed(): bool
    {
        return $this->values['DB_NAME'] !== '' && strlen((string) $this->values['SESSION_SECRET']) >= 32;
    }

    public function get(string $key): mixed
    {
        return $this->values[$key] ?? null;
    }

    public function str(string $key): string
    {
        return (string) ($this->values[$key] ?? '');
    }

    public function int(string $key): int
    {
        return (int) ($this->values[$key] ?? 0);
    }

    public function bool(string $key): bool
    {
        return (bool) ($this->values[$key] ?? false);
    }

    public function isTest(): bool
    {
        return $this->values['APP_ENV'] === 'test';
    }
}
