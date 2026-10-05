import type { FastifyInstance } from 'fastify';
import { Dec, decimalString, round } from '@vitral/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { audit } from '../../lib/audit.js';
import { requirePermission, requireUser } from '../../lib/auth.js';
import { crudRoutes, idParam, like, optText, text, uuid, versionField } from '../../lib/crud.js';
import { AppError } from '../../lib/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../lib/idempotency.js';
import { suggestedWeightPerMeter } from '../../rules/weights.js';
import type { Db, Trx } from '../../db/index.js';
import type { Row } from '../../db/schema.js';

const CATEGORIES = ['light_line', 'facade', 'door_window', 'general', 'misc'] as const;
const base = {
  code: z.string().trim().max(40).optional(),
  name_fa: text(200).min(1, 'نام لازم است'),
  name_ar: optText(200),
  name_en: optText(200),
  category: z.enum(CATEGORIES).nullable().optional(),
  alloy: optText(40),
  section_area_mm2: decimalString.nullable().optional(),
  weight_g_per_m_no_filler: decimalString.nullable().optional(),
  common_lengths: z.array(decimalString).max(20).optional(),
  colors: z.array(text(60)).max(50).optional(),
  drawing_version: optText(40),
  description: optText(2000),
  main_file_id: uuid.nullable().optional(),
};

export function presentProduct(r: Record<string, unknown>): Record<string, unknown> {
  const p = r as Row<'products'> & { fillers?: unknown[]; stock_kg?: string; producible?: boolean; actual_avg?: unknown };
  return {
    id: p.id, code: p.code, name_fa: p.name_fa, name_ar: p.name_ar, name_en: p.name_en, category: p.category, alloy: p.alloy,
    section_area_mm2: p.section_area_mm2, weight_g_per_m_no_filler: p.weight_g_per_m_no_filler,
    suggested_g_per_m: suggestedWeightPerMeter(p.section_area_mm2),
    common_lengths: p.common_lengths, colors: p.colors, drawing_version: p.drawing_version, description: p.description, main_file_id: p.main_file_id,
    active: p.active, fillers: p.fillers, stock_kg: p.stock_kg, producible: p.producible, created_at: p.created_at, updated_at: p.updated_at, version: p.version,
  };
}

export function presentFiller(r: Record<string, unknown>): Record<string, unknown> {
  const f = r as Row<'product_fillers'> & { actual_avg_g_per_m?: string | null; sample_count?: number };
  return {
    id: f.id, product_id: f.product_id, filler_mm: f.filler_mm, weight_g_per_m: f.weight_g_per_m, source: f.source, sample_length_m: f.sample_length_m,
    sample_weight_kg: f.sample_weight_kg, status: f.status, approved_by: f.approved_by, approved_at: f.approved_at, note: f.note,
    actual_avg_g_per_m: f.actual_avg_g_per_m ?? null, sample_count: f.sample_count ?? 0, version: f.version, created_at: f.created_at,
  };
}

async function nextProductCode(trx: Trx): Promise<string> {
  const r = await trx.selectFrom('products').select(sql<string>`MAX(CASE WHEN code ~ '^P[0-9]+$' THEN substring(code from 2)::int ELSE 0 END)`.as('m')).executeTakeFirstOrThrow();
  return `P${String(Number(r.m ?? 0) + 1).padStart(4, '0')}`;
}

/** Fillers with the actual average g/m from bundles of this product+filler (module 1). */
export async function fillersWithActual(db: Db | Trx, productId: string): Promise<Record<string, unknown>[]> {
  const fillers = await db.selectFrom('product_fillers').selectAll().where('product_id', '=', productId).orderBy('filler_mm').orderBy('created_at').execute();
  const actual = await db
    .selectFrom('bundle_lines')
    .innerJoin('bundles', 'bundles.id', 'bundle_lines.bundle_id')
    .select(['bundle_lines.filler_mm', sql<string>`AVG((COALESCE(bundle_lines.weight_kg, bundles.weight_kg) - COALESCE(bundles.packaging_kg, 0)) / NULLIF(bundle_lines.bars * bundle_lines.length_m, 0) * 1000)`.as('avg'), sql<number>`COUNT(*)::int`.as('n')])
    .where('bundle_lines.product_id', '=', productId)
    .where('bundles.draft', '=', false)
    .where('bundles.form', '=', 'raw')
    .where('bundle_lines.bars', '>', 0)
    .where(sql`(SELECT COUNT(*) FROM bundle_lines bl2 WHERE bl2.bundle_id = bundles.id)`, '=', 1)
    .groupBy('bundle_lines.filler_mm')
    .execute();
  return fillers.map((f) => {
    const a = actual.find((x) => (x.filler_mm ?? null) === (f.filler_mm ?? null));
    return presentFiller({ ...f, actual_avg_g_per_m: a?.avg ? round(a.avg, 'g_per_m') : null, sample_count: a?.n ?? 0 });
  });
}

