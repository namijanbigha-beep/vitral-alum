<?php
declare(strict_types=1);

namespace Vitral\Lib\Telegram;

use Vitral\Lib\Num;

/**
 * Port of apps/bot/src/handlers.ts: Persian commands, free notes (text / voice / photo / document), inline buttons for
 * money documents (post / void), quarantine bundles (accept / rework / scrap) and tasks (done). Every action goes
 * through the regular API as the linked user (Api), so the server enforces permissions and T56 money hiding.
 */
final class Handlers
{
    public const HELP = "دستورها (فارسی یا انگلیسی):\n"
        . "• امروز — گزارش تولید امروز\n"
        . "• گزارش ۱۴۰۵/۰۷/۱۲ — گزارش یک روز\n"
        . "• بندیل VT-0012 — وضعیت یک بندیل\n"
        . "• سفارش VT-0003 — وضعیت یک سفارش\n"
        . "• انبار — موجودی به کیلو\n"
        . "• تأییدها — موارد در انتظار تأیید (با دکمه تأیید/رد)\n"
        . "• کار @نام متن کار — کار جدید برای یک کارمند (فقط مدیر)\n"
        . "• کارها — کارهای باز من\n"
        . "• مانده نام طرف — مانده حساب (فقط مالی)\n"
        . '• هر متن دیگر، ویس یا عکس → یادداشت آزاد';

    private const WORDS = ['امروز' => 'today', 'گزارش' => 'report', 'بندیل' => 'bundle', 'سفارش' => 'order', 'انبار' => 'stock', 'تأییدها' => 'pending', 'تاییدها' => 'pending', 'کار' => 'task', 'کارها' => 'tasks', 'مانده' => 'balance', 'راهنما' => 'help', 'یادداشت' => 'note', 'today' => 'today', 'report' => 'report', 'bundle' => 'bundle', 'order' => 'order', 'stock' => 'stock', 'pending' => 'pending', 'task' => 'task', 'tasks' => 'tasks', 'balance' => 'balance', 'help' => 'help', 'note' => 'note', 'start' => 'start'];

    /** Where the app's «اتصال تلگرام» page lives: «بیشتر › اتصال تلگرام», route /settings/telegram. */
    public const LINK_PAGE_ROUTE = '/settings/telegram';

    /** @var callable(array<string,mixed>,string):void */
    private $log;

    public function __construct(private readonly Api $api, private readonly Telegram $tg, callable $log, private readonly ?string $publicUrl = null)
    {
        $this->log = $log;
    }

    /** @return array{cmd:?string,arg:string} */
    public static function parse(string $text): array
    {
        $t = (string) preg_replace('/^\//', '', Num::jsTrim($text));
        $parts = preg_split('/\s+/u', $t) ?: [''];
        $head = (string) array_shift($parts);
        return ['cmd' => self::WORDS[mb_strtolower($head)] ?? null, 'arg' => Num::jsTrim(implode(' ', $parts))];
    }

    public static function errorText(\Throwable $e): string
    {
        if ($e instanceof ApiError) {
            if ($e->status === 403) return 'اجازهٔ این کار را نداری.';
            if ($e->status === 409) return 'این مورد همزمان توسط شخص دیگری تغییر کرده؛ دوباره «تأییدها» را بزن.';
            $d = '';
            if (is_array($e->details) && $e->details) {
                $parts = [];
                foreach ($e->details as $k => $v) $parts[] = "{$k}: " . (is_scalar($v) ? (string) $v : json_encode($v, JSON_UNESCAPED_UNICODE));
                $d = implode('، ', $parts);
            }
            return $e->getMessage() . ($d !== '' ? " ({$d})" : '');
        }
        return 'خطای غیرمنتظره؛ بعداً دوباره تلاش کن.';
    }

    private static function fa(string $s): string
    {
        return Num::toPersianDigits($s);
    }

