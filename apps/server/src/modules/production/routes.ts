import type { FastifyInstance } from 'fastify';
import { Dec, decimalString, round } from '@vitral/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { audit } from '../../lib/audit.js';
import { can, requirePermission, requireUser, type AuthUser } from '../../lib/auth.js';
import { crudRoutes, idParam, like, optText, uuid, versionField } from '../../lib/crud.js';
import { AppError } from '../../lib/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../lib/idempotency.js';
import { nextNumber } from '../../lib/numbering.js';
import { notifyManagers } from '../../lib/notify.js';
import { getSetting } from '../../lib/settings.js';
import { itemBalance, move, stockPositions } from '../../lib/stock.js';
import type { Db, Trx } from '../../db/index.js';
import type { Row } from '../../db/schema.js';
import { productionFee, runBalance } from '../../rules/production.js';
import { splitByWeight } from '../../rules/money.js';
import { activeContract } from '../contracts/routes.js';
import { bundleTotalsForRun } from '../bundles/service.js';

const bump = { updated_at: new Date(), version: sql<number>`version + 1` };

export function presentRun(r: Record<string, unknown>, user?: AuthUser): Record<string, unknown> {
  const p = r as Row<'production_runs'> & { lines?: unknown[]; bundle_summary?: unknown; balance?: unknown; factory_name?: string };
  const out: Record<string, unknown> = {
    id: p.id, number: p.number, factory_party_id: p.factory_party_id, factory_name: p.factory_name, location_id: p.location_id, service: p.service, started_at: p.started_at, due_at: p.due_at, contract_id: p.contract_id,
    rate_per_kg: p.rate_per_kg, rate_currency: p.rate_currency, weight_basis: p.weight_basis, fixed_fee: p.fixed_fee, scrap_owner: p.scrap_owner, status: p.status,
    ingot_allocated_kg: p.ingot_allocated_kg, ingot_consumed_kg: p.ingot_consumed_kg, good_kg: p.good_kg, rejected_kg: p.rejected_kg, scrap_kg: p.scrap_kg, returned_material_kg: p.returned_material_kg,
    unexplained_kg: p.unexplained_kg, close_reason: p.close_reason, closed_by: p.closed_by, closed_at: p.closed_at, press: p.press, shift: p.shift, heat_treatment: p.heat_treatment, note: p.note,
    fee_document_id: p.fee_document_id, shortage_document_id: p.shortage_document_id, fee_incomplete: p.rate_per_kg === null || p.weight_basis === null,
    lines: p.lines, bundle_summary: p.bundle_summary, balance: p.balance, version: p.version, created_at: p.created_at,
  };
  if (user && !can(user, 'finance.view')) { delete out.fee_document_id; delete out.shortage_document_id; }
  return out;
}

const lineSchema = z.object({ order_line_id: uuid.nullable().optional(), product_id: uuid, die_id: uuid.nullable().optional(), filler_mm: decimalString.nullable().optional(), length_m: decimalString.nullable().optional(), target_kg: decimalString.nullable().optional(), target_bars: z.number().int().min(0).nullable().optional() });
const base = {
  factory_party_id: uuid, service: z.enum(['extrusion', 'smelting']).default('extrusion'), started_at: z.string().datetime({ offset: true }).optional(), due_at: z.string().datetime({ offset: true }).nullable().optional(),
  ingot_allocated_kg: decimalString.optional(), press: optText(80), shift: optText(40), heat_treatment: optText(80), note: optText(2000),
};

export async function loadRun(db: Db | Trx, id: string) {
  const r = await db.selectFrom('production_runs').leftJoin('parties', 'parties.id', 'production_runs.factory_party_id').selectAll('production_runs').select('parties.name as factory_name').where('production_runs.id', '=', id).executeTakeFirst();
  if (!r) return undefined;
  const lines = await db.selectFrom('production_run_lines').leftJoin('products', 'products.id', 'production_run_lines.product_id').leftJoin('order_lines', 'order_lines.id', 'production_run_lines.order_line_id').leftJoin('orders', 'orders.id', 'order_lines.order_id').selectAll('production_run_lines').select(['products.code as product_code', 'products.name_fa as product_name', 'orders.number as order_number', 'order_lines.min_length_m', 'order_lines.color as order_color']).where('run_id', '=', id).execute();
  const bundle_summary = await bundleTotalsForRun(db, id);
  const threshold = (await getSetting<string>(db, 'production_balance_threshold_percent')) ?? '1';
  const balance = runBalance(r.ingot_consumed_kg, bundle_summary.good_kg, bundle_summary.rejected_kg, r.scrap_kg, r.returned_material_kg, threshold);
  return { ...r, lines, bundle_summary, balance };
}

