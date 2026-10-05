import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CURRENCIES, Dec, decimalString, round, type Currency } from '@vitral/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Db, Trx } from '../../db/index.js';
import type { Row } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { can, requirePermission, requireUser, type AuthUser } from '../../lib/auth.js';
import { crudRoutes, idParam, optText, text, uuid, versionField, boolQuery } from '../../lib/crud.js';
import { AppError } from '../../lib/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../lib/idempotency.js';
import { nextNumber } from '../../lib/numbering.js';
import { notifyManagers } from '../../lib/notify.js';
import { decodeCursor, encodeCursor, listQuery } from '../../lib/pagination.js';
import { crossCurrencySettlement, lineAmount, partyBalance, splitByWeight, type BalanceDocKind } from '../../rules/money.js';
import { loadLines } from '../orders/service.js';

const bump = { updated_at: new Date(), version: sql<number>`version + 1` };
const KINDS = ['invoice', 'sales_return', 'purchase', 'toll_fee', 'expense', 'receipt', 'payment', 'barter', 'opening_balance', 'fx_difference'] as const;
const STATUSES = ['draft', 'reported', 'posted', 'void', 'needs_completion'] as const;
const METHODS = ['cash', 'card', 'bank_transfer', 'exchange_house', 'cheque', 'other'] as const;
/** Kinds whose amount is a cost (confidential for users without finance.view). */
const COST_KINDS = new Set(['purchase', 'toll_fee', 'expense']);
type DocRow = Row<'documents'>;

export function presentDocument(r: Record<string, unknown>, user?: AuthUser): Record<string, unknown> {
  const d = r as DocRow & Record<string, unknown>;
  const out: Record<string, unknown> = {
    id: d.id, number: d.number, kind: d.kind, status: d.status, party_id: d.party_id, party_name: d.party_name, order_id: d.order_id, order_number: d.order_number, date: d.date, due_date: d.due_date, amount: d.amount, currency: d.currency, method: d.method, account_id: d.account_id, account_name: d.account_name, tracking_no: d.tracking_no,
    description: d.description, note: d.note, file_ids: d.file_ids, posted_by: d.posted_by, posted_at: d.posted_at, reported_by: d.reported_by, locked: d.locked, print_count: d.print_count, expense_type: d.expense_type, expense_category: d.expense_category, purchase_kind: d.purchase_kind, material_lot_id: d.material_lot_id,
    agreed_kg: d.agreed_kg, received_kg: d.received_kg, unit_price: d.unit_price, settlement_basis_kg: d.settlement_basis_kg, barter_sign: d.barter_sign, barter_kg: d.barter_kg, source_type: d.source_type, source_id: d.source_id, transfer_id: d.transfer_id, reverses_document_id: d.reverses_document_id, reversed_by_document_id: d.reversed_by_document_id,
    lines: d.lines, allocations_out: d.allocations_out, allocations_in: d.allocations_in, allocated: d.allocated, remaining: d.remaining, shares: d.shares, version: d.version, created_at: d.created_at, updated_at: d.updated_at,
  };
  if (user && !can(user, 'finance.view') && COST_KINDS.has(d.kind)) { delete out.amount; delete out.unit_price; delete out.remaining; delete out.allocated; delete out.allocations_in; delete out.shares; }
  return out;
}

export async function loadDocument(db: Db | Trx, id: string) {
  const d = await db.selectFrom('documents').leftJoin('parties', 'parties.id', 'documents.party_id').leftJoin('orders', 'orders.id', 'documents.order_id').leftJoin('accounts', 'accounts.id', 'documents.account_id').selectAll('documents').select(['parties.name as party_name', 'orders.number as order_number', 'accounts.name as account_name']).where('documents.id', '=', id).executeTakeFirst();
  if (!d) return undefined;
  const lines = await db.selectFrom('document_lines').selectAll().where('document_id', '=', id).orderBy('sort').execute();
  const out = await db.selectFrom('allocations').leftJoin('documents as t', 't.id', 'allocations.to_document_id').leftJoin('orders as o', 'o.id', 'allocations.order_id').selectAll('allocations').select(['t.number as to_number', 't.kind as to_kind', 'o.number as order_number']).where('from_document_id', '=', id).orderBy('allocations.created_at').execute();
  const inn = await db.selectFrom('allocations').innerJoin('documents as f', 'f.id', 'allocations.from_document_id').selectAll('allocations').select(['f.number as from_number', 'f.kind as from_kind', 'f.status as from_status']).where('to_document_id', '=', id).orderBy('allocations.created_at').execute();
  const shares = d.kind === 'expense' ? await db.selectFrom('expense_shares').innerJoin('orders', 'orders.id', 'expense_shares.order_id').selectAll('expense_shares').select('orders.number as order_number').where('document_id', '=', id).execute() : undefined;
  const cur = d.currency as Currency;
  const allocatedOut = out.reduce((a, x) => a.plus(x.amount), new Dec(0));
  const allocatedIn = inn.filter((x) => x.from_status === 'posted').reduce((a, x) => a.plus(x.amount_in_target_currency ?? x.amount), new Dec(0));
  const settles = d.kind === 'receipt' || d.kind === 'payment';
  const allocated = settles ? allocatedOut : allocatedIn;
  return { ...d, lines, allocations_out: out, allocations_in: inn, allocated: round(allocated, cur), remaining: d.amount === null ? null : round(new Dec(d.amount).minus(allocated), cur), shares };
}

