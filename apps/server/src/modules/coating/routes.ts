import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Dec, decimalString, round } from '@vitral/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Db, Trx } from '../../db/index.js';
import type { Row } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { can, requirePermission, requireUser, type AuthUser } from '../../lib/auth.js';
import { idParam, optText, uuid } from '../../lib/crud.js';
import { AppError } from '../../lib/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../lib/idempotency.js';
import { nextNumber } from '../../lib/numbering.js';
import { notifyManagers } from '../../lib/notify.js';
import { decodeCursor, encodeCursor, listQuery } from '../../lib/pagination.js';
import { getSetting } from '../../lib/settings.js';
import { move, OWN_WAREHOUSE } from '../../lib/stock.js';
import { coatingFee, weightGain } from '../../rules/production.js';
import { activeContract } from '../contracts/routes.js';
import { formState } from '../bundles/routes.js';

const bump = { updated_at: new Date(), version: sql<number>`version + 1` };
type RunRow = Row<'coating_runs'>;

export function presentCoatingRun(r: Record<string, unknown>, user?: AuthUser): Record<string, unknown> {
  const c = r as RunRow & Record<string, unknown>;
  const out: Record<string, unknown> = {
    id: c.id, number: c.number, party_id: c.party_id, party_name: c.party_name, service: c.service, color_code: c.color_code, contract_id: c.contract_id, rate_per_kg: c.rate_per_kg, rate_currency: c.rate_currency,
    includes_material: c.includes_material, material_lot_id: c.material_lot_id, material_units: c.material_units, input_basis: c.input_basis, input_basis_kg: c.input_basis_kg, basis_reason: c.basis_reason, status: c.status,
    sent_at: c.sent_at, due_at: c.due_at, closed_at: c.closed_at, transfer_id: c.transfer_id, fee_document_id: c.fee_document_id, fee_incomplete: c.rate_per_kg === null, note: c.note,
    items: c.items, totals: c.totals, version: c.version, created_at: c.created_at,
  };
  if (user && !can(user, 'finance.view')) delete out.fee_document_id;
  return out;
}

export async function loadCoatingRun(db: Db | Trx, id: string) {
  const r = await db.selectFrom('coating_runs').leftJoin('parties', 'parties.id', 'coating_runs.party_id').selectAll('coating_runs').select('parties.name as party_name').where('coating_runs.id', '=', id).executeTakeFirst();
  if (!r) return undefined;
  const items = await db.selectFrom('coating_run_items').innerJoin('bundles', 'bundles.id', 'coating_run_items.bundle_id').selectAll('coating_run_items').select(['bundles.code as bundle_code', 'bundles.form as bundle_form', 'bundles.status as bundle_status', 'bundles.location_id as bundle_location_id']).where('run_id', '=', id).orderBy('coating_run_items.created_at').execute();
  const raw = items.reduce((a, i) => a.plus(i.raw_kg), new Dec(0));
  const returned = items.filter((i) => i.coated_kg !== null);
  const rawReturned = returned.reduce((a, i) => a.plus(i.raw_kg), new Dec(0));
  const coated = returned.reduce((a, i) => a.plus(i.coated_kg!), new Dec(0));
  const gain = returned.length ? weightGain(rawReturned, coated) : null;
  const totals = { raw_kg: round(raw, 'weight'), returned_count: returned.length, item_count: items.length, coated_kg: returned.length ? round(coated, 'weight') : null, gain_kg: gain?.gain_kg ?? null, gain_percent: gain?.percent ?? null, fee: coatingFee(r.input_basis_kg, r.rate_per_kg) };
  return { ...r, items: items.map((i) => ({ ...i, gain: i.coated_kg === null ? null : weightGain(i.raw_kg, i.coated_kg) })), totals };
}

/** Settings `coating_gain_range_percent` (paint) and `anodize_gain_range_percent` (anodize); D4 — NULL until the client decides. */
async function gainRange(db: Db | Trx, service: string): Promise<{ min: string; max: string } | null> {
  const v = await getSetting<{ min: string; max: string } | null>(db, service === 'anodize' ? 'anodize_gain_range_percent' : 'coating_gain_range_percent');
  return v && v.min !== undefined && v.max !== undefined ? v : null;
}

