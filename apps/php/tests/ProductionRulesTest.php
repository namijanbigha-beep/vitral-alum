<?php
declare(strict_types=1);

use Vitral\Core\Json;
use Vitral\Rules\Production;
use Vitral\Rules\Weights;

/** src/Rules/Production.php + Weights.php against fixtures generated from the TypeScript (fixtures/generate-production.ts). */
$fx = Json::decode((string) file_get_contents(__DIR__ . '/fixtures/production-rules.json'));
$classes = [
    'suggestedWeightPerMeter' => Weights::class,
    'estimatedLineKg' => Weights::class,
    'estimatedBarsForKg' => Weights::class,
];

$tests = [];
foreach ($fx as $fn => $cases) {
    $tests[$fn] = static function () use ($fn, $cases, $classes) {
        $class = $classes[$fn] ?? Production::class;
        foreach ($cases as $i => $c) {
            $got = $class::$fn(...$c['args']);
            // compare as JSON, the way the API serialises results
            T::eq(Json::encode($c['out']), Json::encode($got), "$fn #$i " . json_encode($c['args']));
        }
    };
}

$tests['bundleReportTotals empty per_product encodes as {}'] = static function () {
    T::eq('{"bundle_count":0,"total_kg":"0.000","per_product":{}}', Json::encode(Production::bundleReportTotals([])));
};

// The spec cases of apps/server/test/rules.test.ts / rules-all.test.ts (T01–T11, T26–T28) on the PHP side.
$tests['spec cases T01–T11'] = static function () {
    T::eq('791.1', Weights::suggestedWeightPerMeter('293'));
    T::eq(null, Weights::suggestedWeightPerMeter(null));
    T::eq(['kg' => '108.000', 'estimate' => true], Weights::estimatedLineKg('180', '6', '100'));
    T::eq(['kg' => '4.746', 'estimate' => true], Weights::estimatedLineKg('791', '6', '1'));
    T::eq(['exact' => '210.7', 'display' => '211', 'estimate' => true], Weights::estimatedBarsForKg('1000', '791', '6'));
    T::eq(null, Weights::estimatedBarsForKg('1000', '0', '6'));
    T::eq(['g_per_m' => '938.1', 'diff_percent' => '-1.3'], Production::bundleWeightPerMeter('394', null, '70', '6', '950'));
    T::eq(210, Production::barsFromPackages(15, 14));
    T::eq('80000000', Production::coatingFee('1000', '80000'));
    T::eq(['gain_kg' => '50.000', 'percent' => '5.0'], Production::weightGain('1000', '1050'));
    T::eq(null, Production::productionFee(null, '1000', null));
    T::eq('14750000', Production::productionFee('15000', '950', '500000'));
    T::eq(['unexplained_kg' => '5.000', 'unexplained_percent' => '0.5', 'yield_percent' => '95.0', 'needs_reason' => false], Production::runBalance('1000', '950', '20', '25', '0'));
    T::eq(true, Production::runBalance('1000', '920', '20', '25', '0')['needs_reason']);
    T::eq(['kg' => '980.000', 'gross_only' => false], Production::scaleNet('15000', '14000', '20'));
    T::eq(['kg' => '1000.000', 'gross_only' => true], Production::scaleNet('15000', '14000', null));
};

$tests['spec cases T26–T28 (golden §12-a)'] = static function () {
    $frames = [['812', '394'], ['813', '594'], ['807', '397'], ['808', '397'], ['816', '396'], ['818', '334'], ['817', '399']];
    $peers = array_column($frames, 1);
    T::eq(['warn' => true, 'median_kg' => '397.000'], Production::bundleWeightOutlier('594', $peers));
    foreach ($peers as $w) if ($w !== '594') T::eq(false, Production::bundleWeightOutlier($w, $peers)['warn'], "peer {$w}");
    T::eq(false, Production::bundleWeightOutlier('479', ['349', '352', '479', '318', '357'])['warn']);
    $L = static fn (string $p, ?string $kg) => ['product_id' => $p, 'weight_kg' => $kg];
    $b = static fn (string $code, string $kg, array $lines) => ['code' => $code, 'weight_kg' => $kg, 'lines' => $lines];
    $bundles = array_merge(
        array_map(static fn ($f) => $b($f[0], $f[1], [$L('frame', null)]), $frames),
        [
            $b('809', '542', [$L('frame', '213'), $L('tee', '329')]),
            $b('806', '349', [$L('leaf', null)]), $b('811', '352', [$L('leaf', null)]), $b('821', '479', [$L('leaf', null)]),
            $b('819', '318', [$L('leaf', null)]), $b('822', '302', [$L('leaf', null)]), $b('820', '357', [$L('leaf', null)]),
            $b('810', '494', [$L('tee', null)]), $b('TMP-1', '679', [$L('tee', null)]), $b('TMP-2', '680', [$L('tee', null)]),
            $b('803', '237', [$L('strip', null)]),
        ],
    );
    $r = Production::bundleReportTotals($bundles);
    T::eq(18, $r['bundle_count']);
    T::eq('7700.000', $r['total_kg']);
    T::eq(['frame' => '3124.000', 'tee' => '2182.000', 'leaf' => '2157.000', 'strip' => '237.000'], $r['per_product']);
};

return $tests;
