import type { FastifyInstance } from 'fastify';
import { CURRENCIES, Dec, decimalString, round } from '@vitral/shared';
import { sql, type SqlBool, type RawBuilder } from 'kysely';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { audit } from '../../lib/audit.js';
import { can, requirePermission, requireUser, type AuthUser } from '../../lib/auth.js';
import { dateOnly, idParam, like, optText, text, uuid, versionField } from '../../lib/crud.js';
import { AppError } from '../../lib/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../lib/idempotency.js';
import { nextNumber } from '../../lib/numbering.js';
import { notifyManagers } from '../../lib/notify.js';
import { decodeCursor, encodeCursor, listQuery } from '../../lib/pagination.js';
import { getSetting } from '../../lib/settings.js';
import type { Db, Trx } from '../../db/index.js';
import { computeLineQty, computeStatuses, loadLines, NEXT_ACTION_LABELS, orderTotals, postedReceiptsForOrder, presentLine, snapshotOrder, type LineRow, type OrderRow } from './service.js';

const lineSchema = z.object({
  id: uuid.optional(),
  sort: z.number().int().min(0).default(0),
  kind: z.enum(['profile', 'material', 'die_making', 'service']).default('profile'),
  product_id: uuid.nullable().optional(),
  product_filler_id: uuid.nullable().optional(),
  filler_mm: decimalString.nullable().optional(),
  length_m: decimalString.nullable().optional(),
  min_length_m: decimalString.nullable().optional(),
  color: optText(80),
  load_type_label: optText(60),
  weight_g_per_m: decimalString.nullable().optional(),
  calc_mode: z.enum(['from_bars', 'from_weight', 'manual']).default('manual'),
  qty_bars: decimalString.nullable().optional(),
  qty_kg: decimalString.nullable().optional(),
  qty_pieces: z.number().int().min(0).nullable().optional(),
  price_basis: z.enum(['per_kg', 'per_bar', 'per_meter', 'per_piece']).default('per_kg'),
  unit_price: decimalString.nullable().optional(),
  currency: z.enum(CURRENCIES).optional(),
  discount_amount: decimalString.default('0'),
  discount_percent: decimalString.default('0'),
  supply_method: z.enum(['toll_production', 'stock', 'buy_raw_then_paint', 'buy_finished']).nullable().optional(),
  die_id: uuid.nullable().optional(),
  material_kind: z.enum(['ingot', 'billet', 'scrap', 'paint_powder', 'tool']).nullable().optional(),
  coating_gain_estimate_percent: decimalString.nullable().optional(),
  name_ar: optText(200),
  name_en: optText(200),
  description: optText(500),
  file_id: uuid.nullable().optional(),
  note: optText(1000),
});

const orderBase = {
  title: optText(200),
  party_id: uuid,
  currency: z.enum(CURRENCIES).default('TOMAN'),
  settlement_basis: z.enum(['final_net_scale', 'agreed_weight']).default('final_net_scale'),
  prepay_percent: decimalString.nullable().optional(),
  prepay_amount: decimalString.nullable().optional(),
  payment_terms: z.enum(['cash', 'credit']).default('cash'),
  valid_until: dateOnly.nullable().optional(),
  validity_text: optText(500),
  delivery_days: z.number().int().min(0).nullable().optional(),
  due_date: dateOnly.nullable().optional(),
  order_date: dateOnly.optional(),
  destination_country: optText(80),
  destination_city: optText(80),
  destination_address: optText(500),
  owner_user_id: uuid.nullable().optional(),
  invoice_notes: optText(4000),
  internal_note: optText(4000),
  numbering_kind: z.enum(['order', 'wholesale_proforma']).optional(),
};
const createSchema = z.object({ ...orderBase, lines: z.array(lineSchema).max(200).default([]) });
const updateSchema = z.object({ ...versionField, ...Object.fromEntries(Object.entries(orderBase).map(([k, v]) => [k, v.optional()])), lines: z.array(lineSchema).max(200).optional() });

