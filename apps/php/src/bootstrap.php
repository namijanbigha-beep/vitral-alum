<?php
declare(strict_types=1);

/**
 * Bootstrap shared by the front controller, the installer and the CLI scripts:
 * PSR-4 autoloader for `Vitral\` → src/, UTC clock, UTF-8 strings, warnings as exceptions.
 * No Composer: shared hosts cannot run it.
 */

if (PHP_VERSION_ID < 80100) {
    http_response_code(500);
    echo 'Vitral needs PHP 8.1 or newer.';
    exit(1);
}

define('VITRAL_SRC', __DIR__);
define('VITRAL_ROOT', dirname(__DIR__));

spl_autoload_register(static function (string $class): void {
    if (strncmp($class, 'Vitral\\', 7) !== 0) return;
    $rel = str_replace('\\', '/', substr($class, 7));
    $file = VITRAL_SRC . '/' . $rel . '.php';
    if (is_file($file)) require $file;
});

date_default_timezone_set('UTC');
if (function_exists('mb_internal_encoding')) mb_internal_encoding('UTF-8');
ini_set('serialize_precision', '-1');

set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) return false;
    throw new ErrorException($message, 0, $severity, $file, $line);
});
