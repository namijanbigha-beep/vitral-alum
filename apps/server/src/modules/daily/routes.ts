import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CURRENCIES, Dec, decimalString, round, toLatinDigits } from '@vitral/shared';
import { sql, type SqlBool } from 'kysely';
import type { ExpressionBuilder } from 'kysely';
import type { Database } from '../../db/schema.js';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Db, Trx } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { can, requirePermission, requireUser, type AuthUser } from '../../lib/auth.js';
import { crudRoutes, idParam, optText, text, uuid, versionField, boolQuery } from '../../lib/crud.js';
import { jalaliDateArg, jalaliDayRange, jalaliToDateKey } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../lib/idempotency.js';
import { nextNumber } from '../../lib/numbering.js';
import { notify, notifyManagers } from '../../lib/notify.js';
import { buildZip } from '../../lib/zip.js';
import { move, OWN_WAREHOUSE } from '../../lib/stock.js';
import { buildDailyReport, snapshotDailyReport } from './report.js';

const bump = { updated_at: new Date(), version: sql<number>`version + 1` };
const TOPICS = ['paint_purchase', 'tool_purchase', 'bill_payment', 'freight_cost', 'misc_delivery', 'damage', 'other'] as const;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function presentNote(r: Record<string, unknown>, user: AuthUser | null): Record<string, unknown> {
  const n = r as Record<string, unknown>;
  const out = { ...n };
  if (!user || !can(user, 'finance.view')) { if (n.sensitive && n.created_by !== user?.id) return { id: n.id, status: n.status, sensitive: true, created_at: n.created_at, created_by: n.created_by }; if (n.created_by !== user?.id) { delete out.amount; delete out.currency; } }
  return out;
}

/** Auto caption from the event the photo belongs to (never from the picture itself). */
export async function galleryItems(db: Db | Trx, f: { start?: Date; end?: Date; party_id?: string; product_id?: string; stage?: string; bundle_id?: string }) {
  let q = db.selectFrom('files').leftJoin('bundles', (j) => j.onRef('bundles.id', '=', 'files.owner_id').on('files.owner_entity', '=', 'bundles')).leftJoin('transfers', (j) => j.onRef('transfers.id', '=', 'files.owner_id').on('files.owner_entity', '=', 'transfers')).leftJoin('scale_tickets', (j) => j.onRef('scale_tickets.id', '=', 'files.owner_id').on('files.owner_entity', '=', 'scale_tickets')).leftJoin('coating_runs', (j) => j.onRef('coating_runs.id', '=', 'files.owner_id').on('files.owner_entity', '=', 'coating_runs'))
    .leftJoin('parties', 'parties.id', 'bundles.factory_party_id').leftJoin('locations', 'locations.id', 'bundles.location_id')
    .select(['files.id', 'files.kind', 'files.mime', 'files.caption', 'files.created_at', 'files.owner_entity', 'files.owner_id', 'files.thumb_key', 'bundles.code as bundle_code', 'bundles.weight_kg as bundle_kg', 'bundles.production_run_id', 'parties.name as factory_name', 'locations.name as location_name', 'transfers.number as transfer_number', 'scale_tickets.stage as ticket_stage', 'coating_runs.number as coating_number'])
    .where('files.sensitive', '=', false).where('files.mime', 'like', 'image/%').where('files.owner_entity', 'in', ['bundles', 'transfers', 'scale_tickets', 'coating_runs', 'production_runs']).orderBy('files.created_at', 'desc').limit(500);
  if (f.start) q = q.where('files.created_at', '>=', f.start);
  if (f.end) q = q.where('files.created_at', '<', f.end);
  if (f.bundle_id) q = q.where('files.owner_id', '=', f.bundle_id);
  if (f.party_id) q = q.where('bundles.factory_party_id', '=', f.party_id);
  if (f.product_id) q = q.where(sql<SqlBool>`EXISTS (SELECT 1 FROM bundle_lines bl WHERE bl.bundle_id = bundles.id AND bl.product_id = ${f.product_id}::uuid)`);
  if (f.stage) q = q.where('files.owner_entity', '=', f.stage === 'production' ? 'bundles' : f.stage === 'coating' ? 'coating_runs' : f.stage === 'scale' ? 'scale_tickets' : 'transfers');
  const rows = await q.execute();
  return rows.map((r) => {
    const stage = r.owner_entity === 'bundles' ? 'تولید' : r.owner_entity === 'coating_runs' ? 'رنگ' : r.owner_entity === 'scale_tickets' ? 'باسکول' : 'بار';
    const parts = [r.factory_name ?? r.location_name, stage, r.bundle_code ? `بندیل ${r.bundle_code}` : r.transfer_number ? `بار ${r.transfer_number}` : r.coating_number ? `نوبت رنگ ${r.coating_number}` : null, r.bundle_kg ? `${round(r.bundle_kg, 'weight')} کیلو` : null].filter(Boolean);
    return { id: r.id, kind: r.kind, caption: r.caption, auto_caption: parts.join(' · '), created_at: r.created_at, owner_entity: r.owner_entity, owner_id: r.owner_id, has_thumb: !!r.thumb_key, bundle_code: r.bundle_code, stage };
  });
}