async function resolveLine(trx: Trx, orderCurrency: string, input: z.infer<typeof lineSchema>): Promise<Record<string, unknown>> {
  const l: Record<string, unknown> = { ...input, currency: input.currency ?? orderCurrency };
  delete l.id;
  if (input.kind === 'profile') {
    if (!input.product_id) throw new AppError('validation', 'محصول ردیف لازم است', { product_id: 'لازم است' });
    let weightUnapproved = false;
    if (input.product_filler_id) {
      const f = await trx.selectFrom('product_fillers').selectAll().where('id', '=', input.product_filler_id).executeTakeFirst();
      if (!f || f.product_id !== input.product_id) throw new AppError('validation', 'فیلر با محصول نمی‌خواند', { product_filler_id: 'نامعتبر' });
      l.filler_mm = f.filler_mm;
      if (f.status === 'approved') l.weight_g_per_m = input.weight_g_per_m ?? f.weight_g_per_m;
      else { weightUnapproved = true; l.weight_g_per_m = input.weight_g_per_m ?? null; }
    } else if (input.weight_g_per_m) weightUnapproved = true;
    l.weight_unapproved = weightUnapproved;
    if (!l.weight_g_per_m && input.calc_mode !== 'manual') throw new AppError('validation', 'بدون وزن هر متر فقط حالت دستی ممکن است', { calc_mode: 'فقط دستی' });
    if (!l.length_m) {
      const common = await trx.selectFrom('products').select('common_lengths').where('id', '=', input.product_id).executeTakeFirst();
      l.length_m = common?.common_lengths?.[0] ?? '6';
    }
  }
  const q = computeLineQty({ ...(l as Partial<LineRow>), kind: input.kind, calc_mode: input.calc_mode, weight_g_per_m: (l.weight_g_per_m as string | null) ?? null });
  return { ...l, ...q };
}

const AFTER_APPROVAL_FIELDS = ['product_id', 'product_filler_id', 'qty_kg', 'qty_bars', 'qty_pieces', 'unit_price', 'currency', 'discount_amount', 'discount_percent', 'price_basis', 'length_m', 'color'];

export async function presentOrder(db: Db | Trx, order: OrderRow, user: AuthUser): Promise<Record<string, unknown>> {
  const lines = await loadLines(db, order.id);
  const paid = await postedReceiptsForOrder(db, order.id);
  const totals = orderTotals(order, lines, paid);
  const statuses = await computeStatuses(db, order, lines, totals);
  const party = await db.selectFrom('parties').select(['name', 'name_ar', 'phones', 'address', 'city', 'country']).where('id', '=', order.party_id).executeTakeFirst();
  const owner = order.owner_user_id ? await db.selectFrom('users').select(['name', 'short_name']).where('id', '=', order.owner_user_id).executeTakeFirst() : null;
  const out: Record<string, unknown> = {
    id: order.id, number: order.number, title: order.title, party_id: order.party_id, party, currency: order.currency, settlement_basis: order.settlement_basis,
    prepay_percent: order.prepay_percent, prepay_amount: order.prepay_amount, payment_terms: order.payment_terms, valid_until: order.valid_until, validity_text: order.validity_text,
    delivery_days: order.delivery_days, due_date: order.due_date, order_date: order.order_date, destination_country: order.destination_country, destination_city: order.destination_city, destination_address: order.destination_address,
    owner_user_id: order.owner_user_id, owner, status_sales: order.status_sales, revision: order.revision, approved_by: order.approved_by, approved_at: order.approved_at,
    invoice_notes: order.invoice_notes, internal_note: order.internal_note, archived: order.archived, print_count: order.print_count, cancel_reason: order.cancel_reason,
    lines: lines.map(presentLine), totals, statuses: { ...statuses, next_action_label: statuses.next_action ? NEXT_ACTION_LABELS[statuses.next_action] : null },
    created_at: order.created_at, updated_at: order.updated_at, version: order.version,
  };
  if (!can(user, 'finance.view')) delete out.internal_note;
  return out;
}

