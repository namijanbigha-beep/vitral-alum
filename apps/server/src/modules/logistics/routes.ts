import type { FastifyInstance, FastifyRequest } from 'fastify';
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
import { getSetting } from '../../lib/settings.js';
import { IN_TRANSIT, itemBalance, move, type StockState } from '../../lib/stock.js';
import { barsFromPackages, scaleNet } from '../../rules/production.js';
import { splitByWeight } from '../../rules/money.js';
import { formState } from '../bundles/routes.js';
import { lotAverage } from '../materials/routes.js';

const bump = { updated_at: new Date(), version: sql<number>`version + 1` };
const KINDS = ['ingot_in', 'to_production', 'raw_delivery', 'to_coating', 'from_coating', 'between_locations', 'to_customer', 'customer_return', 'scrap_out', 'scrap_in', 'die_move', 'general'] as const;
const STATUSES = ['draft', 'dispatched', 'in_transit', 'at_border', 'partially_received', 'received', 'delivered'] as const;
type TransferRow = Row<'transfers'>;

const lineSchema = z.object({
  bundle_id: uuid.nullable().optional(), material_lot_id: uuid.nullable().optional(), die_id: uuid.nullable().optional(), kg: decimalString.nullable().optional(), bars: z.number().int().min(0).nullable().optional(),
  packages: z.number().int().min(0).nullable().optional(), bars_per_package: z.number().int().min(0).nullable().optional(), length_m: decimalString.nullable().optional(), order_id: uuid.nullable().optional(), order_line_id: uuid.nullable().optional(),
}).refine((l) => [l.bundle_id, l.material_lot_id, l.die_id].filter(Boolean).length === 1, 'هر ردیف دقیقاً یک بندیل، یک پارت مواد یا یک قالب دارد');

const transportFields = {
  transport_mode: optText(40), vehicle_type: optText(80), plate: optText(40), driver_name: optText(120), driver_phone: optText(40), carrier_party_id: uuid.nullable().optional(), waybill_no: optText(80),
  eta: z.string().datetime({ offset: true }).nullable().optional(), border: optText(80), is_export: z.boolean().optional(), consignee: optText(300), destination_country: optText(80), destination_city: optText(80), destination_address: optText(500),
  bill_to_party_id: uuid.nullable().optional(), delivery_term: optText(40), freight_cost: decimalString.nullable().optional(), freight_currency: z.enum(CURRENCIES).optional(), freight_payer: z.enum(['vitral', 'customer', 'party']).nullable().optional(), note: optText(2000),
};
const createSchema = z.object({ kind: z.enum(KINDS), from_location_id: uuid.nullable().optional(), to_location_id: uuid.nullable().optional(), order_ids: z.array(uuid).max(50).optional(), production_run_id: uuid.nullable().optional(), coating_run_id: uuid.nullable().optional(), purchase_document_id: uuid.nullable().optional(), returns_transfer_id: uuid.nullable().optional(), lines: z.array(lineSchema).max(500).default([]), ...transportFields });
const updateSchema = z.object({ ...versionField, from_location_id: uuid.nullable().optional(), to_location_id: uuid.nullable().optional(), order_ids: z.array(uuid).max(50).optional(), lines: z.array(lineSchema).max(500).optional(), ...transportFields });

export function presentTransfer(r: Record<string, unknown>, user?: AuthUser): Record<string, unknown> {
  const t = r as TransferRow & Record<string, unknown>;
  const out: Record<string, unknown> = {
    id: t.id, number: t.number, kind: t.kind, status: t.status, from_location_id: t.from_location_id, from_name: t.from_name, to_location_id: t.to_location_id, to_name: t.to_name, order_ids: t.order_ids, order_numbers: t.order_numbers,
    production_run_id: t.production_run_id, coating_run_id: t.coating_run_id, purchase_document_id: t.purchase_document_id, returns_transfer_id: t.returns_transfer_id, transport_mode: t.transport_mode, vehicle_type: t.vehicle_type, plate: t.plate,
    driver_name: t.driver_name, driver_phone: t.driver_phone, carrier_party_id: t.carrier_party_id, waybill_no: t.waybill_no, departed_at: t.departed_at, eta: t.eta, received_at: t.received_at, receiver_name: t.receiver_name, border: t.border,
    is_export: t.is_export, consignee: t.consignee, destination_country: t.destination_country, destination_city: t.destination_city, destination_address: t.destination_address, bill_to_party_id: t.bill_to_party_id, delivery_term: t.delivery_term,
    freight_cost: t.freight_cost, freight_currency: t.freight_currency, freight_payer: t.freight_payer, freight_document_id: t.freight_document_id, print_count: t.print_count, note: t.note, dispatched_by: t.dispatched_by,
    lines: t.lines, packing: t.packing, scale_tickets: t.scale_tickets, totals: t.totals, documents_policy: t.documents_policy, version: t.version, created_at: t.created_at, updated_at: t.updated_at,
  };
  if (user && !can(user, 'finance.view')) delete out.freight_document_id;
  return out;
}

