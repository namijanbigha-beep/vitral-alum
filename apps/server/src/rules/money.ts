import { Dec, round, type Currency, type DecimalInput } from '@vitral/shared';

export const moneyRound = (v: DecimalInput, currency: Currency): string => round(v, currency);

/** R10 — line amount = basis qty × unit price − discount (amount, or percent of the gross). Null price → null. */
export function lineAmount(
  qty: DecimalInput | null,
  unitPrice: DecimalInput | null,
  currency: Currency,
  discountAmount: DecimalInput = 0,
  discountPercent: DecimalInput = 0,
): string | null {
  if (qty === null || unitPrice === null) return null;
  const gross = new Dec(qty).mul(unitPrice);
  const disc = new Dec(discountAmount).plus(gross.mul(discountPercent).div(100));
  return moneyRound(gross.minus(disc), currency);
}

/** R10 — totals per currency; never mixed. Lines with null amount are skipped and flagged. */
export function totalsByCurrency(lines: Array<{ amount: string | null; currency: Currency }>): {
  totals: Partial<Record<Currency, string>>;
  incomplete: boolean;
} {
  const acc: Partial<Record<Currency, Dec>> = {};
  let incomplete = false;
  for (const l of lines) {
    if (l.amount === null) {
      incomplete = true;
      continue;
    }
    acc[l.currency] = (acc[l.currency] ?? new Dec(0)).plus(l.amount);
  }
  const totals: Partial<Record<Currency, string>> = {};
  for (const [c, v] of Object.entries(acc) as Array<[Currency, Dec]>) totals[c] = moneyRound(v, c);
  return { totals, incomplete };
}

/** R11 — requested prepayment = total × percent ÷ 100; printed remainder = total − posted receipts. */
export function prepayment(
  total: DecimalInput,
  percent: DecimalInput,
  paidPosted: DecimalInput,
  currency: Currency,
): { prepay: string; remaining: string } {
  return {
    prepay: moneyRound(new Dec(total).mul(percent).div(100), currency),
    remaining: moneyRound(new Dec(total).minus(paidPosted), currency),
  };
}

export type BalanceDocKind =
  | 'invoice'
  | 'sales_return'
  | 'purchase'
  | 'toll_fee'
  | 'expense'
  | 'receipt'
  | 'payment'
  | 'barter'
  | 'opening_balance'
  | 'fx_difference';

/**
 * R12 — party balance per currency = opening + invoices − returns − posted receipts − (purchases + fees)
 * + posted payments ± barters. Positive = Vitral is owed. Only posted documents count (caller filters).
 * Barter and fx_difference amounts are signed from Vitral's point of view (positive increases what the party owes).
 */
export function partyBalance(
  docs: Array<{ kind: BalanceDocKind; amount: DecimalInput; currency: Currency; status: string; party_expense?: boolean }>,
): Partial<Record<Currency, string>> {
  const acc: Partial<Record<Currency, Dec>> = {};
  for (const d of docs) {
    if (d.status !== 'posted') continue;
    const a = new Dec(d.amount);
    let delta: Dec;
    switch (d.kind) {
      case 'opening_balance':
      case 'invoice':
      case 'payment':
      case 'barter':
      case 'fx_difference':
        delta = a;
        break;
      case 'sales_return':
      case 'receipt':
      case 'purchase':
      case 'toll_fee':
      case 'expense':
        delta = a.neg();
        break;
    }
    acc[d.currency] = (acc[d.currency] ?? new Dec(0)).plus(delta);
  }
  const out: Partial<Record<Currency, string>> = {};
  for (const [c, v] of Object.entries(acc) as Array<[Currency, Dec]>) out[c] = moneyRound(v, c);
  return out;
}

/**
 * R13 — moving weighted average per (owner, kind, alloy) group. Receipts with a null unit cost leave the
 * average «incomplete» (cost unknown is not zero). Issues leave the average unchanged.
 */
export interface AvgState {
  kg: string;
  value: string | null;
  avg: string | null;
  incomplete: boolean;
}
export const emptyAvg = (): AvgState => ({ kg: '0.000', value: '0', avg: null, incomplete: false });

export function applyReceipt(state: AvgState, kg: DecimalInput, unitCost: DecimalInput | null, currency: Currency = 'TOMAN'): AvgState {
  const newKg = new Dec(state.kg).plus(kg);
  if (unitCost === null || state.value === null) {
    return { kg: round(newKg, 'weight'), value: null, avg: null, incomplete: true };
  }
  const value = new Dec(state.value).plus(new Dec(kg).mul(unitCost));
  return {
    kg: round(newKg, 'weight'),
    value: value.toFixed(),
    avg: newKg.isZero() ? null : round(value.div(newKg), currency),
    incomplete: state.incomplete,
  };
}

