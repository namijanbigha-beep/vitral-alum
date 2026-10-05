<?php
declare(strict_types=1);

namespace Vitral\Lib;

use Vitral\Core\AppError;
use Vitral\Core\Db;

/**
 * Port of apps/server/src/lib/stock.ts — the weight ledger (principle 8).
 *
 * Item types: 'material_lot' | 'bundle'. States: ingot, scrap, raw, coated, quarantine, in_transit, consumed, sold, paint, tool.
 * MoveInput (array keys as in TypeScript): at?, item_type, item_id, from_location_id, to_location_id, kg,
 * state_from?, state_to?, ref_type, ref_id, unit_cost?, currency?, owner_party_id?, note?, userId.
 */
final class Stock
{
    private const ITEM_TABLE = ['bundle' => 'bundles', 'material_lot' => 'material_lots'];

    /** Quantity of an item at a location, from the ledger (canonical weight string). */
    public static function itemBalance(Db $trx, string $itemType, string $itemId, string $locationId): string
    {
        $kg = $trx->value(
            'SELECT COALESCE(SUM(CASE WHEN to_location_id = ? THEN kg ELSE 0 END) - SUM(CASE WHEN from_location_id = ? THEN kg ELSE 0 END), 0) AS kg
             FROM stock_moves WHERE item_type = ? AND item_id = ?',
            [$locationId, $locationId, $itemType, $itemId],
        );
        return Num::round((string) ($kg ?? '0'), 'weight');
    }

    /**
     * Append one ledger row. A move out of a location checks the balance first (with the item locked) and fails with
     * insufficient_stock, so no location ever goes negative. Node takes pg_advisory_xact_lock(item); here the item's
     * own row (bundles / material_lots) is locked FOR UPDATE, which likewise serialises moves of one item until commit.
     * @param array<string,mixed> $m MoveInput
     * @return string the new stock_moves id
     */
    public static function move(Db $trx, array $m): string
    {
        $table = self::ITEM_TABLE[$m['item_type']] ?? null;
        if ($table !== null) $trx->exec('SELECT id FROM ' . Db::ident($table) . ' WHERE id = ? FOR UPDATE', [$m['item_id']]);
        $kg = $m['kg'] instanceof Decimal ? $m['kg']->toFixed() : (string) $m['kg'];
        if (!empty($m['from_location_id'])) {
            $have = Decimal::of(self::itemBalance($trx, $m['item_type'], $m['item_id'], $m['from_location_id']));
            if ($have->lt($kg)) {
                throw new AppError('insufficient_stock', 'موجودی کافی نیست؛ موجود ' . Num::round($have, 'weight') . ' کیلوگرم، درخواست ' . Num::round($kg, 'weight') . ' کیلوگرم');
            }
        }
        $at = $m['at'] ?? null;
        return $trx->insertNoReturn('stock_moves', [
            'at' => $at === null ? Db::now() : Db::dt($at),
            'item_type' => $m['item_type'],
            'item_id' => $m['item_id'],
            'from_location_id' => $m['from_location_id'] ?? null,
            'to_location_id' => $m['to_location_id'] ?? null,
            'kg' => $kg,
            'state_from' => $m['state_from'] ?? null,
            'state_to' => $m['state_to'] ?? null,
            'ref_type' => $m['ref_type'],
            'ref_id' => $m['ref_id'],
            'unit_cost' => $m['unit_cost'] ?? null,
            'currency' => $m['currency'] ?? null,
            'owner_party_id' => $m['owner_party_id'] ?? null,
            'note' => $m['note'] ?? null,
            'created_by' => $m['userId'] ?? null,
        ]);
    }

    /**
     * Current quantity of every item at every location (non-zero), optionally restricted.
     * @param array{location_id?:string,item_type?:string,item_id?:string} $filter
     * @return list<array{location_id:string,item_type:string,item_id:string,kg:string}>
     */
    public static function stockPositions(Db $db, array $filter = []): array
    {
        $where = [];
        $params = [];
        foreach (['location_id', 'item_type', 'item_id'] as $k) {
            if (!empty($filter[$k])) {
                $where[] = "m.{$k} = ?";
                $params[] = $filter[$k];
            }
        }
        $sql = 'SELECT m.location_id, m.item_type, m.item_id, SUM(m.kg) AS kg FROM (
                  SELECT item_type, item_id, `at`, to_location_id AS location_id, kg FROM stock_moves WHERE to_location_id IS NOT NULL
                  UNION ALL
                  SELECT item_type, item_id, `at`, from_location_id AS location_id, -kg AS kg FROM stock_moves WHERE from_location_id IS NOT NULL
                ) m' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . '
                GROUP BY m.location_id, m.item_type, m.item_id
                HAVING SUM(m.kg) <> 0
                ORDER BY MIN(m.`at`), m.location_id, m.item_type, m.item_id'; // deterministic, as lib/stock.ts
        $out = [];
        foreach ($db->all($sql, $params) as $r) {
            $out[] = ['location_id' => $r['location_id'], 'item_type' => $r['item_type'], 'item_id' => $r['item_id'], 'kg' => Num::round((string) $r['kg'], 'weight')];
        }
        return $out;
    }

    /** Id of the single «in transit» location. */
    public static function IN_TRANSIT(Db $db): string
    {
        $id = $db->value("SELECT id FROM locations WHERE kind = 'in_transit' LIMIT 1");
        if ($id === null) throw new \RuntimeException('no result');
        return (string) $id;
    }

    /** Id of the first (oldest) own warehouse. */
    public static function OWN_WAREHOUSE(Db $db): string
    {
        $id = $db->value("SELECT id FROM locations WHERE kind = 'own_warehouse' ORDER BY created_at LIMIT 1");
        if ($id === null) throw new \RuntimeException('no result');
        return (string) $id;
    }
}
