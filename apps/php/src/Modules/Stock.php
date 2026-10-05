<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\Auth;
use Vitral\Core\Db;
use Vitral\Core\Idempotency;
use Vitral\Core\Pagination;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\V;
use Vitral\Lib\Decimal;
use Vitral\Lib\Num;
use Vitral\Lib\Stock as Ledger;

/** Port of apps/server/src/modules/stock/routes.ts: positions, summary, availability, ledger, opening balances, count adjustment. */
final class Stock
{
    /**
     * «Where is the weight»: every item at every location with its current state, from the ledger only (principle 8).
     * Filter keys: location_id, item_type, state, party_id, product_id. Each item has `bundle` or `lot` only for its type.
     * @return list<array<string,mixed>>
     */
    public static function positionsDetailed(Db $db, array $filter = []): array
    {
        $pf = [];
        foreach (['location_id', 'item_type'] as $k) if (isset($filter[$k]) && $filter[$k] !== '') $pf[$k] = $filter[$k];
        $positions = Ledger::stockPositions($db, $pf);
        if (!$positions) return [];
        $locIds = array_values(array_unique(array_map(static fn ($p) => $p['location_id'], $positions)));
        $locs = [];
        foreach ($db->all('SELECT id, name, kind, party_id FROM locations WHERE id IN (' . Db::placeholders($locIds) . ')', $locIds) as $l) $locs[$l['id']] = $l;
        $bundleIds = array_values(array_map(static fn ($p) => $p['item_id'], array_filter($positions, static fn ($p) => $p['item_type'] === 'bundle')));
        $lotIds = array_values(array_map(static fn ($p) => $p['item_id'], array_filter($positions, static fn ($p) => $p['item_type'] === 'material_lot')));
        $bundles = [];
        $blines = [];
        if ($bundleIds) {
            foreach ($db->all('SELECT id, code, form, color, status, production_run_id, reserved_order_line_id, factory_party_id FROM bundles WHERE id IN (' . Db::placeholders($bundleIds) . ')', $bundleIds) as $b) $bundles[$b['id']] = $b;
            foreach ($db->all(
                'SELECT bundle_lines.bundle_id, bundle_lines.product_id, products.code AS product_code, products.name_fa AS product_name, bundle_lines.length_m, bundle_lines.filler_mm, bundle_lines.bars
                 FROM bundle_lines INNER JOIN products ON products.id = bundle_lines.product_id WHERE bundle_id IN (' . Db::placeholders($bundleIds) . ') ORDER BY bundle_lines.sort',
                $bundleIds,
            ) as $l) $blines[$l['bundle_id']][] = $l;
        }
        $lots = [];
        if ($lotIds) {
            foreach ($db->all(
                'SELECT material_lots.id, material_lots.kind, material_lots.alloy, material_lots.description, material_lots.owner_party_id, material_lots.unit, parties.name AS owner_name
                 FROM material_lots LEFT JOIN parties ON parties.id = material_lots.owner_party_id WHERE material_lots.id IN (' . Db::placeholders($lotIds) . ')',
                $lotIds,
            ) as $l) $lots[$l['id']] = $l;
        }
        // Current state per (item, location): the latest inbound move's state_to.
        $itemIds = array_map(static fn ($p) => $p['item_id'], $positions);
        $states = [];
        foreach ($db->all(
            'SELECT item_type, item_id, to_location_id, state_to, owner_party_id FROM stock_moves WHERE to_location_id IN (' . Db::placeholders($locIds) . ') AND item_id IN (' . Db::placeholders($itemIds) . ') ORDER BY at DESC, created_at DESC',
            [...$locIds, ...$itemIds],
        ) as $s) {
            $states[$s['item_id'] . '|' . $s['to_location_id']] ??= $s;
        }
        $out = [];
        foreach ($positions as $p) {
            $loc = $locs[$p['location_id']];
            $st = $states[$p['item_id'] . '|' . $p['location_id']] ?? null;
            $b = $p['item_type'] === 'bundle' ? ($bundles[$p['item_id']] ?? null) : null;
            $lot = $p['item_type'] === 'material_lot' ? ($lots[$p['item_id']] ?? null) : null;
            if ($b) $state = $b['status'] === 'ok' ? Bundles::formState($b['form']) : ($b['status'] === 'consumed' ? 'sold' : 'quarantine');
            else $state = $st['state_to'] ?? ($lot ? Materials::lotState($lot['kind']) : null);
            if (isset($filter['state']) && $filter['state'] !== '' && $state !== $filter['state']) continue;
            if (isset($filter['party_id']) && $filter['party_id'] !== '' && $loc['party_id'] !== $filter['party_id']) continue;
            $lines = $b ? ($blines[$b['id']] ?? []) : [];
            if (isset($filter['product_id']) && $filter['product_id'] !== '') {
                $found = false;
                foreach ($lines as $l) if ($l['product_id'] === $filter['product_id']) $found = true;
                if (!$found) continue;
            }
            $row = [
                'location_id' => $p['location_id'],
                'location_name' => $loc['name'],
                'location_kind' => $loc['kind'],
                'party_id' => $loc['party_id'],
                'item_type' => $p['item_type'],
                'item_id' => $p['item_id'],
                'kg' => $p['kg'],
                'state' => $state,
                'owner_party_id' => $lot['owner_party_id'] ?? $st['owner_party_id'] ?? null,
            ];
            if ($b) $row['bundle'] = $b + ['lines' => $lines];
            if ($lot) $row['lot'] = $lot;
            $out[] = $row;
        }
        return $out;
    }