export function applyIssue(state: AvgState, kg: DecimalInput): AvgState & { unit_cost: string | null; cost: string | null } {
  const newKg = new Dec(state.kg).minus(kg);
  const avgExact = state.value === null || new Dec(state.kg).isZero() ? null : new Dec(state.value).div(state.kg);
  const value = state.value === null || avgExact === null ? null : new Dec(state.value).minus(avgExact.mul(kg)).toFixed();
  return {
    kg: round(newKg, 'weight'),
    value,
    avg: state.avg,
    incomplete: state.incomplete,
    unit_cost: state.avg,
    cost: avgExact === null ? null : round(avgExact.mul(kg), 'TOMAN'),
  };
}

/**
 * R14 — realised order profit = sales of dispatched items − cost of the same items. On partial delivery the total
 * cost is apportioned by raw weight dispatched ÷ total raw weight.
 */
export function realisedProfit(
  salesAmount: DecimalInput,
  totalCost: DecimalInput | null,
  dispatchedRawKg: DecimalInput,
  totalRawKg: DecimalInput,
  currency: Currency = 'TOMAN',
): { sales: string; cost: string; profit: string } | null {
  if (totalCost === null || new Dec(totalRawKg).isZero()) return null;
  const share = new Dec(dispatchedRawKg).div(totalRawKg);
  const cost = new Dec(totalCost).mul(share);
  return { sales: moneyRound(salesAmount, currency), cost: moneyRound(cost, currency), profit: moneyRound(new Dec(salesAmount).minus(cost), currency) };
}

/**
 * R15 — weight-gain share = gain kg of sold items × effective price per kg (after discount);
 * base share = profit − gain share. The gain share is never added to profit again.
 */
export function profitSplit(
  profit: DecimalInput,
  soldGainKg: DecimalInput,
  effectivePricePerKg: DecimalInput,
  currency: Currency = 'TOMAN',
): { gain_share: string; base_share: string; total: string } {
  const gain = new Dec(soldGainKg).mul(effectivePricePerKg);
  return { gain_share: moneyRound(gain, currency), base_share: moneyRound(new Dec(profit).minus(gain), currency), total: moneyRound(profit, currency) };
}

/**
 * R16 — split a shared cost by weight; rounding remainder goes to the largest share so the parts sum exactly.
 * Returns shares in input order.
 */
export function splitByWeight(total: DecimalInput, weightsKg: DecimalInput[], currency: Currency = 'TOMAN'): string[] {
  const sum = weightsKg.reduce((a: Dec, w) => a.plus(w), new Dec(0));
  if (weightsKg.length === 0) return [];
  if (sum.isZero()) throw new RangeError('جمع وزن صفر است؛ تقسیم ممکن نیست');
  const totalD = new Dec(total);
  const shares = weightsKg.map((w) => new Dec(moneyRound(totalD.mul(w).div(sum), currency)));
  const allocated = shares.reduce((a: Dec, s) => a.plus(s), new Dec(0));
  const remainder = totalD.minus(allocated);
  if (!remainder.isZero()) {
    let maxIdx = 0;
    shares.forEach((s, i) => {
      if (s.gt(shares[maxIdx] as Dec)) maxIdx = i;
    });
    shares[maxIdx] = (shares[maxIdx] as Dec).plus(remainder);
  }
  return shares.map((s) => moneyRound(s, currency));
}

/** R21 — suggested price per kg = estimated total cost ÷ raw kg × (1 + markup on cost %). */
export function suggestedPricePerKg(
  estimatedCost: DecimalInput | null,
  rawKg: DecimalInput,
  markupPercent: DecimalInput,
  currency: Currency = 'TOMAN',
): string | null {
  if (estimatedCost === null || new Dec(rawKg).isZero()) return null;
  return moneyRound(new Dec(estimatedCost).div(rawKg).mul(new Dec(1).plus(new Dec(markupPercent).div(100))), currency);
}

/** R24 — cross-currency settlement: settled debt = payment amount × agreed rate (in the recorded direction). */
export function crossCurrencySettlement(
  paymentAmount: DecimalInput,
  paymentCurrency: Currency,
  debtCurrency: Currency,
  rate: DecimalInput,
  rateFrom: Currency,
  rateTo: Currency,
): string {
  // rate = units of `rateTo` for one unit of `rateFrom`
  if (rateFrom === debtCurrency && rateTo === paymentCurrency) {
    return moneyRound(new Dec(paymentAmount).div(rate), debtCurrency);
  }
  if (rateFrom === paymentCurrency && rateTo === debtCurrency) {
    return moneyRound(new Dec(paymentAmount).mul(rate), debtCurrency);
  }
  throw new RangeError('جهت نرخ با ارز پرداخت و بدهی نمی‌خواند');
}