export async function orderRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  async function load(trx: Db | Trx, id: string, lock = false): Promise<OrderRow> {
    let q = trx.selectFrom('orders').selectAll().where('id', '=', id);
    if (lock) q = q.forUpdate();
    const o = await q.executeTakeFirst();
    if (!o) throw new AppError('not_found');
    return o;
  }

  app.get('/orders', async (req) => {
    const me = requireUser(req);
    const q = listQuery.extend({ q: z.string().max(100).optional(), status: z.enum(['draft', 'proforma', 'approved', 'cancelled']).optional(), party_id: uuid.optional(), archived: z.enum(['true', 'false']).default('false'), owner: z.enum(['me']).optional() }).parse(req.query);
    let qb = db.selectFrom('orders').innerJoin('parties', 'parties.id', 'orders.party_id').selectAll('orders').select('parties.name as party_name').orderBy('orders.created_at', 'desc').orderBy('orders.id', 'desc').limit(q.limit + 1);
    qb = qb.where('orders.archived', '=', q.archived === 'true');
    if (q.status) qb = qb.where('orders.status_sales', '=', q.status);
    if (q.party_id) qb = qb.where('orders.party_id', '=', q.party_id);
    if (q.owner === 'me') qb = qb.where('orders.owner_user_id', '=', me.id);
    if (q.q) qb = qb.where((eb) => eb.or([eb('orders.number', 'ilike', like(q.q!)), eb('orders.title', 'ilike', like(q.q!)), eb('parties.name', 'ilike', like(q.q!))]));
    const cursor = decodeCursor(q.cursor);
    if (cursor) qb = qb.where(sql<SqlBool>`(orders.created_at, orders.id) < (${new Date(cursor.at)}, ${cursor.id}::uuid)`);
    const rows = await qb.execute();
    const page = rows.slice(0, q.limit);
    const ids = page.map((r) => r.id);
    const lines = ids.length ? await db.selectFrom('order_lines').selectAll().where('order_id', 'in', ids).execute() : [];
    const items = page.map((o) => {
      const ls = lines.filter((l) => l.order_id === o.id);
      const t = orderTotals(o, ls, {});
      return { id: o.id, number: o.number, title: o.title, party_id: o.party_id, party_name: o.party_name, currency: o.currency, status_sales: o.status_sales, due_date: o.due_date, order_date: o.order_date, archived: o.archived, totals: t.totals, total_kg: t.total_kg, line_count: ls.length, created_at: o.created_at, version: o.version };
    });
    const last = page[page.length - 1];
    return { items, next_cursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null };
  });

  app.get('/orders/:id', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    return presentOrder(db, await load(db, id), me);
  });

  app.post('/orders', async (req, reply) => {
    const me = requireUser(req);
    const key = requireIdempotencyKey(req);
    const body = createSchema.parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /orders', async (trx) => {
      const { lines, numbering_kind, ...o } = body as typeof body & { numbering_kind?: 'order' | 'wholesale_proforma' };
      const prepay = o.prepay_percent ?? (await getSetting<string>(trx, 'default_prepay_percent'));
      const deliveryDays = o.delivery_days ?? (await getSetting<number>(trx, 'default_delivery_days'));
      const validity = o.validity_text ?? (await getSetting<string>(trx, 'proforma_validity_text'));
      const notes = o.invoice_notes ?? (await getSetting<string>(trx, 'sales_terms_fa'));
      const order = await trx
        .insertInto('orders')
        .values({ ...o, number: await nextNumber(trx, numbering_kind ?? 'order', o.order_date ? new Date(`${o.order_date}T12:00:00+03:30`) : new Date()), prepay_percent: prepay, delivery_days: deliveryDays, validity_text: validity, invoice_notes: notes, owner_user_id: o.owner_user_id ?? me.id, created_by: me.id })
        .returningAll().executeTakeFirstOrThrow();
      for (const [i, l] of lines.entries()) {
        const v = await resolveLine(trx, order.currency, { ...l, sort: l.sort || i });
        await trx.insertInto('order_lines').values({ ...(v as Record<string, unknown>), order_id: order.id, created_by: me.id } as never).execute();
      }
      await audit(trx, { userId: me.id, entity: 'orders', entityId: order.id, action: 'create', after: order });
      return { status: 201, body: await presentOrder(trx, order, me) };
    });
    return reply.status(r.status).send(r.body);
  });

  /** Draft/proforma: free edit. Approved: changes to price/qty/product/destination create a revision with a reason (T51). */
  app.patch('/orders/:id', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = updateSchema.parse(req.body);
    return db.transaction().execute(async (trx) => {
      const before = await load(trx, id, true);
      if (before.version !== body.version) throw new AppError('conflict', undefined, undefined, await presentOrder(trx, before, me));
      if (before.status_sales === 'cancelled') throw new AppError('validation', 'سفارش لغوشده ویرایش نمی‌شود');
      const { version, reason, lines, ...patch } = body as typeof body & { numbering_kind?: string };
      delete (patch as Record<string, unknown>).numbering_kind;
      void version;
      const beforeLines = await loadLines(trx, id);
      const approved = before.status_sales === 'approved';
      if (approved) {
        if (!can(me, 'sales.approve')) throw new AppError('forbidden', 'تغییر سفارش تأییدشده فقط با مجوز فروش');
        const material = Object.keys(patch).some((k) => ['destination_country', 'destination_city', 'destination_address', 'currency', 'prepay_percent', 'prepay_amount'].includes(k)) || lines !== undefined;
        if (material && !reason) throw new AppError('validation', 'برای تغییر سفارش تأییدشده دلیل لازم است', { reason: 'لازم است' });
        if (material) {
          await trx.insertInto('order_revisions').values({ order_id: id, revision: before.revision, snapshot: JSON.stringify(snapshotOrder(before, beforeLines)), reason: reason ?? null, created_by: me.id }).execute();
          (patch as Record<string, unknown>).revision = before.revision + 1;
        }
      }
      const after = await trx.updateTable('orders').set({ ...(patch as Record<string, unknown>), updated_at: new Date(), version: sql`version + 1` } as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      if (lines) {
        const keep = new Set<string>();
        for (const [i, l] of lines.entries()) {
          const v = await resolveLine(trx, after.currency, { ...l, sort: l.sort || i });
          if (l.id) {
            const existing = beforeLines.find((b) => b.id === l.id);
            if (!existing) throw new AppError('not_found', 'ردیف سفارش پیدا نشد');
            if (approved && !reason && AFTER_APPROVAL_FIELDS.some((k) => String((v as Record<string, unknown>)[k] ?? '') !== String((existing as unknown as Record<string, unknown>)[k] ?? ''))) {
              throw new AppError('validation', 'تغییر ردیف سفارش تأییدشده دلیل لازم دارد', { reason: 'لازم است' });
            }
            await trx.updateTable('order_lines').set({ ...(v as Record<string, unknown>), updated_at: new Date(), version: sql`version + 1` } as never).where('id', '=', l.id).execute();
            keep.add(l.id);
          } else {
            const r = await trx.insertInto('order_lines').values({ ...(v as Record<string, unknown>), order_id: id, created_by: me.id } as never).returning('id').executeTakeFirstOrThrow();
            keep.add(r.id);
          }
        }
        for (const b of beforeLines) {
          if (keep.has(b.id)) continue;
          const used = await trx.selectFrom('bundle_lines').select('id').where('order_line_id', '=', b.id).executeTakeFirst();
          const res = await trx.selectFrom('reservations').select('id').where('order_line_id', '=', b.id).where('status', '=', 'active').executeTakeFirst();
          if (used || res) throw new AppError('validation', 'ردیفی که تولید یا رزرو دارد حذف نمی‌شود');
          await trx.deleteFrom('order_lines').where('id', '=', b.id).execute();
        }
      }
      await audit(trx, { userId: me.id, entity: 'orders', entityId: id, action: approved ? 'revise' : 'update', before: snapshotOrder(before, beforeLines), after: snapshotOrder(after, await loadLines(trx, id)), reason: reason ?? null });
      return presentOrder(trx, after, me);
    });
  });

  app.get('/orders/:id/revisions', async (req) => {
    requireUser(req);
    const { id } = idParam.parse(req.params);
    return { items: await db.selectFrom('order_revisions').selectAll().where('order_id', '=', id).orderBy('revision', 'desc').execute() };
  });

  async function action(req: FastifyRequest, name: string, perm: 'sales.approve' | null, work: (trx: Trx, o: OrderRow, me: AuthUser, body: Record<string, unknown>) => Promise<void>) {
    const me = perm ? requirePermission(req, perm) : requireUser(req);
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ version: z.number().int(), reason: optText(1000) }).passthrough().parse(req.body ?? {});
    const r = await withIdempotency(db, key, me.id, `POST /orders/${name}`, async (trx) => {
      const o = await load(trx, id, true);
      if (o.version !== body.version) throw new AppError('conflict', undefined, undefined, await presentOrder(trx, o, me));
      await work(trx, o, me, body);
      const after = await load(trx, id);
      await audit(trx, { userId: me.id, entity: 'orders', entityId: id, action: name, before: { status_sales: o.status_sales, archived: o.archived }, after: { status_sales: after.status_sales, archived: after.archived }, reason: (body.reason as string | null) ?? null });
      return { status: 200, body: await presentOrder(trx, after, me) };
    });
    return r.body;
  }
  const bump = { updated_at: new Date(), version: sql<number>`version + 1` as RawBuilder<number> };

  app.post('/orders/:id/approve', (req) =>
    action(req, 'approve', 'sales.approve', async (trx, o, me) => {
      if (o.status_sales === 'cancelled') throw new AppError('validation', 'سفارش لغوشده تأیید نمی‌شود');
      const lines = await loadLines(trx, o.id);
      const missing = lines.filter((l) => l.unit_price === null);
      if (missing.length) throw new AppError('validation', 'همه ردیف‌ها باید قیمت داشته باشند تا قیمت قفل شود', { lines: 'قیمت ناقص' });
      await trx.updateTable('orders').set({ status_sales: 'approved', approved_by: me.id, approved_at: new Date(), ...bump }).where('id', '=', o.id).execute();
    }),
  );

  app.post('/orders/:id/request-approval', (req) =>
    action(req, 'request_approval', null, async (trx, o, me) => {
      await notifyManagers(trx, { kind: 'approval_requested', title: `درخواست تأیید سفارش ${o.number} از ${me.name}`, entity: 'orders', entityId: o.id, groupKey: `approval:${o.id}` });
    }),
  );

  app.post('/orders/:id/cancel', (req) =>
    action(req, 'cancel', 'sales.approve', async (trx, o, _me, body) => {
      if (!body.reason) throw new AppError('validation', 'دلیل لغو لازم است', { reason: 'لازم است' });
      const lines = await loadLines(trx, o.id);
      const ids = lines.map((l) => l.id);
      if (ids.length) {
        // Bundles return to free stock; fees and ingot consumption stay (T52).
        await trx.updateTable('reservations').set({ status: 'released', ...bump }).where('order_line_id', 'in', ids).where('status', '=', 'active').execute();
        await trx.updateTable('bundles').set({ reserved_order_line_id: null, ...bump }).where('reserved_order_line_id', 'in', ids).execute();
      }
      await trx.updateTable('orders').set({ status_sales: 'cancelled', cancel_reason: String(body.reason), ...bump }).where('id', '=', o.id).execute();
    }),
  );

  app.post('/orders/:id/archive', (req) => action(req, 'archive', null, async (trx, o) => { await trx.updateTable('orders').set({ archived: !o.archived, ...bump }).where('id', '=', o.id).execute(); }));

  /** Reservation (R17, R18): per-line kg against bundles, row-locked; a whole-order amount is split by remaining need. */
  app.post('/orders/:id/reserve', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ items: z.array(z.object({ order_line_id: uuid, bundle_id: uuid, kg: decimalString.optional() })).min(1).max(200) }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /orders/reserve', async (trx) => {
      const o = await load(trx, id, true);
      if (o.status_sales !== 'approved') throw new AppError('validation', 'رزرو فقط برای سفارش تأییدشده');
      const lines = await loadLines(trx, o.id);
      for (const it of body.items) {
        const line = lines.find((l) => l.id === it.order_line_id);
        if (!line) throw new AppError('not_found', 'ردیف سفارش پیدا نشد');
        const b = await trx.selectFrom('bundles').selectAll().where('id', '=', it.bundle_id).forUpdate().executeTakeFirst();
        if (!b) throw new AppError('not_found', 'بندیل پیدا نشد');
        if (b.status !== 'ok' || b.draft) throw new AppError('validation', `بندیل ${b.code} با وضعیت غیر از سالم قابل رزرو نیست`);
        const bl = await trx.selectFrom('bundle_lines').selectAll().where('bundle_id', '=', b.id).execute();
        const compatible = bl.some((x) => x.product_id === line.product_id && (line.filler_mm === null || x.filler_mm === null || String(x.filler_mm) === String(line.filler_mm)) && (line.min_length_m === null || x.length_m === null || new Dec(x.length_m).gte(line.min_length_m)));
        if (!compatible) throw new AppError('validation', `بندیل ${b.code} با ردیف سفارش سازگار نیست (محصول، فیلر یا حداقل طول)`);
        if (line.color && b.form !== 'raw' && b.color && b.color !== line.color) throw new AppError('validation', `رنگ بندیل ${b.code} با سفارش فرق دارد`);
        const reserved = await trx.selectFrom('reservations').select(sql<string>`COALESCE(SUM(kg),0)`.as('kg')).where('bundle_id', '=', b.id).where('status', '=', 'active').executeTakeFirstOrThrow();
        const free = new Dec(b.weight_kg).minus(reserved.kg);
        const kg = new Dec(it.kg ?? free.toFixed());
        if (kg.lte(0) || kg.gt(free)) throw new AppError('insufficient_stock', `مقدار آزاد بندیل ${b.code} فقط ${round(free, 'weight')} کیلوگرم است`);
        await trx.insertInto('reservations').values({ order_line_id: line.id, bundle_id: b.id, kg: kg.toFixed(3), created_by: me.id }).execute();
        if (kg.eq(b.weight_kg)) await trx.updateTable('bundles').set({ reserved_order_line_id: line.id, ...bump }).where('id', '=', b.id).execute();
      }
      await audit(trx, { userId: me.id, entity: 'orders', entityId: id, action: 'reserve', after: body });
      return { status: 200, body: await presentOrder(trx, o, me) };
    });
    return r.body;
  });

  /** Suggest a split of a whole-order reservation across lines by remaining need (module 3 example 60/40 → 30/20). */
  app.get('/orders/:id/reserve-suggest', async (req) => {
    requireUser(req);
    const { id } = idParam.parse(req.params);
    const { kg } = z.object({ kg: decimalString }).parse(req.query);
    const lines = (await loadLines(db, id)).filter((l) => l.kind === 'profile' && l.qty_kg);
    const ids = lines.map((l) => l.id);
    const res = ids.length ? await db.selectFrom('reservations').select(['order_line_id', sql<string>`SUM(kg)`.as('kg')]).where('order_line_id', 'in', ids).where('status', 'in', ['active', 'consumed']).groupBy('order_line_id').execute() : [];
    const remaining = lines.map((l) => ({ id: l.id, remaining: new Dec(l.qty_kg!).minus(res.find((r) => r.order_line_id === l.id)?.kg ?? 0) }));
    const sum = remaining.reduce((a, r) => a.plus(r.remaining.gt(0) ? r.remaining : 0), new Dec(0));
    if (sum.isZero()) return { items: [] };
    return { items: remaining.map((r) => ({ order_line_id: r.id, remaining_kg: round(r.remaining, 'weight'), suggested_kg: round(new Dec(kg).mul(r.remaining.gt(0) ? r.remaining : 0).div(sum), 'weight') })) };
  });

  app.post('/orders/:id/release', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const { reservation_id } = z.object({ reservation_id: uuid }).parse(req.body);
    return db.transaction().execute(async (trx) => {
      const r = await trx.selectFrom('reservations').selectAll().where('id', '=', reservation_id).forUpdate().executeTakeFirst();
      if (!r || r.status !== 'active') throw new AppError('not_found');
      await trx.updateTable('reservations').set({ status: 'released', ...bump }).where('id', '=', reservation_id).execute();
      if (r.bundle_id) await trx.updateTable('bundles').set({ reserved_order_line_id: null, ...bump }).where('id', '=', r.bundle_id).where('reserved_order_line_id', '=', r.order_line_id).execute();
      await audit(trx, { userId: me.id, entity: 'reservations', entityId: reservation_id, action: 'release', before: r });
      return presentOrder(trx, await load(trx, id), me);
    });
  });

  app.get('/orders/:id/reservations', async (req) => {
    requireUser(req);
    const { id } = idParam.parse(req.params);
    const items = await db.selectFrom('reservations').innerJoin('order_lines', 'order_lines.id', 'reservations.order_line_id').leftJoin('bundles', 'bundles.id', 'reservations.bundle_id').selectAll('reservations').select(['bundles.code as bundle_code', 'bundles.weight_kg as bundle_kg']).where('order_lines.order_id', '=', id).orderBy('reservations.created_at').execute();
    return { items };
  });

  /** Everything linked to the order for the file tabs: runs, coating runs, transfers, documents, files, tasks, notes. */
  app.get('/orders/:id/related', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const lines = await loadLines(db, id);
    const lineIds = lines.map((l) => l.id);
    const runs = lineIds.length ? await db.selectFrom('production_runs').innerJoin('production_run_lines', 'production_run_lines.run_id', 'production_runs.id').select(['production_runs.id', 'production_runs.number', 'production_runs.status', 'production_runs.factory_party_id', 'production_runs.started_at', 'production_runs.good_kg']).where('production_run_lines.order_line_id', 'in', lineIds).distinct().execute() : [];
    const bundles = lineIds.length ? await db.selectFrom('bundles').select(['id', 'code', 'weight_kg', 'form', 'status', 'location_id', 'color', 'reserved_order_line_id']).where((eb) => eb.or([eb('reserved_order_line_id', 'in', lineIds), sql<boolean>`EXISTS (SELECT 1 FROM bundle_lines bl WHERE bl.bundle_id = bundles.id AND bl.order_line_id = ANY(${lineIds}::uuid[]))`])).where('draft', '=', false).execute() : [];
    const bundleIds = bundles.map((b) => b.id);
    const coating = bundleIds.length ? await db.selectFrom('coating_runs').innerJoin('coating_run_items', 'coating_run_items.run_id', 'coating_runs.id').select(['coating_runs.id', 'coating_runs.number', 'coating_runs.status', 'coating_runs.party_id', 'coating_runs.service', 'coating_runs.sent_at']).where('coating_run_items.bundle_id', 'in', bundleIds).distinct().execute() : [];
    const transfers = await db.selectFrom('transfers').select(['id', 'number', 'kind', 'status', 'departed_at', 'received_at', 'to_location_id', 'from_location_id']).where(sql<boolean>`${id}::uuid = ANY(order_ids)`).orderBy('created_at', 'desc').execute();
    let docs = await db.selectFrom('documents').select(['id', 'number', 'kind', 'status', 'amount', 'currency', 'date', 'party_id', 'description', 'created_by']).where('order_id', '=', id).orderBy('date', 'desc').execute();
    if (!can(me, 'finance.view')) docs = docs.filter((d) => ['invoice', 'receipt', 'sales_return'].includes(d.kind) || d.created_by === me.id).map((d) => ({ ...d }));
    const files = await db.selectFrom('file_links').innerJoin('files', 'files.id', 'file_links.file_id').select(['files.id', 'files.kind', 'files.caption', 'files.sensitive', 'files.mime', 'files.created_at', 'file_links.entity', 'file_links.entity_id']).where('file_links.entity', '=', 'orders').where('file_links.entity_id', '=', id).execute();
    const tasks = await db.selectFrom('tasks').select(['id', 'title', 'status', 'due_at', 'assignee_user_id']).where('order_id', '=', id).execute();
    const notes = await db.selectFrom('free_notes').select(['id', 'text', 'status', 'created_at', 'created_by']).where('order_id', '=', id).orderBy('created_at', 'desc').execute();
    return { runs, bundles, coating_runs: coating, transfers, documents: docs, files: files.filter((f) => !f.sensitive || can(me, 'finance.view')), tasks, notes };
  });

  void text;
}
