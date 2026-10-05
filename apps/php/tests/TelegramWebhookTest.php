<?php
declare(strict_types=1);

use Vitral\Core\App;
use Vitral\Core\Config;
use Vitral\Lib\Telegram\Api;
use Vitral\Lib\Telegram\Handlers;
use Vitral\Lib\Telegram\Telegram;
use Vitral\Lib\Telegram\Transport;
use Vitral\Lib\Telegram\Webhook;

/**
 * The webhook bot without network or database: a fake Transport records what would be sent to api.telegram.org and a
 * fake API dispatcher answers the Vitral endpoints the handlers call (the real ones are covered by the conformance
 * tests). Mirrors apps/bot/test/handlers.test.ts.
 */

/** Records every Bot API call; `getFile`/file download return bytes for the voice test. */
final class FakeTelegramTransport implements Transport
{
    /** @var list<array{method:string,body:array<string,mixed>}> */
    public array $calls = [];
    public int $downloads = 0;
    public bool $down = false;

    public function request(string $method, string $url, ?string $body, array $headers, int $timeoutSeconds): array
    {
        if ($this->down) throw new \Vitral\Lib\Telegram\TelegramError('telegram unreachable (fake)', true);
        if (!str_contains($url, '/bot')) throw new \RuntimeException("unexpected url {$url}");
        if (str_contains($url, '/file/bot')) {
            $this->downloads++;
            return ['status' => 200, 'body' => 'OggS-fake-voice-bytes'];
        }
        $api = substr($url, strrpos($url, '/') + 1);
        $decoded = $body === null ? [] : (array) json_decode($body, true);
        $this->calls[] = ['method' => $api, 'body' => $decoded];
        $result = match ($api) {
            'getFile' => ['file_path' => 'voice/file_9.oga'],
            default => true,
        };
        return ['status' => 200, 'body' => json_encode(['ok' => true, 'result' => $result], JSON_UNESCAPED_UNICODE)];
    }

    /** @return list<string> the text of every sendMessage, in order */
    public function sent(): array
    {
        $out = [];
        foreach ($this->calls as $c) if ($c['method'] === 'sendMessage') $out[] = (string) $c['body']['text'];
        return $out;
    }

    public function callsOf(string $method): array
    {
        return array_values(array_filter($this->calls, static fn ($c) => $c['method'] === $method));
    }
}

/** A tiny stand-in for the Vitral API: records requests and answers from a route table. */
final class FakeApiBackend
{
    /** @var list<array{method:string,url:string,headers:array<string,string>,body:string}> */
    public array $requests = [];
    /** @var array<string,array{status:int,body:mixed}> */
    public array $routes = [];

    public function api(string $serviceKey = 'bot-service-key-for-tests-0123456789abcdef'): Api
    {
        return new Api(function (string $method, string $url, array $headers, string $body): array {
            $this->requests[] = ['method' => $method, 'url' => $url, 'headers' => $headers, 'body' => $body];
            $path = (string) parse_url($url, PHP_URL_PATH);
            $key = $method . ' ' . $path;
            $r = $this->routes[$key] ?? ['status' => 404, 'body' => ['error' => ['code' => 'not_found', 'message' => 'پیدا نشد']]];
            $out = is_callable($r['body']) ? ($r['body'])($url, $body) : $r['body'];
            return ['status' => $r['status'], 'body' => $out === null ? '' : json_encode($out, JSON_UNESCAPED_UNICODE)];
        }, $serviceKey);
    }

    public function on(string $method, string $path, mixed $body, int $status = 200): void
    {
        $this->routes[$method . ' ' . $path] = ['status' => $status, 'body' => $body];
    }

    /** @return list<string> URLs of every recorded request */
    public function urls(): array
    {
        return array_map(static fn ($r) => $r['url'], $this->requests);
    }

    public function find(string $method, string $pathPrefix): ?array
    {
        foreach ($this->requests as $r) {
            if ($r['method'] === $method && str_starts_with((string) parse_url($r['url'], PHP_URL_PATH), $pathPrefix)) return $r;
        }
        return null;
    }
}