    /** «بیشتر › اتصال تلگرام» plus the direct link when the bot knows the app's public URL. */
    private function linkHint(): string
    {
        $base = $this->publicUrl !== null ? (string) preg_replace('#/+$#', '', $this->publicUrl) : '';
        return "در برنامه از «بیشتر › اتصال تلگرام» کد بگیر و بفرست:\n/start 123456" . ($base !== '' ? "\n{$base}" . self::LINK_PAGE_ROUTE : '');
    }

    private function log(array $o, string $m): void
    {
        ($this->log)($o, $m);
    }

    /** @param array<string,mixed> $m a Telegram Message */
    public function onMessage(array $m): void
    {
        $chatId = (string) $m['chat']['id'];
        $text = (string) ($m['text'] ?? $m['caption'] ?? '');
        ['cmd' => $cmd, 'arg' => $arg] = self::parse($text);
        if ($cmd === 'start') {
            $this->start($chatId, $arg);
            return;
        }

        $user = $this->api->resolve($chatId)['user'] ?? null;
        if (!$user) {
            // T55: unregistered chats are logged and told how to link; nothing else leaks.
            $this->api->log($chatId, 'unregistered', mb_substr($text, 0, 200));
            $this->tg->send($chatId, 'این چت به حسابی متصل نیست. ' . $this->linkHint());
            return;
        }
        try {
            if (isset($m['voice']) || isset($m['audio'])) {
                $this->noteWithFile($user, $chatId, $m, (string) ($m['voice'] ?? $m['audio'])['file_id'], 'voice', $text);
                return;
            }
            if (!empty($m['photo']) && is_array($m['photo'])) {
                $last = $m['photo'][count($m['photo']) - 1];
                $this->noteWithFile($user, $chatId, $m, (string) $last['file_id'], 'photo', $text);
                return;
            }
            if (isset($m['document'])) {
                $this->noteWithFile($user, $chatId, $m, (string) $m['document']['file_id'], 'document', $text);
                return;
            }
            $full = (bool) preg_match('/کامل|full/u', $arg);
            switch ($cmd) {
                case 'help':
                    $this->tg->send($chatId, self::HELP);
                    return;
                case 'today':
                    $this->report($user, $chatId, null, $full);
                    return;
                case 'report':
                    $this->report($user, $chatId, $arg !== '' ? Num::toLatinDigits((string) preg_replace('/[-.]/', '/', $arg)) : null, $full);
                    return;
                case 'bundle':
                    if ($arg === '') {
                        $this->tg->send($chatId, 'کد بندیل را بنویس: بندیل VT-0012');
                        return;
                    }
                    $this->tg->send($chatId, $this->api->text($user['id'], 'bundle', ['code' => Num::toLatinDigits($arg)])['text']);
                    return;
                case 'order':
                    if ($arg === '') {
                        $this->tg->send($chatId, 'شمارهٔ سفارش را بنویس: سفارش VT-0003');
                        return;
                    }
                    $this->tg->send($chatId, $this->api->text($user['id'], 'order', ['number' => Num::toLatinDigits($arg)])['text']);
                    return;
                case 'stock':
                    $this->tg->send($chatId, $this->api->text($user['id'], 'stock')['text']);
                    return;
                case 'pending':
                    $this->pending($user, $chatId);
                    return;
                case 'task':
                    $this->task($user, $chatId, $arg);
                    return;
                case 'tasks':
                    $this->tasks($user, $chatId);
                    return;
                case 'balance':
                    if (empty($user['finance'])) {
                        $this->tg->send($chatId, 'دسترسی مالی نداری.');
                        return;
                    }
                    if ($arg === '') {
                        $this->tg->send($chatId, 'نام طرف حساب را بنویس: مانده احمدی');
                        return;
                    }
                    $this->tg->send($chatId, $this->api->text($user['id'], 'balance', ['q' => $arg])['text']);
                    return;
                case 'note':
                    $this->note($user, $chatId, $m, $arg);
                    return;
                default:
                    $this->note($user, $chatId, $m, $text);
                    return;
            }
        } catch (\Throwable $e) {
            $this->log(['err' => $e->getMessage(), 'chatId' => $chatId, 'text' => mb_substr($text, 0, 80)], 'handler error');
            $this->tg->send($chatId, self::errorText($e));
        }
    }

