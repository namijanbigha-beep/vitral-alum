<?php
declare(strict_types=1);

namespace Vitral\Lib;

/**
 * R25: amount in words, Persian and Arabic, integers up to 999 trillion — port of packages/shared/src/words.ts.
 * Fits in a 64-bit PHP int, so no big-number library is needed.
 */
final class Words
{
    private const FA_ONES = ['', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'];
    private const FA_TEENS = ['ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هجده', 'نوزده'];
    private const FA_TENS = ['', '', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود'];
    private const FA_HUNDREDS = ['', 'صد', 'دویست', 'سیصد', 'چهارصد', 'پانصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد'];
    private const FA_SCALES = ['', 'هزار', 'میلیون', 'میلیارد', 'تریلیون'];
    private const FA_CURRENCY = ['TOMAN' => 'تومان', 'USD' => 'دلار', 'IQD' => 'دینار'];
    private const AR_CURRENCY = ['TOMAN' => 'تومان', 'USD' => 'دولار', 'IQD' => 'دينار'];

    private const AR_ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'];
    private const AR_TEENS = ['عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
    private const AR_TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
    private const AR_HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];
    /** [singular, dual, plural (3–10)] */
    private const AR_SCALES = [['', '', ''], ['ألف', 'ألفان', 'آلاف'], ['مليون', 'مليونان', 'ملايين'], ['مليار', 'ملياران', 'مليارات'], ['تريليون', 'تريليونان', 'تريليونات']];

    private const MAX = 999_999_999_999_999;

    private static function toInt(string|int $value): int
    {
        $s = Num::jsTrim((string) $value);
        if (!preg_match('/^\d+(\.0+)?$/', $s)) throw new \RangeException('مبلغ به حروف فقط برای عدد صحیح نامنفی است');
        $int = ltrim(explode('.', $s)[0], '0');
        if ($int === '') return 0;
        if (strlen($int) > 15) throw new \RangeException('مبلغ بیش از حد مجاز برای حروف');
        $n = (int) $int;
        if ($n > self::MAX) throw new \RangeException('مبلغ بیش از حد مجاز برای حروف');
        return $n;
    }

    /** @return int[] groups of three digits, least significant first */
    private static function groups(int $n): array
    {
        $out = [];
        while ($n > 0) {
            $out[] = $n % 1000;
            $n = intdiv($n, 1000);
        }
        return $out;
    }

    private static function faUnder1000(int $n): string
    {
        $parts = [];
        $h = intdiv($n, 100);
        $rest = $n % 100;
        if ($h) $parts[] = self::FA_HUNDREDS[$h];
        if ($rest >= 10 && $rest < 20) {
            $parts[] = self::FA_TEENS[$rest - 10];
        } else {
            $t = intdiv($rest, 10);
            $o = $rest % 10;
            if ($t) $parts[] = self::FA_TENS[$t];
            if ($o) $parts[] = self::FA_ONES[$o];
        }
        return implode(' و ', $parts);
    }

    public static function numberToPersian(string|int $value): string
    {
        $n = self::toInt($value);
        if ($n === 0) return 'صفر';
        $g = self::groups($n);
        $parts = [];
        for ($i = count($g) - 1; $i >= 0; $i--) {
            $v = $g[$i];
            if (!$v) continue;
            $words = self::faUnder1000($v);
            $parts[] = $i === 0 ? $words : $words . ' ' . self::FA_SCALES[$i];
        }
        return implode(' و ', $parts);
    }

    public static function amountToPersian(string|int $value, string $currency = 'TOMAN'): string
    {
        return self::numberToPersian($value) . ' ' . self::FA_CURRENCY[$currency];
    }

    private static function arUnder1000(int $n): string
    {
        $parts = [];
        $h = intdiv($n, 100);
        $rest = $n % 100;
        if ($h) $parts[] = self::AR_HUNDREDS[$h];
        if ($rest >= 10 && $rest < 20) {
            $parts[] = self::AR_TEENS[$rest - 10];
        } else {
            $t = intdiv($rest, 10);
            $o = $rest % 10;
            // Arabic reads units before tens: «خمسة وعشرون»
            if ($o) $parts[] = self::AR_ONES[$o];
            if ($t) $parts[] = self::AR_TENS[$t];
        }
        return implode(' و ', $parts);
    }

    public static function numberToArabic(string|int $value): string
    {
        $n = self::toInt($value);
        if ($n === 0) return 'صفر';
        $g = self::groups($n);
        $parts = [];
        for ($i = count($g) - 1; $i >= 0; $i--) {
            $v = $g[$i];
            if (!$v) continue;
            if ($i === 0) {
                $parts[] = self::arUnder1000($v);
                continue;
            }
            [$one, $two, $many] = self::AR_SCALES[$i];
            if ($v === 1) $parts[] = $one;
            elseif ($v === 2) $parts[] = $two;
            elseif ($v <= 10) $parts[] = self::arUnder1000($v) . ' ' . $many;
            else $parts[] = self::arUnder1000($v) . ' ' . $one;
        }
        return implode(' و ', $parts);
    }

    public static function amountToArabic(string|int $value, string $currency = 'TOMAN'): string
    {
        return self::numberToArabic($value) . ' ' . self::AR_CURRENCY[$currency];
    }
}
