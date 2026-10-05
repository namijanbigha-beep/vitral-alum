<?php
declare(strict_types=1);

namespace Vitral\Lib\Telegram;

use Vitral\Core\App;
use Vitral\Core\Log;

/**
 * The two background loops of apps/bot/src/main.ts, run by the scheduler (lazy cron / cron.php) instead of a daemon:
 *   alerts()  — claim queued notifications for linked users and send «🔔 title»
 *   nightly() — the full report to every linked manager, once per day after DAILY_REPORT_TIME
 * When Telegram is unreachable they log, give the claimed alerts back to the queue and report `down`, so the scheduler
 * backs off instead of trying every minute.
 */
final class Jobs
{
    /** @return array{sent:int,failed:int,down:bool} */
    public static function alerts(App $app, Telegram $tg, Api $api): array
    {
        $sent = 0;
        $failed = 0;
        $items = $api->claimNotifications()['items'] ?? [];
        foreach (array_values($items) as $i => $n) {
            try {
                $tg->send($n['chat_id'], '🔔 ' . $n['title']);
                $sent++;
            } catch (TelegramError $e) {
                if ($e->network) {
                    // Unreachable: put this and the rest back in the queue for a later run.
                    $back = array_map(static fn ($x) => $x['id'], array_slice($items, $i));
                    $app->db()->exec('UPDATE notifications SET telegram_sent_at = NULL WHERE id IN (' . \Vitral\Core\Db::placeholders($back) . ')', $back);
                    Log::warn('telegram unreachable; alerts re-queued', ['count' => count($back), 'err' => $e->getMessage()]);
                    return ['sent' => $sent, 'failed' => $failed, 'down' => true];
                }
                $failed++;
                Log::warn('alert send failed', ['err' => $e->getMessage(), 'id' => $n['id']]);
            }
        }
        return ['sent' => $sent, 'failed' => $failed, 'down' => false];
    }

    /** @return array{recipients:int,sent:int,down:bool} */
    public static function nightly(App $app, Telegram $tg, Api $api): array
    {
        $items = $api->reportRecipients()['items'] ?? [];
        $sent = 0;
        $networkFailures = 0;
        foreach ($items as $r) {
            try {
                $t = $api->text($r['id'], 'report', ['full' => 'true']);
                $tg->send($r['chat_id'], "🌙 گزارش شب\n\n" . $t['text']);
                $sent++;
            } catch (\Throwable $e) {
                if ($e instanceof TelegramError && $e->network) $networkFailures++;
                Log::warn('nightly send failed', ['err' => $e->getMessage(), 'user' => $r['id']]);
            }
        }
        Log::info('nightly report sent', ['recipients' => count($items), 'sent' => $sent]);
        return ['recipients' => count($items), 'sent' => $sent, 'down' => $items !== [] && $sent === 0 && $networkFailures > 0];
    }
}
