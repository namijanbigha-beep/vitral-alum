<?php
declare(strict_types=1);

namespace Vitral\Core;

use Vitral\Lib\Jalali;

/**
 * Port of apps/server/src/lib/numbering.ts (principle 11): gap-free document numbers inside the caller's transaction.
 * Tokens: {seq} / {seq:N}, {yy}, {yyyy}, {mm}, {dd}, {yymmdd} — Jalali dates in the business time zone.
 * The counter row is upserted (INSERT … ON DUPLICATE KEY UPDATE), which row-locks it until commit,
 * so a rolled-back transaction leaves no gap.
 */
final class Numbering
{
    /** Kinds stored in the single `documents` table, whose `number` is unique across kinds. */
    private const FINANCIAL_DOCUMENT_KINDS = ['invoice', 'sales_return', 'purchase', 'toll_fee', 'expense', 'receipt', 'payment', 'barter', 'opening_balance', 'fx_difference'];

    public static function renderPattern(string $pattern, int $seq, \DateTimeInterface|string $at, string $timeZone): string
    {
        $j = Jalali::of($at, $timeZone);
        $p2 = static fn (int $n) => str_pad((string) $n, 2, '0', STR_PAD_LEFT);
        $yy = $p2($j['jy'] % 100);
        $out = (string) preg_replace_callback('/\{seq(?::(\d+))?\}/', static fn ($m) => str_pad((string) $seq, isset($m[1]) && $m[1] !== '' ? (int) $m[1] : 1, '0', STR_PAD_LEFT), $pattern);
        $out = str_replace('{yymmdd}', $yy . $p2($j['jm']) . $p2($j['jd']), $out);
        $out = str_replace('{yyyy}', (string) $j['jy'], $out);
        $out = str_replace('{yy}', $yy, $out);
        $out = str_replace('{mm}', $p2($j['jm']), $out);
        return str_replace('{dd}', $p2($j['jd']), $out);
    }

    public static function counterPeriod(string $pattern, \DateTimeInterface|string $at, string $timeZone): int
    {
        $j = Jalali::of($at, $timeZone);
        if (preg_match('/\{(yymmdd|dd)\}/', $pattern)) return $j['jy'] * 10000 + $j['jm'] * 100 + $j['jd'];
        if (preg_match('/\{(yy|yyyy)\}/', $pattern)) return $j['jy'];
        return 0;
    }

    public static function next(Db $trx, string $kind, \DateTimeInterface|string|null $at = null): string
    {
        $at ??= new \DateTimeImmutable('now');
        $patterns = Json::toArray(Settings::get($trx, 'numbering_patterns'));
        $pattern = $patterns[$kind] ?? (Settings::get($trx, 'default_numbering_pattern') ?? 'VT-{seq:4}');
        $timeZone = Settings::get($trx, 'time_zone') ?? 'Asia/Tehran';
        $period = self::counterPeriod($pattern, $at, $timeZone);
        // Financial documents without a pattern of their own share one counter (one table, one unique number column).
        $counterKind = !isset($patterns[$kind]) && in_array($kind, self::FINANCIAL_DOCUMENT_KINDS, true) ? 'document' : $kind;
        $trx->exec(
            'INSERT INTO counters (id, kind, year, `last_value`) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE `last_value` = `last_value` + 1',
            [Db::uuid(), $counterKind, $period],
        );
        $seq = (int) $trx->value('SELECT `last_value` FROM counters WHERE kind = ? AND year = ?', [$counterKind, $period]);
        return self::renderPattern($pattern, $seq, $at, $timeZone);
    }
}
