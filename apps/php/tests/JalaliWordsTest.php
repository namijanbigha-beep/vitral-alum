<?php
declare(strict_types=1);

use Vitral\Lib\Jalali;
use Vitral\Lib\Words;

return [
    'toJalali / toGregorian match jalali.ts' => function (): void {
        foreach (T::fixtures()['jalali'] as $r) {
            [$gy, $gm, $gd] = $r['g'];
            T::eq($r['j'], array_values(Jalali::toJalali($gy, $gm, $gd)), "g " . implode('-', $r['g']));
            T::eq($r['back'], array_values(Jalali::toGregorian(...$r['j'])), "j " . implode('/', $r['j']));
        }
    },
    'leap years match' => function (): void {
        foreach (T::fixtures()['leaps'] as $r) T::eq($r['leap'], Jalali::isLeapYear($r['y']), "leap {$r['y']}");
    },
    'parse matches parseJalali' => function (): void {
        foreach (T::fixtures()['parseJ'] as $r) {
            $p = Jalali::parse($r['s']);
            T::eq($r['r'], $p === null ? null : Jalali::format($p), "parse «{$r['s']}»");
        }
    },
    'jalaliOf an instant in Tehran and UTC' => function (): void {
        foreach (T::fixtures()['instants'] as $r) {
            T::eq($r['j'], Jalali::format(Jalali::of($r['at'])), "at {$r['at']}");
            T::eq($r['utc'], Jalali::format(Jalali::of($r['at'], 'UTC')), "utc {$r['at']}");
        }
    },
    'invalid dates throw' => function (): void {
        T::throws(fn () => Jalali::toGregorian(1405, 13, 1), RangeException::class);
        T::eq(null, Jalali::parse('1404/12/30') === null ? null : 'x', '1404 is not leap');
    },
    'day range is Tehran midnight in UTC' => function (): void {
        T::eq(['start' => '2026-10-01T20:30:00.000Z', 'end' => '2026-10-02T20:30:00.000Z'], Jalali::dayRange(['jy' => 1405, 'jm' => 7, 'jd' => 10]));
    },
    'Persian and Arabic words match words.ts' => function (): void {
        foreach (T::fixtures()['words'] as $r) {
            T::eq($r['fa'], Words::numberToPersian($r['n']), "fa {$r['n']}");
            T::eq($r['ar'], Words::numberToArabic($r['n']), "ar {$r['n']}");
            T::eq($r['faUsd'], Words::amountToPersian($r['n'], 'USD'), "faUsd {$r['n']}");
            T::eq($r['arIqd'], Words::amountToArabic($r['n'], 'IQD'), "arIqd {$r['n']}");
            T::eq($r['faToman'], Words::amountToPersian($r['n']), "faToman {$r['n']}");
        }
    },
    'words refuse negatives, fractions and > 999 trillion' => function (): void {
        T::throws(fn () => Words::numberToPersian('-1'), RangeException::class);
        T::throws(fn () => Words::numberToPersian('1.5'), RangeException::class);
        T::throws(fn () => Words::numberToPersian('1000000000000000'), RangeException::class);
    },
];
