<?php
declare(strict_types=1);

use Vitral\Lib\Decimal;
use Vitral\Lib\Num;

return [
    'matches decimal.js for add/sub/mul/div/cmp/toFixed on fixtures' => function (): void {
        foreach (T::fixtures()['decimalOps'] as $r) {
            $a = Decimal::of($r['a']);
            $ctx = "a={$r['a']} b={$r['b']}";
            T::eq($r['a_fixed'], $a->toFixed(), "$ctx toFixed");
            T::eq($r['add'], $a->add($r['b'])->toFixed(), "$ctx add");
            T::eq($r['sub'], $a->sub($r['b'])->toFixed(), "$ctx sub");
            T::eq($r['mul'], $a->mul($r['b'])->toFixed(), "$ctx mul");
            if ($r['div'] !== null) T::eq($r['div'], $a->div($r['b'])->toFixed(), "$ctx div");
            T::eq($r['cmp'], $a->cmp($r['b']), "$ctx cmp");
            foreach ($r['fixed'] as $dp => $want) T::eq($want, $a->toFixed($dp), "$ctx toFixed($dp)");
        }
    },
    'round() per kind matches number.ts' => function (): void {
        foreach (T::fixtures()['rounds'] as $r) T::eq($r['r'], Num::round($r['v'], $r['k']), "round {$r['v']} {$r['k']}");
    },
    'percent() matches number.ts' => function (): void {
        foreach (T::fixtures()['percents'] as $r) T::eq($r['r'], Num::percent($r['part'], $r['whole']), "percent {$r['part']}/{$r['whole']}");
    },
    'parseNumber() matches number.ts' => function (): void {
        foreach (T::fixtures()['parsed'] as $r) T::eq($r['r'], Num::parseNumber($r['s']), "parse «{$r['s']}»");
    },
    'formatNumber() matches number.ts' => function (): void {
        foreach (T::fixtures()['formatted'] as $r) T::eq($r['r'], Num::formatNumber($r['v'], $r['k']), "format {$r['v']} {$r['k']}");
    },
    'half-up is away from zero, and money never becomes a float' => function (): void {
        T::eq('3', Decimal::of('2.5')->toFixed(0));
        T::eq('-3', Decimal::of('-2.5')->toFixed(0));
        T::eq('0.000', Num::round('-0.0004', 'weight'));
        T::eq('-0.000', Decimal::of('-0.0004')->toFixed(3));
        T::eq('0.3', Decimal::of('0.1')->add('0.2')->toFixed());
        T::eq('1.235', Decimal::of('1.2345')->toFixed(3));
        T::eq('"12.50"', json_encode(Decimal::of('12.5')->toDecimalPlaces(2)->toFixed(2)));
    },
    'division with a fixed scale' => function (): void {
        T::eq('0.33', Decimal::of('1')->div('3', 2)->toFixed());
        T::eq('0.67', Decimal::of('2')->div('3', 2)->toFixed());
        T::eq('-0.67', Decimal::of('-2')->div('3', 2)->toFixed());
        T::eq('333.333', Decimal::of('1000')->div('3', 3)->toFixed());
        T::eq('12500', Decimal::of('100000')->div('8', 0)->toFixed());
        T::eq('0.2', Decimal::of('1')->div('5', 3)->toFixed());
        T::throws(fn () => Decimal::of('1')->div('0'), DivisionByZeroError::class);
    },
    'parsing accepts exponents and rejects garbage' => function (): void {
        T::eq('1000', Decimal::of('1e3')->toFixed());
        T::eq('0.0015', Decimal::of('1.5e-3')->toFixed());
        T::eq('5', Decimal::of('+5')->toFixed());
        T::eq('0.5', Decimal::of('.5')->toFixed());
        T::throws(fn () => Decimal::of('1,5'), InvalidArgumentException::class);
        T::throws(fn () => Decimal::of(''), InvalidArgumentException::class);
        T::throws(fn () => Decimal::of('abc'), InvalidArgumentException::class);
    },
    'comparison helpers and sum' => function (): void {
        T::true(Decimal::of('1.10')->eq('1.1'));
        T::true(Decimal::of('-0')->eq('0'));
        T::true(Decimal::of('-1')->lt('0.5'));
        T::true(Decimal::of('10')->gt('9.999'));
        T::eq('6.6', Decimal::sum(['1.1', '2.2', null, '3.3'])->toFixed());
        T::eq('9.999', Decimal::max('1', '9.999', '-3')->toFixed());
        T::eq('-3', Decimal::min('1', '9.999', '-3')->toFixed());
    },
];
