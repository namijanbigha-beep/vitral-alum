<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\Auth;
use Vitral\Core\AuthUser;
use Vitral\Core\Db;
use Vitral\Core\Idempotency;
use Vitral\Core\Notify;
use Vitral\Core\Numbering;
use Vitral\Core\Pagination;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\Schema;
use Vitral\Core\Settings;
use Vitral\Core\Undef;
use Vitral\Core\V;
use Vitral\Lib\Decimal;
use Vitral\Lib\Num;
use Vitral\Lib\OrdersService as S;

/** Port of apps/server/src/modules/orders/routes.ts (service.ts → Lib/OrdersService). */
final class Orders
{
    private const AFTER_APPROVAL_FIELDS = ['product_id', 'product_filler_id', 'qty_kg', 'qty_bars', 'qty_pieces', 'unit_price', 'currency', 'discount_amount', 'discount_percent', 'price_basis', 'length_m', 'color'];
    private const MATERIAL_KEYS = ['destination_country', 'destination_city', 'destination_address', 'currency', 'prepay_percent', 'prepay_amount'];

    public static function lineSchema(): Schema
    {
        return V::object([
            'id' => V::uuid()->optional(),
            'sort' => V::int()->min(0)->default(0),
            'kind' => V::enum(['profile', 'material', 'die_making', 'service'])->default('profile'),
            'product_id' => V::uuid()->nullable()->optional(),
            'product_filler_id' => V::uuid()->nullable()->optional(),
            'filler_mm' => V::decimalString()->nullable()->optional(),
            'length_m' => V::decimalString()->nullable()->optional(),
            'min_length_m' => V::decimalString()->nullable()->optional(),
            'color' => V::optText(80),
            'load_type_label' => V::optText(60),
            'weight_g_per_m' => V::decimalString()->nullable()->optional(),
            'calc_mode' => V::enum(['from_bars', 'from_weight', 'manual'])->default('manual'),
            'qty_bars' => V::decimalString()->nullable()->optional(),
            'qty_kg' => V::decimalString()->nullable()->optional(),
            'qty_pieces' => V::int()->min(0)->nullable()->optional(),
            'price_basis' => V::enum(['per_kg', 'per_bar', 'per_meter', 'per_piece'])->default('per_kg'),
            'unit_price' => V::decimalString()->nullable()->optional(),
            'currency' => V::enum(Num::CURRENCIES)->optional(),
            'discount_amount' => V::decimalString()->default('0'),
            'discount_percent' => V::decimalString()->default('0'),
            'supply_method' => V::enum(['toll_production', 'stock', 'buy_raw_then_paint', 'buy_finished'])->nullable()->optional(),
            'die_id' => V::uuid()->nullable()->optional(),
            'material_kind' => V::enum(['ingot', 'billet', 'scrap', 'paint_powder', 'tool'])->nullable()->optional(),
            'coating_gain_estimate_percent' => V::decimalString()->nullable()->optional(),
            'name_ar' => V::optText(200),
            'name_en' => V::optText(200),
            'description' => V::optText(500),
            'file_id' => V::uuid()->nullable()->optional(),
            'note' => V::optText(1000),
        ]);
    }

    /**
     * orderBase of the Node code. For the update schema every field is `.optional()` on top of its default, which in
     * zod means a missing key stays missing (ZodOptional answers undefined before ZodDefault runs): no defaults there.
     * @return array<string,Schema>
     */
    private static function orderBase(bool $forUpdate): array
    {
        $def = static fn (Schema $s, mixed $d) => $forUpdate ? $s->optional() : $s->default($d);
        $opt = static fn (Schema $s) => $forUpdate ? $s->optional() : $s;
        return [
            'title' => V::optText(200),
            'party_id' => $opt(V::uuid()),
            'currency' => $def(V::enum(Num::CURRENCIES), 'TOMAN'),
            'settlement_basis' => $def(V::enum(['final_net_scale', 'agreed_weight']), 'final_net_scale'),
            'prepay_percent' => V::decimalString()->nullable()->optional(),
            'prepay_amount' => V::decimalString()->nullable()->optional(),
            'payment_terms' => $def(V::enum(['cash', 'credit']), 'cash'),
            'valid_until' => V::dateOnly()->nullable()->optional(),
            'validity_text' => V::optText(500),
            'delivery_days' => V::int()->min(0)->nullable()->optional(),
            'due_date' => V::dateOnly()->nullable()->optional(),
            'order_date' => V::dateOnly()->optional(),
            'destination_country' => V::optText(80),
            'destination_city' => V::optText(80),
            'destination_address' => V::optText(500),
            'owner_user_id' => V::uuid()->nullable()->optional(),
            'invoice_notes' => V::optText(4000),
            'internal_note' => V::optText(4000),
            'numbering_kind' => V::enum(['order', 'wholesale_proforma'])->optional(),
        ];
    }