    private function start(string $chatId, string $code): void
    {
        $c = (string) preg_replace('/\D/', '', Num::toLatinDigits($code));
        if (strlen($c) !== 6) {
            $this->tg->send($chatId, 'سلام! برای اتصال به کد ۶ رقمی نیاز است. ' . $this->linkHint());
            return;
        }
        try {
            $r = $this->api->link($chatId, $c);
            $this->api->log($chatId, 'linked', (string) $r['user']['id']);
            $this->tg->send($chatId, 'خوش آمدی ' . ($r['user']['short_name'] ?? $r['user']['name']) . " ✅\n\n" . self::HELP);
        } catch (TelegramError $e) {
            throw $e;
        } catch (\Throwable $e) {
            $this->api->log($chatId, 'link_failed', $c);
            $this->tg->send($chatId, $e instanceof ApiError && $e->status === 404 ? 'کد نامعتبر یا منقضی است؛ کد تازه بگیر.' : self::errorText($e));
        }
    }

    private function report(array $user, string $chatId, ?string $date, bool $full): void
    {
        $r = $this->api->text($user['id'], 'report', ['date' => $date, 'full' => $full ? 'true' : null]);
        $this->tg->send($chatId, $r['text']);
    }

    private function pending(array $user, string $chatId): void
    {
        $r = $this->api->text($user['id'], 'pending');
        $rows = array_slice($r['items'] ?? [], 0, 10);
        $keyboard = null;
        if ($rows) {
            $kb = [];
            foreach ($rows as $i => $it) {
                $n = self::fa((string) ($i + 1));
                $kb[] = $it['type'] === 'document'
                    ? [['text' => "✅ تأیید {$n}", 'callback_data' => "doc:post:{$it['id']}"], ['text' => "❌ رد {$n}", 'callback_data' => "doc:void:{$it['id']}"]]
                    : [['text' => "✔ قبول {$n}", 'callback_data' => "bundle:accept:{$it['id']}"], ['text' => "🔁 بازکاری {$n}", 'callback_data' => "bundle:rework:{$it['id']}"], ['text' => "♻ ضایعات {$n}", 'callback_data' => "bundle:scrap:{$it['id']}"]];
            }
            $keyboard = ['inline_keyboard' => $kb];
        }
        $this->tg->send($chatId, $r['text'], $keyboard);
    }

    /** Inline buttons → the same definitive endpoints the web uses, with a fresh Idempotency-Key per tap. @param array<string,mixed> $cb */
    public function onCallback(array $cb): void
    {
        $chatId = isset($cb['message']['chat']['id']) ? (string) $cb['message']['chat']['id'] : (string) $cb['from']['id'];
        $user = $this->api->resolve($chatId)['user'] ?? null;
        if (!$user) {
            $this->tg->answerCallback((string) $cb['id'], 'این چت متصل نیست');
            return;
        }
        $parts = explode(':', (string) ($cb['data'] ?? ''));
        $kind = $parts[0] ?? '';
        $action = $parts[1] ?? '';
        $id = $parts[2] ?? '';
        try {
            if ($kind === 'task' && $action === 'done' && $id !== '') {
                $this->onTaskDone($cb, $user, $id);
                return;
            }
            if ($kind === 'doc' && $id !== '') {
                $d = $this->api->request('GET', "/documents/{$id}", ['user' => $user['id']]);
                if ($action === 'post') {
                    $this->api->request('POST', "/documents/{$id}/post", ['user' => $user['id'], 'body' => ['version' => $d['version']], 'idempotent' => true]);
                    $this->tg->answerCallback((string) $cb['id'], 'قطعی شد ✅');
                    $this->tg->send($chatId, 'سند ' . self::fa((string) $d['number']) . ' قطعی شد ✅');
                } else {
                    $this->api->request('POST', "/documents/{$id}/void", ['user' => $user['id'], 'body' => ['version' => $d['version'], 'reason' => 'رد از تلگرام'], 'idempotent' => true]);
                    $this->tg->answerCallback((string) $cb['id'], 'رد شد');
                    $this->tg->send($chatId, 'سند ' . self::fa((string) $d['number']) . ' رد و باطل شد ❌');
                }
                return;
            }
            if ($kind === 'bundle' && $id !== '' && in_array($action, ['accept', 'rework', 'scrap'], true)) {
                $b = $this->api->request('GET', "/bundles/{$id}", ['user' => $user['id']]);
                $this->api->request('POST', "/bundles/{$id}/decide", ['user' => $user['id'], 'body' => ['version' => $b['version'], 'decision' => $action, 'note' => 'تصمیم از تلگرام'], 'idempotent' => true]);
                $this->tg->answerCallback((string) $cb['id'], 'ثبت شد');
                $this->tg->send($chatId, 'بندیل ' . self::fa((string) $b['code']) . ': ' . ($action === 'accept' ? 'قبول شد ✔' : ($action === 'rework' ? 'به بازکاری رفت 🔁' : 'به ضایعات رفت ♻')));
                return;
            }
            $this->tg->answerCallback((string) $cb['id'], 'دکمهٔ ناشناخته');
        } catch (\Throwable $e) {
            $this->tg->answerCallback((string) $cb['id'], 'انجام نشد');
            $this->tg->send($chatId, self::errorText($e));
        }
    }

