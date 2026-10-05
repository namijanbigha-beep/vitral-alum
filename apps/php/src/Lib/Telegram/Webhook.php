<?php
declare(strict_types=1);

namespace Vitral\Lib\Telegram;

use Vitral\Core\App;
use Vitral\Core\Log;

/**
 * Telegram → public/telegram.php. Shared hosting cannot run the long-polling loop of apps/bot, so Telegram pushes each
 * update here (setWebhook with a secret_token). The request is answered 200 at once (fastcgi_finish_request where
 * available) and the update is then handled like apps/bot/src/main.ts: one update, errors logged, never re-thrown, so
 * Telegram never retries an update forever.
 */
final class Webhook
{
    /** Front-controller entry. Sends the HTTP response itself. */
    public static function serve(App $app): void
    {
        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
        $secretHeader = (string) ($_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '');
        $raw = $method === 'POST' ? (string) file_get_contents('php://input') : '';
        [$status, $update] = self::accept($app, $method, $secretHeader, $raw);
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        $body = $status === 200 ? '{"ok":true}' : '{"ok":false}';
        header('Content-Length: ' . strlen($body));
        echo $body;
        if ($update === null) return;
        ignore_user_abort(true);
        @set_time_limit(120);
        if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
        elseif (function_exists('litespeed_finish_request')) litespeed_finish_request();
        else @flush();
        self::process($app, $update);
    }

    /**
     * Validate a webhook call. @return array{0:int,1:?array<string,mixed>} [HTTP status, update to process]
     */
    public static function accept(App $app, string $method, string $secretHeader, string $raw): array
    {
        if ($method !== 'POST') return [405, null];
        if (!$app->config->installed() || !$app->config->get('TELEGRAM_BOT_TOKEN')) return [404, null];
        $secret = Telegram::webhookSecret($app->config);
        if ($secretHeader === '' || !hash_equals($secret, $secretHeader)) {
            Log::warn('telegram webhook: bad secret token');
            return [401, null];
        }
        $update = json_decode($raw, true);
        if (!is_array($update) || !isset($update['update_id'])) return [400, null];
        return [200, $update];
    }

    /** Handle one update; never throws. */
    public static function process(App $app, array $update, ?Telegram $tg = null, ?Api $api = null): void
    {
        try {
            $tg ??= Telegram::fromConfig($app->config);
            if ($tg === null) return;
            if (!$app->config->get('BOT_SERVICE_KEY')) {
                Log::error('telegram webhook: BOT_SERVICE_KEY is not configured');
                return;
            }
            $api ??= Api::internal($app);
            $publicUrl = $app->config->get('PUBLIC_URL');
            $handlers = new Handlers($api, $tg, static fn (array $o, string $m) => Log::warn($m, $o), is_string($publicUrl) ? $publicUrl : null);
            self::dispatch($handlers, $update);
        } catch (\Throwable $e) {
            Log::error('telegram update failed', ['update' => $update['update_id'] ?? null, 'err' => $e->getMessage(), 'class' => get_class($e)]);
        }
    }

    public static function dispatch(Handlers $handlers, array $update): void
    {
        if (isset($update['message']) && is_array($update['message'])) $handlers->onMessage($update['message']);
        elseif (isset($update['callback_query']) && is_array($update['callback_query'])) $handlers->onCallback($update['callback_query']);
    }

    /** Where Telegram should post: PUBLIC_URL + /telegram.php (the file sits next to index.php). */
    public static function defaultUrl(App $app): ?string
    {
        $base = $app->config->get('PUBLIC_URL');
        return is_string($base) && $base !== '' ? rtrim($base, '/') . '/telegram.php' : null;
    }
}
