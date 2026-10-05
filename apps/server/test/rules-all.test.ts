import { describe, expect, it } from 'vitest';
import {
  applyIssue,
  applyReceipt,
  barsFromPackages,
  bundleReportTotals,
  bundleWeightOutlier,
  bundleWeightPerMeter,
  coatingFee,
  crossCurrencySettlement,
  emptyAvg,
  lineAmount,
  partyBalance,
  prepayment,
  productionFee,
  profitSplit,
  realisedProfit,
  runBalance,
  scaleNet,
  splitByWeight,
  suggestedPricePerKg,
  totalsByCurrency,
  weightGain,
} from '../src/rules/index.js';

describe('T04 — R03', () => {
  it('394 kg, 70 bars, 6 m → 938.1 g/m; vs 950 → −1.3 %', () => {
    expect(bundleWeightPerMeter('394', null, '70', '6', '950')).toEqual({ g_per_m: '938.1', diff_percent: '-1.3' });
  });
});
describe('T05 — R04', () => {
  it('15 × 14 = 210', () => expect(barsFromPackages(15, 14)).toBe(210));
});
describe('T06 — R05', () => {
  it('1,000 kg × 80,000 = 80,000,000 regardless of 1,050 output', () => expect(coatingFee('1000', '80000')).toBe('80000000'));
});
describe('T07 — R06', () => {
  it('1,000 → 1,050: 50 kg, 5.0 %', () => expect(weightGain('1000', '1050')).toEqual({ gain_kg: '50.000', percent: '5.0' }));
  it('not returned → null', () => expect(weightGain('1000', null)).toBeNull());
});
describe('T08 — R07', () => {
  it('null rate → null fee', () => expect(productionFee(null, '1000', null)).toBeNull());
  it('rate × basis + fixed', () => expect(productionFee('15000', '950', '500000')).toBe('14750000'));
});
describe('T09, T10 — R08', () => {
  it('T09: 5 kg (0.5 %), yield 95.0 %, no reason needed', () => {
    expect(runBalance('1000', '950', '20', '25', '0')).toEqual({ unexplained_kg: '5.000', unexplained_percent: '0.5', yield_percent: '95.0', needs_reason: false });
  });
  it('T10: 35 kg (3.5 %) needs a reason', () => {
    expect(runBalance('1000', '920', '20', '25', '0')).toMatchObject({ unexplained_kg: '35.000', unexplained_percent: '3.5', needs_reason: true });
  });
});
describe('T11 — R09', () => {
  it('15,000 − 14,000 − 20 = 980; without packaging 1,000 gross', () => {
    expect(scaleNet('15000', '14000', '20')).toEqual({ kg: '980.000', gross_only: false });
    expect(scaleNet('15000', '14000', null)).toEqual({ kg: '1000.000', gross_only: true });
  });
});
describe('T12, T14 — R10', () => {
  it('977.795 × 850,000 = 831,125,750; + 80,000,000 = 911,125,750', () => {
    const a = lineAmount('977.795', '850000', 'TOMAN');
    const b = lineAmount('1', '80000000', 'TOMAN');
    expect(a).toBe('831125750');
    expect(totalsByCurrency([{ amount: a, currency: 'TOMAN' }, { amount: b, currency: 'TOMAN' }])).toEqual({ totals: { TOMAN: '911125750' }, incomplete: false });
  });
  it('T14: 100/150/100/150 × 750,000', () => {
    const lines = ['100', '150', '100', '150'].map((q) => ({ amount: lineAmount(q, '750000', 'TOMAN'), currency: 'TOMAN' as const }));
    expect(lines.map((l) => l.amount)).toEqual(['75000000', '112500000', '75000000', '112500000']);
    expect(totalsByCurrency(lines).totals).toEqual({ TOMAN: '375000000' });
    expect(prepayment('375000000', '80', '0', 'TOMAN').prepay).toBe('300000000');
  });
  it('currencies are never mixed; a null price marks the total incomplete', () => {
    const r = totalsByCurrency([{ amount: '10', currency: 'USD' }, { amount: '5', currency: 'TOMAN' }, { amount: null, currency: 'USD' }]);
    expect(r).toEqual({ totals: { USD: '10.00', TOMAN: '5' }, incomplete: true });
  });
  it('discount percent and amount', () => expect(lineAmount('100', '1000', 'TOMAN', '500', '10')).toBe('89500'));
});
describe('T13 — R11', () => {
  it('80 % of 911,125,750 = 728,900,600; remaining 911,125,750', () => {
    expect(prepayment('911125750', '80', '0', 'TOMAN')).toEqual({ prepay: '728900600', remaining: '911125750' });
  });
});
describe('T15 — R12', () => {
  it('proforma 20,000 (no effect) + receipt 8,000 + invoice 15,000 → owed 7,000 USD', () => {
    expect(partyBalance([
      { kind: 'receipt', amount: '8000', currency: 'USD', status: 'posted' },
      { kind: 'invoice', amount: '15000', currency: 'USD', status: 'posted' },
      { kind: 'invoice', amount: '99999', currency: 'USD', status: 'draft' },
    ])).toEqual({ USD: '7000.00' });
  });
  it('T42-style: paying a factory fee changes money only, and reported docs do not count', () => {
    expect(partyBalance([
      { kind: 'toll_fee', amount: '1000000', currency: 'TOMAN', status: 'posted' },
      { kind: 'payment', amount: '400000', currency: 'TOMAN', status: 'posted' },
      { kind: 'payment', amount: '600000', currency: 'TOMAN', status: 'reported' },
    ])).toEqual({ TOMAN: '-600000' });
  });
});
describe('T16, T17 — R13', () => {
  it('T16: 100@100 + 100@120 → avg 110; sell 50 @150 → profit 2,000', () => {
    let s = applyReceipt(emptyAvg(), '100', '100');
    s = applyReceipt(s, '100', '120');
    expect(s.avg).toBe('110');
    const issue = applyIssue(s, '50');
    expect(issue.cost).toBe('5500');
    expect(Number('7500') - Number(issue.cost)).toBe(2000);
    expect(issue.kg).toBe('150.000');
  });
  it('T17: scrap at book 6 sold at 7 → profit 1', () => {
    const s = applyReceipt(emptyAvg(), '1', '6');
    const issue = applyIssue(s, '1');
    expect(Number('7') - Number(issue.cost)).toBe(1);
  });
  it('unknown cost → incomplete, not zero', () => {
    const s = applyReceipt(emptyAvg(), '100', null);
    expect(s.avg).toBeNull();
    expect(s.incomplete).toBe(true);
    expect(applyIssue(s, '10').cost).toBeNull();
  });
});
describe('T18, T19, T20 — R14, R15', () => {
  const price = '440000';
  it('T18: sales 462M; profit 62 = base 40 + gain 22, never 84', () => {
    const r = realisedProfit('462000000', '400000000', '1000', '1000');
    expect(r).toEqual({ sales: '462000000', cost: '400000000', profit: '62000000' });
    const split = profitSplit(r!.profit, '50', price);
    expect(split).toEqual({ gain_share: '22000000', base_share: '40000000', total: '62000000' });
    expect(Number(split.base_share) + Number(split.gain_share)).toBe(62_000_000);
  });
  it('T19: actual cost 420M → profit 42 = 20 + 22; customer price unchanged', () => {
    const r = realisedProfit('462000000', '420000000', '1000', '1000');
    expect(profitSplit(r!.profit, '50', price)).toEqual({ gain_share: '22000000', base_share: '20000000', total: '42000000' });
  });
  it('T20: dispatch 630 final (raw 600): sales 277.2M, cost 240M, profit 37.2M', () => {
    expect(realisedProfit('277200000', '400000000', '600', '1000')).toEqual({ sales: '277200000', cost: '240000000', profit: '37200000' });
  });
  it('unknown cost → null (labelled incomplete by caller)', () => expect(realisedProfit('1', null, '1', '1')).toBeNull());
});
describe('T21, T22 — R16', () => {
  it('5,000,000 between 600 and 400 → 3,000,000 / 2,000,000', () => expect(splitByWeight('5000000', ['600', '400'])).toEqual(['3000000', '2000000']));
  it('100 between three equal → 34, 33, 33', () => expect(splitByWeight('100', ['10', '10', '10'])).toEqual(['34', '33', '33']));
  it('USD keeps cents and sums exactly', () => {
    const s = splitByWeight('100', ['1', '1', '1'], 'USD');
    expect(s).toEqual(['33.34', '33.33', '33.33']);
  });
});
describe('T25 — R21', () => {
  it('400M, 1,000 kg, 10 % → 440,000', () => expect(suggestedPricePerKg('400000000', '1000', '10')).toBe('440000'));
});
describe('T26, T27, T28 — R22, R23 golden scenario', () => {
  const frames: Array<[string, string]> = [['812', '394'], ['813', '594'], ['807', '397'], ['808', '397'], ['816', '396'], ['818', '334'], ['817', '399']];
  it('T26: only 813 warns (median 397); 334 does not', () => {
    const peers = frames.map((f) => f[1]);
    const r813 = bundleWeightOutlier('594', peers);
    expect(r813).toEqual({ warn: true, median_kg: '397.000' });
    expect(bundleWeightOutlier('334', peers)!.warn).toBe(false);
    for (const [, w] of frames) if (w !== '594') expect(bundleWeightOutlier(w, peers)!.warn).toBe(false);
  });
  it('T27: 479 among leaf bundles does not warn (36 % < 40 %)', () => {
    const leaves = ['349', '352', '479', '318', '357'];
    expect(bundleWeightOutlier('479', leaves)!.warn).toBe(false);
  });
  it('T28: 3,124 / 2,157 / 2,182 / 237; total 7,700; 18 bundles', () => {
    const L = (p: string, kg: string | null) => ({ product_id: p, weight_kg: kg });
    const b = (code: string, kg: string, lines: ReturnType<typeof L>[]) => ({ code, weight_kg: kg, lines });
    const bundles = [
      ...frames.map(([c, w]) => b(c, w, [L('frame', null)])),
      b('809', '542', [L('frame', '213'), L('tee', '329')]),
      b('806', '349', [L('leaf', null)]), b('811', '352', [L('leaf', null)]), b('821', '479', [L('leaf', null)]),
      b('819', '318', [L('leaf', null)]), b('822', '302', [L('leaf', null)]), b('820', '357', [L('leaf', null)]),
      b('810', '494', [L('tee', null)]), b('TMP-1', '679', [L('tee', null)]), b('TMP-2', '680', [L('tee', null)]),
      b('803', '237', [L('strip', null)]),
    ];
    const r = bundleReportTotals(bundles);
    expect(r.bundle_count).toBe(18);
    expect(r.total_kg).toBe('7700.000');
    expect(r.per_product).toEqual({ frame: '3124.000', tee: '2182.000', leaf: '2157.000', strip: '237.000' });
  });
});
describe('T29 — R24', () => {
  it('60,000,000 TOMAN at 60,000 per USD settles 1,000 USD', () => {
    expect(crossCurrencySettlement('60000000', 'TOMAN', 'USD', '60000', 'USD', 'TOMAN')).toBe('1000.00');
  });
});