export function productionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  crudRoutes(app, ctx, {
    table: 'production_runs', path: '/production-runs',
    createSchema: z.object({ ...base, lines: z.array(lineSchema).max(100).default([]) }),
    updateSchema: z.object({ ...versionField, ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.optional()])), lines: z.array(lineSchema).max(100).optional() }),
    listSchema: z.object({ q: z.string().max(100).optional(), status: z.enum(['open', 'closed']).optional(), factory_party_id: uuid.optional(), order_id: uuid.optional() }),
    present: presentRun,
    idempotent: true,
    orderBy: 'started_at',
    filter: (qb, q) => {
      if (q.q) qb = qb.where('production_runs.number', 'ilike', like(String(q.q)));
      if (q.status) qb = qb.where('production_runs.status', '=', String(q.status));
      if (q.factory_party_id) qb = qb.where('production_runs.factory_party_id', '=', String(q.factory_party_id));
      if (q.order_id) qb = qb.where(sql<SqlBool>`EXISTS (SELECT 1 FROM production_run_lines prl JOIN order_lines ol ON ol.id = prl.order_line_id WHERE prl.run_id = production_runs.id AND ol.order_id = ${String(q.order_id)}::uuid)`);
      return qb;
    },
    loadOne: (trx, id) => loadRun(trx, id),
    beforeCreate: async (trx, input) => {
      const { lines, ...rest } = input as typeof input & { lines: z.infer<typeof lineSchema>[] };
      void lines;
      const loc = await trx.selectFrom('locations').select('id').where('party_id', '=', String(rest.factory_party_id)).where('kind', '=', 'factory').executeTakeFirst();
      if (!loc) throw new AppError('validation', 'این طرف نقش کارخانه (یا ریخته‌گر) ندارد', { factory_party_id: 'کارخانه نیست' });
      const c = await activeContract(trx, String(rest.factory_party_id), rest.service === 'smelting' ? 'smelting' : 'extrusion');
      return {
        ...rest, number: await nextNumber(trx, 'production_run'), location_id: loc.id, contract_id: c?.id ?? null,
        rate_per_kg: c?.rate_per_kg ?? null, rate_currency: c?.currency ?? 'TOMAN', weight_basis: c?.weight_basis ?? null, fixed_fee: c?.fixed_fee ?? null, scrap_owner: c?.scrap_owner ?? null, scrap_credit_rate: c?.scrap_credit_rate ?? null,
        started_at: rest.started_at ? new Date(String(rest.started_at)) : new Date(), due_at: rest.due_at ? new Date(String(rest.due_at)) : null,
      };
    },
    afterCreate: async (trx, row, input, user) => {
      for (const l of (input as { lines: z.infer<typeof lineSchema>[] }).lines) await trx.insertInto('production_run_lines').values({ ...l, run_id: row.id as string, created_by: user.id }).execute();
    },
    beforeUpdate: async (trx, before, patch, user) => {
      if (before.status === 'closed') throw new AppError('validation', 'نوبت بسته‌شده ویرایش نمی‌شود');
      const { lines, ...rest } = patch as typeof patch & { lines?: z.infer<typeof lineSchema>[] };
      if (lines) {
        const used = await trx.selectFrom('bundles').select('id').where('production_run_id', '=', before.id as string).executeTakeFirst();
        if (used) throw new AppError('validation', 'ردیف‌های نوبتی که بندیل دارد تغییر نمی‌کند؛ ردیف جدید اضافه کنید');
        await trx.deleteFrom('production_run_lines').where('run_id', '=', before.id as string).execute();
        for (const l of lines) await trx.insertInto('production_run_lines').values({ ...l, run_id: before.id as string, created_by: user.id }).execute();
      }
      delete rest.factory_party_id; delete rest.service;
      if (rest.started_at) rest.started_at = new Date(String(rest.started_at));
      if (rest.due_at) rest.due_at = new Date(String(rest.due_at));
      return rest;
    },
  });

  app.post('/production-runs/:id/lines', async (req, reply) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = lineSchema.parse(req.body);
    const run = await db.selectFrom('production_runs').select('status').where('id', '=', id).executeTakeFirst();
    if (!run) throw new AppError('not_found');
    if (run.status === 'closed') throw new AppError('validation', 'نوبت بسته است');
    const r = await db.insertInto('production_run_lines').values({ ...body, run_id: id, created_by: me.id }).returningAll().executeTakeFirstOrThrow();
    return reply.status(201).send(r);
  });

  /** Ingot available to this run: Vitral-owned ingot/billet lots at the factory location, from the ledger. */
  app.get('/production-runs/:id/ingot', async (req) => {
    requireUser(req);
    const { id } = idParam.parse(req.params);
    const run = await db.selectFrom('production_runs').select(['location_id', 'factory_party_id']).where('id', '=', id).executeTakeFirst();
    if (!run) throw new AppError('not_found');
    return { items: await ingotAtLocation(db, run.location_id) };
  });

  /** Close (technical.approve): R08 balance, ingot consumption, scrap, die counters, toll_fee document (R07), shortage purchase. */
  app.post('/production-runs/:id/close', async (req) => {
    const me = requirePermission(req, 'technical.approve');
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ version: z.number().int(), ingot_consumed_kg: decimalString, scrap_kg: decimalString.default('0'), returned_material_kg: decimalString.default('0'), close_reason: optText(2000), rework_cost: decimalString.nullable().optional() }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /production-runs/close', async (trx) => {
      const run = await trx.selectFrom('production_runs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!run) throw new AppError('not_found');
      if (run.version !== body.version) throw new AppError('conflict', undefined, undefined, presentRun(run));
      if (run.status === 'closed') throw new AppError('validation', 'نوبت قبلاً بسته شده است');
      const drafts = await trx.selectFrom('bundles').select('id').where('production_run_id', '=', id).where('draft', '=', true).executeTakeFirst();
      if (drafts) throw new AppError('validation', 'بندیل پیش‌نویس در این نوبت هست؛ اول قطعی یا حذف کنید');
      const sums = await bundleTotalsForRun(trx, id);
      const threshold = (await getSetting<string>(trx, 'production_balance_threshold_percent')) ?? '1';
      const bal = runBalance(body.ingot_consumed_kg, sums.good_kg, sums.rejected_kg, body.scrap_kg, body.returned_material_kg, threshold)!;
      if (bal.needs_reason && !body.close_reason) {
        throw new AppError('validation', `اختلاف توضیح‌داده‌نشده ${bal.unexplained_kg} کیلوگرم (${bal.unexplained_percent}٪) از آستانه ${threshold}٪ بیشتر است؛ دلیل مکتوب لازم است`, { close_reason: 'لازم است' });
      }

      // Ingot consumption from Vitral's lots at the factory (oldest first); shortfall becomes a proposed purchase from the factory.
      let remaining = new Dec(body.ingot_consumed_kg);
      const lots = await ingotAtLocation(trx, run.location_id);
      let costSum = new Dec(0);
      let costIncomplete = false;
      for (const lot of lots) {
        if (remaining.lte(0)) break;
        const take = Dec.min(remaining, new Dec(lot.kg));
        if (take.lte(0)) continue;
        await move(trx, { item_type: 'material_lot', item_id: lot.item_id, from_location_id: run.location_id, to_location_id: null, kg: take.toFixed(3), state_from: 'ingot', state_to: 'consumed', ref_type: 'production_consume', ref_id: id, unit_cost: lot.avg_cost, currency: 'TOMAN', userId: me.id });
        if (lot.avg_cost === null) costIncomplete = true; else costSum = costSum.plus(take.mul(lot.avg_cost));
        remaining = remaining.minus(take);
      }
      let shortageDocId: string | null = null;
      if (remaining.gt(0)) {
        const lot = await trx.insertInto('material_lots').values({ kind: 'ingot', owner_party_id: null, description: `کسری شمش نوبت ${run.number} (تأمین کارخانه)`, created_by: me.id }).returning('id').executeTakeFirstOrThrow();
        const doc = await trx.insertInto('documents').values({
          number: await nextNumber(trx, 'purchase'), kind: 'purchase', party_id: run.factory_party_id, amount: null, currency: run.rate_currency, status: 'needs_completion', purchase_kind: 'ingot',
          material_lot_id: lot.id, agreed_kg: remaining.toFixed(3), received_kg: remaining.toFixed(3), source_type: 'production_run', source_id: id, description: `خرید پیشنهادی شمش برای کسری نوبت ${run.number}`, created_by: me.id,
        }).returning('id').executeTakeFirstOrThrow();
        shortageDocId = doc.id;
        await move(trx, { item_type: 'material_lot', item_id: lot.id, from_location_id: null, to_location_id: run.location_id, kg: remaining.toFixed(3), state_to: 'ingot', ref_type: 'purchase_receipt', ref_id: doc.id, unit_cost: null, userId: me.id });
        await move(trx, { item_type: 'material_lot', item_id: lot.id, from_location_id: run.location_id, to_location_id: null, kg: remaining.toFixed(3), state_from: 'ingot', state_to: 'consumed', ref_type: 'production_consume', ref_id: id, unit_cost: null, userId: me.id });
        costIncomplete = true;
        await notifyManagers(trx, { kind: 'ingot_shortage', title: `کسری شمش ${round(remaining, 'weight')} کیلو در نوبت ${run.number}؛ قیمت خرید از کارخانه لازم است`, entity: 'documents', entityId: doc.id, groupKey: `shortage:${id}` });
      }

      // Scrap goes to the owner per contract (D3: unknown owner → at the factory, owner «نامشخص», no credit).
      if (new Dec(body.scrap_kg).gt(0)) {
        const owner = run.scrap_owner === 'factory' ? run.factory_party_id : null;
        const lot = await trx.insertInto('material_lots').values({ kind: 'scrap', owner_party_id: owner, description: `ضایعات نوبت ${run.number}${run.scrap_owner ? '' : ' (مالک نامشخص)'}`, created_by: me.id }).returning('id').executeTakeFirstOrThrow();
        await move(trx, { item_type: 'material_lot', item_id: lot.id, from_location_id: null, to_location_id: run.location_id, kg: body.scrap_kg, state_to: 'scrap', ref_type: 'production_output', ref_id: id, owner_party_id: owner, note: run.scrap_owner ? null : 'مالک نامشخص', userId: me.id });
      }

      // Die counters: cumulative, never overwritten.
      const perDie = await trx.selectFrom('bundle_lines').innerJoin('bundles', 'bundles.id', 'bundle_lines.bundle_id').innerJoin('production_run_lines', (j) => j.onRef('production_run_lines.run_id', '=', 'bundles.production_run_id').onRef('production_run_lines.product_id', '=', 'bundle_lines.product_id')).select(['production_run_lines.die_id', sql<string>`SUM(COALESCE(bundle_lines.weight_kg, bundles.weight_kg))`.as('kg')]).where('bundles.production_run_id', '=', id).where('production_run_lines.die_id', 'is not', null).groupBy('production_run_lines.die_id').execute();
      for (const d of perDie) if (d.die_id) await trx.updateTable('dies').set({ total_produced_kg: sql`total_produced_kg + ${d.kg}`, run_count: sql`run_count + 1`, last_run_at: new Date(), ...bump }).where('id', '=', d.die_id).execute();

      // Toll fee (R07): basis from the contract only; NULL → document needs completion.
      const basisKg = run.weight_basis === 'input' ? body.ingot_consumed_kg : run.weight_basis === 'good_output' ? sums.good_kg : null;
      const fee = productionFee(run.rate_per_kg, basisKg, run.fixed_fee);
      const feeDoc = await trx.insertInto('documents').values({
        number: await nextNumber(trx, 'toll_fee'), kind: 'toll_fee', party_id: run.factory_party_id, amount: fee, currency: run.rate_currency, status: fee === null ? 'needs_completion' : 'posted',
        posted_by: fee === null ? null : me.id, posted_at: fee === null ? null : new Date(), source_type: 'production_run', source_id: id, settlement_basis_kg: basisKg, unit_price: run.rate_per_kg,
        description: `اجرت تولید نوبت ${run.number}`, created_by: me.id,
      }).returning('id').executeTakeFirstOrThrow();
      if (fee === null) await notifyManagers(trx, { kind: 'fee_incomplete', title: `اجرت نوبت ${run.number} نرخ یا مبنا ندارد؛ هزینه ناقص`, entity: 'documents', entityId: feeDoc.id, groupKey: `fee:${id}` });

      // Module 4: «برگشت به کارخانه برای تولید مجدد (هزینه دوباره‌کاری به همان نوبت وصل می‌شود)». A rework cost given at close becomes an
      // expense document sourced on this run and shared over the run's orders by weight (R16), unless the contract puts it on the factory.
      let reworkDocId: string | null = null;
      if (body.rework_cost && new Dec(body.rework_cost).gt(0)) {
        const payer = run.contract_id ? (await trx.selectFrom('contracts').select('rework_payer').where('id', '=', run.contract_id).executeTakeFirst())?.rework_payer ?? null : null;
        if (payer !== 'party') reworkDocId = await reworkExpense(trx, run, round(new Dec(body.rework_cost), run.rate_currency as 'TOMAN'), me);
      }

      const after = await trx.updateTable('production_runs').set({
        status: 'closed', ingot_consumed_kg: body.ingot_consumed_kg, good_kg: sums.good_kg, rejected_kg: sums.rejected_kg, scrap_kg: body.scrap_kg, returned_material_kg: body.returned_material_kg,
        unexplained_kg: bal.unexplained_kg, close_reason: body.close_reason ?? null, closed_by: me.id, closed_at: new Date(), fee_document_id: feeDoc.id, shortage_document_id: shortageDocId, ...bump,
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, { userId: me.id, entity: 'production_runs', entityId: id, action: 'close', before: run, after: { ...after, ingot_cost: costIncomplete ? null : costSum.toFixed(), rework_cost: body.rework_cost ?? null, rework_document_id: reworkDocId }, reason: body.close_reason ?? null });
      return { status: 200, body: presentRun((await loadRun(trx, id))!, me) };
    });
    return r.body;
  });

  /** Factory scorecard (module 4): yield, reject %, lateness, run count — closed runs only. */
  app.get('/production-runs/scorecard', async (req) => {
    requireUser(req);
    const rows = await db.selectFrom('production_runs').innerJoin('parties', 'parties.id', 'production_runs.factory_party_id')
      .select(['production_runs.factory_party_id', 'parties.name', sql<number>`COUNT(*)::int`.as('runs'), sql<string>`SUM(ingot_consumed_kg)`.as('consumed'), sql<string>`SUM(good_kg)`.as('good'), sql<string>`SUM(rejected_kg)`.as('rejected'), sql<number>`SUM(CASE WHEN due_at IS NOT NULL AND closed_at > due_at THEN 1 ELSE 0 END)::int`.as('late')])
      .where('production_runs.status', '=', 'closed').groupBy(['production_runs.factory_party_id', 'parties.name']).execute();
    return { items: rows.map((r) => ({ factory_party_id: r.factory_party_id, name: r.name, runs: r.runs, late: r.late, yield_percent: r.consumed && Number(r.consumed) ? round(new Dec(r.good).div(r.consumed).mul(100), 'percent') : null, reject_percent: r.consumed && Number(r.consumed) ? round(new Dec(r.rejected).div(r.consumed).mul(100), 'percent') : null })) };
  });
}