export function dailyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, storage } = ctx;

  // ---- free notes (spec module 8) ----
  const noteBase = { text: text(4000).min(1), topic: z.enum(TOPICS).nullable().optional(), amount: decimalString.nullable().optional(), currency: z.enum(CURRENCIES).nullable().optional(), party_id: uuid.nullable().optional(), order_id: uuid.nullable().optional(), location_id: uuid.nullable().optional(), qty: decimalString.nullable().optional(), kg: decimalString.nullable().optional(), occurred_at: z.string().datetime({ offset: true }).nullable().optional(), sensitive: z.boolean().default(false), file_ids: z.array(uuid).max(10).optional(), telegram_message_id: optText(60) };
  crudRoutes(app, ctx, {
    table: 'free_notes', path: '/free-notes', createSchema: z.object(noteBase), updateSchema: z.object({ ...versionField, ...Object.fromEntries(Object.entries(noteBase).map(([k, v]) => [k, v.optional()])) }), idempotent: true,
    listSchema: z.object({ status: z.enum(['new', 'needs_info', 'reviewed', 'converted', 'rejected']).optional(), mine: boolQuery.optional(), topic: z.enum(TOPICS).optional() }),
    present: (r, u) => presentNote(r, u),
    filter: (qb, q, user) => {
      if (q.status) qb = qb.where('free_notes.status', '=', String(q.status));
      if (q.topic) qb = qb.where('free_notes.topic', '=', String(q.topic));
      if (q.mine || !can(user, 'finance.view')) qb = qb.where((eb: ExpressionBuilder<Database, keyof Database>) => eb.or([eb('free_notes.created_by', '=', user.id), eb('free_notes.sensitive', '=', false)]));
      return qb;
    },
    beforeCreate: async (_t, i) => { const { file_ids, occurred_at, ...rest } = i; void file_ids; return { ...rest, occurred_at: occurred_at ? new Date(String(occurred_at)) : new Date() }; },
    afterCreate: async (trx, row, input, user) => {
      for (const fid of (input.file_ids as string[] | undefined) ?? []) await trx.insertInto('file_links').values({ file_id: fid, entity: 'free_notes', entity_id: row.id as string, created_by: user.id }).onConflict((oc) => oc.doNothing()).execute();
      await notifyManagers(trx, { kind: 'free_note', title: `ثبت آزاد جدید: ${String(input.text).slice(0, 60)}`, entity: 'free_notes', entityId: row.id as string, groupKey: `note:${row.id}` });
    },
    beforeUpdate: async (_t, before, patch, user) => {
      if (before.created_by !== user.id && !can(user, 'finance.post')) throw new AppError('forbidden');
      if (before.status === 'converted') throw new AppError('validation', 'ثبت تبدیل‌شده تغییر نمی‌کند');
      const { file_ids, occurred_at, ...rest } = patch; void file_ids;
      return occurred_at !== undefined ? { ...rest, occurred_at: occurred_at ? new Date(String(occurred_at)) : null } : rest;
    },
    loadOne: async (trx, id) => {
      const n = await trx.selectFrom('free_notes').leftJoin('users', 'users.id', 'free_notes.created_by').leftJoin('parties', 'parties.id', 'free_notes.party_id').selectAll('free_notes').select(['users.short_name as user_name', 'parties.name as party_name']).where('free_notes.id', '=', id).executeTakeFirst();
      if (!n) return undefined;
      const files = await trx.selectFrom('file_links').innerJoin('files', 'files.id', 'file_links.file_id').select(['files.id', 'files.mime', 'files.caption', 'files.sensitive']).where('entity', '=', 'free_notes').where('entity_id', '=', id).execute();
      const docs = n.converted_document_ids.length ? await trx.selectFrom('documents').select(['id', 'number', 'kind', 'status']).where('id', 'in', n.converted_document_ids).execute() : [];
      return { ...n, files, converted_documents: docs };
    },
  });

  app.post('/free-notes/:id/review', async (req) => {
    const me = requirePermission(req, 'finance.post');
    const { id } = idParam.parse(req.params);
    const body = z.object({ version: z.number().int(), status: z.enum(['needs_info', 'reviewed', 'rejected']), review_note: optText(1000) }).parse(req.body);
    return db.transaction().execute(async (trx) => {
      const n = await trx.selectFrom('free_notes').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!n) throw new AppError('not_found');
      if (n.version !== body.version) throw new AppError('conflict', undefined, undefined, presentNote(n, me));
      if (n.status === 'converted') throw new AppError('validation', 'ثبت تبدیل‌شده است');
      const after = await trx.updateTable('free_notes').set({ status: body.status, review_note: body.review_note ?? null, reviewed_by: me.id, reviewed_at: new Date(), ...bump }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      if (n.created_by) await notify(trx, { userId: n.created_by, kind: 'note_reviewed', title: body.status === 'needs_info' ? `ثبت شما نیاز به اطلاعات دارد: ${body.review_note ?? ''}` : body.status === 'rejected' ? 'ثبت شما رد شد' : 'ثبت شما بررسی شد', entity: 'free_notes', entityId: id });
      await trx.updateTable('notifications').set({ read_at: new Date() }).where('group_key', '=', `note:${id}`).where('read_at', 'is', null).execute();
      await audit(trx, { userId: me.id, entity: 'free_notes', entityId: id, action: 'review', before: { status: n.status }, after: { status: after.status }, reason: body.review_note ?? null });
      return presentNote(after, me);
    });
  });

  /**
   * Convert a free note into documents (T40). Effects: expense | purchase | payment_for_purchase | purchase_and_payment | link_transfer.
   * Idempotent twice over: the Idempotency-Key and the note's conversion_request_id — a second click returns the same documents.
   */
  app.post('/free-notes/:id/convert', async (req) => {
    const me = requirePermission(req, 'finance.post');
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ version: z.number().int(), effect: z.enum(['expense', 'purchase', 'payment_for_purchase', 'purchase_and_payment', 'link_transfer']), party_id: uuid.optional(), amount: decimalString.optional(), currency: z.enum(CURRENCIES).optional(), order_id: uuid.nullable().optional(), expense_type: z.enum(['order', 'shared', 'general']).optional(), expense_category: optText(60), purchase_kind: z.enum(['ingot', 'billet', 'scrap', 'paint_powder', 'tool', 'other']).optional(), kg: decimalString.optional(), receive_to_location_id: uuid.optional(), method: z.enum(['cash', 'card', 'bank_transfer', 'exchange_house', 'cheque', 'other']).default('cash'), account_id: uuid.nullable().optional(), purchase_document_id: uuid.optional(), transfer_id: uuid.optional(), description: optText(300) }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /free-notes/convert', async (trx) => {
      const n = await trx.selectFrom('free_notes').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!n) throw new AppError('not_found');
      if (n.status === 'converted' && n.conversion_request_id) {
        const docs = await trx.selectFrom('documents').select(['id', 'number', 'kind', 'status']).where('id', 'in', n.converted_document_ids.length ? n.converted_document_ids : [id]).execute();
        return { status: 200, body: { note_id: id, documents: docs, transfer_id: n.converted_transfer_id, replayed: true } };
      }
      if (n.version !== body.version) throw new AppError('conflict', undefined, undefined, presentNote(n, me));
      const partyId = body.party_id ?? n.party_id;
      const amount = body.amount ?? n.amount;
      const currency = (body.currency ?? n.currency ?? 'TOMAN') as 'TOMAN' | 'USD' | 'IQD';
      const desc = body.description ?? n.text.slice(0, 200);
      const created: string[] = [];
      let transferId: string | null = null;
      if (body.effect === 'link_transfer') {
        if (!body.transfer_id) throw new AppError('validation', 'شماره بار لازم است', { transfer_id: 'لازم است' });
        transferId = body.transfer_id;
        await trx.insertInto('file_links').values((await trx.selectFrom('file_links').select('file_id').where('entity', '=', 'free_notes').where('entity_id', '=', id).execute()).map((f) => ({ file_id: f.file_id, entity: 'transfers', entity_id: body.transfer_id!, created_by: me.id }))).onConflict((oc) => oc.doNothing()).execute().catch(() => undefined);
      } else {
        if (amount === null || amount === undefined) throw new AppError('validation', 'مبلغ لازم است', { amount: 'لازم است' });
        if (body.effect === 'expense') {
          const d = await trx.insertInto('documents').values({ number: await nextNumber(trx, 'expense'), kind: 'expense', party_id: partyId, order_id: body.order_id ?? n.order_id, amount, currency, status: 'posted', posted_by: me.id, posted_at: new Date(), expense_type: body.expense_type ?? (body.order_id ?? n.order_id ? 'order' : 'general'), expense_category: body.expense_category ?? n.topic, description: desc, source_type: 'free_note', source_id: id, date: n.occurred_at ?? new Date(), created_by: me.id }).returning('id').executeTakeFirstOrThrow();
          if (body.order_id ?? n.order_id) await trx.insertInto('expense_shares').values({ document_id: d.id, order_id: (body.order_id ?? n.order_id)!, amount, currency, created_by: me.id }).execute();
          created.push(d.id);
        }
        let purchaseId: string | null = body.purchase_document_id ?? null;
        if (body.effect === 'purchase' || body.effect === 'purchase_and_payment') {
          if (!partyId) throw new AppError('validation', 'فروشنده لازم است', { party_id: 'لازم است' });
          const kind = body.purchase_kind ?? (n.topic === 'paint_purchase' ? 'paint_powder' : n.topic === 'tool_purchase' ? 'tool' : 'other');
          let lotId: string | null = null;
          if (kind !== 'other') lotId = (await trx.insertInto('material_lots').values({ kind, description: desc, created_by: me.id }).returning('id').executeTakeFirstOrThrow()).id;
          const kg = body.kg ?? n.kg;
          const d = await trx.insertInto('documents').values({ number: await nextNumber(trx, 'purchase'), kind: 'purchase', party_id: partyId, amount, currency, status: 'posted', posted_by: me.id, posted_at: new Date(), purchase_kind: kind, material_lot_id: lotId, agreed_kg: kg, unit_price: kg && !new Dec(kg).isZero() ? round(new Dec(amount).div(kg), currency) : null, description: desc, source_type: 'free_note', source_id: id, date: n.occurred_at ?? new Date(), created_by: me.id }).returning('id').executeTakeFirstOrThrow();
          if (lotId && kg) {
            const to = body.receive_to_location_id ?? n.location_id ?? (await OWN_WAREHOUSE(trx));
            await move(trx, { item_type: 'material_lot', item_id: lotId, from_location_id: null, to_location_id: to, kg, state_to: kind === 'paint_powder' ? 'paint' : kind === 'tool' ? 'tool' : kind === 'scrap' ? 'scrap' : 'ingot', ref_type: 'purchase_receipt', ref_id: d.id, unit_cost: round(new Dec(amount).div(kg), currency), currency, userId: me.id });
            await trx.updateTable('documents').set({ received_kg: kg }).where('id', '=', d.id).execute();
          }
          created.push(d.id); purchaseId = d.id;
        }
        if (body.effect === 'payment_for_purchase' || body.effect === 'purchase_and_payment') {
          if (!purchaseId) throw new AppError('validation', 'سند خرید لازم است', { purchase_document_id: 'لازم است' });
          const p = await trx.selectFrom('documents').selectAll().where('id', '=', purchaseId).executeTakeFirstOrThrow();
          const d = await trx.insertInto('documents').values({ number: await nextNumber(trx, 'payment'), kind: 'payment', party_id: p.party_id, amount, currency, method: body.method, account_id: body.account_id ?? null, status: 'posted', posted_by: me.id, posted_at: new Date(), description: `پرداخت ${p.number}: ${desc}`, source_type: 'free_note', source_id: id, date: n.occurred_at ?? new Date(), created_by: me.id }).returning('id').executeTakeFirstOrThrow();
          const alloc = Dec.min(new Dec(amount), new Dec(p.amount ?? amount));
          try { await trx.insertInto('allocations').values({ from_document_id: d.id, to_document_id: p.id, amount: alloc.toFixed(2), currency, created_by: me.id }).execute(); } catch (e) { if (String((e as Error).message).includes('over_allocation')) throw new AppError('over_allocation'); throw e; }
          created.push(d.id);
        }
      }
      await trx.updateTable('free_notes').set({ status: 'converted', converted_document_ids: created, converted_transfer_id: transferId, conversion_request_id: key, reviewed_by: me.id, reviewed_at: new Date(), ...bump }).where('id', '=', id).execute();
      await trx.updateTable('notifications').set({ read_at: new Date() }).where('group_key', '=', `note:${id}`).where('read_at', 'is', null).execute();
      if (n.created_by) await notify(trx, { userId: n.created_by, kind: 'note_converted', title: 'ثبت شما به سند تبدیل شد', entity: 'free_notes', entityId: id });
      await audit(trx, { userId: me.id, entity: 'free_notes', entityId: id, action: 'convert', after: { effect: body.effect, documents: created, transfer_id: transferId } });
      const docs = created.length ? await trx.selectFrom('documents').select(['id', 'number', 'kind', 'status']).where('id', 'in', created).execute() : [];
      return { status: 200, body: { note_id: id, documents: docs, transfer_id: transferId, replayed: false } };
    });
    return r.body;
  });

  // ---- tasks ----
  const taskBase = { title: text(200).min(1), description: optText(4000), assignee_user_id: uuid, due_at: z.string().datetime({ offset: true }).nullable().optional(), order_id: uuid.nullable().optional(), party_id: uuid.nullable().optional(), transfer_id: uuid.nullable().optional(), voice_file_id: uuid.nullable().optional() };
  crudRoutes(app, ctx, {
    table: 'tasks', path: '/tasks', createSchema: z.object(taskBase), updateSchema: z.object({ ...versionField, ...Object.fromEntries(Object.entries(taskBase).map(([k, v]) => [k, v.optional()])) }), idempotent: true, orderBy: 'created_at',
    listSchema: z.object({ status: z.enum(['open', 'done', 'cancelled']).optional(), assignee_user_id: uuid.optional(), overdue: boolQuery.optional(), order_id: uuid.optional() }),
    present: (r) => r,
    filter: (qb, q, user) => {
      if (user.role !== 'manager') qb = qb.where('tasks.assignee_user_id', '=', user.id);
      if (q.status) qb = qb.where('tasks.status', '=', String(q.status));
      if (q.assignee_user_id) qb = qb.where('tasks.assignee_user_id', '=', String(q.assignee_user_id));
      if (q.order_id) qb = qb.where('tasks.order_id', '=', String(q.order_id));
      if (q.overdue) qb = qb.where('tasks.status', '=', 'open').where('tasks.due_at', '<', new Date());
      return qb;
    },
    beforeCreate: async (_t, i, user) => { if (user.role !== 'manager') throw new AppError('forbidden', 'فقط مدیر کار می‌سازد'); return { ...i, due_at: i.due_at ? new Date(String(i.due_at)) : null }; },
    afterCreate: async (trx, row) => { await notify(trx, { userId: row.assignee_user_id as string, kind: 'task_new', title: `کار جدید: ${row.title}`, entity: 'tasks', entityId: row.id as string }); },
    beforeUpdate: async (_t, before, patch, user) => { if (user.role !== 'manager' && before.assignee_user_id !== user.id) throw new AppError('forbidden'); return patch.due_at !== undefined ? { ...patch, due_at: patch.due_at ? new Date(String(patch.due_at)) : null } : patch; },
    loadOne: async (trx, id, user) => {
      const t = await trx.selectFrom('tasks').leftJoin('users as a', 'a.id', 'tasks.assignee_user_id').leftJoin('users as c', 'c.id', 'tasks.created_by').selectAll('tasks').select(['a.short_name as assignee_name', 'c.short_name as creator_name']).where('tasks.id', '=', id).executeTakeFirst();
      if (!t) return undefined;
      if (user.role !== 'manager' && t.assignee_user_id !== user.id) throw new AppError('forbidden');
      const comments = await trx.selectFrom('task_comments').leftJoin('users', 'users.id', 'task_comments.user_id').selectAll('task_comments').select('users.short_name as user_name').where('task_id', '=', id).orderBy('task_comments.created_at').execute();
      return { ...t, comments };
    },
  });
  app.post('/tasks/:id/done', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ version: z.number().int(), done_note: optText(2000), done_file_id: uuid.nullable().optional() }).parse(req.body);
    const r = await withIdempotency(db, key, me.id, 'POST /tasks/done', async (trx) => {
      const t = await trx.selectFrom('tasks').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!t) throw new AppError('not_found');
      if (me.role !== 'manager' && t.assignee_user_id !== me.id) throw new AppError('forbidden');
      if (t.version !== body.version) throw new AppError('conflict', undefined, undefined, t);
      if (t.status !== 'open') throw new AppError('validation', 'کار باز نیست');
      const after = await trx.updateTable('tasks').set({ status: 'done', done_at: new Date(), done_note: body.done_note ?? null, done_file_id: body.done_file_id ?? null, ...bump }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      if (t.created_by && t.created_by !== me.id) await notify(trx, { userId: t.created_by, kind: 'task_done', title: `کار «${t.title}» انجام شد${body.done_note ? ': ' + body.done_note : ''}`, entity: 'tasks', entityId: id });
      await audit(trx, { userId: me.id, entity: 'tasks', entityId: id, action: 'done', after: { done_note: body.done_note } });
      return { status: 200, body: after };
    });
    return r.body;
  });
  app.post('/tasks/:id/comments', async (req, reply) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = z.object({ text: optText(2000), file_id: uuid.nullable().optional() }).refine((b) => b.text || b.file_id, 'متن یا فایل لازم است').parse(req.body);
    const t = await db.selectFrom('tasks').select(['assignee_user_id', 'created_by', 'title']).where('id', '=', id).executeTakeFirst();
    if (!t) throw new AppError('not_found');
    if (me.role !== 'manager' && t.assignee_user_id !== me.id) throw new AppError('forbidden');
    const c = await db.insertInto('task_comments').values({ task_id: id, user_id: me.id, text: body.text ?? null, file_id: body.file_id ?? null, created_by: me.id }).returningAll().executeTakeFirstOrThrow();
    const other = me.id === t.assignee_user_id ? t.created_by : t.assignee_user_id;
    if (other && other !== me.id) await notify(db, { userId: other, kind: 'task_comment', title: `نظر جدید روی کار «${t.title}»`, entity: 'tasks', entityId: id });
    return reply.status(201).send(c);
  });

  // ---- notifications ----
  app.get('/notifications', async (req) => {
    const me = requireUser(req);
    const q = z.object({ unread: boolQuery.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    let qb = db.selectFrom('notifications').selectAll().where('user_id', '=', me.id).orderBy('created_at', 'desc').limit(q.limit);
    if (q.unread) qb = qb.where('read_at', 'is', null);
    const items = await qb.execute();
    const unread = await db.selectFrom('notifications').select(sql<number>`COUNT(*)::int`.as('n')).where('user_id', '=', me.id).where('read_at', 'is', null).executeTakeFirstOrThrow();
    return { items, unread: unread.n };
  });
  app.post('/notifications/read', async (req) => {
    const me = requireUser(req);
    const body = z.object({ ids: z.array(uuid).max(200).optional(), all: z.boolean().optional() }).parse(req.body ?? {});
    let q = db.updateTable('notifications').set({ read_at: new Date() }).where('user_id', '=', me.id).where('read_at', 'is', null);
    if (!body.all) { if (!body.ids?.length) return { ok: true }; q = q.where('id', 'in', body.ids); }
    await q.execute();
    return { ok: true };
  });

  // ---- share links (T44) ----
  app.post('/share-links', async (req, reply) => {
    const me = requireUser(req);
    const body = z.object({ scope_type: z.enum(['daily_report', 'document', 'bundle_gallery']), scope_id: uuid.optional(), scope_date: z.string().optional(), expires_in_days: z.number().int().min(1).max(90).default(7) }).parse(req.body);
    if (body.scope_type === 'daily_report' && !body.scope_date) throw new AppError('validation', 'تاریخ گزارش لازم است', { scope_date: 'لازم است' });
    if (body.scope_type !== 'daily_report' && !body.scope_id) throw new AppError('validation', 'شناسه لازم است', { scope_id: 'لازم است' });
    if (body.scope_type === 'document') {
      const d = await db.selectFrom('documents').select('kind').where('id', '=', body.scope_id!).executeTakeFirst();
      if (!d) throw new AppError('not_found');
      if (!['invoice', 'sales_return'].includes(d.kind)) throw new AppError('validation', 'فقط فاکتور و برگشت فروش قابل اشتراک است');
    }
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + body.expires_in_days * 86400_000);
    const row = await db.insertInto('share_links').values({ token_hash: sha(token), scope_type: body.scope_type, scope_id: body.scope_id ?? null, scope_date: body.scope_date ? jalaliToDateKey(jalaliDateArg(body.scope_date)) : null, expires_at: expires, created_by: me.id }).returningAll().executeTakeFirstOrThrow();
    await audit(db, { userId: me.id, entity: 'share_links', entityId: row.id, action: 'create', after: { scope_type: row.scope_type, scope_id: row.scope_id, expires_at: row.expires_at } });
    return reply.status(201).send({ id: row.id, url: `/s/${token}`, expires_at: row.expires_at, scope_type: row.scope_type });
  });
  app.get('/share-links', async (req) => {
    const me = requireUser(req);
    const rows = await db.selectFrom('share_links').select(['id', 'scope_type', 'scope_id', 'scope_date', 'expires_at', 'revoked', 'open_count', 'last_opened_at', 'created_at', 'created_by']).where(me.role === 'manager' ? sql<boolean>`true` : sql<boolean>`created_by = ${me.id}::uuid`).orderBy('created_at', 'desc').limit(200).execute();
    return { items: rows };
  });
  app.post('/share-links/:id/revoke', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const l = await db.selectFrom('share_links').selectAll().where('id', '=', id).executeTakeFirst();
    if (!l) throw new AppError('not_found');
    if (l.created_by !== me.id && me.role !== 'manager') throw new AppError('forbidden');
    await db.updateTable('share_links').set({ revoked: true }).where('id', '=', id).execute();
    await audit(db, { userId: me.id, entity: 'share_links', entityId: id, action: 'revoke' });
    return { ok: true };
  });

  // ---- daily report ----
  app.get('/reports/daily', async (req) => {
    const me = requireUser(req);
    const q = z.object({ date: z.string().max(12).optional(), snapshot: boolQuery.optional(), run_id: uuid.optional() }).parse(req.query);
    let date;
    try { date = jalaliDateArg(q.date ? toLatinDigits(q.date) : undefined); } catch { throw new AppError('validation', 'تاریخ شمسی نامعتبر است', { date: 'نامعتبر' }); }
    const finance = can(me, 'finance.view');
    if (q.snapshot && finance) {
      const s = await db.selectFrom('daily_reports').selectAll().where('date', '=', jalaliToDateKey(date)).executeTakeFirst();
      if (s) return { ...(s.snapshot as object), snapshot_at: s.generated_at };
    }
    const r = await buildDailyReport(db, date, { finance, userId: me.id });
    const snap = await db.selectFrom('daily_reports').select('generated_at').where('date', '=', jalaliToDateKey(date)).executeTakeFirst();
    return { ...r, snapshot_at: snap?.generated_at ?? null };
  });
  app.post('/reports/daily/snapshot', async (req) => {
    const me = requirePermission(req, 'settings.manage');
    const q = z.object({ date: z.string().max(12).optional() }).parse(req.body ?? {});
    const date = jalaliDateArg(q.date ? toLatinDigits(q.date) : undefined);
    await snapshotDailyReport(db, date, me.id);
    return { ok: true };
  });

  // ---- gallery & downloads ----
  app.get('/gallery', async (req) => {
    requireUser(req);
    const q = z.object({ date: z.string().max(12).optional(), party_id: uuid.optional(), product_id: uuid.optional(), stage: z.enum(['production', 'coating', 'transfer', 'scale']).optional(), bundle_id: uuid.optional() }).parse(req.query);
    const range = q.date ? jalaliDayRange(jalaliDateArg(toLatinDigits(q.date))) : {};
    return { items: await galleryItems(db, { ...q, ...range }) };
  });
  async function zipOf(ids: string[], namer: (f: { id: string; original_name: string; created_at: Date; caption: string | null }, i: number) => string): Promise<Buffer> {
    const files = ids.length ? await db.selectFrom('files').selectAll().where('id', 'in', ids).where('sensitive', '=', false).execute() : [];
    const entries = [];
    let i = 1;
    for (const f of files) entries.push({ name: namer(f, i++), data: await storage.read(f.storage_key), mtime: f.created_at });
    return buildZip(entries);
  }
  const safe = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_');
  app.get('/bundles/:id/photos.zip', async (req, reply) => {
    requireUser(req);
    const { id } = idParam.parse(req.params);
    const b = await db.selectFrom('bundles').leftJoin('parties', 'parties.id', 'bundles.factory_party_id').select(['bundles.code', 'bundles.reported_at', 'parties.name as factory']).where('bundles.id', '=', id).executeTakeFirst();
    if (!b) throw new AppError('not_found');
    const files = await db.selectFrom('files').select('id').where('owner_entity', '=', 'bundles').where('owner_id', '=', id).execute();
    const day = toLatinDigits(jalaliDateArg(undefined, b.reported_at) && require_fmt(b.reported_at));
    const zip = await zipOf(files.map((f) => f.id), (f, i) => `${day}_${safe(b.factory ?? 'vitral')}_${safe(b.code)}_${i}${ext(f.original_name)}`);
    return reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="bundle_${safe(b.code)}.zip"`).send(zip);
  });
  app.get('/reports/daily/photos.zip', async (req, reply) => {
    requireUser(req);
    const q = z.object({ date: z.string().max(12).optional() }).parse(req.query);
    const date = jalaliDateArg(q.date ? toLatinDigits(q.date) : undefined);
    const items = await galleryItems(db, jalaliDayRange(date));
    const day = require_fmt(jalaliDayRange(date).start);
    const zip = await zipOf(items.map((i) => i.id), (f, i) => { const it = items.find((x) => x.id === f.id); return `${day}_${safe(it?.auto_caption.split(' · ')[0] ?? 'vitral')}_${safe(it?.bundle_code ?? it?.stage ?? '')}_${i}${ext(f.original_name)}`; });
    return reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="report_${day}.zip"`).send(zip);
  });

  // ---- global search ----
  app.get('/search', async (req) => {
    const me = requireUser(req);
    const { q } = z.object({ q: z.string().trim().min(1).max(80) }).parse(req.query);
    const like = `%${toLatinDigits(q)}%`;
    const [parties, products, orders, transfers, bundles] = await Promise.all([
      db.selectFrom('parties').select(['id', 'name', 'roles', 'phones']).where('merged_into_id', 'is', null).where((eb) => eb.or([eb('name', 'ilike', like), sql<SqlBool>`EXISTS (SELECT 1 FROM unnest(phones) p WHERE p ILIKE ${like})`])).limit(10).execute(),
      db.selectFrom('products').select(['id', 'code', 'name_fa']).where((eb) => eb.or([eb('code', 'ilike', like), eb('name_fa', 'ilike', like), eb('name_ar', 'ilike', like)])).limit(10).execute(),
      db.selectFrom('orders').innerJoin('parties', 'parties.id', 'orders.party_id').select(['orders.id', 'orders.number', 'orders.status_sales', 'parties.name as party_name']).where((eb) => eb.or([eb('orders.number', 'ilike', like), eb('orders.title', 'ilike', like)])).limit(10).execute(),
      db.selectFrom('transfers').select(['id', 'number', 'kind', 'status', 'plate']).where((eb) => eb.or([eb('number', 'ilike', like), eb('plate', 'ilike', like), eb('driver_name', 'ilike', like)])).limit(10).execute(),
      db.selectFrom('bundles').select(['id', 'code', 'weight_kg', 'status', 'form']).where('code', 'ilike', like).where('draft', '=', false).limit(10).execute(),
    ]);
    void me;
    return { parties, products, orders, transfers, bundles };
  });

  // ---- telegram link code (spec §16) ----
  app.post('/telegram/link-code', async (req) => {
    const me = requireUser(req);
    const code = String(randomInt(100000, 999999));
    await db.deleteFrom('telegram_link_codes').where('user_id', '=', me.id).where('used_at', 'is', null).execute();
    await db.insertInto('telegram_link_codes').values({ user_id: me.id, code_hash: sha(code), expires_at: new Date(Date.now() + 10 * 60_000), created_by: me.id }).execute();
    return { code, expires_in_seconds: 600 };
  });
  app.post('/telegram/unlink', async (req) => {
    const me = requireUser(req);
    await db.updateTable('users').set({ telegram_chat_id: null, ...bump }).where('id', '=', me.id).execute();
    return { ok: true };
  });

  // Correction requests on posted documents (dashboard «درخواست‌های اصلاح سند قطعی»).
  crudRoutes(app, ctx, {
    table: 'correction_requests', path: '/correction-requests', createSchema: z.object({ entity: z.enum(['documents', 'transfers', 'production_runs', 'bundles']), entity_id: uuid, reason: text(2000).min(3) }), updateSchema: z.object({ ...versionField, status: z.enum(['done', 'rejected']), resolution: optText(2000) }), idempotent: true,
    listSchema: z.object({ status: z.enum(['open', 'done', 'rejected']).optional() }), present: (r) => r,
    filter: (qb, q) => (q.status ? qb.where('correction_requests.status', '=', String(q.status)) : qb),
    afterCreate: async (trx, row) => { await notifyManagers(trx, { kind: 'correction_request', title: `درخواست اصلاح: ${String(row.reason).slice(0, 80)}`, entity: row.entity as string, entityId: row.entity_id as string, groupKey: `corr:${row.id}` }); },
    beforeUpdate: async (_t, _b, patch, user) => { if (!can(user, 'finance.post')) throw new AppError('forbidden'); return { ...patch, resolved_by: user.id, resolved_at: new Date() }; },
  });
}

function require_fmt(d: Date): string {
  const j = jalaliDateArg(undefined, d);
  return `${j.jy}${String(j.jm).padStart(2, '0')}${String(j.jd).padStart(2, '0')}`;
}
function ext(name: string): string {
  const m = /\.[a-z0-9]{2,5}$/i.exec(name);
  return m ? m[0].toLowerCase() : '.jpg';
}

export type { FastifyRequest };