    private static function truthy(mixed $v): bool
    {
        return !($v === null || $v === false || $v === '' || $v === 0);
    }

    /** @return array<string,mixed> the order_lines values for an input line */
    private static function resolveLine(Db $trx, string $orderCurrency, array $input): array
    {
        $l = $input;
        $l['currency'] = $input['currency'] ?? $orderCurrency;
        unset($l['id']);
        if ($input['kind'] === 'profile') {
            if (!self::truthy($input['product_id'] ?? null)) throw new AppError('validation', 'محصول ردیف لازم است', ['product_id' => 'لازم است']);
            $weightUnapproved = false;
            if (self::truthy($input['product_filler_id'] ?? null)) {
                $f = $trx->one('SELECT * FROM product_fillers WHERE id = ?', [$input['product_filler_id']]);
                if (!$f || $f['product_id'] !== $input['product_id']) throw new AppError('validation', 'فیلر با محصول نمی‌خواند', ['product_filler_id' => 'نامعتبر']);
                $l['filler_mm'] = $f['filler_mm'];
                if ($f['status'] === 'approved') {
                    $l['weight_g_per_m'] = $input['weight_g_per_m'] ?? $f['weight_g_per_m'];
                } else {
                    $weightUnapproved = true;
                    $l['weight_g_per_m'] = $input['weight_g_per_m'] ?? null;
                }
            } elseif (self::truthy($input['weight_g_per_m'] ?? null)) {
                $weightUnapproved = true;
            }
            $l['weight_unapproved'] = $weightUnapproved;
            if (!self::truthy($l['weight_g_per_m'] ?? null) && $input['calc_mode'] !== 'manual') {
                throw new AppError('validation', 'بدون وزن هر متر فقط حالت دستی ممکن است', ['calc_mode' => 'فقط دستی']);
            }
            if (!self::truthy($l['length_m'] ?? null)) {
                $common = $trx->one('SELECT common_lengths FROM products WHERE id = ?', [$input['product_id']]);
                $cl = $common['common_lengths'] ?? null;
                $first = is_array($cl) && array_key_exists(0, $cl) ? $cl[0] : null;
                $l['length_m'] = $first ?? '6';
            }
        }
        $q = S::computeLineQty(array_merge($l, ['kind' => $input['kind'], 'calc_mode' => $input['calc_mode'], 'weight_g_per_m' => $l['weight_g_per_m'] ?? null]));
        return array_merge($l, $q);
    }

    /** @return array<string,mixed> */
    public static function presentOrder(Db $db, array $order, AuthUser $user): array
    {
        $lines = S::loadLines($db, $order['id']);
        $paid = S::postedReceiptsForOrder($db, $order['id']);
        $totals = S::orderTotals($order, $lines, $paid);
        $statuses = S::computeStatuses($db, $order, $lines, $totals);
        $party = $db->one('SELECT name, name_ar, phones, address, city, country FROM parties WHERE id = ?', [$order['party_id']]);
        $owner = self::truthy($order['owner_user_id']) ? $db->one('SELECT name, short_name FROM users WHERE id = ?', [$order['owner_user_id']]) : null;
        $out = [
            'id' => $order['id'], 'number' => $order['number'], 'title' => $order['title'], 'party_id' => $order['party_id'], 'party' => $party, 'currency' => $order['currency'], 'settlement_basis' => $order['settlement_basis'],
            'prepay_percent' => $order['prepay_percent'], 'prepay_amount' => $order['prepay_amount'], 'payment_terms' => $order['payment_terms'], 'valid_until' => $order['valid_until'], 'validity_text' => $order['validity_text'],
            'delivery_days' => $order['delivery_days'], 'due_date' => $order['due_date'], 'order_date' => $order['order_date'], 'destination_country' => $order['destination_country'], 'destination_city' => $order['destination_city'], 'destination_address' => $order['destination_address'],
            'owner_user_id' => $order['owner_user_id'], 'owner' => $owner, 'status_sales' => $order['status_sales'], 'revision' => $order['revision'], 'approved_by' => $order['approved_by'], 'approved_at' => $order['approved_at'],
            'invoice_notes' => $order['invoice_notes'], 'internal_note' => $order['internal_note'], 'archived' => $order['archived'], 'print_count' => $order['print_count'], 'cancel_reason' => $order['cancel_reason'],
            'lines' => array_map([S::class, 'presentLine'], $lines), 'totals' => S::totalsJson($totals),
            'statuses' => $statuses + ['next_action_label' => $statuses['next_action'] !== null ? (S::NEXT_ACTION_LABELS[$statuses['next_action']] ?? null) : null],
            'created_at' => $order['created_at'], 'updated_at' => $order['updated_at'], 'version' => $order['version'],
        ];
        if ($party === null) unset($out['party']); // executeTakeFirst() → undefined → key dropped by JSON
        if (!Auth::can($user, 'finance.view')) unset($out['internal_note']);
        return $out;
    }

