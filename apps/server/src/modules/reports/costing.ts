import { Dec, round, type Currency } from '@vitral/shared';
import { sql, type SqlBool } from 'kysely';
import type { Db, Trx } from '../../db/index.js';
import { profitSplit, realisedProfit, suggestedPricePerKg } from '../../rules/money.js';
import { loadLines, orderTotals, postedReceiptsForOrder } from '../orders/service.js';

export type ComponentStatus = 'estimated' | 'final' | 'unknown';
export interface CostComponent { key: string; label: string; amount: string | null; currency: Currency; basis_kg: string | null; rate: string | null; ref_type: string | null; ref_id: string | null; ref_number: string | null; status: ComponentStatus; note?: string }

export interface OrderCosting {
  order_id: string; currency: Currency; components: CostComponent[]; total_cost: string | null; cost_incomplete: boolean; incomplete_keys: string[];
  raw_kg: string; coated_kg: string | null; dispatched_raw_kg: string; dispatched_final_kg: string; sold_gain_kg: string;
  sales: { proforma: string; invoiced: string; status: 'estimated' | 'final' };
  profit: { estimated: { sales: string; cost: string; profit: string } | null; realised: { sales: string; cost: string; profit: string } | null; collected: { received: string; paid: string; net: string }; split: { gain_share: string; base_share: string; total: string } | null };
  pricing: { base_per_kg: string | null; suggested_per_kg: string | null; markup_percent: string; effective_price_per_kg: string | null };
  cost_confirmed_at: Date | null;
}

const sum = (xs: Array<string | null>) => xs.reduce((a: Dec, x) => a.plus(x ?? 0), new Dec(0));