export async function loadTransfer(db: Db | Trx, id: string) {
  const t = await db.selectFrom('transfers').leftJoin('locations as f', 'f.id', 'transfers.from_location_id').leftJoin('locations as t', 't.id', 'transfers.to_location_id').selectAll('transfers').select(['f.name as from_name', 't.name as to_name']).where('transfers.id', '=', id).executeTakeFirst();
  if (!t) return undefined;
  const lines = await db.selectFrom('transfer_lines').leftJoin('bundles', 'bundles.id', 'transfer_lines.bundle_id').leftJoin('material_lots', 'material_lots.id', 'transfer_lines.material_lot_id').leftJoin('dies', 'dies.id', 'transfer_lines.die_id')
    .selectAll('transfer_lines').select(['bundles.code as bundle_code', 'bundles.form as bundle_form', 'bundles.color as bundle_color', 'material_lots.kind as lot_kind', 'material_lots.description as lot_description', 'dies.code as die_code']).where('transfer_id', '=', id).orderBy('transfer_lines.created_at').execute();
  const packing = await db.selectFrom('packing_lines').leftJoin('products', 'products.id', 'packing_lines.product_id').selectAll('packing_lines').select(['products.code as product_code', 'products.name_fa as product_name', 'products.name_ar as product_name_ar', 'products.name_en as product_name_en']).where('transfer_id', '=', id).orderBy('sort').execute();
  const tickets = await db.selectFrom('scale_tickets').selectAll().where('transfer_id', '=', id).orderBy('created_at').execute();
  const orders = t.order_ids.length ? await db.selectFrom('orders').select(['id', 'number']).where('id', 'in', t.order_ids).execute() : [];
  const kg = lines.reduce((a, l) => (l.kg ? a.plus(l.kg) : a), new Dec(0));
  const received = lines.reduce((a, l) => (l.received_kg ? a.plus(l.received_kg) : a), new Dec(0));
  const policy = (await getSetting<Record<string, string[]>>(db, 'transfer_document_policy')) ?? {};
  return { ...t, lines, packing, scale_tickets: tickets.map(presentTicket), order_numbers: orders.map((o) => o.number), totals: { kg: round(kg, 'weight'), received_kg: round(received, 'weight'), line_count: lines.length, packages: packing.reduce((a, p) => a + p.packages, 0), bars: packing.reduce((a, p) => a + (p.bars ?? 0), 0) }, documents_policy: policy[t.kind] ?? [] };
}

export function presentTicket(r: Record<string, unknown>): Record<string, unknown> {
  const t = r as Row<'scale_tickets'>;
  const net = t.net_direct_kg !== null ? { kg: t.net_direct_kg, gross_only: false } : scaleNet(t.gross_kg, t.tare_kg, t.packaging_kg);
  return { id: t.id, transfer_id: t.transfer_id, production_run_id: t.production_run_id, coating_run_id: t.coating_run_id, stage: t.stage, site: t.site, ticket_no: t.ticket_no, at: t.at, gross_kg: t.gross_kg, tare_kg: t.tare_kg, packaging_kg: t.packaging_kg, net_direct_kg: t.net_direct_kg, net, net_kg: net && !net.gross_only ? net.kg : null, gross_only: net ? net.gross_only : true, status: t.status, approved_for: t.approved_for, approved_by: t.approved_by, approved_at: t.approved_at, file_id: t.file_id, note: t.note, version: t.version, created_at: t.created_at };
}

/** Customer location (one per customer party), created on first delivery. */
export async function customerLocation(trx: Trx, partyId: string, userId: string): Promise<string> {
  const l = await trx.selectFrom('locations').select('id').where('party_id', '=', partyId).where('kind', '=', 'customer').executeTakeFirst();
  if (l) return l.id;
  const p = await trx.selectFrom('parties').select('name').where('id', '=', partyId).executeTakeFirstOrThrow();
  return (await trx.insertInto('locations').values({ name: `مشتری: ${p.name}`, kind: 'customer', party_id: partyId, created_by: userId }).returning('id').executeTakeFirstOrThrow()).id;
}

