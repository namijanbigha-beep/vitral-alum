<?php
declare(strict_types=1);

namespace Vitral\Rules;

use Vitral\Lib\Decimal;
use Vitral\Lib\Num;

/**
 * Port of apps/server/src/rules/production.ts (R03–R09, R22, R23). Pure functions; decimal inputs are strings
 * (ints, floats and Decimals accepted), outputs are canonical strings / arrays shaped like the TypeScript results.
 */
final class Production
{
    /**
     * R03 — actual weight per metre of a bundle (g/m) = (bundle kg − packaging kg) ÷ (bars × length) × 1000,
     * plus the signed difference to the reference in percent (negative = lighter). Null when it cannot be computed.
     * @return array{g_per_m:string,diff_percent:?string}|null
     */
    public static function bundleWeightPerMeter(
        string|int|float|Decimal|null $bundleKg,
        string|int|float|Decimal|null $packagingKg,
        string|int|float|Decimal|null $bars,
        string|int|float|Decimal|null $lengthM,
        string|int|float|Decimal|null $referenceGpm = null,
    ): ?array {
        if ($bundleKg === null || $bars === null || $lengthM === null) return null;
        $denom = Decimal::of($bars)->mul($lengthM);
        if ($denom->isZero()) return null;
        $net = Decimal::of($bundleKg)->sub($packagingKg ?? 0);
        $gpm = $net->div($denom)->mul(1000);
        $diff = $referenceGpm === null || Decimal::of($referenceGpm)->isZero() ? null : Num::percent($gpm->sub($referenceGpm), Decimal::of($referenceGpm));
        return ['g_per_m' => Num::round($gpm, 'g_per_m'), 'diff_percent' => $diff];
    }

    /** R04 — bars = packages × bars per package. */
    public static function barsFromPackages(int|float $packages, int|float $barsPerPackage): int|float
    {
        return $packages * $barsPerPackage;
    }

    /** R05 — coating fee = basis input kg × run rate. Output weight has no effect. Null rate → null. */
    public static function coatingFee(string|int|float|Decimal|null $inputBasisKg, string|int|float|Decimal|null $ratePerKg): ?string
    {
        if ($inputBasisKg === null || $ratePerKg === null) return null;
        return Num::round(Decimal::of($inputBasisKg)->mul($ratePerKg), 'TOMAN');
    }

    /**
     * R06 — weight gain = coated − raw; percent = gain ÷ raw. Un-returned bundles are not included (caller filters).
     * @return array{gain_kg:string,percent:?string}|null
     */
    public static function weightGain(string|int|float|Decimal $rawKg, string|int|float|Decimal|null $coatedKg): ?array
    {
        if ($coatedKg === null) return null;
        $gain = Decimal::of($coatedKg)->sub($rawKg);
        return ['gain_kg' => Num::round($gain, 'weight'), 'percent' => Num::percent($gain, Decimal::of($rawKg))];
    }

    /** R07 — production fee = rate × contract basis kg + fixed fee. Null rate or basis → null. */
    public static function productionFee(
        string|int|float|Decimal|null $ratePerKg,
        string|int|float|Decimal|null $basisKg,
        string|int|float|Decimal|null $fixedFee,
    ): ?string {
        if ($ratePerKg === null || $basisKg === null) return null;
        return Num::round(Decimal::of($ratePerKg)->mul($basisKg)->add($fixedFee ?? 0), 'TOMAN');
    }