/** Module 9: every cost component with its basis, reference and status; estimated/realised/collected profit; R15 split; R21 price. */
export async function orderCosting(db: Db | Trx, orderId: string, markupPercent = '10', manualPricePerKg: string | null = null): Promise<OrderCosting> {
  const order = await db.selectFrom('orders').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
  const cur = order.currency as Currency;
  const lines = await loadLines(db, orderId);
  const lineIds = lines.map((l) => l.id);
  const components: CostComponent[] = [];
  const C = (c: Omit<CostComponent, 'currency'> & { currency?: Currency }) => components.push({ currency: cur, ...c });

  // Bundles of this order (produced for its lines or reserved to them), with their run.
  const bundles = lineIds.length ? await db.selectFrom('bundles').select(['bundles.id', 'bundles.weight_kg', 'bundles.raw_weight_kg', 'bundles.form', 'bundles.status', 'bundles.production_run_id', 'bundles.location_id'])
    .where((eb) => eb.or([eb('bundles.reserved_order_line_id', 'in', lineIds), sql<boolean>`EXISTS (SELECT 1 FROM bundle_lines bl WHERE bl.bundle_id = bundles.id AND bl.order_line_id = ANY(${lineIds}::uuid[]))`])).where('bundles.draft', '=', false).execute() : [];
  const bundleIds = bundles.map((b) => b.id);
  const rawOf = (b: { weight_kg: string; raw_weight_kg: string | null; form: string }) => (b.form === 'raw' ? b.weight_kg : b.raw_weight_kg ?? b.weight_kg);
  const rawKg = sum(bundles.map(rawOf));
  const coatedBundles = bundles.filter((b) => b.form !== 'raw');
  const coatedKg = coatedBundles.length ? sum(coatedBundles.map((b) => b.weight_kg)) : null;

  // Dispatched to the customer (delivered transfers).
  const dispatched = bundleIds.length ? await db.selectFrom('transfer_lines').innerJoin('transfers', 'transfers.id', 'transfer_lines.transfer_id').select(['transfer_lines.bundle_id', 'transfer_lines.received_kg', 'transfer_lines.kg']).where('transfers.kind', '=', 'to_customer').where('transfers.status', 'in', ['delivered', 'received', 'in_transit', 'partially_received']).where('transfer_lines.bundle_id', 'in', bundleIds).execute() : [];
  const dispatchedIds = new Set(dispatched.map((d) => d.bundle_id!));
  const dispatchedBundles = bundles.filter((b) => dispatchedIds.has(b.id));
  const dispatchedRaw = sum(dispatchedBundles.map(rawOf));
  const dispatchedFinal = sum(dispatched.map((d) => d.received_kg ?? d.kg));
  const soldGain = dispatchedFinal.minus(dispatchedRaw);

  // 1. Ingot & 2. production fee & scrap credit — per run, pro-rated by this order's good kg in the run.
  const runIds = [...new Set(bundles.map((b) => b.production_run_id).filter((x): x is string => !!x))];
  for (const runId of runIds) {
    const run = await db.selectFrom('production_runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
    const runGood = new Dec(run.good_kg).isZero() ? sum((await db.selectFrom('bundles').select('weight_kg').where('production_run_id', '=', runId).where('draft', '=', false).execute()).map((b) => b.weight_kg)) : new Dec(run.good_kg);
    const ourKg = sum(bundles.filter((b) => b.production_run_id === runId).map(rawOf));
    const share = runGood.isZero() ? new Dec(0) : ourKg.div(runGood);
    const consumed = await db.selectFrom('stock_moves').select([sql<string>`COALESCE(SUM(kg),0)`.as('kg'), sql<string>`SUM(kg * unit_cost)`.as('value'), sql<boolean>`bool_or(unit_cost IS NULL)`.as('unknown')]).where('ref_type', '=', 'production_consume').where('ref_id', '=', runId).executeTakeFirstOrThrow();
    const consumedKg = new Dec(consumed.kg).mul(share);
    const ingotKnown = !consumed.unknown && consumed.value !== null && run.status === 'closed';
    C({ key: `ingot:${runId}`, label: 'شمش مصرفی', amount: ingotKnown ? round(new Dec(consumed.value!).mul(share), cur) : null, basis_kg: round(consumedKg, 'weight'), rate: ingotKnown && !consumedKg.isZero() ? round(new Dec(consumed.value!).div(consumed.kg), cur) : null, ref_type: 'production_runs', ref_id: runId, ref_number: run.number, status: run.status !== 'closed' ? 'estimated' : ingotKnown ? 'final' : 'unknown', note: consumed.unknown ? 'شمش بدون قیمت خرید' : undefined });
    const fee = run.fee_document_id ? await db.selectFrom('documents').select(['amount', 'status', 'currency', 'number']).where('id', '=', run.fee_document_id).executeTakeFirst() : null;
    C({ key: `toll:${runId}`, label: 'اجرت تولید', amount: fee?.amount ? round(new Dec(fee.amount).mul(share), cur) : null, currency: (fee?.currency as Currency) ?? cur, basis_kg: round(ourKg, 'weight'), rate: run.rate_per_kg, ref_type: 'documents', ref_id: run.fee_document_id, ref_number: fee?.number ?? run.number, status: fee?.amount && fee.status === 'posted' ? 'final' : run.rate_per_kg ? 'estimated' : 'unknown', note: run.rate_per_kg ? undefined : 'نرخ اجرت قرارداد ثبت نشده (D1)' });
    if (run.scrap_owner === 'vitral' && run.scrap_credit_rate && new Dec(run.scrap_kg).gt(0)) {
      C({ key: `scrap:${runId}`, label: 'اعتبار ضایعات برگشتی', amount: round(new Dec(run.scrap_kg).mul(run.scrap_credit_rate).mul(share).neg(), cur), basis_kg: round(new Dec(run.scrap_kg).mul(share), 'weight'), rate: run.scrap_credit_rate, ref_type: 'production_runs', ref_id: runId, ref_number: run.number, status: 'final' });
    }
  }

  // 3. Coating fee & paint material — per coating run, pro-rated by raw kg of our bundles in it.
  const coatingRuns = bundleIds.length ? await db.selectFrom('coating_run_items').innerJoin('coating_runs', 'coating_runs.id', 'coating_run_items.run_id').select(['coating_runs.id', 'coating_runs.number', 'coating_runs.rate_per_kg', 'coating_runs.rate_currency', 'coating_runs.input_basis_kg', 'coating_runs.fee_document_id', 'coating_runs.status', 'coating_runs.includes_material', 'coating_runs.service', sql<string>`SUM(CASE WHEN coating_run_items.bundle_id = ANY(${bundleIds}::uuid[]) THEN coating_run_items.raw_kg ELSE 0 END)`.as('our_raw'), sql<string>`SUM(coating_run_items.raw_kg)`.as('all_raw')]).groupBy(['coating_runs.id']).having(sql<SqlBool>`SUM(CASE WHEN coating_run_items.bundle_id = ANY(${bundleIds}::uuid[]) THEN 1 ELSE 0 END) > 0`).execute() : [];
  for (const cr of coatingRuns) {
    const share = new Dec(cr.all_raw).isZero() ? new Dec(0) : new Dec(cr.our_raw).div(cr.all_raw);
    const fee = cr.fee_document_id ? await db.selectFrom('documents').select(['amount', 'status', 'number']).where('id', '=', cr.fee_document_id).executeTakeFirst() : null;
    const est = cr.rate_per_kg && cr.input_basis_kg ? new Dec(cr.input_basis_kg).mul(cr.rate_per_kg) : null;
    C({ key: `coating:${cr.id}`, label: cr.service === 'paint' ? 'اجرت رنگ' : 'اجرت آنادایز', amount: fee?.amount ? round(new Dec(fee.amount).mul(share), cur) : est ? round(est.mul(share), cur) : null, currency: cr.rate_currency as Currency, basis_kg: round(new Dec(cr.our_raw), 'weight'), rate: cr.rate_per_kg, ref_type: cr.fee_document_id ? 'documents' : 'coating_runs', ref_id: cr.fee_document_id ?? cr.id, ref_number: fee?.number ?? cr.number, status: fee?.amount && fee.status === 'posted' ? 'final' : est ? 'estimated' : 'unknown', note: cr.rate_per_kg ? undefined : 'نرخ رنگ ثبت نشده' });
    if (cr.includes_material === false) {
      const mat = await db.selectFrom('stock_moves').select([sql<string>`COALESCE(SUM(kg),0)`.as('kg'), sql<string>`SUM(kg * unit_cost)`.as('value'), sql<boolean>`bool_or(unit_cost IS NULL)`.as('unknown')]).where('ref_type', '=', 'material_consume').where('ref_id', '=', cr.id).executeTakeFirstOrThrow();
      C({ key: `paint:${cr.id}`, label: 'ماده رنگ', amount: mat.value && !mat.unknown ? round(new Dec(mat.value).mul(share), cur) : null, basis_kg: round(new Dec(mat.kg).mul(share), 'weight'), rate: null, ref_type: 'coating_runs', ref_id: cr.id, ref_number: cr.number, status: mat.value && !mat.unknown ? 'final' : 'unknown', note: new Dec(mat.kg).isZero() ? 'مصرف رنگ ثبت نشده' : undefined });
    } else if (cr.includes_material === null) C({ key: `paint:${cr.id}`, label: 'ماده رنگ', amount: null, basis_kg: null, rate: null, ref_type: 'coating_runs', ref_id: cr.id, ref_number: cr.number, status: 'unknown', note: 'شمول ماده رنگ در اجرت نامشخص (D2)' });
  }

  // 4. Dies made for this order's lines.
  const dieOrders = lineIds.length ? await db.selectFrom('die_orders').selectAll().where('order_line_id', 'in', lineIds).execute() : [];
  for (const d of dieOrders) C({ key: `die:${d.id}`, label: 'ساخت قالب', amount: d.maker_cost, currency: d.currency as Currency, basis_kg: null, rate: null, ref_type: 'die_orders', ref_id: d.id, ref_number: d.number, status: d.maker_cost ? (d.purchase_document_id ? 'final' : 'estimated') : 'unknown' });

  // 5. Freight / packaging / shared expenses and 6. purchases for this order (expense shares, R16).
  const shares = await db.selectFrom('expense_shares').innerJoin('documents', 'documents.id', 'expense_shares.document_id').select(['expense_shares.amount', 'expense_shares.currency', 'documents.id as doc_id', 'documents.number', 'documents.status', 'documents.expense_category', 'documents.expense_type', 'expense_shares.weight_kg']).where('expense_shares.order_id', '=', orderId).where('documents.status', '<>', 'void').execute();
  for (const s of shares) C({ key: `expense:${s.doc_id}`, label: s.expense_category === 'freight' ? 'حمل' : s.expense_type === 'shared' ? 'هزینه مشترک' : 'هزینه سفارش', amount: s.amount, currency: s.currency as Currency, basis_kg: s.weight_kg, rate: null, ref_type: 'documents', ref_id: s.doc_id, ref_number: s.number, status: s.status === 'posted' ? 'final' : 'estimated' });
  const purchases = await db.selectFrom('documents').select(['id', 'number', 'amount', 'currency', 'status', 'agreed_kg', 'unit_price', 'purchase_kind']).where('order_id', '=', orderId).where('kind', '=', 'purchase').where('status', '<>', 'void').execute();
  for (const p of purchases) C({ key: `purchase:${p.id}`, label: p.purchase_kind === 'finished_profile' ? 'خرید محصول آماده' : p.purchase_kind === 'raw_profile' ? 'خرید پروفیل خام' : 'خرید', amount: p.amount, currency: p.currency as Currency, basis_kg: p.agreed_kg, rate: p.unit_price, ref_type: 'documents', ref_id: p.id, ref_number: p.number, status: p.amount === null ? 'unknown' : p.status === 'posted' ? 'final' : 'estimated' });

  // Totals in the order currency only; foreign-currency components are flagged and excluded (no silent mixing).
  const mixed = components.filter((c) => c.currency !== cur && c.amount !== null);
  for (const m of mixed) m.note = (m.note ? m.note + '؛ ' : '') + 'ارز متفاوت؛ در جمع نیامده';
  const inCur = components.filter((c) => c.currency === cur);
  const incompleteKeys = components.filter((c) => c.amount === null).map((c) => c.key);
  const costIncomplete = incompleteKeys.length > 0 || mixed.length > 0;
  const totalCost = inCur.some((c) => c.amount !== null) ? round(sum(inCur.map((c) => c.amount)), cur) : null;

  // Sales: posted invoices (final) else proforma total (estimated).
  const paid = await postedReceiptsForOrder(db, orderId);
  const totals = orderTotals(order, lines, paid);
  const proforma = totals.totals[cur] ?? '0';
  const inv = await db.selectFrom('documents').select(sql<string>`COALESCE(SUM(CASE WHEN kind = 'invoice' THEN amount ELSE -amount END),0)`.as('a')).where('order_id', '=', orderId).where('kind', 'in', ['invoice', 'sales_return']).where('status', '=', 'posted').where('currency', '=', cur).executeTakeFirstOrThrow();
  const invoiced = round(inv.a, cur);
  const salesFinal = !new Dec(invoiced).isZero();
  const salesAmount = salesFinal ? invoiced : proforma;

  const estimated = totalCost === null ? null : { sales: round(proforma, cur), cost: totalCost, profit: round(new Dec(proforma).minus(totalCost), cur) };
  const realised = salesFinal && !costIncomplete && totalCost !== null ? realisedProfit(invoiced, totalCost, dispatchedRaw, rawKg, cur) : null;
  const payments = await db.selectFrom('allocations').innerJoin('documents as p', 'p.id', 'allocations.from_document_id').innerJoin('documents as t', 't.id', 'allocations.to_document_id').select(sql<string>`COALESCE(SUM(allocations.amount),0)`.as('a')).where('p.kind', '=', 'payment').where('p.status', '=', 'posted').where('p.currency', '=', cur).where((eb) => eb.or([eb('t.order_id', '=', orderId), sql<boolean>`EXISTS (SELECT 1 FROM expense_shares es WHERE es.document_id = t.id AND es.order_id = ${orderId}::uuid)`])).executeTakeFirstOrThrow();
  const received = paid[cur] ?? '0';
  const collected = { received: round(received, cur), paid: round(payments.a, cur), net: round(new Dec(received).minus(payments.a), cur) };

  const effectivePrice = dispatchedFinal.isZero() ? (rawKg.isZero() ? null : round(new Dec(salesAmount).div(coatedKg ?? rawKg), cur)) : round(new Dec(salesAmount).div(dispatchedFinal), cur);
  const profitForSplit = realised?.profit ?? estimated?.profit ?? null;
  const gainForSplit = dispatchedFinal.isZero() ? (coatedKg ? coatedKg.minus(rawKg) : new Dec(0)) : soldGain;
  const split = profitForSplit !== null && effectivePrice !== null ? profitSplit(profitForSplit, gainForSplit, manualPricePerKg ?? effectivePrice, cur) : null;
  const basePerKg = totalCost === null || rawKg.isZero() ? null : round(new Dec(totalCost).div(rawKg), cur);

  return {
    order_id: orderId, currency: cur, components, total_cost: totalCost, cost_incomplete: costIncomplete, incomplete_keys: incompleteKeys,
    raw_kg: round(rawKg, 'weight'), coated_kg: coatedKg ? round(coatedKg, 'weight') : null, dispatched_raw_kg: round(dispatchedRaw, 'weight'), dispatched_final_kg: round(dispatchedFinal, 'weight'), sold_gain_kg: round(soldGain, 'weight'),
    sales: { proforma: round(proforma, cur), invoiced, status: salesFinal ? 'final' : 'estimated' },
    profit: { estimated, realised, collected, split },
    pricing: { base_per_kg: basePerKg, suggested_per_kg: suggestedPricePerKg(totalCost, rawKg, markupPercent, cur), markup_percent: markupPercent, effective_price_per_kg: manualPricePerKg ?? effectivePrice },
    cost_confirmed_at: order.cost_confirmed_at,
  };
}
