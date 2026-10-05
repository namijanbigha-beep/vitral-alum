<?php
declare(strict_types=1);

namespace Vitral\Lib;

use Vitral\Core\App;
use Vitral\Core\Json;
use Vitral\Core\Log;
use Vitral\Lib\Telegram\Api;
use Vitral\Lib\Telegram\Jobs;
use Vitral\Lib\Telegram\Telegram;

/**
 * apps/server/src/scheduler.ts + the timers of apps/bot/src/main.ts, without a daemon (shared hosting):
 *
 *  (a) lazy cron — after an API response has been sent (fastcgi_finish_request / litespeed_finish_request), at most
 *      once a minute per installation (marker file in LOG_DIR), run() is called;
 *  (b) public/cron.php — `php cron.php` from a cPanel Cron Job (every 1–5 minutes), or the URL with CRON_KEY.
 *
 * run() holds a MySQL named lock (GET_LOCK, no wait), so two triggers never run the jobs at the same time.
 * Jobs, each isolated (a failure is logged, the others still run):
 *   1. daily report snapshot — after DAILY_REPORT_TIME (Tehran), once per Jalali day (DailyReport::snapshotDailyReport)
 *   2. Telegram alerts — claim queued notifications → send (only when TELEGRAM_BOT_TOKEN and BOT_SERVICE_KEY are set)
 *   3. nightly report to managers — after DAILY_REPORT_TIME, once per day
 * When api.telegram.org cannot be reached the Telegram jobs back off for 10 minutes; nothing crashes.
 * Backups: the PHP edition does not create backups (cPanel does; see Modules/Backup), so there is nothing to rotate.
 */
final class Scheduler
{
    public const TICK_SECONDS = 60;
    public const TELEGRAM_BACKOFF_SECONDS = 600;

    /** Lazy cron hook, called by App::run after the response went out. Never throws. */
    public static function afterResponse(App $app): void
    {
        try {
            if (!self::lazyEnabled($app)) return;
            $marker = rtrim($app->config->str('LOG_DIR'), '/') . '/.cron-tick';
            clearstatcache(true, $marker);
            $mtime = @filemtime($marker);
            if ($mtime !== false && time() - $mtime < self::TICK_SECONDS) return;
            $dir = dirname($marker);
            if (!is_dir($dir) && !@mkdir($dir, 0700, true)) return;
            if (!@touch($marker)) return;
            ignore_user_abort(true);
            @set_time_limit(120);
            if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
            elseif (function_exists('litespeed_finish_request')) litespeed_finish_request();
            self::run($app, 'lazy');
        } catch (\Throwable $e) {
            Log::error('lazy cron failed', ['err' => $e->getMessage()]);
        }
    }

    /**
     * LAZY_CRON: 'auto' (default) = on when the response can be finished before the jobs run (PHP-FPM / LiteSpeed) or
     * under mod_php / CGI; off under PHP's built-in server (development, tests). true/'1' = on except the built-in
     * server, 'always' = on everywhere, false/'0' = off (use cron.php).
     */
    public static function lazyEnabled(App $app): bool
    {
        if (!$app->config->installed()) return false;
        $v = $app->config->get('LAZY_CRON') ?? 'auto';
        if ($v === false || $v === 0 || in_array(strtolower((string) $v), ['0', 'false', 'off', 'no'], true)) return false;
        if (strtolower((string) $v) === 'always') return true;
        return PHP_SAPI !== 'cli-server' && PHP_SAPI !== 'cli';
    }

    private static function lockName(App $app): string
    {
        return 'vitral_cron_' . substr(hash('sha256', $app->config->str('DB_HOST') . '/' . $app->config->str('DB_NAME')), 0, 16);
    }

    /**
     * Run every due job once. @param int|null $now unix time (tests)
     * @return array<string,mixed> what happened (cron.php prints it)
     */
    public static function run(App $app, string $trigger = 'cron', ?int $now = null): array
    {
        $now ??= time();
        $db = $app->db();
        $lock = self::lockName($app);
        if ((int) $db->value('SELECT GET_LOCK(?, 0)', [$lock]) !== 1) return ['trigger' => $trigger, 'skipped' => 'another run holds the lock'];
        $out = ['trigger' => $trigger, 'at' => gmdate('Y-m-d\TH:i:s\Z', $now)];
        try {
            $state = self::loadState($app);
            $state['last_run'] = $out['at'];
            $out['snapshot'] = self::guard(function () use ($app, &$state, $now) { return self::snapshotJob($app, $state, $now); });
            $out['telegram'] = self::guard(function () use ($app, &$state, $now) { return self::telegramJobs($app, $state, $now); });
            self::saveState($app, $state);
        } finally {
            try {
                $db->value('SELECT RELEASE_LOCK(?)', [$lock]);
            } catch (\Throwable) {
            }
        }
        return $out;
    }

