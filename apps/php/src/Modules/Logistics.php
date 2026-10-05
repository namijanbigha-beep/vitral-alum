<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\Auth;
use Vitral\Core\AuthUser;
use Vitral\Core\Crud;
use Vitral\Core\Db;
use Vitral\Core\Idempotency;
use Vitral\Core\Notify;
use Vitral\Core\Numbering;
use Vitral\Core\Query;
use Vitral\Core\Request;
use Vitral\Core\Router;
use Vitral\Core\Schema;
use Vitral\Core\Settings;
use Vitral\Core\Undef;
use Vitral\Core\V;
use Vitral\Lib\Decimal;
use Vitral\Lib\Num;
use Vitral\Lib\Stock as Ledger;
use Vitral\Rules\Money;
use Vitral\Rules\Production;

/**
 * Port of apps/server/src/modules/logistics/routes.ts: transfers (dispatch → in transit → border → receive, the two-point
 * move of T38), packing lists (R04), scale tickets (R09) and the transfer document policy («documents_missing»).
 */
final class Logistics
{
    public const KINDS = ['ingot_in', 'to_production', 'raw_delivery', 'to_coating', 'from_coating', 'between_locations', 'to_customer', 'customer_return', 'scrap_out', 'scrap_in', 'die_move', 'general'];
    public const STATUSES = ['draft', 'dispatched', 'in_transit', 'at_border', 'partially_received', 'received', 'delivered'];

    /** File kind on the transfer that satisfies each photo/paper requirement of the document policy. */
    private const DOC_FILE_KIND = ['load_photo' => 'load', 'vehicle_photo' => 'vehicle', 'waybill' => 'waybill', 'delivery_receipt' => 'delivery_receipt'];

    private const TRANSFER_KEYS = [
        'id', 'number', 'kind', 'status', 'from_location_id', 'from_name', 'to_location_id', 'to_name', 'order_ids', 'order_numbers',
        'production_run_id', 'coating_run_id', 'purchase_document_id', 'returns_transfer_id', 'transport_mode', 'vehicle_type', 'plate',
        'driver_name', 'driver_phone', 'carrier_party_id', 'waybill_no', 'departed_at', 'eta', 'received_at', 'receiver_name', 'border',
        'is_export', 'consignee', 'destination_country', 'destination_city', 'destination_address', 'bill_to_party_id', 'delivery_term',
        'freight_cost', 'freight_currency', 'freight_payer', 'freight_document_id', 'print_count', 'note', 'dispatched_by',
        'lines', 'packing', 'scale_tickets', 'totals', 'documents_policy', 'documents_missing', 'version', 'created_at', 'updated_at',
    ];

    public static function presentTransfer(array $t, ?AuthUser $user = null): array
    {
        $out = Materials::pick($t, self::TRANSFER_KEYS);
        if ($user && !Auth::can($user, 'finance.view')) unset($out['freight_document_id']);
        return $out;
    }

    public static function loadTransfer(Db $db, string $id): ?array
    {
        $t = $db->one('SELECT transfers.*, f.name AS from_name, t.name AS to_name FROM transfers LEFT JOIN locations f ON f.id = transfers.from_location_id LEFT JOIN locations t ON t.id = transfers.to_location_id WHERE transfers.id = ?', [$id]);
        if (!$t) return null;
        $lines = $db->all(
            'SELECT transfer_lines.*, bundles.code AS bundle_code, bundles.form AS bundle_form, bundles.color AS bundle_color, material_lots.kind AS lot_kind, material_lots.description AS lot_description, dies.code AS die_code
             FROM transfer_lines
             LEFT JOIN bundles ON bundles.id = transfer_lines.bundle_id
             LEFT JOIN material_lots ON material_lots.id = transfer_lines.material_lot_id
             LEFT JOIN dies ON dies.id = transfer_lines.die_id
             WHERE transfer_id = ? ORDER BY transfer_lines.created_at',
            [$id],
        );
        $packing = $db->all(
            'SELECT packing_lines.*, products.code AS product_code, products.name_fa AS product_name, products.name_ar AS product_name_ar, products.name_en AS product_name_en
             FROM packing_lines LEFT JOIN products ON products.id = packing_lines.product_id WHERE transfer_id = ? ORDER BY sort',
            [$id],
        );
        $tickets = $db->all('SELECT * FROM scale_tickets WHERE transfer_id = ? ORDER BY created_at', [$id]);
        $orderIds = is_array($t['order_ids']) ? array_values($t['order_ids']) : [];
        $orders = $orderIds ? $db->all('SELECT id, number FROM orders WHERE id IN (' . Db::placeholders($orderIds) . ')', $orderIds) : [];
        $kg = Decimal::zero();
        $received = Decimal::zero();
        foreach ($lines as $l) {
            if (Materials::truthy($l['kg'])) $kg = $kg->add($l['kg']);
            if (Materials::truthy($l['received_kg'])) $received = $received->add($l['received_kg']);
        }
        $packages = 0;
        $bars = 0;
        foreach ($packing as $p) {
            $packages += $p['packages'];
            $bars += $p['bars'] ?? 0;
        }
        $docs = self::transferDocuments($db, $t['id'], $t['kind']);
        $t['lines'] = $lines;
        $t['packing'] = $packing;
        $t['scale_tickets'] = array_map([self::class, 'presentTicket'], $tickets);
        $t['order_numbers'] = array_map(static fn ($o) => $o['number'], $orders);
        $t['totals'] = ['kg' => Num::round($kg, 'weight'), 'received_kg' => Num::round($received, 'weight'), 'line_count' => count($lines), 'packages' => $packages, 'bars' => $bars];
        $t['documents_policy'] = $docs['required'];
        $t['documents_missing'] = $docs['missing'];
        return $t;
    }

