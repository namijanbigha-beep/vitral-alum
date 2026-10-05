<?php
declare(strict_types=1);

/**
 * Scheduled jobs for hosts with cPanel Cron Jobs (the reliable way; the lazy cron in the request pipeline is the
 * fallback when no cron job exists):
 *
 *   * * * * *   /usr/local/bin/php -q /home/<user>/public_html/app/cron.php
 *
 * or, if only a URL can be fetched, set CRON_KEY in config.php and call
 *   https://<domain>/app/cron.php?key=<CRON_KEY>
 *
 * Jobs (src/Lib/Scheduler.php): the daily report snapshot after DAILY_REPORT_TIME Tehran, Telegram alerts and the
 * nightly report. A MySQL named lock keeps two triggers from running them twice.
 */
$root = is_file(__DIR__ . '/src/bootstrap.php') ? __DIR__ : dirname(__DIR__);
require $root . '/src/bootstrap.php';

use Vitral\Core\App;
use Vitral\Core\Json;
use Vitral\Lib\Scheduler;

$cli = PHP_SAPI === 'cli';
$app = App::fromRoot(VITRAL_ROOT);

if (!$cli) {
    $key = (string) ($app->config->get('CRON_KEY') ?? '');
    $given = (string) ($_GET['key'] ?? '');
    if ($key === '' || strlen($key) < 16 || !hash_equals($key, $given)) {
        http_response_code(404);
        header('Content-Type: application/json; charset=utf-8');
        echo '{"error":"not found"}';
        return;
    }
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
}

if (!$app->config->installed()) {
    if ($cli) {
        fwrite(STDERR, "vitral is not installed yet\n");
        exit(1);
    }
    http_response_code(503);
    echo '{"error":"not installed"}';
    return;
}

try {
    $out = Scheduler::run($app, $cli ? 'cli' : 'url');
    echo Json::encode($out), "\n";
} catch (\Throwable $e) {
    \Vitral\Core\Log::error('cron failed', ['err' => $e->getMessage(), 'class' => get_class($e)]);
    if ($cli) {
        fwrite(STDERR, 'cron failed: ' . $e->getMessage() . "\n");
        exit(1);
    }
    http_response_code(500);
    echo Json::encode(['error' => 'cron failed']), "\n";
}
