import type { FastifyInstance } from 'fastify';
import { CURRENCIES, Dec, decimalString, round } from '@vitral/shared';
import { sql, type SqlBool } from 'kysely';
import type { ExpressionBuilder } from 'kysely';
import type { Database } from '../../db/schema.js';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Db, Trx } from '../../db/index.js';
import type { Row } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { can, requirePermission, requireUser, type AuthUser } from '../../lib/auth.js';
import { crudRoutes, idParam, optText, uuid, versionField, boolQuery } from '../../lib/crud.js';
import { AppError } from '../../lib/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../lib/idempotency.js';
import { nextNumber } from '../../lib/numbering.js';
import { notifyManagers } from '../../lib/notify.js';
import { move, OWN_WAREHOUSE, stockPositions, type StockState } from '../../lib/stock.js';
import { applyIssue, applyReceipt, emptyAvg, productionFee, type AvgState } from '../../rules/index.js';
import { activeContract } from '../contracts/routes.js';

const bump = { updated_at: new Date(), version: sql<number>`version + 1` };
const LOT_KINDS = ['ingot', 'billet', 'scrap', 'paint_powder', 'tool'] as const;
const PURCHASE_KINDS = ['ingot', 'billet', 'scrap', 'paint_powder', 'tool', 'raw_profile', 'finished_profile', 'die', 'other'] as const;

export const lotState = (kind: string): StockState => (kind === 'scrap' ? 'scrap' : kind === 'paint_powder' ? 'paint' : kind === 'tool' ? 'tool' : 'ingot');

export function presentLot(r: Record<string, unknown>, user?: AuthUser): Record<string, unknown> {
  const l = r as Row<'material_lots'> & Record<string, unknown>;
  const out: Record<string, unknown> = { id: l.id, kind: l.kind, alloy: l.alloy, grade: l.grade, batch_no: l.batch_no, owner_party_id: l.owner_party_id, owner_name: l.owner_name, unit: l.unit, kg_per_unit: l.kg_per_unit, description: l.description, tool_class: l.tool_class, responsible_user_id: l.responsible_user_id, positions: l.positions, total_kg: l.total_kg, avg_cost: l.avg_cost, cost_incomplete: l.cost_incomplete, moves: l.moves, version: l.version, created_at: l.created_at };
  if (user && !can(user, 'finance.view')) { delete out.avg_cost; }
  return out;
}

/** Moving average (R13) replayed over the lot's receipts and issues, oldest first. */
export async function lotAverage(db: Db | Trx, lotId: string): Promise<AvgState> {
  // The ledger is append-only: a purchase receipt booked before its price was known keeps unit_cost NULL, and the
  // price later completed on the purchase document values it here (the document is the valuation record).
  const moves = await db.selectFrom('stock_moves')
    .leftJoin('documents as pd', (j) => j.onRef('pd.id', '=', 'stock_moves.ref_id').on('stock_moves.ref_type', '=', 'purchase_receipt').on('pd.kind', '=', 'purchase'))
    .select(['stock_moves.kg', sql<string | null>`COALESCE(stock_moves.unit_cost, pd.unit_price)`.as('unit_cost'), 'stock_moves.to_location_id', 'stock_moves.from_location_id', 'stock_moves.ref_type', sql<string | null>`COALESCE(stock_moves.currency, pd.currency)`.as('currency')])
    .where('stock_moves.item_type', '=', 'material_lot').where('stock_moves.item_id', '=', lotId).orderBy('stock_moves.at').orderBy('stock_moves.created_at').execute();
  let st = emptyAvg();
  for (const m of moves) {
    const inbound = ['purchase_receipt', 'opening', 'smelting_output', 'scrap_conversion'].includes(m.ref_type) && m.to_location_id && !m.from_location_id;
    const outbound = !m.to_location_id && m.from_location_id;
    if (m.ref_type === 'count_adjustment') { if (m.to_location_id && !m.from_location_id) st = applyReceipt(st, m.kg, st.avg); else if (outbound) st = applyIssue(st, m.kg); continue; }
    if (inbound) st = applyReceipt(st, m.kg, m.unit_cost, (m.currency as 'TOMAN') ?? 'TOMAN');
    else if (outbound) st = applyIssue(st, m.kg);
  }
  return st;
}

