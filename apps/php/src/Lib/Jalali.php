<?php
declare(strict_types=1);

namespace Vitral\Lib;

/**
 * R26: Gregorian ↔ Jalali conversion — port of packages/shared/src/jalali.ts (jalaali-js break-year algorithm).
 * Dates are arrays ['jy'=>, 'jm'=>, 'jd'=>] / ['gy'=>, 'gm'=>, 'gd'=>] like the TS objects.
 */
final class Jalali
{
    private const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

    public const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

    // JS Math.trunc division and remainder: PHP intdiv and % have the same truncating semantics.
    private static function div(int $a, int $b): int { return intdiv($a, $b); }
    private static function mod(int $a, int $b): int { return $a - intdiv($a, $b) * $b; }

    /** @return array{leap:int,gy:int,march:int} */
    private static function jalCal(int $jy): array
    {
        $bl = count(self::BREAKS);
        $gy = $jy + 621;
        $leapJ = -14;
        $jp = self::BREAKS[0];
        $jump = 0;
        if ($jy < $jp || $jy >= self::BREAKS[$bl - 1]) throw new \RangeException("Invalid Jalali year {$jy}");
        for ($i = 1; $i < $bl; $i++) {
            $jm = self::BREAKS[$i];
            $jump = $jm - $jp;
            if ($jy < $jm) break;
            $leapJ = $leapJ + self::div($jump, 33) * 8 + self::div(self::mod($jump, 33), 4);
            $jp = $jm;
        }
        $n = $jy - $jp;
        $leapJ = $leapJ + self::div($n, 33) * 8 + self::div(self::mod($n, 33) + 3, 4);
        if (self::mod($jump, 33) === 4 && $jump - $n === 4) $leapJ += 1;
        $leapG = self::div($gy, 4) - self::div((self::div($gy, 100) + 1) * 3, 4) - 150;
        $march = 20 + $leapJ - $leapG;
        if ($jump - $n < 6) $n = $n - $jump + self::div($jump + 4, 33) * 33;
        $leap = self::mod(self::mod($n + 1, 33) - 1, 4);
        if ($leap === -1) $leap = 4;
        return ['leap' => $leap, 'gy' => $gy, 'march' => $march];
    }

    private static function g2d(int $gy, int $gm, int $gd): int
    {
        $d = self::div(($gy + self::div($gm - 8, 6) + 100100) * 1461, 4) + self::div(153 * self::mod($gm + 9, 12) + 2, 5) + $gd - 34840408;
        return $d - self::div(self::div($gy + 100100 + self::div($gm - 8, 6), 100) * 3, 4) + 752;
    }

