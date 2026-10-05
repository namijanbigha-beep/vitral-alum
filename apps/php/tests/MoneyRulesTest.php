<?php
declare(strict_types=1);

use Vitral\Rules\Money;

/** src/Rules/Money.php against apps/server/src/rules/money.ts (fixtures: tests/fixtures/generate-money.ts). */
return [
    'every rules/money.ts function matches the TypeScript outputs' => function (): void {
        $f = json_decode((string) file_get_contents(__DIR__ . '/fixtures/money-rules.json'), true, 512, JSON_THROW_ON_ERROR);
        $seen = [];
        foreach ($f['cases'] as $i => [$fn, $args, $want]) {
            $seen[$fn] = true;
            $ctx = "#{$i} {$fn}(" . json_encode($args, JSON_UNESCAPED_UNICODE) . ')';
            if (is_array($want) && array_key_exists('error', $want) && count($want) === 1) {
                $e = T::throws(static fn () => Money::$fn(...$args), Throwable::class, $ctx);
                T::eq($want['error'], $e->getMessage(), $ctx);
                continue;
            }
            T::eq($want, Money::$fn(...$args), $ctx);
        }
        foreach (['moneyRound', 'lineAmount', 'totalsByCurrency', 'prepayment', 'partyBalance', 'emptyAvg', 'applyReceipt', 'applyIssue', 'realisedProfit', 'profitSplit', 'splitByWeight', 'suggestedPricePerKg', 'crossCurrencySettlement'] as $fn) {
            T::true(isset($seen[$fn]), "no fixture for {$fn}");
        }
    },
];