/** Party statement: posted documents in order with a running balance per currency (R12 sign convention). */
export async function partyStatement(db: Db | Trx, partyId: string, from?: Date, to?: Date) {
  let qb = db.selectFrom('documents').selectAll().where('party_id', '=', partyId).where('status', '=', 'posted').orderBy('date').orderBy('created_at');
  if (from) qb = qb.where('date', '>=', from);
  if (to) qb = qb.where('date', '<', to);
  const docs = await qb.execute();
  const opening = from ? partyBalance((await db.selectFrom('documents').select(['kind', 'amount', 'currency', 'status', 'barter_sign']).where('party_id', '=', partyId).where('status', '=', 'posted').where('date', '<', from).execute()).map(signed)) : {};
  const running: Partial<Record<Currency, Dec>> = {};
  for (const [c, v] of Object.entries(opening) as Array<[Currency, string]>) running[c] = new Dec(v);
  const rows = docs.map((d) => {
    const delta = new Dec(partyBalance([signed(d)])[d.currency as Currency] ?? '0');
    running[d.currency as Currency] = (running[d.currency as Currency] ?? new Dec(0)).plus(delta);
    return { id: d.id, number: d.number, kind: d.kind, date: d.date, description: d.description, currency: d.currency, debit: delta.gt(0) ? round(delta, d.currency as Currency) : null, credit: delta.lt(0) ? round(delta.abs(), d.currency as Currency) : null, balance: round(running[d.currency as Currency]!, d.currency as Currency) };
  });
  const closing: Partial<Record<Currency, string>> = {};
  for (const [c, v] of Object.entries(running) as Array<[Currency, Dec]>) closing[c] = round(v, c);
  return { opening, rows, closing };
}

function signed(d: { kind: string; amount: string | null; currency: string; status: string; barter_sign: number | null }) {
  const signedKinds = d.kind === 'barter' || d.kind === 'fx_difference' || d.kind === 'opening_balance';
  return { kind: d.kind as BalanceDocKind, amount: signedKinds ? new Dec(d.amount ?? 0).mul(d.barter_sign ?? 1).toFixed() : (d.amount ?? '0'), currency: d.currency as Currency, status: d.status };
}

