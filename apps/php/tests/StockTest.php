<?php
declare(strict_types=1);

use Vitral\Core\AppError;
use Vitral\Core\Db;
use Vitral\Lib\Stock;

/**
 * src/Lib/Stock.php (port of apps/server/src/lib/stock.ts) against a migrated MySQL test database.
 * Needs STOCK_TEST_DB_NAME (a name ending in _test or _test_wN, migrated, e.g. after a conformance run) and optionally
 * DB_HOST / DB_PORT / DB_USER / DB_PASS; without it the tests are skipped. Everything runs in a rolled-back transaction.
 *   STOCK_TEST_DB_NAME=vitral_php_test_w1 php apps/php/tests/run.php Stock
 */
$name = getenv('STOCK_TEST_DB_NAME') ?: '';
if ($name === '' || !preg_match('/_test(_w\d+)?$/', $name)) {
    return ['skipped (set STOCK_TEST_DB_NAME to a migrated *_test database)' => static fn () => null];
}
$db = new Db(['host' => getenv('DB_HOST') ?: '127.0.0.1', 'port' => getenv('DB_PORT') ?: '3306', 'name' => $name, 'user' => getenv('DB_USER') ?: 'vitral', 'pass' => getenv('DB_PASS') ?: 'vitral']);

$inTrx = static function (callable $fn) use ($db): void {
    try {
        $db->transaction(static function (Db $trx) use ($fn) {
            $fn($trx);
            throw new \LogicException('rollback');
        });
    } catch (\LogicException $e) {
        if ($e->getMessage() !== 'rollback') throw $e;
    }
};
$loc = static function (Db $trx, string $kind = 'factory'): string {
    return $trx->insertNoReturn('locations', ['name' => 'stock test ' . Db::uuid(), 'kind' => $kind]);
};
$lot = static fn (Db $trx): string => $trx->insertNoReturn('material_lots', ['kind' => 'ingot', 'description' => 'stock test']);

return [
    'IN_TRANSIT and OWN_WAREHOUSE resolve the seeded locations' => static function () use ($db) {
        T::eq('in_transit', $db->value('SELECT kind FROM locations WHERE id = ?', [Stock::IN_TRANSIT($db)]));
        T::eq('own_warehouse', $db->value('SELECT kind FROM locations WHERE id = ?', [Stock::OWN_WAREHOUSE($db)]));
    },
    'moves, balances and positions follow the ledger' => static function () use ($inTrx, $loc, $lot) {
        $inTrx(static function (Db $trx) use ($loc, $lot) {
            $a = $loc($trx);
            $b = $loc($trx);
            $item = $lot($trx);
            T::eq('0.000', Stock::itemBalance($trx, 'material_lot', $item, $a));
            Stock::move($trx, ['item_type' => 'material_lot', 'item_id' => $item, 'from_location_id' => null, 'to_location_id' => $a, 'kg' => '1000', 'state_to' => 'ingot', 'ref_type' => 'opening', 'ref_id' => $item, 'userId' => null]);
            $id = Stock::move($trx, ['at' => new DateTimeImmutable('2026-01-02T03:04:05.678Z'), 'item_type' => 'material_lot', 'item_id' => $item, 'from_location_id' => $a, 'to_location_id' => $b, 'kg' => '400.5', 'state_from' => 'ingot', 'state_to' => 'ingot', 'ref_type' => 'transfer_dispatch', 'ref_id' => $item, 'unit_cost' => '300000', 'currency' => 'TOMAN', 'userId' => null]);
            $row = $trx->find('stock_moves', $id);
            T::eq('2026-01-02T03:04:05.678Z', $row['at']);
            T::eq('400.500', $row['kg']);
            T::eq('599.500', Stock::itemBalance($trx, 'material_lot', $item, $a));
            T::eq('400.500', Stock::itemBalance($trx, 'material_lot', $item, $b));
            $pos = Stock::stockPositions($trx, ['item_id' => $item]);
            usort($pos, static fn ($x, $y) => strcmp($x['kg'], $y['kg']));
            T::eq([
                ['location_id' => $b, 'item_type' => 'material_lot', 'item_id' => $item, 'kg' => '400.500'],
                ['location_id' => $a, 'item_type' => 'material_lot', 'item_id' => $item, 'kg' => '599.500'],
            ], $pos);
            T::eq(1, count(Stock::stockPositions($trx, ['item_id' => $item, 'location_id' => $b])));
            // a location that drops to zero disappears from the positions (HAVING SUM <> 0)
            Stock::move($trx, ['item_type' => 'material_lot', 'item_id' => $item, 'from_location_id' => $b, 'to_location_id' => null, 'kg' => '400.5', 'state_from' => 'ingot', 'state_to' => 'consumed', 'ref_type' => 'production_consume', 'ref_id' => $item, 'userId' => null]);
            T::eq([], Stock::stockPositions($trx, ['item_id' => $item, 'location_id' => $b]));
        });
    },
    'a move out of a location never makes it negative (insufficient_stock with the Persian message)' => static function () use ($inTrx, $loc, $lot) {
        $inTrx(static function (Db $trx) use ($loc, $lot) {
            $a = $loc($trx);
            $item = $lot($trx);
            Stock::move($trx, ['item_type' => 'material_lot', 'item_id' => $item, 'from_location_id' => null, 'to_location_id' => $a, 'kg' => '10', 'state_to' => 'ingot', 'ref_type' => 'opening', 'ref_id' => $item, 'userId' => null]);
            $e = T::throws(static fn () => Stock::move($trx, ['item_type' => 'material_lot', 'item_id' => $item, 'from_location_id' => $a, 'to_location_id' => null, 'kg' => '10.001', 'ref_type' => 'production_consume', 'ref_id' => $item, 'userId' => null]), AppError::class);
            T::eq('insufficient_stock', $e->errorCode);
            T::eq(409, $e->status);
            T::eq('موجودی کافی نیست؛ موجود 10.000 کیلوگرم، درخواست 10.001 کیلوگرم', $e->getMessage());
            T::eq('10.000', Stock::itemBalance($trx, 'material_lot', $item, $a));
        });
    },
];
