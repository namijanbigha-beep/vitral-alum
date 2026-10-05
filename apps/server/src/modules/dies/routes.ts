import type { FastifyInstance } from 'fastify';
import { CURRENCIES, decimalString } from '@vitral/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { audit } from '../../lib/audit.js';
import { requirePermission, requireUser, can } from '../../lib/auth.js';
import { crudRoutes, dateOnly, idParam, like, optText, text, uuid, versionField } from '../../lib/crud.js';
import { AppError } from '../../lib/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../lib/idempotency.js';
import { nextNumber } from '../../lib/numbering.js';
import { notifyManagers } from '../../lib/notify.js';
import type { Row } from '../../db/schema.js';

const DIE_STATUS = ['design', 'making', 'ready', 'needs_repair', 'retired'] as const;
const base = {
  code: text(40).min(1),
  name: optText(200),
  product_id: uuid.nullable().optional(),
  owner_party_id: uuid.nullable().optional(),
  location_id: uuid.nullable().optional(),
  compatible_press: optText(100),
  maker_party_id: uuid.nullable().optional(),
  status: z.enum(DIE_STATUS).default('ready'),
  note: optText(2000),
};

export const presentDie = (r: Record<string, unknown>) => {
  const d = r as Row<'dies'>;
  return {
    id: d.id, code: d.code, name: d.name, product_id: d.product_id, owner_party_id: d.owner_party_id, location_id: d.location_id, compatible_press: d.compatible_press,
    maker_party_id: d.maker_party_id, status: d.status, total_produced_kg: d.total_produced_kg, run_count: d.run_count, last_run_at: d.last_run_at, note: d.note, version: d.version, created_at: d.created_at,
  };
};

const STEPS = ['drawing_received', 'quoted', 'ordered', 'delivered', 'trial_run', 'registered'] as const;

