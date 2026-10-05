<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Auth;
use Vitral\Core\AuthUser;
use Vitral\Core\Db;
use Vitral\Core\Log;
use Vitral\Core\Request;
use Vitral\Core\Router;
use Vitral\Core\V;
use Vitral\Lib\DailyReport;
use Vitral\Lib\Decimal;
use Vitral\Lib\Num;
use Vitral\Lib\OrdersService;
use Vitral\Lib\Scheduler;
use Vitral\Lib\Telegram\Telegram;
use Vitral\Lib\Telegram\TelegramError;
use Vitral\Lib\Telegram\Webhook;

/**
 * Port of apps/server/src/modules/bot/routes.ts: internal endpoints for the Telegram bot (spec §16), guarded by
 * BOT_SERVICE_KEY. The bot then calls the regular API as the linked user (X-Bot-User), so permissions and
 * confidential filtering stay in one place. The ready-made texts hide money from users without finance.view (T56).
 *
 * PHP only (shared hosting runs the bot as a webhook, see Lib/Telegram): settings.manage endpoints to register the
 * webhook with Telegram and to see the scheduler's state.
 */
final class Bot
{
    private const CUR = ['TOMAN' => 'تومان', 'USD' => 'دلار', 'IQD' => 'دینار'];

    private static function chatId(): \Vitral\Core\Schema
    {
        return V::string()->regex('/^-?\d{1,20}$/');
    }

    /** fa() of routes.ts: formatNumber(String(v ?? 0), kind) ?? '۰'. */
    private static function fa(mixed $v, ?string $kind = null): string
    {
        $s = $v === null ? '0' : ($v instanceof Decimal ? $v->toFixed() : (string) $v);
        return Num::formatNumber($s, $kind !== null && isset(Num::PLACES[$kind]) ? $kind : null) ?? '۰';
    }

    private static function p(string $s): string
    {
        return Num::toPersianDigits($s);
    }

    private static function guard(Request $req, App $app): void
    {
        $key = $req->header('x-bot-key');
        $service = (string) ($app->config->get('BOT_SERVICE_KEY') ?? '');
        if ($service === '' || $key === null || strlen($key) !== strlen($service) || !hash_equals($service, $key)) {
            throw new AppError('forbidden', 'کلید سرویس بات نامعتبر است');
        }
    }

    private static function userOf(Request $req, App $app): AuthUser
    {
        $uid = $req->header('x-bot-user');
        $u = $uid !== null ? Auth::loadBotUser($app->db(), $uid) : null;
        if (!$u) throw new AppError('unauthorized', 'این چت به کاربری متصل نیست');
        return $u;
    }