/** @return array{0:Handlers,1:FakeTelegramTransport,2:FakeApiBackend} */
function tgHandlers(?array $user = null): array
{
    $transport = new FakeTelegramTransport();
    $backend = new FakeApiBackend();
    if ($user !== null) $backend->on('GET', '/api/v1/internal/bot/resolve', ['user' => $user]);
    else $backend->on('GET', '/api/v1/internal/bot/resolve', ['user' => null]);
    $backend->on('POST', '/api/v1/internal/bot/log', ['ok' => true]);
    $tg = new Telegram('123:FAKE', $transport);
    return [new Handlers($backend->api(), $tg, static fn (array $o, string $m) => null, 'https://app.example.com'), $transport, $backend];
}

const TG_STAFF = ['id' => '11111111-1111-4111-8111-111111111111', 'name' => 'کارمند انبار', 'short_name' => 'انبار', 'role' => 'staff', 'permissions' => [], 'finance' => false];
const TG_MANAGER = ['id' => '22222222-2222-4222-8222-222222222222', 'name' => 'مدیر ویترال', 'short_name' => 'مدیر', 'role' => 'manager', 'permissions' => ['finance.view'], 'finance' => true];

function tgApp(array $extra = []): App
{
    $dir = sys_get_temp_dir() . '/vitral-tg-test';
    @mkdir($dir, 0700, true);
    return new App(Config::fromArray(array_merge([
        'APP_ENV' => 'test', 'DB_NAME' => 'vitral_php_test', 'SESSION_SECRET' => str_repeat('s', 40),
        'LOG_DIR' => $dir, 'TELEGRAM_BOT_TOKEN' => '123:FAKE', 'BOT_SERVICE_KEY' => str_repeat('k', 48),
    ], $extra), dirname(__DIR__)));
}

