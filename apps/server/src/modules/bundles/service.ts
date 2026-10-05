import { Dec, round } from '@vitral/shared';
import { sql } from 'kysely';
import type { Db, Trx } from '../../db/index.js';
import { bundleReportTotals } from '../../rules/production.js';

export async function bundleTotalsForRun(db: Db | Trx, runId: string): Promise<{ good_kg: string; rejected_kg: string; bundle_count: number; total_kg: string; per_product: Record<string, string> }> {
  const bundles = await db.selectFrom('bundles').select(['id', 'code', 'weight_kg', 'status']).where('production_run_id', '=', runId).where('draft', '=', false).where('status', '<>', 'consumed').execute();
  const ids = bundles.map((b) => b.id);
  const lines = ids.length ? await db.selectFrom('bundle_lines').select(['bundle_id', 'product_id', 'weight_kg']).where('bundle_id', 'in', ids).execute() : [];
  const report = bundleReportTotals(bundles.map((b) => ({ code: b.code, weight_kg: b.weight_kg, lines: lines.filter((l) => l.bundle_id === b.id).map((l) => ({ product_id: l.product_id, weight_kg: l.weight_kg })) })));
  const good = bundles.filter((b) => b.status === 'ok').reduce((a, b) => a.plus(b.weight_kg), new Dec(0));
  const rejected = bundles.filter((b) => b.status !== 'ok' && b.status !== 'scrapped').reduce((a, b) => a.plus(b.weight_kg), new Dec(0));
  return { good_kg: round(good, 'weight'), rejected_kg: round(rejected, 'weight'), ...report };
}

export const bundleCountSql = sql<number>`(SELECT COUNT(*)::int FROM bundle_lines bl WHERE bl.bundle_id = bundles.id)`;
