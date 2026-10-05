<?php
declare(strict_types=1);

namespace Vitral\Lib;

use Vitral\Core\Db;
use Vitral\Rules\Production;

/** Port of apps/server/src/modules/bundles/service.ts. */
final class BundlesService
{
    /** Number of lines of the bundle in the current row (`bundles` in scope), as an SQL fragment. */
    public const BUNDLE_COUNT_SQL = '(SELECT COUNT(*) FROM bundle_lines bl WHERE bl.bundle_id = bundles.id)';

    public static function bundleCountSql(): string
    {
        return self::BUNDLE_COUNT_SQL;
    }

    /**
     * Good / rejected kg and the R23 report of a run's definitive, unconsumed bundles.
     * @return array{good_kg:string,rejected_kg:string,bundle_count:int,total_kg:string,per_product:array<string,string>|\stdClass}
     */
    public static function bundleTotalsForRun(Db $db, string $runId): array
    {
        // no ORDER BY in Node (PostgreSQL heap order ≈ insertion order)
        $bundles = $db->all("SELECT id, code, weight_kg, status FROM bundles WHERE production_run_id = ? AND draft = 0 AND status <> 'consumed' ORDER BY created_at, id", [$runId]);
        $ids = array_column($bundles, 'id');
        $lines = $ids ? $db->all('SELECT bundle_id, product_id, weight_kg FROM bundle_lines WHERE bundle_id IN (' . Db::placeholders($ids) . ') ORDER BY created_at, sort', $ids) : [];
        $byBundle = [];
        foreach ($lines as $l) $byBundle[$l['bundle_id']][] = ['product_id' => $l['product_id'], 'weight_kg' => $l['weight_kg']];
        $report = Production::bundleReportTotals(array_map(static fn ($b) => ['code' => $b['code'], 'weight_kg' => $b['weight_kg'], 'lines' => $byBundle[$b['id']] ?? []], $bundles));
        $good = Decimal::zero();
        $rejected = Decimal::zero();
        foreach ($bundles as $b) {
            if ($b['status'] === 'ok') $good = $good->add($b['weight_kg']);
            elseif ($b['status'] !== 'scrapped') $rejected = $rejected->add($b['weight_kg']);
        }
        return ['good_kg' => Num::round($good, 'weight'), 'rejected_kg' => Num::round($rejected, 'weight')] + $report;
    }
}
