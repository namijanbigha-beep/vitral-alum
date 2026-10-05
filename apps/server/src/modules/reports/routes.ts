import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CURRENCIES, Dec, decimalString, round, toLatinDigits, type Currency } from '@vitral/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Db } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { can, requirePermission, requireUser, type AuthUser } from '../../lib/auth.js';
import { idParam, uuid, boolQuery } from '../../lib/crud.js';
import { jalaliDateArg, jalaliDayRange } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../lib/idempotency.js';
import { buildXlsx, type Cell } from '../../lib/xlsx.js';
import { diskUsagePercent } from '../health/routes.js';
import { lotAverage } from '../materials/routes.js';
import { positionsDetailed } from '../stock/routes.js';
import { orderCosting } from './costing.js';

const bump = { updated_at: new Date(), version: sql<number>`version + 1` };

const rangeQuery = z.object({ from: z.string().max(12).optional(), to: z.string().max(12).optional(), party_id: uuid.optional(), order_id: uuid.optional(), product_id: uuid.optional(), currency: z.enum(CURRENCIES).optional(), country: z.string().max(80).optional(), color: z.string().max(60).optional(), xlsx: boolQuery.optional() });
type RangeQ = z.infer<typeof rangeQuery>;

function range(q: RangeQ): { start?: Date; end?: Date } {
  const start = q.from ? jalaliDayRange(jalaliDateArg(toLatinDigits(q.from))).start : undefined;
  const end = q.to ? jalaliDayRange(jalaliDateArg(toLatinDigits(q.to))).end : undefined;
  return { start, end };
}