    private static function handle(array $u): string
    {
        $n = Num::jsTrim((string) (($u['short_name'] ?? '') !== '' ? $u['short_name'] : $u['name']));
        return '@' . preg_replace('/\s+/u', '_', $n);
    }

    private static function norm(string $s): string
    {
        return mb_strtolower(Num::jsTrim((string) preg_replace('/\s+/u', ' ', str_replace('_', ' ', Num::toLatinDigits($s)))));
    }

    /** Spec §16 `/task` (مدیر) and module 10 «مدیر برای هر کارمند کار می‌سازد»; the server enforces it too. */
    private function task(array $user, string $chatId, string $arg): void
    {
        if ($user['role'] !== 'manager') {
            $this->tg->send($chatId, 'کار جدید را فقط مدیر می‌سازد. کارهای خودت: «کارها»');
            return;
        }
        if ($arg === '') {
            $this->tg->send($chatId, 'نام کارمند و متن کار را بنویس: کار @علی زنگ به کارخانه');
            return;
        }
        $assignee = $user['id'];
        $title = $arg;
        if (preg_match('/^@(\S+)\s+(.+)$/su', $arg, $m)) {
            $users = $this->api->request('GET', '/users/directory', ['user' => $user['id']])['items'] ?? [];
            $want = self::norm($m[1]);
            $exact = array_values(array_filter($users, static fn ($u) => self::norm((string) ($u['short_name'] ?? '')) === $want || self::norm((string) $u['name']) === $want));
            $matches = $exact ?: array_values(array_filter($users, static fn ($u) => str_contains(self::norm((string) ($u['short_name'] ?? '')), $want) || str_contains(self::norm((string) $u['name']), $want)));
            if (count($matches) !== 1) {
                // Never fall back to someone else: ask again with the valid names.
                $list = implode("\n", array_map(static fn ($u) => self::handle($u) . " ({$u['name']})", array_slice($matches ?: $users, 0, 15)));
                $example = $matches[0] ?? $users[0] ?? ['id' => '', 'name' => 'علی', 'short_name' => null];
                $head = $matches ? "چند نفر با «{$m[1]}» پیدا شد؛ دقیق‌تر بنویس" : "کاربری با نام «{$m[1]}» پیدا نشد؛ یکی از این نام‌ها را بنویس";
                $this->tg->send($chatId, "{$head}:\n{$list}\nمثال: کار " . self::handle($example) . ' زنگ به کارخانه');
                return;
            }
            $assignee = $matches[0]['id'];
            $title = $m[2];
        }
        $t = $this->api->request('POST', '/tasks', ['user' => $user['id'], 'body' => ['title' => mb_substr($title, 0, 200), 'assignee_user_id' => $assignee], 'idempotent' => true]);
        $this->tg->send($chatId, "کار ثبت شد 📝 «{$t['title']}»");
    }