    /**
     * Module 6 «سیاست مدارک»: the documents the setting `transfer_document_policy` requires for this kind, and which are still missing.
     * A file counts when it is owned by or linked to the transfer; a scale ticket when one is recorded on it (or a scale-ticket photo is attached).
     * @return array{required:list<string>,missing:list<string>}
     */
    public static function transferDocuments(Db $db, string $transferId, string $kind): array
    {
        $policy = Settings::get($db, 'transfer_document_policy');
        $required = is_array($policy) && isset($policy[$kind]) && is_array($policy[$kind]) ? array_values($policy[$kind]) : [];
        if (!$required) return ['required' => $required, 'missing' => []];
        $fileKinds = array_flip(array_map('strval', $db->column(
            "SELECT kind FROM files WHERE (owner_entity = 'transfers' AND owner_id = ?) OR id IN (SELECT file_id FROM file_links WHERE entity = 'transfers' AND entity_id = ?)",
            [$transferId, $transferId],
        )));
        $ticket = $db->value('SELECT id FROM scale_tickets WHERE transfer_id = ? LIMIT 1', [$transferId]);
        $packing = $db->value('SELECT id FROM packing_lines WHERE transfer_id = ? LIMIT 1', [$transferId]);
        $has = static function (string $d) use ($fileKinds, $ticket, $packing): bool {
            if ($d === 'scale_ticket') return $ticket !== null || isset($fileKinds['scale_ticket']);
            if ($d === 'packing_list') return $packing !== null;
            return isset(self::DOC_FILE_KIND[$d]) && isset($fileKinds[self::DOC_FILE_KIND[$d]]);
        };
        return ['required' => $required, 'missing' => array_values(array_filter($required, static fn ($d) => !$has((string) $d)))];
    }

    public static function presentTicket(array $t): array
    {
        $net = ($t['net_direct_kg'] ?? null) !== null ? ['kg' => $t['net_direct_kg'], 'gross_only' => false] : Production::scaleNet($t['gross_kg'] ?? null, $t['tare_kg'] ?? null, $t['packaging_kg'] ?? null);
        return [
            'id' => $t['id'], 'transfer_id' => $t['transfer_id'], 'production_run_id' => $t['production_run_id'], 'coating_run_id' => $t['coating_run_id'],
            'stage' => $t['stage'], 'site' => $t['site'], 'ticket_no' => $t['ticket_no'], 'at' => $t['at'], 'gross_kg' => $t['gross_kg'], 'tare_kg' => $t['tare_kg'],
            'packaging_kg' => $t['packaging_kg'], 'net_direct_kg' => $t['net_direct_kg'], 'net' => $net,
            'net_kg' => $net && !$net['gross_only'] ? $net['kg'] : null, 'gross_only' => $net ? $net['gross_only'] : true,
            'status' => $t['status'], 'approved_for' => $t['approved_for'], 'approved_by' => $t['approved_by'], 'approved_at' => $t['approved_at'],
            'file_id' => $t['file_id'], 'note' => $t['note'], 'version' => $t['version'], 'created_at' => $t['created_at'],
        ];
    }

    /** Customer location (one per customer party), created on first delivery. */
    public static function customerLocation(Db $trx, string $partyId, string $userId): string
    {
        $id = $trx->value("SELECT id FROM locations WHERE party_id = ? AND kind = 'customer' LIMIT 1", [$partyId]);
        if ($id !== null) return (string) $id;
        $p = $trx->one('SELECT name FROM parties WHERE id = ?', [$partyId]);
        if (!$p) throw new \RuntimeException('no result');
        return $trx->insertNoReturn('locations', ['name' => "مشتری: {$p['name']}", 'kind' => 'customer', 'party_id' => $partyId, 'created_by' => $userId]);
    }

    private static function lineWithItem(Db $trx, array $l): array
    {
        $out = $l;
        if (Materials::truthy($l['bundle_id'] ?? null)) {
            $b = $trx->one('SELECT weight_kg, draft, status FROM bundles WHERE id = ?', [$l['bundle_id']]);
            if (!$b) throw new AppError('validation', 'بندیل یافت نشد', ['bundle_id' => 'نامعتبر']);
            if ($b['draft']) throw new AppError('validation', 'بندیل پیش‌نویس ارسال نمی‌شود');
            $out['kg'] = $l['kg'] ?? $b['weight_kg'];
        } elseif (Materials::truthy($l['die_id'] ?? null)) {
            $out['kg'] = $l['kg'] ?? '0';
        } elseif (!Materials::truthy($l['kg'] ?? null)) {
            throw new AppError('validation', 'وزن پارت مواد لازم است', ['kg' => 'لازم است']);
        }
        return $out;
    }

    private static function insertLines(Db $trx, string $transferId, array $lines, string $userId): void
    {
        // Lines are listed ORDER BY created_at. PostgreSQL gives every line of the transaction the same now() and
        // returns them in insertion order; DATETIME(3) ties in MySQL come back in index order, so each line gets
        // its own millisecond here to keep the request's order.
        $base = new \DateTimeImmutable('now');
        foreach (array_values($lines) as $i => $l) {
            $trx->insertNoReturn('transfer_lines', array_merge(self::lineWithItem($trx, $l), ['transfer_id' => $transferId, 'created_by' => $userId, 'created_at' => $base->modify('+' . $i . ' milliseconds')]));
        }
    }

