<?php
declare(strict_types=1);

namespace Vitral\Lib\Telegram;

use Vitral\Core\App;
use Vitral\Core\Db;
use Vitral\Core\Request;

/**
 * Port of apps/bot/src/api.ts: the bot talks to Vitral as the linked user (X-Bot-Key + X-Bot-User), so permissions,
 * idempotency and the confidential filter stay in the API. On shared hosting there is no second process: requests are
 * dispatched in-process through the same pipeline (App::handleApi) instead of over HTTP.
 */
final class Api
{
    /** @var callable(string,string,array<string,string>,string):array{status:int,body:string} */
    private $dispatch;

    /** @param callable(string $method, string $url, array<string,string> $headers, string $body):array{status:int,body:string} $dispatch */
    public function __construct(callable $dispatch, private readonly string $key)
    {
        $this->dispatch = $dispatch;
    }

    /** In-process dispatcher over App::handleApi. */
    public static function internal(App $app): self
    {
        $dispatch = static function (string $method, string $url, array $headers, string $body) use ($app): array {
            $path = (string) parse_url($url, PHP_URL_PATH);
            $qs = (string) (parse_url($url, PHP_URL_QUERY) ?? '');
            $req = new Request($method, $path, Request::parseQuery($qs), $headers + ['host' => 'telegram.internal'], [], $body, '127.0.0.1', $app);
            $req->internal = true;
            $res = $app->handleApi(static fn () => $req);
            return ['status' => $res->status, 'body' => $res->body()];
        };
        return new self($dispatch, (string) ($app->config->get('BOT_SERVICE_KEY') ?? ''));
    }

    /**
     * @param array{user?:?string,body?:mixed,form?:array{fields:array<string,string>,file:array{name:string,data:string}},idempotent?:bool,query?:array<string,?string>} $opts
     * @return mixed decoded JSON (assoc arrays)
     */
    public function request(string $method, string $path, array $opts = []): mixed
    {
        $url = '/api/v1' . $path;
        $query = array_filter($opts['query'] ?? [], static fn ($v) => $v !== null);
        if ($query) $url .= '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
        $headers = ['x-bot-key' => $this->key, 'x-requested-with' => 'vitral'];
        if (!empty($opts['user'])) $headers['x-bot-user'] = (string) $opts['user'];
        if (!empty($opts['idempotent'])) $headers['idempotency-key'] = Db::uuid();
        $body = '';
        if (isset($opts['form'])) {
            $boundary = '----vitral' . bin2hex(random_bytes(12));
            foreach ($opts['form']['fields'] as $k => $v) {
                $body .= "--{$boundary}\r\nContent-Disposition: form-data; name=\"{$k}\"\r\n\r\n{$v}\r\n";
            }
            $f = $opts['form']['file'];
            $name = str_replace(['"', "\r", "\n"], '_', $f['name']);
            $body .= "--{$boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{$name}\"\r\nContent-Type: application/octet-stream\r\n\r\n{$f['data']}\r\n--{$boundary}--\r\n";
            $headers['content-type'] = "multipart/form-data; boundary={$boundary}";
            $headers['content-length'] = (string) strlen($body);
        } elseif (array_key_exists('body', $opts)) {
            $headers['content-type'] = 'application/json';
            $body = json_encode($opts['body'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        }
        $res = ($this->dispatch)($method, $url, $headers, $body);
        $json = $res['body'] !== '' ? json_decode($res['body'], true) : null;
        if ($res['status'] < 200 || $res['status'] >= 300) {
            $e = is_array($json) ? ($json['error'] ?? null) : null;
            throw new ApiError($res['status'], (string) ($e['code'] ?? 'error'), (string) ($e['message'] ?? "HTTP {$res['status']}"), $e['fields'] ?? null);
        }
        return $json;
    }

    /** @return array{user:?array} */
    public function resolve(string $chatId): array { return $this->request('GET', '/internal/bot/resolve', ['query' => ['chat_id' => $chatId]]); }

    /** @return array{user:array} */
    public function link(string $chatId, string $code): array { return $this->request('POST', '/internal/bot/link', ['body' => ['chat_id' => $chatId, 'code' => $code]]); }

    public function log(?string $chatId, string $kind, ?string $detail = null): void
    {
        try {
            $this->request('POST', '/internal/bot/log', ['body' => ['chat_id' => $chatId, 'kind' => $kind, 'detail' => $detail]]);
        } catch (\Throwable) {
            // .catch(() => null)
        }
    }

    /** @return array{items:list<array{id:string,kind:string,title:string,chat_id:string}>} */
    public function claimNotifications(): array { return $this->request('POST', '/internal/bot/notifications/claim', []); }

    /** @return array{items:list<array{id:string,chat_id:string}>} */
    public function reportRecipients(): array { return $this->request('GET', '/internal/bot/report-recipients'); }

    /** @return array{text:string,items?:list<array{type:string,id:string,label:string}>,id?:string} */
    public function text(string $user, string $what, array $query = []): array
    {
        return $this->request('GET', "/internal/bot/text/{$what}", ['user' => $user, 'query' => $query]);
    }
}