export async function loadLot(db: Db | Trx, id: string, withMoves = false) {
  const l = await db.selectFrom('material_lots').leftJoin('parties', 'parties.id', 'material_lots.owner_party_id').selectAll('material_lots').select('parties.name as owner_name').where('material_lots.id', '=', id).executeTakeFirst();
  if (!l) return undefined;
  const positions = await stockPositions(db, { item_type: 'material_lot', item_id: id });
  const locs = positions.length ? await db.selectFrom('locations').select(['id', 'name', 'kind']).where('id', 'in', positions.map((p) => p.location_id)).execute() : [];
  const avg = await lotAverage(db, id);
  const moves = withMoves ? await db.selectFrom('stock_moves').leftJoin('locations as f', 'f.id', 'stock_moves.from_location_id').leftJoin('locations as t', 't.id', 'stock_moves.to_location_id').select(['stock_moves.id', 'stock_moves.at', 'stock_moves.kg', 'stock_moves.state_from', 'stock_moves.state_to', 'stock_moves.ref_type', 'stock_moves.ref_id', 'stock_moves.note', 'f.name as from_name', 't.name as to_name']).where('item_type', '=', 'material_lot').where('item_id', '=', id).orderBy('at').execute() : undefined;
  return { ...l, positions: positions.map((p) => ({ ...p, location_name: locs.find((x) => x.id === p.location_id)?.name, location_kind: locs.find((x) => x.id === p.location_id)?.kind })), total_kg: round(positions.reduce((a, p) => a.plus(p.kg), new Dec(0)), 'weight'), avg_cost: avg.avg, cost_incomplete: avg.incomplete, moves };
}

const lotBase = { kind: z.enum(LOT_KINDS), alloy: optText(40), grade: optText(40), batch_no: optText(80), owner_party_id: uuid.nullable().optional(), unit: z.enum(['kg', 'carton', 'piece']).default('kg'), kg_per_unit: decimalString.nullable().optional(), description: optText(500), tool_class: z.enum(['consumable', 'equipment']).nullable().optional(), responsible_user_id: uuid.nullable().optional() };

export function presentPurchase(r: Record<string, unknown>, user?: AuthUser): Record<string, unknown> {
  const d = r as Row<'documents'> & Record<string, unknown>;
  const out: Record<string, unknown> = { id: d.id, number: d.number, kind: d.kind, party_id: d.party_id, party_name: d.party_name, date: d.date, amount: d.amount, currency: d.currency, status: d.status, purchase_kind: d.purchase_kind, material_lot_id: d.material_lot_id, lot: d.lot, agreed_kg: d.agreed_kg, received_kg: d.received_kg, unit_price: d.unit_price, unit_cost: d.unit_price, description: d.description, note: d.note, due_date: d.due_date, file_ids: d.file_ids, source_type: d.source_type, source_id: d.source_id, paid: d.paid, remaining: d.remaining, transfer_id: d.transfer_id, version: d.version, created_at: d.created_at };
  if (user && !can(user, 'finance.view')) { delete out.amount; delete out.paid; delete out.remaining; }
  return out;
}

export async function loadPurchase(db: Db | Trx, id: string) {
  const d = await db.selectFrom('documents').leftJoin('parties', 'parties.id', 'documents.party_id').selectAll('documents').select('parties.name as party_name').where('documents.id', '=', id).where('documents.kind', '=', 'purchase').executeTakeFirst();
  if (!d) return undefined;
  const lot = d.material_lot_id ? await loadLot(db, d.material_lot_id) : null;
  const paid = await db.selectFrom('allocations').select(sql<string>`COALESCE(SUM(amount),0)`.as('a')).where('to_document_id', '=', id).executeTakeFirstOrThrow();
  return { ...d, lot: lot ? presentLot(lot) : null, paid: round(paid.a, d.currency as 'TOMAN'), remaining: d.amount === null ? null : round(new Dec(d.amount).minus(paid.a), d.currency as 'TOMAN') };
}