    private static function lineSchema(): Schema
    {
        return V::object([
            'bundle_id' => V::uuid()->nullable()->optional(),
            'material_lot_id' => V::uuid()->nullable()->optional(),
            'die_id' => V::uuid()->nullable()->optional(),
            'kg' => V::decimalString()->nullable()->optional(),
            'bars' => V::int()->min(0)->nullable()->optional(),
            'packages' => V::int()->min(0)->nullable()->optional(),
            'bars_per_package' => V::int()->min(0)->nullable()->optional(),
            'length_m' => V::decimalString()->nullable()->optional(),
            'order_id' => V::uuid()->nullable()->optional(),
            'order_line_id' => V::uuid()->nullable()->optional(),
        ])->refine(static fn ($l) => count(array_filter([$l['bundle_id'] ?? null, $l['material_lot_id'] ?? null, $l['die_id'] ?? null], [Materials::class, 'truthy'])) === 1, 'هر ردیف دقیقاً یک بندیل، یک پارت مواد یا یک قالب دارد');
    }

    /** @return array<string,Schema> */
    private static function transportFields(): array
    {
        return [
            'transport_mode' => V::optText(40),
            'vehicle_type' => V::optText(80),
            'plate' => V::optText(40),
            'driver_name' => V::optText(120),
            'driver_phone' => V::optText(40),
            'carrier_party_id' => V::uuid()->nullable()->optional(),
            'waybill_no' => V::optText(80),
            'eta' => V::isoDate()->nullable()->optional(),
            'border' => V::optText(80),
            'is_export' => V::boolean()->optional(),
            'consignee' => V::optText(300),
            'destination_country' => V::optText(80),
            'destination_city' => V::optText(80),
            'destination_address' => V::optText(500),
            'bill_to_party_id' => V::uuid()->nullable()->optional(),
            'delivery_term' => V::optText(40),
            'freight_cost' => V::decimalString()->nullable()->optional(),
            'freight_currency' => V::enum(Num::CURRENCIES)->optional(),
            'freight_payer' => V::enum(['vitral', 'customer', 'party'])->nullable()->optional(),
            'note' => V::optText(2000),
        ];
    }

    private static function lotStateOf(string $kind): string
    {
        return $kind === 'scrap' ? 'scrap' : ($kind === 'paint_powder' ? 'paint' : ($kind === 'tool' ? 'tool' : 'ingot'));
    }