    private static function load(Db $trx, string $id, bool $lock = false): array
    {
        $o = $trx->find('orders', $id, $lock);
        if (!$o) throw new AppError('not_found');
        return $o;
    }

    public static function register(Router $r, App $app): void
    {
        $db = static fn (): Db => $app->db();

        $r->get('/orders', static function (Request $req) use ($db) {
            $me = $req->requireUser();
            $q = V::listQuery()->extend([
                'q' => V::string()->max(100)->optional(),
                'status' => V::enum(['draft', 'proforma', 'approved', 'cancelled'])->optional(),
                'party_id' => V::uuid()->optional(),
                'archived' => V::enum(['true', 'false'])->default('false'),
                'owner' => V::enum(['me'])->optional(),
            ])->parse($req->query);
            $where = ['orders.archived = ?'];
            $params = [$q['archived'] === 'true' ? 1 : 0];
            if (self::truthy($q['status'] ?? null)) { $where[] = 'orders.status_sales = ?'; $params[] = $q['status']; }
            if (self::truthy($q['party_id'] ?? null)) { $where[] = 'orders.party_id = ?'; $params[] = $q['party_id']; }
            if (($q['owner'] ?? null) === 'me') { $where[] = 'orders.owner_user_id = ?'; $params[] = $me->id; }
            if (self::truthy($q['q'] ?? null)) {
                $like = Db::like($q['q']);
                $where[] = '(orders.number LIKE ? OR orders.title LIKE ? OR parties.name LIKE ?)';
                array_push($params, $like, $like, $like);
            }
            $cursor = Pagination::decodeCursor($q['cursor'] ?? null);
            if ($cursor) {
                $where[] = '(orders.created_at, orders.id) < (?, ?)';
                array_push($params, Db::dt($cursor['at']), $cursor['id']);
            }
            $params[] = $q['limit'] + 1;
            $rows = $db()->all(
                'SELECT orders.*, parties.name AS party_name FROM orders INNER JOIN parties ON parties.id = orders.party_id WHERE ' . implode(' AND ', $where)
                . ' ORDER BY orders.created_at DESC, orders.id DESC LIMIT ?',
                $params,
            );
            $page = array_slice($rows, 0, $q['limit']);
            $ids = array_map(static fn ($o) => $o['id'], $page);
            $lines = $ids ? $db()->all('SELECT * FROM order_lines WHERE order_id IN (' . Db::placeholders($ids) . ')', $ids) : [];
            $items = [];
            foreach ($page as $o) {
                $ls = array_values(array_filter($lines, static fn ($l) => $l['order_id'] === $o['id']));
                $t = S::orderTotals($o, $ls, []);
                $items[] = [
                    'id' => $o['id'], 'number' => $o['number'], 'title' => $o['title'], 'party_id' => $o['party_id'], 'party_name' => $o['party_name'], 'currency' => $o['currency'], 'status_sales' => $o['status_sales'],
                    'due_date' => $o['due_date'], 'order_date' => $o['order_date'], 'archived' => $o['archived'], 'totals' => (object) $t['totals'], 'total_kg' => $t['total_kg'], 'line_count' => count($ls),
                    'created_at' => $o['created_at'], 'version' => $o['version'],
                ];
            }
            $last = $page ? $page[count($page) - 1] : null;
            return ['items' => $items, 'next_cursor' => count($rows) > $q['limit'] && $last ? Pagination::encodeCursor($last['created_at'], $last['id']) : null];
        });

        $r->get('/orders/:id', static function (Request $req) use ($db) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            return self::presentOrder($db(), self::load($db(), $id), $me);
        });

