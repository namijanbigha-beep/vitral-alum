<?php
declare(strict_types=1);

namespace Vitral\Rules;

use Vitral\Lib\Decimal;
use Vitral\Lib\Num;

/**
 * Port of apps/server/src/rules/money.ts (R10–R16, R21, R24). Pure functions, no floats: every amount goes through
 * Decimal and comes back as a canonical string rounded per R19 (Num::round).
 * Currency maps (`Partial<Record<Currency, string>>` in TS) are plain PHP arrays keyed by currency code, in
 * insertion order; an empty map is `[]` — cast it with `(object)` before emitting it as JSON (`{}` in Node).
 */
final class Money
{
    public const BALANCE_DOC_KINDS = ['invoice', 'sales_return', 'purchase', 'toll_fee', 'expense', 'receipt', 'payment', 'barter', 'opening_balance', 'fx_difference'];

    public static function moneyRound(string|int|Decimal $v, string $currency): string
    {
        return Num::round($v, $currency);
    }

    /** R10 — line amount = basis qty × unit price − discount (amount, or percent of the gross). Null price → null. */
    public static function lineAmount(
        string|int|Decimal|null $qty,
        string|int|Decimal|null $unitPrice,
        string $currency,
        string|int|Decimal|null $discountAmount = 0,
        string|int|Decimal|null $discountPercent = 0,
    ): ?string {
        if ($qty === null || $unitPrice === null) return null;
        // TS default parameters apply only to `undefined`; a SQL NULL reaching here would make decimal.js throw.
        $gross = Decimal::of($qty)->mul($unitPrice);
        $disc = Decimal::of($discountAmount ?? throw new \InvalidArgumentException('discount amount is null'))
            ->add($gross->mul($discountPercent ?? throw new \InvalidArgumentException('discount percent is null'))->div(100));
        return self::moneyRound($gross->sub($disc), $currency);
    }

    /**
     * R10 — totals per currency; never mixed. Lines with null amount are skipped and flagged.
     * @param iterable<array{amount:?string,currency:string}> $lines
     * @return array{totals:array<string,string>,incomplete:bool}
     */
    public static function totalsByCurrency(iterable $lines): array
    {
        $acc = [];
        $incomplete = false;
        foreach ($lines as $l) {
            if ($l['amount'] === null) {
                $incomplete = true;
                continue;
            }
            $acc[$l['currency']] = ($acc[$l['currency']] ?? Decimal::zero())->add($l['amount']);
        }
        $totals = [];
        foreach ($acc as $c => $v) $totals[$c] = self::moneyRound($v, (string) $c);
        return ['totals' => $totals, 'incomplete' => $incomplete];
    }

    /**
     * R11 — requested prepayment = total × percent ÷ 100; printed remainder = total − posted receipts.
     * @return array{prepay:string,remaining:string}
     */
    public static function prepayment(string|int|Decimal $total, string|int|Decimal $percent, string|int|Decimal $paidPosted, string $currency): array
    {
        return [
            'prepay' => self::moneyRound(Decimal::of($total)->mul($percent)->div(100), $currency),
            'remaining' => self::moneyRound(Decimal::of($total)->sub($paidPosted), $currency),
        ];
    }

    /**
     * R12 — party balance per currency = opening + invoices − returns − posted receipts − (purchases + fees)
     * + posted payments ± barters. Positive = Vitral is owed. Only posted documents count.
     * Barter and fx_difference amounts are signed from Vitral's point of view.
     * @param iterable<array{kind:string,amount:string|int|Decimal,currency:string,status:string}> $docs
     * @return array<string,string>
     */
    public static function partyBalance(iterable $docs): array
    {
        $acc = [];
        foreach ($docs as $d) {
            if ($d['status'] !== 'posted') continue;
            $a = Decimal::of($d['amount']);
            switch ($d['kind']) {
                case 'opening_balance':
                case 'invoice':
                case 'payment':
                case 'barter':
                case 'fx_difference':
                    $delta = $a;
                    break;
                case 'sales_return':
                case 'receipt':
                case 'purchase':
                case 'toll_fee':
                case 'expense':
                    $delta = $a->neg();
                    break;
                default:
                    // TS: `delta` stays undefined and Decimal.plus(undefined) throws
                    throw new \InvalidArgumentException("unknown balance document kind {$d['kind']}");
            }
            $acc[$d['currency']] = ($acc[$d['currency']] ?? Decimal::zero())->add($delta);
        }
        $out = [];
        foreach ($acc as $c => $v) $out[$c] = self::moneyRound($v, (string) $c);
        return $out;
    }

    /**
     * R13 — moving weighted average state.
     * @return array{kg:string,value:?string,avg:?string,incomplete:bool}
     */
    public static function emptyAvg(): array
    {
        return ['kg' => '0.000', 'value' => '0', 'avg' => null, 'incomplete' => false];
    }

    /**
     * @param array{kg:string,value:?string,avg:?string,incomplete:bool} $state
     * @return array{kg:string,value:?string,avg:?string,incomplete:bool}
     */
    public static function applyReceipt(array $state, string|int|Decimal $kg, string|int|Decimal|null $unitCost, string $currency = 'TOMAN'): array
    {
        $newKg = Decimal::of($state['kg'])->add($kg);
        if ($unitCost === null || $state['value'] === null) {
            return ['kg' => Num::round($newKg, 'weight'), 'value' => null, 'avg' => null, 'incomplete' => true];
        }
        $value = Decimal::of($state['value'])->add(Decimal::of($kg)->mul($unitCost));
        return [
            'kg' => Num::round($newKg, 'weight'),
            'value' => $value->toFixed(),
            'avg' => $newKg->isZero() ? null : Num::round($value->div($newKg), $currency),
            'incomplete' => $state['incomplete'],
        ];
    }