    /**
     * R08 — run balance: unexplained = consumed − (good + rejected + scrap + returned); yield = good ÷ consumed.
     * `needs_reason` when |unexplained| exceeds the threshold percent of consumed ingot.
     * @return array{unexplained_kg:string,unexplained_percent:?string,yield_percent:?string,needs_reason:bool}|null
     */
    public static function runBalance(
        string|int|float|Decimal|null $consumedKg,
        string|int|float|Decimal $goodKg,
        string|int|float|Decimal $rejectedKg,
        string|int|float|Decimal $scrapKg,
        string|int|float|Decimal $returnedKg,
        string|int|float|Decimal $thresholdPercent = '1',
    ): ?array {
        if ($consumedKg === null) return null;
        $consumed = Decimal::of($consumedKg);
        $unexplained = $consumed->sub($goodKg)->sub($rejectedKg)->sub($scrapKg)->sub($returnedKg);
        return [
            'unexplained_kg' => Num::round($unexplained, 'weight'),
            'unexplained_percent' => Num::percent($unexplained, $consumed),
            'yield_percent' => Num::percent(Decimal::of($goodKg), $consumed),
            'needs_reason' => !$consumed->isZero() && $unexplained->abs()->div($consumed)->mul(100)->gt($thresholdPercent),
        ];
    }

    /**
     * R09 — scale net = gross − tare − packaging. Without packaging the figure is «ناخالص» and unusable for settlement.
     * @return array{kg:string,gross_only:bool}|null
     */
    public static function scaleNet(
        string|int|float|Decimal|null $grossKg,
        string|int|float|Decimal|null $tareKg,
        string|int|float|Decimal|null $packagingKg,
    ): ?array {
        if ($grossKg === null || $tareKg === null) return null;
        $base = Decimal::of($grossKg)->sub($tareKg);
        if ($packagingKg === null) return ['kg' => Num::round($base, 'weight'), 'gross_only' => true];
        return ['kg' => Num::round($base->sub($packagingKg), 'weight'), 'gross_only' => false];
    }

    /**
     * R22 — bundle weight warning: at least 4 single-product bundles of the same product in the run and
     * |weight − median| ÷ median > threshold. Returns the median used, or null when not applicable.
     * @param list<string|int|float|Decimal> $peerWeightsKg
     * @return array{warn:bool,median_kg:string}|null
     */
    public static function bundleWeightOutlier(string|int|float|Decimal $weightKg, array $peerWeightsKg, string|int|float|Decimal $thresholdPercent = '40'): ?array
    {
        if (count($peerWeightsKg) < 4) return null;
        $sorted = array_map(static fn ($w) => Decimal::of($w), array_values($peerWeightsKg));
        usort($sorted, static fn (Decimal $a, Decimal $b) => $a->cmp($b));
        $n = count($sorted);
        $mid = intdiv($n, 2);
        $median = $n % 2 ? $sorted[$mid] : $sorted[$mid - 1]->add($sorted[$mid])->div(2);
        if ($median->isZero()) return null;
        $warn = Decimal::of($weightKg)->sub($median)->abs()->div($median)->mul(100)->gt($thresholdPercent);
        return ['warn' => $warn, 'median_kg' => Num::round($median, 'weight')];
    }

    /**
     * R23 — bundle report: bundle count is the number of bundles; product weight comes from lines.
     * A single-line bundle without a line weight contributes its bundle weight to that product.
     * @param list<array{code:string,weight_kg:string,lines:list<array{product_id:string,weight_kg:?string}>}> $bundles
     * @return array{bundle_count:int,total_kg:string,per_product:array<string,string>|\stdClass}
     *         per_product is an empty \stdClass when no line has a weight (so it encodes as `{}`)
     */
    public static function bundleReportTotals(array $bundles): array
    {
        /** @var array<string,Decimal> $per */
        $per = [];
        $total = Decimal::zero();
        foreach ($bundles as $b) {
            $total = $total->add($b['weight_kg']);
            $lines = $b['lines'];
            foreach ($lines as $l) {
                $kg = $l['weight_kg'] ?? (count($lines) === 1 ? $b['weight_kg'] : null);
                if ($kg === null) continue;
                $key = (string) $l['product_id'];
                $per[$key] = ($per[$key] ?? Decimal::zero())->add($kg);
            }
        }
        $out = [];
        foreach ($per as $k => $v) $out[(string) $k] = Num::round($v, 'weight');
        return [
            'bundle_count' => count($bundles),
            'total_kg' => Num::round($total, 'weight'),
            'per_product' => $out ?: new \stdClass(),
        ];
    }
}
