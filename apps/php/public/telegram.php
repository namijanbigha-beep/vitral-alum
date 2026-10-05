<?php
declare(strict_types=1);

/**
 * Telegram webhook. Shared hosting cannot run the long-polling bot (apps/bot), so Telegram pushes every update here:
 *
 *   1. config.php holds TELEGRAM_BOT_TOKEN and BOT_SERVICE_KEY (install.php asks for the token);
 *   2. a manager registers the webhook once — POST /api/v1/bot/telegram/webhook (settings.manage) — which calls
 *      setWebhook with url = <PUBLIC_URL>/telegram.php and a secret_token derived from BOT_SERVICE_KEY;
 *   3. Telegram then POSTs each update with X-Telegram-Bot-Api-Secret-Token; anything without that header is 401.
 *
 * The update is handled after the response is flushed (fastcgi_finish_request), so Telegram sees a fast 200 and never
 * retries while we work. Unreachable Telegram or a failing update is logged, never crashed on.
 */
$root = is_file(__DIR__ . '/src/bootstrap.php') ? __DIR__ : dirname(__DIR__);
require $root . '/src/bootstrap.php';

\Vitral\Lib\Telegram\Webhook::serve(\Vitral\Core\App::fromRoot(VITRAL_ROOT));