export async function productRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;
  crudRoutes(app, ctx, {
    table: 'products',
    path: '/products',
    createSchema: z.object(base),
    updateSchema: z.object({ ...versionField, ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.optional()])), active: z.boolean().optional() }),
    listSchema: z.object({ q: z.string().max(100).optional(), category: z.enum(CATEGORIES).optional(), active: z.enum(['true', 'false']).optional(), color: z.string().max(60).optional(), filler: z.string().max(10).optional(), in_stock: z.enum(['true']).optional() }),
    present: presentProduct,
    filter: (qb, q) => {
      if (q.q) qb = qb.where((eb) => eb.or([eb('products.name_fa', 'ilike', like(String(q.q))), eb('products.code', 'ilike', like(String(q.q))), eb('products.name_en', 'ilike', like(String(q.q)))]));
      if (q.category) qb = qb.where('products.category', '=', String(q.category));
      if (q.active) qb = qb.where('products.active', '=', q.active === 'true');
      if (q.color) qb = qb.where(sql<SqlBool>`${String(q.color)} = ANY(products.colors)`);
      if (q.filler) qb = qb.where(sql<SqlBool>`EXISTS (SELECT 1 FROM product_fillers pf WHERE pf.product_id = products.id AND pf.filler_mm = ${String(q.filler)}::numeric)`);
      if (q.in_stock) qb = qb.where(sql<SqlBool>`EXISTS (SELECT 1 FROM bundle_lines bl JOIN bundles b ON b.id = bl.bundle_id WHERE bl.product_id = products.id AND b.status = 'ok' AND b.draft = false AND b.reserved_order_line_id IS NULL)`);
      return qb;
    },
    orderBy: 'code',
    beforeCreate: async (trx, input) => ({ ...input, code: input.code || (await nextProductCode(trx)) }),
    loadOne: async (trx, id) => {
      const p = await trx.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirst();
      if (!p) return undefined;
      const fillers = await fillersWithActual(trx, id);
      const stock = await trx
        .selectFrom('bundle_lines')
        .innerJoin('bundles', 'bundles.id', 'bundle_lines.bundle_id')
        .select(sql<string>`COALESCE(SUM(COALESCE(bundle_lines.weight_kg, bundles.weight_kg)), 0)`.as('kg'))
        .where('bundle_lines.product_id', '=', id)
        .where('bundles.status', '=', 'ok')
        .where('bundles.draft', '=', false)
        .executeTakeFirstOrThrow();
      const die = await trx.selectFrom('dies').select('id').where('product_id', '=', id).where('status', '=', 'ready').executeTakeFirst();
      return { ...p, fillers, stock_kg: round(stock.kg, 'weight'), producible: !!die };
    },
  });

  // Catalogue cards: products with fillers, stock and producible flags in one query set (no N+1).
  app.get('/products/catalog', async (req) => {
    requireUser(req);
    const q = z.object({ q: z.string().max(100).optional(), category: z.enum(CATEGORIES).optional(), limit: z.coerce.number().int().min(1).max(100).default(100) }).parse(req.query);
    let pq = db.selectFrom('products').selectAll().where('active', '=', true).orderBy('code').limit(q.limit);
    if (q.q) pq = pq.where((eb) => eb.or([eb('name_fa', 'ilike', like(q.q!)), eb('code', 'ilike', like(q.q!))]));
    if (q.category) pq = pq.where('category', '=', q.category);
    const products = await pq.execute();
    const ids = products.map((p) => p.id);
    if (!ids.length) return { items: [] };
    const fillers = await db.selectFrom('product_fillers').selectAll().where('product_id', 'in', ids).where('status', '=', 'approved').execute();
    const stock = await db
      .selectFrom('bundle_lines').innerJoin('bundles', 'bundles.id', 'bundle_lines.bundle_id')
      .select(['bundle_lines.product_id', sql<string>`SUM(COALESCE(bundle_lines.weight_kg, bundles.weight_kg))`.as('kg')])
      .where('bundle_lines.product_id', 'in', ids).where('bundles.status', '=', 'ok').where('bundles.draft', '=', false).where('bundles.reserved_order_line_id', 'is', null)
      .groupBy('bundle_lines.product_id').execute();
    const dies = await db.selectFrom('dies').select('product_id').where('product_id', 'in', ids).where('status', '=', 'ready').execute();
    return {
      items: products.map((p) =>
        presentProduct({
          ...p,
          fillers: fillers.filter((f) => f.product_id === p.id).map(presentFiller),
          stock_kg: round(stock.find((s) => s.product_id === p.id)?.kg ?? '0', 'weight'),
          producible: dies.some((d) => d.product_id === p.id),
        }),
      ),
    };
  });

  // --- fillers ---
  const fillerCreate = z.object({
    filler_mm: decimalString.nullable().optional(),
    weight_g_per_m: decimalString.optional(),
    source: z.enum(['drawing', 'sample', 'formula', 'agreed']),
    sample_length_m: decimalString.optional(),
    sample_weight_kg: decimalString.optional(),
    note: optText(1000),
  });

  app.get('/products/:id/fillers', async (req) => {
    requireUser(req);
    const { id } = idParam.parse(req.params);
    return { items: await fillersWithActual(db, id) };
  });

  app.post('/products/:id/fillers', async (req, reply) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = fillerCreate.parse(req.body);
    const product = await db.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirst();
    if (!product) throw new AppError('not_found');
    let gpm = body.weight_g_per_m ?? null;
    if (body.source === 'sample') {
      if (!body.sample_length_m || !body.sample_weight_kg) throw new AppError('validation', 'طول و وزن نمونه لازم است', { sample_weight_kg: 'لازم است' });
      gpm = round(new Dec(body.sample_weight_kg).div(body.sample_length_m).mul(1000), 'g_per_m');
    } else if (body.source === 'formula') {
      gpm = suggestedWeightPerMeter(product.section_area_mm2);
      if (gpm === null) throw new AppError('validation', 'سطح مقطع محصول نامشخص است؛ فرمول R01 قابل اجرا نیست', { section_area_mm2: 'نامشخص' });
    }
    if (gpm === null) throw new AppError('validation', 'وزن هر متر لازم است', { weight_g_per_m: 'لازم است' });
    const row = await db.transaction().execute(async (trx) => {
      const r = await trx
        .insertInto('product_fillers')
        .values({ product_id: id, filler_mm: body.filler_mm ?? null, weight_g_per_m: gpm, source: body.source, sample_length_m: body.sample_length_m ?? null, sample_weight_kg: body.sample_weight_kg ?? null, note: body.note ?? null, created_by: me.id })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, { userId: me.id, entity: 'product_fillers', entityId: r.id, action: 'propose', after: r });
      return r;
    });
    return reply.status(201).send(presentFiller(row));
  });

  app.patch('/products/:id/fillers/:fid', async (req) => {
    const me = requireUser(req);
    const { fid } = z.object({ id: uuid, fid: uuid }).parse(req.params);
    const body = z.object({ ...versionField, weight_g_per_m: decimalString.optional(), filler_mm: decimalString.nullable().optional(), note: optText(1000) }).parse(req.body);
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('product_fillers').selectAll().where('id', '=', fid).forUpdate().executeTakeFirst();
      if (!before) throw new AppError('not_found');
      if (before.version !== body.version) throw new AppError('conflict', undefined, undefined, presentFiller(before));
      if (before.status === 'approved' && !me.permissions.includes('technical.approve')) throw new AppError('forbidden', 'وزن تأییدشده فقط با مجوز فنی تغییر می‌کند');
      const { version, reason, ...patch } = body;
      void version;
      const after = await trx.updateTable('product_fillers').set({ ...patch, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', fid).returningAll().executeTakeFirstOrThrow();
      await audit(trx, { userId: me.id, entity: 'product_fillers', entityId: fid, action: 'update', before, after, reason: reason ?? null });
      return presentFiller(after);
    });
  });

  /** technical.approve: the approved value becomes the reference; a previous approved row for the same filler is demoted. */
  app.post('/products/:id/fillers/:fid/approve', async (req) => {
    const me = requirePermission(req, 'technical.approve');
    const { id, fid } = z.object({ id: uuid, fid: uuid }).parse(req.params);
    const key = requireIdempotencyKey(req);
    const r = await withIdempotency(db, key, me.id, 'POST fillers/approve', async (trx) => {
      const f = await trx.selectFrom('product_fillers').selectAll().where('id', '=', fid).where('product_id', '=', id).forUpdate().executeTakeFirst();
      if (!f) throw new AppError('not_found');
      await trx
        .updateTable('product_fillers')
        .set({ status: 'proposed', note: sql`COALESCE(note, '') || ' (جایگزین شد)'`, updated_at: new Date(), version: sql`version + 1` })
        .where('product_id', '=', id).where('status', '=', 'approved').where('id', '<>', fid)
        .where(sql`COALESCE(filler_mm, -1)`, '=', f.filler_mm ?? -1)
        .execute();
      const after = await trx.updateTable('product_fillers').set({ status: 'approved', approved_by: me.id, approved_at: new Date(), updated_at: new Date(), version: sql`version + 1` }).where('id', '=', fid).returningAll().executeTakeFirstOrThrow();
      await audit(trx, { userId: me.id, entity: 'product_fillers', entityId: fid, action: 'approve', before: f, after });
      return { status: 200, body: presentFiller(after) };
    });
    return r.body;
  });
}