    /** String.prototype.localeCompare(b, 'fa'). */
    private static function localeCompare(string $a, string $b): int
    {
        static $coll = null;
        if ($coll === null && class_exists(\Collator::class)) $coll = new \Collator('fa');
        if ($coll) return (int) $coll->compare($a, $b);
        return strcmp($a, $b);
    }

    /** Object.fromEntries of rounded Decimals; empty → {} */
    private static function roundedMap(array $m): array|\stdClass
    {
        $out = [];
        foreach ($m as $k => $v) $out[$k] = Num::round($v, 'weight');
        return $out ?: new \stdClass();
    }

    public static function register(Router $r, App $app): void
    {
        $r->get('/stock/positions', static function (Request $req) use ($app) {
            $req->requireUser();
            $q = V::object([
                'location_id' => V::uuid()->optional(),
                'item_type' => V::enum(['bundle', 'material_lot'])->optional(),
                'state' => V::string()->max(20)->optional(),
                'party_id' => V::uuid()->optional(),
                'product_id' => V::uuid()->optional(),
            ])->parse($req->query);
            return ['items' => self::positionsDetailed($app->db(), $q)];
        });

        // Summary per location → state → kg, plus totals by state (raw / coated / quarantine / ingot / scrap / in transit).
        $r->get('/stock/summary', static function (Request $req) use ($app) {
            $req->requireUser();
            $items = self::positionsDetailed($app->db());
            $byLocation = [];
            $byState = [];
            $total = Decimal::zero();
            $vitralOwned = Decimal::zero();
            foreach ($items as $p) {
                $id = $p['location_id'];
                $byLocation[$id] ??= ['location_id' => $id, 'name' => $p['location_name'], 'kind' => $p['location_kind'], 'party_id' => $p['party_id'], 'states' => [], 'total_kg' => '0', 'bundle_count' => 0];
                $key = $p['state'] ?? 'unknown';
                $byLocation[$id]['states'][$key] = Num::round(Decimal::of($byLocation[$id]['states'][$key] ?? 0)->add($p['kg']), 'weight');
                $byLocation[$id]['total_kg'] = Num::round(Decimal::of($byLocation[$id]['total_kg'])->add($p['kg']), 'weight');
                if ($p['item_type'] === 'bundle') $byLocation[$id]['bundle_count']++;
                $byState[$key] = ($byState[$key] ?? Decimal::zero())->add($p['kg']);
                $total = $total->add($p['kg']);
                if ($p['owner_party_id'] === null || $p['owner_party_id'] === '') $vitralOwned = $vitralOwned->add($p['kg']);
            }
            $locations = array_values($byLocation);
            usort($locations, static fn ($a, $b) => self::localeCompare((string) $a['name'], (string) $b['name']));
            foreach ($locations as &$l) if (!$l['states']) $l['states'] = new \stdClass();
            unset($l);
            return ['locations' => $locations, 'by_state' => self::roundedMap($byState), 'total_kg' => Num::round($total, 'weight'), 'vitral_owned_kg' => Num::round($vitralOwned, 'weight')];
        });

        // Available for sale: ok, definitive bundles minus active reservations, grouped by product/form/colour.
        $r->get('/stock/available', static function (Request $req) use ($app) {
            $req->requireUser();
            $q = V::object([
                'product_id' => V::uuid()->optional(),
                'form' => V::enum(['raw', 'painted', 'anodized'])->optional(),
                'color' => V::string()->max(60)->optional(),
            ])->parse($req->query);
            $where = ["bundles.status = 'ok'", 'bundles.draft = 0', "locations.kind IN ('own_warehouse', 'factory', 'painter')"];
            $params = [];
            if (Materials::truthy($q['product_id'] ?? null)) { $where[] = 'bundle_lines.product_id = ?'; $params[] = $q['product_id']; }
            if (Materials::truthy($q['form'] ?? null)) { $where[] = 'bundles.form = ?'; $params[] = $q['form']; }
            if (Materials::truthy($q['color'] ?? null)) { $where[] = 'bundles.color = ?'; $params[] = $q['color']; }
            // The reserved kg per bundle is summed once per joined line, as the Node query does.
            $rows = $app->db()->all(
                "SELECT bundle_lines.product_id, products.code AS product_code, products.name_fa AS product_name, bundles.form, bundles.color, bundle_lines.length_m, bundle_lines.filler_mm,
                        COUNT(DISTINCT bundles.id) AS bundles, SUM(COALESCE(bundle_lines.weight_kg, bundles.weight_kg)) AS kg, SUM(COALESCE(bundle_lines.bars,0)) AS bars,
                        COALESCE(SUM(COALESCE(rs.kg, 0)),0) AS reserved_kg
                 FROM bundles
                 INNER JOIN bundle_lines ON bundle_lines.bundle_id = bundles.id
                 INNER JOIN products ON products.id = bundle_lines.product_id
                 INNER JOIN locations ON locations.id = bundles.location_id
                 LEFT JOIN (SELECT r.bundle_id, SUM(r.kg) AS kg FROM reservations r WHERE r.status = 'active' AND r.bundle_id IS NOT NULL GROUP BY r.bundle_id) rs ON rs.bundle_id = bundles.id
                 WHERE " . implode(' AND ', $where) . '
                 GROUP BY bundle_lines.product_id, products.code, products.name_fa, bundles.form, bundles.color, bundle_lines.length_m, bundle_lines.filler_mm',
                $params,
            );
            $items = [];
            foreach ($rows as $row) {
                $row['bundles'] = (int) $row['bundles'];
                $row['bars'] = Decimal::of((string) $row['bars'])->toFixed();
                $kg = (string) $row['kg'];
                $reserved = (string) $row['reserved_kg'];
                $row['kg'] = Num::round($kg, 'weight');
                $row['reserved_kg'] = Num::round($reserved, 'weight');
                $row['free_kg'] = Num::round(Decimal::of($kg)->sub($reserved), 'weight');
                $items[] = $row;
            }
            return ['items' => $items];
        });

        // Ledger browser.
        $r->get('/stock/moves', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $q = V::listQuery()->extend([
                'item_type' => V::enum(['bundle', 'material_lot'])->optional(),
                'item_id' => V::uuid()->optional(),
                'location_id' => V::uuid()->optional(),
                'ref_type' => V::string()->max(40)->optional(),
                'ref_id' => V::uuid()->optional(),
                'from' => V::isoDate()->optional(),
                'to' => V::isoDate()->optional(),
            ])->parse($req->query);
            $where = [];
            $params = [];
            if (Materials::truthy($q['item_type'] ?? null)) { $where[] = 'stock_moves.item_type = ?'; $params[] = $q['item_type']; }
            if (Materials::truthy($q['item_id'] ?? null)) { $where[] = 'stock_moves.item_id = ?'; $params[] = $q['item_id']; }
            if (Materials::truthy($q['location_id'] ?? null)) { $where[] = '(stock_moves.from_location_id = ? OR stock_moves.to_location_id = ?)'; array_push($params, $q['location_id'], $q['location_id']); }
            if (Materials::truthy($q['ref_type'] ?? null)) { $where[] = 'stock_moves.ref_type = ?'; $params[] = $q['ref_type']; }
            if (Materials::truthy($q['ref_id'] ?? null)) { $where[] = 'stock_moves.ref_id = ?'; $params[] = $q['ref_id']; }
            if (Materials::truthy($q['from'] ?? null)) { $where[] = 'stock_moves.at >= ?'; $params[] = Db::dt($q['from']); }
            if (Materials::truthy($q['to'] ?? null)) { $where[] = 'stock_moves.at < ?'; $params[] = Db::dt($q['to']); }
            $cur = Pagination::decodeCursor($q['cursor'] ?? null);
            if ($cur) {
                $where[] = '(stock_moves.at, stock_moves.id) < (?, ?)';
                array_push($params, (string) Db::dt($cur['at']), $cur['id']);
            }
            $params[] = $q['limit'] + 1;
            $rows = $app->db()->all(
                "SELECT stock_moves.*, f.name AS from_name, t.name AS to_name, bundles.code AS bundle_code, users.short_name AS user_name
                 FROM stock_moves
                 LEFT JOIN locations f ON f.id = stock_moves.from_location_id
                 LEFT JOIN locations t ON t.id = stock_moves.to_location_id
                 LEFT JOIN bundles ON bundles.id = stock_moves.item_id AND stock_moves.item_type = 'bundle'
                 LEFT JOIN users ON users.id = stock_moves.created_by" .
                ($where ? ' WHERE ' . implode(' AND ', $where) : '') .
                ' ORDER BY stock_moves.at DESC, stock_moves.id DESC LIMIT ?',
                $params,
            );
            $page = array_slice($rows, 0, $q['limit']);
            $last = $page ? $page[count($page) - 1] : null;
            $finance = Auth::can($me, 'finance.view');
            $items = array_map(static function ($m) use ($finance) {
                if (!$finance) unset($m['unit_cost']);
                return $m;
            }, $page);
            return ['items' => $items, 'next_cursor' => count($rows) > $q['limit'] && $last ? Pagination::encodeCursor($last['at'], $last['id']) : null];
        });