    private function tasks(array $user, string $chatId): void
    {
        $r = $this->api->request('GET', '/tasks', ['user' => $user['id'], 'query' => ['status' => 'open', 'assignee_user_id' => $user['id'], 'limit' => '20']]);
        $items = $r['items'] ?? [];
        if (!$items) {
            $this->tg->send($chatId, 'کار بازی نداری ✅');
            return;
        }
        $lines = ['📝 کارهای باز:'];
        foreach ($items as $i => $t) $lines[] = self::fa((string) ($i + 1)) . '. ' . $t['title'];
        $kb = [];
        foreach (array_slice($items, 0, 8) as $i => $t) $kb[] = [['text' => '✅ انجام شد ' . self::fa((string) ($i + 1)), 'callback_data' => "task:done:{$t['id']}"]];
        $this->tg->send($chatId, implode("\n", $lines), ['inline_keyboard' => $kb]);
    }

    /** Free text → free note (spec module 8); the reviewer converts it later. @param list<string> $fileIds */
    private function note(array $user, string $chatId, array $m, string $text, array $fileIds = []): void
    {
        if (Num::jsTrim($text) === '' && !$fileIds) {
            $this->tg->send($chatId, self::HELP);
            return;
        }
        $body = Num::jsTrim($text) !== '' ? Num::jsTrim($text) : ($fileIds ? 'پیوست از تلگرام' : '');
        $this->api->request('POST', '/free-notes', ['user' => $user['id'], 'body' => ['text' => $body, 'file_ids' => $fileIds, 'telegram_message_id' => "{$m['chat']['id']}:{$m['message_id']}"], 'idempotent' => true]);
        $this->tg->send($chatId, 'یادداشت ثبت شد 🗒 (' . ($fileIds ? 'با پیوست، ' : '') . 'بررسی می‌شود)');
    }

    private function noteWithFile(array $user, string $chatId, array $m, string $fileId, string $kind, string $caption): void
    {
        ['data' => $data, 'path' => $path] = $this->tg->download($fileId);
        $base = basename($path);
        $name = $base !== '' ? $base : "{$kind}.bin";
        $f = $this->api->request('POST', '/files', [
            'user' => $user['id'],
            'form' => ['fields' => ['kind' => $kind === 'voice' ? 'voice' : 'other', 'owner_entity' => 'free_notes'], 'file' => ['name' => $name, 'data' => $data]],
            'idempotent' => true,
        ]);
        // A photo whose caption names a bundle code is attached to that bundle too (spec §16 photo flow).
        if ($kind === 'photo' && preg_match('/\b(?:VT|TMP)-[A-Z0-9-]+\b/i', Num::toLatinDigits($caption), $cm)) {
            $code = $cm[0];
            $r = $this->api->text($user['id'], 'bundle', ['code' => $code]);
            if (!empty($r['id'])) {
                $this->api->request('POST', "/bundles/{$r['id']}/files", ['user' => $user['id'], 'body' => ['file_ids' => [$f['id']]], 'idempotent' => true]);
                $this->tg->send($chatId, 'عکس به بندیل ' . self::fa(strtoupper($code)) . ' پیوست شد 📷');
                return;
            }
        }
        $this->note($user, $chatId, $m, $caption, [$f['id']]);
    }

    /** @param array<string,mixed> $cb */
    public function onTaskDone(array $cb, array $user, string $id): void
    {
        $t = $this->api->request('GET', "/tasks/{$id}", ['user' => $user['id']]);
        $this->api->request('POST', "/tasks/{$id}/done", ['user' => $user['id'], 'body' => ['version' => $t['version']], 'idempotent' => true]);
        $this->tg->answerCallback((string) $cb['id'], 'انجام شد ✅');
    }
}