    /**
     * @param array{kg:string,value:?string,avg:?string,incomplete:bool} $state
     * @return array{kg:string,value:?string,avg:?string,incomplete:bool,unit_cost:?string,cost:?string}
     */
    public static function applyIssue(array $state, string|int|Decimal $kg): array
    {
        $newKg = Decimal::of($state['kg'])->sub($kg);
        $avgExact = $state['value'] === null || Decimal::of($state['kg'])->isZero() ? null : Decimal::of($state['value'])->div($state['kg']);
        $value = $state['value'] === null || $avgExact === null ? null : Decimal::of($state['value'])->sub($avgExact->mul($kg))->toFixed();
        return [
            'kg' => Num::round($newKg, 'weight'),
            'value' => $value,
            'avg' => $state['avg'],
            'incomplete' => $state['incomplete'],
            'unit_cost' => $state['avg'],
            'cost' => $avgExact === null ? null : Num::round($avgExact->mul($kg), 'TOMAN'),
        ];
    }

    /**
     * R14 — realised order profit; on partial delivery the total cost is apportioned by raw weight dispatched ÷ total.
     * @return array{sales:string,cost:string,profit:string}|null
     */
    public static function realisedProfit(
        string|int|Decimal $salesAmount,
        string|int|Decimal|null $totalCost,
        string|int|Decimal $dispatchedRawKg,
        string|int|Decimal $totalRawKg,
        string $currency = 'TOMAN',
    ): ?array {
        if ($totalCost === null || Decimal::of($totalRawKg)->isZero()) return null;
        $share = Decimal::of($dispatchedRawKg)->div($totalRawKg);
        $cost = Decimal::of($totalCost)->mul($share);
        return [
            'sales' => self::moneyRound($salesAmount, $currency),
            'cost' => self::moneyRound($cost, $currency),
            'profit' => self::moneyRound(Decimal::of($salesAmount)->sub($cost), $currency),
        ];
    }

    /**
     * R15 — weight-gain share = gain kg of sold items × effective price per kg; base share = profit − gain share.
     * @return array{gain_share:string,base_share:string,total:string}
     */
    public static function profitSplit(string|int|Decimal $profit, string|int|Decimal $soldGainKg, string|int|Decimal $effectivePricePerKg, string $currency = 'TOMAN'): array
    {
        $gain = Decimal::of($soldGainKg)->mul($effectivePricePerKg);
        return [
            'gain_share' => self::moneyRound($gain, $currency),
            'base_share' => self::moneyRound(Decimal::of($profit)->sub($gain), $currency),
            'total' => self::moneyRound($profit, $currency),
        ];
    }

    /**
     * R16 — split a shared cost by weight; the rounding remainder goes to the largest share so the parts sum exactly.
     * Shares in input order. Throws \RangeException (TS RangeError) when the weights sum to zero.
     * @param list<string|int|Decimal> $weightsKg
     * @return list<string>
     */
    public static function splitByWeight(string|int|Decimal $total, array $weightsKg, string $currency = 'TOMAN'): array
    {
        $sum = Decimal::zero();
        foreach ($weightsKg as $w) $sum = $sum->add($w);
        if (!$weightsKg) return [];
        if ($sum->isZero()) throw new \RangeException('جمع وزن صفر است؛ تقسیم ممکن نیست');
        $totalD = Decimal::of($total);
        $shares = [];
        foreach (array_values($weightsKg) as $w) $shares[] = Decimal::of(self::moneyRound($totalD->mul($w)->div($sum), $currency));
        $allocated = Decimal::sum($shares);
        $remainder = $totalD->sub($allocated);
        if (!$remainder->isZero()) {
            $maxIdx = 0;
            foreach ($shares as $i => $s) if ($s->gt($shares[$maxIdx])) $maxIdx = $i;
            $shares[$maxIdx] = $shares[$maxIdx]->add($remainder);
        }
        return array_map(static fn (Decimal $s) => self::moneyRound($s, $currency), $shares);
    }

    /** R21 — suggested price per kg = estimated total cost ÷ raw kg × (1 + markup on cost %). */
    public static function suggestedPricePerKg(string|int|Decimal|null $estimatedCost, string|int|Decimal $rawKg, string|int|Decimal $markupPercent, string $currency = 'TOMAN'): ?string
    {
        if ($estimatedCost === null || Decimal::of($rawKg)->isZero()) return null;
        return self::moneyRound(Decimal::of($estimatedCost)->div($rawKg)->mul(Decimal::of(1)->add(Decimal::of($markupPercent)->div(100))), $currency);
    }

    /**
     * R24 — cross-currency settlement: settled debt = payment amount × agreed rate (rate = units of $rateTo for one
     * unit of $rateFrom). Throws \RangeException when the rate direction fits neither currency pair.
     */
    public static function crossCurrencySettlement(
        string|int|Decimal $paymentAmount,
        string $paymentCurrency,
        string $debtCurrency,
        string|int|Decimal $rate,
        string $rateFrom,
        string $rateTo,
    ): string {
        if ($rateFrom === $debtCurrency && $rateTo === $paymentCurrency) {
            return self::moneyRound(Decimal::of($paymentAmount)->div($rate), $debtCurrency);
        }
        if ($rateFrom === $paymentCurrency && $rateTo === $debtCurrency) {
            return self::moneyRound(Decimal::of($paymentAmount)->mul($rate), $debtCurrency);
        }
        throw new \RangeException('جهت نرخ با ارز پرداخت و بدهی نمی‌خواند');
    }
}