        $r->post('/orders', static function (Request $req) use ($db) {
            $me = $req->requireUser();
            $key = Idempotency::requireKey($req);
            $body = V::object(self::orderBase(false) + ['lines' => V::array(self::lineSchema())->max(200)->default([])])->parse($req->body());
            $res = Idempotency::run($db(), $key, $me->id, 'POST /orders', static function (Db $trx) use ($body, $me) {
                $lines = $body['lines'];
                $numberingKind = $body['numbering_kind'] ?? null;
                $o = $body;
                unset($o['lines'], $o['numbering_kind']);
                $prepay = $o['prepay_percent'] ?? Settings::get($trx, 'default_prepay_percent');
                $deliveryDays = $o['delivery_days'] ?? Settings::get($trx, 'default_delivery_days');
                $validity = $o['validity_text'] ?? Settings::get($trx, 'proforma_validity_text');
                $notes = $o['invoice_notes'] ?? Settings::get($trx, 'sales_terms_fa');
                $at = self::truthy($o['order_date'] ?? null) ? new \DateTimeImmutable("{$o['order_date']}T12:00:00+03:30") : new \DateTimeImmutable('now');
                $order = $trx->insert('orders', array_merge($o, [
                    'number' => Numbering::next($trx, $numberingKind ?? 'order', $at),
                    'prepay_percent' => $prepay, 'delivery_days' => $deliveryDays, 'validity_text' => $validity, 'invoice_notes' => $notes,
                    'owner_user_id' => $o['owner_user_id'] ?? $me->id, 'created_by' => $me->id,
                ]));
                foreach ($lines as $i => $l) {
                    $l['sort'] = self::truthy($l['sort']) ? $l['sort'] : $i;
                    $v = self::resolveLine($trx, $order['currency'], $l);
                    $trx->insertNoReturn('order_lines', array_merge($v, ['order_id' => $order['id'], 'created_by' => $me->id]));
                }
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'orders', 'entityId' => $order['id'], 'action' => 'create', 'after' => $order]);
                return ['status' => 201, 'body' => self::presentOrder($trx, $order, $me)];
            });
            return Response::json($res['body'], $res['status']);
        });

        // Draft/proforma: free edit. Approved: changes to price/qty/product/destination create a revision with a reason (T51).
        $r->patch('/orders/:id', static function (Request $req) use ($db) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $body = V::object(V::versionField() + self::orderBase(true) + ['lines' => V::array(self::lineSchema())->max(200)->optional()])->parse($req->body());
            return $db()->transaction(static function (Db $trx) use ($id, $body, $me) {
                $before = self::load($trx, $id, true);
                if ($before['version'] !== $body['version']) throw AppError::conflict(self::presentOrder($trx, $before, $me));
                if ($before['status_sales'] === 'cancelled') throw new AppError('validation', 'سفارش لغوشده ویرایش نمی‌شود');
                $reason = $body['reason'] ?? null;
                $lines = array_key_exists('lines', $body) ? $body['lines'] : null;
                $patch = $body;
                unset($patch['version'], $patch['reason'], $patch['lines'], $patch['numbering_kind']);
                $beforeLines = S::loadLines($trx, $id);
                $approved = $before['status_sales'] === 'approved';
                if ($approved) {
                    if (!Auth::can($me, 'sales.approve')) throw new AppError('forbidden', 'تغییر سفارش تأییدشده فقط با مجوز فروش');
                    $material = (bool) array_intersect(array_keys($patch), self::MATERIAL_KEYS) || $lines !== null;
                    if ($material && !self::truthy($reason)) throw new AppError('validation', 'برای تغییر سفارش تأییدشده دلیل لازم است', ['reason' => 'لازم است']);
                    if ($material) {
                        $trx->insertNoReturn('order_revisions', [
                            'order_id' => $id, 'revision' => $before['revision'], 'snapshot' => S::snapshotOrder($before, $beforeLines), 'reason' => $reason, 'created_by' => $me->id,
                        ]);
                        $patch['revision'] = $before['revision'] + 1;
                    }
                }
                $after = $trx->updateById('orders', $id, array_merge($patch, Db::bump()));
                if ($lines !== null) {
                    $keep = [];
                    foreach ($lines as $i => $l) {
                        $l['sort'] = self::truthy($l['sort']) ? $l['sort'] : $i;
                        $v = self::resolveLine($trx, $after['currency'], $l);
                        if (self::truthy($l['id'] ?? null)) {
                            $existing = null;
                            foreach ($beforeLines as $b) if ($b['id'] === $l['id']) { $existing = $b; break; }
                            if (!$existing) throw new AppError('not_found', 'ردیف سفارش پیدا نشد');
                            if ($approved && !self::truthy($reason)) {
                                foreach (self::AFTER_APPROVAL_FIELDS as $k) {
                                    if (Schema::jsString($v[$k] ?? '') !== Schema::jsString($existing[$k] ?? '')) {
                                        throw new AppError('validation', 'تغییر ردیف سفارش تأییدشده دلیل لازم دارد', ['reason' => 'لازم است']);
                                    }
                                }
                            }
                            $trx->update('order_lines', array_merge($v, Db::bump()), 'id = ?', [$l['id']]);
                            $keep[$l['id']] = true;
                        } else {
                            $newId = $trx->insertNoReturn('order_lines', array_merge($v, ['order_id' => $id, 'created_by' => $me->id]));
                            $keep[$newId] = true;
                        }
                    }
                    foreach ($beforeLines as $b) {
                        if (isset($keep[$b['id']])) continue;
                        $used = $trx->one('SELECT id FROM bundle_lines WHERE order_line_id = ? LIMIT 1', [$b['id']]);
                        $res = $trx->one("SELECT id FROM reservations WHERE order_line_id = ? AND status = 'active' LIMIT 1", [$b['id']]);
                        if ($used || $res) throw new AppError('validation', 'ردیفی که تولید یا رزرو دارد حذف نمی‌شود');
                        $trx->exec('DELETE FROM order_lines WHERE id = ?', [$b['id']]);
                    }
                }
                Audit::log($trx, [
                    'userId' => $me->id, 'entity' => 'orders', 'entityId' => $id, 'action' => $approved ? 'revise' : 'update',
                    'before' => S::snapshotOrder($before, $beforeLines), 'after' => S::snapshotOrder($after, S::loadLines($trx, $id)), 'reason' => $reason,
                ]);
                return self::presentOrder($trx, $after, $me);
            });
        });

        $r->get('/orders/:id/revisions', static function (Request $req) use ($db) {
            $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            return ['items' => $db()->all('SELECT * FROM order_revisions WHERE order_id = ? ORDER BY revision DESC', [$id])];
        });

        $action = static function (Request $req, string $name, ?string $perm, callable $work) use ($db) {
            $me = $perm ? $req->requirePermission($perm) : $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $key = Idempotency::requireKey($req);
            $raw = $req->body();
            if ($raw instanceof Undef || $raw === null) $raw = new \stdClass();
            $body = V::object(['version' => V::int(), 'reason' => V::optText(1000)])->passthrough()->parse($raw);
            $res = Idempotency::run($db(), $key, $me->id, "POST /orders/{$name}", static function (Db $trx) use ($id, $me, $body, $work, $name) {
                $o = self::load($trx, $id, true);
                if ($o['version'] !== $body['version']) throw AppError::conflict(self::presentOrder($trx, $o, $me));
                $work($trx, $o, $me, $body);
                $after = self::load($trx, $id);
                Audit::log($trx, [
                    'userId' => $me->id, 'entity' => 'orders', 'entityId' => $id, 'action' => $name,
                    'before' => ['status_sales' => $o['status_sales'], 'archived' => $o['archived']], 'after' => ['status_sales' => $after['status_sales'], 'archived' => $after['archived']],
                    'reason' => isset($body['reason']) ? (string) $body['reason'] : null,
                ]);
                return ['status' => 200, 'body' => self::presentOrder($trx, $after, $me)];
            });
            return $res['body'];
        };

        $r->post('/orders/:id/approve', static fn (Request $req) => $action($req, 'approve', 'sales.approve', static function (Db $trx, array $o, AuthUser $me) {
            if ($o['status_sales'] === 'cancelled') throw new AppError('validation', 'سفارش لغوشده تأیید نمی‌شود');
            $lines = S::loadLines($trx, $o['id']);
            foreach ($lines as $l) {
                if ($l['unit_price'] === null) throw new AppError('validation', 'همه ردیف‌ها باید قیمت داشته باشند تا قیمت قفل شود', ['lines' => 'قیمت ناقص']);
            }
            $trx->update('orders', ['status_sales' => 'approved', 'approved_by' => $me->id, 'approved_at' => Db::now()] + Db::bump(), 'id = ?', [$o['id']]);
        }));

        $r->post('/orders/:id/request-approval', static fn (Request $req) => $action($req, 'request_approval', null, static function (Db $trx, array $o, AuthUser $me) {
            Notify::managers($trx, ['kind' => 'approval_requested', 'title' => "درخواست تأیید سفارش {$o['number']} از {$me->name}", 'entity' => 'orders', 'entityId' => $o['id'], 'groupKey' => "approval:{$o['id']}"]);
        }));

        $r->post('/orders/:id/cancel', static fn (Request $req) => $action($req, 'cancel', 'sales.approve', static function (Db $trx, array $o, AuthUser $me, array $body) {
            if (!self::truthy($body['reason'] ?? null)) throw new AppError('validation', 'دلیل لغو لازم است', ['reason' => 'لازم است']);
            $ids = array_map(static fn ($l) => $l['id'], S::loadLines($trx, $o['id']));
            if ($ids) {
                // Bundles return to free stock; fees and ingot consumption stay (T52).
                $in = Db::placeholders($ids);
                $trx->update('reservations', ['status' => 'released'] + Db::bump(), "order_line_id IN ({$in}) AND status = 'active'", $ids);
                $trx->update('bundles', ['reserved_order_line_id' => null] + Db::bump(), "reserved_order_line_id IN ({$in})", $ids);
            }
            $trx->update('orders', ['status_sales' => 'cancelled', 'cancel_reason' => (string) $body['reason']] + Db::bump(), 'id = ?', [$o['id']]);
        }));

        $r->post('/orders/:id/archive', static fn (Request $req) => $action($req, 'archive', null, static function (Db $trx, array $o) {
            $trx->update('orders', ['archived' => !$o['archived']] + Db::bump(), 'id = ?', [$o['id']]);
        }));

        // Reservation (R17, R18): per-line kg against bundles, row-locked.
        $r->post('/orders/:id/reserve', static function (Request $req) use ($db) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $key = Idempotency::requireKey($req);
            $body = V::object(['items' => V::array(V::object(['order_line_id' => V::uuid(), 'bundle_id' => V::uuid(), 'kg' => V::decimalString()->optional()]))->min(1)->max(200)])->parse($req->body());
            $res = Idempotency::run($db(), $key, $me->id, 'POST /orders/reserve', static function (Db $trx) use ($id, $body, $me) {
                $o = self::load($trx, $id, true);
                if ($o['status_sales'] !== 'approved') throw new AppError('validation', 'رزرو فقط برای سفارش تأییدشده');
                $lines = S::loadLines($trx, $o['id']);
                foreach ($body['items'] as $it) {
                    $line = null;
                    foreach ($lines as $l) if ($l['id'] === $it['order_line_id']) { $line = $l; break; }
                    if (!$line) throw new AppError('not_found', 'ردیف سفارش پیدا نشد');
                    $b = $trx->find('bundles', $it['bundle_id'], true);
                    if (!$b) throw new AppError('not_found', 'بندیل پیدا نشد');
                    if ($b['status'] !== 'ok' || $b['draft']) throw new AppError('validation', "بندیل {$b['code']} با وضعیت غیر از سالم قابل رزرو نیست");
                    $bl = $trx->all('SELECT * FROM bundle_lines WHERE bundle_id = ?', [$b['id']]);
                    $compatible = false;
                    foreach ($bl as $x) {
                        if ($x['product_id'] === $line['product_id']
                            && ($line['filler_mm'] === null || $x['filler_mm'] === null || (string) $x['filler_mm'] === (string) $line['filler_mm'])
                            && ($line['min_length_m'] === null || $x['length_m'] === null || Decimal::of($x['length_m'])->gte($line['min_length_m']))) {
                            $compatible = true;
                            break;
                        }
                    }
                    if (!$compatible) throw new AppError('validation', "بندیل {$b['code']} با ردیف سفارش سازگار نیست (محصول، فیلر یا حداقل طول)");
                    if (self::truthy($line['color']) && $b['form'] !== 'raw' && self::truthy($b['color']) && $b['color'] !== $line['color']) {
                        throw new AppError('validation', "رنگ بندیل {$b['code']} با سفارش فرق دارد");
                    }
                    $reserved = $trx->value("SELECT COALESCE(SUM(kg),0) AS kg FROM reservations WHERE bundle_id = ? AND status = 'active'", [$b['id']]);
                    $free = Decimal::of((string) $b['weight_kg'])->sub((string) $reserved);
                    $kg = Decimal::of($it['kg'] ?? $free->toFixed());
                    if ($kg->lte(0) || $kg->gt($free)) throw new AppError('insufficient_stock', "مقدار آزاد بندیل {$b['code']} فقط " . Num::round($free, 'weight') . ' کیلوگرم است');
                    $trx->insertNoReturn('reservations', ['order_line_id' => $line['id'], 'bundle_id' => $b['id'], 'kg' => $kg->toFixed(3), 'created_by' => $me->id]);
                    if ($kg->eq((string) $b['weight_kg'])) $trx->update('bundles', ['reserved_order_line_id' => $line['id']] + Db::bump(), 'id = ?', [$b['id']]);
                }
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'orders', 'entityId' => $id, 'action' => 'reserve', 'after' => $body]);
                return ['status' => 200, 'body' => self::presentOrder($trx, $o, $me)];
            });
            return $res['body'];
        });

        // Suggest a split of a whole-order reservation across lines by remaining need (module 3 example 60/40 → 30/20).
        $r->get('/orders/:id/reserve-suggest', static function (Request $req) use ($db) {
            $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            ['kg' => $kg] = V::object(['kg' => V::decimalString()])->parse($req->query);
            $lines = array_values(array_filter(S::loadLines($db(), $id), static fn ($l) => $l['kind'] === 'profile' && self::truthy($l['qty_kg'])));
            $ids = array_map(static fn ($l) => $l['id'], $lines);
            $res = $ids ? $db()->all("SELECT order_line_id, SUM(kg) AS kg FROM reservations WHERE order_line_id IN (" . Db::placeholders($ids) . ") AND status IN ('active','consumed') GROUP BY order_line_id", $ids) : [];
            $byLine = [];
            foreach ($res as $x) $byLine[$x['order_line_id']] = (string) $x['kg'];
            $remaining = array_map(static fn ($l) => ['id' => $l['id'], 'remaining' => Decimal::of($l['qty_kg'])->sub($byLine[$l['id']] ?? 0)], $lines);
            $sum = Decimal::zero();
            foreach ($remaining as $x) $sum = $sum->add($x['remaining']->gt(0) ? $x['remaining'] : 0);
            if ($sum->isZero()) return ['items' => []];
            return ['items' => array_map(static fn ($x) => [
                'order_line_id' => $x['id'],
                'remaining_kg' => Num::round($x['remaining'], 'weight'),
                'suggested_kg' => Num::round(Decimal::of($kg)->mul($x['remaining']->gt(0) ? $x['remaining'] : 0)->div($sum), 'weight'),
            ], $remaining)];
        });

        $r->post('/orders/:id/release', static function (Request $req) use ($db) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            ['reservation_id' => $reservationId] = V::object(['reservation_id' => V::uuid()])->parse($req->body());
            return $db()->transaction(static function (Db $trx) use ($id, $reservationId, $me) {
                $r = $trx->find('reservations', $reservationId, true);
                if (!$r || $r['status'] !== 'active') throw new AppError('not_found');
                $trx->update('reservations', ['status' => 'released'] + Db::bump(), 'id = ?', [$reservationId]);
                if (self::truthy($r['bundle_id'])) {
                    $trx->update('bundles', ['reserved_order_line_id' => null] + Db::bump(), 'id = ? AND reserved_order_line_id = ?', [$r['bundle_id'], $r['order_line_id']]);
                }
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'reservations', 'entityId' => $reservationId, 'action' => 'release', 'before' => $r]);
                return self::presentOrder($trx, self::load($trx, $id), $me);
            });
        });

        $r->get('/orders/:id/reservations', static function (Request $req) use ($db) {
            $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $items = $db()->all(
                'SELECT reservations.*, bundles.code AS bundle_code, bundles.weight_kg AS bundle_kg FROM reservations
                 INNER JOIN order_lines ON order_lines.id = reservations.order_line_id
                 LEFT JOIN bundles ON bundles.id = reservations.bundle_id
                 WHERE order_lines.order_id = ? ORDER BY reservations.created_at',
                [$id],
            );
            return ['items' => $items];
        });

        // Everything linked to the order for the file tabs: runs, coating runs, transfers, documents, files, tasks, notes.
        $r->get('/orders/:id/related', static function (Request $req) use ($db) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $d = $db();
            $lineIds = array_map(static fn ($l) => $l['id'], S::loadLines($d, $id));
            $in = Db::placeholders($lineIds);
            $runs = $lineIds ? $d->all(
                "SELECT DISTINCT production_runs.id, production_runs.number, production_runs.status, production_runs.factory_party_id, production_runs.started_at, production_runs.good_kg
                 FROM production_runs INNER JOIN production_run_lines ON production_run_lines.run_id = production_runs.id
                 WHERE production_run_lines.order_line_id IN ({$in})",
                $lineIds,
            ) : [];
            $bundles = $lineIds ? $d->all(
                "SELECT id, code, weight_kg, form, status, location_id, color, reserved_order_line_id FROM bundles
                 WHERE (reserved_order_line_id IN ({$in}) OR EXISTS (SELECT 1 FROM bundle_lines bl WHERE bl.bundle_id = bundles.id AND bl.order_line_id IN ({$in}))) AND draft = 0",
                [...$lineIds, ...$lineIds],
            ) : [];
            $bundleIds = array_map(static fn ($b) => $b['id'], $bundles);
            $coating = $bundleIds ? $d->all(
                'SELECT DISTINCT coating_runs.id, coating_runs.number, coating_runs.status, coating_runs.party_id, coating_runs.service, coating_runs.sent_at
                 FROM coating_runs INNER JOIN coating_run_items ON coating_run_items.run_id = coating_runs.id
                 WHERE coating_run_items.bundle_id IN (' . Db::placeholders($bundleIds) . ')',
                $bundleIds,
            ) : [];
            $transfers = $d->all(
                'SELECT id, number, kind, status, departed_at, received_at, to_location_id, from_location_id FROM transfers WHERE order_ids LIKE ? ORDER BY created_at DESC',
                ['%"' . $id . '"%'],
            );
            $docs = $d->all('SELECT id, number, kind, status, amount, currency, `date`, party_id, description, created_by FROM documents WHERE order_id = ? ORDER BY `date` DESC', [$id]);
            if (!Auth::can($me, 'finance.view')) {
                $docs = array_values(array_filter($docs, static fn ($x) => in_array($x['kind'], ['invoice', 'receipt', 'sales_return'], true) || $x['created_by'] === $me->id));
            }
            $files = $d->all(
                "SELECT files.id, files.kind, files.caption, files.`sensitive`, files.mime, files.created_at, file_links.entity, file_links.entity_id
                 FROM file_links INNER JOIN files ON files.id = file_links.file_id WHERE file_links.entity = 'orders' AND file_links.entity_id = ?",
                [$id],
            );
            $tasks = $d->all('SELECT id, title, status, due_at, assignee_user_id FROM tasks WHERE order_id = ?', [$id]);
            $notes = $d->all('SELECT id, `text`, status, created_at, created_by FROM free_notes WHERE order_id = ? ORDER BY created_at DESC', [$id]);
            $canFinance = Auth::can($me, 'finance.view');
            return [
                'runs' => $runs, 'bundles' => $bundles, 'coating_runs' => $coating, 'transfers' => $transfers, 'documents' => $docs,
                'files' => array_values(array_filter($files, static fn ($f) => !$f['sensitive'] || $canFinance)), 'tasks' => $tasks, 'notes' => $notes,
            ];
        });
    }
}
