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
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\Schema;
use Vitral\Core\V;
use Vitral\Lib\Decimal;
use Vitral\Lib\Num;
use Vitral\Lib\Stock as Ledger;
use Vitral\Rules\Money;
use Vitral\Rules\Production;

/** Port of apps/server/src/modules/materials/routes.ts: material lots, purchases and receiving, scrap sale, smelting, consumption. */
final class Materials
{
    public const LOT_KINDS = ['ingot', 'billet', 'scrap', 'paint_powder', 'tool'];
    public const PURCHASE_KINDS = ['ingot', 'billet', 'scrap', 'paint_powder', 'tool', 'raw_profile', 'finished_profile', 'die', 'other'];

    public static function lotState(string $kind): string
    {
        return $kind === 'scrap' ? 'scrap' : ($kind === 'paint_powder' ? 'paint' : ($kind === 'tool' ? 'tool' : 'ingot'));
    }

    /**
     * The keys of $row listed in $keys, in that order; a key the row does not have is left out
     * (a JavaScript `undefined` property disappears from JSON).
     * @param array<string,string> $alias output key => source key
     */
    public static function pick(array $row, array $keys, array $alias = []): array
    {
        $out = [];
        foreach ($keys as $k) {
            $src = $alias[$k] ?? $k;
            if (array_key_exists($src, $row)) $out[$k] = $row[$src];
        }
        return $out;
    }

    /** JavaScript truthiness for values coming from validated input or a row ("0" is truthy, '' is not). */
    public static function truthy(mixed $v): bool
    {
        return !($v === null || $v === false || $v === '' || $v === 0 || $v === 0.0);
    }

    /** Instant → the UTC calendar day, for DATE columns written from a timestamp. */
    public static function day(\DateTimeInterface $at): string
    {
        return \DateTimeImmutable::createFromInterface($at)->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d');
    }

    public static function presentLot(array $l, ?AuthUser $user = null): array
    {
        $out = self::pick($l, ['id', 'kind', 'alloy', 'grade', 'batch_no', 'owner_party_id', 'owner_name', 'unit', 'kg_per_unit', 'description', 'tool_class', 'responsible_user_id', 'positions', 'total_kg', 'avg_cost', 'cost_incomplete', 'moves', 'version', 'created_at']);
        if ($user && !Auth::can($user, 'finance.view')) unset($out['avg_cost']);
        return $out;
    }

    /** Moving average (R13) replayed over the lot's receipts and issues, oldest first. */
    public static function lotAverage(Db $db, string $lotId): array
    {
        // The ledger is append-only: a purchase receipt booked before its price was known keeps unit_cost NULL, and the
        // price later completed on the purchase document values it here (the document is the valuation record).
        $moves = $db->all(
            "SELECT stock_moves.kg, COALESCE(stock_moves.unit_cost, pd.unit_price) AS unit_cost, stock_moves.to_location_id, stock_moves.from_location_id, stock_moves.ref_type, COALESCE(stock_moves.currency, pd.currency) AS currency
             FROM stock_moves LEFT JOIN documents pd ON pd.id = stock_moves.ref_id AND stock_moves.ref_type = 'purchase_receipt' AND pd.kind = 'purchase'
             WHERE stock_moves.item_type = 'material_lot' AND stock_moves.item_id = ? ORDER BY stock_moves.at, stock_moves.created_at",
            [$lotId],
        );
        $st = Money::emptyAvg();
        foreach ($moves as $m) {
            $inbound = in_array($m['ref_type'], ['purchase_receipt', 'opening', 'smelting_output', 'scrap_conversion'], true) && $m['to_location_id'] !== null && $m['from_location_id'] === null;
            $outbound = $m['to_location_id'] === null && $m['from_location_id'] !== null;
            if ($m['ref_type'] === 'count_adjustment') {
                if ($m['to_location_id'] !== null && $m['from_location_id'] === null) $st = Money::applyReceipt($st, $m['kg'], $st['avg']);
                elseif ($outbound) $st = Money::applyIssue($st, $m['kg']);
                continue;
            }
            if ($inbound) $st = Money::applyReceipt($st, $m['kg'], $m['unit_cost'], $m['currency'] ?? 'TOMAN');
            elseif ($outbound) $st = Money::applyIssue($st, $m['kg']);
        }
        return $st;
    }