return [
    // ── the webhook endpoint itself ──────────────────────────────────────────────
    'webhook accepts only POST with the right secret token' => function (): void {
        $app = tgApp();
        $secret = Telegram::webhookSecret($app->config);
        T::true(strlen($secret) >= 32, 'a secret is derived from BOT_SERVICE_KEY');
        $body = '{"update_id":1,"message":{"message_id":2,"chat":{"id":5,"type":"private"},"date":1,"text":"سلام"}}';
        T::eq(405, Webhook::accept($app, 'GET', $secret, '')[0]);
        T::eq(401, Webhook::accept($app, 'POST', '', $body)[0]);
        T::eq(401, Webhook::accept($app, 'POST', 'wrong-secret', $body)[0]);
        T::eq(400, Webhook::accept($app, 'POST', $secret, 'not json')[0]);
        T::eq(400, Webhook::accept($app, 'POST', $secret, '{"no":"update_id"}')[0]);
        [$status, $update] = Webhook::accept($app, 'POST', $secret, $body);
        T::eq(200, $status);
        T::eq(1, $update['update_id']);
        // no token configured → the endpoint does not exist
        T::eq(404, Webhook::accept(tgApp(['TELEGRAM_BOT_TOKEN' => null]), 'POST', $secret, $body)[0]);
    },
    'an explicit TELEGRAM_WEBHOOK_SECRET wins' => function (): void {
        T::eq('my-own-secret', Telegram::webhookSecret(tgApp(['TELEGRAM_WEBHOOK_SECRET' => 'my-own-secret'])->config));
    },
    'dispatch routes messages and callbacks' => function (): void {
        [$h, $tr, $be] = tgHandlers(TG_STAFF);
        $be->on('GET', '/api/v1/internal/bot/text/stock', ['text' => '🏭 موجودی به کیلو']);
        Webhook::dispatch($h, ['update_id' => 3, 'message' => ['message_id' => 1, 'chat' => ['id' => 7, 'type' => 'private'], 'text' => 'انبار']]);
        T::eq(['🏭 موجودی به کیلو'], $tr->sent());
        Webhook::dispatch($h, ['update_id' => 4, 'callback_query' => ['id' => 'cb1', 'from' => ['id' => 7], 'data' => 'nope:x:y']]);
        T::eq('دکمهٔ ناشناخته', $tr->callsOf('answerCallbackQuery')[0]['body']['text']);
    },

    // ── /start linking (spec §16) ────────────────────────────────────────────────
    '/start <code> links the chat and greets with the help text' => function (): void {
        [$h, $tr, $be] = tgHandlers(null);
        $be->on('POST', '/api/v1/internal/bot/link', ['user' => ['id' => TG_STAFF['id'], 'name' => 'کارمند انبار', 'short_name' => 'انبار']]);
        $h->onMessage(['message_id' => 1, 'chat' => ['id' => 2001, 'type' => 'private'], 'text' => '/start ۱۲۳۴۵۶']);
        $link = $be->find('POST', '/api/v1/internal/bot/link');
        T::true($link !== null, 'the bot called /internal/bot/link');
        T::eq(['chat_id' => '2001', 'code' => '123456'], json_decode($link['body'], true), 'Persian digits are converted');
        T::eq('bot-service-key-for-tests-0123456789abcdef', $link['headers']['x-bot-key'], 'the service key guards the internal endpoint');
        $sent = $tr->sent();
        T::eq("خوش آمدی انبار ✅\n\n" . Handlers::HELP, $sent[0]);
        $log = $be->find('POST', '/api/v1/internal/bot/log');
        T::eq('linked', json_decode($log['body'], true)['kind']);
    },
    '/start without a six-digit code explains how to get one' => function (): void {
        [$h, $tr, $be] = tgHandlers(null);
        $h->onMessage(['message_id' => 1, 'chat' => ['id' => 2001, 'type' => 'private'], 'text' => '/start']);
        T::eq(1, count($tr->sent()));
        T::true(str_contains($tr->sent()[0], 'کد ۶ رقمی'), 'asks for the code');
        T::true(str_contains($tr->sent()[0], 'https://app.example.com/settings/telegram'), 'carries the link page');
        T::eq(null, $be->find('POST', '/api/v1/internal/bot/link'), 'nothing was linked');
    },
    'an expired code is reported, and the attempt logged' => function (): void {
        [$h, $tr, $be] = tgHandlers(null);
        $be->on('POST', '/api/v1/internal/bot/link', ['error' => ['code' => 'not_found', 'message' => 'کد نامعتبر یا منقضی است']], 404);
        $h->onMessage(['message_id' => 1, 'chat' => ['id' => 9, 'type' => 'private'], 'text' => '/start 000111']);
        T::eq(['کد نامعتبر یا منقضی است؛ کد تازه بگیر.'], $tr->sent());
        T::eq('link_failed', json_decode($be->find('POST', '/api/v1/internal/bot/log')['body'], true)['kind']);
    },
    'T55 — an unregistered chat is logged and told how to link, nothing else' => function (): void {
        [$h, $tr, $be] = tgHandlers(null);
        $h->onMessage(['message_id' => 1, 'chat' => ['id' => 777, 'type' => 'private'], 'text' => 'امروز']);
        T::true(str_contains($tr->sent()[0], 'این چت به حسابی متصل نیست'), 'refused');
        $log = json_decode($be->find('POST', '/api/v1/internal/bot/log')['body'], true);
        T::eq(['chat_id' => '777', 'kind' => 'unregistered', 'detail' => 'امروز'], $log);
        foreach ($be->urls() as $u) T::true(!str_contains($u, '/text/'), "no report was fetched: {$u}");
    },

    // ── free notes ───────────────────────────────────────────────────────────────
    'plain text becomes a free note with the telegram message id and an idempotency key' => function (): void {
        [$h, $tr, $be] = tgHandlers(TG_STAFF);
        $be->on('POST', '/api/v1/free-notes', ['id' => 'note-1']);
        $h->onMessage(['message_id' => 42, 'chat' => ['id' => 2001, 'type' => 'private'], 'text' => '  رنگ خریدم  ']);
        $req = $be->find('POST', '/api/v1/free-notes');
        T::eq(['text' => 'رنگ خریدم', 'file_ids' => [], 'telegram_message_id' => '2001:42'], json_decode($req['body'], true));
        T::eq(TG_STAFF['id'], $req['headers']['x-bot-user']);
        T::true(preg_match('/^[0-9a-f-]{36}$/', $req['headers']['idempotency-key']) === 1, 'fresh Idempotency-Key');
        T::eq(['یادداشت ثبت شد 🗒 (بررسی می‌شود)'], $tr->sent());
    },
    'a voice message is downloaded, uploaded as kind=voice and attached to the note' => function (): void {
        [$h, $tr, $be] = tgHandlers(TG_STAFF);
        $be->on('POST', '/api/v1/files', ['id' => 'file-7']);
        $be->on('POST', '/api/v1/free-notes', ['id' => 'note-2']);
        $h->onMessage(['message_id' => 9, 'chat' => ['id' => 2001, 'type' => 'private'], 'voice' => ['file_id' => 'AgAC-voice', 'file_unique_id' => 'u', 'duration' => 3], 'caption' => 'ویس انبار']);
        T::eq('AgAC-voice', $tr->callsOf('getFile')[0]['body']['file_id']);
        T::eq(1, $tr->downloads, 'the bytes were fetched once');
        $upload = $be->find('POST', '/api/v1/files');
        T::true($upload !== null, 'the file was uploaded');
        T::true(str_starts_with($upload['headers']['content-type'], 'multipart/form-data; boundary='), 'multipart upload');
        foreach (['name="kind"', 'voice', 'name="owner_entity"', 'free_notes', 'filename="file_9.oga"', 'OggS-fake-voice-bytes'] as $needle) {
            T::true(str_contains($upload['body'], $needle), "the body carries {$needle}");
        }
        $note = json_decode($be->find('POST', '/api/v1/free-notes')['body'], true);
        T::eq(['text' => 'ویس انبار', 'file_ids' => ['file-7'], 'telegram_message_id' => '2001:9'], $note);
        T::eq(['یادداشت ثبت شد 🗒 (با پیوست، بررسی می‌شود)'], $tr->sent());
    },
    'a photo whose caption names a bundle code is attached to that bundle' => function (): void {
        [$h, $tr, $be] = tgHandlers(TG_STAFF);
        $be->on('POST', '/api/v1/files', ['id' => 'file-8']);
        $be->on('GET', '/api/v1/internal/bot/text/bundle', ['text' => '📦 بندیل VT-0012', 'id' => 'bundle-id-1']);
        $be->on('POST', '/api/v1/bundles/bundle-id-1/files', ['ok' => true]);
        $h->onMessage(['message_id' => 11, 'chat' => ['id' => 2001, 'type' => 'private'], 'photo' => [['file_id' => 'small'], ['file_id' => 'big']], 'caption' => 'خرابی vt-0012']);
        T::eq('big', $tr->callsOf('getFile')[0]['body']['file_id'], 'the largest size is used');
        T::eq(['file_ids' => ['file-8']], json_decode($be->find('POST', '/api/v1/bundles/bundle-id-1/files')['body'], true));
        T::eq(['عکس به بندیل VT-۰۰۱۲ پیوست شد 📷'], $tr->sent());
        T::eq(null, $be->find('POST', '/api/v1/free-notes'), 'no free note for an attached photo');
    },

    // ── inline buttons ───────────────────────────────────────────────────────────
    'doc:post reads the version, posts the document and confirms' => function (): void {
        [$h, $tr, $be] = tgHandlers(TG_MANAGER);
        $be->on('GET', '/api/v1/documents/doc-1', ['id' => 'doc-1', 'number' => 'RC-0007', 'version' => 3]);
        $be->on('POST', '/api/v1/documents/doc-1/post', ['id' => 'doc-1', 'status' => 'posted']);
        $h->onCallback(['id' => 'cb-9', 'from' => ['id' => 2002], 'message' => ['message_id' => 5, 'chat' => ['id' => 2002, 'type' => 'private']], 'data' => 'doc:post:doc-1']);
        $post = $be->find('POST', '/api/v1/documents/doc-1/post');
        T::eq(['version' => 3], json_decode($post['body'], true), 'the fresh version is sent (principle 5)');
        T::true(preg_match('/^[0-9a-f-]{36}$/', $post['headers']['idempotency-key']) === 1, 'fresh Idempotency-Key');
        T::eq(TG_MANAGER['id'], $post['headers']['x-bot-user']);
        T::eq('قطعی شد ✅', $tr->callsOf('answerCallbackQuery')[0]['body']['text']);
        T::eq(['سند RC-۰۰۰۷ قطعی شد ✅'], $tr->sent());
    },
    'doc:void voids it, and a 403 from the API is reported in Persian' => function (): void {
        [$h, $tr, $be] = tgHandlers(TG_STAFF);
        $be->on('GET', '/api/v1/documents/doc-2', ['id' => 'doc-2', 'number' => 'RC-0008', 'version' => 1]);
        $be->on('POST', '/api/v1/documents/doc-2/void', ['error' => ['code' => 'forbidden', 'message' => 'اجازه این کار را ندارید']], 403);
        $h->onCallback(['id' => 'cb-10', 'from' => ['id' => 2001], 'message' => ['message_id' => 6, 'chat' => ['id' => 2001, 'type' => 'private']], 'data' => 'doc:void:doc-2']);
        T::eq('انجام نشد', $tr->callsOf('answerCallbackQuery')[0]['body']['text']);
        T::eq(['اجازهٔ این کار را نداری.'], $tr->sent());
    },
    'bundle and task buttons call the definitive endpoints' => function (): void {
        [$h, $tr, $be] = tgHandlers(TG_MANAGER);
        $be->on('GET', '/api/v1/bundles/b-1', ['id' => 'b-1', 'code' => 'VT-0012', 'version' => 2]);
        $be->on('POST', '/api/v1/bundles/b-1/decide', ['ok' => true]);
        $h->onCallback(['id' => 'cb-11', 'from' => ['id' => 2002], 'message' => ['message_id' => 7, 'chat' => ['id' => 2002, 'type' => 'private']], 'data' => 'bundle:rework:b-1']);
        T::eq(['version' => 2, 'decision' => 'rework', 'note' => 'تصمیم از تلگرام'], json_decode($be->find('POST', '/api/v1/bundles/b-1/decide')['body'], true));
        T::eq(['بندیل VT-۰۰۱۲: به بازکاری رفت 🔁'], $tr->sent());

        [$h2, $tr2, $be2] = tgHandlers(TG_STAFF);
        $be2->on('GET', '/api/v1/tasks/t-1', ['id' => 't-1', 'title' => 'زنگ به کارخانه', 'version' => 1]);
        $be2->on('POST', '/api/v1/tasks/t-1/done', ['ok' => true]);
        $h2->onCallback(['id' => 'cb-12', 'from' => ['id' => 2001], 'data' => 'task:done:t-1']);
        T::eq(['version' => 1], json_decode($be2->find('POST', '/api/v1/tasks/t-1/done')['body'], true));
        T::eq('انجام شد ✅', $tr2->callsOf('answerCallbackQuery')[0]['body']['text']);
    },
    'تأییدها builds the approve / reject keyboard' => function (): void {
        [$h, $tr, $be] = tgHandlers(TG_MANAGER);
        $be->on('GET', '/api/v1/internal/bot/text/pending', ['text' => "⏳ در انتظار تأیید:\n۱. بندیل VT-0012\n۲. دریافت RC-0007", 'items' => [
            ['type' => 'bundle', 'id' => 'b-1', 'label' => 'بندیل VT-0012'],
            ['type' => 'document', 'id' => 'doc-1', 'label' => 'دریافت RC-0007'],
        ]]);
        $h->onMessage(['message_id' => 1, 'chat' => ['id' => 2002, 'type' => 'private'], 'text' => 'تأییدها']);
        $kb = $tr->callsOf('sendMessage')[0]['body']['reply_markup']['inline_keyboard'];
        T::eq(3, count($kb[0]), 'a bundle row has accept / rework / scrap');
        T::eq('bundle:accept:b-1', $kb[0][0]['callback_data']);
        T::eq(['doc:post:doc-1', 'doc:void:doc-1'], array_column($kb[1], 'callback_data'));
    },

    // ── T56: money only for finance.view ────────────────────────────────────────
    'T56 — «مانده» is refused for a user without finance.view, and never reaches the API' => function (): void {
        [$h, $tr, $be] = tgHandlers(TG_STAFF);
        $be->on('GET', '/api/v1/internal/bot/text/balance', ['text' => '💼 مانده نمونه: ۵٬۰۰۰٬۰۰۰ تومان']);
        $h->onMessage(['message_id' => 1, 'chat' => ['id' => 2001, 'type' => 'private'], 'text' => 'مانده نمونه']);
        T::eq(['دسترسی مالی نداری.'], $tr->sent());
        foreach ($be->urls() as $u) T::true(!str_contains($u, '/text/balance'), "the balance text was not fetched: {$u}");
        foreach ($tr->sent() as $text) T::true(preg_match('/تومان|۵٬۰۰۰٬۰۰۰/u', $text) !== 1, 'no money in the reply');
    },
    'T56 — a manager gets the balance text, and the server decides what is in it' => function (): void {
        [$h, $tr, $be] = tgHandlers(TG_MANAGER);
        $be->on('GET', '/api/v1/internal/bot/text/balance', ['text' => "💼 مانده نمونه:\n• ۵٬۰۰۰٬۰۰۰ تومان (طلب ویترال)"]);
        $h->onMessage(['message_id' => 1, 'chat' => ['id' => 2002, 'type' => 'private'], 'text' => 'مانده نمونه']);
        T::true(str_contains($tr->sent()[0], '۵٬۰۰۰٬۰۰۰ تومان'), 'the server text is forwarded verbatim');
        T::true(str_contains($be->find('GET', '/api/v1/internal/bot/text/balance')['url'], 'q=' . rawurlencode('نمونه')), 'the query is passed on');
    },
    'T56 — the staff report is whatever the server returns; the bot adds no money' => function (): void {
        [$h, $tr, $be] = tgHandlers(TG_STAFF);
        $be->on('GET', '/api/v1/internal/bot/text/report', ['text' => "📋 گزارش موجودی تولید شده پروفیل خام\n✅ جمع کل: ۹۸۸ کیلو", 'date' => '1405/07/10']);
        $h->onMessage(['message_id' => 1, 'chat' => ['id' => 2001, 'type' => 'private'], 'text' => 'گزارش ۱۴۰۵/۰۷/۱۰ کامل']);
        $url = $be->find('GET', '/api/v1/internal/bot/text/report')['url'];
        T::true(str_contains($url, 'date=' . rawurlencode('1405/07/10')), "the Jalali date is sent as latin digits: {$url}");
        T::true(str_contains($url, 'full=true'), 'کامل → full=true');
        T::eq(TG_STAFF['id'], $be->find('GET', '/api/v1/internal/bot/text/report')['headers']['x-bot-user']);
        foreach ($tr->sent() as $text) T::true(preg_match('/تومان|دلار|دینار/u', $text) !== 1, 'no currency in a staff reply');
    },
    'only a manager creates tasks; an unknown name is never silently reassigned' => function (): void {
        [$h, $tr] = tgHandlers(TG_STAFF);
        $h->onMessage(['message_id' => 1, 'chat' => ['id' => 2001, 'type' => 'private'], 'text' => 'کار @علی زنگ بزن']);
        T::eq(['کار جدید را فقط مدیر می‌سازد. کارهای خودت: «کارها»'], $tr->sent());

        [$h2, $tr2, $be2] = tgHandlers(TG_MANAGER);
        $be2->on('GET', '/api/v1/users/directory', ['items' => [['id' => 'u-1', 'name' => 'علی رضایی', 'short_name' => 'علی'], ['id' => 'u-2', 'name' => 'علی محمدی', 'short_name' => 'علی م']]]);
        $be2->on('POST', '/api/v1/tasks', ['id' => 't-9', 'title' => 'زنگ بزن']);
        $h2->onMessage(['message_id' => 1, 'chat' => ['id' => 2002, 'type' => 'private'], 'text' => 'کار @علی_رضایی زنگ بزن']);
        T::eq(['id' => 'u-1', 'title' => 'زنگ بزن'], ['id' => json_decode($be2->find('POST', '/api/v1/tasks')['body'], true)['assignee_user_id'], 'title' => json_decode($be2->find('POST', '/api/v1/tasks')['body'], true)['title']]);
        T::eq(['کار ثبت شد 📝 «زنگ بزن»'], $tr2->sent());

        // two partial matches and no exact one: ask again instead of guessing
        [$h3, $tr3, $be3] = tgHandlers(TG_MANAGER);
        $be3->on('GET', '/api/v1/users/directory', ['items' => [['id' => 'u-1', 'name' => 'علی رضایی', 'short_name' => 'رضا ا'], ['id' => 'u-2', 'name' => 'رضا محمدی', 'short_name' => 'رضا م']]]);
        $h3->onMessage(['message_id' => 1, 'chat' => ['id' => 2002, 'type' => 'private'], 'text' => 'کار @رضا زنگ بزن']);
        T::true(str_contains($tr3->sent()[0], 'چند نفر با «رضا» پیدا شد'), 'asks again');
        T::eq(null, $be3->find('POST', '/api/v1/tasks'), 'no task was created');

        [$h4, $tr4, $be4] = tgHandlers(TG_MANAGER);
        $be4->on('GET', '/api/v1/users/directory', ['items' => [['id' => 'u-1', 'name' => 'علی رضایی', 'short_name' => 'علی']]]);
        $h4->onMessage(['message_id' => 1, 'chat' => ['id' => 2002, 'type' => 'private'], 'text' => 'کار @نیما زنگ بزن']);
        T::true(str_contains($tr4->sent()[0], 'کاربری با نام «نیما» پیدا نشد'), 'lists the valid names');
        T::eq(null, $be4->find('POST', '/api/v1/tasks'), 'no task was created');
    },

    // ── graceful degradation ─────────────────────────────────────────────────────
    'an unreachable Telegram is logged, not crashed on' => function (): void {
        [, $tr, $be] = tgHandlers(TG_STAFF);
        $be->on('GET', '/api/v1/internal/bot/text/stock', ['text' => '🏭 موجودی']);
        $tr->down = true;
        // Webhook::process swallows the failure (it is logged); Telegram gets its 200 either way.
        Webhook::process(tgApp(), ['update_id' => 5, 'message' => ['message_id' => 1, 'chat' => ['id' => 7, 'type' => 'private'], 'text' => 'انبار']], new Telegram('123:FAKE', $tr), $be->api());
        T::eq([], $tr->sent(), 'nothing could be sent');
        T::true($be->find('GET', '/api/v1/internal/bot/text/stock') !== null, 'the work was still done server-side');
    },
    'a long report is split into Telegram-sized chunks' => function (): void {
        [$h, $tr, $be] = tgHandlers(TG_STAFF);
        $long = implode("\n", array_fill(0, 500, 'خط گزارش با طول متوسط برای آزمون تقسیم'));
        $be->on('GET', '/api/v1/internal/bot/text/report', ['text' => $long, 'date' => '1405/07/10']);
        $h->onMessage(['message_id' => 1, 'chat' => ['id' => 2001, 'type' => 'private'], 'text' => 'امروز']);
        $sent = $tr->sent();
        T::true(count($sent) > 1, 'split into several messages');
        foreach ($sent as $chunk) T::true(mb_strlen($chunk) <= 4000, 'each chunk fits');
        T::eq($long, implode("\n", $sent), 'nothing is lost');
    },
];
