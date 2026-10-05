<?php
declare(strict_types=1);

/**
 * Front controller. On the host this file sits in public_html/app/ next to src/, migrations/ and the built
 * web app; in the repository it is apps/php/public/index.php with src/ one level up.
 *   /api/v1/*  → the JSON API (src/Core/App.php)
 *   anything else → a static file of the web app, or its index.html (client-side routes)
 */
$root = is_file(__DIR__ . '/src/bootstrap.php') ? __DIR__ : dirname(__DIR__);
require $root . '/src/bootstrap.php';

use Vitral\Core\App;

// Base path the app is mounted under («/app» for public_html/app/), from the script's own URL.
$base = defined('VITRAL_BASE')
    ? (string) VITRAL_BASE
    : rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/index.php'))), '/');
if (!defined('VITRAL_WEB_DIR') && is_file(__DIR__ . '/index.html')) define('VITRAL_WEB_DIR', __DIR__);

$app = App::fromRoot(VITRAL_ROOT);

if (!$app->config->installed()) {
    $path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    if (!str_starts_with(substr($path, strlen($base)), '/api/') && is_file(__DIR__ . '/install.php')) {
        header('Location: ' . $base . '/install.php', true, 302);
        exit;
    }
}

$app->run($base);