    public static function loadLot(Db $db, string $id, bool $withMoves = false): ?array
    {
        $l = $db->one('SELECT material_lots.*, parties.name AS owner_name FROM material_lots LEFT JOIN parties ON parties.id = material_lots.owner_party_id WHERE material_lots.id = ?', [$id]);
        if (!$l) return null;
        $positions = Ledger::stockPositions($db, ['item_type' => 'material_lot', 'item_id' => $id]);
        $locIds = array_values(array_unique(array_map(static fn ($p) => $p['location_id'], $positions)));
        $locs = [];
        if ($locIds) {
            foreach ($db->all('SELECT id, name, kind FROM locations WHERE id IN (' . Db::placeholders($locIds) . ')', $locIds) as $r) $locs[$r['id']] = $r;
        }
        $avg = self::lotAverage($db, $id);
        $total = Decimal::zero();
        $outPositions = [];
        foreach ($positions as $p) {
            $total = $total->add($p['kg']);
            $row = $p;
            if (isset($locs[$p['location_id']])) {
                $row['location_name'] = $locs[$p['location_id']]['name'];
                $row['location_kind'] = $locs[$p['location_id']]['kind'];
            }
            $outPositions[] = $row;
        }
        $l['positions'] = $outPositions;
        $l['total_kg'] = Num::round($total, 'weight');
        $l['avg_cost'] = $avg['avg'];
        $l['cost_incomplete'] = $avg['incomplete'];
        if ($withMoves) {
            $l['moves'] = $db->all(
                "SELECT stock_moves.id, stock_moves.at, stock_moves.kg, stock_moves.state_from, stock_moves.state_to, stock_moves.ref_type, stock_moves.ref_id, stock_moves.note, f.name AS from_name, t.name AS to_name
                 FROM stock_moves LEFT JOIN locations f ON f.id = stock_moves.from_location_id LEFT JOIN locations t ON t.id = stock_moves.to_location_id
                 WHERE item_type = 'material_lot' AND item_id = ? ORDER BY at",
                [$id],
            );
        }
        return $l;
    }

    /** lotBase of the Node code; $withDefaults=false for the PATCH schema (zod `.optional()` over a default keeps undefined). */
    private static function lotBase(bool $withDefaults = true): array
    {
        $unit = V::enum(['kg', 'carton', 'piece']);
        return [
            'kind' => V::enum(self::LOT_KINDS),
            'alloy' => V::optText(40),
            'grade' => V::optText(40),
            'batch_no' => V::optText(80),
            'owner_party_id' => V::uuid()->nullable()->optional(),
            'unit' => $withDefaults ? $unit->default('kg') : $unit,
            'kg_per_unit' => V::decimalString()->nullable()->optional(),
            'description' => V::optText(500),
            'tool_class' => V::enum(['consumable', 'equipment'])->nullable()->optional(),
            'responsible_user_id' => V::uuid()->nullable()->optional(),
        ];
    }

    public static function presentPurchase(array $d, ?AuthUser $user = null): array
    {
        $out = self::pick($d, ['id', 'number', 'kind', 'party_id', 'party_name', 'date', 'amount', 'currency', 'status', 'purchase_kind', 'material_lot_id', 'lot', 'agreed_kg', 'received_kg', 'unit_price', 'unit_cost', 'description', 'note', 'due_date', 'file_ids', 'source_type', 'source_id', 'paid', 'remaining', 'transfer_id', 'version', 'created_at'], ['unit_cost' => 'unit_price']);
        if ($user && !Auth::can($user, 'finance.view')) unset($out['amount'], $out['paid'], $out['remaining']);
        return $out;
    }

    public static function loadPurchase(Db $db, string $id): ?array
    {
        $d = $db->one("SELECT documents.*, parties.name AS party_name FROM documents LEFT JOIN parties ON parties.id = documents.party_id WHERE documents.id = ? AND documents.kind = 'purchase'", [$id]);
        if (!$d) return null;
        $lot = $d['material_lot_id'] ? self::loadLot($db, $d['material_lot_id']) : null;
        $paid = (string) $db->value('SELECT COALESCE(SUM(amount),0) AS a FROM allocations WHERE to_document_id = ?', [$id]);
        $d['lot'] = $lot ? self::presentLot($lot) : null;
        $d['paid'] = Num::round($paid, $d['currency']);
        $d['remaining'] = $d['amount'] === null ? null : Num::round(Decimal::of($d['amount'])->sub($paid), $d['currency']);
        return $d;
    }