export function moneyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  crudRoutes(app, ctx, {
    table: 'accounts', path: '/accounts', writePermission: 'finance.post', readPermission: 'finance.view',
    createSchema: z.object({ name: text(120).min(1), kind: z.enum(['bank', 'cash']), currency: z.enum(CURRENCIES).default('TOMAN') }),
    updateSchema: z.object({ ...versionField, name: text(120).min(1).optional(), active: z.boolean().optional() }),
    present: (r) => ({ id: r.id, name: r.name, kind: r.kind, currency: r.currency, active: r.active, version: r.version }), orderBy: 'name',
  });

  crudRoutes(app, ctx, {
    table: 'fx_rates', path: '/fx-rates', writePermission: 'finance.post',
    createSchema: z.object({ from_currency: z.enum(CURRENCIES), to_currency: z.enum(CURRENCIES), rate: decimalString, kind: z.enum(['agreed_settlement', 'report_daily']).default('report_daily'), at: z.string().datetime({ offset: true }).optional(), source_text: optText(200) }).refine((r) => r.from_currency !== r.to_currency, 'دو ارز باید متفاوت باشند'),
    updateSchema: z.object({ ...versionField }),
    listSchema: z.object({ from_currency: z.enum(CURRENCIES).optional(), to_currency: z.enum(CURRENCIES).optional(), kind: z.enum(['agreed_settlement', 'report_daily']).optional() }),
    present: (r) => ({ id: r.id, from_currency: r.from_currency, to_currency: r.to_currency, rate: r.rate, kind: r.kind, at: r.at, source_text: r.source_text }),
    filter: (qb, q) => { for (const k of ['from_currency', 'to_currency', 'kind'] as const) if (q[k]) qb = qb.where(`fx_rates.${k}`, '=', String(q[k])); return qb; },
    beforeCreate: async (_t, i) => ({ ...i, at: i.at ? new Date(String(i.at)) : new Date() }), orderBy: 'at',
  });

  /** Latest daily rate for a pair (reports only; settlements use the agreed rate stored on the allocation). */
  app.get('/fx-rates/latest', async (req) => {
    requireUser(req);
    const q = z.object({ from_currency: z.enum(CURRENCIES), to_currency: z.enum(CURRENCIES) }).parse(req.query);
    const r = await db.selectFrom('fx_rates').selectAll().where('from_currency', '=', q.from_currency).where('to_currency', '=', q.to_currency).where('kind', '=', 'report_daily').orderBy('at', 'desc').executeTakeFirst();
    return r ?? null;
  });

  app.get('/documents', async (req) => {
    const me = requireUser(req);
    const q = listQuery.extend({ kind: z.enum(KINDS).optional(), status: z.enum(STATUSES).optional(), party_id: uuid.optional(), order_id: uuid.optional(), q: z.string().max(60).optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), open: boolQuery.optional(), pending: boolQuery.optional() }).parse(req.query);
    let qb = db.selectFrom('documents').leftJoin('parties', 'parties.id', 'documents.party_id').leftJoin('orders', 'orders.id', 'documents.order_id').selectAll('documents').select(['parties.name as party_name', 'orders.number as order_number',
      sql<string>`(SELECT COALESCE(SUM(a.amount),0) FROM allocations a WHERE a.from_document_id = documents.id)`.as('alloc_out'),
      sql<string>`(SELECT COALESCE(SUM(COALESCE(a.amount_in_target_currency, a.amount)),0) FROM allocations a JOIN documents f ON f.id = a.from_document_id WHERE a.to_document_id = documents.id AND f.status = 'posted')`.as('alloc_in')]).orderBy('documents.date', 'desc').orderBy('documents.id', 'desc').limit(q.limit + 1);
    if (!can(me, 'finance.view')) qb = qb.where('documents.kind', 'not in', [...COST_KINDS]);
    if (q.kind) qb = qb.where('documents.kind', '=', q.kind);
    if (q.status) qb = qb.where('documents.status', '=', q.status);
    if (q.pending) qb = qb.where('documents.status', 'in', ['reported', 'needs_completion']);
    if (q.party_id) qb = qb.where('documents.party_id', '=', q.party_id);
    if (q.order_id) qb = qb.where('documents.order_id', '=', q.order_id);
    if (q.q) qb = qb.where((eb) => eb.or([eb('documents.number', 'ilike', `%${q.q}%`), eb('documents.description', 'ilike', `%${q.q}%`), eb('documents.tracking_no', 'ilike', `%${q.q}%`)]));
    if (q.from) qb = qb.where('documents.date', '>=', new Date(q.from));
    if (q.to) qb = qb.where('documents.date', '<', new Date(q.to));
    if (q.open) qb = qb.where('documents.status', '=', 'posted').where('documents.kind', 'in', ['invoice', 'purchase', 'toll_fee', 'expense']).where(sql<SqlBool>`documents.amount > (SELECT COALESCE(SUM(COALESCE(a.amount_in_target_currency, a.amount)),0) FROM allocations a JOIN documents f ON f.id = a.from_document_id WHERE a.to_document_id = documents.id AND f.status = 'posted')`);
    const cur = decodeCursor(q.cursor);
    if (cur) qb = qb.where(sql<SqlBool>`(documents.date, documents.id) < (${new Date(cur.at)}, ${cur.id}::uuid)`);
    const rows = await qb.execute();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((d) => {
        const settles = d.kind === 'receipt' || d.kind === 'payment';
        const allocated = new Dec(settles ? d.alloc_out : d.alloc_in);
        return presentDocument({ ...d, allocated: round(allocated, d.currency as Currency), remaining: d.amount === null ? null : round(new Dec(d.amount).minus(allocated), d.currency as Currency) }, me);
      }),
      next_cursor: rows.length > q.limit && last ? encodeCursor(last.date, last.id) : null,
    };
  });

  app.get('/documents/:id', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const d = await loadDocument(db, id);
    if (!d) throw new AppError('not_found');
    if (!can(me, 'finance.view') && COST_KINDS.has(d.kind)) throw new AppError('forbidden');
    return presentDocument(d, me);
  });

  const lineSchema = z.object({ description: text(300).min(1), qty: decimalString.nullable().optional(), unit: optText(20), unit_price: decimalString.nullable().optional(), amount: decimalString.optional(), vat_rate: decimalString.nullable().optional(), order_line_id: uuid.nullable().optional(), meta: z.record(z.unknown()).nullable().optional() });
  const createSchema = z.object({
    kind: z.enum(KINDS), party_id: uuid.nullable().optional(), order_id: uuid.nullable().optional(), order_ids: z.array(uuid).max(50).optional(), amount: decimalString.nullable().optional(), currency: z.enum(CURRENCIES).optional(), date: z.string().datetime({ offset: true }).optional(), due_date: z.string().datetime({ offset: true }).nullable().optional(),
    method: z.enum(METHODS).nullable().optional(), account_id: uuid.nullable().optional(), tracking_no: optText(80), description: optText(500), note: optText(2000), file_ids: z.array(uuid).max(20).optional(), lines: z.array(lineSchema).max(200).optional(),
    expense_type: z.enum(['order', 'shared', 'general']).nullable().optional(), expense_category: optText(60), shares: z.array(z.object({ order_id: uuid, amount: decimalString })).optional(), barter_sign: z.union([z.literal(1), z.literal(-1)]).optional(), barter_kg: decimalString.nullable().optional(),
    reverses_document_id: uuid.nullable().optional(), settlement_kg: decimalString.nullable().optional(), post: z.boolean().default(false),
    allocations: z.array(z.object({ to_document_id: uuid.optional(), order_id: uuid.optional(), amount: decimalString, rate: decimalString.optional(), rate_from: z.enum(CURRENCIES).optional(), rate_to: z.enum(CURRENCIES).optional() })).max(50).optional(),
  });

  /** Create a document. Staff may create (draft/reported); posting needs finance.post. Invoices can be built from an order. */
  app.post('/documents', async (req, reply) => {
    const me = requireUser(req);
    const key = requireIdempotencyKey(req);
    const body = createSchema.parse(req.body);
    if (body.post) requirePermission(req, 'finance.post');
    if (COST_KINDS.has(body.kind) && !can(me, 'finance.view')) throw new AppError('forbidden', 'ثبت خرید/اجرت/هزینه فقط با دسترسی مالی');
    const r = await withIdempotency(db, key, me.id, 'POST /documents', async (trx) => {
      const at = body.date ? new Date(body.date) : new Date();
      let partyId = body.party_id ?? null;
      let currency = body.currency ?? 'TOMAN';
      let amount = body.amount ?? null;
      let lines: Array<z.infer<typeof lineSchema> & { amount: string }> = [];
      let orderId = body.order_id ?? null;
      let basisKg: string | null = body.settlement_kg ?? null;
      if (body.kind === 'invoice' || body.kind === 'sales_return') {
        if (body.kind === 'sales_return' && body.reverses_document_id) {
          const inv = await trx.selectFrom('documents').selectAll().where('id', '=', body.reverses_document_id).where('kind', '=', 'invoice').executeTakeFirst();
          if (!inv) throw new AppError('validation', 'فاکتور مرجع یافت نشد', { reverses_document_id: 'نامعتبر' });
          partyId = partyId ?? inv.party_id; orderId = orderId ?? inv.order_id; currency = body.currency ?? (inv.currency as Currency);
        }
        if (orderId) {
          const o = await trx.selectFrom('orders').selectAll().where('id', '=', orderId).executeTakeFirst();
          if (!o) throw new AppError('validation', 'سفارش یافت نشد', { order_id: 'نامعتبر' });
          if (body.kind === 'invoice' && o.status_sales !== 'approved') throw new AppError('validation', 'فاکتور فقط برای سفارش تأییدشده صادر می‌شود');
          partyId = partyId ?? o.party_id; currency = body.currency ?? (o.currency as Currency);
          if (!body.lines) {
            const ol = await loadLines(trx, orderId);
            // Settlement on final net scale: the approved «sale» ticket of the delivery replaces estimated kg for per-kg lines (R10 stays the same formula).
            if (body.kind === 'invoice' && o.settlement_basis === 'final_net_scale' && !basisKg) {
              const t = await trx.selectFrom('scale_tickets').innerJoin('transfers', 'transfers.id', 'scale_tickets.transfer_id').select(['scale_tickets.net_direct_kg', 'scale_tickets.gross_kg', 'scale_tickets.tare_kg', 'scale_tickets.packaging_kg']).where('scale_tickets.status', '=', 'approved').where(sql<SqlBool>`'sale' = ANY(scale_tickets.approved_for)`).where(sql<SqlBool>`${orderId}::uuid = ANY(transfers.order_ids)`).orderBy('scale_tickets.approved_at', 'desc').executeTakeFirst();
              if (t) basisKg = t.net_direct_kg ?? (t.gross_kg && t.tare_kg ? round(new Dec(t.gross_kg).minus(t.tare_kg).minus(t.packaging_kg ?? 0), 'weight') : null);
            }
            const perKgTotal = ol.filter((l) => l.price_basis === 'per_kg' && l.qty_kg).reduce((a, l) => a.plus(l.qty_kg!), new Dec(0));
            for (const l of ol) {
              if (l.currency !== currency) continue;
              let qty = l.price_basis === 'per_kg' ? l.qty_kg : l.price_basis === 'per_bar' ? l.qty_bars : l.price_basis === 'per_piece' ? (l.qty_pieces === null ? null : String(l.qty_pieces)) : l.qty_kg;
              if (basisKg && l.price_basis === 'per_kg' && l.qty_kg && !perKgTotal.isZero()) qty = round(new Dec(basisKg).mul(l.qty_kg).div(perKgTotal), 'weight');
              const amt = lineAmount(qty, l.unit_price, currency, l.discount_amount, l.discount_percent);
              if (amt === null) throw new AppError('validation', `ردیف «${l.description ?? l.product_id}» قیمت ندارد`, { lines: 'قیمت ناقص' });
              lines.push({ description: l.description ?? l.load_type_label ?? 'ردیف', qty, unit: l.price_basis === 'per_kg' ? 'kg' : l.price_basis === 'per_bar' ? 'bar' : l.price_basis === 'per_piece' ? 'piece' : 'm', unit_price: l.unit_price, amount: amt, vat_rate: l.vat_rate, order_line_id: l.id, meta: { product_id: l.product_id, color: l.color, length_m: l.length_m, name_ar: l.name_ar, name_en: l.name_en } });
            }
          }
        }
      }
      if (body.lines) lines = body.lines.map((l) => ({ ...l, amount: l.amount ?? (l.qty && l.unit_price ? round(new Dec(l.qty).mul(l.unit_price), currency) : '0') }));
      if (lines.length) amount = round(lines.reduce((a, l) => a.plus(l.amount).plus(l.vat_rate && l.amount ? new Dec(l.amount).mul(l.vat_rate).div(100) : 0), new Dec(0)), currency);
      if (['receipt', 'payment', 'barter', 'opening_balance', 'fx_difference', 'invoice', 'sales_return'].includes(body.kind) && !partyId) throw new AppError('validation', 'طرف حساب لازم است', { party_id: 'لازم است' });
      if (body.kind === 'expense' && body.expense_type === 'order' && !orderId) throw new AppError('validation', 'هزینه سفارشی باید به سفارش وصل باشد', { order_id: 'لازم است' });
      if ((body.kind === 'receipt' || body.kind === 'payment') && (amount === null || new Dec(amount).lte(0))) throw new AppError('validation', 'مبلغ لازم است', { amount: 'لازم است' });
      const status = amount === null ? 'needs_completion' : body.post ? 'posted' : body.kind === 'receipt' || body.kind === 'payment' ? 'reported' : 'draft';
      const d = await trx.insertInto('documents').values({
        number: await nextNumber(trx, body.kind, at), kind: body.kind, party_id: partyId, order_id: orderId, amount, currency, date: at, due_date: body.due_date ? new Date(body.due_date) : null, method: body.method ?? null, account_id: body.account_id ?? null, tracking_no: body.tracking_no ?? null,
        description: body.description ?? null, note: body.note ?? null, file_ids: body.file_ids ?? [], status, posted_by: status === 'posted' ? me.id : null, posted_at: status === 'posted' ? new Date() : null, reported_by: me.id, expense_type: body.kind === 'expense' ? body.expense_type ?? (orderId ? 'order' : body.order_ids?.length ? 'shared' : 'general') : null,
        expense_category: body.expense_category ?? null, barter_sign: body.kind === 'barter' || body.kind === 'opening_balance' || body.kind === 'fx_difference' ? body.barter_sign ?? 1 : null, barter_kg: body.barter_kg ?? null, reverses_document_id: body.reverses_document_id ?? null, settlement_basis_kg: basisKg, created_by: me.id,
      }).returningAll().executeTakeFirstOrThrow();
      let sort = 0;
      for (const l of lines) await trx.insertInto('document_lines').values({ document_id: d.id, description: l.description, qty: l.qty ?? null, unit: l.unit ?? null, unit_price: l.unit_price ?? null, amount: l.amount, vat_rate: l.vat_rate ?? null, vat_amount: l.vat_rate ? round(new Dec(l.amount).mul(l.vat_rate).div(100), currency) : null, order_line_id: l.order_line_id ?? null, meta: l.meta ? JSON.stringify(l.meta) : null, sort: sort++, created_by: me.id }).execute();
      if (body.kind === 'expense' && amount !== null) await writeShares(trx, d, body.order_ids ?? [], body.shares, me.id);
      if (body.allocations?.length) await allocate(trx, d, body.allocations, me);
      if (body.reverses_document_id && body.kind === 'sales_return') await trx.updateTable('documents').set({ reversed_by_document_id: d.id, ...bump }).where('id', '=', body.reverses_document_id).execute();
      if (status === 'reported') await notifyManagers(trx, { kind: 'document_reported', title: `${d.kind === 'receipt' ? 'دریافت' : 'پرداخت'} ${d.number} به مبلغ ${amount} ${currency} گزارش شد؛ منتظر تأیید`, entity: 'documents', entityId: d.id, groupKey: `reported:${d.id}` });
      await audit(trx, { userId: me.id, entity: 'documents', entityId: d.id, action: 'create', after: d });
      return { status: 201, body: presentDocument((await loadDocument(trx, d.id))!, me) };
    });
    return reply.status(r.status).send(r.body);
  });

  /** Expense shares (R16): manual amounts or split by order weight (sum of order lines kg). */
  async function writeShares(trx: Trx, d: DocRow, orderIds: string[], manual: Array<{ order_id: string; amount: string }> | undefined, userId: string): Promise<void> {
    await trx.deleteFrom('expense_shares').where('document_id', '=', d.id).execute();
    if (d.expense_type === 'order' && d.order_id) { await trx.insertInto('expense_shares').values({ document_id: d.id, order_id: d.order_id, amount: d.amount!, currency: d.currency, created_by: userId }).execute(); return; }
    if (d.expense_type !== 'shared') return;
    if (manual?.length) {
      const sum = manual.reduce((a, m) => a.plus(m.amount), new Dec(0));
      if (!sum.eq(d.amount!)) throw new AppError('validation', `جمع سهم‌ها (${sum}) با مبلغ هزینه (${d.amount}) برابر نیست`, { shares: 'ناسازگار' });
      for (const m of manual) await trx.insertInto('expense_shares').values({ document_id: d.id, order_id: m.order_id, amount: m.amount, currency: d.currency, manual: true, created_by: userId }).execute();
      return;
    }
    if (!orderIds.length) throw new AppError('validation', 'هزینه مشترک سفارش‌ها یا سهم دستی لازم دارد', { order_ids: 'لازم است' });
    const weights = await trx.selectFrom('order_lines').select(['order_id', sql<string>`COALESCE(SUM(qty_kg),0)`.as('kg')]).where('order_id', 'in', orderIds).groupBy('order_id').execute();
    const ordered = orderIds.map((id) => ({ id, kg: weights.find((w) => w.order_id === id)?.kg ?? '0' }));
    let shares: string[];
    try { shares = splitByWeight(d.amount!, ordered.map((o) => o.kg), d.currency as Currency); } catch { throw new AppError('validation', 'وزن سفارش‌ها صفر است؛ سهم‌ها را دستی بدهید', { shares: 'لازم است' }); }
    for (const [i, o] of ordered.entries()) await trx.insertInto('expense_shares').values({ document_id: d.id, order_id: o.id, amount: shares[i]!, currency: d.currency, weight_kg: o.kg, created_by: userId }).execute();
  }

  /** Allocate a receipt/payment to invoices/orders/purchases (R24 across currencies with an agreed rate). The DB trigger refuses over-allocation. */
  async function allocate(trx: Trx, d: DocRow, items: Array<{ to_document_id?: string; order_id?: string; amount: string; rate?: string; rate_from?: Currency; rate_to?: Currency }>, me: AuthUser): Promise<void> {
    if (d.kind !== 'receipt' && d.kind !== 'payment') throw new AppError('validation', 'فقط دریافت/پرداخت تخصیص می‌گیرد');
    for (const it of items) {
      if (!it.to_document_id === !it.order_id) throw new AppError('validation', 'هر تخصیص یا به سند است یا به سفارش', { allocations: 'نامعتبر' });
      let targetCurrency: Currency = d.currency as Currency;
      let targetAmount: string | null = null;
      let fxId: string | null = null;
      if (it.to_document_id) {
        const t = await trx.selectFrom('documents').selectAll().where('id', '=', it.to_document_id).executeTakeFirst();
        if (!t || t.status !== 'posted') throw new AppError('validation', 'سند مقصد باید قطعی باشد', { to_document_id: 'نامعتبر' });
        if (d.kind === 'receipt' && t.kind !== 'invoice') throw new AppError('validation', 'دریافت فقط به فاکتور تخصیص می‌یابد');
        if (d.kind === 'payment' && !COST_KINDS.has(t.kind)) throw new AppError('validation', 'پرداخت فقط به خرید/اجرت/هزینه تخصیص می‌یابد');
        if (t.party_id !== d.party_id) throw new AppError('validation', 'طرف حساب سند مقصد با این سند یکی نیست');
        targetCurrency = t.currency as Currency;
      } else {
        const o = await trx.selectFrom('orders').select(['currency', 'party_id']).where('id', '=', it.order_id!).executeTakeFirst();
        if (!o) throw new AppError('validation', 'سفارش یافت نشد', { order_id: 'نامعتبر' });
        if (o.party_id !== d.party_id) throw new AppError('validation', 'سفارش متعلق به این طرف نیست');
        targetCurrency = o.currency as Currency;
      }
      if (targetCurrency !== d.currency) {
        if (!it.rate || !it.rate_from || !it.rate_to) throw new AppError('validation', 'تسویه بین دو ارز نرخ توافقی لازم دارد', { rate: 'لازم است' });
        targetAmount = crossCurrencySettlement(it.amount, d.currency as Currency, targetCurrency, it.rate, it.rate_from, it.rate_to);
        const fx = await trx.insertInto('fx_rates').values({ from_currency: it.rate_from, to_currency: it.rate_to, rate: it.rate, kind: 'agreed_settlement', source_text: `تسویه ${d.number}`, created_by: me.id }).returning('id').executeTakeFirstOrThrow();
        fxId = fx.id;
      }
      try {
        await trx.insertInto('allocations').values({ from_document_id: d.id, to_document_id: it.to_document_id ?? null, order_id: it.order_id ?? null, amount: it.amount, currency: d.currency, amount_in_target_currency: targetAmount, target_currency: targetAmount ? targetCurrency : null, fx_rate_id: fxId, created_by: me.id }).execute();
      } catch (e) {
        if (String((e as Error).message).includes('over_allocation')) throw new AppError('over_allocation');
        throw e;
      }
    }
  }

  async function act(req: FastifyRequest, name: string, perm: 'finance.post' | null, schema: z.ZodTypeAny, work: (trx: Trx, d: DocRow, me: AuthUser, body: Record<string, unknown>) => Promise<void>) {
    const me = perm ? requirePermission(req, perm) : requireUser(req);
    const { id } = idParam.parse(req.params);
    const key = requireIdempotencyKey(req);
    const body = z.object({ version: z.number().int() }).and(schema).parse(req.body ?? {}) as Record<string, unknown> & { version: number };
    const r = await withIdempotency(db, key, me.id, `POST /documents/${name}`, async (trx) => {
      const d = await trx.selectFrom('documents').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d) throw new AppError('not_found');
      if (d.version !== body.version) throw new AppError('conflict', undefined, undefined, presentDocument((await loadDocument(trx, id))!, me));
      await work(trx, d, me, body);
      const after = await trx.selectFrom('documents').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      await audit(trx, { userId: me.id, entity: 'documents', entityId: id, action: name, before: { status: d.status, amount: d.amount }, after: { status: after.status, amount: after.amount }, reason: (body.reason as string | null) ?? null });
      return { status: 200, body: presentDocument((await loadDocument(trx, id))!, me) };
    });
    return r.body;
  }

  /** Edit a non-posted document (T37: posted → refused). */
  app.patch('/documents/:id', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const body = z.object({ ...versionField, amount: decimalString.nullable().optional(), date: z.string().datetime({ offset: true }).optional(), due_date: z.string().datetime({ offset: true }).nullable().optional(), method: z.enum(METHODS).nullable().optional(), account_id: uuid.nullable().optional(), tracking_no: optText(80), description: optText(500), note: optText(2000), file_ids: z.array(uuid).max(20).optional(), party_id: uuid.nullable().optional(), lines: z.array(lineSchema).max(200).optional(), expense_category: optText(60) }).parse(req.body);
    return db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('documents').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d) throw new AppError('not_found');
      if (d.version !== body.version) throw new AppError('conflict', undefined, undefined, presentDocument((await loadDocument(trx, id))!, me));
      if (d.status === 'posted' || d.status === 'void' || d.locked) throw new AppError('validation', 'سند قطعی تغییر نمی‌کند؛ برای اصلاح سند برگشتی/اصلاحی بزنید');
      if (COST_KINDS.has(d.kind) && !can(me, 'finance.view')) throw new AppError('forbidden');
      const { version, lines, date, due_date, ...rest } = body;
      void version;
      let amount = rest.amount !== undefined ? rest.amount : d.amount;
      if (lines) {
        await trx.deleteFrom('document_lines').where('document_id', '=', id).execute();
        let sort = 0; let sum = new Dec(0);
        for (const l of lines) { const amt = l.amount ?? (l.qty && l.unit_price ? round(new Dec(l.qty).mul(l.unit_price), d.currency as Currency) : '0'); sum = sum.plus(amt).plus(l.vat_rate ? new Dec(amt).mul(l.vat_rate).div(100) : 0); await trx.insertInto('document_lines').values({ document_id: id, description: l.description, qty: l.qty ?? null, unit: l.unit ?? null, unit_price: l.unit_price ?? null, amount: amt, vat_rate: l.vat_rate ?? null, order_line_id: l.order_line_id ?? null, meta: l.meta ? JSON.stringify(l.meta) : null, sort: sort++, created_by: me.id }).execute(); }
        amount = round(sum, d.currency as Currency);
      }
      const after = await trx.updateTable('documents').set({ ...rest, amount, status: amount === null ? 'needs_completion' : d.status === 'needs_completion' ? 'draft' : d.status, ...(date ? { date: new Date(date) } : {}), ...(due_date !== undefined ? { due_date: due_date ? new Date(due_date) : null } : {}), ...bump }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      if (after.kind === 'expense' && after.amount && after.amount !== d.amount) { const prev = await trx.selectFrom('expense_shares').selectAll().where('document_id', '=', id).execute(); await writeShares(trx, after, prev.map((p) => p.order_id), prev.some((p) => p.manual) ? undefined : undefined, me.id); }
      await audit(trx, { userId: me.id, entity: 'documents', entityId: id, action: 'update', before: d, after });
      return presentDocument((await loadDocument(trx, id))!, me);
    });
  });

  /** Post (finance.post): the document becomes immutable and counts in balances (T43: a reported receipt counts only from here). */
  app.post('/documents/:id/post', (req) => act(req, 'post', 'finance.post', z.object({}), async (trx, d, me) => {
    if (d.status === 'posted') throw new AppError('validation', 'سند قبلاً قطعی شده است');
    if (d.status === 'void') throw new AppError('validation', 'سند باطل است');
    if (d.amount === null) throw new AppError('validation', 'سند ناقص است؛ مبلغ لازم است', { amount: 'لازم است' });
    if ((d.kind === 'receipt' || d.kind === 'payment') && !d.method) throw new AppError('validation', 'روش دریافت/پرداخت لازم است', { method: 'لازم است' });
    await trx.updateTable('documents').set({ status: 'posted', posted_by: me.id, posted_at: new Date(), locked: true, ...bump }).where('id', '=', d.id).execute();
    if (d.kind === 'invoice' && d.order_id) await trx.updateTable('orders').set({ updated_at: new Date(), version: sql`version + 1` }).where('id', '=', d.order_id).execute();
  }));

  /** Void (finance.post, reason required): status → void, allocations removed; the row itself stays for history. */
  app.post('/documents/:id/void', (req) => act(req, 'void', 'finance.post', z.object({ reason: z.string().trim().min(3).max(1000) }), async (trx, d, me, body) => {
    if (d.status === 'void') throw new AppError('validation', 'سند قبلاً باطل شده است');
    const incoming = await trx.selectFrom('allocations').innerJoin('documents as f', 'f.id', 'allocations.from_document_id').select('allocations.id').where('to_document_id', '=', d.id).where('f.status', '=', 'posted').executeTakeFirst();
    if (incoming) throw new AppError('validation', 'این سند تخصیص دریافت/پرداخت دارد؛ اول تخصیص‌ها را آزاد کنید');
    await trx.deleteFrom('allocations').where('from_document_id', '=', d.id).execute();
    if (d.kind === 'expense') await trx.deleteFrom('expense_shares').where('document_id', '=', d.id).execute();
    // Reversal document (spec: «ابطال با سند معکوس»): same kind and amount, both rows carry status void and point at each other.
    const rev = await trx.insertInto('documents').values({ number: await nextNumber(trx, d.kind), kind: d.kind, party_id: d.party_id, order_id: d.order_id, amount: d.amount, currency: d.currency, status: 'void', locked: true, reverses_document_id: d.id, description: `ابطال ${d.number}: ${String(body.reason)}`, created_by: me.id }).returning('id').executeTakeFirstOrThrow();
    await trx.updateTable('documents').set({ status: 'void', locked: true, reversed_by_document_id: rev.id, ...bump }).where('id', '=', d.id).execute();
    if (d.reverses_document_id) await trx.updateTable('documents').set({ reversed_by_document_id: null, ...bump }).where('id', '=', d.reverses_document_id).execute();
  }));

  app.post('/documents/:id/allocate', (req) => act(req, 'allocate', 'finance.post', z.object({ items: z.array(z.object({ to_document_id: uuid.optional(), order_id: uuid.optional(), amount: decimalString, rate: decimalString.optional(), rate_from: z.enum(CURRENCIES).optional(), rate_to: z.enum(CURRENCIES).optional() })).min(1).max(50) }), async (trx, d, me, body) => {
    await allocate(trx, d, body.items as never, me);
  }));

  app.post('/documents/:id/unallocate', (req) => act(req, 'unallocate', 'finance.post', z.object({ allocation_id: uuid }), async (trx, d, _me, body) => {
    const a = await trx.selectFrom('allocations').selectAll().where('id', '=', String(body.allocation_id)).where('from_document_id', '=', d.id).executeTakeFirst();
    if (!a) throw new AppError('not_found');
    await trx.deleteFrom('allocations').where('id', '=', a.id).execute();
  }));

  /** Manual expense shares (finance.post). */
  app.post('/documents/:id/shares', (req) => act(req, 'shares', 'finance.post', z.object({ shares: z.array(z.object({ order_id: uuid, amount: decimalString })).min(1) }), async (trx, d, me, body) => {
    if (d.kind !== 'expense' || d.amount === null) throw new AppError('validation', 'فقط هزینه با مبلغ سهم‌بندی می‌شود');
    await trx.updateTable('documents').set({ expense_type: 'shared', ...bump }).where('id', '=', d.id).execute();
    await writeShares(trx, { ...d, expense_type: 'shared' }, [], body.shares as never, me.id);
  }));

  /** Party ledger (statement) with running balances; also drives the statement PDF. */
  app.get('/parties/:id/statement', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const q = z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).parse(req.query);
    const party = await db.selectFrom('parties').select(['id', 'name', 'name_ar', 'phones', 'address']).where('id', '=', id).executeTakeFirst();
    if (!party) throw new AppError('not_found');
    const st = await partyStatement(db, id, q.from ? new Date(q.from) : undefined, q.to ? new Date(q.to) : undefined);
    if (!can(me, 'finance.view')) st.rows = st.rows.filter((r) => !COST_KINDS.has(r.kind));
    return { party, ...st };
  });

  /** Open items for a party: invoices (receivable) and purchases/fees/expenses (payable) with remaining amounts. */
  app.get('/parties/:id/open-items', async (req) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const rows = await db.selectFrom('documents').selectAll().select(sql<string>`(SELECT COALESCE(SUM(COALESCE(a.amount_in_target_currency, a.amount)),0) FROM allocations a JOIN documents f ON f.id = a.from_document_id WHERE a.to_document_id = documents.id AND f.status = 'posted')`.as('alloc_in')).where('party_id', '=', id).where('status', '=', 'posted').where('kind', 'in', ['invoice', 'purchase', 'toll_fee', 'expense']).orderBy('date').execute();
    const items = rows.map((d) => ({ ...presentDocument({ ...d, allocated: round(d.alloc_in, d.currency as Currency), remaining: round(new Dec(d.amount ?? 0).minus(d.alloc_in), d.currency as Currency) }, me) })).filter((d) => d.remaining && new Dec(d.remaining as string).gt(0));
    const unallocated = await db.selectFrom('documents').selectAll().select(sql<string>`(SELECT COALESCE(SUM(a.amount),0) FROM allocations a WHERE a.from_document_id = documents.id)`.as('alloc_out')).where('party_id', '=', id).where('status', '=', 'posted').where('kind', 'in', ['receipt', 'payment']).where(sql<SqlBool>`documents.amount > (SELECT COALESCE(SUM(a.amount),0) FROM allocations a WHERE a.from_document_id = documents.id)`).execute();
    return { items, unallocated: unallocated.map((d) => presentDocument({ ...d, allocated: round(d.alloc_out, d.currency as Currency), remaining: round(new Dec(d.amount ?? 0).minus(d.alloc_out), d.currency as Currency) }, me)) };
  });

  /** Pending confirmations for the manager: reported receipts/payments and incomplete documents. */
  app.get('/documents/pending', async (req) => {
    const me = requirePermission(req, 'finance.view');
    const rows = await db.selectFrom('documents').leftJoin('parties', 'parties.id', 'documents.party_id').leftJoin('users', 'users.id', 'documents.reported_by').selectAll('documents').select(['parties.name as party_name', 'users.short_name as reported_by_name']).where('documents.status', 'in', ['reported', 'needs_completion']).orderBy('documents.created_at').execute();
    return { items: rows.map((d) => presentDocument(d, me)) };
  });
}