function xlsx(reply: FastifyReply, name: string, header: string[], rows: Cell[][]) {
  return reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="${name}.xlsx"`).send(buildXlsx([{ name, header, rows }]));
}

export function reportRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  // ---- module 9 ----
  app.get('/orders/:id/costing', async (req) => {
    requirePermission(req, 'finance.view');
    const { id } = idParam.parse(req.params);
    const q = z.object({ markup_percent: decimalString.optional(), manual_price_per_kg: decimalString.optional() }).parse(req.query);
    const exists = await db.selectFrom('orders').select('id').where('id', '=', id).executeTakeFirst();
    if (!exists) throw new AppError('not_found');
    return orderCosting(db, id, q.markup_percent ?? '10', q.manual_price_per_kg ?? null);
  });
  app.post('/orders/:id/confirm-cost', async (req) => {
    const me = requirePermission(req, 'finance.view');
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ version: z.number().int() }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /orders/confirm-cost', async (trx) => {
      const o = await trx.selectFrom('orders').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!o) throw new AppError('not_found');
      if (o.version !== body.version) throw new AppError('conflict');
      const c = await orderCosting(trx, id);
      if (c.cost_incomplete) throw new AppError('validation', `هزینه ناقص است: ${c.incomplete_keys.length} جزء بدون مبلغ`, { components: c.incomplete_keys.join(', ') });
      await trx.updateTable('orders').set({ cost_confirmed_at: new Date(), cost_confirmed_by: me.id, ...bump }).where('id', '=', id).execute();
      await audit(trx, { userId: me.id, entity: 'orders', entityId: id, action: 'confirm_cost', after: { total_cost: c.total_cost } });
      return { status: 200, body: { ok: true, total_cost: c.total_cost } };
    });
    return r.body;
  });

  // ---- dashboard (§15): decisions first, then numbers ----
  app.get('/reports/dashboard', async (req) => {
    const me = requireUser(req);
    const finance = can(me, 'finance.view');
    const now = new Date();
    const soon = new Date(now.getTime() + 3 * 86400_000);
    const [quarantine, tickets, notes, reported, incompleteDocs, corrections, dueOrders, overdueTasks, missingDocs, diffs] = await Promise.all([
      db.selectFrom('bundles').select(['id', 'code', 'status', 'weight_kg', 'defect']).where('status', 'in', ['damaged', 'wrong_product', 'pending_review']).where('draft', '=', false).limit(50).execute(),
      db.selectFrom('scale_tickets').leftJoin('transfers', 'transfers.id', 'scale_tickets.transfer_id').select(['scale_tickets.id', 'scale_tickets.stage', 'transfers.number']).where('scale_tickets.status', '=', 'needs_completion').limit(50).execute(),
      db.selectFrom('free_notes').select(['id', 'text', 'topic', 'status', 'created_at']).where('status', 'in', ['new', 'needs_info']).where(finance ? sql<boolean>`true` : sql<boolean>`created_by = ${me.id}::uuid`).limit(50).execute(),
      finance ? db.selectFrom('documents').select(['id', 'number', 'kind', 'amount', 'currency']).where('status', '=', 'reported').limit(50).execute() : Promise.resolve([]),
      finance ? db.selectFrom('documents').select(['id', 'number', 'kind', 'description', 'source_type']).where('status', '=', 'needs_completion').limit(50).execute() : Promise.resolve([]),
      finance ? db.selectFrom('correction_requests').select(['id', 'entity', 'entity_id', 'reason', 'created_at']).where('status', '=', 'open').limit(50).execute() : Promise.resolve([]),
      db.selectFrom('orders').innerJoin('parties', 'parties.id', 'orders.party_id').select(['orders.id', 'orders.number', 'orders.due_date', 'parties.name as party_name']).where('orders.status_sales', '=', 'approved').where('orders.archived', '=', false).where('orders.due_date', 'is not', null).where('orders.due_date', '<', soon).orderBy('orders.due_date').limit(50).execute(),
      db.selectFrom('tasks').leftJoin('users', 'users.id', 'tasks.assignee_user_id').select(['tasks.id', 'tasks.title', 'tasks.due_at', 'users.short_name as assignee']).where('tasks.status', '=', 'open').where('tasks.due_at', '<', now).where(me.role === 'manager' ? sql<boolean>`true` : sql<boolean>`tasks.assignee_user_id = ${me.id}::uuid`).limit(50).execute(),
      db.selectFrom('notifications').select(['id', 'title', 'entity', 'entity_id', 'created_at']).where('kind', '=', 'missing_document').where('read_at', 'is', null).where('user_id', '=', me.id).limit(50).execute(),
      db.selectFrom('transfer_lines').innerJoin('transfers', 'transfers.id', 'transfer_lines.transfer_id').select(['transfers.id', 'transfers.number', sql<string>`SUM(transfer_lines.kg - COALESCE(transfer_lines.received_kg, transfer_lines.kg))`.as('diff_kg')]).where('transfer_lines.diff_reason', 'is not', null).where('transfers.received_at', '>', new Date(now.getTime() - 7 * 86400_000)).groupBy(['transfers.id', 'transfers.number']).limit(50).execute(),
    ]);
    const decisions = { quarantine, incomplete_tickets: tickets, free_notes: notes, reported_money: reported, incomplete_costs: incompleteDocs, correction_requests: corrections, due_orders: dueOrders, overdue_tasks: overdueTasks, missing_documents: missingDocs, weight_differences: diffs };

    // Where is the weight (location × state), with approximate value for finance users.
    const positions = await positionsDetailed(db);
    const weight: Record<string, { location_id: string; name: string; kind: string; states: Record<string, string>; total_kg: string; value: string | null }> = {};
    const lotAvg = new Map<string, string | null>();
    for (const p of positions) {
      const w = (weight[p.location_id] ??= { location_id: p.location_id, name: p.location_name, kind: p.location_kind, states: {}, total_kg: '0', value: finance ? '0' : null });
      const k = p.state ?? 'unknown';
      w.states[k] = round(new Dec(w.states[k] ?? 0).plus(p.kg), 'weight');
      w.total_kg = round(new Dec(w.total_kg).plus(p.kg), 'weight');
      if (finance && p.item_type === 'material_lot' && !p.owner_party_id) {
        if (!lotAvg.has(p.item_id)) lotAvg.set(p.item_id, (await lotAverage(db, p.item_id)).avg);
        const a = lotAvg.get(p.item_id);
        if (a) w.value = round(new Dec(w.value ?? 0).plus(new Dec(p.kg).mul(a)), 'TOMAN');
      }
    }

    let money: unknown = null;
    let profit: unknown = null;
    if (finance) {
      const rec = await db.selectFrom('documents').innerJoin('parties', 'parties.id', 'documents.party_id').select(['documents.currency', sql<string>`SUM(documents.amount - (SELECT COALESCE(SUM(COALESCE(a.amount_in_target_currency, a.amount)),0) FROM allocations a JOIN documents f ON f.id = a.from_document_id WHERE a.to_document_id = documents.id AND f.status = 'posted'))`.as('open'), sql<string>`SUM(CASE WHEN documents.due_date < now() THEN documents.amount - (SELECT COALESCE(SUM(COALESCE(a.amount_in_target_currency, a.amount)),0) FROM allocations a JOIN documents f ON f.id = a.from_document_id WHERE a.to_document_id = documents.id AND f.status = 'posted') ELSE 0 END)`.as('overdue')]).where('documents.kind', '=', 'invoice').where('documents.status', '=', 'posted').groupBy('documents.currency').execute();
      const pay = await db.selectFrom('documents').select(['documents.currency', 'documents.kind', sql<string>`SUM(documents.amount - (SELECT COALESCE(SUM(COALESCE(a.amount_in_target_currency, a.amount)),0) FROM allocations a JOIN documents f ON f.id = a.from_document_id WHERE a.to_document_id = documents.id AND f.status = 'posted'))`.as('open')]).where('documents.kind', 'in', ['purchase', 'toll_fee', 'expense']).where('documents.status', '=', 'posted').where('documents.party_id', 'is not', null).groupBy(['documents.currency', 'documents.kind']).execute();
      money = { receivables: rec.map((r) => ({ currency: r.currency, open: round(r.open, r.currency as Currency), overdue: round(r.overdue, r.currency as Currency) })), payables: pay.map((p) => ({ currency: p.currency, kind: p.kind, open: round(p.open, p.currency as Currency) })) };
      const q = rangeQuery.parse(req.query);
      profit = await periodProfit(db, range(q));
    }
    const factories = await db.selectFrom('production_runs').innerJoin('parties', 'parties.id', 'production_runs.factory_party_id').select(['parties.id', 'parties.name', sql<number>`COUNT(*)::int`.as('runs'), sql<string>`SUM(ingot_consumed_kg)`.as('consumed'), sql<string>`SUM(good_kg)`.as('good'), sql<string>`SUM(rejected_kg)`.as('rejected'), sql<number>`SUM(CASE WHEN due_at IS NOT NULL AND closed_at > due_at THEN 1 ELSE 0 END)::int`.as('late')]).where('production_runs.status', '=', 'closed').groupBy(['parties.id', 'parties.name']).execute();
    const painters = await db.selectFrom('coating_run_items').innerJoin('coating_runs', 'coating_runs.id', 'coating_run_items.run_id').innerJoin('parties', 'parties.id', 'coating_runs.party_id').select(['parties.id', 'parties.name', 'coating_runs.color_code', sql<string>`SUM(raw_kg)`.as('raw'), sql<string>`SUM(coated_kg)`.as('coated'), sql<number>`COUNT(*)::int`.as('items')]).where('coating_run_items.coated_kg', 'is not', null).groupBy(['parties.id', 'parties.name', 'coating_runs.color_code']).execute();
    const disk = await diskUsagePercent(ctx.config.FILE_STORAGE_DIR);
    return {
      decisions, weight: Object.values(weight), money, profit,
      scorecards: { factories: factories.map((f) => ({ ...f, yield_percent: f.consumed && Number(f.consumed) ? round(new Dec(f.good).div(f.consumed).mul(100), 'percent') : null, reject_percent: f.consumed && Number(f.consumed) ? round(new Dec(f.rejected).div(f.consumed).mul(100), 'percent') : null })), painters: painters.map((p) => ({ ...p, gain_percent: Number(p.raw) ? round(new Dec(p.coated).minus(p.raw).div(p.raw).mul(100), 'percent') : null })) },
      disk_usage_percent: disk, disk_warning: disk !== null && disk > 80,
    };
  });

  /** Period profit: realised per order (complete costs only), ingot/scrap trading, general expenses. Per currency; no cross-currency sums. */
  async function periodProfit(dbx: Db, r: { start?: Date; end?: Date }) {
    let oq = dbx.selectFrom('orders').select(['id', 'number', 'currency']).where('status_sales', '=', 'approved');
    if (r.start) oq = oq.where('order_date', '>=', r.start);
    if (r.end) oq = oq.where('order_date', '<', r.end);
    const orders = await oq.limit(500).execute();
    const perCurrency: Record<string, { estimated: Dec; realised: Dec; collected: Dec; gain_share: Dec }> = {};
    const incomplete: Array<{ id: string; number: string; keys: string[] }> = [];
    for (const o of orders) {
      const c = await orderCosting(dbx, o.id);
      const acc = (perCurrency[o.currency] ??= { estimated: new Dec(0), realised: new Dec(0), collected: new Dec(0), gain_share: new Dec(0) });
      if (c.profit.estimated) acc.estimated = acc.estimated.plus(c.profit.estimated.profit);
      if (c.profit.realised) { acc.realised = acc.realised.plus(c.profit.realised.profit); if (c.profit.split) acc.gain_share = acc.gain_share.plus(c.profit.split.gain_share); }
      else if (c.sales.status === 'final') incomplete.push({ id: o.id, number: o.number, keys: c.incomplete_keys });
      acc.collected = acc.collected.plus(c.profit.collected.net);
    }
    let gq = dbx.selectFrom('documents').select(['currency', sql<string>`COALESCE(SUM(amount),0)`.as('a')]).where('kind', '=', 'expense').where('expense_type', '=', 'general').where('status', '=', 'posted');
    if (r.start) gq = gq.where('date', '>=', r.start);
    if (r.end) gq = gq.where('date', '<', r.end);
    const general = await gq.groupBy('currency').execute();
    // Ingot & scrap trading: posted invoices on material lots − book value of the issued kg (R13).
    let sq = dbx.selectFrom('documents').select(['id', 'currency', 'amount', 'material_lot_id', 'agreed_kg']).where('kind', '=', 'invoice').where('status', '=', 'posted').where('material_lot_id', 'is not', null);
    if (r.start) sq = sq.where('date', '>=', r.start);
    if (r.end) sq = sq.where('date', '<', r.end);
    const scrapSales = await sq.execute();
    const trading: Record<string, Dec> = {};
    for (const s of scrapSales) {
      const cost = await dbx.selectFrom('stock_moves').select(sql<string>`SUM(kg * unit_cost)`.as('v')).where('ref_type', '=', 'sale_dispatch').where('ref_id', '=', s.id).executeTakeFirstOrThrow();
      if (cost.v !== null && s.amount) trading[s.currency] = (trading[s.currency] ?? new Dec(0)).plus(new Dec(s.amount).minus(cost.v));
    }
    return {
      by_currency: Object.entries(perCurrency).map(([cur, v]) => ({ currency: cur, estimated: round(v.estimated, cur as Currency), realised: round(v.realised, cur as Currency), collected: round(v.collected, cur as Currency), coating_gain_share: round(v.gain_share, cur as Currency), trading: trading[cur] ? round(trading[cur]!, cur as Currency) : '0', general_expenses: round(general.find((g) => g.currency === cur)?.a ?? 0, cur as Currency), total: round(v.realised.plus(trading[cur] ?? 0).minus(general.find((g) => g.currency === cur)?.a ?? 0), cur as Currency) })),
      incomplete_orders: incomplete, note: 'جمع ارزها فقط با نرخ و تاریخ نرخ معتبر است؛ این گزارش ارزها را جمع نمی‌زند.',
    };
  }

  // ---- reports table (§15) ----
  const report = (name: string, perm: 'finance.view' | null, build: (q: RangeQ, me: AuthUser) => Promise<{ header: string[]; rows: Cell[][]; items?: unknown }>) => {
    app.get(`/reports/${name}`, async (req: FastifyRequest, reply: FastifyReply) => {
      const me = perm ? requirePermission(req, perm) : requireUser(req);
      const q = rangeQuery.parse(req.query);
      const r = await build(q, me);
      if (q.xlsx) return xlsx(reply, name, r.header, r.rows);
      return { header: r.header, rows: r.rows, items: r.items };
    });
  };

  report('sales', 'finance.view', async (q) => {
    const r = range(q);
    let qb = db.selectFrom('documents').innerJoin('parties', 'parties.id', 'documents.party_id').leftJoin('orders', 'orders.id', 'documents.order_id').select(['documents.id', 'documents.number', 'documents.kind', 'documents.date', 'documents.amount', 'documents.currency', 'parties.name as party', 'parties.country', 'orders.number as order_number']).where('documents.kind', 'in', ['invoice', 'sales_return']).where('documents.status', '=', 'posted').orderBy('documents.date');
    if (r.start) qb = qb.where('documents.date', '>=', r.start);
    if (r.end) qb = qb.where('documents.date', '<', r.end);
    if (q.party_id) qb = qb.where('documents.party_id', '=', q.party_id);
    if (q.currency) qb = qb.where('documents.currency', '=', q.currency);
    if (q.country) qb = qb.where('parties.country', '=', q.country);
    if (q.order_id) qb = qb.where('documents.order_id', '=', q.order_id);
    if (q.product_id) qb = qb.where(sql<SqlBool>`EXISTS (SELECT 1 FROM document_lines dl WHERE dl.document_id = documents.id AND dl.meta->>'product_id' = ${q.product_id})`);
    const rows = await qb.execute();
    const totals: Record<string, Dec> = {};
    for (const x of rows) totals[x.currency] = (totals[x.currency] ?? new Dec(0)).plus(x.kind === 'invoice' ? x.amount ?? 0 : new Dec(x.amount ?? 0).neg());
    return { header: ['شماره', 'نوع', 'تاریخ', 'مشتری', 'کشور', 'سفارش', 'مبلغ', 'ارز'], rows: rows.map((x) => [x.number, x.kind === 'invoice' ? 'فاکتور' : 'برگشت', x.date, x.party, x.country, x.order_number, x.kind === 'invoice' ? x.amount : `-${x.amount}`, x.currency]), items: { totals: Object.fromEntries(Object.entries(totals).map(([c, v]) => [c, round(v, c as Currency)])) } };
  });

  report('receivables', 'finance.view', async (q) => {
    let qb = db.selectFrom('documents').innerJoin('parties', 'parties.id', 'documents.party_id').select(['documents.id', 'documents.number', 'documents.date', 'documents.due_date', 'documents.currency', 'documents.amount', 'parties.name as party', 'parties.id as party_id', sql<string>`documents.amount - (SELECT COALESCE(SUM(COALESCE(a.amount_in_target_currency, a.amount)),0) FROM allocations a JOIN documents f ON f.id = a.from_document_id WHERE a.to_document_id = documents.id AND f.status = 'posted')`.as('remaining')]).where('documents.kind', '=', 'invoice').where('documents.status', '=', 'posted').orderBy('parties.name').orderBy('documents.due_date');
    if (q.party_id) qb = qb.where('documents.party_id', '=', q.party_id);
    if (q.currency) qb = qb.where('documents.currency', '=', q.currency);
    const rows = (await qb.execute()).filter((x) => new Dec(x.remaining).gt(0));
    return { header: ['مشتری', 'فاکتور', 'تاریخ', 'سررسید', 'مبلغ', 'مانده', 'ارز', 'گذشته از سررسید'], rows: rows.map((x) => [x.party, x.number, x.date, x.due_date, x.amount, round(x.remaining, x.currency as Currency), x.currency, x.due_date && x.due_date < new Date() ? 'بله' : 'خیر']), items: rows.map((x) => ({ ...x, remaining: round(x.remaining, x.currency as Currency) })) };
  });

  report('payables', 'finance.view', async (q) => {
    let qb = db.selectFrom('documents').innerJoin('parties', 'parties.id', 'documents.party_id').select(['documents.id', 'documents.number', 'documents.kind', 'documents.date', 'documents.currency', 'documents.amount', 'documents.purchase_kind', 'documents.expense_category', 'documents.source_type', 'parties.name as party', 'parties.id as party_id', sql<string>`documents.amount - (SELECT COALESCE(SUM(COALESCE(a.amount_in_target_currency, a.amount)),0) FROM allocations a JOIN documents f ON f.id = a.from_document_id WHERE a.to_document_id = documents.id AND f.status = 'posted')`.as('remaining')]).where('documents.kind', 'in', ['purchase', 'toll_fee', 'expense']).where('documents.status', '=', 'posted').orderBy('parties.name');
    if (q.party_id) qb = qb.where('documents.party_id', '=', q.party_id);
    if (q.currency) qb = qb.where('documents.currency', '=', q.currency);
    const rows = (await qb.execute()).filter((x) => new Dec(x.remaining).gt(0));
    const type = (x: (typeof rows)[number]) => (x.kind === 'toll_fee' ? (x.source_type === 'coating_run' ? 'اجرت رنگ' : 'اجرت تولید') : x.kind === 'purchase' ? (x.purchase_kind === 'die' ? 'قالب' : x.purchase_kind === 'ingot' || x.purchase_kind === 'billet' ? 'شمش' : 'خرید') : x.expense_category === 'freight' ? 'حمل' : 'هزینه');
    return { header: ['طرف', 'نوع', 'سند', 'تاریخ', 'مبلغ', 'مانده', 'ارز'], rows: rows.map((x) => [x.party, type(x), x.number, x.date, x.amount, round(x.remaining, x.currency as Currency), x.currency]), items: rows.map((x) => ({ ...x, type: type(x), remaining: round(x.remaining, x.currency as Currency) })) };
  });

  report('order-profit', 'finance.view', async (q) => {
    const r = range(q);
    let oq = db.selectFrom('orders').innerJoin('parties', 'parties.id', 'orders.party_id').select(['orders.id', 'orders.number', 'orders.currency', 'parties.name as party']).where('orders.status_sales', '=', 'approved').orderBy('orders.order_date', 'desc').limit(300);
    if (r.start) oq = oq.where('orders.order_date', '>=', r.start);
    if (r.end) oq = oq.where('orders.order_date', '<', r.end);
    if (q.party_id) oq = oq.where('orders.party_id', '=', q.party_id);
    if (q.order_id) oq = oq.where('orders.id', '=', q.order_id);
    const orders = await oq.execute();
    const items = [];
    for (const o of orders) { const c = await orderCosting(db, o.id); items.push({ id: o.id, number: o.number, party: o.party, currency: o.currency, sales: c.sales, total_cost: c.total_cost, cost_incomplete: c.cost_incomplete, profit: c.profit, raw_kg: c.raw_kg, sold_gain_kg: c.sold_gain_kg }); }
    return { header: ['سفارش', 'مشتری', 'ارز', 'فروش', 'وضعیت فروش', 'هزینه', 'وضعیت هزینه', 'سود برآوردی', 'سود قطعی', 'سهم پایه', 'سهم اضافه‌وزن', 'وصول خالص'], rows: items.map((i) => [i.number, i.party, i.currency, i.sales.status === 'final' ? i.sales.invoiced : i.sales.proforma, i.sales.status === 'final' ? 'قطعی' : 'برآوردی', i.total_cost, i.cost_incomplete ? 'هزینه ناقص' : 'کامل', i.profit.estimated?.profit ?? null, i.profit.realised?.profit ?? null, i.profit.split?.base_share ?? null, i.profit.split?.gain_share ?? null, i.profit.collected.net]), items };
  });

  report('coating-gain', 'finance.view', async (q) => {
    let qb = db.selectFrom('coating_run_items').innerJoin('coating_runs', 'coating_runs.id', 'coating_run_items.run_id').innerJoin('bundles', 'bundles.id', 'coating_run_items.bundle_id').innerJoin('parties', 'parties.id', 'coating_runs.party_id')
      .select(['bundles.id', 'bundles.code', 'bundles.status', 'bundles.color', 'coating_runs.number as run', 'parties.name as painter', 'coating_run_items.raw_kg', 'coating_run_items.coated_kg', 'coating_run_items.gain_needs_review', 'coating_run_items.returned_at']).where('coating_run_items.coated_kg', 'is not', null).orderBy('coating_run_items.returned_at', 'desc').limit(1000);
    if (q.party_id) qb = qb.where('coating_runs.party_id', '=', q.party_id);
    if (q.color) qb = qb.where('coating_runs.color_code', '=', q.color);
    const rows = await qb.execute();
    return { header: ['بندیل', 'رنگ', 'رنگکار', 'نوبت', 'خام', 'پوشش‌شده', 'افزایش', 'درصد', 'نیازمند بررسی', 'وضعیت'], rows: rows.map((x) => { const g = new Dec(x.coated_kg!).minus(x.raw_kg); return [x.code, x.color, x.painter, x.run, x.raw_kg, x.coated_kg, round(g, 'weight'), new Dec(x.raw_kg).isZero() ? null : round(g.div(x.raw_kg).mul(100), 'percent'), x.gain_needs_review ? 'بله' : '', x.status === 'consumed' ? 'فروخته‌شده' : 'در انبار']; }), items: rows };
  });

  report('workshops', null, async (q, me) => {
    const finance = can(me, 'finance.view');
    let pq = db.selectFrom('parties').select(['id', 'name', 'roles']).where(sql<SqlBool>`roles && ARRAY['factory','painter','anodizer','smelter']::text[]`).where('merged_into_id', 'is', null);
    if (q.party_id) pq = pq.where('id', '=', q.party_id);
    const parties = await pq.execute();
    const items = [];
    for (const p of parties) {
      const runs = await db.selectFrom('production_runs').select([sql<number>`COUNT(*)::int`.as('runs'), sql<string>`COALESCE(SUM(ingot_consumed_kg),0)`.as('consumed'), sql<string>`COALESCE(SUM(good_kg),0)`.as('good'), sql<string>`COALESCE(SUM(rejected_kg),0)`.as('rejected'), sql<number>`SUM(CASE WHEN due_at IS NOT NULL AND closed_at > due_at THEN 1 ELSE 0 END)::int`.as('late')]).where('factory_party_id', '=', p.id).where('status', '=', 'closed').executeTakeFirstOrThrow();
      const coat = await db.selectFrom('coating_run_items').innerJoin('coating_runs', 'coating_runs.id', 'coating_run_items.run_id').select([sql<string>`COALESCE(SUM(raw_kg),0)`.as('raw'), sql<string>`COALESCE(SUM(coated_kg),0)`.as('coated'), sql<number>`SUM(CASE WHEN qc = 'rejected' THEN 1 ELSE 0 END)::int`.as('rejected')]).where('coating_runs.party_id', '=', p.id).where('coated_kg', 'is not', null).executeTakeFirstOrThrow();
      const money = finance ? await db.selectFrom('documents').select(['currency', 'kind', sql<string>`COALESCE(SUM(amount),0)`.as('a')]).where('party_id', '=', p.id).where('status', '=', 'posted').groupBy(['currency', 'kind']).execute() : [];
      const fees = finance ? await db.selectFrom('documents').select([sql<string>`COALESCE(SUM(amount),0)`.as('a'), sql<string>`COALESCE(SUM(settlement_basis_kg),0)`.as('kg')]).where('party_id', '=', p.id).where('kind', '=', 'toll_fee').where('status', '=', 'posted').executeTakeFirstOrThrow() : null;
      items.push({ ...p, runs: runs.runs, late: runs.late, yield_percent: Number(runs.consumed) ? round(new Dec(runs.good).div(runs.consumed).mul(100), 'percent') : null, reject_percent: Number(runs.consumed) ? round(new Dec(runs.rejected).div(runs.consumed).mul(100), 'percent') : null, coating_gain_percent: Number(coat.raw) ? round(new Dec(coat.coated).minus(coat.raw).div(coat.raw).mul(100), 'percent') : null, coating_rejected: coat.rejected, money, actual_cost_per_kg: fees && Number(fees.kg) ? round(new Dec(fees.a).div(fees.kg), 'TOMAN') : null });
    }
    return { header: ['کارگاه', 'نوبت‌ها', 'تأخیر', 'بازده ٪', 'مردودی ٪', 'افزایش وزن ٪', 'مردودی رنگ', ...(finance ? ['هزینه واقعی هر کیلو'] : [])], rows: items.map((i) => [i.name, i.runs, i.late, i.yield_percent, i.reject_percent, i.coating_gain_percent, i.coating_rejected, ...(finance ? [i.actual_cost_per_kg] : [])]), items };
  });

  report('inventory', null, async (q) => {
    const items = await positionsDetailed(db, { party_id: q.party_id, product_id: q.product_id });
    return { header: ['محل', 'نوع', 'کد/شرح', 'محصول', 'شکل/وضعیت', 'مالک', 'کیلو'], rows: items.map((p) => [p.location_name, p.item_type === 'bundle' ? 'بندیل' : 'مواد', p.item_type === 'bundle' ? String(p.bundle?.code) : String(p.lot?.description ?? p.lot?.kind), p.item_type === 'bundle' ? ((p.bundle?.lines as Array<{ product_name: string }>) ?? []).map((l) => l.product_name).join('، ') : String(p.lot?.alloy ?? ''), p.state, p.owner_party_id ? 'طرف' : 'ویترال', p.kg]), items };
  });

  report('stock-moves', null, async (q) => {
    const r = range(q);
    let qb = db.selectFrom('stock_moves').leftJoin('locations as f', 'f.id', 'stock_moves.from_location_id').leftJoin('locations as t', 't.id', 'stock_moves.to_location_id').leftJoin('bundles', (j) => j.onRef('bundles.id', '=', 'stock_moves.item_id').on('stock_moves.item_type', '=', 'bundle')).select(['stock_moves.at', 'stock_moves.item_type', 'stock_moves.kg', 'stock_moves.state_from', 'stock_moves.state_to', 'stock_moves.ref_type', 'f.name as from_name', 't.name as to_name', 'bundles.code']).orderBy('stock_moves.at', 'desc').limit(5000);
    if (r.start) qb = qb.where('stock_moves.at', '>=', r.start);
    if (r.end) qb = qb.where('stock_moves.at', '<', r.end);
    const rows = await qb.execute();
    return { header: ['زمان', 'نوع', 'کد', 'از', 'به', 'کیلو', 'حالت قبل', 'حالت بعد', 'مرجع'], rows: rows.map((m) => [m.at, m.item_type, m.code, m.from_name, m.to_name, m.kg, m.state_from, m.state_to, m.ref_type]) };
  });

  report('dies', null, async () => {
    const rows = await db.selectFrom('dies').leftJoin('products', 'products.id', 'dies.product_id').leftJoin('locations', 'locations.id', 'dies.location_id').select(['dies.id', 'dies.code', 'dies.status', 'dies.total_produced_kg', 'dies.run_count', 'dies.last_run_at', 'products.code as product_code', 'locations.name as location', sql<number>`(SELECT COUNT(*)::int FROM die_events e WHERE e.die_id = dies.id AND e.kind = 'repair')`.as('repairs'), sql<number>`(SELECT COUNT(*)::int FROM die_events e WHERE e.die_id = dies.id AND e.kind = 'filler_check')`.as('filler_checks')]).orderBy('dies.code').execute();
    return { header: ['قالب', 'محصول', 'وضعیت', 'محل', 'کیلو تجمعی', 'نوبت‌ها', 'آخرین تولید', 'تعمیرها', 'چک فیلر'], rows: rows.map((d) => [d.code, d.product_code, d.status, d.location, d.total_produced_kg, d.run_count, d.last_run_at, d.repairs, d.filler_checks]), items: rows };
  });

  report('materials', 'finance.view', async (q) => {
    const r = range(q);
    let qb = db.selectFrom('stock_moves').innerJoin('material_lots', 'material_lots.id', 'stock_moves.item_id').select(['material_lots.kind', 'stock_moves.ref_type', sql<string>`COALESCE(SUM(kg),0)`.as('kg'), sql<string>`SUM(kg * unit_cost)`.as('value')]).where('stock_moves.item_type', '=', 'material_lot').groupBy(['material_lots.kind', 'stock_moves.ref_type']);
    if (r.start) qb = qb.where('stock_moves.at', '>=', r.start);
    if (r.end) qb = qb.where('stock_moves.at', '<', r.end);
    const rows = await qb.execute();
    return { header: ['ماده', 'نوع گردش', 'کیلو', 'ارزش'], rows: rows.map((x) => [x.kind, x.ref_type, x.kg, x.value]), items: rows };
  });

  report('expenses', 'finance.view', async (q) => {
    const r = range(q);
    let qb = db.selectFrom('documents').leftJoin('parties', 'parties.id', 'documents.party_id').leftJoin('orders', 'orders.id', 'documents.order_id').select(['documents.number', 'documents.date', 'documents.expense_type', 'documents.expense_category', 'documents.amount', 'documents.currency', 'documents.status', 'parties.name as party', 'orders.number as order_number', 'documents.description']).where('documents.kind', '=', 'expense').where('documents.status', '<>', 'void').orderBy('documents.date', 'desc');
    if (r.start) qb = qb.where('documents.date', '>=', r.start);
    if (r.end) qb = qb.where('documents.date', '<', r.end);
    if (q.order_id) qb = qb.where((eb) => eb.or([eb('documents.order_id', '=', q.order_id!), sql<SqlBool>`EXISTS (SELECT 1 FROM expense_shares es WHERE es.document_id = documents.id AND es.order_id = ${q.order_id}::uuid)`]));
    const rows = await qb.execute();
    return { header: ['شماره', 'تاریخ', 'نوع', 'دسته', 'طرف', 'سفارش', 'شرح', 'مبلغ', 'ارز', 'وضعیت'], rows: rows.map((x) => [x.number, x.date, x.expense_type, x.expense_category, x.party, x.order_number, x.description, x.amount, x.currency, x.status]), items: rows };
  });

  /** Generic list export: any permitted list endpoint's rows to xlsx (web passes the columns it shows). */
  app.post('/export/xlsx', async (req, reply) => {
    requireUser(req);
    const body = z.object({ name: z.string().max(60).default('export'), header: z.array(z.string().max(100)).max(50), rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]).nullable()).max(50)).max(5000) }).parse(req.body);
    return xlsx(reply, body.name.replace(/[^\w؀-ۿ-]+/g, '_'), body.header, body.rows as Cell[][]);
  });
}