    private static function guard(callable $fn): mixed
    {
        try {
            return $fn();
        } catch (\Throwable $e) {
            Log::error('scheduled job failed', ['err' => $e->getMessage(), 'class' => get_class($e), 'at' => $e->getFile() . ':' . $e->getLine()]);
            return ['error' => $e->getMessage()];
        }
    }

    /** @return array{due:bool,day:array{jy:int,jm:int,jd:int},key:string,dateKey:string,threshold:int} */
    public static function dayInfo(App $app, int $now): array
    {
        $time = (string) ($app->config->get('DAILY_REPORT_TIME') ?: '21:00');
        if (!preg_match('/^(\d{2}):(\d{2})$/', $time, $tm)) $time = '21:00';
        $tehran = $now + Jalali::TEHRAN_OFFSET_SECONDS;
        $hhmm = gmdate('H:i', $tehran);
        $day = Jalali::of(new \DateTimeImmutable('@' . $now));
        $g = Jalali::toGregorian($day['jy'], $day['jm'], $day['jd']);
        [$h, $m] = array_map('intval', explode(':', $time));
        return [
            'due' => $hhmm >= $time,
            'day' => $day,
            'key' => Jalali::format($day),
            'dateKey' => sprintf('%04d-%02d-%02d', $g['gy'], $g['gm'], $g['gd']),
            'threshold' => gmmktime($h, $m, 0, $g['gm'], $g['gd'], $g['gy']) - Jalali::TEHRAN_OFFSET_SECONDS,
        ];
    }

    /** Nightly daily-report snapshot at DAILY_REPORT_TIME (Tehran); one per Jalali day. */
    private static function snapshotJob(App $app, array &$state, int $now): mixed
    {
        $d = self::dayInfo($app, $now);
        if (!$d['due']) return 'not yet';
        if (($state['snapshot_day'] ?? null) === $d['key']) return 'done';
        // Already stored after today's report time (another trigger, or a restored state file)?
        $at = $app->db()->value('SELECT generated_at FROM daily_reports WHERE `date` = ?', [$d['dateKey']]);
        if (is_string($at) && strtotime($at) >= $d['threshold']) {
            $state['snapshot_day'] = $d['key'];
            return 'done';
        }
        DailyReport::snapshotDailyReport($app->db(), $d['day'], null);
        $state['snapshot_day'] = $d['key'];
        Log::info('daily report snapshot stored', ['date' => $d['key']]);
        return 'stored';
    }

    private static function telegramJobs(App $app, array &$state, int $now): mixed
    {
        if (!$app->config->get('TELEGRAM_BOT_TOKEN') || !$app->config->get('BOT_SERVICE_KEY')) return 'not configured';
        if (($state['telegram_down_until'] ?? 0) > $now) return 'backing off (telegram unreachable)';
        $tg = Telegram::fromConfig($app->config);
        if ($tg === null) return 'not configured';
        $api = Api::internal($app);
        $out = [];
        $alerts = self::guard(static fn () => Jobs::alerts($app, $tg, $api));
        $out['alerts'] = $alerts;
        if (is_array($alerts) && !empty($alerts['down'])) {
            $state['telegram_down_until'] = $now + self::TELEGRAM_BACKOFF_SECONDS;
            return $out;
        }
        $d = self::dayInfo($app, $now);
        if ($d['due'] && ($state['nightly_day'] ?? null) !== $d['key']) {
            $n = self::guard(static fn () => Jobs::nightly($app, $tg, $api));
            $out['nightly'] = $n;
            if (is_array($n) && !empty($n['down'])) {
                $state['telegram_down_until'] = $now + self::TELEGRAM_BACKOFF_SECONDS;
            } elseif (is_array($n) && !isset($n['error'])) {
                $state['nightly_day'] = $d['key'];
                $app->db()->exec('UPDATE daily_reports SET sent_to_telegram_at = NOW(3) WHERE `date` = ?', [$d['dateKey']]);
            }
        }
        return $out;
    }

    private static function stateFile(App $app): string
    {
        return rtrim($app->config->str('LOG_DIR'), '/') . '/.scheduler-state.json';
    }

    /** @return array<string,mixed> */
    public static function loadState(App $app): array
    {
        $raw = @file_get_contents(self::stateFile($app));
        $v = is_string($raw) ? json_decode($raw, true) : null;
        return is_array($v) ? $v : [];
    }

    private static function saveState(App $app, array $state): void
    {
        $file = self::stateFile($app);
        $dir = dirname($file);
        if (!is_dir($dir) && !@mkdir($dir, 0700, true)) return;
        @file_put_contents($file . '.tmp', Json::encode($state), LOCK_EX);
        @rename($file . '.tmp', $file);
    }
}