    public static function register(Router $r, App $app): void
    {
        $line = self::lineSchema();
        $createSchema = V::object([
            'kind' => V::enum(self::KINDS),
            'from_location_id' => V::uuid()->nullable()->optional(),
            'to_location_id' => V::uuid()->nullable()->optional(),
            'order_ids' => V::array(V::uuid())->max(50)->optional(),
            'production_run_id' => V::uuid()->nullable()->optional(),
            'coating_run_id' => V::uuid()->nullable()->optional(),
            'purchase_document_id' => V::uuid()->nullable()->optional(),
            'returns_transfer_id' => V::uuid()->nullable()->optional(),
            'lines' => V::array($line)->max(500)->default([]),
        ] + self::transportFields());
        $updateSchema = V::object(V::versionField() + [
            'from_location_id' => V::uuid()->nullable()->optional(),
            'to_location_id' => V::uuid()->nullable()->optional(),
            'order_ids' => V::array(V::uuid())->max(50)->optional(),
            'lines' => V::array($line)->max(500)->optional(),
        ] + self::transportFields());

        Crud::routes($r, $app, [
            'table' => 'transfers',
            'path' => '/transfers',
            'createSchema' => $createSchema,
            'updateSchema' => $updateSchema,
            'idempotent' => true,
            'orderBy' => 'created_at',
            'listSchema' => V::object([
                'kind' => V::enum(self::KINDS)->optional(),
                'status' => V::enum(self::STATUSES)->optional(),
                'order_id' => V::uuid()->optional(),
                'location_id' => V::uuid()->optional(),
                'open' => V::boolQuery()->optional(),
                'q' => V::string()->max(60)->optional(),
            ]),
            'present' => [self::class, 'presentTransfer'],
            'filter' => static function (Query $qb, array $q): void {
                if (Materials::truthy($q['kind'] ?? null)) $qb->where('transfers.kind = ?', [(string) $q['kind']]);
                if (Materials::truthy($q['status'] ?? null)) $qb->where('transfers.status = ?', [(string) $q['status']]);
                if (!empty($q['open'])) $qb->where("transfers.status NOT IN ('received', 'delivered')");
                if (Materials::truthy($q['order_id'] ?? null)) $qb->where('transfers.order_ids LIKE ?', [Db::like('"' . strtolower((string) $q['order_id']) . '"')]);
                if (Materials::truthy($q['location_id'] ?? null)) $qb->where('transfers.from_location_id = ? OR transfers.to_location_id = ?', [(string) $q['location_id'], (string) $q['location_id']]);
                if (Materials::truthy($q['q'] ?? null)) {
                    $like = '%' . $q['q'] . '%';
                    $qb->where('transfers.number LIKE ? OR transfers.plate LIKE ? OR transfers.driver_name LIKE ?', [$like, $like, $like]);
                }
            },
            'loadOne' => static fn (Db $trx, string $id) => self::loadTransfer($trx, $id),
            'beforeCreate' => static function (Db $trx, array $input): array {
                $rest = $input;
                $eta = $rest['eta'] ?? null;
                unset($rest['lines'], $rest['eta']);
                if ($rest['kind'] === 'to_customer' && empty($rest['order_ids'])) throw new AppError('validation', 'ارسال به مشتری باید به سفارش وصل باشد', ['order_ids' => 'لازم است']);
                if ($rest['kind'] !== 'die_move' && !Materials::truthy($rest['from_location_id'] ?? null)) throw new AppError('validation', 'محل مبدأ لازم است', ['from_location_id' => 'لازم است']);
                return array_merge($rest, [
                    'number' => Numbering::next($trx, 'transfer'),
                    'eta' => Materials::truthy($eta) ? new \DateTimeImmutable($eta) : null,
                    'order_ids' => $rest['order_ids'] ?? [],
                ]);
            },
            'afterCreate' => static function (Db $trx, array $row, array $input, AuthUser $user): void {
                self::insertLines($trx, $row['id'], $input['lines'] ?? [], $user->id);
            },
            'beforeUpdate' => static function (Db $trx, array $before, array $patch, AuthUser $user): array {
                $lines = $patch['lines'] ?? null;
                $rest = $patch;
                unset($rest['lines'], $rest['eta']);
                if ($before['status'] !== 'draft') {
                    foreach (['from_location_id', 'lines'] as $k) {
                        if (array_key_exists($k, $patch)) throw new AppError('validation', 'پس از ارسال فقط مشخصات حمل و مقصد تغییر می‌کند');
                    }
                    if ($before['status'] === 'received' || $before['status'] === 'delivered') {
                        foreach (['to_location_id', 'order_ids'] as $k) {
                            if (array_key_exists($k, $patch)) throw new AppError('validation', 'حواله دریافت‌شده تغییر نمی‌کند');
                        }
                    }
                }
                if ($lines !== null) {
                    $trx->exec('DELETE FROM transfer_lines WHERE transfer_id = ?', [$before['id']]);
                    self::insertLines($trx, $before['id'], $lines, $user->id);
                }
                if (array_key_exists('eta', $patch)) $rest['eta'] = Materials::truthy($patch['eta']) ? new \DateTimeImmutable($patch['eta']) : null;
                return $rest;
            },
        ]);

        /**
         * One transfer action: version check under a row lock, the work, an audit row and the fresh transfer —
         * the `act` helper of the Node module (body = {version} ∧ schema; no body counts as {}).
         */
        $act = static function (Request $req, string $name, array $shape, callable $work) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $key = Idempotency::requireKey($req);
            $raw = $req->body();
            $body = V::object(['version' => V::int()] + $shape)->parse($raw instanceof Undef || $raw === null ? new \stdClass() : $raw);
            $res = Idempotency::run($app->db(), $key, $me->id, "POST /transfers/{$name}", static function (Db $trx) use ($id, $body, $me, $name, $work) {
                $t = $trx->find('transfers', $id, true);
                if (!$t) throw new AppError('not_found');
                if ($t['version'] !== $body['version']) throw AppError::conflict(self::presentTransfer(self::loadTransfer($trx, $id), $me));
                $work($trx, $t, $me, $body);
                $after = $trx->find('transfers', $id);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'transfers', 'entityId' => $id, 'action' => $name, 'before' => ['status' => $t['status']], 'after' => ['status' => $after['status']], 'reason' => $body['reason'] ?? null]);
                return ['status' => 200, 'body' => self::presentTransfer(self::loadTransfer($trx, $id), $me)];
            });
            return $res['body'];
        };

        // Dispatch: every line leaves the origin for «در مسیر» (first point of the two-point move, T38). Die moves update the die location directly.
        $r->post('/transfers/:id/dispatch', static fn (Request $req) => $act($req, 'dispatch', ['departed_at' => V::isoDate()->optional()], static function (Db $trx, array $t, AuthUser $me, array $body): void {
            if ($t['status'] !== 'draft') throw new AppError('validation', 'این حواله قبلاً ارسال شده است');
            $lines = $trx->all('SELECT * FROM transfer_lines WHERE transfer_id = ? ORDER BY created_at', [$t['id']]);
            if (!$lines) throw new AppError('validation', 'حواله بدون ردیف ارسال نمی‌شود');
            $at = isset($body['departed_at']) ? new \DateTimeImmutable($body['departed_at']) : new \DateTimeImmutable('now');
            $transit = Ledger::IN_TRANSIT($trx);
            // A missing document never blocks the physical move (principle 14); a load leaving without its photo is flagged at once.
            if (in_array('load_photo', self::transferDocuments($trx, $t['id'], $t['kind'])['missing'], true)) {
                Notify::managers($trx, ['kind' => 'missing_document', 'title' => "حواله {$t['number']} بدون عکس بار ارسال شد", 'entity' => 'transfers', 'entityId' => $t['id'], 'groupKey' => "load_photo:{$t['id']}"]);
            }
            foreach ($lines as $l) {
                if (Materials::truthy($l['die_id'])) {
                    $trx->update('dies', ['location_id' => $t['to_location_id'], 'status' => 'in_transit'] + Db::bump(), 'id = ?', [$l['die_id']]);
                    $trx->insertNoReturn('die_events', ['die_id' => $l['die_id'], 'kind' => 'moved', 'detail' => "حواله {$t['number']}", 'created_by' => $me->id]);
                    continue;
                }
                if (!Materials::truthy($t['from_location_id'])) throw new AppError('validation', 'محل مبدأ لازم است');
                $itemType = Materials::truthy($l['bundle_id']) ? 'bundle' : 'material_lot';
                $itemId = $l['bundle_id'] ?? $l['material_lot_id'];
                $unitCost = null;
                if (Materials::truthy($l['bundle_id'])) {
                    $b = $trx->find('bundles', $l['bundle_id'], true);
                    if (!$b) throw new \RuntimeException('no result');
                    if ($b['status'] !== 'ok' && $t['kind'] !== 'scrap_out') throw new AppError('validation', "بندیل {$b['code']} در قرنطینه است و ارسال نمی‌شود");
                    if (Materials::truthy($b['reserved_order_line_id']) && $t['kind'] === 'to_customer' && Materials::truthy($l['order_line_id']) && $b['reserved_order_line_id'] !== $l['order_line_id']) throw new AppError('validation', "بندیل {$b['code']} برای سفارش دیگری رزرو شده است");
                    if ($t['kind'] === 'to_customer' && !Materials::truthy($l['order_id'])) throw new AppError('validation', "ردیف بندیل {$b['code']} به سفارش وصل نیست", ['order_id' => 'لازم است']);
                    $state = Bundles::formState($b['form']);
                    $trx->update('bundles', ['location_id' => $transit] + Db::bump(), 'id = ?', [$b['id']]);
                } else {
                    $lot = $trx->one('SELECT kind FROM material_lots WHERE id = ?', [$itemId]);
                    if (!$lot) throw new \RuntimeException('no result');
                    $state = self::lotStateOf($lot['kind']);
                    // The lot keeps its book value (R13 moving average) while it travels, so the cost is known at the destination.
                    $unitCost = Materials::lotAverage($trx, $itemId)['avg'];
                }
                Ledger::move($trx, ['at' => $at, 'item_type' => $itemType, 'item_id' => $itemId, 'from_location_id' => $t['from_location_id'], 'to_location_id' => $transit, 'kg' => $l['kg'] ?? '0', 'state_from' => $state, 'state_to' => $state, 'ref_type' => 'transfer_dispatch', 'ref_id' => $t['id'], 'unit_cost' => $unitCost, 'currency' => Materials::truthy($unitCost) ? 'TOMAN' : null, 'userId' => $me->id]);
            }
            $set = ['status' => $t['kind'] === 'die_move' ? 'received' : 'in_transit', 'departed_at' => $at, 'dispatched_by' => $me->id];
            if ($t['kind'] === 'die_move') $set['received_at'] = $at;
            $trx->update('transfers', $set + Db::bump(), 'id = ?', [$t['id']]);
            if ($t['kind'] === 'die_move') {
                foreach ($lines as $l) {
                    if (Materials::truthy($l['die_id'])) $trx->update('dies', ['status' => 'ready'] + Db::bump(), "id = ? AND status = 'in_transit'", [$l['die_id']]);
                }
            }
            self::freightExpense($trx, $t, $me->id);
        }));

        $r->post('/transfers/:id/border', static fn (Request $req) => $act($req, 'border', ['border' => V::optText(80)], static function (Db $trx, array $t, AuthUser $me, array $body): void {
            if ($t['status'] !== 'in_transit' && $t['status'] !== 'dispatched') throw new AppError('validation', 'حواله در مسیر نیست');
            $trx->update('transfers', ['status' => 'at_border', 'border' => $body['border'] ?? $t['border']] + Db::bump(), 'id = ?', [$t['id']]);
        }));

        // Receive: second point of the move, «در مسیر» → destination with the received kg. A shortfall needs a reason and is
        // written off from transit with that note, so the ledger never shows weight in two places. To-customer lines become «sold».
        $receiveShape = [
            'received_at' => V::isoDate()->optional(),
            'receiver_name' => V::optText(120),
            'to_location_id' => V::uuid()->optional(),
            'lines' => V::array(V::object([
                'line_id' => V::uuid(),
                'received_kg' => V::decimalString()->optional(),
                'diff_reason' => V::enum(['scale_difference', 'packaging', 'shortage', 'partial_unload', 'other'])->nullable()->optional(),
                'diff_note' => V::optText(500),
            ]))->optional(),
        ];
        $r->post('/transfers/:id/receive', static fn (Request $req) => $act($req, 'receive', $receiveShape, static function (Db $trx, array $t, AuthUser $me, array $body): void {
            if ($t['status'] === 'draft') throw new AppError('validation', 'حواله هنوز ارسال نشده است');
            if ($t['status'] === 'received' || $t['status'] === 'delivered') throw new AppError('validation', 'حواله قبلاً دریافت شده است');
            $at = isset($body['received_at']) ? new \DateTimeImmutable($body['received_at']) : new \DateTimeImmutable('now');
            $transit = Ledger::IN_TRANSIT($trx);
            $dest = $body['to_location_id'] ?? $t['to_location_id'];
            if ($t['kind'] === 'to_customer' && !Materials::truthy($dest)) {
                $o = $trx->one('SELECT party_id FROM orders WHERE id = ?', [$t['order_ids'][0] ?? null]);
                if (!$o) throw new \RuntimeException('no result');
                $dest = self::customerLocation($trx, $o['party_id'], $me->id);
            }
            if (!Materials::truthy($dest)) throw new AppError('validation', 'محل مقصد لازم است', ['to_location_id' => 'لازم است']);
            $lines = $trx->all('SELECT * FROM transfer_lines WHERE transfer_id = ? AND received_at IS NULL ORDER BY created_at FOR UPDATE', [$t['id']]);
            $given = [];
            foreach ($body['lines'] ?? [] as $g) $given[$g['line_id']] = $g;
            $toReceive = $given ? array_values(array_filter($lines, static fn ($l) => isset($given[$l['id']]))) : $lines;
            if (!$toReceive) throw new AppError('validation', 'ردیفی برای دریافت نیست');
            foreach ($toReceive as $l) {
                if (Materials::truthy($l['die_id'])) {
                    $trx->update('transfer_lines', ['received_at' => $at, 'received_kg' => $l['kg']] + Db::bump(), 'id = ?', [$l['id']]);
                    continue;
                }
                $g = $given[$l['id']] ?? null;
                $sent = Decimal::of($l['kg'] ?? '0');
                $recv = Decimal::of($g['received_kg'] ?? $l['kg'] ?? '0');
                if ($recv->gt($sent)) throw new AppError('validation', "وزن دریافتی ({$recv}) از ارسالی ({$sent}) بیشتر است؛ اضافه را جداگانه ثبت کنید", ['received_kg' => 'بیش از ارسالی']);
                $diff = $sent->sub($recv);
                if ($diff->gt(0) && !Materials::truthy($g['diff_reason'] ?? null)) throw new AppError('validation', 'اختلاف ' . $diff->toFixed(3) . ' کیلوگرم در ردیف دلیل لازم دارد', ['diff_reason' => 'لازم است']);
                $itemType = Materials::truthy($l['bundle_id']) ? 'bundle' : 'material_lot';
                $itemId = $l['bundle_id'] ?? $l['material_lot_id'];
                $inTransit = Decimal::of(Ledger::itemBalance($trx, $itemType, $itemId, $transit));
                if ($inTransit->lt($sent)) throw new AppError('insufficient_stock', "در مسیر فقط {$inTransit} کیلوگرم از این قلم هست");
                $unitCost = null;
                if (Materials::truthy($l['bundle_id'])) {
                    $b = $trx->find('bundles', $l['bundle_id'], true);
                    if (!$b) throw new \RuntimeException('no result');
                    $stateFrom = Bundles::formState($b['form']);
                    $stateTo = $t['kind'] === 'to_customer' ? 'sold' : $stateFrom;
                    $set = ['location_id' => $dest, 'weight_kg' => $recv->toFixed(3)];
                    if ($t['kind'] === 'to_customer') $set += ['status' => 'consumed', 'reserved_order_line_id' => null];
                    $trx->update('bundles', $set + Db::bump(), 'id = ?', [$b['id']]);
                    if ($t['kind'] === 'to_customer') $trx->update('reservations', ['status' => 'consumed'] + Db::bump(), "bundle_id = ? AND status = 'active'", [$b['id']]);
                } else {
                    $lot = $trx->one('SELECT kind FROM material_lots WHERE id = ?', [$itemId]);
                    if (!$lot) throw new \RuntimeException('no result');
                    $stateFrom = self::lotStateOf($lot['kind']);
                    $stateTo = $t['kind'] === 'to_customer' || $t['kind'] === 'scrap_out' ? 'sold' : $stateFrom;
                    $unitCost = Materials::lotAverage($trx, $itemId)['avg'];
                }
                $currency = Materials::truthy($unitCost) ? 'TOMAN' : null;
                if ($recv->gt(0)) Ledger::move($trx, ['at' => $at, 'item_type' => $itemType, 'item_id' => $itemId, 'from_location_id' => $transit, 'to_location_id' => $dest, 'kg' => $recv->toFixed(3), 'state_from' => $stateFrom, 'state_to' => $stateTo, 'ref_type' => 'transfer_receive', 'ref_id' => $t['id'], 'unit_cost' => $unitCost, 'currency' => $currency, 'userId' => $me->id]);
                if ($diff->gt(0)) {
                    $note = 'اختلاف دریافت: ' . ($g['diff_reason'] ?? 'undefined') . (Materials::truthy($g['diff_note'] ?? null) ? ' — ' . $g['diff_note'] : '');
                    Ledger::move($trx, ['at' => $at, 'item_type' => $itemType, 'item_id' => $itemId, 'from_location_id' => $transit, 'to_location_id' => null, 'kg' => $diff->toFixed(3), 'state_from' => $stateFrom, 'state_to' => 'consumed', 'ref_type' => 'transfer_receive', 'ref_id' => $t['id'], 'unit_cost' => $unitCost, 'currency' => $currency, 'note' => $note, 'userId' => $me->id]);
                }
                $trx->update('transfer_lines', ['received_at' => $at, 'received_kg' => $recv->toFixed(3), 'diff_reason' => $g['diff_reason'] ?? null, 'diff_note' => $g['diff_note'] ?? null] + Db::bump(), 'id = ?', [$l['id']]);
            }
            $pending = $trx->value('SELECT id FROM transfer_lines WHERE transfer_id = ? AND received_at IS NULL LIMIT 1', [$t['id']]);
            $status = $pending !== null ? 'partially_received' : ($t['kind'] === 'to_customer' ? 'delivered' : 'received');
            $trx->update('transfers', ['status' => $status, 'to_location_id' => $dest, 'received_at' => $pending !== null ? null : $at, 'receiver_name' => $body['receiver_name'] ?? $t['receiver_name']] + Db::bump(), 'id = ?', [$t['id']]);
            if ($pending === null && $t['kind'] === 'to_customer') {
                $diffs = array_filter($toReceive, static fn ($l) => Materials::truthy($given[$l['id']]['diff_reason'] ?? null));
                if ($diffs) Notify::managers($trx, ['kind' => 'delivery_difference', 'title' => "تحویل {$t['number']} با اختلاف وزن در " . count($diffs) . ' ردیف ثبت شد', 'entity' => 'transfers', 'entityId' => $t['id'], 'groupKey' => "diff:{$t['id']}"]);
            }
        }));

        // Packing list lines (R04: bars = packages × bars per package; weight per group or per package).
        $r->get('/transfers/:id/packing', static function (Request $req) use ($app) {
            $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $t = self::loadTransfer($app->db(), $id);
            if (!$t) throw new AppError('not_found');
            return ['items' => $t['packing'], 'totals' => $t['totals']];
        });

        $packingLine = V::object([
            'product_id' => V::uuid()->nullable()->optional(),
            'description' => V::optText(300),
            'order_id' => V::uuid()->nullable()->optional(),
            'order_line_id' => V::uuid()->nullable()->optional(),
            'color' => V::optText(60),
            'filler_mm' => V::decimalString()->nullable()->optional(),
            'length_m' => V::decimalString()->nullable()->optional(),
            'packages' => V::int()->min(0)->default(0),
            'bars_per_package' => V::int()->min(0)->nullable()->optional(),
            'bars' => V::int()->min(0)->nullable()->optional(),
            'weight_kg' => V::decimalString()->nullable()->optional(),
            'weight_mode' => V::enum(['group_total', 'per_package'])->default('group_total'),
            'is_partial' => V::boolean()->default(false),
            'gross_kg' => V::decimalString()->nullable()->optional(),
        ]);
        $r->put('/transfers/:id/packing', static function (Request $req) use ($app, $packingLine) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $body = V::object(['version' => V::int(), 'lines' => V::array($packingLine)->max(300)])->parse($req->body());
            return $app->db()->transaction(static function (Db $trx) use ($id, $body, $me) {
                $t = $trx->find('transfers', $id, true);
                if (!$t) throw new AppError('not_found');
                if ($t['version'] !== $body['version']) throw AppError::conflict(self::presentTransfer(self::loadTransfer($trx, $id), $me));
                if ($t['status'] === 'received' || $t['status'] === 'delivered') throw new AppError('validation', 'لیست بسته‌بندی حواله دریافت‌شده تغییر نمی‌کند');
                $trx->exec('DELETE FROM packing_lines WHERE transfer_id = ?', [$id]);
                $sort = 0;
                foreach ($body['lines'] as $l) {
                    if (!Materials::truthy($l['product_id'] ?? null) && !Materials::truthy($l['description'] ?? null)) throw new AppError('validation', 'هر ردیف محصول یا شرح دارد', ['description' => 'لازم است']);
                    $bpp = $l['bars_per_package'] ?? null;
                    $bars = $l['bars'] ?? ($bpp !== null ? Production::barsFromPackages($l['packages'], $bpp) : null);
                    if ($l['is_partial'] && ($l['bars'] ?? null) !== null && Materials::truthy($bpp) && $l['bars'] > $l['packages'] * $bpp) throw new AppError('validation', 'تعداد شاخه از ظرفیت بسته‌ها بیشتر است', ['bars' => 'زیاد']);
                    $w = $l['weight_kg'] ?? null;
                    $weight = $w === null ? null : ($l['weight_mode'] === 'per_package' ? Num::round(Decimal::of($w)->mul($l['packages']), 'weight') : $w);
                    $trx->insertNoReturn('packing_lines', array_merge($l, ['bars' => $bars, 'weight_kg' => $weight, 'transfer_id' => $id, 'sort' => $sort++, 'created_by' => $me->id]));
                }
                $trx->update('transfers', Db::bump(), 'id = ?', [$id]);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'transfers', 'entityId' => $id, 'action' => 'packing', 'after' => ['lines' => count($body['lines'])]]);
                return self::presentTransfer(self::loadTransfer($trx, $id), $me);
            });
        });

        // ---- scale tickets (R09) ----
        $ticketBase = [
            'transfer_id' => V::uuid()->nullable()->optional(),
            'production_run_id' => V::uuid()->nullable()->optional(),
            'coating_run_id' => V::uuid()->nullable()->optional(),
            'stage' => V::enum(['origin', 'destination', 'factory_in', 'factory_out', 'painter_in', 'painter_out', 'border']),
            'site' => V::optText(120),
            'ticket_no' => V::optText(80),
            'at' => V::isoDate()->nullable()->optional(),
            'gross_kg' => V::decimalString()->nullable()->optional(),
            'tare_kg' => V::decimalString()->nullable()->optional(),
            'packaging_kg' => V::decimalString()->nullable()->optional(),
            'net_direct_kg' => V::decimalString()->nullable()->optional(),
            'file_id' => V::uuid()->nullable()->optional(),
            'note' => V::optText(1000),
        ];
        $ticketStatus = static fn (array $t): string => Materials::truthy($t['net_direct_kg'] ?? null) || (Materials::truthy($t['gross_kg'] ?? null) && Materials::truthy($t['tare_kg'] ?? null)) ? 'recorded' : 'needs_completion';
        Crud::routes($r, $app, [
            'table' => 'scale_tickets',
            'path' => '/scale-tickets',
            'createSchema' => V::object($ticketBase),
            'updateSchema' => V::object(V::versionField() + array_map(static fn (Schema $s) => $s->optional(), $ticketBase)),
            'idempotent' => true,
            'listSchema' => V::object([
                'transfer_id' => V::uuid()->optional(),
                'production_run_id' => V::uuid()->optional(),
                'coating_run_id' => V::uuid()->optional(),
                'status' => V::enum(['needs_completion', 'recorded', 'approved'])->optional(),
            ]),
            'present' => static fn (array $row) => self::presentTicket($row),
            'filter' => static function (Query $qb, array $q): void {
                foreach (['transfer_id', 'production_run_id', 'coating_run_id', 'status'] as $k) {
                    if (Materials::truthy($q[$k] ?? null)) $qb->where("scale_tickets.{$k} = ?", [(string) $q[$k]]);
                }
            },
            'beforeCreate' => static function (Db $trx, array $input) use ($ticketStatus): array {
                if (!Materials::truthy($input['transfer_id'] ?? null) && !Materials::truthy($input['production_run_id'] ?? null) && !Materials::truthy($input['coating_run_id'] ?? null)) {
                    throw new AppError('validation', 'قبض باسکول باید به حواله، نوبت تولید یا نوبت رنگ وصل باشد');
                }
                return array_merge($input, ['at' => Materials::truthy($input['at'] ?? null) ? new \DateTimeImmutable($input['at']) : new \DateTimeImmutable('now'), 'status' => $ticketStatus($input)]);
            },
            'beforeUpdate' => static function (Db $trx, array $before, array $patch) use ($ticketStatus): array {
                if ($before['status'] === 'approved') throw new AppError('validation', 'قبض تأییدشده تغییر نمی‌کند');
                $merged = array_merge($before, $patch);
                $out = $patch;
                if (Materials::truthy($patch['at'] ?? null)) $out['at'] = new \DateTimeImmutable($patch['at']);
                $out['status'] = $ticketStatus($merged);
                return $out;
            },
        ]);

        // Approve a ticket for a purpose (technical.approve). A gross-only figure cannot be approved for settlement.
        $r->post('/scale-tickets/:id/approve', static function (Request $req) use ($app) {
            $me = $req->requirePermission('technical.approve');
            ['id' => $id] = V::idParam()->parse($req->params);
            $key = Idempotency::requireKey($req);
            $body = V::object(['version' => V::int(), 'approved_for' => V::array(V::enum(['receipt', 'toll_fee', 'sale']))->min(1)])->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /scale-tickets/approve', static function (Db $trx) use ($id, $body, $me) {
                $t = $trx->find('scale_tickets', $id, true);
                if (!$t) throw new AppError('not_found');
                if ($t['version'] !== $body['version']) throw AppError::conflict(self::presentTicket($t));
                $net = $t['net_direct_kg'] !== null ? ['kg' => $t['net_direct_kg'], 'gross_only' => false] : Production::scaleNet($t['gross_kg'], $t['tare_kg'], $t['packaging_kg']);
                if (!$net) throw new AppError('validation', 'قبض ناقص است؛ وزن خالص محاسبه نمی‌شود');
                $for = $body['approved_for'];
                if ($net['gross_only'] && (in_array('toll_fee', $for, true) || in_array('sale', $for, true))) throw new AppError('validation', 'وزن بدون کسر بسته‌بندی «ناخالص» است و برای تسویه قابل تأیید نیست', ['packaging_kg' => 'لازم است']);
                $after = $trx->updateById('scale_tickets', $id, ['status' => 'approved', 'approved_for' => $for, 'approved_by' => $me->id, 'approved_at' => new \DateTimeImmutable('now')] + Db::bump());
                if (Materials::truthy($t['coating_run_id']) && in_array('toll_fee', $for, true)) {
                    $trx->update('coating_runs', ['input_basis' => 'scale_ticket', 'input_basis_kg' => $net['kg']] + Db::bump(), "id = ? AND status <> 'closed'", [$t['coating_run_id']]);
                }
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'scale_tickets', 'entityId' => $id, 'action' => 'approve', 'before' => $t, 'after' => $after]);
                return ['status' => 200, 'body' => self::presentTicket($after)];
            });
            return $res['body'];
        });

        // Weight comparison for a transfer: declared vs origin/destination tickets vs received.
        $r->get('/transfers/:id/weights', static function (Request $req) use ($app) {
            $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $t = self::loadTransfer($app->db(), $id);
            if (!$t) throw new AppError('not_found');
            $byStage = [];
            foreach ($t['scale_tickets'] as $s) $byStage[(string) $s['stage']] = $s['net'];
            return ['declared_kg' => $t['totals']['kg'], 'received_kg' => $t['totals']['received_kg'], 'tickets' => $byStage ?: new \stdClass()];
        });
    }

    /** Freight paid by Vitral becomes an expense document, split across the transfer's orders by weight (R16). */
    private static function freightExpense(Db $trx, array $t, string $userId): void
    {
        if (!Materials::truthy($t['freight_cost']) || $t['freight_payer'] !== 'vitral' || Materials::truthy($t['freight_document_id'])) return;
        $orderIds = is_array($t['order_ids']) ? array_values($t['order_ids']) : [];
        $expenseType = count($orderIds) === 1 ? 'order' : (count($orderIds) > 1 ? 'shared' : 'general');
        $docId = $trx->insertNoReturn('documents', [
            'number' => Numbering::next($trx, 'expense'),
            'kind' => 'expense',
            'party_id' => $t['carrier_party_id'],
            'amount' => $t['freight_cost'],
            'currency' => $t['freight_currency'],
            'status' => 'posted',
            'posted_by' => $userId,
            'posted_at' => new \DateTimeImmutable('now'),
            'expense_type' => $expenseType,
            'expense_category' => 'freight',
            'order_id' => $expenseType === 'order' ? $orderIds[0] : null,
            'transfer_id' => $t['id'],
            'source_type' => 'transfer',
            'source_id' => $t['id'],
            'description' => "کرایه حمل حواله {$t['number']}",
            'created_by' => $userId,
        ]);
        if ($expenseType === 'shared') {
            $weights = $trx->all('SELECT order_id, COALESCE(SUM(kg),0) AS kg FROM transfer_lines WHERE transfer_id = ? AND order_id IS NOT NULL GROUP BY order_id', [$t['id']]);
            $shares = Money::splitByWeight($t['freight_cost'], array_map(static fn ($w) => (string) $w['kg'], $weights), $t['freight_currency']);
            foreach ($weights as $i => $w) {
                $trx->insertNoReturn('expense_shares', ['document_id' => $docId, 'order_id' => $w['order_id'], 'amount' => $shares[$i], 'currency' => $t['freight_currency'], 'weight_kg' => (string) $w['kg'], 'created_by' => $userId]);
            }
        }
        $trx->update('transfers', ['freight_document_id' => $docId] + Db::bump(), 'id = ?', [$t['id']]);
    }
}