    public static function register(Router $r, App $app): void
    {
        // The onRequest hook of the Node module: every /internal/bot URL needs the key, even an unknown one.
        $guarded = static function (callable $fn) use ($app): callable {
            return static function (Request $req) use ($fn, $app) {
                self::guard($req, $app);
                return $fn($req);
            };
        };
        foreach (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as $m) {
            $r->add($m, '/internal/bot/*', $guarded(static fn () => throw new AppError('not_found')));
        }

        /** /start <code>: bind the chat to the user who generated the code (10-minute, single use). */
        $r->post('/internal/bot/link', $guarded(static function (Request $req) use ($app) {
            $b = V::object(['chat_id' => self::chatId(), 'code' => V::string()->regex('/^\d{6}$/')])->parse($req->body());
            $db = $app->db();
            $row = $db->one('SELECT id, user_id FROM telegram_link_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > NOW(3)', [hash('sha256', $b['code'])]);
            if (!$row) throw new AppError('not_found', 'کد نامعتبر یا منقضی است');
            $db->transaction(static function (Db $trx) use ($b, $row) {
                $trx->exec('UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = ?', [$b['chat_id']]);
                $trx->exec('UPDATE users SET telegram_chat_id = ?, updated_at = NOW(3), version = version + 1 WHERE id = ?', [$b['chat_id'], $row['user_id']]);
                $trx->exec('UPDATE telegram_link_codes SET used_at = NOW(3) WHERE id = ?', [$row['id']]);
            });
            $u = $db->one('SELECT id, name, short_name, role FROM users WHERE id = ?', [$row['user_id']]) ?? throw new \RuntimeException('no result');
            return ['user' => $u];
        }));

        /** chat_id → user (null when unregistered; the caller logs it, T55). */
        $r->get('/internal/bot/resolve', $guarded(static function (Request $req) use ($app) {
            $q = V::object(['chat_id' => self::chatId()])->parse($req->query);
            $db = $app->db();
            $u = $db->one('SELECT id, name, short_name, role, permissions FROM users WHERE telegram_chat_id = ? AND active = 1', [$q['chat_id']]);
            if (!$u) return ['user' => null];
            $au = Auth::loadBotUser($db, $u['id']);
            $u['permissions'] = $au ? $au->permissions : [];
            $u['finance'] = Auth::can($au, 'finance.view');
            return ['user' => $u];
        }));

        $r->post('/internal/bot/log', $guarded(static function (Request $req) use ($app) {
            $b = V::object(['chat_id' => self::chatId()->nullable(), 'kind' => V::string()->max(40), 'detail' => V::string()->max(2000)->nullable()->optional()])->parse($req->body());
            $app->db()->insertNoReturn('bot_log', ['chat_id' => $b['chat_id'], 'kind' => $b['kind'], 'detail' => $b['detail'] ?? null]);
            return ['ok' => true];
        }));

        /** Unsent notifications for users with a linked chat; marked sent when claimed (instant alerts, §16). */
        $r->post('/internal/bot/notifications/claim', $guarded(static function () use ($app) {
            return $app->db()->transaction(static function (Db $trx) {
                $rows = $trx->all(
                    'SELECT notifications.id, notifications.kind, notifications.title, notifications.entity, notifications.entity_id, users.telegram_chat_id AS chat_id
                       FROM notifications INNER JOIN users ON users.id = notifications.user_id
                      WHERE notifications.telegram_sent_at IS NULL AND notifications.read_at IS NULL AND users.telegram_chat_id IS NOT NULL AND users.active = 1
                      ORDER BY notifications.created_at LIMIT 50 FOR UPDATE',
                );
                if ($rows) {
                    $ids = array_column($rows, 'id');
                    $trx->exec('UPDATE notifications SET telegram_sent_at = NOW(3) WHERE id IN (' . Db::placeholders($ids) . ')', $ids);
                }
                return ['items' => $rows];
            });
        }));

        /** Managers who should receive the nightly report. */
        $r->get('/internal/bot/report-recipients', $guarded(static function () use ($app) {
            $rows = $app->db()->all("SELECT id, telegram_chat_id AS chat_id, role FROM users WHERE telegram_chat_id IS NOT NULL AND active = 1 AND role = 'manager'");
            return ['items' => $rows];
        }));

        // ── Ready-made Persian texts (the bot forwards these verbatim) ───────────────
        /** امروز / گزارش: production text for a Jalali date + a short decision summary. Money only for finance.view (T56). */
        $r->get('/internal/bot/text/report', $guarded(static function (Request $req) use ($app) {
            $me = self::userOf($req, $app);
            $q = V::object(['date' => V::string()->optional(), 'full' => V::boolQuery()->default(false)])->parse($req->query);
            try {
                $date = Pdf::jalaliDateArg($q['date'] ?? null);
            } catch (\RangeException) {
                throw new AppError('validation', 'تاریخ شمسی نامعتبر است', ['date' => 'نامعتبر']);
            }
            $rep = DailyReport::buildDailyReport($app->db(), $date, ['finance' => Auth::can($me, 'finance.view'), 'userId' => $me->id]);
            $lines = [$q['full'] ? $rep['production']['text_full'] : $rep['production']['text']];
            $d = $rep['decisions'];
            $nq = count($d['quarantine']);
            $nw = count($d['weight_warnings']);
            $ni = count($d['incomplete_documents']);
            $pm = (int) ($d['pending_money'] ?? 0);
            if ($nq || $nw || $ni || $pm) {
                array_push($lines, '', '⚠️ نیازمند تصمیم:');
                if ($nq) $lines[] = '• ' . self::fa($nq) . ' بندیل در قرنطینه';
                if ($nw) $lines[] = '• ' . self::fa($nw) . ' هشدار وزن';
                if ($ni) $lines[] = '• ' . self::fa($ni) . ' سند/قبض ناقص';
                if ($pm) $lines[] = '• ' . self::fa($pm) . ' دریافت/پرداخت در انتظار تأیید';
            }
            if ($rep['transfers']) {
                array_push($lines, '', '🚚 بارها:');
                foreach ($rep['transfers'] as $t) $lines[] = '• ' . self::p((string) $t['number']) . ' ' . ($t['from_name'] ?? '') . ' ← ' . ($t['to_name'] ?? '') . ' · ' . self::fa($t['kg'] ?? null, 'weight') . ' کیلو · ' . $t['status'];
            }
            if (!empty($rep['money'])) {
                array_push($lines, '', '💰 دریافت/پرداخت امروز:');
                foreach ($rep['money'] as $m) $lines[] = '• ' . ($m['kind'] === 'receipt' ? 'دریافت' : 'پرداخت') . ' ' . self::fa($m['amount'] ?? null, (string) $m['currency']) . ' ' . (self::CUR[(string) $m['currency']] ?? 'undefined') . ' از/به ' . ($m['party_name'] ?? '—') . " ({$m['status']})";
            }
            if ($rep['tasks']['open']) array_push($lines, '', '📝 کارهای باز: ' . self::fa(count($rep['tasks']['open'])));
            return ['text' => implode("\n", $lines), 'date' => $rep['date']];
        }));

        /** بندیل <code>: one bundle, with where it is and its state. */
        $r->get('/internal/bot/text/bundle', $guarded(static function (Request $req) use ($app) {
            self::userOf($req, $app);
            $q = V::object(['code' => V::string()->min(1)->max(40)])->parse($req->query);
            $db = $app->db();
            $b = $db->one('SELECT bundles.*, locations.name AS location_name FROM bundles LEFT JOIN locations ON locations.id = bundles.location_id WHERE bundles.code = ?', [strtoupper($q['code'])]);
            if (!$b) return ['text' => 'بندیلی با کد ' . self::p($q['code']) . ' پیدا نشد.'];
            $lines = $db->all('SELECT products.name_fa, bundle_lines.bars, bundle_lines.length_m, bundle_lines.filler_mm, bundle_lines.weight_kg FROM bundle_lines INNER JOIN products ON products.id = bundle_lines.product_id WHERE bundle_id = ?', [$b['id']]);
            $pos = $db->one("SELECT state_to FROM stock_moves WHERE item_type = 'bundle' AND item_id = ? ORDER BY at DESC LIMIT 1", [$b['id']]);
            $status = ['ok' => 'سالم', 'damaged' => 'آسیب‌دیده', 'wrong_product' => 'محصول اشتباه', 'pending_review' => 'در انتظار بررسی', 'scrapped' => 'ضایعات شد', 'consumed' => 'مصرف شد'];
            $form = ['raw' => 'خام', 'painted' => 'رنگ‌شده', 'anodized' => 'آنادایز'];
            $out = [
                '📦 بندیل ' . self::p($b['code']) . ($b['code_is_temp'] ? ' (کد موقت)' : ''),
                'وزن: ' . self::fa($b['weight_kg'], 'weight') . ' کیلو · ' . ($form[$b['form']] ?? $b['form']) . ' · ' . ($status[$b['status']] ?? $b['status']),
                'مکان: ' . ($b['location_name'] ?? '—') . (!empty($pos['state_to']) ? " ({$pos['state_to']})" : ''),
            ];
            $t = static fn ($v) => $v !== null && $v !== '' && $v !== 0;
            foreach ($lines as $l) {
                $out[] = '• ' . $l['name_fa'] . ($t($l['bars']) ? ' · ' . self::fa($l['bars']) . ' شاخه' : '') . ($t($l['length_m']) ? ' · ' . self::fa($l['length_m'], 'length') . ' متر' : '') . ($t($l['filler_mm']) ? ' · فیلر ' . self::fa($l['filler_mm'], 'filler') : '') . ($t($l['weight_kg']) ? ' · ' . self::fa($l['weight_kg'], 'weight') . ' کیلو' : '');
            }
            if (is_array($b['warnings']) && array_is_list($b['warnings']) && $b['warnings']) {
                $out[] = '⚠️ ' . implode(' / ', array_map(static fn ($w) => (string) (((array) $w)['message'] ?? ''), $b['warnings']));
            }
            return ['text' => implode("\n", $out), 'id' => $b['id']];
        }));

        /** سفارش <number>: statuses in one glance. */
        $r->get('/internal/bot/text/order', $guarded(static function (Request $req) use ($app) {
            $me = self::userOf($req, $app);
            $q = V::object(['number' => V::string()->min(1)->max(40)])->parse($req->query);
            $db = $app->db();
            $o = $db->one('SELECT orders.*, parties.name AS party_name FROM orders INNER JOIN parties ON parties.id = orders.party_id WHERE orders.number = ?', [strtoupper($q['number'])]);
            if (!$o) return ['text' => 'سفارش ' . self::p($q['number']) . ' پیدا نشد.'];
            $party = $o['party_name'];
            unset($o['party_name']);
            $lines = OrdersService::loadLines($db, $o['id']);
            $totals = OrdersService::orderTotals($o, $lines, OrdersService::postedReceiptsForOrder($db, $o['id']));
            $st = OrdersService::computeStatuses($db, $o, $lines, $totals);
            $out = [
                '🧾 سفارش ' . self::p($o['number']) . ' · ' . $party,
                "وضعیت فروش: {$o['status_sales']} · تأمین: {$st['supply']} · عملیات: {$st['operations']} · ارسال: {$st['shipping']}",
                'وزن کل: ' . self::fa($totals['total_kg'], 'weight') . ' کیلو · ' . self::fa(count($lines)) . ' ردیف',
            ];
            if (Auth::can($me, 'finance.view')) {
                $paid = (array) $totals['paid'];
                $remaining = (array) $totals['remaining'];
                foreach ((array) $totals['totals'] as $c => $v) {
                    $out[] = 'جمع: ' . self::fa($v, $c) . ' ' . (self::CUR[$c] ?? $c) . ' · دریافتی ' . self::fa($paid[$c] ?? 0, $c) . ' · مانده ' . self::fa($remaining[$c] ?? $v, $c);
                }
                $out[] = "مالی: {$st['finance']}";
            }
            if (!empty($st['next_action'])) $out[] = '➡️ اقدام بعدی: ' . (OrdersService::NEXT_ACTION_LABELS[$st['next_action']] ?? $st['next_action']);
            return ['text' => implode("\n", $out), 'id' => $o['id']];
        }));

        /** انبار: positions by location/state (weights only; no values). */
        $r->get('/internal/bot/text/stock', $guarded(static function (Request $req) use ($app) {
            self::userOf($req, $app);
            $items = Stock::positionsDetailed($app->db());
            $byLoc = [];
            $total = Decimal::zero();
            foreach ($items as $p) {
                $lid = $p['location_id'];
                $byLoc[$lid] ??= ['name' => $p['location_name'], 'kg' => Decimal::zero(), 'states' => []];
                $byLoc[$lid]['kg'] = $byLoc[$lid]['kg']->add((string) $p['kg']);
                $s = $p['state'] ?? '؟';
                $byLoc[$lid]['states'][$s] = ($byLoc[$lid]['states'][$s] ?? Decimal::zero())->add((string) $p['kg']);
                $total = $total->add((string) $p['kg']);
            }
            $stateFa = ['ingot' => 'شمش', 'scrap' => 'ضایعات', 'raw' => 'خام', 'coated' => 'رنگ‌شده', 'quarantine' => 'قرنطینه', 'in_transit' => 'در راه', 'paint' => 'پودر رنگ', 'tool' => 'ابزار'];
            $locs = array_values($byLoc);
            usort($locs, static fn ($a, $b) => $b['kg']->cmp($a['kg']));
            $out = ['🏭 موجودی به کیلو'];
            foreach ($locs as $l) {
                $parts = [];
                foreach ($l['states'] as $s => $k) $parts[] = ($stateFa[$s] ?? $s) . ' ' . self::fa(Num::round($k, 'weight'), 'weight');
                $out[] = '• ' . $l['name'] . ': ' . self::fa(Num::round($l['kg'], 'weight'), 'weight') . ' (' . implode('، ', $parts) . ')';
            }
            $out[] = 'جمع: ' . self::fa(Num::round($total, 'weight'), 'weight') . ' کیلو';
            return ['text' => implode("\n", $out)];
        }));

        /** تأییدها: pending items the user may act on (finance only sees money). */
        $r->get('/internal/bot/text/pending', $guarded(static function (Request $req) use ($app) {
            $me = self::userOf($req, $app);
            $db = $app->db();
            $items = [];
            $bundles = $db->all("SELECT id, code, weight_kg, defect FROM bundles WHERE status IN ('pending_review', 'damaged', 'wrong_product') AND decision IS NULL AND draft = 0 LIMIT 20");
            foreach ($bundles as $b) {
                $items[] = ['type' => 'bundle', 'id' => $b['id'], 'label' => 'بندیل ' . self::p($b['code']) . ' ' . self::fa($b['weight_kg'], 'weight') . ' کیلو' . ($b['defect'] !== null && $b['defect'] !== '' ? " — {$b['defect']}" : '')];
            }
            if (Auth::can($me, 'finance.view')) {
                $docs = $db->all("SELECT documents.id, documents.number, documents.kind, documents.amount, documents.currency, parties.name AS party_name, documents.status FROM documents LEFT JOIN parties ON parties.id = documents.party_id WHERE documents.status IN ('reported', 'needs_completion') ORDER BY documents.created_at DESC LIMIT 20");
                foreach ($docs as $d) {
                    $kind = $d['kind'] === 'receipt' ? 'دریافت' : ($d['kind'] === 'payment' ? 'پرداخت' : $d['kind']);
                    $amount = $d['amount'] !== null && $d['amount'] !== '' ? self::fa($d['amount'], (string) $d['currency']) . ' ' . (self::CUR[(string) $d['currency']] ?? 'undefined') : '(ناقص)';
                    $items[] = ['type' => 'document', 'id' => $d['id'], 'label' => "{$kind} " . self::p((string) $d['number']) . " {$amount} " . ($d['party_name'] ?? '') . ($d['status'] === 'needs_completion' ? ' — ناقص' : '')];
                }
            }
            if (!$items) return ['text' => 'چیزی در انتظار تأیید نیست ✅', 'items' => $items];
            $out = ['⏳ در انتظار تأیید:'];
            foreach ($items as $i => $it) $out[] = self::p((string) ($i + 1)) . '. ' . $it['label'];
            return ['text' => implode("\n", $out), 'items' => $items];
        }));

        /** مانده <party>: balance per currency (finance.view only; T56). */
        $r->get('/internal/bot/text/balance', $guarded(static function (Request $req) use ($app) {
            $me = self::userOf($req, $app);
            if (!Auth::can($me, 'finance.view')) throw new AppError('forbidden', 'دسترسی مالی ندارید');
            $q = V::object(['q' => V::string()->min(1)->max(80)])->parse($req->query);
            $db = $app->db();
            $parties = $db->all('SELECT id, name FROM parties WHERE name LIKE ? LIMIT 5', [Db::like($q['q'])]);
            if (!$parties) return ['text' => "طرف حسابی با نام «{$q['q']}» پیدا نشد."];
            if (count($parties) > 1) return ['text' => 'چند طرف حساب پیدا شد: ' . implode('، ', array_column($parties, 'name')) . '. نام دقیق‌تر بنویس.'];
            $st = Money::partyStatement($db, $parties[0]['id']);
            $out = ["💼 مانده {$parties[0]['name']}:"];
            foreach ((array) $st['closing'] as $c => $v) {
                $out[] = '• ' . self::fa($v, $c) . ' ' . (self::CUR[$c] ?? $c) . ' ' . (Decimal::of((string) $v)->gte(0) ? '(طلب ویترال)' : '(بدهی ویترال)');
            }
            if (count($out) === 1) $out[] = '• صفر';
            return ['text' => implode("\n", $out)];
        }));

        // ── PHP only: webhook registration and scheduler state (settings.manage) ─────
        $r->get('/bot/telegram', static function (Request $req) use ($app) {
            $req->requirePermission('settings.manage');
            $tg = Telegram::fromConfig($app->config);
            $state = Scheduler::loadState($app);
            $out = [
                'configured' => $tg !== null,
                'service_key_configured' => (bool) $app->config->get('BOT_SERVICE_KEY'),
                'webhook_url' => Webhook::defaultUrl($app),
                'lazy_cron' => Scheduler::lazyEnabled($app),
                'scheduler' => [
                    'last_run' => $state['last_run'] ?? null,
                    'snapshot_day' => $state['snapshot_day'] ?? null,
                    'nightly_day' => $state['nightly_day'] ?? null,
                    'telegram_down_until' => isset($state['telegram_down_until']) ? gmdate('Y-m-d\TH:i:s\Z', (int) $state['telegram_down_until']) : null,
                ],
                'telegram' => null,
                'telegram_error' => null,
            ];
            if ($tg !== null) {
                try {
                    $info = $tg->getWebhookInfo();
                    $out['telegram'] = is_array($info) ? array_intersect_key($info, array_flip(['url', 'pending_update_count', 'last_error_date', 'last_error_message', 'max_connections'])) : null;
                } catch (TelegramError $e) {
                    $out['telegram_error'] = $e->network ? 'دسترسی به سرور تلگرام از این میزبان ممکن نیست' : self::redact($e->getMessage(), $app);
                }
            }
            return $out;
        });

        /** setWebhook: Telegram posts updates to <PUBLIC_URL>/telegram.php with the secret header. */
        $r->post('/bot/telegram/webhook', static function (Request $req) use ($app) {
            $me = $req->requirePermission('settings.manage');
            $body = $req->body();
            $b = V::object(['url' => V::string()->url()->startsWith('https://', 'نشانی باید https باشد')->max(500)->optional()])->parse($body instanceof \Vitral\Core\Undef ? new \stdClass() : $body);
            $tg = Telegram::fromConfig($app->config) ?? throw new AppError('validation', 'توکن بات تلگرام تنظیم نشده است (TELEGRAM_BOT_TOKEN در config.php)');
            if (!$app->config->get('BOT_SERVICE_KEY')) throw new AppError('validation', 'BOT_SERVICE_KEY در config.php تنظیم نشده است');
            $url = $b['url'] ?? Webhook::defaultUrl($app) ?? throw new AppError('validation', 'نشانی عمومی برنامه (PUBLIC_URL) تنظیم نشده است', ['url' => 'لازم است']);
            try {
                $tg->setWebhook($url, Telegram::webhookSecret($app->config));
            } catch (TelegramError $e) {
                Log::warn('setWebhook failed', ['err' => self::redact($e->getMessage(), $app)]);
                throw new AppError('validation', $e->network ? 'دسترسی به سرور تلگرام از این میزبان ممکن نیست' : 'تلگرام نپذیرفت: ' . self::redact($e->getMessage(), $app));
            }
            \Vitral\Core\Audit::log($app->db(), ['userId' => $me->id, 'entity' => 'settings', 'entityId' => null, 'action' => 'telegram_webhook_set', 'after' => ['url' => $url]]);
            return ['ok' => true, 'url' => $url];
        });

        $r->delete('/bot/telegram/webhook', static function (Request $req) use ($app) {
            $me = $req->requirePermission('settings.manage');
            $tg = Telegram::fromConfig($app->config) ?? throw new AppError('validation', 'توکن بات تلگرام تنظیم نشده است (TELEGRAM_BOT_TOKEN در config.php)');
            try {
                $tg->deleteWebhook();
            } catch (TelegramError $e) {
                throw new AppError('validation', $e->network ? 'دسترسی به سرور تلگرام از این میزبان ممکن نیست' : 'تلگرام نپذیرفت: ' . self::redact($e->getMessage(), $app));
            }
            \Vitral\Core\Audit::log($app->db(), ['userId' => $me->id, 'entity' => 'settings', 'entityId' => null, 'action' => 'telegram_webhook_deleted']);
            return ['ok' => true];
        });
    }

    /** Never echo the bot token back. */
    private static function redact(string $s, App $app): string
    {
        $token = (string) ($app->config->get('TELEGRAM_BOT_TOKEN') ?? '');
        return $token !== '' ? str_replace($token, '***', $s) : $s;
    }
}