export function dieRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  crudRoutes(app, ctx, {
    table: 'dies', path: '/dies',
    createSchema: z.object(base),
    updateSchema: z.object({ ...versionField, ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.optional()])) }),
    listSchema: z.object({ q: z.string().max(100).optional(), product_id: uuid.optional(), status: z.enum([...DIE_STATUS, 'in_transit']).optional(), location_id: uuid.optional() }),
    present: presentDie,
    filter: (qb, q) => {
      if (q.q) qb = qb.where((eb) => eb.or([eb('dies.code', 'ilike', like(String(q.q))), eb('dies.name', 'ilike', like(String(q.q)))]));
      if (q.product_id) qb = qb.where('dies.product_id', '=', String(q.product_id));
      if (q.status) qb = qb.where('dies.status', '=', String(q.status));
      if (q.location_id) qb = qb.where('dies.location_id', '=', String(q.location_id));
      return qb;
    },
    orderBy: 'code',
    beforeUpdate: async (_trx, before, patch) => {
      // Cumulative counters are never overwritten by hand (module 1).
      delete patch.total_produced_kg; delete patch.run_count; delete patch.last_run_at;
      if (patch.location_id && patch.location_id !== before.location_id) throw new AppError('validation', 'جابه‌جایی قالب فقط با بار die_move ثبت می‌شود');
      return patch;
    },
  });

  app.get('/dies/:id/events', async (req) => {
    requireUser(req);
    const { id } = idParam.parse(req.params);
    const items = await db.selectFrom('die_events').selectAll().where('die_id', '=', id).orderBy('at', 'desc').limit(200).execute();
    return { items };
  });

  app.post('/dies/:id/events', async (req, reply) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = z.object({ kind: z.enum(['repair', 'filler_check', 'damage', 'note']), at: z.string().datetime({ offset: true }).optional(), detail: optText(2000), measured_filler_mm: decimalString.nullable().optional(), file_ids: z.array(uuid).max(20).optional() }).parse(req.body);
    const row = await db.transaction().execute(async (trx) => {
      const die = await trx.selectFrom('dies').select('id').where('id', '=', id).executeTakeFirst();
      if (!die) throw new AppError('not_found');
      const r = await trx.insertInto('die_events').values({ die_id: id, kind: body.kind, at: body.at ? new Date(body.at) : new Date(), detail: body.detail ?? null, measured_filler_mm: body.measured_filler_mm ?? null, created_by: me.id }).returningAll().executeTakeFirstOrThrow();
      for (const fid of body.file_ids ?? []) await trx.insertInto('file_links').values({ file_id: fid, entity: 'die_events', entity_id: r.id, created_by: me.id }).onConflict((oc) => oc.doNothing()).execute();
      if (body.kind === 'damage') await trx.updateTable('dies').set({ status: 'needs_repair', updated_at: new Date(), version: sql`version + 1` }).where('id', '=', id).execute();
      await audit(trx, { userId: me.id, entity: 'die_events', entityId: r.id, action: 'create', after: r });
      return r;
    });
    return reply.status(201).send(row);
  });

  // --- die orders (six steps) ---
  const dieOrderBase = {
    customer_party_id: uuid.nullable().optional(), maker_party_id: uuid.nullable().optional(), die_id: uuid.nullable().optional(), order_line_id: uuid.nullable().optional(),
    maker_cost: decimalString.nullable().optional(), currency: z.enum(CURRENCIES).default('TOMAN'), due_date: dateOnly.nullable().optional(), note: optText(2000),
  };
  const presentDieOrder = (r: Record<string, unknown>) => {
    const d = r as Row<'die_orders'>;
    return { id: d.id, number: d.number, customer_party_id: d.customer_party_id, maker_party_id: d.maker_party_id, die_id: d.die_id, order_line_id: d.order_line_id, step: d.step, maker_cost: d.maker_cost, currency: d.currency, due_date: d.due_date, steps: d.steps, purchase_document_id: d.purchase_document_id, note: d.note, version: d.version, created_at: d.created_at };
  };
  crudRoutes(app, ctx, {
    table: 'die_orders', path: '/die-orders',
    createSchema: z.object(dieOrderBase),
    updateSchema: z.object({ ...versionField, ...Object.fromEntries(Object.entries(dieOrderBase).map(([k, v]) => [k, v.optional()])) }),
    present: presentDieOrder,
    idempotent: true,
    beforeCreate: async (trx, input, user) => ({ ...input, number: await nextNumber(trx, 'die_order'), steps: JSON.stringify([{ step: 'drawing_received', at: new Date().toISOString(), by: user.id }]) }),
    beforeUpdate: async (_trx, _before, patch, user) => {
      if (patch.maker_cost !== undefined && !can(user, 'finance.post')) throw new AppError('forbidden', 'هزینه قالب‌ساز فقط با مجوز مالی ثبت می‌شود');
      return patch;
    },
  });

  /** Advance one step; each step records date, user and optional files; steps 3/4 create and post the purchase document. */
  app.post('/die-orders/:id/advance', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ version: z.number().int(), file_ids: z.array(uuid).max(20).optional(), note: optText(1000), location_id: uuid.optional(), owner_party_id: uuid.nullable().optional(), production_run_id: uuid.optional() }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST die-orders/advance', async (trx) => {
      const o = await trx.selectFrom('die_orders').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!o) throw new AppError('not_found');
      if (o.version !== body.version) throw new AppError('conflict', undefined, undefined, presentDieOrder(o));
      const idx = STEPS.indexOf(o.step as (typeof STEPS)[number]);
      const next = STEPS[idx + 1];
      if (!next) throw new AppError('validation', 'سفارش قالب در گام آخر است');
      if (next === 'registered' && me.role !== 'manager') throw new AppError('forbidden', 'ثبت رسمی قالب فقط با مدیر');
      const patch: Record<string, unknown> = { step: next };
      if (next === 'ordered') {
        if (!o.maker_party_id) throw new AppError('validation', 'قالب‌ساز مشخص نیست', { maker_party_id: 'لازم است' });
        const doc = await trx.insertInto('documents').values({
          number: await nextNumber(trx, 'purchase'), kind: 'purchase', party_id: o.maker_party_id, amount: o.maker_cost, currency: o.currency, status: 'draft',
          source_type: 'die_order', source_id: o.id, purchase_kind: 'die', description: `ساخت قالب ${o.number}`, created_by: me.id,
        }).returning('id').executeTakeFirstOrThrow();
        patch.purchase_document_id = doc.id;
      }
      if (next === 'delivered') {
        if (o.purchase_document_id) {
          const doc = await trx.selectFrom('documents').select(['amount']).where('id', '=', o.purchase_document_id).executeTakeFirstOrThrow();
          await trx.updateTable('documents').set({ status: doc.amount === null ? 'needs_completion' : 'posted', posted_by: doc.amount === null ? null : me.id, posted_at: doc.amount === null ? null : new Date(), updated_at: new Date(), version: sql`version + 1` }).where('id', '=', o.purchase_document_id).execute();
        }
        if (o.die_id && body.location_id) await trx.updateTable('dies').set({ location_id: body.location_id, status: 'ready', updated_at: new Date(), version: sql`version + 1` }).where('id', '=', o.die_id).execute();
      }
      if (next === 'registered' && o.die_id) {
        await trx.updateTable('dies').set({ status: 'ready', owner_party_id: body.owner_party_id ?? null, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', o.die_id).execute();
        const die = await trx.selectFrom('dies').select('product_id').where('id', '=', o.die_id).executeTakeFirst();
        if (die?.product_id) await trx.updateTable('products').set({ active: true, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', die.product_id).execute();
      }
      const steps = [...((o.steps as unknown[]) ?? []), { step: next, at: new Date().toISOString(), by: me.id, note: body.note ?? null, file_ids: body.file_ids ?? [], production_run_id: body.production_run_id ?? null }];
      const after = await trx.updateTable('die_orders').set({ ...patch, steps: JSON.stringify(steps), updated_at: new Date(), version: sql`version + 1` }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      for (const fid of body.file_ids ?? []) await trx.insertInto('file_links').values({ file_id: fid, entity: 'die_orders', entity_id: id, created_by: me.id }).onConflict((oc) => oc.doNothing()).execute();
      await audit(trx, { userId: me.id, entity: 'die_orders', entityId: id, action: `step:${next}`, before: o, after });
      if (next === 'delivered') await notifyManagers(trx, { kind: 'die_delivered', title: `قالب ${o.number} تحویل شد`, entity: 'die_orders', entityId: id, groupKey: `die_delivered:${id}` });
      return { status: 200, body: presentDieOrder(after) };
    });
    return r.body;
  });

  void requirePermission;
}
