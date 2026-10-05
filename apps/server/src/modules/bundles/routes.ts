import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Dec, decimalString, round } from '@vitral/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Db, Trx } from '../../db/index.js';
import type { Row } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { requirePermission, requireUser, type AuthUser } from '../../lib/auth.js';
import { idParam, optText, uuid, boolQuery } from '../../lib/crud.js';
import { AppError } from '../../lib/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../lib/idempotency.js';
import { notifyManagers } from '../../lib/notify.js';
import { decodeCursor, encodeCursor, listQuery } from '../../lib/pagination.js';
import { getSetting } from '../../lib/settings.js';
import { itemBalance, move, OWN_WAREHOUSE, type StockState } from '../../lib/stock.js';
import { bundleWeightOutlier, bundleWeightPerMeter } from '../../rules/production.js';

const bump = { updated_at: new Date(), version: sql<number>`version + 1` };
const STATUSES = ['ok', 'damaged', 'wrong_product', 'pending_review', 'scrapped', 'consumed'] as const;
const QUARANTINE = ['damaged', 'wrong_product', 'pending_review'] as const;

const lineSchema = z.object({ product_id: uuid, filler_mm: decimalString.nullable().optional(), length_m: decimalString.nullable().optional(), bars: z.number().int().min(0).nullable().optional(), weight_kg: decimalString.nullable().optional(), order_line_id: uuid.nullable().optional() });
const createSchema = z.object({
  production_run_id: uuid.nullable().optional(), location_id: uuid.optional(), factory_party_id: uuid.nullable().optional(), code: z.string().trim().min(1).max(60).optional(),
  weight_kg: decimalString, packaging_kg: decimalString.nullable().optional(), form: z.enum(['raw', 'painted', 'anodized']).default('raw'), color: optText(60),
  source: z.enum(['production', 'purchase', 'opening', 'return']).default('production'), draft: z.boolean().default(false), note: optText(2000), reported_at: z.string().datetime({ offset: true }).optional(),
  lines: z.array(lineSchema).min(1).max(50),
});
const updateSchema = z.object({ version: z.number().int(), code: z.string().trim().min(1).max(60).optional(), color: optText(60), note: optText(2000), qc_note: optText(2000), weight_kg: decimalString.optional(), packaging_kg: decimalString.nullable().optional(), lines: z.array(lineSchema).min(1).max(50).optional(), reason: optText(1000) });

export type BundleRow = Row<'bundles'>;

export function presentBundle(b: Record<string, unknown>): Record<string, unknown> {
  const r = b as BundleRow & Record<string, unknown>;
  return {
    id: r.id, code: r.code, code_is_temp: r.code_is_temp, production_run_id: r.production_run_id, run_number: r.run_number, location_id: r.location_id, location_name: r.location_name, factory_party_id: r.factory_party_id,
    weight_kg: r.weight_kg, packaging_kg: r.packaging_kg, form: r.form, color: r.color, status: r.status, draft: r.draft, source: r.source, qc_note: r.qc_note, defect: r.defect, decision: r.decision, decision_note: r.decision_note,
    decided_by: r.decided_by, decided_at: r.decided_at, raw_weight_kg: r.raw_weight_kg, measured_filler_mm: r.measured_filler_mm, measured_length_m: r.measured_length_m, reserved_order_line_id: r.reserved_order_line_id, origin_bundle_ids: r.origin_bundle_ids,
    warnings: r.warnings, note: r.note, reported_at: r.reported_at, lines: r.lines, reserved_kg: r.reserved_kg, free_kg: r.free_kg, moves: r.moves, version: r.version, created_at: r.created_at, updated_at: r.updated_at,
  };
}

