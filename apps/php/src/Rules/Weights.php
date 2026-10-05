<?php
declare(strict_types=1);

namespace Vitral\Rules;

use Vitral\Lib\Decimal;
use Vitral\Lib\Num;

/**
 * Port of apps/server/src/rules/weights.ts (R01, R02). Pure functions; decimal inputs are strings
 * (ints and Decimals accepted), outputs are canonical strings like the TypeScript originals.
 */
final class Weights
{
    /** Default aluminium density, g/cm³. */
    public const DEFAULT_DENSITY = '2.7';

    /**
     * R01 — suggested weight per metre (g/m) = section area (mm²) × density (g/cm³).
     * A suggestion only; the reference is the approved filler value. Unknown area → null.
     */
    public static function suggestedWeightPerMeter(string|int|float|Decimal|null $sectionAreaMm2, string|int|float|Decimal $density = self::DEFAULT_DENSITY): ?string
    {
        if ($sectionAreaMm2 === null) return null;
        return Num::round(Decimal::of($sectionAreaMm2)->mul($density), 'g_per_m');
    }

    /**
     * R02 — estimated line weight (kg) = g/m × length (m) × bars ÷ 1000. Always labelled «تخمینی».
     * @return array{kg:string,estimate:true}|null
     */
    public static function estimatedLineKg(string|int|float|Decimal|null $gramsPerMeter, string|int|float|Decimal|null $lengthM, string|int|float|Decimal|null $bars): ?array
    {
        if ($gramsPerMeter === null || $lengthM === null || $bars === null) return null;
        $kg = Decimal::of($gramsPerMeter)->mul($lengthM)->mul($bars)->div(1000);
        return ['kg' => Num::round($kg, 'weight'), 'estimate' => true];
    }

    /**
     * R02 inverse — bars needed for a weight. `exact` to one place, `display` rounded half-up to a whole bar,
     * both approximate. Zero or unknown weight per bar → null.
     * @return array{exact:string,display:string,estimate:true}|null
     */
    public static function estimatedBarsForKg(string|int|float|Decimal|null $kg, string|int|float|Decimal|null $gramsPerMeter, string|int|float|Decimal|null $lengthM): ?array
    {
        if ($kg === null || $gramsPerMeter === null || $lengthM === null) return null;
        $perBarKg = Decimal::of($gramsPerMeter)->mul($lengthM)->div(1000);
        if ($perBarKg->isZero()) return null;
        $bars = Decimal::of($kg)->div($perBarKg);
        return [
            'exact' => $bars->toDecimalPlaces(1)->toFixed(1),
            'display' => $bars->toDecimalPlaces(0)->toFixed(0),
            'estimate' => true,
        ];
    }
}