/** Rework expense of a production run: posted by finance.post, otherwise reported for review; split over the run's orders by target kg (R16). */
async function reworkExpense(trx: Trx, run: Row<'production_runs'>, amount: string, me: AuthUser): Promise<string> {
  const perOrder = await trx.selectFrom('production_run_lines').innerJoin('order_lines', 'order_lines.id', 'production_run_lines.order_line_id').select(['order_lines.order_id', sql<string>`COALESCE(SUM(production_run_lines.target_kg),0)`.as('kg')]).where('production_run_lines.run_id', '=', run.id).groupBy('order_lines.order_id').orderBy('order_lines.order_id').execute();
  const expenseType = perOrder.length === 1 ? 'order' : perOrder.length > 1 ? 'shared' : 'general';
  const posted = can(me, 'finance.post');
  const doc = await trx.insertInto('documents').values({
    number: await nextNumber(trx, 'expense'), kind: 'expense', party_id: run.factory_party_id, amount, currency: run.rate_currency, status: posted ? 'posted' : 'reported', posted_by: posted ? me.id : null, posted_at: posted ? new Date() : null, reported_by: me.id,
    expense_type: expenseType, expense_category: 'rework', order_id: expenseType === 'order' ? perOrder[0]!.order_id : null, source_type: 'production_run', source_id: run.id, description: `هزینه دوباره‌کاری نوبت ${run.number}`, created_by: me.id,
  }).returning('id').executeTakeFirstOrThrow();
  if (perOrder.length) {
    const weights = perOrder.some((o) => new Dec(o.kg).gt(0)) ? perOrder.map((o) => o.kg) : perOrder.map(() => '1');
    const shares = splitByWeight(amount, weights, run.rate_currency as 'TOMAN');
    for (const [i, o] of perOrder.entries()) await trx.insertInto('expense_shares').values({ document_id: doc.id, order_id: o.order_id, amount: shares[i]!, currency: run.rate_currency, weight_kg: perOrder.some((x) => new Dec(x.kg).gt(0)) ? o.kg : null, created_by: me.id }).execute();
  }
  if (!posted) await notifyManagers(trx, { kind: 'rework_cost', title: `هزینه دوباره‌کاری نوبت ${run.number} گزارش شد؛ قطعی‌کردن با مالی`, entity: 'documents', entityId: doc.id, groupKey: `rework:${run.id}` });
  return doc.id;
}