export async function loadBundle(db: Db | Trx, id: string, withMoves = false) {
  const b = await db.selectFrom('bundles').leftJoin('locations', 'locations.id', 'bundles.location_id').leftJoin('production_runs', 'production_runs.id', 'bundles.production_run_id').selectAll('bundles').select(['locations.name as location_name', 'production_runs.number as run_number']).where('bundles.id', '=', id).executeTakeFirst();
  if (!b) return undefined;
  const lines = await db.selectFrom('bundle_lines').leftJoin('products', 'products.id', 'bundle_lines.product_id').selectAll('bundle_lines').select(['products.code as product_code', 'products.name_fa as product_name']).where('bundle_id', '=', id).orderBy('sort').execute();
  const reserved = await db.selectFrom('reservations').select(sql<string>`COALESCE(SUM(kg),0)`.as('kg')).where('bundle_id', '=', id).where('status', '=', 'active').executeTakeFirstOrThrow();
  const moves = withMoves ? await db.selectFrom('stock_moves').leftJoin('locations as f', 'f.id', 'stock_moves.from_location_id').leftJoin('locations as t', 't.id', 'stock_moves.to_location_id').select(['stock_moves.id', 'stock_moves.at', 'stock_moves.kg', 'stock_moves.state_from', 'stock_moves.state_to', 'stock_moves.ref_type', 'stock_moves.ref_id', 'f.name as from_name', 't.name as to_name']).where('item_type', '=', 'bundle').where('item_id', '=', id).orderBy('at').execute() : undefined;
  return { ...b, lines, reserved_kg: round(reserved.kg, 'weight'), free_kg: round(new Dec(b.weight_kg).minus(reserved.kg), 'weight'), moves };
}

/** Form → ledger state. */
export const formState = (form: string): StockState => (form === 'raw' ? 'raw' : 'coated');

/** Temporary code TMP-<yyyymmdd>-<n>, unique per day (spec §8 module 5). */
async function tempCode(trx: Trx): Promise<string> {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const r = await trx.selectFrom('bundles').select(sql<number>`COUNT(*)::int`.as('n')).where('code', 'like', `TMP-${day}-%`).executeTakeFirstOrThrow();
  return `TMP-${day}-${r.n + 1}`;
}

interface Warning { code: string; message: string; data?: Record<string, unknown> }

/** Warnings at report time (never blocking): R03 weight/metre vs approved filler weight, R22 outlier, min length, duplicate code. */
export async function bundleWarnings(trx: Trx | Db, input: { code?: string; id?: string; production_run_id: string | null; weight_kg: string; packaging_kg: string | null; lines: z.infer<typeof lineSchema>[] }): Promise<Warning[]> {
  const out: Warning[] = [];
  const tol = (await getSetting<string>(trx, 'weight_per_meter_tolerance_percent')) ?? '5';
  const medianTol = (await getSetting<string>(trx, 'bundle_weight_median_threshold_percent')) ?? '40';
  if (input.code) {
    let q = trx.selectFrom('bundles').select('id').where('code', '=', input.code).where('status', '<>', 'consumed');
    if (input.id) q = q.where('id', '<>', input.id);
    if (await q.executeTakeFirst()) out.push({ code: 'duplicate_code', message: `کد ${input.code} قبلاً ثبت شده؛ بندیل در حالت «نیازمند بررسی» قرار گرفت` });
  }
  const single = input.lines.length === 1 ? input.lines[0]! : null;
  for (const l of input.lines) {
    const kg = input.lines.length === 1 ? input.weight_kg : l.weight_kg ?? null;
    if (kg !== null && l.bars && l.length_m) {
      let ref: string | null = null;
      const fq = trx.selectFrom('product_fillers').select('weight_g_per_m').where('product_id', '=', l.product_id).where('status', '=', 'approved');
      const f = l.filler_mm ? await fq.where('filler_mm', '=', l.filler_mm).executeTakeFirst() : await fq.where('filler_mm', 'is', null).executeTakeFirst();
      ref = f?.weight_g_per_m ?? null;
      const r = bundleWeightPerMeter(kg, input.lines.length === 1 ? input.packaging_kg : null, l.bars, l.length_m, ref);
      if (r && r.diff_percent !== null && new Dec(r.diff_percent).abs().gt(tol)) out.push({ code: 'weight_per_meter', message: `وزن هر متر ${r.g_per_m} گرم است؛ ${r.diff_percent}٪ اختلاف با وزن تأییدشده ${ref}`, data: { product_id: l.product_id, g_per_m: r.g_per_m, diff_percent: r.diff_percent, reference: ref } });
    }
    if (l.order_line_id && l.length_m) {
      const ol = await trx.selectFrom('order_lines').select('min_length_m').where('id', '=', l.order_line_id).executeTakeFirst();
      if (ol?.min_length_m && new Dec(l.length_m).lt(ol.min_length_m)) out.push({ code: 'min_length', message: `طول ${l.length_m} متر از حداقل طول سفارش (${ol.min_length_m}) کمتر است`, data: { order_line_id: l.order_line_id } });
    }
  }
  if (single && input.production_run_id) {
    let q = trx.selectFrom('bundles').innerJoin('bundle_lines', 'bundle_lines.bundle_id', 'bundles.id').select('bundles.weight_kg').where('bundles.production_run_id', '=', input.production_run_id).where('bundle_lines.product_id', '=', single.product_id).where('bundles.draft', '=', false).where(sql<SqlBool>`(SELECT COUNT(*) FROM bundle_lines x WHERE x.bundle_id = bundles.id) = 1`);
    if (input.id) q = q.where('bundles.id', '<>', input.id);
    const peers = (await q.execute()).map((p) => p.weight_kg);
    const o = bundleWeightOutlier(input.weight_kg, peers, medianTol);
    if (o?.warn) out.push({ code: 'weight_outlier', message: `وزن بندیل ${input.weight_kg} با میانه ${o.median_kg} کیلوگرم بندیل‌های همین محصول در این نوبت فاصله دارد`, data: { median_kg: o.median_kg } });
  }
  return out;
}

