<?php
declare(strict_types=1);

/**
 * Router for PHP's built-in server — development and the conformance tests only (never shipped: build.sh leaves it out).
 *   php -S 127.0.0.1:8080 apps/php/public/router-dev.php
 * Serves the API at /api/v1, the web app from WEB_DIST_DIR (default apps/web/dist) and, when
 * VITRAL_TEST_BRIDGE_KEY is set, the test bridge at /__test/* (dev/TestBridge.php).
 */
if (PHP_SAPI !== 'cli-server') {
    http_response_code(404);
    exit;
}
define('VITRAL_BASE', '');
$web = getenv('WEB_DIST_DIR') ?: dirname(__DIR__, 2) . '/web/dist';
if (is_dir($web)) define('VITRAL_WEB_DIR', $web);

$path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
if (str_starts_with($path, '/__test/')) {
    require dirname(__DIR__) . '/dev/TestBridge.php';
    return true;
}
// The two stand-alone entry points of the shared-hosting build (served by the web server itself in production).
if ($path === '/telegram.php' || $path === '/cron.php') {
    require __DIR__ . $path;
    return true;
}
require __DIR__ . '/index.php';
return true;