    /** @return array{gy:int,gm:int,gd:int} */
    private static function d2g(int $jdn): array
    {
        $j = 4 * $jdn + 139361631;
        $j = $j + self::div(self::div(4 * $jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
        $i = self::div(self::mod($j, 1461), 4) * 5 + 308;
        $gd = self::div(self::mod($i, 153), 5) + 1;
        $gm = self::mod(self::div($i, 153), 12) + 1;
        $gy = self::div($j, 1461) - 100100 + self::div(8 - $gm, 6);
        return ['gy' => $gy, 'gm' => $gm, 'gd' => $gd];
    }

    private static function j2d(int $jy, int $jm, int $jd): int
    {
        $r = self::jalCal($jy);
        return self::g2d($r['gy'], 3, $r['march']) + ($jm - 1) * 31 - self::div($jm, 7) * ($jm - 7) + $jd - 1;
    }

    /** @return array{jy:int,jm:int,jd:int} */
    private static function d2j(int $jdn): array
    {
        $gy = self::d2g($jdn)['gy'];
        $jy = $gy - 621;
        $r = self::jalCal($jy);
        $jdn1f = self::g2d($gy, 3, $r['march']);
        $k = $jdn - $jdn1f;
        if ($k >= 0) {
            if ($k <= 185) return ['jy' => $jy, 'jm' => 1 + self::div($k, 31), 'jd' => self::mod($k, 31) + 1];
            $k -= 186;
        } else {
            $jy -= 1;
            $k += 179;
            if ($r['leap'] === 1) $k += 1;
        }
        return ['jy' => $jy, 'jm' => 7 + self::div($k, 30), 'jd' => self::mod($k, 30) + 1];
    }

    public static function isLeapYear(int $jy): bool
    {
        return self::jalCal($jy)['leap'] === 0;
    }

    public static function monthLength(int $jy, int $jm): int
    {
        if ($jm <= 6) return 31;
        if ($jm <= 11) return 30;
        return self::isLeapYear($jy) ? 30 : 29;
    }

    public static function isValid(int $jy, int $jm, int $jd): bool
    {
        if ($jy < -60 || $jy > 3177 || $jm < 1 || $jm > 12 || $jd < 1) return false;
        return $jd <= self::monthLength($jy, $jm);
    }

    /** @return array{gy:int,gm:int,gd:int} */
    public static function toGregorian(int $jy, int $jm, int $jd): array
    {
        if (!self::isValid($jy, $jm, $jd)) throw new \RangeException('تاریخ شمسی نامعتبر است');
        return self::d2g(self::j2d($jy, $jm, $jd));
    }

    /** @return array{jy:int,jm:int,jd:int} */
    public static function toJalali(int $gy, int $gm, int $gd): array
    {
        return self::d2j(self::g2d($gy, $gm, $gd));
    }

    /** Parse «۱۴۰۵/۰۶/۲۳» or «14050623» (any digit script). @return array{jy:int,jm:int,jd:int}|null */
    public static function parse(string $input): ?array
    {
        $latin = Num::toLatinDigits(Num::jsTrim($input));
        if (!preg_match('/^(\d{4})[\/\-.]?(\d{1,2})[\/\-.]?(\d{1,2})$/', $latin, $m)) return null;
        [$jy, $jm, $jd] = [(int) $m[1], (int) $m[2], (int) $m[3]];
        return self::isValid($jy, $jm, $jd) ? ['jy' => $jy, 'jm' => $jm, 'jd' => $jd] : null;
    }

    /** @param array{jy:int,jm:int,jd:int} $d */
    public static function format(array $d): string
    {
        return sprintf('%04d/%02d/%02d', $d['jy'], $d['jm'], $d['jd']);
    }

    /**
     * Calendar parts of an instant in an IANA zone (default Asia/Tehran).
     * @return array{gy:int,gm:int,gd:int,hour:int,minute:int}
     */
    public static function zonedParts(\DateTimeInterface|string $at, string $timeZone = 'Asia/Tehran'): array
    {
        $dt = $at instanceof \DateTimeInterface ? \DateTimeImmutable::createFromInterface($at) : new \DateTimeImmutable($at);
        $dt = $dt->setTimezone(new \DateTimeZone($timeZone));
        return [
            'gy' => (int) $dt->format('Y'),
            'gm' => (int) $dt->format('n'),
            'gd' => (int) $dt->format('j'),
            'hour' => (int) $dt->format('G'),
            'minute' => (int) $dt->format('i'),
        ];
    }

    /** Jalali date of an instant in the business time zone. @return array{jy:int,jm:int,jd:int} */
    public static function of(\DateTimeInterface|string|null $at = null, string $timeZone = 'Asia/Tehran'): array
    {
        $p = self::zonedParts($at ?? new \DateTimeImmutable('now', new \DateTimeZone('UTC')), $timeZone);
        return self::toJalali($p['gy'], $p['gm'], $p['gd']);
    }

    /** Tehran has had no DST since 2022: a fixed +03:30 (apps/server/src/lib/dates.ts). */
    public const TEHRAN_OFFSET_SECONDS = 12600;

    /**
     * [start, end) UTC instants of a Jalali business day, as ISO strings with milliseconds.
     * @param array{jy:int,jm:int,jd:int} $d
     * @return array{start:string,end:string}
     */
    public static function dayRange(array $d): array
    {
        $g = self::toGregorian($d['jy'], $d['jm'], $d['jd']);
        $start = gmmktime(0, 0, 0, $g['gm'], $g['gd'], $g['gy']) - self::TEHRAN_OFFSET_SECONDS;
        return ['start' => gmdate('Y-m-d\TH:i:s.000\Z', $start), 'end' => gmdate('Y-m-d\TH:i:s.000\Z', $start + 86400)];
    }
}