    public static function register(Router $r, App $app): void
    {
        $lotBase = self::lotBase();
        $lotPatch = ['version' => V::versionField()['version'], 'reason' => V::versionField()['reason']] + array_map(static fn (Schema $s) => $s->optional(), self::lotBase(false));

        Crud::routes($r, $app, [
            'table' => 'material_lots',
            'path' => '/material-lots',
            'createSchema' => V::object($lotBase),
            'updateSchema' => V::object($lotPatch),
            'idempotent' => true,
            'listSchema' => V::object([
                'kind' => V::enum(self::LOT_KINDS)->optional(),
                'owner_party_id' => V::uuid()->optional(),
                'location_id' => V::uuid()->optional(),
                'in_stock' => V::boolQuery()->optional(),
                'q' => V::string()->max(80)->optional(),
            ]),
            'present' => [self::class, 'presentLot'],
            'filter' => static function (Query $qb, array $q): void {
                if (self::truthy($q['kind'] ?? null)) $qb->where('material_lots.kind = ?', [(string) $q['kind']]);
                if (self::truthy($q['owner_party_id'] ?? null)) $qb->where('material_lots.owner_party_id = ?', [(string) $q['owner_party_id']]);
                if (self::truthy($q['q'] ?? null)) {
                    $like = '%' . $q['q'] . '%';
                    $qb->where('material_lots.description LIKE ? OR material_lots.batch_no LIKE ? OR material_lots.alloy LIKE ?', [$like, $like, $like]);
                }
                if (self::truthy($q['location_id'] ?? null)) {
                    $qb->where("(SELECT COALESCE(SUM(CASE WHEN to_location_id = ? THEN kg ELSE 0 END) - SUM(CASE WHEN from_location_id = ? THEN kg ELSE 0 END),0) FROM stock_moves sm WHERE sm.item_type='material_lot' AND sm.item_id = material_lots.id) > 0", [(string) $q['location_id'], (string) $q['location_id']]);
                }
                if (!empty($q['in_stock'])) {
                    $qb->where("(SELECT COALESCE(SUM(CASE WHEN to_location_id IS NOT NULL THEN kg ELSE 0 END) - SUM(CASE WHEN from_location_id IS NOT NULL THEN kg ELSE 0 END),0) FROM stock_moves sm WHERE sm.item_type='material_lot' AND sm.item_id = material_lots.id) > 0");
                }
            },
            'loadOne' => static fn (Db $trx, string $id) => self::loadLot($trx, $id, true),
            'beforeCreate' => static function (Db $trx, array $input): array {
                if ($input['unit'] !== 'kg' && !self::truthy($input['kg_per_unit'] ?? null)) throw new AppError('validation', 'برای واحد کارتن/عدد وزن هر واحد لازم است', ['kg_per_unit' => 'لازم است']);
                return $input;
            },
        ]);

        // Purchases (documents of kind purchase). Amount = agreed kg × unit price when both known; otherwise «needs_completion».
        $purchaseBase = [
            'party_id' => V::uuid(),
            'purchase_kind' => V::enum(self::PURCHASE_KINDS),
            'material_lot_id' => V::uuid()->nullable()->optional(),
            'lot' => V::object($lotBase)->partial()->optional(),
            'agreed_kg' => V::decimalString()->nullable()->optional(),
            'unit_price' => V::decimalString()->nullable()->optional(),
            'amount' => V::decimalString()->nullable()->optional(),
            'currency' => V::enum(Num::CURRENCIES)->default('TOMAN'),
            'date' => V::isoDate()->optional(),
            'due_date' => V::isoDate()->nullable()->optional(),
            'description' => V::optText(500),
            'note' => V::optText(2000),
            'file_ids' => V::array(V::uuid())->max(20)->optional(),
            'order_id' => V::uuid()->nullable()->optional(),
        ];

        $r->get('/purchases', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $q = V::object([
                'limit' => V::coerceNumber()->int()->min(1)->max(100)->default(50),
                'status' => V::enum(['draft', 'reported', 'posted', 'void', 'needs_completion'])->optional(),
                'party_id' => V::uuid()->optional(),
                'purchase_kind' => V::enum(self::PURCHASE_KINDS)->optional(),
                'unreceived' => V::boolQuery()->optional(),
            ])->parse($req->query);
            $qb = Query::from('documents')->select('documents.*, parties.name AS party_name')->join('LEFT JOIN parties ON parties.id = documents.party_id')
                ->where("documents.kind = 'purchase'")->orderBy('documents.date', 'desc')->limit($q['limit']);
            if (self::truthy($q['status'] ?? null)) $qb->where('documents.status = ?', [$q['status']]);
            if (self::truthy($q['party_id'] ?? null)) $qb->where('documents.party_id = ?', [$q['party_id']]);
            if (self::truthy($q['purchase_kind'] ?? null)) $qb->where('documents.purchase_kind = ?', [$q['purchase_kind']]);
            if (!empty($q['unreceived'])) $qb->where('documents.agreed_kg IS NOT NULL AND documents.received_kg < documents.agreed_kg');
            return ['items' => array_map(static fn ($d) => self::presentPurchase($d, $me), $qb->all($app->db()))];
        });