async function lineWithItem(trx: Trx, l: z.infer<typeof lineSchema>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...l };
  if (l.bundle_id) {
    const b = await trx.selectFrom('bundles').select(['weight_kg', 'draft', 'status']).where('id', '=', l.bundle_id).executeTakeFirst();
    if (!b) throw new AppError('validation', 'بندیل یافت نشد', { bundle_id: 'نامعتبر' });
    if (b.draft) throw new AppError('validation', 'بندیل پیش‌نویس ارسال نمی‌شود');
    out.kg = l.kg ?? b.weight_kg;
  } else if (l.die_id) {
    out.kg = l.kg ?? '0';
  } else if (!l.kg) throw new AppError('validation', 'وزن پارت مواد لازم است', { kg: 'لازم است' });
  return out;
}

export function logisticsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  crudRoutes(app, ctx, {
    table: 'transfers', path: '/transfers', createSchema, updateSchema, idempotent: true, orderBy: 'created_at',
    listSchema: z.object({ kind: z.enum(KINDS).optional(), status: z.enum(STATUSES).optional(), order_id: uuid.optional(), location_id: uuid.optional(), open: boolQuery.optional(), q: z.string().max(60).optional() }),
    present: presentTransfer,
    filter: (qb, q) => {
      if (q.kind) qb = qb.where('transfers.kind', '=', String(q.kind));
      if (q.status) qb = qb.where('transfers.status', '=', String(q.status));
      if (q.open) qb = qb.where('transfers.status', 'not in', ['received', 'delivered']);
      if (q.order_id) qb = qb.where(sql<SqlBool>`${String(q.order_id)}::uuid = ANY(transfers.order_ids)`);
      if (q.location_id) qb = qb.where((eb: ExpressionBuilder<Database, keyof Database>) => eb.or([eb('transfers.from_location_id', '=', String(q.location_id)), eb('transfers.to_location_id', '=', String(q.location_id))]));
      if (q.q) qb = qb.where((eb: ExpressionBuilder<Database, keyof Database>) => eb.or([eb('transfers.number', 'ilike', `%${q.q}%`), eb('transfers.plate', 'ilike', `%${q.q}%`), eb('transfers.driver_name', 'ilike', `%${q.q}%`)]));
      return qb;
    },
    loadOne: (trx, id) => loadTransfer(trx, id),
    beforeCreate: async (trx, input) => {
      const { lines, eta, ...rest } = input as typeof input & { lines: z.infer<typeof lineSchema>[]; eta?: string | null };
      void lines;
      if (rest.kind === 'to_customer' && !(rest.order_ids as string[] | undefined)?.length) throw new AppError('validation', 'ارسال به مشتری باید به سفارش وصل باشد', { order_ids: 'لازم است' });
      if (rest.kind !== 'die_move' && !rest.from_location_id) throw new AppError('validation', 'محل مبدأ لازم است', { from_location_id: 'لازم است' });
      return { ...rest, number: await nextNumber(trx, 'transfer'), eta: eta ? new Date(eta) : null, order_ids: rest.order_ids ?? [] };
    },
    afterCreate: async (trx, row, input, user) => {
      for (const l of (input as { lines: z.infer<typeof lineSchema>[] }).lines) await trx.insertInto('transfer_lines').values({ ...(await lineWithItem(trx, l)), transfer_id: row.id as string, created_by: user.id } as never).execute();
    },
    beforeUpdate: async (trx, before, patch, user) => {
      const { lines, eta, ...rest } = patch as typeof patch & { lines?: z.infer<typeof lineSchema>[]; eta?: string | null };
      const draft = before.status === 'draft';
      if (!draft) {
        for (const k of ['from_location_id', 'lines']) if (k in patch && patch[k] !== undefined) throw new AppError('validation', 'پس از ارسال فقط مشخصات حمل و مقصد تغییر می‌کند');
        if (before.status === 'received' || before.status === 'delivered') for (const k of ['to_location_id', 'order_ids']) if (k in patch) throw new AppError('validation', 'حواله دریافت‌شده تغییر نمی‌کند');
      }
      if (lines) {
        await trx.deleteFrom('transfer_lines').where('transfer_id', '=', before.id as string).execute();
        for (const l of lines) await trx.insertInto('transfer_lines').values({ ...(await lineWithItem(trx, l)), transfer_id: before.id as string, created_by: user.id } as never).execute();
      }
      if (eta !== undefined) rest.eta = eta ? new Date(eta) : null;
      return rest;
    },
  });

  async function act(req: FastifyRequest, name: string, schema: z.ZodTypeAny, work: (trx: Trx, t: TransferRow, me: AuthUser, body: Record<string, unknown>) => Promise<void>) {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ version: z.number().int() }).and(schema).parse(req.body ?? {}) as Record<string, unknown> & { version: number };
    const r = await withIdempotency(db, key, me.id, `POST /transfers/${name}`, async (trx) => {
      const t = await trx.selectFrom('transfers').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!t) throw new AppError('not_found');
      if (t.version !== body.version) throw new AppError('conflict', undefined, undefined, presentTransfer((await loadTransfer(trx, id))!, me));
      await work(trx, t, me, body);
      const after = await trx.selectFrom('transfers').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      await audit(trx, { userId: me.id, entity: 'transfers', entityId: id, action: name, before: { status: t.status }, after: { status: after.status }, reason: (body.reason as string | null) ?? null });
      return { status: 200, body: presentTransfer((await loadTransfer(trx, id))!, me) };
    });
    return r.body;
  }

  /** Dispatch: every line leaves the origin for «در مسیر» (first point of the two-point move, T38). Die moves update the die location directly. */
  app.post('/transfers/:id/dispatch', (req) => act(req, 'dispatch', z.object({ departed_at: z.string().datetime({ offset: true }).optional() }), async (trx, t, me, body) => {
    if (t.status !== 'draft') throw new AppError('validation', 'این حواله قبلاً ارسال شده است');
    const lines = await trx.selectFrom('transfer_lines').selectAll().where('transfer_id', '=', t.id).execute();
    if (!lines.length) throw new AppError('validation', 'حواله بدون ردیف ارسال نمی‌شود');
    const at = body.departed_at ? new Date(String(body.departed_at)) : new Date();
    const transit = await IN_TRANSIT(trx);
    const policy = ((await getSetting<Record<string, string[]>>(trx, 'transfer_document_policy')) ?? {})[t.kind] ?? [];
    if (policy.includes('load_photo')) {
      const photo = await trx.selectFrom('file_links').innerJoin('files', 'files.id', 'file_links.file_id').select('files.id').where('entity', '=', 'transfers').where('entity_id', '=', t.id).where('files.kind', '=', 'load_photo').executeTakeFirst();
      const direct = await trx.selectFrom('files').select('id').where('owner_entity', '=', 'transfers').where('owner_id', '=', t.id).where('kind', '=', 'load_photo').executeTakeFirst();
      if (!photo && !direct) await notifyManagers(trx, { kind: 'missing_document', title: `حواله ${t.number} بدون عکس بار ارسال شد`, entity: 'transfers', entityId: t.id, groupKey: `load_photo:${t.id}` });
    }
    for (const l of lines) {
      if (l.die_id) {
        await trx.updateTable('dies').set({ location_id: t.to_location_id, status: 'in_transit', ...bump }).where('id', '=', l.die_id).execute();
        await trx.insertInto('die_events').values({ die_id: l.die_id, kind: 'moved', detail: `حواله ${t.number}`, created_by: me.id }).execute();
        continue;
      }
      if (!t.from_location_id) throw new AppError('validation', 'محل مبدأ لازم است');
      const itemType = l.bundle_id ? 'bundle' : 'material_lot';
      const itemId = (l.bundle_id ?? l.material_lot_id)!;
      let state: StockState | null = null;
      let unitCost: string | null = null;
      if (l.bundle_id) {
        const b = await trx.selectFrom('bundles').selectAll().where('id', '=', l.bundle_id).forUpdate().executeTakeFirstOrThrow();
        if (b.status !== 'ok' && t.kind !== 'scrap_out') throw new AppError('validation', `بندیل ${b.code} در قرنطینه است و ارسال نمی‌شود`);
        if (b.reserved_order_line_id && t.kind === 'to_customer' && l.order_line_id && b.reserved_order_line_id !== l.order_line_id) throw new AppError('validation', `بندیل ${b.code} برای سفارش دیگری رزرو شده است`);
        if (t.kind === 'to_customer' && !l.order_id) throw new AppError('validation', `ردیف بندیل ${b.code} به سفارش وصل نیست`, { order_id: 'لازم است' });
        state = formState(b.form);
        await trx.updateTable('bundles').set({ location_id: transit, ...bump }).where('id', '=', b.id).execute();
      } else {
        const lot = await trx.selectFrom('material_lots').select('kind').where('id', '=', itemId).executeTakeFirstOrThrow();
        state = lot.kind === 'scrap' ? 'scrap' : lot.kind === 'paint_powder' ? 'paint' : lot.kind === 'tool' ? 'tool' : 'ingot';
        // The lot keeps its book value (R13 moving average) while it travels, so the cost is known at the destination.
        unitCost = (await lotAverage(trx, itemId)).avg;
      }
      await move(trx, { at, item_type: itemType, item_id: itemId, from_location_id: t.from_location_id, to_location_id: transit, kg: l.kg ?? '0', state_from: state, state_to: state, ref_type: 'transfer_dispatch', ref_id: t.id, unit_cost: unitCost, currency: unitCost ? 'TOMAN' : null, userId: me.id });
    }
    await trx.updateTable('transfers').set({ status: t.kind === 'die_move' ? 'received' : 'in_transit', departed_at: at, dispatched_by: me.id, ...(t.kind === 'die_move' ? { received_at: at } : {}), ...bump }).where('id', '=', t.id).execute();
    if (t.kind === 'die_move') for (const l of lines) if (l.die_id) await trx.updateTable('dies').set({ status: 'ready', ...bump }).where('id', '=', l.die_id).where('status', '=', 'in_transit').execute();
    await freightExpense(trx, t, me.id);
  }));

  app.post('/transfers/:id/border', (req) => act(req, 'border', z.object({ border: optText(80) }), async (trx, t, _me, body) => {
    if (t.status !== 'in_transit' && t.status !== 'dispatched') throw new AppError('validation', 'حواله در مسیر نیست');
    await trx.updateTable('transfers').set({ status: 'at_border', border: (body.border as string | null) ?? t.border, ...bump }).where('id', '=', t.id).execute();
  }));

  /**
   * Receive: second point of the move, «در مسیر» → destination with the received kg. A shortfall needs a reason and is
   * written off from transit with that note, so the ledger never shows weight in two places. To-customer lines become «sold».
   */
  app.post('/transfers/:id/receive', (req) => act(req, 'receive', z.object({ received_at: z.string().datetime({ offset: true }).optional(), receiver_name: optText(120), to_location_id: uuid.optional(), lines: z.array(z.object({ line_id: uuid, received_kg: decimalString.optional(), diff_reason: z.enum(['scale_difference', 'packaging', 'shortage', 'partial_unload', 'other']).nullable().optional(), diff_note: optText(500) })).optional() }), async (trx, t, me, body) => {
    if (t.status === 'draft') throw new AppError('validation', 'حواله هنوز ارسال نشده است');
    if (t.status === 'received' || t.status === 'delivered') throw new AppError('validation', 'حواله قبلاً دریافت شده است');
    const at = body.received_at ? new Date(String(body.received_at)) : new Date();
    const transit = await IN_TRANSIT(trx);
    let dest = (body.to_location_id as string | undefined) ?? t.to_location_id;
    if (t.kind === 'to_customer' && !dest) {
      const o = await trx.selectFrom('orders').select('party_id').where('id', '=', t.order_ids[0]!).executeTakeFirstOrThrow();
      dest = await customerLocation(trx, o.party_id, me.id);
    }
    if (!dest) throw new AppError('validation', 'محل مقصد لازم است', { to_location_id: 'لازم است' });
    const lines = await trx.selectFrom('transfer_lines').selectAll().where('transfer_id', '=', t.id).where('received_at', 'is', null).forUpdate().execute();
    const given = new Map((body.lines as Array<{ line_id: string; received_kg?: string; diff_reason?: string | null; diff_note?: string | null }> | undefined)?.map((l) => [l.line_id, l]) ?? []);
    const toReceive = given.size ? lines.filter((l) => given.has(l.id)) : lines;
    if (!toReceive.length) throw new AppError('validation', 'ردیفی برای دریافت نیست');
    for (const l of toReceive) {
      if (l.die_id) { await trx.updateTable('transfer_lines').set({ received_at: at, received_kg: l.kg, ...bump }).where('id', '=', l.id).execute(); continue; }
      const g = given.get(l.id);
      const sent = new Dec(l.kg ?? '0');
      const recv = new Dec(g?.received_kg ?? l.kg ?? '0');
      if (recv.gt(sent)) throw new AppError('validation', `وزن دریافتی (${recv}) از ارسالی (${sent}) بیشتر است؛ اضافه را جداگانه ثبت کنید`, { received_kg: 'بیش از ارسالی' });
      const diff = sent.minus(recv);
      if (diff.gt(0) && !g?.diff_reason) throw new AppError('validation', `اختلاف ${diff.toFixed(3)} کیلوگرم در ردیف دلیل لازم دارد`, { diff_reason: 'لازم است' });
      const itemType = l.bundle_id ? 'bundle' : 'material_lot';
      const itemId = (l.bundle_id ?? l.material_lot_id)!;
      const inTransit = new Dec(await itemBalance(trx, itemType, itemId, transit));
      if (inTransit.lt(sent)) throw new AppError('insufficient_stock', `در مسیر فقط ${inTransit} کیلوگرم از این قلم هست`);
      let stateFrom: StockState = 'ingot';
      let stateTo: StockState = 'ingot';
      let unitCost: string | null = null;
      if (l.bundle_id) {
        const b = await trx.selectFrom('bundles').selectAll().where('id', '=', l.bundle_id).forUpdate().executeTakeFirstOrThrow();
        stateFrom = formState(b.form);
        stateTo = t.kind === 'to_customer' ? 'sold' : stateFrom;
        await trx.updateTable('bundles').set({ location_id: dest, weight_kg: recv.toFixed(3), ...(t.kind === 'to_customer' ? { status: 'consumed', reserved_order_line_id: null } : {}), ...bump }).where('id', '=', b.id).execute();
        if (t.kind === 'to_customer') await trx.updateTable('reservations').set({ status: 'consumed', ...bump }).where('bundle_id', '=', b.id).where('status', '=', 'active').execute();
      } else {
        const lot = await trx.selectFrom('material_lots').select('kind').where('id', '=', itemId).executeTakeFirstOrThrow();
        stateFrom = lot.kind === 'scrap' ? 'scrap' : lot.kind === 'paint_powder' ? 'paint' : lot.kind === 'tool' ? 'tool' : 'ingot';
        stateTo = t.kind === 'to_customer' || t.kind === 'scrap_out' ? 'sold' : stateFrom;
        unitCost = (await lotAverage(trx, itemId)).avg;
      }
      if (recv.gt(0)) await move(trx, { at, item_type: itemType, item_id: itemId, from_location_id: transit, to_location_id: dest, kg: recv.toFixed(3), state_from: stateFrom, state_to: stateTo, ref_type: 'transfer_receive', ref_id: t.id, unit_cost: unitCost, currency: unitCost ? 'TOMAN' : null, userId: me.id });
      if (diff.gt(0)) await move(trx, { at, item_type: itemType, item_id: itemId, from_location_id: transit, to_location_id: null, kg: diff.toFixed(3), state_from: stateFrom, state_to: 'consumed', ref_type: 'transfer_receive', ref_id: t.id, unit_cost: unitCost, currency: unitCost ? 'TOMAN' : null, note: `اختلاف دریافت: ${g?.diff_reason}${g?.diff_note ? ' — ' + g.diff_note : ''}`, userId: me.id });
      await trx.updateTable('transfer_lines').set({ received_at: at, received_kg: recv.toFixed(3), diff_reason: g?.diff_reason ?? null, diff_note: g?.diff_note ?? null, ...bump }).where('id', '=', l.id).execute();
    }
    const pending = await trx.selectFrom('transfer_lines').select('id').where('transfer_id', '=', t.id).where('received_at', 'is', null).executeTakeFirst();
    const status = pending ? 'partially_received' : t.kind === 'to_customer' ? 'delivered' : 'received';
    await trx.updateTable('transfers').set({ status, to_location_id: dest, received_at: pending ? null : at, receiver_name: (body.receiver_name as string | null) ?? t.receiver_name, ...bump }).where('id', '=', t.id).execute();
    if (!pending && t.kind === 'to_customer') {
      const diffs = toReceive.filter((l) => given.get(l.id)?.diff_reason);
      if (diffs.length) await notifyManagers(trx, { kind: 'delivery_difference', title: `تحویل ${t.number} با اختلاف وزن در ${diffs.length} ردیف ثبت شد`, entity: 'transfers', entityId: t.id, groupKey: `diff:${t.id}` });
    }
  }));

  /** Freight paid by Vitral becomes an expense document, split across the transfer's orders by weight (R16). */
  async function freightExpense(trx: Trx, t: TransferRow, userId: string): Promise<void> {
    if (!t.freight_cost || t.freight_payer !== 'vitral' || t.freight_document_id) return;
    const carrier = t.carrier_party_id;
    const expenseType = t.order_ids.length === 1 ? 'order' : t.order_ids.length > 1 ? 'shared' : 'general';
    const doc = await trx.insertInto('documents').values({
      number: await nextNumber(trx, 'expense'), kind: 'expense', party_id: carrier, amount: t.freight_cost, currency: t.freight_currency, status: 'posted', posted_by: userId, posted_at: new Date(), expense_type: expenseType, expense_category: 'freight',
      order_id: expenseType === 'order' ? t.order_ids[0]! : null, transfer_id: t.id, source_type: 'transfer', source_id: t.id, description: `کرایه حمل حواله ${t.number}`, created_by: userId,
    }).returning('id').executeTakeFirstOrThrow();
    if (expenseType === 'shared') {
      const weights = await trx.selectFrom('transfer_lines').select(['order_id', sql<string>`COALESCE(SUM(kg),0)`.as('kg')]).where('transfer_id', '=', t.id).where('order_id', 'is not', null).groupBy('order_id').execute();
      const shares = splitByWeight(t.freight_cost, weights.map((w) => w.kg), t.freight_currency as 'TOMAN');
      for (const [i, w] of weights.entries()) await trx.insertInto('expense_shares').values({ document_id: doc.id, order_id: w.order_id!, amount: shares[i]!, currency: t.freight_currency, weight_kg: w.kg, created_by: userId }).execute();
    }
    await trx.updateTable('transfers').set({ freight_document_id: doc.id, ...bump }).where('id', '=', t.id).execute();
  }

  /** Packing list lines (R04: bars = packages × bars per package; weight per group or per package). */
  app.get('/transfers/:id/packing', async (req) => {
    requireUser(req);
    const { id } = idParam.parse(req.params);
    const t = await loadTransfer(db, id);
    if (!t) throw new AppError('not_found');
    return { items: t.packing, totals: t.totals };
  });

  const packingLine = z.object({ product_id: uuid.nullable().optional(), description: optText(300), order_id: uuid.nullable().optional(), order_line_id: uuid.nullable().optional(), color: optText(60), filler_mm: decimalString.nullable().optional(), length_m: decimalString.nullable().optional(), packages: z.number().int().min(0).default(0), bars_per_package: z.number().int().min(0).nullable().optional(), bars: z.number().int().min(0).nullable().optional(), weight_kg: decimalString.nullable().optional(), weight_mode: z.enum(['group_total', 'per_package']).default('group_total'), is_partial: z.boolean().default(false), gross_kg: decimalString.nullable().optional() });
  app.put('/transfers/:id/packing', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = z.object({ version: z.number().int(), lines: z.array(packingLine).max(300) }).parse(req.body);
    return db.transaction().execute(async (trx) => {
      const t = await trx.selectFrom('transfers').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!t) throw new AppError('not_found');
      if (t.version !== body.version) throw new AppError('conflict', undefined, undefined, presentTransfer((await loadTransfer(trx, id))!, me));
      if (t.status === 'received' || t.status === 'delivered') throw new AppError('validation', 'لیست بسته‌بندی حواله دریافت‌شده تغییر نمی‌کند');
      await trx.deleteFrom('packing_lines').where('transfer_id', '=', id).execute();
      let sort = 0;
      for (const l of body.lines) {
        if (!l.product_id && !l.description) throw new AppError('validation', 'هر ردیف محصول یا شرح دارد', { description: 'لازم است' });
        const bars = l.bars ?? (l.bars_per_package !== null && l.bars_per_package !== undefined ? barsFromPackages(l.packages, l.bars_per_package) : null);
        if (l.is_partial && l.bars !== null && l.bars !== undefined && l.bars_per_package && l.bars > l.packages * l.bars_per_package) throw new AppError('validation', 'تعداد شاخه از ظرفیت بسته‌ها بیشتر است', { bars: 'زیاد' });
        const weight = l.weight_kg === null || l.weight_kg === undefined ? null : l.weight_mode === 'per_package' ? round(new Dec(l.weight_kg).mul(l.packages), 'weight') : l.weight_kg;
        await trx.insertInto('packing_lines').values({ ...l, bars, weight_kg: weight, transfer_id: id, sort: sort++, created_by: me.id }).execute();
      }
      await trx.updateTable('transfers').set(bump).where('id', '=', id).execute();
      await audit(trx, { userId: me.id, entity: 'transfers', entityId: id, action: 'packing', after: { lines: body.lines.length } });
      return presentTransfer((await loadTransfer(trx, id))!, me);
    });
  });

  // ---- scale tickets (R09) ----
  const ticketBase = {
    transfer_id: uuid.nullable().optional(), production_run_id: uuid.nullable().optional(), coating_run_id: uuid.nullable().optional(), stage: z.enum(['origin', 'destination', 'factory_in', 'factory_out', 'painter_in', 'painter_out', 'border']),
    site: optText(120), ticket_no: optText(80), at: z.string().datetime({ offset: true }).nullable().optional(), gross_kg: decimalString.nullable().optional(), tare_kg: decimalString.nullable().optional(), packaging_kg: decimalString.nullable().optional(), net_direct_kg: decimalString.nullable().optional(), file_id: uuid.nullable().optional(), note: optText(1000),
  };
  const ticketStatus = (t: { gross_kg?: unknown; tare_kg?: unknown; net_direct_kg?: unknown }) => (t.net_direct_kg || (t.gross_kg && t.tare_kg) ? 'recorded' : 'needs_completion');
  crudRoutes(app, ctx, {
    table: 'scale_tickets', path: '/scale-tickets', createSchema: z.object(ticketBase), updateSchema: z.object({ ...versionField, ...Object.fromEntries(Object.entries(ticketBase).map(([k, v]) => [k, v.optional()])) }), idempotent: true,
    listSchema: z.object({ transfer_id: uuid.optional(), production_run_id: uuid.optional(), coating_run_id: uuid.optional(), status: z.enum(['needs_completion', 'recorded', 'approved']).optional() }),
    present: presentTicket,
    filter: (qb, q) => {
      for (const k of ['transfer_id', 'production_run_id', 'coating_run_id', 'status'] as const) if (q[k]) qb = qb.where(`scale_tickets.${k}`, '=', String(q[k]));
      return qb;
    },
    beforeCreate: async (_trx, input) => {
      if (!input.transfer_id && !input.production_run_id && !input.coating_run_id) throw new AppError('validation', 'قبض باسکول باید به حواله، نوبت تولید یا نوبت رنگ وصل باشد');
      return { ...input, at: input.at ? new Date(String(input.at)) : new Date(), status: ticketStatus(input) };
    },
    beforeUpdate: async (_trx, before, patch) => {
      if (before.status === 'approved') throw new AppError('validation', 'قبض تأییدشده تغییر نمی‌کند');
      const merged = { ...before, ...patch };
      return { ...patch, ...(patch.at ? { at: new Date(String(patch.at)) } : {}), status: ticketStatus(merged) };
    },
  });

  /** Approve a ticket for a purpose (technical.approve). A gross-only figure cannot be approved for settlement. */
  app.post('/scale-tickets/:id/approve', async (req) => {
    const me = requirePermission(req, 'technical.approve');
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ version: z.number().int(), approved_for: z.array(z.enum(['receipt', 'toll_fee', 'sale'])).min(1) }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /scale-tickets/approve', async (trx) => {
      const t = await trx.selectFrom('scale_tickets').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!t) throw new AppError('not_found');
      if (t.version !== body.version) throw new AppError('conflict', undefined, undefined, presentTicket(t));
      const net = t.net_direct_kg !== null ? { kg: t.net_direct_kg, gross_only: false } : scaleNet(t.gross_kg, t.tare_kg, t.packaging_kg);
      if (!net) throw new AppError('validation', 'قبض ناقص است؛ وزن خالص محاسبه نمی‌شود');
      if (net.gross_only && (body.approved_for.includes('toll_fee') || body.approved_for.includes('sale'))) throw new AppError('validation', 'وزن بدون کسر بسته‌بندی «ناخالص» است و برای تسویه قابل تأیید نیست', { packaging_kg: 'لازم است' });
      const after = await trx.updateTable('scale_tickets').set({ status: 'approved', approved_for: body.approved_for, approved_by: me.id, approved_at: new Date(), ...bump }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      if (t.coating_run_id && body.approved_for.includes('toll_fee')) await trx.updateTable('coating_runs').set({ input_basis: 'scale_ticket', input_basis_kg: net.kg, ...bump }).where('id', '=', t.coating_run_id).where('status', '<>', 'closed').execute();
      await audit(trx, { userId: me.id, entity: 'scale_tickets', entityId: id, action: 'approve', before: t, after });
      return { status: 200, body: presentTicket(after) };
    });
    return r.body;
  });

  /** Weight comparison for a transfer: declared vs origin/destination tickets vs received. */
  app.get('/transfers/:id/weights', async (req) => {
    requireUser(req);
    const { id } = idParam.parse(req.params);
    const t = await loadTransfer(db, id);
    if (!t) throw new AppError('not_found');
    const byStage: Record<string, unknown> = {};
    for (const s of t.scale_tickets) byStage[String(s.stage)] = s.net;
    return { declared_kg: t.totals.kg, received_kg: t.totals.received_kg, tickets: byStage };
  });
}