/** Vitral-owned ingot/billet lots with a positive balance at a location, with the moving-average unit cost (R13). */
export async function ingotAtLocation(db: Db | Trx, locationId: string): Promise<Array<{ item_id: string; kg: string; avg_cost: string | null; kind: string; alloy: string | null }>> {
  const positions = await stockPositions(db, { location_id: locationId, item_type: 'material_lot' });
  const out: Array<{ item_id: string; kg: string; avg_cost: string | null; kind: string; alloy: string | null }> = [];
  for (const p of positions) {
    if (new Dec(p.kg).lte(0)) continue;
    const lot = await db.selectFrom('material_lots').select(['kind', 'alloy', 'owner_party_id', 'created_at']).where('id', '=', p.item_id).executeTakeFirst();
    if (!lot || (lot.kind !== 'ingot' && lot.kind !== 'billet') || lot.owner_party_id !== null) continue;
    // stock_moves is append-only: a purchase receipt booked before its price was known keeps unit_cost NULL and is
    // valued with the price later completed on its purchase document (same lookup as materials lotAverage).
    const cost = await db
      .selectFrom('stock_moves')
      .leftJoin('documents as pd', (j) => j.onRef('pd.id', '=', 'stock_moves.ref_id').on('stock_moves.ref_type', '=', 'purchase_receipt').on('pd.kind', '=', 'purchase'))
      .select([sql<string>`SUM(stock_moves.kg * COALESCE(stock_moves.unit_cost, pd.unit_price))`.as('v'), sql<string>`SUM(stock_moves.kg)`.as('k'), sql<boolean>`bool_or(COALESCE(stock_moves.unit_cost, pd.unit_price) IS NULL)`.as('unknown')])
      .where('stock_moves.item_type', '=', 'material_lot').where('stock_moves.item_id', '=', p.item_id).where('stock_moves.to_location_id', 'is not', null)
      .where('stock_moves.ref_type', 'in', ['purchase_receipt', 'opening', 'transfer_receive', 'smelting_output', 'count_adjustment'])
      .executeTakeFirstOrThrow();
    const avg = cost.unknown || !cost.k || Number(cost.k) === 0 ? null : round(new Dec(cost.v).div(cost.k), 'TOMAN');
    out.push({ item_id: p.item_id, kg: p.kg, avg_cost: avg, kind: lot.kind, alloy: lot.alloy });
  }
  return out.sort((a, b) => a.item_id.localeCompare(b.item_id));
}

void itemBalance;