        $r->get('/purchases/:id', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $d = self::loadPurchase($app->db(), $id);
            if (!$d) throw new AppError('not_found');
            return self::presentPurchase($d, $me);
        });

        $r->post('/purchases', static function (Request $req) use ($app, $purchaseBase) {
            $me = $req->requireUser();
            $key = Idempotency::requireKey($req);
            $body = V::object($purchaseBase)->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /purchases', static function (Db $trx) use ($body, $me) {
                $lotId = $body['material_lot_id'] ?? null;
                $material = in_array($body['purchase_kind'], self::LOT_KINDS, true);
                if ($material && !self::truthy($lotId)) {
                    $lotIn = $body['lot'] ?? [];
                    $lot = $trx->insertNoReturn('material_lots', array_merge($lotIn, [
                        'kind' => $body['purchase_kind'],
                        'unit' => $lotIn['unit'] ?? 'kg',
                        'owner_party_id' => null,
                        'description' => $lotIn['description'] ?? $body['description'] ?? null,
                        'created_by' => $me->id,
                    ]));
                    $lotId = $lot;
                }
                $cur = $body['currency'];
                $amount = $body['amount'] ?? null;
                if ($amount === null) $amount = self::truthy($body['agreed_kg'] ?? null) && self::truthy($body['unit_price'] ?? null) ? Num::round(Decimal::of($body['agreed_kg'])->mul($body['unit_price']), $cur) : null;
                $unitPrice = $body['unit_price'] ?? null;
                if ($unitPrice === null) {
                    $unitPrice = self::truthy($body['amount'] ?? null) && self::truthy($body['agreed_kg'] ?? null) && !Decimal::of($body['agreed_kg'])->isZero()
                        ? Num::round(Decimal::of($body['amount'])->div($body['agreed_kg']), $cur) : null;
                }
                $at = isset($body['date']) ? new \DateTimeImmutable($body['date']) : new \DateTimeImmutable('now');
                $d = $trx->insert('documents', [
                    'number' => Numbering::next($trx, 'purchase', $at),
                    'kind' => 'purchase',
                    'party_id' => $body['party_id'],
                    'amount' => $amount,
                    'currency' => $cur,
                    'status' => $amount === null ? 'needs_completion' : 'draft',
                    'purchase_kind' => $body['purchase_kind'],
                    'material_lot_id' => $lotId,
                    'agreed_kg' => $body['agreed_kg'] ?? null,
                    'unit_price' => $unitPrice,
                    'date' => self::day($at),
                    'due_date' => self::truthy($body['due_date'] ?? null) ? self::day(new \DateTimeImmutable($body['due_date'])) : null,
                    'description' => $body['description'] ?? null,
                    'note' => $body['note'] ?? null,
                    'file_ids' => $body['file_ids'] ?? [],
                    'order_id' => $body['order_id'] ?? null,
                    'created_by' => $me->id,
                ]);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'documents', 'entityId' => $d['id'], 'action' => 'create', 'after' => $d]);
                return ['status' => 201, 'body' => self::presentPurchase(self::loadPurchase($trx, $d['id']), $me)];
            });
            return Response::json($res['body'], $res['status']);
        });

        // Complete/edit a purchase before it is posted.
        $r->patch('/purchases/:id', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $body = V::object(V::versionField() + [
                'agreed_kg' => V::decimalString()->nullable()->optional(),
                'unit_price' => V::decimalString()->nullable()->optional(),
                'amount' => V::decimalString()->nullable()->optional(),
                'description' => V::optText(500),
                'note' => V::optText(2000),
                'due_date' => V::isoDate()->nullable()->optional(),
                'file_ids' => V::array(V::uuid())->max(20)->optional(),
                'party_id' => V::uuid()->optional(),
            ])->parse($req->body());
            return $app->db()->transaction(static function (Db $trx) use ($id, $body, $me) {
                $d = $trx->one("SELECT * FROM documents WHERE id = ? AND kind = 'purchase' FOR UPDATE", [$id]);
                if (!$d) throw new AppError('not_found');
                if ($d['version'] !== $body['version']) throw AppError::conflict(self::presentPurchase(self::loadPurchase($trx, $id), $me));
                if ($d['status'] === 'posted' || $d['status'] === 'void') throw new AppError('validation', 'سند قطعی/باطل تغییر نمی‌کند؛ سند اصلاحی بزنید');
                $cur = $d['currency'];
                $agreed = array_key_exists('agreed_kg', $body) ? $body['agreed_kg'] : $d['agreed_kg'];
                $unit = array_key_exists('unit_price', $body) ? $body['unit_price'] : $d['unit_price'];
                $amount = array_key_exists('amount', $body) ? $body['amount'] : $d['amount'];
                if (array_key_exists('unit_price', $body) && !array_key_exists('amount', $body) && self::truthy($agreed) && self::truthy($unit)) $amount = Num::round(Decimal::of($agreed)->mul($unit), $cur);
                if (array_key_exists('amount', $body) && !array_key_exists('unit_price', $body) && self::truthy($agreed) && self::truthy($amount) && !Decimal::of($agreed)->isZero()) $unit = Num::round(Decimal::of($amount)->div($agreed), $cur);
                $rest = $body;
                unset($rest['version'], $rest['reason'], $rest['due_date']);
                $set = array_merge($rest, [
                    'agreed_kg' => $agreed,
                    'unit_price' => $unit,
                    'amount' => $amount,
                    'status' => $amount === null ? 'needs_completion' : ($d['status'] === 'needs_completion' ? 'draft' : $d['status']),
                ]);
                if (array_key_exists('due_date', $body)) $set['due_date'] = self::truthy($body['due_date']) ? self::day(new \DateTimeImmutable($body['due_date'])) : null;
                $after = $trx->updateById('documents', $id, $set + Db::bump());
                // Receipts already booked at an unknown price are not rewritten (stock_moves is append-only, principle 8):
                // lotAverage values them with the price now on this purchase document.
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'documents', 'entityId' => $id, 'action' => 'update', 'before' => $d, 'after' => $after, 'reason' => $body['reason'] ?? null]);
                return self::presentPurchase(self::loadPurchase($trx, $id), $me);
            });
        });

        // Receive purchased goods into a location (T41). Materials go to the lot; profiles become bundles with source «purchase».
        $r->post('/purchases/:id/receive', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $key = Idempotency::requireKey($req);
            $body = V::object([
                'version' => V::int(),
                'kg' => V::decimalString()->optional(),
                'to_location_id' => V::uuid()->optional(),
                'at' => V::isoDate()->optional(),
                'note' => V::optText(500),
                'bundles' => V::array(V::object([
                    'code' => V::string()->trim()->min(1)->max(60)->optional(),
                    'weight_kg' => V::decimalString(),
                    'form' => V::enum(['raw', 'painted', 'anodized'])->default('raw'),
                    'color' => V::optText(60),
                    'lines' => V::array(V::object([
                        'product_id' => V::uuid(),
                        'filler_mm' => V::decimalString()->nullable()->optional(),
                        'length_m' => V::decimalString()->nullable()->optional(),
                        'bars' => V::int()->min(0)->nullable()->optional(),
                        'weight_kg' => V::decimalString()->nullable()->optional(),
                        'order_line_id' => V::uuid()->nullable()->optional(),
                    ]))->min(1),
                ]))->optional(),
            ])->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /purchases/receive', static function (Db $trx) use ($id, $body, $me) {
                $d = $trx->one("SELECT * FROM documents WHERE id = ? AND kind = 'purchase' FOR UPDATE", [$id]);
                if (!$d) throw new AppError('not_found');
                if ($d['version'] !== $body['version']) throw AppError::conflict(self::presentPurchase(self::loadPurchase($trx, $id), $me));
                if ($d['status'] === 'void') throw new AppError('validation', 'سند باطل است');
                $to = $body['to_location_id'] ?? Ledger::OWN_WAREHOUSE($trx);
                $at = isset($body['at']) ? new \DateTimeImmutable($body['at']) : new \DateTimeImmutable('now');
                $received = Decimal::zero();
                if ($d['material_lot_id']) {
                    if (!self::truthy($body['kg'] ?? null)) throw new AppError('validation', 'وزن دریافتی لازم است', ['kg' => 'لازم است']);
                    $lot = $trx->find('material_lots', $d['material_lot_id']);
                    if (!$lot) throw new \RuntimeException('no result');
                    Ledger::move($trx, ['at' => $at, 'item_type' => 'material_lot', 'item_id' => $lot['id'], 'from_location_id' => null, 'to_location_id' => $to, 'kg' => $body['kg'], 'state_to' => self::lotState($lot['kind']), 'ref_type' => 'purchase_receipt', 'ref_id' => $id, 'unit_cost' => $d['unit_price'], 'currency' => $d['currency'], 'note' => $body['note'] ?? null, 'userId' => $me->id]);
                    $received = Decimal::of($body['kg']);
                } elseif ($d['purchase_kind'] === 'raw_profile' || $d['purchase_kind'] === 'finished_profile') {
                    if (empty($body['bundles'])) throw new AppError('validation', 'بندیل‌های دریافتی لازم است', ['bundles' => 'لازم است']);
                    foreach ($body['bundles'] as $bd) {
                        $code = $bd['code'] ?? ('PUR-' . $d['number'] . '-' . $received->toFixed(0));
                        $bid = $trx->insertNoReturn('bundles', [
                            'code' => $code,
                            'code_is_temp' => !self::truthy($bd['code'] ?? null),
                            'location_id' => $to,
                            'factory_party_id' => $d['party_id'],
                            'weight_kg' => $bd['weight_kg'],
                            'form' => $bd['form'],
                            'color' => $bd['color'] ?? null,
                            'source' => 'purchase',
                            'warnings' => '[]',
                            'created_by' => $me->id,
                        ]);
                        $sort = 0;
                        foreach ($bd['lines'] as $l) $trx->insertNoReturn('bundle_lines', array_merge($l, ['bundle_id' => $bid, 'sort' => $sort++, 'created_by' => $me->id]));
                        Ledger::move($trx, ['at' => $at, 'item_type' => 'bundle', 'item_id' => $bid, 'from_location_id' => null, 'to_location_id' => $to, 'kg' => $bd['weight_kg'], 'state_to' => $bd['form'] === 'raw' ? 'raw' : 'coated', 'ref_type' => 'purchase_receipt', 'ref_id' => $id, 'unit_cost' => $d['unit_price'], 'currency' => $d['currency'], 'userId' => $me->id]);
                        $received = $received->add($bd['weight_kg']);
                    }
                } else {
                    throw new AppError('validation', 'این نوع خرید دریافت وزنی ندارد');
                }
                $after = $trx->updateById('documents', $id, ['received_kg' => Db::raw('received_kg + ?', [$received->toFixed(3)])] + Db::bump());
                if (self::truthy($d['agreed_kg']) && Decimal::of($after['received_kg'])->gt(Decimal::of($d['agreed_kg'])->mul('1.02'))) {
                    Notify::managers($trx, ['kind' => 'purchase_over_receipt', 'title' => "دریافت خرید {$d['number']} ({$after['received_kg']}) از توافق ({$d['agreed_kg']}) بیشتر است", 'entity' => 'documents', 'entityId' => $id, 'groupKey' => "over:{$id}"]);
                }
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'documents', 'entityId' => $id, 'action' => 'receive', 'before' => ['received_kg' => $d['received_kg']], 'after' => ['received_kg' => $after['received_kg'], 'location_id' => $to]]);
                return ['status' => 200, 'body' => self::presentPurchase(self::loadPurchase($trx, $id), $me)];
            });
            return $res['body'];
        });

        // Scrap sale: a draft invoice to a scrap trader plus the weight leaving stock as «sold» (posting is in money).
        $r->post('/scrap/sale', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $key = Idempotency::requireKey($req);
            $body = V::object([
                'lot_id' => V::uuid(),
                'party_id' => V::uuid(),
                'from_location_id' => V::uuid(),
                'kg' => V::decimalString(),
                'unit_price' => V::decimalString()->nullable()->optional(),
                'currency' => V::enum(Num::CURRENCIES)->default('TOMAN'),
                'note' => V::optText(500),
            ])->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /scrap/sale', static function (Db $trx) use ($body, $me) {
                $lot = $trx->find('material_lots', $body['lot_id']);
                if (!$lot || $lot['kind'] !== 'scrap') throw new AppError('validation', 'پارت ضایعات یافت نشد', ['lot_id' => 'نامعتبر']);
                $amount = self::truthy($body['unit_price'] ?? null) ? Num::round(Decimal::of($body['kg'])->mul($body['unit_price']), $body['currency']) : null;
                $d = $trx->insert('documents', [
                    'number' => Numbering::next($trx, 'invoice'),
                    'kind' => 'invoice',
                    'party_id' => $body['party_id'],
                    'amount' => $amount,
                    'currency' => $body['currency'],
                    'status' => $amount === null ? 'needs_completion' : 'draft',
                    'material_lot_id' => $lot['id'],
                    'agreed_kg' => $body['kg'],
                    'unit_price' => $body['unit_price'] ?? null,
                    'description' => "فروش ضایعات {$body['kg']} کیلوگرم",
                    'note' => $body['note'] ?? null,
                    'created_by' => $me->id,
                ]);
                $trx->insertNoReturn('document_lines', [
                    'document_id' => $d['id'],
                    'description' => 'ضایعات آلومینیوم' . (self::truthy($lot['alloy']) ? ' ' . $lot['alloy'] : ''),
                    'qty' => $body['kg'],
                    'unit' => 'kg',
                    'unit_price' => $body['unit_price'] ?? null,
                    'amount' => $amount ?? '0',
                    'created_by' => $me->id,
                ]);
                Ledger::move($trx, ['item_type' => 'material_lot', 'item_id' => $lot['id'], 'from_location_id' => $body['from_location_id'], 'to_location_id' => null, 'kg' => $body['kg'], 'state_from' => 'scrap', 'state_to' => 'sold', 'ref_type' => 'sale_dispatch', 'ref_id' => $d['id'], 'userId' => $me->id]);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'documents', 'entityId' => $d['id'], 'action' => 'create', 'after' => $d]);
                return ['status' => 201, 'body' => ['id' => $d['id'], 'number' => $d['number'], 'amount' => $amount, 'status' => $d['status']]];
            });
            return Response::json($res['body'], $res['status']);
        });

        // Smelting: scrap lots consumed, one ingot lot produced at the smelter, fee from the smelting contract.
        // Recorded as a closed production run with service «smelting» so the balance (R08) and fee (R07) rules apply unchanged.
        $r->post('/smelting', static function (Request $req) use ($app) {
            $me = $req->requirePermission('technical.approve');
            $key = Idempotency::requireKey($req);
            $body = V::object([
                'smelter_party_id' => V::uuid(),
                'inputs' => V::array(V::object(['lot_id' => V::uuid(), 'from_location_id' => V::uuid(), 'kg' => V::decimalString()]))->min(1),
                'output_kg' => V::decimalString(),
                'alloy' => V::optText(40),
                'to_location_id' => V::uuid()->optional(),
                'at' => V::isoDate()->optional(),
                'note' => V::optText(1000),
            ])->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /smelting', static function (Db $trx) use ($body, $me) {
                $loc = $trx->one("SELECT id FROM locations WHERE party_id = ? AND kind = 'factory' LIMIT 1", [$body['smelter_party_id']]);
                if (!$loc) throw new AppError('validation', 'این طرف نقش ریخته‌گر ندارد', ['smelter_party_id' => 'ریخته‌گر نیست']);
                $at = isset($body['at']) ? new \DateTimeImmutable($body['at']) : new \DateTimeImmutable('now');
                $c = Contracts::activeContract($trx, $body['smelter_party_id'], 'smelting', $at);
                $inputKg = Decimal::zero();
                foreach ($body['inputs'] as $i) $inputKg = $inputKg->add($i['kg']);
                $runNumber = Numbering::next($trx, 'production_run', $at);
                $runId = $trx->insertNoReturn('production_runs', [
                    'number' => $runNumber,
                    'factory_party_id' => $body['smelter_party_id'],
                    'location_id' => $loc['id'],
                    'service' => 'smelting',
                    'contract_id' => $c['id'] ?? null,
                    'rate_per_kg' => $c['rate_per_kg'] ?? null,
                    'rate_currency' => $c['currency'] ?? 'TOMAN',
                    'weight_basis' => $c['weight_basis'] ?? null,
                    'fixed_fee' => $c['fixed_fee'] ?? null,
                    'started_at' => $at,
                    'note' => $body['note'] ?? null,
                    'created_by' => $me->id,
                ]);
                $costValue = Decimal::zero();
                $incomplete = false;
                foreach ($body['inputs'] as $i) {
                    $avg = self::lotAverage($trx, $i['lot_id']);
                    if ($avg['avg'] === null) $incomplete = true;
                    else $costValue = $costValue->add(Decimal::of($avg['avg'])->mul($i['kg']));
                    Ledger::move($trx, ['at' => $at, 'item_type' => 'material_lot', 'item_id' => $i['lot_id'], 'from_location_id' => $i['from_location_id'], 'to_location_id' => null, 'kg' => $i['kg'], 'state_from' => 'scrap', 'state_to' => 'consumed', 'ref_type' => 'production_consume', 'ref_id' => $runId, 'unit_cost' => $avg['avg'], 'userId' => $me->id]);
                }
                $wb = $c['weight_basis'] ?? null;
                $basis = $wb === 'good_output' ? $body['output_kg'] : ($wb === 'input' ? $inputKg->toFixed(3) : null);
                $fee = Production::productionFee($c['rate_per_kg'] ?? null, $basis, $c['fixed_fee'] ?? null);
                $feeDocId = $trx->insertNoReturn('documents', [
                    'number' => Numbering::next($trx, 'toll_fee', $at),
                    'kind' => 'toll_fee',
                    'party_id' => $body['smelter_party_id'],
                    'amount' => $fee,
                    'currency' => $c['currency'] ?? 'TOMAN',
                    'status' => $fee === null ? 'needs_completion' : 'posted',
                    'posted_by' => $fee === null ? null : $me->id,
                    'posted_at' => $fee === null ? null : $at,
                    'source_type' => 'production_run',
                    'source_id' => $runId,
                    'settlement_basis_kg' => $basis,
                    'unit_price' => $c['rate_per_kg'] ?? null,
                    'description' => "اجرت ذوب {$runNumber}",
                    'created_by' => $me->id,
                ]);
                if ($fee === null) $incomplete = true;
                else $costValue = $costValue->add($fee);
                $unitCost = $incomplete || Decimal::of($body['output_kg'])->isZero() ? null : Num::round($costValue->div($body['output_kg']), 'TOMAN');
                $outId = $trx->insertNoReturn('material_lots', ['kind' => 'ingot', 'alloy' => $body['alloy'] ?? null, 'owner_party_id' => null, 'description' => "شمش ذوب {$runNumber}", 'created_by' => $me->id]);
                Ledger::move($trx, ['at' => $at, 'item_type' => 'material_lot', 'item_id' => $outId, 'from_location_id' => null, 'to_location_id' => $body['to_location_id'] ?? $loc['id'], 'kg' => $body['output_kg'], 'state_to' => 'ingot', 'ref_type' => 'smelting_output', 'ref_id' => $runId, 'unit_cost' => $unitCost, 'currency' => 'TOMAN', 'userId' => $me->id]);
                $loss = $inputKg->sub($body['output_kg']);
                $trx->update('production_runs', [
                    'status' => 'closed',
                    'ingot_consumed_kg' => $inputKg->toFixed(3),
                    'good_kg' => $body['output_kg'],
                    'unexplained_kg' => $loss->toFixed(3),
                    'closed_at' => $at,
                    'closed_by' => $me->id,
                    'fee_document_id' => $feeDocId,
                    'close_reason' => 'افت ذوب',
                ] + Db::bump(), 'id = ?', [$runId]);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'production_runs', 'entityId' => $runId, 'action' => 'smelt', 'after' => ['input_kg' => $inputKg->toFixed(3), 'output_kg' => $body['output_kg'], 'loss_kg' => $loss->toFixed(3), 'output_lot_id' => $outId]]);
                return ['status' => 201, 'body' => [
                    'run_id' => $runId,
                    'number' => $runNumber,
                    'output_lot_id' => $outId,
                    'input_kg' => $inputKg->toFixed(3),
                    'output_kg' => $body['output_kg'],
                    'loss_kg' => Num::round($loss, 'weight'),
                    'loss_percent' => $inputKg->isZero() ? null : Num::round($loss->div($inputKg)->mul(100), 'percent'),
                    'fee_incomplete' => $fee === null,
                ]];
            });
            return Response::json($res['body'], $res['status']);
        });

        // Consume paint powder / consumable tools at a location (by units or kg).
        $r->post('/materials/consume', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $key = Idempotency::requireKey($req);
            $body = V::object([
                'lot_id' => V::uuid(),
                'location_id' => V::uuid(),
                'units' => V::decimalString()->optional(),
                'kg' => V::decimalString()->optional(),
                'ref_type' => V::enum(['coating_run', 'general'])->default('general'),
                'ref_id' => V::uuid()->optional(),
                'note' => V::optText(500),
            ])->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /materials/consume', static function (Db $trx) use ($body, $me) {
                $lot = $trx->find('material_lots', $body['lot_id']);
                if (!$lot) throw new AppError('not_found');
                if ($lot['kind'] === 'tool' && $lot['tool_class'] === 'equipment') throw new AppError('validation', 'تجهیزات مصرف نمی‌شوند؛ فقط جابه‌جا می‌شوند');
                $kg = self::truthy($body['kg'] ?? null) ? Decimal::of($body['kg'])
                    : (self::truthy($body['units'] ?? null) ? Decimal::of($body['units'])->mul($lot['kg_per_unit'] ?? 0) : null);
                if (!$kg || $kg->lte(0)) throw new AppError('validation', 'مقدار مصرف لازم است', ['kg' => 'لازم است']);
                $avg = self::lotAverage($trx, $lot['id']);
                Ledger::move($trx, ['item_type' => 'material_lot', 'item_id' => $lot['id'], 'from_location_id' => $body['location_id'], 'to_location_id' => null, 'kg' => $kg->toFixed(3), 'state_from' => self::lotState($lot['kind']), 'state_to' => 'consumed', 'ref_type' => 'material_consume', 'ref_id' => $body['ref_id'] ?? $lot['id'], 'unit_cost' => $avg['avg'], 'note' => $body['note'] ?? null, 'userId' => $me->id]);
                return ['status' => 200, 'body' => self::presentLot(self::loadLot($trx, $lot['id']), $me)];
            });
            return $res['body'];
        });
    }
}