        // Opening balances (inventory.adjust): one ledger row per item with ref «opening»; locked after any later movement.
        $r->post('/stock/opening', static function (Request $req) use ($app) {
            $me = $req->requirePermission('inventory.adjust');
            $key = Idempotency::requireKey($req);
            $body = V::object([
                'as_of' => V::string()->regex('/^\d{4}-\d{2}-\d{2}$/'),
                'location_id' => V::uuid(),
                'reason' => V::optText(500),
                'file_id' => V::uuid()->nullable()->optional(),
                'items' => V::array(V::object([
                    'item_type' => V::enum(['bundle', 'material_lot']),
                    'item_id' => V::uuid()->optional(),
                    'kg' => V::decimalString(),
                    'unit_cost' => V::decimalString()->nullable()->optional(),
                    'currency' => V::enum(Num::CURRENCIES)->default('TOMAN'),
                    'bundle' => V::object([
                        'code' => V::string()->trim()->min(1)->max(60),
                        'form' => V::enum(['raw', 'painted', 'anodized'])->default('raw'),
                        'color' => V::optText(60),
                        'lines' => V::array(V::object([
                            'product_id' => V::uuid(),
                            'filler_mm' => V::decimalString()->nullable()->optional(),
                            'length_m' => V::decimalString()->nullable()->optional(),
                            'bars' => V::int()->min(0)->nullable()->optional(),
                            'weight_kg' => V::decimalString()->nullable()->optional(),
                        ]))->min(1),
                    ])->optional(),
                    'lot' => V::object([
                        'kind' => V::enum(['ingot', 'billet', 'scrap', 'paint_powder', 'tool']),
                        'alloy' => V::optText(40),
                        'description' => V::optText(500),
                        'owner_party_id' => V::uuid()->nullable()->optional(),
                        'unit' => V::enum(['kg', 'carton', 'piece'])->default('kg'),
                        'kg_per_unit' => V::decimalString()->nullable()->optional(),
                    ])->optional(),
                ]))->min(1)->max(500),
            ])->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /stock/opening', static function (Db $trx) use ($body, $me) {
                $asOf = new \DateTimeImmutable($body['as_of'] . 'T00:00:00Z');
                $created = [];
                foreach ($body['items'] as $it) {
                    $itemId = $it['item_id'] ?? null;
                    $state = 'ingot';
                    $owner = null;
                    if ($it['item_type'] === 'bundle') {
                        if (!Materials::truthy($itemId)) {
                            if (!isset($it['bundle'])) throw new AppError('validation', 'مشخصات بندیل افتتاحیه لازم است', ['bundle' => 'لازم است']);
                            $bid = $trx->insertNoReturn('bundles', ['code' => $it['bundle']['code'], 'location_id' => $body['location_id'], 'weight_kg' => $it['kg'], 'form' => $it['bundle']['form'], 'color' => $it['bundle']['color'] ?? null, 'source' => 'opening', 'reported_at' => $asOf, 'warnings' => '[]', 'created_by' => $me->id]);
                            $sort = 0;
                            foreach ($it['bundle']['lines'] as $l) $trx->insertNoReturn('bundle_lines', array_merge($l, ['bundle_id' => $bid, 'sort' => $sort++, 'created_by' => $me->id]));
                            $itemId = $bid;
                            $state = Bundles::formState($it['bundle']['form']);
                        } else {
                            $b = $trx->one('SELECT form FROM bundles WHERE id = ?', [$itemId]);
                            if (!$b) throw new \RuntimeException('no result');
                            $state = Bundles::formState($b['form']);
                        }
                    } else {
                        if (!Materials::truthy($itemId)) {
                            if (!isset($it['lot'])) throw new AppError('validation', 'مشخصات پارت مواد افتتاحیه لازم است', ['lot' => 'لازم است']);
                            $itemId = $trx->insertNoReturn('material_lots', array_merge($it['lot'], ['created_by' => $me->id]));
                            $state = Materials::lotState($it['lot']['kind']);
                            $owner = $it['lot']['owner_party_id'] ?? null;
                        } else {
                            $l = $trx->one('SELECT kind, owner_party_id FROM material_lots WHERE id = ?', [$itemId]);
                            if (!$l) throw new \RuntimeException('no result');
                            $state = Materials::lotState($l['kind']);
                            $owner = $l['owner_party_id'];
                        }
                    }
                    $hasCost = Materials::truthy($it['unit_cost'] ?? null);
                    $rowId = $trx->insertNoReturn('opening_weights', ['item_type' => $it['item_type'], 'item_id' => $itemId, 'location_id' => $body['location_id'], 'kg' => $it['kg'], 'unit_cost' => $it['unit_cost'] ?? null, 'currency' => $hasCost ? $it['currency'] : null, 'as_of' => $body['as_of'], 'reason' => $body['reason'] ?? null, 'file_id' => $body['file_id'] ?? null, 'created_by' => $me->id]);
                    Ledger::move($trx, ['at' => $asOf, 'item_type' => $it['item_type'], 'item_id' => $itemId, 'from_location_id' => null, 'to_location_id' => $body['location_id'], 'kg' => $it['kg'], 'state_to' => $state, 'ref_type' => 'opening', 'ref_id' => $rowId, 'unit_cost' => $it['unit_cost'] ?? null, 'currency' => $hasCost ? $it['currency'] : null, 'owner_party_id' => $owner, 'userId' => $me->id]);
                    $created[] = $rowId;
                }
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'opening_weights', 'entityId' => null, 'action' => 'create', 'after' => ['count' => count($created), 'location_id' => $body['location_id'], 'as_of' => $body['as_of']], 'reason' => $body['reason'] ?? null]);
                return ['status' => 201, 'body' => ['ids' => $created]];
            });
            return Response::json($res['body'], $res['status']);
        });

        $r->get('/stock/opening', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $q = V::object(['location_id' => V::uuid()->optional()])->parse($req->query);
            $db = $app->db();
            $where = '';
            $params = [];
            if (Materials::truthy($q['location_id'] ?? null)) {
                $where = ' WHERE opening_weights.location_id = ?';
                $params[] = $q['location_id'];
            }
            $rows = $db->all(
                'SELECT opening_weights.*, locations.name AS location_name, bundles.code AS bundle_code, material_lots.description AS lot_description, material_lots.kind AS lot_kind
                 FROM opening_weights
                 LEFT JOIN locations ON locations.id = opening_weights.location_id
                 LEFT JOIN bundles ON bundles.id = opening_weights.item_id
                 LEFT JOIN material_lots ON material_lots.id = opening_weights.item_id' . $where . '
                 ORDER BY opening_weights.as_of DESC LIMIT 500',
                $params,
            );
            $finance = Auth::can($me, 'finance.view');
            $items = [];
            foreach ($rows as $row) {
                $later = $db->value("SELECT id FROM stock_moves WHERE item_type = ? AND item_id = ? AND ref_type <> 'opening' LIMIT 1", [$row['item_type'], $row['item_id']]);
                $row['locked'] = $row['locked'] || $later !== null;
                if (!$finance) unset($row['unit_cost']);
                $items[] = $row;
            }
            return ['items' => $items];
        });

        // Count adjustment (inventory.adjust): set the counted kg of an item at a location; the difference is one ledger row with the reason.
        $r->post('/stock/adjust', static function (Request $req) use ($app) {
            $me = $req->requirePermission('inventory.adjust');
            $key = Idempotency::requireKey($req);
            $body = V::object([
                'item_type' => V::enum(['bundle', 'material_lot']),
                'item_id' => V::uuid(),
                'location_id' => V::uuid(),
                'counted_kg' => V::decimalString(),
                'reason' => V::string()->trim()->min(3)->max(500),
                'file_id' => V::uuid()->nullable()->optional(),
            ])->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /stock/adjust', static function (Db $trx) use ($body, $me) {
                $have = Decimal::of(Ledger::itemBalance($trx, $body['item_type'], $body['item_id'], $body['location_id']));
                $diff = Decimal::of($body['counted_kg'])->sub($have);
                if ($diff->isZero()) return ['status' => 200, 'body' => ['kg' => $have->toFixed(3), 'diff_kg' => '0.000']];
                if ($body['item_type'] === 'bundle') {
                    $b = $trx->find('bundles', $body['item_id'], true);
                    if (!$b) throw new \RuntimeException('no result');
                    $state = $b['status'] === 'ok' ? Bundles::formState($b['form']) : 'quarantine';
                    $trx->update('bundles', ['weight_kg' => $body['counted_kg']] + Db::bump(), 'id = ?', [$b['id']]);
                } else {
                    $l = $trx->one('SELECT kind FROM material_lots WHERE id = ?', [$body['item_id']]);
                    if (!$l) throw new \RuntimeException('no result');
                    $state = Materials::lotState($l['kind']);
                }
                $avg = $body['item_type'] === 'material_lot' ? Materials::lotAverage($trx, $body['item_id'])['avg'] : null;
                $note = $body['reason'] . (Materials::truthy($body['file_id'] ?? null) ? " [file:{$body['file_id']}]" : '');
                if ($diff->gt(0)) {
                    Ledger::move($trx, ['item_type' => $body['item_type'], 'item_id' => $body['item_id'], 'from_location_id' => null, 'to_location_id' => $body['location_id'], 'kg' => $diff->toFixed(3), 'state_to' => $state, 'ref_type' => 'count_adjustment', 'ref_id' => $body['item_id'], 'unit_cost' => $avg, 'note' => $note, 'userId' => $me->id]);
                } else {
                    Ledger::move($trx, ['item_type' => $body['item_type'], 'item_id' => $body['item_id'], 'from_location_id' => $body['location_id'], 'to_location_id' => null, 'kg' => $diff->abs()->toFixed(3), 'state_from' => $state, 'state_to' => 'consumed', 'ref_type' => 'count_adjustment', 'ref_id' => $body['item_id'], 'unit_cost' => $avg, 'note' => $note, 'userId' => $me->id]);
                }
                Audit::log($trx, ['userId' => $me->id, 'entity' => $body['item_type'] === 'bundle' ? 'bundles' : 'material_lots', 'entityId' => $body['item_id'], 'action' => 'count_adjustment', 'before' => ['kg' => $have->toFixed(3)], 'after' => ['kg' => $body['counted_kg'], 'location_id' => $body['location_id']], 'reason' => $body['reason']]);
                return ['status' => 200, 'body' => ['kg' => $body['counted_kg'], 'diff_kg' => Num::round($diff, 'weight')]];
            });
            return $res['body'];
        });

        // Factory weight account: Vitral's weight at a factory/painter — received, consumed, produced, scrap, currently there.
        $r->get('/stock/party-account/:id', static function (Request $req) use ($app) {
            $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $db = $app->db();
            $locs = $db->all('SELECT id, name, kind FROM locations WHERE party_id = ?', [$id]);
            if (!$locs) throw new AppError('not_found', 'این طرف محل انبار ندارد');
            $ids = array_map(static fn ($l) => $l['id'], $locs);
            $in = '(' . Db::placeholders($ids) . ')';
            $cols = [
                'received_kg' => "to_location_id IN {$in} AND ref_type IN ('transfer_receive','purchase_receipt','opening')",
                'consumed_kg' => "from_location_id IN {$in} AND ref_type = 'production_consume'",
                'produced_kg' => "to_location_id IN {$in} AND ref_type = 'production_output' AND item_type = 'bundle'",
                'scrap_kg' => "to_location_id IN {$in} AND state_to = 'scrap'",
                'dispatched_kg' => "from_location_id IN {$in} AND ref_type = 'transfer_dispatch'",
                'coating_in_kg' => "to_location_id IN {$in} AND ref_type = 'coating_send'",
                'coating_out_kg' => "from_location_id IN {$in} AND ref_type = 'coating_return'",
            ];
            $select = [];
            $params = [];
            foreach ($cols as $name => $cond) {
                $select[] = "COALESCE(SUM(CASE WHEN {$cond} THEN kg ELSE 0 END),0) AS {$name}";
                array_push($params, ...$ids);
            }
            $sums = $db->one('SELECT ' . implode(', ', $select) . ' FROM stock_moves', $params) ?? [];
            $positions = self::positionsDetailed($db, ['party_id' => $id]);
            $byState = [];
            $total = Decimal::zero();
            foreach ($positions as $p) {
                $k = $p['state'] ?? 'unknown';
                $byState[$k] = ($byState[$k] ?? Decimal::zero())->add($p['kg']);
                $total = $total->add($p['kg']);
            }
            $out = ['locations' => $locs];
            foreach ($sums as $k => $v) $out[$k] = Num::round((string) $v, 'weight');
            $out['on_hand'] = self::roundedMap($byState);
            $out['on_hand_total_kg'] = Num::round($total, 'weight');
            $out['items'] = $positions;
            return $out;
        });
    }
}
