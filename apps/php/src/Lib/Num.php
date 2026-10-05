<?php
declare(strict_types=1);

namespace Vitral\Lib;

/** Port of packages/shared/src/number.ts (R19 rounding, R20 parsing, Persian display). */
final class Num
{
    public const CURRENCIES = ['TOMAN', 'USD', 'IQD'];

    /** Precision kinds from R19. */
    public const PLACES = [
        'weight' => 3,
        'TOMAN' => 0,
        'USD' => 2,
        'IQD' => 2,
        'percent' => 1,
        'g_per_m' => 1,
        'filler' => 2,
        'length' => 2,
    ];

    /** Canonical decimal string accepted by the API (money and weight travel as strings). */
    public const DECIMAL_RE = '/^-?\d+(\.\d+)?$/';

    private const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
    private const ARABIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

    public static function dec(string|int|float|Decimal $value): Decimal
    {
        return Decimal::of($value);
    }

    /** R19: half-up rounding to the fixed number of places for the kind; canonical string. */
    public static function round(string|int|float|Decimal $value, string $kind): string
    {
        $p = self::places($kind);
        return Decimal::of($value)->toDecimalPlaces($p)->toFixed($p);
    }

    public static function places(string $kind): int
    {
        if (!isset(self::PLACES[$kind])) throw new \InvalidArgumentException("unknown round kind {$kind}");
        return self::PLACES[$kind];
    }

    /** R19: part / whole × 100 to 1 place; null when the denominator is zero or a side is unknown. */
    public static function percent(string|int|Decimal|null $part, string|int|Decimal|null $whole): ?string
    {
        if ($part === null || $whole === null) return null;
        $w = Decimal::of($whole);
        if ($w->isZero()) return null;
        return self::round(Decimal::of($part)->div($w)->mul(100), 'percent');
    }

    public static function toLatinDigits(string $input): string
    {
        return str_replace(self::ARABIC_DIGITS, range(0, 9), str_replace(self::PERSIAN_DIGITS, range(0, 9), $input));
    }

    public static function toPersianDigits(string $input): string
    {
        return str_replace(range(0, 9), self::PERSIAN_DIGITS, $input);
    }

    /** JavaScript String.prototype.trim(): strips Unicode white space and line terminators. */
    public static function jsTrim(string $s): string
    {
        return (string) preg_replace('/^[\s\p{Zs}\x{FEFF}\x{2028}\x{2029}]+|[\s\p{Zs}\x{FEFF}\x{2028}\x{2029}]+$/u', '', $s);
    }

    /**
     * R20: Persian, Arabic and Latin digits; «٬» and «,» thousands separators; «٫» or «.» decimal mark.
     * Canonical decimal string, or null when the input is not a number.
     */
    public static function parseNumber(string $input): ?string
    {
        $s = self::toLatinDigits(self::jsTrim($input));
        $s = (string) preg_replace('/[٬,\s\p{Zs}\x{FEFF}\x{2028}\x{2029}\x{200C}\x{200F}\x{200E}]/u', '', $s);
        $s = str_replace('٫', '.', $s);
        if (str_starts_with($s, '−')) $s = '-' . substr($s, strlen('−'));
        if (!preg_match('/^-?\d+(\.\d+)?$/', $s) && !preg_match('/^-?\.\d+$/', $s)) return null;
        return Decimal::of($s)->toFixed();
    }

    /** Persian digits, «٬» grouping and «٫» decimal mark, rounded per R19 when a kind is given. */
    public static function formatNumber(string|int|Decimal|null $value, ?string $kind = null): ?string
    {
        if ($value === null) return null;
        $fixed = $kind !== null ? self::round($value, $kind) : Decimal::of($value)->toFixed();
        $negative = str_starts_with($fixed, '-');
        $parts = explode('.', $negative ? substr($fixed, 1) : $fixed);
        $int = $parts[0] === '' ? '0' : $parts[0];
        $frac = $parts[1] ?? '';
        $grouped = (string) preg_replace('/\B(?=(\d{3})+(?!\d))/', '٬', $int);
        $body = $frac !== '' ? $grouped . '٫' . $frac : $grouped;
        return self::toPersianDigits(($negative ? '-' : '') . $body);
    }
}
