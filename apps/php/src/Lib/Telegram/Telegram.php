<?php
declare(strict_types=1);

namespace Vitral\Lib\Telegram;

use Vitral\Core\Config;
use Vitral\Core\Schema;

/** Port of apps/bot/src/telegram.ts: a minimal Bot API client (JSON over HTTPS, no dependency). Webhook mode, no polling. */
final class Telegram
{
    private readonly string $base;

    public function __construct(private readonly string $token, private readonly Transport $transport, string $apiBase = 'https://api.telegram.org')
    {
        $this->base = rtrim($apiBase, '/');
    }

    public static function fromConfig(Config $config, ?Transport $transport = null): ?self
    {
        $token = (string) ($config->get('TELEGRAM_BOT_TOKEN') ?? '');
        if ($token === '') return null;
        $proxy = $config->get('TELEGRAM_PROXY');
        return new self($token, $transport ?? new HttpTransport(is_string($proxy) && $proxy !== '' ? $proxy : null), (string) ($config->get('TELEGRAM_API_URL') ?: 'https://api.telegram.org'));
    }

    /**
     * The secret Telegram echoes in X-Telegram-Bot-Api-Secret-Token on every webhook call (setWebhook secret_token).
     * TELEGRAM_WEBHOOK_SECRET when set, otherwise derived from BOT_SERVICE_KEY (or SESSION_SECRET): nothing extra to configure.
     */
    public static function webhookSecret(Config $config): string
    {
        $explicit = (string) ($config->get('TELEGRAM_WEBHOOK_SECRET') ?? '');
        if ($explicit !== '') return $explicit;
        $base = (string) ($config->get('BOT_SERVICE_KEY') ?: $config->str('SESSION_SECRET'));
        return hash_hmac('sha256', 'vitral-telegram-webhook', $base);
    }

    /** @return mixed the `result` of the call */
    public function call(string $method, array $body, int $timeout = 15): mixed
    {
        $res = $this->transport->request('POST', "{$this->base}/bot{$this->token}/{$method}", json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), ['content-type' => 'application/json'], $timeout);
        $json = json_decode($res['body'], true);
        if (!is_array($json)) throw new TelegramError("telegram {$method}: HTTP {$res['status']}", $res['status'] >= 500 || $res['status'] === 0);
        if (empty($json['ok'])) throw new TelegramError("telegram {$method}: " . ($json['description'] ?? $res['status']), false, isset($json['error_code']) ? (int) $json['error_code'] : null);
        return $json['result'] ?? null;
    }

    /** Telegram caps a message at 4096 chars; long reports are split on line boundaries. */
    public function send(int|string $chatId, string $text, ?array $keyboard = null): void
    {
        $chunks = [];
        $cur = '';
        foreach (explode("\n", $text) as $line) {
            if (Schema::jsLength($cur) + Schema::jsLength($line) + 1 > 4000) {
                $chunks[] = $cur;
                $cur = '';
            }
            $cur .= ($cur !== '' ? "\n" : '') . $line;
        }
        if ($cur !== '') $chunks[] = $cur;
        $n = count($chunks);
        foreach ($chunks as $i => $chunk) {
            $body = ['chat_id' => $chatId, 'text' => $chunk];
            if ($keyboard && $i === $n - 1) $body['reply_markup'] = $keyboard;
            $this->call('sendMessage', $body);
        }
    }

    public function answerCallback(string $id, ?string $text = null): mixed
    {
        $body = ['callback_query_id' => $id];
        if ($text !== null) $body['text'] = $text;
        return $this->call('answerCallbackQuery', $body);
    }

    /** @return array{data:string,path:string} */
    public function download(string $fileId): array
    {
        $f = $this->call('getFile', ['file_id' => $fileId]);
        $path = is_array($f) ? (string) ($f['file_path'] ?? '') : '';
        if ($path === '') throw new TelegramError('telegram getFile: no file_path');
        $res = $this->transport->request('GET', "{$this->base}/file/bot{$this->token}/{$path}", null, [], 60);
        if ($res['status'] < 200 || $res['status'] >= 300) throw new TelegramError("telegram download {$res['status']}");
        return ['data' => $res['body'], 'path' => $path];
    }

    public function setWebhook(string $url, string $secret): mixed
    {
        return $this->call('setWebhook', ['url' => $url, 'secret_token' => $secret, 'allowed_updates' => ['message', 'callback_query'], 'drop_pending_updates' => false]);
    }

    public function deleteWebhook(): mixed
    {
        return $this->call('deleteWebhook', ['drop_pending_updates' => false]);
    }

    public function getWebhookInfo(): mixed
    {
        return $this->call('getWebhookInfo', []);
    }
}
