import { boolQuery } from '../../lib/crud.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Dec, formatNumber, round, toPersianDigits, type Currency } from '@vitral/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { can, loadBotUser } from '../../lib/auth.js';
import { jalaliDateArg } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { buildDailyReport } from '../daily/report.js';
import { positionsDetailed } from '../stock/routes.js';
import { partyStatement } from '../money/routes.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const chatId = z.string().regex(/^-?\d{1,20}$/);
const fa = (v: unknown, kind?: Parameters<typeof formatNumber>[1]) => formatNumber(String(v ?? 0), kind) ?? '۰';
const CUR: Record<string, string> = { TOMAN: 'تومان', USD: 'دلار', IQD: 'دینار' };

/**
 * Internal endpoints for the Telegram bot service (spec §16). Guarded by BOT_SERVICE_KEY; the bot then calls the
 * regular API as the linked user (X-Bot-User), so permissions and confidential filtering stay in one place.
 */
export function botRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;

  function guard(req: FastifyRequest): void {
    const key = req.headers['x-bot-key'];
    if (!config.BOT_SERVICE_KEY || typeof key !== 'string' || key.length !== config.BOT_SERVICE_KEY.length || !timingSafeEqual(Buffer.from(key), Buffer.from(config.BOT_SERVICE_KEY))) throw new AppError('forbidden', 'کلید سرویس بات نامعتبر است');
  }
  async function userOf(req: FastifyRequest) {
    const uid = req.headers['x-bot-user'];
    const u = typeof uid === 'string' ? await loadBotUser(db, uid) : null;
    if (!u) throw new AppError('unauthorized', 'این چت به کاربری متصل نیست');
    return u;
  }

  app.addHook('onRequest', async (req) => { if (req.url.startsWith('/api/v1/internal/bot')) guard(req); });

  /** /start <code>: bind the chat to the user who generated the code (10-minute, single use). */
  app.post('/internal/bot/link', async (req) => {
    const b = z.object({ chat_id: chatId, code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const row = await db.selectFrom('telegram_link_codes').select(['id', 'user_id']).where('code_hash', '=', sha(b.code)).where('used_at', 'is', null).where('expires_at', '>', new Date()).executeTakeFirst();
    if (!row) throw new AppError('not_found', 'کد نامعتبر یا منقضی است');
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('users').set({ telegram_chat_id: null }).where('telegram_chat_id', '=', b.chat_id).execute();
      await trx.updateTable('users').set({ telegram_chat_id: b.chat_id, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', row.user_id).execute();
      await trx.updateTable('telegram_link_codes').set({ used_at: new Date() }).where('id', '=', row.id).execute();
    });
    const u = await db.selectFrom('users').select(['id', 'name', 'short_name', 'role']).where('id', '=', row.user_id).executeTakeFirstOrThrow();
    return { user: u };
  });

  /** chat_id → user (null when unregistered; the caller logs it, T55). */
  app.get('/internal/bot/resolve', async (req) => {
    const q = z.object({ chat_id: chatId }).parse(req.query);
    const u = await db.selectFrom('users').select(['id', 'name', 'short_name', 'role', 'permissions']).where('telegram_chat_id', '=', q.chat_id).where('active', '=', true).executeTakeFirst();
    if (!u) return { user: null };
    const au = await loadBotUser(db, u.id);
    return { user: { ...u, permissions: au?.permissions ?? [], finance: can(au, 'finance.view') } };
  });

  app.post('/internal/bot/log', async (req) => {
    const b = z.object({ chat_id: chatId.nullable(), kind: z.string().max(40), detail: z.string().max(2000).nullable().optional() }).parse(req.body);
    await db.insertInto('bot_log').values({ chat_id: b.chat_id, kind: b.kind, detail: b.detail ?? null }).execute();
    return { ok: true };
  });

  /** Unsent notifications for users with a linked chat; marked sent when claimed (instant alerts, §16). */
  app.post('/internal/bot/notifications/claim', async () => {
    return db.transaction().execute(async (trx) => {
      const rows = await trx.selectFrom('notifications').innerJoin('users', 'users.id', 'notifications.user_id').select(['notifications.id', 'notifications.kind', 'notifications.title', 'notifications.entity', 'notifications.entity_id', 'users.telegram_chat_id as chat_id']).where('notifications.telegram_sent_at', 'is', null).where('notifications.read_at', 'is', null).where('users.telegram_chat_id', 'is not', null).where('users.active', '=', true).orderBy('notifications.created_at').limit(50).execute();
      if (rows.length) await trx.updateTable('notifications').set({ telegram_sent_at: new Date() }).where('id', 'in', rows.map((r) => r.id)).execute();
      return { items: rows };
    });
  });

  /** Managers (and anyone with finance.view) who should receive the nightly report. */
  app.get('/internal/bot/report-recipients', async () => {
    const rows = await db.selectFrom('users').select(['id', 'telegram_chat_id as chat_id', 'role']).where('telegram_chat_id', 'is not', null).where('active', '=', true).where('role', '=', 'manager').execute();
    return { items: rows };
  });

  // ── Ready-made Persian texts (the bot forwards these verbatim) ───────────────
  /** امروز / گزارش: production text for a Jalali date + a short decision summary. Money only for finance.view (T56). */
  app.get('/internal/bot/text/report', async (req) => {
    const me = await userOf(req);
    const q = z.object({ date: z.string().optional(), full: boolQuery.default(false) }).parse(req.query);
    const date = jalaliDateArg(q.date);
    const r = await buildDailyReport(db, date, { finance: can(me, 'finance.view'), userId: me.id });
    const lines = [q.full ? r.production.text_full : r.production.text];
    const d = r.decisions;
    if (d.quarantine.length || d.weight_warnings.length || d.incomplete_documents.length || d.pending_money) {
      lines.push('', '⚠️ نیازمند تصمیم:');
      if (d.quarantine.length) lines.push(`• ${fa(d.quarantine.length)} بندیل در قرنطینه`);
      if (d.weight_warnings.length) lines.push(`• ${fa(d.weight_warnings.length)} هشدار وزن`);
      if (d.incomplete_documents.length) lines.push(`• ${fa(d.incomplete_documents.length)} سند/قبض ناقص`);
      if (d.pending_money) lines.push(`• ${fa(d.pending_money)} دریافت/پرداخت در انتظار تأیید`);
    }
    if (r.transfers.length) { lines.push('', '🚚 بارها:'); for (const t of r.transfers) lines.push(`• ${toPersianDigits(String(t.number))} ${String(t.from_name ?? '')} ← ${String(t.to_name ?? '')} · ${fa(t.kg, 'weight')} کیلو · ${String(t.status)}`); }
    if (r.money && r.money.length) { lines.push('', '💰 دریافت/پرداخت امروز:'); for (const m of r.money) lines.push(`• ${m.kind === 'receipt' ? 'دریافت' : 'پرداخت'} ${fa(m.amount, m.currency as Currency)} ${CUR[String(m.currency)]} از/به ${String(m.party_name ?? '—')} (${String(m.status)})`); }
    if (r.tasks.open.length) lines.push('', `📝 کارهای باز: ${fa(r.tasks.open.length)}`);
    return { text: lines.join('\n'), date: r.date };
  });

  /** بندیل <code>: one bundle, with where it is and its state. */
  app.get('/internal/bot/text/bundle', async (req) => {
    await userOf(req);
    const q = z.object({ code: z.string().min(1).max(40) }).parse(req.query);
    const b = await db.selectFrom('bundles').leftJoin('locations', 'locations.id', 'bundles.location_id').selectAll('bundles').select('locations.name as location_name').where('bundles.code', '=', q.code.toUpperCase()).executeTakeFirst();
    if (!b) return { text: `بندیلی با کد ${toPersianDigits(q.code)} پیدا نشد.` };
    const lines = await db.selectFrom('bundle_lines').innerJoin('products', 'products.id', 'bundle_lines.product_id').select(['products.name_fa', 'bundle_lines.bars', 'bundle_lines.length_m', 'bundle_lines.filler_mm', 'bundle_lines.weight_kg']).where('bundle_id', '=', b.id).execute();
    const pos = await db.selectFrom('stock_moves').select(['state_to']).where('item_type', '=', 'bundle').where('item_id', '=', b.id).orderBy('at', 'desc').limit(1).executeTakeFirst();
    const STATUS: Record<string, string> = { ok: 'سالم', damaged: 'آسیب‌دیده', wrong_product: 'محصول اشتباه', pending_review: 'در انتظار بررسی', scrapped: 'ضایعات شد', consumed: 'مصرف شد' };
    const FORM: Record<string, string> = { raw: 'خام', painted: 'رنگ‌شده', anodized: 'آنادایز' };
    const out = [`📦 بندیل ${toPersianDigits(b.code)}${b.code_is_temp ? ' (کد موقت)' : ''}`, `وزن: ${fa(b.weight_kg, 'weight')} کیلو · ${FORM[b.form] ?? b.form} · ${STATUS[b.status] ?? b.status}`, `مکان: ${b.location_name ?? '—'}${pos?.state_to ? ` (${pos.state_to})` : ''}`];
    for (const l of lines) out.push(`• ${l.name_fa}${l.bars ? ` · ${fa(l.bars)} شاخه` : ''}${l.length_m ? ` · ${fa(l.length_m, 'length')} متر` : ''}${l.filler_mm ? ` · فیلر ${fa(l.filler_mm, 'filler')}` : ''}${l.weight_kg ? ` · ${fa(l.weight_kg, 'weight')} کیلو` : ''}`);
    if (Array.isArray(b.warnings) && (b.warnings as unknown[]).length) out.push(`⚠️ ${(b.warnings as Array<{ message?: string }>).map((w) => w.message ?? '').join(' / ')}`);
    return { text: out.join('\n'), id: b.id };
  });

  /** سفارش <number>: statuses in one glance. */
  app.get('/internal/bot/text/order', async (req) => {
    const me = await userOf(req);
    const q = z.object({ number: z.string().min(1).max(40) }).parse(req.query);
    const o = await db.selectFrom('orders').innerJoin('parties', 'parties.id', 'orders.party_id').selectAll('orders').select('parties.name as party_name').where('orders.number', '=', q.number.toUpperCase()).executeTakeFirst();
    if (!o) return { text: `سفارش ${toPersianDigits(q.number)} پیدا نشد.` };
    const { loadLines, orderTotals, postedReceiptsForOrder, computeStatuses, NEXT_ACTION_LABELS } = await import('../orders/service.js');
    const lines = await loadLines(db, o.id);
    const totals = orderTotals(o, lines, await postedReceiptsForOrder(db, o.id));
    const st = await computeStatuses(db, o, lines, totals);
    const out = [`🧾 سفارش ${toPersianDigits(o.number)} · ${o.party_name}`, `وضعیت فروش: ${o.status_sales} · تأمین: ${st.supply} · عملیات: ${st.operations} · ارسال: ${st.shipping}`, `وزن کل: ${fa(totals.total_kg, 'weight')} کیلو · ${fa(lines.length)} ردیف`];
    if (can(me, 'finance.view')) { for (const [c, v] of Object.entries(totals.totals)) out.push(`جمع: ${fa(v, c as Currency)} ${CUR[c]} · دریافتی ${fa(totals.paid[c as Currency] ?? 0, c as Currency)} · مانده ${fa(totals.remaining[c as Currency] ?? v, c as Currency)}`); out.push(`مالی: ${st.finance}`); }
    if (st.next_action) out.push(`➡️ اقدام بعدی: ${NEXT_ACTION_LABELS[st.next_action] ?? st.next_action}`);
    return { text: out.join('\n'), id: o.id };
  });

  /** انبار: positions by location/state (weights only; no values). */
  app.get('/internal/bot/text/stock', async (req) => {
    await userOf(req);
    const items = await positionsDetailed(db);
    const byLoc = new Map<string, { name: string; kg: Dec; states: Map<string, Dec> }>();
    for (const p of items) {
      const l = byLoc.get(p.location_id) ?? byLoc.set(p.location_id, { name: p.location_name, kg: new Dec(0), states: new Map() }).get(p.location_id)!;
      l.kg = l.kg.plus(p.kg); l.states.set(p.state ?? '؟', (l.states.get(p.state ?? '؟') ?? new Dec(0)).plus(p.kg));
    }
    const STATE: Record<string, string> = { ingot: 'شمش', scrap: 'ضایعات', raw: 'خام', coated: 'رنگ‌شده', quarantine: 'قرنطینه', in_transit: 'در راه', paint: 'پودر رنگ', tool: 'ابزار' };
    const out = ['🏭 موجودی به کیلو'];
    for (const l of [...byLoc.values()].sort((a, b) => b.kg.cmp(a.kg))) out.push(`• ${l.name}: ${fa(round(l.kg, 'weight'), 'weight')} (${[...l.states].map(([s, k]) => `${STATE[s] ?? s} ${fa(round(k, 'weight'), 'weight')}`).join('، ')})`);
    out.push(`جمع: ${fa(round(items.reduce((a, p) => a.plus(p.kg), new Dec(0)), 'weight'), 'weight')} کیلو`);
    return { text: out.join('\n') };
  });

  /** تأییدها: pending items the user may act on (finance only sees money). */
  app.get('/internal/bot/text/pending', async (req) => {
    const me = await userOf(req);
    const out: string[] = [];
    const items: Array<{ type: string; id: string; label: string }> = [];
    const q = await db.selectFrom('bundles').select(['id', 'code', 'weight_kg', 'defect']).where('status', 'in', ['pending_review', 'damaged', 'wrong_product']).where('decision', 'is', null).where('draft', '=', false).limit(20).execute();
    for (const b of q) items.push({ type: 'bundle', id: b.id, label: `بندیل ${toPersianDigits(b.code)} ${fa(b.weight_kg, 'weight')} کیلو${b.defect ? ` — ${b.defect}` : ''}` });
    if (can(me, 'finance.view')) {
      const docs = await db.selectFrom('documents').leftJoin('parties', 'parties.id', 'documents.party_id').select(['documents.id', 'documents.number', 'documents.kind', 'documents.amount', 'documents.currency', 'parties.name as party_name', 'documents.status']).where('documents.status', 'in', ['reported', 'needs_completion']).orderBy('documents.created_at', 'desc').limit(20).execute();
      for (const d of docs) items.push({ type: 'document', id: d.id, label: `${d.kind === 'receipt' ? 'دریافت' : d.kind === 'payment' ? 'پرداخت' : d.kind} ${toPersianDigits(d.number)} ${d.amount ? `${fa(d.amount, d.currency as Currency)} ${CUR[d.currency]}` : '(ناقص)'} ${d.party_name ?? ''}${d.status === 'needs_completion' ? ' — ناقص' : ''}` });
    }
    if (!items.length) return { text: 'چیزی در انتظار تأیید نیست ✅', items };
    out.push('⏳ در انتظار تأیید:');
    items.forEach((it, i) => out.push(`${toPersianDigits(String(i + 1))}. ${it.label}`));
    return { text: out.join('\n'), items };
  });

  /** مانده <party>: balance per currency (finance.view only; T56). */
  app.get('/internal/bot/text/balance', async (req) => {
    const me = await userOf(req);
    if (!can(me, 'finance.view')) throw new AppError('forbidden', 'دسترسی مالی ندارید');
    const q = z.object({ q: z.string().min(1).max(80) }).parse(req.query);
    const parties = await db.selectFrom('parties').select(['id', 'name']).where('name', 'ilike', `%${q.q.replace(/[%_\\]/g, '\\$&')}%`).limit(5).execute();
    if (!parties.length) return { text: `طرف حسابی با نام «${q.q}» پیدا نشد.` };
    if (parties.length > 1) return { text: `چند طرف حساب پیدا شد: ${parties.map((p) => p.name).join('، ')}. نام دقیق‌تر بنویس.` };
    const st = await partyStatement(db, parties[0]!.id);
    const out = [`💼 مانده ${parties[0]!.name}:`];
    for (const [c, v] of Object.entries(st.closing)) out.push(`• ${fa(v, c as Currency)} ${CUR[c]} ${new Dec(v!).gte(0) ? '(طلب ویترال)' : '(بدهی ویترال)'}`);
    if (out.length === 1) out.push('• صفر');
    return { text: out.join('\n') };
  });
}