export function coatingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/coating-runs', async (req) => {
    const me = requireUser(req);
    const q = listQuery.extend({ order: z.enum(['asc', 'desc']).default('desc'), status: z.enum(['open', 'partially_returned', 'returned', 'closed']).optional(), party_id: uuid.optional(), service: z.enum(['paint', 'anodize']).optional(), bundle_id: uuid.optional() }).parse(req.query);
    let qb = db.selectFrom('coating_runs').leftJoin('parties', 'parties.id', 'coating_runs.party_id').selectAll('coating_runs').select(['parties.name as party_name', sql<string>`(SELECT COALESCE(SUM(raw_kg),0) FROM coating_run_items i WHERE i.run_id = coating_runs.id)`.as('raw_kg'), sql<number>`(SELECT COUNT(*)::int FROM coating_run_items i WHERE i.run_id = coating_runs.id)`.as('item_count'), sql<number>`(SELECT COUNT(*)::int FROM coating_run_items i WHERE i.run_id = coating_runs.id AND i.coated_kg IS NOT NULL)`.as('returned_count')]).limit(q.limit + 1);
    if (q.status) qb = qb.where('coating_runs.status', '=', q.status);
    if (q.party_id) qb = qb.where('coating_runs.party_id', '=', q.party_id);
    if (q.service) qb = qb.where('coating_runs.service', '=', q.service);
    if (q.bundle_id) qb = qb.where(sql<SqlBool>`EXISTS (SELECT 1 FROM coating_run_items i WHERE i.run_id = coating_runs.id AND i.bundle_id = ${q.bundle_id}::uuid)`);
    const desc = q.order === 'desc';
    qb = qb.orderBy('coating_runs.sent_at', desc ? 'desc' : 'asc').orderBy('coating_runs.id', desc ? 'desc' : 'asc');
    const cur = decodeCursor(q.cursor);
    if (cur) qb = qb.where(sql<SqlBool>`(coating_runs.sent_at, coating_runs.id) ${sql.raw(desc ? '<' : '>')} (${new Date(cur.at)}, ${cur.id}::uuid)`);
    const rows = await qb.execute();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page.map((r) => presentCoatingRun({ ...r, totals: { raw_kg: round(r.raw_kg, 'weight'), item_count: r.item_count, returned_count: r.returned_count, fee: coatingFee(r.input_basis_kg, r.rate_per_kg) } }, me)), next_cursor: rows.length > q.limit && last ? encodeCursor(last.sent_at, last.id) : null };
  });

  app.get('/coating-runs/:id', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const r = await loadCoatingRun(db, id);
    if (!r) throw new AppError('not_found');
    return presentCoatingRun(r, me);
  });

  /** Send bundles to a painter/anodizer: a to_coating transfer (received at once) plus one ledger move per bundle. Rate from the active contract. */
  app.post('/coating-runs', async (req, reply) => {
    const me = requireUser(req);
    const key = requireIdempotencyKey(req);
    const body = z.object({
      party_id: uuid, service: z.enum(['paint', 'anodize']), color_code: optText(60), bundle_ids: z.array(uuid).min(1).max(200), due_at: z.string().datetime({ offset: true }).nullable().optional(), sent_at: z.string().datetime({ offset: true }).optional(),
      includes_material: z.boolean().nullable().optional(), material_lot_id: uuid.nullable().optional(), material_units: decimalString.nullable().optional(), input_basis: z.enum(['bundle_sum', 'scale_ticket', 'agreed']).default('bundle_sum'), input_basis_kg: decimalString.nullable().optional(), basis_reason: optText(1000), note: optText(2000),
    }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /coating-runs', async (trx) => {
      const loc = await trx.selectFrom('locations').select('id').where('party_id', '=', body.party_id).where('kind', '=', 'painter').executeTakeFirst();
      if (!loc) throw new AppError('validation', 'این طرف نقش رنگ‌کار/آنودایزر ندارد', { party_id: 'رنگ‌کار نیست' });
      const c = await activeContract(trx, body.party_id, body.service);
      const rate = c?.rate_per_kg ?? (body.service === 'anodize' ? await getSetting<string>(trx, 'default_anodize_rate_per_kg') : null);
      if (body.input_basis === 'agreed' && (!body.input_basis_kg || !body.basis_reason)) throw new AppError('validation', 'مبنای توافقی وزن و دلیل لازم دارد', { basis_reason: 'لازم است' });
      const bundles = await trx.selectFrom('bundles').selectAll().where('id', 'in', body.bundle_ids).forUpdate().execute();
      if (bundles.length !== body.bundle_ids.length) throw new AppError('validation', 'برخی بندیل‌ها یافت نشد', { bundle_ids: 'نامعتبر' });
      for (const b of bundles) {
        if (b.draft || b.status !== 'ok') throw new AppError('validation', `بندیل ${b.code} پیش‌نویس یا در قرنطینه است`);
        if (b.form !== 'raw') throw new AppError('validation', `بندیل ${b.code} خام نیست`);
        const open = await trx.selectFrom('coating_run_items').innerJoin('coating_runs', 'coating_runs.id', 'coating_run_items.run_id').select('coating_run_items.id').where('bundle_id', '=', b.id).where('coating_run_items.coated_kg', 'is', null).where('coating_runs.status', '<>', 'closed').executeTakeFirst();
        if (open) throw new AppError('validation', `بندیل ${b.code} الان در یک نوبت رنگ باز است`);
      }
      const sentAt = body.sent_at ? new Date(body.sent_at) : new Date();
      const rawSum = bundles.reduce((a, b) => a.plus(b.weight_kg), new Dec(0));
      const basisKg = body.input_basis === 'bundle_sum' ? rawSum.toFixed(3) : body.input_basis_kg ?? null;
      const from = bundles[0]!.location_id;
      const transfer = await trx.insertInto('transfers').values({ number: await nextNumber(trx, 'transfer', sentAt), kind: 'to_coating', from_location_id: from, to_location_id: loc.id, status: 'received', departed_at: sentAt, received_at: sentAt, dispatched_by: me.id, created_by: me.id, note: body.note ?? null }).returning('id').executeTakeFirstOrThrow();
      const run = await trx.insertInto('coating_runs').values({
        number: await nextNumber(trx, 'coating_run', sentAt), party_id: body.party_id, service: body.service, color_code: body.color_code ?? null, contract_id: c?.id ?? null, rate_per_kg: rate, rate_currency: c?.currency ?? 'TOMAN',
        includes_material: body.includes_material ?? c?.includes_material ?? null, material_lot_id: body.material_lot_id ?? null, material_units: body.material_units ?? null, input_basis: body.input_basis, input_basis_kg: basisKg, basis_reason: body.basis_reason ?? null,
        sent_at: sentAt, due_at: body.due_at ? new Date(body.due_at) : null, transfer_id: transfer.id, note: body.note ?? null, created_by: me.id,
      }).returningAll().executeTakeFirstOrThrow();
      for (const b of bundles) {
        await trx.insertInto('transfer_lines').values({ transfer_id: transfer.id, bundle_id: b.id, kg: b.weight_kg, received_kg: b.weight_kg, received_at: sentAt, created_by: me.id }).execute();
        await trx.insertInto('coating_run_items').values({ run_id: run.id, bundle_id: b.id, raw_kg: b.weight_kg, created_by: me.id }).execute();
        await move(trx, { at: sentAt, item_type: 'bundle', item_id: b.id, from_location_id: b.location_id, to_location_id: loc.id, kg: b.weight_kg, state_from: 'raw', state_to: 'raw', ref_type: 'coating_send', ref_id: run.id, userId: me.id });
        await trx.updateTable('bundles').set({ location_id: loc.id, raw_weight_kg: b.weight_kg, ...bump }).where('id', '=', b.id).execute();
      }
      if (rate === null) await notifyManagers(trx, { kind: 'fee_incomplete', title: `نوبت رنگ ${run.number} نرخ ندارد؛ قرارداد ${body.service === 'paint' ? 'رنگ' : 'آنودایز'} را ثبت کنید`, entity: 'coating_runs', entityId: run.id, groupKey: `coating_rate:${run.id}` });
      await audit(trx, { userId: me.id, entity: 'coating_runs', entityId: run.id, action: 'create', after: run });
      return { status: 201, body: presentCoatingRun((await loadCoatingRun(trx, run.id))!, me) };
    });
    return reply.status(r.status).send(r.body);
  });

  async function act(req: FastifyRequest, name: string, perm: 'technical.approve' | null, schema: z.ZodTypeAny, work: (trx: Trx, r: RunRow, me: AuthUser, body: Record<string, unknown>) => Promise<void>) {
    const me = perm ? requirePermission(req, perm) : requireUser(req);
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ version: z.number().int() }).and(schema).parse(req.body ?? {}) as Record<string, unknown> & { version: number };
    const res = await withIdempotency(db, key, me.id, `POST /coating-runs/${name}`, async (trx) => {
      const r = await trx.selectFrom('coating_runs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!r) throw new AppError('not_found');
      if (r.version !== body.version) throw new AppError('conflict', undefined, undefined, presentCoatingRun((await loadCoatingRun(trx, id))!, me));
      if (r.status === 'closed') throw new AppError('validation', 'نوبت رنگ بسته شده است');
      await work(trx, r, me, body);
      const after = await trx.selectFrom('coating_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      await audit(trx, { userId: me.id, entity: 'coating_runs', entityId: id, action: name, before: { status: r.status }, after: { status: after.status }, reason: (body.reason as string | null) ?? null });
      return { status: 200, body: presentCoatingRun((await loadCoatingRun(trx, id))!, me) };
    });
    return res.body;
  }

  /** Return items: coated weight per bundle, R06 gain flagged when outside the configured range; bundles move back (coated) to the warehouse. */
  app.post('/coating-runs/:id/return', (req) => act(req, 'return', null, z.object({ to_location_id: uuid.optional(), returned_at: z.string().datetime({ offset: true }).optional(), items: z.array(z.object({ item_id: uuid, coated_kg: decimalString, bars_returned: z.number().int().min(0).nullable().optional(), qc: z.enum(['ok', 'needs_review', 'rejected']).default('ok'), note: optText(1000) })).min(1).max(200) }), async (trx, r, me, body) => {
    const to = (body.to_location_id as string | undefined) ?? (await OWN_WAREHOUSE(trx));
    const at = body.returned_at ? new Date(String(body.returned_at)) : new Date();
    const range = await gainRange(trx, r.service);
    const form = r.service === 'paint' ? 'painted' : 'anodized';
    const flagged: string[] = [];
    for (const it of body.items as Array<{ item_id: string; coated_kg: string; bars_returned?: number | null; qc: string; note?: string | null }>) {
      const item = await trx.selectFrom('coating_run_items').selectAll().where('id', '=', it.item_id).where('run_id', '=', r.id).forUpdate().executeTakeFirst();
      if (!item) throw new AppError('validation', 'آیتم نوبت یافت نشد', { item_id: 'نامعتبر' });
      if (item.coated_kg !== null) throw new AppError('validation', 'این بندیل قبلاً برگشت خورده است');
      const b = await trx.selectFrom('bundles').selectAll().where('id', '=', item.bundle_id).forUpdate().executeTakeFirstOrThrow();
      const g = weightGain(item.raw_kg, it.coated_kg)!;
      // Module 5: outside the normal range of this service (paint or anodize, if set) or negative → «نیازمند بررسی».
      const needsReview = new Dec(g.gain_kg).lt(0) || (range !== null && g.percent !== null && (new Dec(g.percent).lt(range.min) || new Dec(g.percent).gt(range.max)));
      if (needsReview) flagged.push(`${b.code} (${g.percent}٪)`);
      await trx.updateTable('coating_run_items').set({ coated_kg: it.coated_kg, bars_returned: it.bars_returned ?? null, qc: it.qc, note: it.note ?? null, returned_at: at, gain_needs_review: needsReview, ...bump }).where('id', '=', item.id).execute();
      // Weight changes between send and return: the bundle leaves with raw kg and arrives with coated kg (gain appears as a positive adjustment at the painter).
      const diff = new Dec(it.coated_kg).minus(b.weight_kg);
      if (diff.gt(0)) await move(trx, { at, item_type: 'bundle', item_id: b.id, from_location_id: null, to_location_id: b.location_id, kg: diff.toFixed(3), state_to: 'raw', ref_type: 'coating_return', ref_id: r.id, note: 'افزایش وزن پوشش', userId: me.id });
      else if (diff.lt(0)) await move(trx, { at, item_type: 'bundle', item_id: b.id, from_location_id: b.location_id, to_location_id: null, kg: diff.abs().toFixed(3), state_from: 'raw', ref_type: 'coating_return', ref_id: r.id, note: 'کاهش وزن در پوشش', userId: me.id });
      const toState = it.qc === 'rejected' ? 'quarantine' : formState(form);
      await move(trx, { at, item_type: 'bundle', item_id: b.id, from_location_id: b.location_id, to_location_id: to, kg: it.coated_kg, state_from: 'raw', state_to: toState, ref_type: 'coating_return', ref_id: r.id, userId: me.id });
      await trx.updateTable('bundles').set({ location_id: to, weight_kg: it.coated_kg, form, color: r.color_code ?? b.color, status: it.qc === 'rejected' ? 'damaged' : 'ok', defect: it.qc === 'rejected' ? 'coating_rejected' : b.defect, qc_note: it.note ?? b.qc_note, ...bump }).where('id', '=', b.id).execute();
    }
    const pending = await trx.selectFrom('coating_run_items').select('id').where('run_id', '=', r.id).where('coated_kg', 'is', null).executeTakeFirst();
    await trx.updateTable('coating_runs').set({ status: pending ? 'partially_returned' : 'returned', ...bump }).where('id', '=', r.id).execute();
    if (flagged.length) await notifyManagers(trx, { kind: 'coating_gain_review', title: `افزایش وزن خارج از بازه در نوبت رنگ ${r.number}: ${flagged.join('، ')}`, entity: 'coating_runs', entityId: r.id, groupKey: `gain:${r.id}` });
  }));

  /** Change basis before close (agreed kg needs a reason); items' qc. */
  app.post('/coating-runs/:id/basis', (req) => act(req, 'basis', 'technical.approve', z.object({ input_basis: z.enum(['bundle_sum', 'scale_ticket', 'agreed']), input_basis_kg: decimalString.nullable().optional(), basis_reason: optText(1000), scale_ticket_id: uuid.optional() }), async (trx, r, _me, body) => {
    let kg: string | null = null;
    if (body.input_basis === 'bundle_sum') {
      const s = await trx.selectFrom('coating_run_items').select(sql<string>`COALESCE(SUM(raw_kg),0)`.as('kg')).where('run_id', '=', r.id).executeTakeFirstOrThrow();
      kg = round(s.kg, 'weight');
    } else if (body.input_basis === 'scale_ticket') {
      // No ticket id → the same 400 as an unknown ticket (not a uuid cast error).
      const t = body.scale_ticket_id ? await trx.selectFrom('scale_tickets').selectAll().where('id', '=', String(body.scale_ticket_id)).where('coating_run_id', '=', r.id).executeTakeFirst() : undefined;
      if (!t || t.status !== 'approved') throw new AppError('validation', 'قبض باسکول تأییدشده برای این نوبت لازم است', { scale_ticket_id: 'نامعتبر' });
      kg = t.net_direct_kg ?? (t.gross_kg && t.tare_kg ? round(new Dec(t.gross_kg).minus(t.tare_kg).minus(t.packaging_kg ?? 0), 'weight') : null);
    } else {
      if (!body.input_basis_kg || !body.basis_reason) throw new AppError('validation', 'مبنای توافقی وزن و دلیل لازم دارد', { basis_reason: 'لازم است' });
      kg = body.input_basis_kg as string;
    }
    await trx.updateTable('coating_runs').set({ input_basis: body.input_basis as string, input_basis_kg: kg, basis_reason: (body.basis_reason as string | null) ?? null, ...bump }).where('id', '=', r.id).execute();
  }));

  /** Close (technical.approve): all items returned; fee R05 = input basis × rate (output weight irrelevant, T39); paint powder consumed when supplied by Vitral. */
  app.post('/coating-runs/:id/close', (req) => act(req, 'close', 'technical.approve', z.object({ reason: optText(1000) }), async (trx, r, me) => {
    const pending = await trx.selectFrom('coating_run_items').select('id').where('run_id', '=', r.id).where('coated_kg', 'is', null).executeTakeFirst();
    if (pending) throw new AppError('validation', 'همه بندیل‌ها هنوز برنگشته‌اند');
    const fee = coatingFee(r.input_basis_kg, r.rate_per_kg);
    const doc = await trx.insertInto('documents').values({
      number: await nextNumber(trx, 'toll_fee'), kind: 'toll_fee', party_id: r.party_id, amount: fee, currency: r.rate_currency, status: fee === null ? 'needs_completion' : 'posted', posted_by: fee === null ? null : me.id, posted_at: fee === null ? null : new Date(),
      source_type: 'coating_run', source_id: r.id, settlement_basis_kg: r.input_basis_kg, unit_price: r.rate_per_kg, description: `اجرت ${r.service === 'paint' ? 'رنگ' : 'آنودایز'} نوبت ${r.number}`, created_by: me.id,
    }).returning('id').executeTakeFirstOrThrow();
    if (r.includes_material === false && r.material_lot_id && r.material_units) {
      const lot = await trx.selectFrom('material_lots').selectAll().where('id', '=', r.material_lot_id).executeTakeFirst();
      if (lot) {
        const kg = lot.unit === 'kg' ? new Dec(r.material_units) : new Dec(r.material_units).mul(lot.kg_per_unit ?? 0);
        const loc = await trx.selectFrom('locations').select('id').where('party_id', '=', r.party_id).where('kind', '=', 'painter').executeTakeFirstOrThrow();
        if (kg.gt(0)) await move(trx, { item_type: 'material_lot', item_id: lot.id, from_location_id: loc.id, to_location_id: null, kg: kg.toFixed(3), state_from: 'paint', state_to: 'consumed', ref_type: 'material_consume', ref_id: r.id, userId: me.id });
      }
    }
    if (fee === null) await notifyManagers(trx, { kind: 'fee_incomplete', title: `اجرت نوبت رنگ ${r.number} بدون نرخ؛ هزینه ناقص`, entity: 'documents', entityId: doc.id, groupKey: `coating_fee:${r.id}` });
    await trx.updateTable('coating_runs').set({ status: 'closed', closed_at: new Date(), closed_by: me.id, fee_document_id: doc.id, ...bump }).where('id', '=', r.id).execute();
  }));

  /** Painter scorecard: lateness, avg gain, rejects. */
  app.get('/coating-runs/scorecard', async (req) => {
    requireUser(req);
    const rows = await db.selectFrom('coating_runs').innerJoin('parties', 'parties.id', 'coating_runs.party_id').innerJoin('coating_run_items', 'coating_run_items.run_id', 'coating_runs.id')
      .select(['coating_runs.party_id', 'parties.name', 'coating_runs.service', sql<number>`COUNT(DISTINCT coating_runs.id)::int`.as('runs'), sql<string>`SUM(raw_kg)`.as('raw'), sql<string>`SUM(coated_kg)`.as('coated'), sql<number>`SUM(CASE WHEN qc = 'rejected' THEN 1 ELSE 0 END)::int`.as('rejected'), sql<number>`COUNT(DISTINCT CASE WHEN due_at IS NOT NULL AND returned_at > due_at THEN coating_runs.id END)::int`.as('late')])
      .where('coating_run_items.coated_kg', 'is not', null).groupBy(['coating_runs.party_id', 'parties.name', 'coating_runs.service']).execute();
    return { items: rows.map((x) => ({ party_id: x.party_id, name: x.name, service: x.service, runs: x.runs, late: x.late, rejected_items: x.rejected, gain: weightGain(x.raw, x.coated) })) };
  });
}
