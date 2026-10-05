import { Dec, round, percent, type DecimalInput } from '@vitral/shared';

/**
 * R03 — actual weight per metre of a bundle (g/m) = (bundle kg − packaging kg) ÷ (bars × length) × 1000,
 * plus the signed difference to the reference in percent (negative = lighter). Null when it cannot be computed.
 */
export function bundleWeightPerMeter(
  bundleKg: DecimalInput | null,
  packagingKg: DecimalInput | null,
  bars: DecimalInput | null,
  lengthM: DecimalInput | null,
  referenceGpm: DecimalInput | null = null,
): { g_per_m: string; diff_percent: string | null } | null {
  if (bundleKg === null || bars === null || lengthM === null) return null;
  const denom = new Dec(bars).mul(lengthM);
  if (denom.isZero()) return null;
  const net = new Dec(bundleKg).minus(packagingKg ?? 0);
  const gpm = net.div(denom).mul(1000);
  const diff = referenceGpm === null || new Dec(referenceGpm).isZero() ? null : percent(gpm.minus(referenceGpm), referenceGpm);
  return { g_per_m: round(gpm, 'g_per_m'), diff_percent: diff };
}

/** R04 — bars = packages × bars per package. */
export function barsFromPackages(packages: number, barsPerPackage: number): number {
  return packages * barsPerPackage;
}

/** R05 — coating fee = basis input kg × run rate. Output weight has no effect. Null rate → null. */
export function coatingFee(inputBasisKg: DecimalInput | null, ratePerKg: DecimalInput | null): string | null {
  if (inputBasisKg === null || ratePerKg === null) return null;
  return round(new Dec(inputBasisKg).mul(ratePerKg), 'TOMAN');
}

/** R06 — weight gain = coated − raw; percent = gain ÷ raw. Un-returned bundles are not included (caller filters). */
export function weightGain(rawKg: DecimalInput, coatedKg: DecimalInput | null): { gain_kg: string; percent: string | null } | null {
  if (coatedKg === null) return null;
  const gain = new Dec(coatedKg).minus(rawKg);
  return { gain_kg: round(gain, 'weight'), percent: percent(gain, rawKg) };
}

/** R07 — production fee = rate × contract basis kg + fixed fee. Null rate or basis → null. */
export function productionFee(
  ratePerKg: DecimalInput | null,
  basisKg: DecimalInput | null,
  fixedFee: DecimalInput | null,
): string | null {
  if (ratePerKg === null || basisKg === null) return null;
  return round(new Dec(ratePerKg).mul(basisKg).plus(fixedFee ?? 0), 'TOMAN');
}

/**
 * R08 — run balance: unexplained = consumed − (good + rejected + scrap + returned); yield = good ÷ consumed.
 * `needs_reason` when |unexplained| exceeds the threshold percent of consumed ingot.
 */
export function runBalance(
  consumedKg: DecimalInput | null,
  goodKg: DecimalInput,
  rejectedKg: DecimalInput,
  scrapKg: DecimalInput,
  returnedKg: DecimalInput,
  thresholdPercent: DecimalInput = '1',
): { unexplained_kg: string; unexplained_percent: string | null; yield_percent: string | null; needs_reason: boolean } | null {
  if (consumedKg === null) return null;
  const consumed = new Dec(consumedKg);
  const unexplained = consumed.minus(goodKg).minus(rejectedKg).minus(scrapKg).minus(returnedKg);
  const pct = percent(unexplained, consumed);
  return {
    unexplained_kg: round(unexplained, 'weight'),
    unexplained_percent: pct,
    yield_percent: percent(goodKg, consumed),
    needs_reason: !consumed.isZero() && unexplained.abs().div(consumed).mul(100).gt(thresholdPercent),
  };
}

/**
 * R09 — scale net = gross − tare − packaging. Without packaging the figure is «ناخالص» and unusable for settlement.
 * With only a direct net on the ticket, that is used and compared by the caller.
 */
export function scaleNet(
  grossKg: DecimalInput | null,
  tareKg: DecimalInput | null,
  packagingKg: DecimalInput | null,
): { kg: string; gross_only: boolean } | null {
  if (grossKg === null || tareKg === null) return null;
  const base = new Dec(grossKg).minus(tareKg);
  if (packagingKg === null) return { kg: round(base, 'weight'), gross_only: true };
  return { kg: round(base.minus(packagingKg), 'weight'), gross_only: false };
}

/**
 * R22 — bundle weight warning: at least 4 single-product bundles of the same product in the run and
 * |weight − median| ÷ median > threshold. Returns the median used, or null when not applicable.
 */
export function bundleWeightOutlier(
  weightKg: DecimalInput,
  peerWeightsKg: DecimalInput[],
  thresholdPercent: DecimalInput = '40',
): { warn: boolean; median_kg: string } | null {
  if (peerWeightsKg.length < 4) return null;
  const sorted = peerWeightsKg.map((w) => new Dec(w)).sort((a, b) => a.cmp(b));
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? (sorted[mid] as Dec) : (sorted[mid - 1] as Dec).plus(sorted[mid] as Dec).div(2);
  if (median.isZero()) return null;
  const warn = new Dec(weightKg).minus(median).abs().div(median).mul(100).gt(thresholdPercent);
  return { warn, median_kg: round(median, 'weight') };
}

/**
 * R23 — bundle report: bundle count is the number of bundles; product weight comes from lines.
 * A single-line bundle without a line weight contributes its bundle weight to that product.
 */
export interface ReportBundle {
  code: string;
  weight_kg: string;
  lines: Array<{ product_id: string; weight_kg: string | null }>;
}
export function bundleReportTotals(bundles: ReportBundle[]): { bundle_count: number; total_kg: string; per_product: Record<string, string> } {
  const per: Record<string, Dec> = {};
  let total = new Dec(0);
  for (const b of bundles) {
    total = total.plus(b.weight_kg);
    for (const l of b.lines) {
      const kg = l.weight_kg ?? (b.lines.length === 1 ? b.weight_kg : null);
      if (kg === null) continue;
      per[l.product_id] = (per[l.product_id] ?? new Dec(0)).plus(kg);
    }
  }
  return {
    bundle_count: bundles.length,
    total_kg: round(total, 'weight'),
    per_product: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, round(v, 'weight')])),
  };
}
