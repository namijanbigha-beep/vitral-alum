/**
 * Generates tests/fixtures/production-rules.json from apps/server/src/rules/production.ts and weights.ts, so the PHP
 * ports (src/Rules/Production.php, src/Rules/Weights.php) are checked against the exact Node outputs.
 *
 *   cd apps/server && node --import tsx ../php/tests/fixtures/generate-production.ts
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleReportTotals,
  bundleWeightOutlier,
  bundleWeightPerMeter,
  barsFromPackages,
  coatingFee,
  productionFee,
  runBalance,
  scaleNet,
  weightGain,
} from '../../../server/src/rules/production.js';
import { estimatedBarsForKg, estimatedLineKg, suggestedWeightPerMeter } from '../../../server/src/rules/weights.js';

let seed = 51515;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const int = (n: number): number => Math.floor(rnd() * n);
const kg = (): string => `${int(3000)}.${String(int(1000)).padStart(3, '0')}`;
const small = (): string => `${int(30)}.${int(10)}${int(10)}`;
const maybe = <T>(v: T): T | null => (int(6) === 0 ? null : v);

const cases: Record<string, unknown[]> = {
  bundleWeightPerMeter: [], barsFromPackages: [], coatingFee: [], weightGain: [], productionFee: [], runBalance: [], scaleNet: [],
  bundleWeightOutlier: [], bundleReportTotals: [], suggestedWeightPerMeter: [], estimatedLineKg: [], estimatedBarsForKg: [],
};
const add = (name: string, args: unknown[], out: unknown): void => void cases[name]!.push({ args, out });

for (let i = 0; i < 150; i += 1) {
  const a1 = [maybe(kg()), maybe(small()), maybe(String(int(200))), maybe(small()), maybe(int(4) === 0 ? '0' : `${int(5000)}.${int(10)}`)] as const;
  add('bundleWeightPerMeter', [...a1], bundleWeightPerMeter(...a1));
  const p = [int(50), int(30)] as const;
  add('barsFromPackages', [...p], barsFromPackages(...p));
  const c = [maybe(kg()), maybe(`${int(50000)}.${int(100)}`)] as const;
  add('coatingFee', [...c], coatingFee(...c));
  const w = [int(5) === 0 ? '0' : kg(), maybe(kg())] as const;
  add('weightGain', [...w], weightGain(...w));
  const f = [maybe(`${int(90000)}`), maybe(kg()), maybe(`${int(1000000)}.5`)] as const;
  add('productionFee', [...f], productionFee(...f));
  const r = [maybe(int(6) === 0 ? '0' : kg()), kg(), small(), small(), small(), String(int(5))] as const;
  add('runBalance', [...r], runBalance(...r));
  const s = [maybe(kg()), maybe(kg()), maybe(small())] as const;
  add('scaleNet', [...s], scaleNet(...s));
  const peers = Array.from({ length: int(8) }, () => (int(10) === 0 ? '0.000' : kg()));
  const o = [kg(), peers, String(10 + int(60))] as const;
  add('bundleWeightOutlier', [o[0], o[1], o[2]], bundleWeightOutlier(o[0], o[1], o[2]));
  const bundles = Array.from({ length: int(5) }, (_, j) => ({
    code: `B${j}`,
    weight_kg: kg(),
    lines: Array.from({ length: 1 + int(3) }, () => ({ product_id: `p${int(3)}`, weight_kg: maybe(kg()) })),
  }));
  add('bundleReportTotals', [bundles], bundleReportTotals(bundles));
  const area = maybe(`${int(2000)}.${int(100)}`);
  const dflt = int(2) === 0;
  add('suggestedWeightPerMeter', dflt ? [area] : [area, '2.71'], dflt ? suggestedWeightPerMeter(area) : suggestedWeightPerMeter(area, '2.71'));
  const l = [maybe(`${int(5000)}.${int(10)}`), maybe(small()), maybe(String(int(400)))] as const;
  add('estimatedLineKg', [...l], estimatedLineKg(...l));
  const b = [maybe(kg()), maybe(int(8) === 0 ? '0' : `${int(5000)}.${int(10)}`), maybe(small())] as const;
  add('estimatedBarsForKg', [...b], estimatedBarsForKg(...b));
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'production-rules.json');
writeFileSync(out, JSON.stringify(cases, null, 1) + '\n');
console.log(`wrote ${out}`);