export function bundleRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/bundles', async (req) => {
    const me = requireUser(req);
    const q = listQuery.extend({
      order: z.enum(['asc', 'desc']).default('desc'), q: z.string().trim().max(60).optional(), production_run_id: uuid.optional(), location_id: uuid.optional(), product_id: uuid.optional(), order_line_id: uuid.optional(), status: z.enum(STATUSES).optional(),
      form: z.enum(['raw', 'painted', 'anodized']).optional(), color: z.string().max(60).optional(), available: boolQuery.optional(), quarantine: boolQuery.optional(), draft: boolQuery.optional(), temp: boolQuery.optional(),
    }).parse(req.query);
    let qb = db.selectFrom('bundles').leftJoin('locations', 'locations.id', 'bundles.location_id').selectAll('bundles').select(['locations.name as location_name', sql<string>`(SELECT COALESCE(SUM(kg),0) FROM reservations r WHERE r.bundle_id = bundles.id AND r.status = 'active')`.as('reserved_kg')]).limit(q.limit + 1);
    if (q.q) qb = qb.where('bundles.code', 'ilike', `%${q.q}%`);
    if (q.production_run_id) qb = qb.where('bundles.production_run_id', '=', q.production_run_id);
    if (q.location_id) qb = qb.where('bundles.location_id', '=', q.location_id);
    if (q.status) qb = qb.where('bundles.status', '=', q.status);
    if (q.form) qb = qb.where('bundles.form', '=', q.form);
    if (q.color) qb = qb.where('bundles.color', '=', q.color);
    if (q.draft !== undefined) qb = qb.where('bundles.draft', '=', q.draft);
    if (q.temp) qb = qb.where('bundles.code_is_temp', '=', true);
    if (q.quarantine) qb = qb.where('bundles.status', 'in', [...QUARANTINE]);
    if (q.available) qb = qb.where('bundles.status', '=', 'ok').where('bundles.draft', '=', false);
    if (q.product_id) qb = qb.where(sql<SqlBool>`EXISTS (SELECT 1 FROM bundle_lines bl WHERE bl.bundle_id = bundles.id AND bl.product_id = ${q.product_id}::uuid)`);
    if (q.order_line_id) qb = qb.where((eb) => eb.or([eb('bundles.reserved_order_line_id', '=', q.order_line_id!), sql<SqlBool>`EXISTS (SELECT 1 FROM bundle_lines bl WHERE bl.bundle_id = bundles.id AND bl.order_line_id = ${q.order_line_id}::uuid)`]));
    const desc = q.order === 'desc';
    qb = qb.orderBy('bundles.reported_at', desc ? 'desc' : 'asc').orderBy('bundles.id', desc ? 'desc' : 'asc');
    const cur = decodeCursor(q.cursor);
    if (cur) qb = qb.where(sql<SqlBool>`(bundles.reported_at, bundles.id) ${sql.raw(desc ? '<' : '>')} (${new Date(cur.at)}, ${cur.id}::uuid)`);
    const rows = await qb.execute();
    const page = rows.slice(0, q.limit);
    const ids = page.map((b) => b.id);
    const lines = ids.length ? await db.selectFrom('bundle_lines').leftJoin('products', 'products.id', 'bundle_lines.product_id').selectAll('bundle_lines').select(['products.code as product_code', 'products.name_fa as product_name']).where('bundle_id', 'in', ids).orderBy('sort').execute() : [];
    const last = page[page.length - 1];
    void me;
    return {
      items: page.map((b) => presentBundle({ ...b, lines: lines.filter((l) => l.bundle_id === b.id), free_kg: round(new Dec(b.weight_kg).minus(b.reserved_kg), 'weight') })),
      next_cursor: rows.length > q.limit && last ? encodeCursor(last.reported_at, last.id) : null,
    };
  });

  app.get('/bundles/:id', async (req) => {
    requireUser(req);
    const { id } = idParam.parse(req.params);
    const b = await loadBundle(db, id, true);
    if (!b) throw new AppError('not_found');
    return presentBundle(b);
  });

  /** Report a bundle (any user). A draft stays off the ledger until finalised. */
  app.post('/bundles', async (req, reply) => {
    const me = requireUser(req);
    const key = requireIdempotencyKey(req);
    const body = createSchema.parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /bundles', async (trx) => {
      let locationId = body.location_id ?? null;
      let factory = body.factory_party_id ?? null;
      if (body.production_run_id) {
        const run = await trx.selectFrom('production_runs').select(['location_id', 'factory_party_id', 'status']).where('id', '=', body.production_run_id).executeTakeFirst();
        if (!run) throw new AppError('validation', 'نوبت تولید یافت نشد', { production_run_id: 'نامعتبر' });
        if (run.status === 'closed') throw new AppError('validation', 'نوبت بسته است؛ بندیل جدید ثبت نمی‌شود');
        locationId = locationId ?? run.location_id;
        factory = factory ?? run.factory_party_id;
      }
      if (!locationId) locationId = await OWN_WAREHOUSE(trx);
      const code = body.code ?? (await tempCode(trx));
      const warnings = await bundleWarnings(trx, { code: body.code, production_run_id: body.production_run_id ?? null, weight_kg: body.weight_kg, packaging_kg: body.packaging_kg ?? null, lines: body.lines });
      const sumLines = body.lines.reduce((a, l) => (l.weight_kg ? a.plus(l.weight_kg) : a), new Dec(0));
      if (body.lines.length > 1 && body.lines.every((l) => l.weight_kg) && !sumLines.eq(body.weight_kg)) throw new AppError('validation', `جمع وزن ردیف‌ها (${sumLines.toFixed(3)}) با وزن بندیل (${body.weight_kg}) برابر نیست`, { weight_kg: 'ناسازگار' });
      const duplicate = warnings.some((w) => w.code === 'duplicate_code');
      const b = await trx.insertInto('bundles').values({
        code, code_is_temp: !body.code, production_run_id: body.production_run_id ?? null, location_id: locationId, factory_party_id: factory, weight_kg: body.weight_kg, packaging_kg: body.packaging_kg ?? null,
        form: body.form, color: body.color ?? null, source: body.source, draft: body.draft, status: duplicate ? 'pending_review' : 'ok', defect: duplicate ? 'duplicate_code' : null, note: body.note ?? null,
        reported_at: body.reported_at ? new Date(body.reported_at) : new Date(), warnings: JSON.stringify(warnings), created_by: me.id,
      }).returningAll().executeTakeFirstOrThrow();
      let sort = 0;
      for (const l of body.lines) await trx.insertInto('bundle_lines').values({ ...l, bundle_id: b.id, sort: sort++, created_by: me.id }).execute();
      if (!body.draft) {
        const state: StockState = duplicate ? 'quarantine' : formState(body.form);
        await move(trx, { item_type: 'bundle', item_id: b.id, from_location_id: null, to_location_id: locationId, kg: body.weight_kg, state_to: state, ref_type: body.source === 'production' ? 'production_output' : body.source === 'purchase' ? 'purchase_receipt' : body.source === 'opening' ? 'opening' : 'customer_return', ref_id: b.production_run_id ?? b.id, userId: me.id });
      }
      if (warnings.length) await notifyManagers(trx, { kind: 'bundle_warning', title: `بندیل ${code}: ${warnings.map((w) => w.message).join('؛ ')}`, entity: 'bundles', entityId: b.id, groupKey: `bundle_warn:${b.id}` });
      await audit(trx, { userId: me.id, entity: 'bundles', entityId: b.id, action: 'create', after: b });
      return { status: 201, body: presentBundle((await loadBundle(trx, b.id))!) };
    });
    return reply.status(r.status).send(r.body);
  });

  /** Edit: code/colour/notes always; weight and lines only while draft, afterwards weight via a reasoned count adjustment (technical.approve). */
  app.patch('/bundles/:id', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = updateSchema.parse(req.body);
    return db.transaction().execute(async (trx) => {
      const b = await trx.selectFrom('bundles').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!b) throw new AppError('not_found');
      if (b.version !== body.version) throw new AppError('conflict', undefined, undefined, presentBundle((await loadBundle(trx, id))!));
      if (b.status === 'consumed' || b.status === 'scrapped') throw new AppError('validation', 'این بندیل مصرف یا ضایعات شده است');
      const patch: Record<string, unknown> = {};
      if (body.code !== undefined && body.code !== b.code) { patch.code = body.code; patch.code_is_temp = false; }
      if (body.color !== undefined) patch.color = body.color;
      if (body.note !== undefined) patch.note = body.note;
      if (body.qc_note !== undefined) patch.qc_note = body.qc_note;
      if (body.packaging_kg !== undefined) patch.packaging_kg = body.packaging_kg;
      const weightChange = body.weight_kg !== undefined && !new Dec(body.weight_kg).eq(b.weight_kg);
      if (b.draft) {
        if (body.weight_kg !== undefined) patch.weight_kg = body.weight_kg;
        if (body.lines) {
          await trx.deleteFrom('bundle_lines').where('bundle_id', '=', id).execute();
          let sort = 0;
          for (const l of body.lines) await trx.insertInto('bundle_lines').values({ ...l, bundle_id: id, sort: sort++, created_by: me.id }).execute();
        }
      } else {
        if (body.lines) throw new AppError('validation', 'ردیف‌های بندیل قطعی تغییر نمی‌کند؛ از تفکیک/ادغام استفاده کنید');
        if (weightChange) {
          requirePermission(req, 'technical.approve');
          if (!body.reason) throw new AppError('validation', 'تغییر وزن بندیل قطعی دلیل لازم دارد', { reason: 'لازم است' });
          const diff = new Dec(body.weight_kg!).minus(b.weight_kg);
          const state = b.status === 'ok' ? formState(b.form) : 'quarantine';
          await move(trx, diff.gt(0)
            ? { item_type: 'bundle', item_id: id, from_location_id: null, to_location_id: b.location_id, kg: diff.toFixed(3), state_to: state, ref_type: 'count_adjustment', ref_id: id, note: body.reason, userId: me.id }
            : { item_type: 'bundle', item_id: id, from_location_id: b.location_id, to_location_id: null, kg: diff.abs().toFixed(3), state_from: state, ref_type: 'count_adjustment', ref_id: id, note: body.reason, userId: me.id });
          patch.weight_kg = body.weight_kg;
        }
      }
      const lines = body.lines ?? (await trx.selectFrom('bundle_lines').selectAll().where('bundle_id', '=', id).execute()).map((l) => ({ product_id: l.product_id, filler_mm: l.filler_mm, length_m: l.length_m, bars: l.bars, weight_kg: l.weight_kg, order_line_id: l.order_line_id }));
      patch.warnings = JSON.stringify(await bundleWarnings(trx, { id, code: (patch.code as string | undefined) ?? (b.code_is_temp ? undefined : b.code), production_run_id: b.production_run_id, weight_kg: (patch.weight_kg as string | undefined) ?? b.weight_kg, packaging_kg: (patch.packaging_kg as string | null | undefined) ?? b.packaging_kg, lines }));
      const after = await trx.updateTable('bundles').set({ ...patch, ...bump }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await audit(trx, { userId: me.id, entity: 'bundles', entityId: id, action: 'update', before: b, after, reason: body.reason ?? null });
      return presentBundle((await loadBundle(trx, id))!);
    });
  });

  async function act(req: FastifyRequest, name: string, perm: 'technical.approve' | null, schema: z.ZodTypeAny, work: (trx: Trx, b: BundleRow, me: AuthUser, body: Record<string, unknown>) => Promise<void>) {
    const me = perm ? requirePermission(req, perm) : requireUser(req);
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ version: z.number().int() }).and(schema).parse(req.body ?? {}) as Record<string, unknown> & { version: number };
    const r = await withIdempotency(db, key, me.id, `POST /bundles/${name}`, async (trx) => {
      const b = await trx.selectFrom('bundles').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!b) throw new AppError('not_found');
      if (b.version !== body.version) throw new AppError('conflict', undefined, undefined, presentBundle((await loadBundle(trx, id))!));
      await work(trx, b, me, body);
      const after = await trx.selectFrom('bundles').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      await audit(trx, { userId: me.id, entity: 'bundles', entityId: id, action: name, before: { status: b.status, draft: b.draft, decision: b.decision, location_id: b.location_id }, after: { status: after.status, draft: after.draft, decision: after.decision, location_id: after.location_id }, reason: (body.reason as string | null) ?? (body.note as string | null) ?? null });
      return { status: 200, body: presentBundle((await loadBundle(trx, id))!) };
    });
    return r.body;
  }

  /** Draft → definitive: the ledger row is written now. */
  app.post('/bundles/:id/finalize', (req) => act(req, 'finalize', null, z.object({}), async (trx, b, me) => {
    if (!b.draft) throw new AppError('validation', 'این بندیل قطعی است');
    await move(trx, { item_type: 'bundle', item_id: b.id, from_location_id: null, to_location_id: b.location_id, kg: b.weight_kg, state_to: b.status === 'ok' ? formState(b.form) : 'quarantine', ref_type: b.source === 'production' ? 'production_output' : b.source === 'purchase' ? 'purchase_receipt' : b.source === 'opening' ? 'opening' : 'customer_return', ref_id: b.production_run_id ?? b.id, userId: me.id });
    await trx.updateTable('bundles').set({ draft: false, ...bump }).where('id', '=', b.id).execute();
  }));

  /** Delete a draft (no ledger row exists). */
  app.delete('/bundles/:id', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    await db.transaction().execute(async (trx) => {
      const b = await trx.selectFrom('bundles').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!b) throw new AppError('not_found');
      if (!b.draft) throw new AppError('validation', 'بندیل قطعی حذف نمی‌شود؛ فقط قرنطینه یا ضایعات');
      await trx.deleteFrom('bundle_lines').where('bundle_id', '=', id).execute();
      await trx.deleteFrom('bundles').where('id', '=', id).execute();
      await audit(trx, { userId: me.id, entity: 'bundles', entityId: id, action: 'delete_draft', before: b });
    });
    return { ok: true };
  });

  /** Quarantine (T49): status + defect; the kg stays at the location but in state «quarantine», excluded from available stock. */
  app.post('/bundles/:id/quarantine', (req) => act(req, 'quarantine', null, z.object({ status: z.enum(QUARANTINE), defect: optText(200), qc_note: optText(2000), measured_filler_mm: decimalString.nullable().optional(), measured_length_m: decimalString.nullable().optional() }), async (trx, b, me, body) => {
    if (b.draft) throw new AppError('validation', 'بندیل پیش‌نویس را اول قطعی کنید');
    if (b.status !== 'ok') throw new AppError('validation', 'این بندیل در قرنطینه است');
    const reserved = await trx.selectFrom('reservations').select('id').where('bundle_id', '=', b.id).where('status', '=', 'active').executeTakeFirst();
    if (reserved) await trx.updateTable('reservations').set({ status: 'released', ...bump }).where('bundle_id', '=', b.id).where('status', '=', 'active').execute();
    await move(trx, { item_type: 'bundle', item_id: b.id, from_location_id: b.location_id, to_location_id: b.location_id, kg: b.weight_kg, state_from: formState(b.form), state_to: 'quarantine', ref_type: 'count_adjustment', ref_id: b.id, note: `قرنطینه: ${body.status}`, userId: me.id });
    await trx.updateTable('bundles').set({ status: body.status as string, defect: (body.defect as string | null) ?? null, qc_note: (body.qc_note as string | null) ?? null, measured_filler_mm: (body.measured_filler_mm as string | null) ?? null, measured_length_m: (body.measured_length_m as string | null) ?? null, reserved_order_line_id: null, decision: null, decision_note: null, ...bump }).where('id', '=', b.id).execute();
    await notifyManagers(trx, { kind: 'bundle_quarantine', title: `بندیل ${b.code} قرنطینه شد (${body.status})؛ تصمیم لازم است`, entity: 'bundles', entityId: b.id, groupKey: `quarantine:${b.id}` });
  }));

  /** Decision (T50, technical.approve): accept → ok; rework → stays, decision recorded; discount_sale → ok with flag; scrap → bundle consumed, scrap lot created. */
  app.post('/bundles/:id/decide', (req) => act(req, 'decide', 'technical.approve', z.object({ decision: z.enum(['accept', 'rework', 'discount_sale', 'scrap']), note: optText(2000) }), async (trx, b, me, body) => {
    if (!QUARANTINE.includes(b.status as (typeof QUARANTINE)[number])) throw new AppError('validation', 'این بندیل در قرنطینه نیست');
    const decision = body.decision as string;
    const base = { decision, decision_note: (body.note as string | null) ?? null, decided_by: me.id, decided_at: new Date(), ...bump };
    if (decision === 'accept' || decision === 'discount_sale') {
      await move(trx, { item_type: 'bundle', item_id: b.id, from_location_id: b.location_id, to_location_id: b.location_id, kg: b.weight_kg, state_from: 'quarantine', state_to: formState(b.form), ref_type: 'count_adjustment', ref_id: b.id, note: `تصمیم قرنطینه: ${decision}`, userId: me.id });
      await trx.updateTable('bundles').set({ ...base, status: 'ok' }).where('id', '=', b.id).execute();
    } else if (decision === 'rework') {
      await trx.updateTable('bundles').set(base).where('id', '=', b.id).execute();
    } else {
      const lot = await trx.insertInto('material_lots').values({ kind: 'scrap', owner_party_id: null, description: `ضایعات از بندیل ${b.code}`, created_by: me.id }).returning('id').executeTakeFirstOrThrow();
      await move(trx, { item_type: 'bundle', item_id: b.id, from_location_id: b.location_id, to_location_id: null, kg: b.weight_kg, state_from: 'quarantine', state_to: 'consumed', ref_type: 'scrap_conversion', ref_id: lot.id, userId: me.id });
      await move(trx, { item_type: 'material_lot', item_id: lot.id, from_location_id: null, to_location_id: b.location_id, kg: b.weight_kg, state_to: 'scrap', ref_type: 'scrap_conversion', ref_id: b.id, userId: me.id });
      await trx.updateTable('bundles').set({ ...base, status: 'scrapped' }).where('id', '=', b.id).execute();
    }
  }));

  /** Split one bundle into parts (weights must add up); origin recorded on the parts. */
  app.post('/bundles/:id/split', (req) => act(req, 'split', null, z.object({ parts: z.array(z.object({ code: z.string().trim().min(1).max(60).optional(), weight_kg: decimalString, bars: z.number().int().min(0).nullable().optional() })).min(2).max(20) }), async (trx, b, me, body) => {
    if (b.draft || b.status !== 'ok') throw new AppError('validation', 'فقط بندیل قطعی سالم تفکیک می‌شود');
    const parts = body.parts as Array<{ code?: string; weight_kg: string; bars?: number | null }>;
    const sum = parts.reduce((a, p) => a.plus(p.weight_kg), new Dec(0));
    if (!sum.eq(b.weight_kg)) throw new AppError('validation', `جمع وزن قطعات (${sum.toFixed(3)}) باید برابر وزن بندیل (${b.weight_kg}) باشد`, { parts: 'ناسازگار' });
    const have = await itemBalance(trx, 'bundle', b.id, b.location_id);
    if (new Dec(have).lt(b.weight_kg)) throw new AppError('insufficient_stock');
    const lines = await trx.selectFrom('bundle_lines').selectAll().where('bundle_id', '=', b.id).execute();
    if (lines.length !== 1) throw new AppError('validation', 'بندیل چندمحصولی تفکیک نمی‌شود');
    const line = lines[0]!;
    await move(trx, { item_type: 'bundle', item_id: b.id, from_location_id: b.location_id, to_location_id: null, kg: b.weight_kg, state_from: formState(b.form), state_to: 'consumed', ref_type: 'count_adjustment', ref_id: b.id, note: 'تفکیک', userId: me.id });
    let i = 1;
    for (const p of parts) {
      const nb = await trx.insertInto('bundles').values({ code: p.code ?? `${b.code}-${i}`, code_is_temp: !p.code && b.code_is_temp, production_run_id: b.production_run_id, location_id: b.location_id, factory_party_id: b.factory_party_id, weight_kg: p.weight_kg, form: b.form, color: b.color, source: b.source, origin_bundle_ids: [b.id], warnings: '[]', created_by: me.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('bundle_lines').values({ bundle_id: nb.id, product_id: line.product_id, filler_mm: line.filler_mm, length_m: line.length_m, bars: p.bars ?? null, weight_kg: p.weight_kg, order_line_id: line.order_line_id, created_by: me.id }).execute();
      await move(trx, { item_type: 'bundle', item_id: nb.id, from_location_id: null, to_location_id: b.location_id, kg: p.weight_kg, state_to: formState(b.form), ref_type: 'count_adjustment', ref_id: b.id, note: `تفکیک از ${b.code}`, userId: me.id });
      i++;
    }
    await trx.updateTable('reservations').set({ status: 'released', ...bump }).where('bundle_id', '=', b.id).where('status', '=', 'active').execute();
    await trx.updateTable('bundles').set({ status: 'consumed', reserved_order_line_id: null, ...bump }).where('id', '=', b.id).execute();
  }));

  /** Attach already-uploaded files (photos from the bot or the web form) to a bundle. */
  app.post('/bundles/:id/files', async (req, reply) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ file_ids: z.array(uuid).min(1).max(20) }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /bundles/:id/files', async (trx) => {
      await loadBundle(trx, id);
      for (const fid of body.file_ids) {
        await trx.insertInto('file_links').values({ file_id: fid, entity: 'bundles', entity_id: id, created_by: me.id }).onConflict((oc) => oc.doNothing()).execute();
        await trx.updateTable('files').set({ owner_entity: 'bundles', owner_id: id }).where('id', '=', fid).where('owner_id', 'is', null).execute();
      }
      await audit(trx, { userId: me.id, entity: 'bundles', entityId: id, action: 'attach_files', after: { file_ids: body.file_ids } });
      return { status: 200, body: { ok: true } };
    });
    return reply.status(r.status).send(r.body);
  });

  /** Bundle gallery: files linked to bundles of a run (for the share link, T44). */
  app.get('/bundles/:id/files', async (req) => {
    requireUser(req);
    const { id } = idParam.parse(req.params);
    const files = await db.selectFrom('file_links').innerJoin('files', 'files.id', 'file_links.file_id').select(['files.id', 'files.original_name', 'files.mime', 'files.size', 'files.created_at']).where('file_links.entity', '=', 'bundles').where('file_links.entity_id', '=', id).execute();
    return { items: files };
  });
}
