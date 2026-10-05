<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * Minimal JSON-lines log under LOG_DIR (data/logs, denied to the web). Personal data never reaches the log:
 * no headers, cookies or bodies — method, path without query, status, request id, error message/stack.
 */
final class Log
{
    private static ?string $dir = null;

    public static function init(string $dir): void
    {
        self::$dir = $dir;
    }

    /** @param array<string,mixed> $ctx */
    public static function write(string $level, string $msg, array $ctx = []): void
    {
        $line = Json::encode(['time' => gmdate('Y-m-d\TH:i:s\Z'), 'level' => $level, 'msg' => $msg] + $ctx) . "\n";
        $dir = self::$dir;
        if ($dir !== null && (is_dir($dir) || @mkdir($dir, 0700, true))) {
            @file_put_contents($dir . '/app-' . gmdate('Y-m') . '.log', $line, FILE_APPEND | LOCK_EX);
            return;
        }
        error_log(rtrim($line));
    }

    public static function error(string $msg, array $ctx = []): void { self::write('error', $msg, $ctx); }
    public static function warn(string $msg, array $ctx = []): void { self::write('warn', $msg, $ctx); }
    public static function info(string $msg, array $ctx = []): void { self::write('info', $msg, $ctx); }
}