export function materialRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  crudRoutes(app, ctx, {
    table: 'material_lots', path: '/material-lots', createSchema: z.object(lotBase), updateSchema: z.object({ ...versionField, ...Object.fromEntries(Object.entries(lotBase).map(([k, v]) => [k, v.optional()])) }), idempotent: true,
    listSchema: z.object({ kind: z.enum(LOT_KINDS).optional(), owner_party_id: uuid.optional(), location_id: uuid.optional(), in_stock: boolQuery.optional(), q: z.string().max(80).optional() }),
    present: presentLot,
    filter: (qb, q) => {
      if (q.kind) qb = qb.where('material_lots.kind', '=', String(q.kind));
      if (q.owner_party_id) qb = qb.where('material_lots.owner_party_id', '=', String(q.owner_party_id));
      if (q.q) qb = qb.where((eb: ExpressionBuilder<Database, keyof Database>) => eb.or([eb('material_lots.description', 'ilike', `%${q.q}%`), eb('material_lots.batch_no', 'ilike', `%${q.q}%`), eb('material_lots.alloy', 'ilike', `%${q.q}%`)]));
      if (q.location_id) qb = qb.where(sql<SqlBool>`(SELECT COALESCE(SUM(CASE WHEN to_location_id = ${String(q.location_id)}::uuid THEN kg ELSE 0 END) - SUM(CASE WHEN from_location_id = ${String(q.location_id)}::uuid THEN kg ELSE 0 END),0) FROM stock_moves sm WHERE sm.item_type='material_lot' AND sm.item_id = material_lots.id) > 0`);
      if (q.in_stock) qb = qb.where(sql<SqlBool>`(SELECT COALESCE(SUM(CASE WHEN to_location_id IS NOT NULL THEN kg ELSE 0 END) - SUM(CASE WHEN from_location_id IS NOT NULL THEN kg ELSE 0 END),0) FROM stock_moves sm WHERE sm.item_type='material_lot' AND sm.item_id = material_lots.id) > 0`);
      return qb;
    },
    loadOne: (trx, id) => loadLot(trx, id, true),
    beforeCreate: async (_trx, input) => {
      if (input.unit !== 'kg' && !input.kg_per_unit) throw new AppError('validation', 'برای واحد کارتن/عدد وزن هر واحد لازم است', { kg_per_unit: 'لازم است' });
      return input;
    },
  });

  /** Purchases (documents of kind purchase). Amount = agreed kg × unit price when both known; otherwise «needs_completion». Receipt into stock is separate. */
  const purchaseBase = {
    party_id: uuid, purchase_kind: z.enum(PURCHASE_KINDS), material_lot_id: uuid.nullable().optional(), lot: z.object(lotBase).partial().optional(), agreed_kg: decimalString.nullable().optional(), unit_price: decimalString.nullable().optional(), amount: decimalString.nullable().optional(),
    currency: z.enum(CURRENCIES).default('TOMAN'), date: z.string().datetime({ offset: true }).optional(), due_date: z.string().datetime({ offset: true }).nullable().optional(), description: optText(500), note: optText(2000), file_ids: z.array(uuid).max(20).optional(), order_id: uuid.nullable().optional(),
  };
  app.get('/purchases', async (req) => {
    const me = requireUser(req);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), status: z.enum(['draft', 'reported', 'posted', 'void', 'needs_completion']).optional(), party_id: uuid.optional(), purchase_kind: z.enum(PURCHASE_KINDS).optional(), unreceived: boolQuery.optional() }).parse(req.query);
    let qb = db.selectFrom('documents').leftJoin('parties', 'parties.id', 'documents.party_id').selectAll('documents').select('parties.name as party_name').where('documents.kind', '=', 'purchase').orderBy('documents.date', 'desc').limit(q.limit);
    if (q.status) qb = qb.where('documents.status', '=', q.status);
    if (q.party_id) qb = qb.where('documents.party_id', '=', q.party_id);
    if (q.purchase_kind) qb = qb.where('documents.purchase_kind', '=', q.purchase_kind);
    if (q.unreceived) qb = qb.where(sql<SqlBool>`documents.agreed_kg IS NOT NULL AND documents.received_kg < documents.agreed_kg`);
    return { items: (await qb.execute()).map((d) => presentPurchase(d, me)) };
  });
  app.get('/purchases/:id', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const d = await loadPurchase(db, id);
    if (!d) throw new AppError('not_found');
    return presentPurchase(d, me);
  });
  app.post('/purchases', async (req, reply) => {
    const me = requireUser(req);
    const key = requireIdempotencyKey(req);
    const body = z.object(purchaseBase).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /purchases', async (trx) => {
      let lotId = body.material_lot_id ?? null;
      const material = ['ingot', 'billet', 'scrap', 'paint_powder', 'tool'].includes(body.purchase_kind);
      if (material && !lotId) {
        const lot = await trx.insertInto('material_lots').values({ ...body.lot, kind: body.purchase_kind as (typeof LOT_KINDS)[number], unit: body.lot?.unit ?? 'kg', owner_party_id: null, description: body.lot?.description ?? body.description ?? null, created_by: me.id }).returning('id').executeTakeFirstOrThrow();
        lotId = lot.id;
      }
      const amount = body.amount ?? (body.agreed_kg && body.unit_price ? round(new Dec(body.agreed_kg).mul(body.unit_price), body.currency) : null);
      const unitPrice = body.unit_price ?? (body.amount && body.agreed_kg && !new Dec(body.agreed_kg).isZero() ? round(new Dec(body.amount).div(body.agreed_kg), body.currency) : null);
      const at = body.date ? new Date(body.date) : new Date();
      const d = await trx.insertInto('documents').values({
        number: await nextNumber(trx, 'purchase', at), kind: 'purchase', party_id: body.party_id, amount, currency: body.currency, status: amount === null ? 'needs_completion' : 'draft', purchase_kind: body.purchase_kind, material_lot_id: lotId, agreed_kg: body.agreed_kg ?? null, unit_price: unitPrice,
        date: at, due_date: body.due_date ? new Date(body.due_date) : null, description: body.description ?? null, note: body.note ?? null, file_ids: body.file_ids ?? [], order_id: body.order_id ?? null, created_by: me.id,
      }).returningAll().executeTakeFirstOrThrow();
      await audit(trx, { userId: me.id, entity: 'documents', entityId: d.id, action: 'create', after: d });
      return { status: 201, body: presentPurchase((await loadPurchase(trx, d.id))!, me) };
    });
    return reply.status(r.status).send(r.body);
  });

  /** Complete/edit a purchase before it is posted. */
  app.patch('/purchases/:id', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = z.object({ ...versionField, agreed_kg: decimalString.nullable().optional(), unit_price: decimalString.nullable().optional(), amount: decimalString.nullable().optional(), description: optText(500), note: optText(2000), due_date: z.string().datetime({ offset: true }).nullable().optional(), file_ids: z.array(uuid).max(20).optional(), party_id: uuid.optional() }).parse(req.body);
    return db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('documents').selectAll().where('id', '=', id).where('kind', '=', 'purchase').forUpdate().executeTakeFirst();
      if (!d) throw new AppError('not_found');
      if (d.version !== body.version) throw new AppError('conflict', undefined, undefined, presentPurchase((await loadPurchase(trx, id))!, me));
      if (d.status === 'posted' || d.status === 'void') throw new AppError('validation', 'سند قطعی/باطل تغییر نمی‌کند؛ سند اصلاحی بزنید');
      const agreed = body.agreed_kg !== undefined ? body.agreed_kg : d.agreed_kg;
      let unit = body.unit_price !== undefined ? body.unit_price : d.unit_price;
      let amount = body.amount !== undefined ? body.amount : d.amount;
      if (body.unit_price !== undefined && body.amount === undefined && agreed && unit) amount = round(new Dec(agreed).mul(unit), d.currency as 'TOMAN');
      if (body.amount !== undefined && body.unit_price === undefined && agreed && amount && !new Dec(agreed).isZero()) unit = round(new Dec(amount).div(agreed), d.currency as 'TOMAN');
      const { version, reason, due_date, ...rest } = body;
      void version;
      const after = await trx.updateTable('documents').set({ ...rest, agreed_kg: agreed, unit_price: unit, amount, status: amount === null ? 'needs_completion' : d.status === 'needs_completion' ? 'draft' : d.status, due_date: due_date === undefined ? d.due_date : due_date ? new Date(due_date) : null, ...bump }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      // Receipts already booked at an unknown price are not rewritten (stock_moves is append-only, principle 8):
      // lotAverage values them with the price now on this purchase document.
      await audit(trx, { userId: me.id, entity: 'documents', entityId: id, action: 'update', before: d, after, reason: reason ?? null });
      return presentPurchase((await loadPurchase(trx, id))!, me);
    });
  });

  /** Receive purchased goods into a location (T41). Materials go to the lot; profiles become bundles with source «purchase». */
  app.post('/purchases/:id/receive', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ version: z.number().int(), kg: decimalString.optional(), to_location_id: uuid.optional(), at: z.string().datetime({ offset: true }).optional(), note: optText(500), bundles: z.array(z.object({ code: z.string().trim().min(1).max(60).optional(), weight_kg: decimalString, form: z.enum(['raw', 'painted', 'anodized']).default('raw'), color: optText(60), lines: z.array(z.object({ product_id: uuid, filler_mm: decimalString.nullable().optional(), length_m: decimalString.nullable().optional(), bars: z.number().int().min(0).nullable().optional(), weight_kg: decimalString.nullable().optional(), order_line_id: uuid.nullable().optional() })).min(1) })).optional() }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /purchases/receive', async (trx) => {
      const d = await trx.selectFrom('documents').selectAll().where('id', '=', id).where('kind', '=', 'purchase').forUpdate().executeTakeFirst();
      if (!d) throw new AppError('not_found');
      if (d.version !== body.version) throw new AppError('conflict', undefined, undefined, presentPurchase((await loadPurchase(trx, id))!, me));
      if (d.status === 'void') throw new AppError('validation', 'سند باطل است');
      const to = body.to_location_id ?? (await OWN_WAREHOUSE(trx));
      const at = body.at ? new Date(body.at) : new Date();
      let received = new Dec(0);
      if (d.material_lot_id) {
        if (!body.kg) throw new AppError('validation', 'وزن دریافتی لازم است', { kg: 'لازم است' });
        const lot = await trx.selectFrom('material_lots').selectAll().where('id', '=', d.material_lot_id).executeTakeFirstOrThrow();
        await move(trx, { at, item_type: 'material_lot', item_id: lot.id, from_location_id: null, to_location_id: to, kg: body.kg, state_to: lotState(lot.kind), ref_type: 'purchase_receipt', ref_id: id, unit_cost: d.unit_price, currency: d.currency, note: body.note ?? null, userId: me.id });
        received = new Dec(body.kg);
      } else if (d.purchase_kind === 'raw_profile' || d.purchase_kind === 'finished_profile') {
        if (!body.bundles?.length) throw new AppError('validation', 'بندیل‌های دریافتی لازم است', { bundles: 'لازم است' });
        for (const bd of body.bundles) {
          const code = bd.code ?? `PUR-${d.number}-${received.toFixed(0)}`;
          const b = await trx.insertInto('bundles').values({ code, code_is_temp: !bd.code, location_id: to, factory_party_id: d.party_id, weight_kg: bd.weight_kg, form: bd.form, color: bd.color ?? null, source: 'purchase', warnings: '[]', created_by: me.id }).returning('id').executeTakeFirstOrThrow();
          let sort = 0;
          for (const l of bd.lines) await trx.insertInto('bundle_lines').values({ ...l, bundle_id: b.id, sort: sort++, created_by: me.id }).execute();
          await move(trx, { at, item_type: 'bundle', item_id: b.id, from_location_id: null, to_location_id: to, kg: bd.weight_kg, state_to: bd.form === 'raw' ? 'raw' : 'coated', ref_type: 'purchase_receipt', ref_id: id, unit_cost: d.unit_price, currency: d.currency, userId: me.id });
          received = received.plus(bd.weight_kg);
        }
      } else throw new AppError('validation', 'این نوع خرید دریافت وزنی ندارد');
      const after = await trx.updateTable('documents').set({ received_kg: sql`received_kg + ${received.toFixed(3)}`, ...bump }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      if (d.agreed_kg && new Dec(after.received_kg).gt(new Dec(d.agreed_kg).mul('1.02'))) await notifyManagers(trx, { kind: 'purchase_over_receipt', title: `دریافت خرید ${d.number} (${after.received_kg}) از توافق (${d.agreed_kg}) بیشتر است`, entity: 'documents', entityId: id, groupKey: `over:${id}` });
      await audit(trx, { userId: me.id, entity: 'documents', entityId: id, action: 'receive', before: { received_kg: d.received_kg }, after: { received_kg: after.received_kg, location_id: to } });
      return { status: 200, body: presentPurchase((await loadPurchase(trx, id))!, me) };
    });
    return r.body;
  });

  /** Scrap sale: a draft invoice to a scrap trader plus the weight leaving stock as «sold» (posting is in money). */
  app.post('/scrap/sale', async (req, reply) => {
    const me = requireUser(req);
    const key = requireIdempotencyKey(req);
    const body = z.object({ lot_id: uuid, party_id: uuid, from_location_id: uuid, kg: decimalString, unit_price: decimalString.nullable().optional(), currency: z.enum(CURRENCIES).default('TOMAN'), note: optText(500) }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /scrap/sale', async (trx) => {
      const lot = await trx.selectFrom('material_lots').selectAll().where('id', '=', body.lot_id).executeTakeFirst();
      if (!lot || lot.kind !== 'scrap') throw new AppError('validation', 'پارت ضایعات یافت نشد', { lot_id: 'نامعتبر' });
      const amount = body.unit_price ? round(new Dec(body.kg).mul(body.unit_price), body.currency) : null;
      const d = await trx.insertInto('documents').values({ number: await nextNumber(trx, 'invoice'), kind: 'invoice', party_id: body.party_id, amount, currency: body.currency, status: amount === null ? 'needs_completion' : 'draft', material_lot_id: lot.id, agreed_kg: body.kg, unit_price: body.unit_price ?? null, description: `فروش ضایعات ${body.kg} کیلوگرم`, note: body.note ?? null, created_by: me.id }).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('document_lines').values({ document_id: d.id, description: `ضایعات آلومینیوم${lot.alloy ? ' ' + lot.alloy : ''}`, qty: body.kg, unit: 'kg', unit_price: body.unit_price ?? null, amount: amount ?? '0', created_by: me.id }).execute();
      await move(trx, { item_type: 'material_lot', item_id: lot.id, from_location_id: body.from_location_id, to_location_id: null, kg: body.kg, state_from: 'scrap', state_to: 'sold', ref_type: 'sale_dispatch', ref_id: d.id, userId: me.id });
      await audit(trx, { userId: me.id, entity: 'documents', entityId: d.id, action: 'create', after: d });
      return { status: 201, body: { id: d.id, number: d.number, amount, status: d.status } };
    });
    return reply.status(r.status).send(r.body);
  });

  /**
   * Smelting: scrap lots consumed, one ingot lot produced at the smelter, fee from the smelting contract.
   * Recorded as a closed production run with service «smelting» so the balance (R08) and fee (R07) rules apply unchanged.
   */
  app.post('/smelting', async (req, reply) => {
    const me = requirePermission(req, 'technical.approve');
    const key = requireIdempotencyKey(req);
    const body = z.object({ smelter_party_id: uuid, inputs: z.array(z.object({ lot_id: uuid, from_location_id: uuid, kg: decimalString })).min(1), output_kg: decimalString, alloy: optText(40), to_location_id: uuid.optional(), at: z.string().datetime({ offset: true }).optional(), note: optText(1000) }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /smelting', async (trx) => {
      const loc = await trx.selectFrom('locations').select('id').where('party_id', '=', body.smelter_party_id).where('kind', '=', 'factory').executeTakeFirst();
      if (!loc) throw new AppError('validation', 'این طرف نقش ریخته‌گر ندارد', { smelter_party_id: 'ریخته‌گر نیست' });
      const at = body.at ? new Date(body.at) : new Date();
      const c = await activeContract(trx, body.smelter_party_id, 'smelting', at);
      const inputKg = body.inputs.reduce((a, i) => a.plus(i.kg), new Dec(0));
      const run = await trx.insertInto('production_runs').values({ number: await nextNumber(trx, 'production_run', at), factory_party_id: body.smelter_party_id, location_id: loc.id, service: 'smelting', contract_id: c?.id ?? null, rate_per_kg: c?.rate_per_kg ?? null, rate_currency: c?.currency ?? 'TOMAN', weight_basis: c?.weight_basis ?? null, fixed_fee: c?.fixed_fee ?? null, started_at: at, note: body.note ?? null, created_by: me.id }).returning(['id', 'number']).executeTakeFirstOrThrow();
      let costValue = new Dec(0);
      let incomplete = false;
      for (const i of body.inputs) {
        const avg = await lotAverage(trx, i.lot_id);
        if (avg.avg === null) incomplete = true; else costValue = costValue.plus(new Dec(avg.avg).mul(i.kg));
        await move(trx, { at, item_type: 'material_lot', item_id: i.lot_id, from_location_id: i.from_location_id, to_location_id: null, kg: i.kg, state_from: 'scrap', state_to: 'consumed', ref_type: 'production_consume', ref_id: run.id, unit_cost: avg.avg, userId: me.id });
      }
      const basis = c?.weight_basis === 'good_output' ? body.output_kg : c?.weight_basis === 'input' ? inputKg.toFixed(3) : null;
      const fee = productionFee(c?.rate_per_kg ?? null, basis, c?.fixed_fee ?? null);
      const feeDoc = await trx.insertInto('documents').values({ number: await nextNumber(trx, 'toll_fee', at), kind: 'toll_fee', party_id: body.smelter_party_id, amount: fee, currency: c?.currency ?? 'TOMAN', status: fee === null ? 'needs_completion' : 'posted', posted_by: fee === null ? null : me.id, posted_at: fee === null ? null : at, source_type: 'production_run', source_id: run.id, settlement_basis_kg: basis, unit_price: c?.rate_per_kg ?? null, description: `اجرت ذوب ${run.number}`, created_by: me.id }).returning('id').executeTakeFirstOrThrow();
      if (fee === null) incomplete = true; else costValue = costValue.plus(fee);
      const unitCost = incomplete || new Dec(body.output_kg).isZero() ? null : round(costValue.div(body.output_kg), 'TOMAN');
      const out = await trx.insertInto('material_lots').values({ kind: 'ingot', alloy: body.alloy ?? null, owner_party_id: null, description: `شمش ذوب ${run.number}`, created_by: me.id }).returning('id').executeTakeFirstOrThrow();
      await move(trx, { at, item_type: 'material_lot', item_id: out.id, from_location_id: null, to_location_id: body.to_location_id ?? loc.id, kg: body.output_kg, state_to: 'ingot', ref_type: 'smelting_output', ref_id: run.id, unit_cost: unitCost, currency: 'TOMAN', userId: me.id });
      const loss = inputKg.minus(body.output_kg);
      await trx.updateTable('production_runs').set({ status: 'closed', ingot_consumed_kg: inputKg.toFixed(3), good_kg: body.output_kg, unexplained_kg: loss.toFixed(3), closed_at: at, closed_by: me.id, fee_document_id: feeDoc.id, close_reason: 'افت ذوب', ...bump }).where('id', '=', run.id).execute();
      await audit(trx, { userId: me.id, entity: 'production_runs', entityId: run.id, action: 'smelt', after: { input_kg: inputKg.toFixed(3), output_kg: body.output_kg, loss_kg: loss.toFixed(3), output_lot_id: out.id } });
      return { status: 201, body: { run_id: run.id, number: run.number, output_lot_id: out.id, input_kg: inputKg.toFixed(3), output_kg: body.output_kg, loss_kg: round(loss, 'weight'), loss_percent: inputKg.isZero() ? null : round(loss.div(inputKg).mul(100), 'percent'), fee_incomplete: fee === null } };
    });
    return reply.status(r.status).send(r.body);
  });

  /** Consume paint powder / consumable tools at a location (by units or kg). */
  app.post('/materials/consume', async (req) => {
    const me = requireUser(req);
    const key = requireIdempotencyKey(req);
    const body = z.object({ lot_id: uuid, location_id: uuid, units: decimalString.optional(), kg: decimalString.optional(), ref_type: z.enum(['coating_run', 'general']).default('general'), ref_id: uuid.optional(), note: optText(500) }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /materials/consume', async (trx) => {
      const lot = await trx.selectFrom('material_lots').selectAll().where('id', '=', body.lot_id).executeTakeFirst();
      if (!lot) throw new AppError('not_found');
      if (lot.kind === 'tool' && lot.tool_class === 'equipment') throw new AppError('validation', 'تجهیزات مصرف نمی‌شوند؛ فقط جابه‌جا می‌شوند');
      const kg = body.kg ? new Dec(body.kg) : body.units ? new Dec(body.units).mul(lot.kg_per_unit ?? 0) : null;
      if (!kg || kg.lte(0)) throw new AppError('validation', 'مقدار مصرف لازم است', { kg: 'لازم است' });
      const avg = await lotAverage(trx, lot.id);
      await move(trx, { item_type: 'material_lot', item_id: lot.id, from_location_id: body.location_id, to_location_id: null, kg: kg.toFixed(3), state_from: lotState(lot.kind), state_to: 'consumed', ref_type: 'material_consume', ref_id: body.ref_id ?? lot.id, unit_cost: avg.avg, note: body.note ?? null, userId: me.id });
      return { status: 200, body: presentLot((await loadLot(trx, lot.id))!, me) };
    });
    return r.body;
  });
}
