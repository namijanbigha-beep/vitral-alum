import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestApp, type TestApp, uuid } from './helpers.js';

const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BOT_KEY = 'bot-service-key-for-tests-0123456789abcdef';

/** Decided at collection time so `it.skipIf` can see it: can headless Chromium start in this sandbox? */
const chromiumOk: boolean = await promisify(execFile)(CHROMIUM, ['--headless=new', '--no-sandbox', '--disable-gpu', '--version'], { timeout: 20_000 })
  .then(() => true)
  .catch(() => false);

let t: TestApp;
let manager: string;
let staff: string;
let managerId: string;
let staffId: string;
let partyId: string;
let productId: string;
let orderId: string;
let orderNumber: string;

const PARTY_NAME = 'شرکت نمونه عراق';
const PRODUCT_NAME = 'فریم ۲۹۳';
const AMOUNT_FA = '۸۳۱٬۱۲۵٬۷۵۰'; // 977.795 kg × 850,000 (T12)

beforeAll(async () => {
  t = await setupTestApp({ BOT_SERVICE_KEY: BOT_KEY });
  managerId = await t.createUser({ mobile: '09120000101', password: 'manager-pass-1', role: 'manager', name: 'مدیر ویترال' });
  staffId = await t.createUser({ mobile: '09120000102', password: 'staff-pass-22', role: 'staff', name: 'کارمند انبار' });
  manager = await t.login('09120000101', 'manager-pass-1');
  staff = await t.login('09120000102', 'staff-pass-22');

  const party = await t.call(manager, { method: 'POST', url: '/api/v1/parties', payload: { name: PARTY_NAME, name_ar: 'شركة النموذج', phones: ['+9647700000000'], city: 'بغداد', address: 'شارع الرشید', roles: ['customer'], default_currency: 'TOMAN' } });
  expect(party.statusCode, party.body).toBe(201);
  partyId = party.json().id;

  const product = await t.call(manager, { method: 'POST', url: '/api/v1/products', payload: { code: 'P0293', name_fa: PRODUCT_NAME, name_ar: 'إطار ٢٩٣', section_area_mm2: '293', weight_g_per_m_no_filler: '791.1', common_lengths: ['6'] } });
  expect(product.statusCode, product.body).toBe(201);
  productId = product.json().id;

  const order = await t.call(manager, {
    method: 'POST', url: '/api/v1/orders', idempotency: uuid(),
    payload: {
      party_id: partyId, currency: 'TOMAN', payment_terms: 'cash', prepay_percent: '80',
      lines: [{ kind: 'profile', product_id: productId, length_m: '6', weight_g_per_m: '791.1', calc_mode: 'manual', qty_kg: '977.795', price_basis: 'per_kg', unit_price: '850000', color: 'سفید' }],
    },
  });
  expect(order.statusCode, order.body).toBe(201);
  orderId = order.json().id;
  orderNumber = order.json().number;
  expect(order.json().print_count).toBe(0);
});
afterAll(() => t.close());

const botHeaders = (user?: string, key = BOT_KEY): Record<string, string> => ({ 'x-bot-key': key, ...(user ? { 'x-bot-user': user } : {}) });

async function countRows(table: 'documents' | 'files', where?: { kind: string; owner_id: string }): Promise<number> {
  const r = where
    ? await sql<{ n: string }>`SELECT COUNT(*)::text AS n FROM files WHERE kind = ${where.kind} AND owner_id = ${where.owner_id}`.execute(t.db)
    : await sql<{ n: string }>`SELECT COUNT(*)::text AS n FROM ${sql.table(table)}`.execute(t.db);
  return Number(r.rows[0]!.n);
}

describe('§14 — proforma from an order', () => {
  it('html preview carries the buyer, the totals, the amount in words and the Persian labels', async () => {
    const res = await t.call(manager, { method: 'GET', url: `/api/v1/orders/${orderId}/proforma?format=html` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    const html = res.body;
    expect(html).toContain('پیش فاکتور فروش');
    expect(html).toContain('مشخصات مشتری');
    expect(html).toContain(PARTY_NAME);
    expect(html).toContain(PRODUCT_NAME);
    expect(html).toContain('جمع کل به حروف');
    expect(html).toContain(AMOUNT_FA);
    expect(html).toContain('هشتصد و سی و یک میلیون و صد و بیست و پنج هزار و هفتصد و پنجاه تومان');
    expect(html).toContain('پیش‌پرداخت');
    expect(html).toContain('باقیمانده');
    expect(html).toContain('مهر و امضای فروشنده');
    // Test environment: the "not a real document" watermark, never a silent real-looking paper.
    expect(html).toContain('نمونه آزمایشی — سند واقعی نیست');
  });

  it('a preview does not count as a print and archives nothing', async () => {
    const before = await t.db.selectFrom('orders').select('print_count').where('id', '=', orderId).executeTakeFirstOrThrow();
    await t.call(manager, { method: 'GET', url: `/api/v1/orders/${orderId}/proforma?format=html` });
    const after = await t.db.selectFrom('orders').select('print_count').where('id', '=', orderId).executeTakeFirstOrThrow();
    expect(after.print_count).toBe(before.print_count);
    expect(await countRows('files', { kind: 'document_pdf', owner_id: orderId })).toBe(0);
  });

  it('lang=ar renders the Arabic labels and the Arabic names', async () => {
    const res = await t.call(manager, { method: 'GET', url: `/api/v1/orders/${orderId}/proforma?format=html&lang=ar` });
    expect(res.statusCode, res.body).toBe(200);
    const html = res.body;
    expect(html).toContain('فاتورة أولية للبيع');
    expect(html).toContain('بيانات العميل');
    expect(html).toContain('شركة النموذج');
    expect(html).toContain('إطار ٢٩٣');
    expect(html).toContain('هجري شمسي');
    expect(html).toContain('المجموع بالحروف');
    // Product has name_ar → no "missing Arabic name" warning.
    expect(html).not.toContain('بدون ترجمة عربية');
  });

  it.skipIf(!chromiumOk)('format=pdf returns a real PDF (magic bytes, inline filename)', async () => {
    const res = await t.call(manager, { method: 'GET', url: `/api/v1/orders/${orderId}/proforma?format=pdf` });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/inline; filename=/);
    expect(res.rawPayload.subarray(0, 4).toString('latin1')).toBe('%PDF');
  }, 90_000);

  it.skipIf(!chromiumOk)('T48 — a second print raises print_count by one, archives a document_pdf file and creates no financial document', async () => {
    const docsBefore = await countRows('documents');
    const first = await t.db.selectFrom('orders').select('print_count').where('id', '=', orderId).executeTakeFirstOrThrow();
    const filesBefore = await countRows('files', { kind: 'document_pdf', owner_id: orderId });

    const res = await t.call(manager, { method: 'GET', url: `/api/v1/orders/${orderId}/proforma?format=pdf` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 4).toString('latin1')).toBe('%PDF');

    const second = await t.db.selectFrom('orders').select('print_count').where('id', '=', orderId).executeTakeFirstOrThrow();
    expect(second.print_count).toBe(first.print_count + 1);
    expect(await countRows('files', { kind: 'document_pdf', owner_id: orderId })).toBe(filesBefore + 1);
    expect(await countRows('documents')).toBe(docsBefore);

    const archived = await t.db.selectFrom('files').select(['mime', 'original_name', 'owner_entity', 'sensitive']).where('owner_id', '=', orderId).where('kind', '=', 'document_pdf').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(archived.mime).toBe('application/pdf');
    expect(archived.owner_entity).toBe('orders');
    expect(archived.original_name).toContain(`proforma-${orderNumber}`);
    const link = await t.db.selectFrom('file_links').select('id').where('entity', '=', 'orders').where('entity_id', '=', orderId).execute();
    expect(link.length).toBeGreaterThanOrEqual(1);
    // The next preview shows the next print number on the paper.
    const html = await t.call(manager, { method: 'GET', url: `/api/v1/orders/${orderId}/proforma?format=html` });
    expect(html.body).toContain(`چاپ ${toFa(second.print_count + 1)}`);
  }, 120_000);

  it('unknown order → 404; unauthenticated → 401', async () => {
    expect((await t.call(manager, { method: 'GET', url: `/api/v1/orders/${uuid()}/proforma?format=html` })).statusCode).toBe(404);
    expect((await t.call(null, { method: 'GET', url: `/api/v1/orders/${orderId}/proforma?format=html` })).statusCode).toBe(401);
  });
});

describe('§14 — finance-only documents', () => {
  it('staff without finance.view cannot fetch the commercial invoice or the party statement (403)', async () => {
    const ci = await t.call(staff, { method: 'GET', url: `/api/v1/transfers/${uuid()}/commercial-invoice?format=html` });
    expect(ci.statusCode).toBe(403);
    expect(ci.json().error.code).toBe('forbidden');
    const st = await t.call(staff, { method: 'GET', url: `/api/v1/parties/${partyId}/statement.pdf?format=html` });
    expect(st.statusCode).toBe(403);
    expect(st.json().error.code).toBe('forbidden');
  });

  it('manager gets the party statement with the party name, opening/closing and the posted receipt', async () => {
    const receipt = await t.call(manager, { method: 'POST', url: '/api/v1/documents', idempotency: uuid(), payload: { kind: 'receipt', party_id: partyId, order_id: orderId, amount: '5000000', currency: 'TOMAN', method: 'cash', description: 'پیش‌پرداخت نقدی', post: true } });
    expect(receipt.statusCode, receipt.body).toBe(201);
    expect(receipt.json().status).toBe('posted');

    const res = await t.call(manager, { method: 'GET', url: `/api/v1/parties/${partyId}/statement.pdf?format=html` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('صورتحساب مشتری');
    expect(res.body).toContain(PARTY_NAME);
    expect(res.body).toContain(receipt.json().number.replace(/\d/g, (d: string) => toFa(Number(d))));
    expect(res.body).toContain('۵٬۰۰۰٬۰۰۰');
    const ar = await t.call(manager, { method: 'GET', url: `/api/v1/parties/${partyId}/statement.pdf?format=html&lang=ar` });
    expect(ar.statusCode).toBe(200);
    expect(ar.body).toContain('كشف حساب');
  });

  it('statement for an unknown party → 404', async () => {
    expect((await t.call(manager, { method: 'GET', url: `/api/v1/parties/${uuid()}/statement.pdf?format=html` })).statusCode).toBe(404);
  });
});

describe('§14 — bundle label (A6)', () => {
  it('renders code, product, bars, weight and weight per metre', async () => {
    const b = await t.call(manager, { method: 'POST', url: '/api/v1/bundles', idempotency: uuid(), payload: { code: 'VT-LBL-1', weight_kg: '394', source: 'opening', lines: [{ product_id: productId, length_m: '6', bars: 70 }] } });
    expect(b.statusCode, b.body).toBe(201);
    const res = await t.call(staff, { method: 'GET', url: `/api/v1/bundles/${b.json().id}/label?format=html` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('size: A6');
    expect(res.body).toContain('VT-LBL-1');
    expect(res.body).toContain(PRODUCT_NAME);
    expect(res.body).toContain('۳۹۴'); // weight
    expect(res.body).toContain('۷۰'); // bars
    expect(res.body).toContain('۹۳۸٫۱'); // g/m (T04)
  });
  it('unknown bundle → 404', async () => {
    expect((await t.call(manager, { method: 'GET', url: `/api/v1/bundles/${uuid()}/label?format=html` })).statusCode).toBe(404);
  });
});

describe('§16 — internal bot routes need the service key', () => {
  const urls = ['/api/v1/internal/bot/resolve?chat_id=1', '/api/v1/internal/bot/report-recipients', '/api/v1/internal/bot/text/report'];
  it('no key → rejected', async () => {
    for (const url of urls) {
      const res = await t.call(null, { method: 'GET', url });
      expect([401, 403], url).toContain(res.statusCode);
      expect(res.json().user).toBeUndefined();
    }
    const post = await t.call(null, { method: 'POST', url: '/api/v1/internal/bot/log', payload: { chat_id: '1', kind: 'x' } });
    expect([401, 403]).toContain(post.statusCode);
    expect(await t.db.selectFrom('bot_log').select('id').execute()).toHaveLength(0);
  });
  it('wrong key → rejected, even with a session cookie', async () => {
    const res = await t.call(manager, { method: 'GET', url: '/api/v1/internal/bot/report-recipients', headers: botHeaders(undefined, 'x'.repeat(BOT_KEY.length)) });
    expect([401, 403]).toContain(res.statusCode);
    const short = await t.call(manager, { method: 'GET', url: '/api/v1/internal/bot/report-recipients', headers: botHeaders(undefined, 'short') });
    expect([401, 403]).toContain(short.statusCode);
  });
});

describe('§16 — link flow', () => {
  let code: string;
  it('user asks for a code; the code is six digits and expires in ten minutes', async () => {
    const res = await t.call(staff, { method: 'POST', url: '/api/v1/telegram/link-code' });
    expect(res.statusCode, res.body).toBe(200);
    code = res.json().code;
    expect(code).toMatch(/^\d{6}$/);
    expect(res.json().expires_in_seconds).toBe(600);
    const row = await t.db.selectFrom('telegram_link_codes').select(['expires_at', 'used_at']).where('user_id', '=', staffId).executeTakeFirstOrThrow();
    expect(row.used_at).toBeNull();
    expect(new Date(row.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
  });
  it('bot links the chat; resolve returns the user without finance', async () => {
    const link = await t.call(null, { method: 'POST', url: '/api/v1/internal/bot/link', headers: botHeaders(), payload: { chat_id: '2001', code } });
    expect(link.statusCode, link.body).toBe(200);
    expect(link.json().user.id).toBe(staffId);
    const res = await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/resolve?chat_id=2001', headers: botHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(staffId);
    expect(res.json().user.finance).toBe(false);
    expect(res.json().user.permissions).toEqual([]);
  });
  it('the code is single use', async () => {
    const again = await t.call(null, { method: 'POST', url: '/api/v1/internal/bot/link', headers: botHeaders(), payload: { chat_id: '2009', code } });
    expect(again.statusCode).toBe(404);
    expect((await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/resolve?chat_id=2009', headers: botHeaders() })).json().user).toBeNull();
  });
  it('an expired code is refused', async () => {
    const res = await t.call(manager, { method: 'POST', url: '/api/v1/telegram/link-code' });
    await t.db.updateTable('telegram_link_codes').set({ expires_at: new Date(Date.now() - 1000) }).where('user_id', '=', managerId).execute();
    const link = await t.call(null, { method: 'POST', url: '/api/v1/internal/bot/link', headers: botHeaders(), payload: { chat_id: '2002', code: res.json().code } });
    expect(link.statusCode).toBe(404);
  });
  it('manager links too; the manager resolves with finance', async () => {
    const res = await t.call(manager, { method: 'POST', url: '/api/v1/telegram/link-code' });
    const link = await t.call(null, { method: 'POST', url: '/api/v1/internal/bot/link', headers: botHeaders(), payload: { chat_id: '2002', code: res.json().code } });
    expect(link.statusCode, link.body).toBe(200);
    const r = await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/resolve?chat_id=2002', headers: botHeaders() });
    expect(r.json().user.id).toBe(managerId);
    expect(r.json().user.finance).toBe(true);
  });
  it('a deactivated user no longer resolves', async () => {
    const extraId = await t.createUser({ mobile: '09120000103', password: 'extra-pass-33', role: 'staff' });
    await t.db.updateTable('users').set({ telegram_chat_id: '2003', active: false }).where('id', '=', extraId).execute();
    const r = await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/resolve?chat_id=2003', headers: botHeaders() });
    expect(r.json().user).toBeNull();
    // and the bot cannot act as them either
    const me = await t.call(null, { method: 'GET', url: '/api/v1/auth/me', headers: botHeaders(extraId) });
    expect(me.statusCode).toBe(401);
  });
});

describe('T55 — unknown chat', () => {
  it('resolve returns no user and the bot logs it', async () => {
    const r = await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/resolve?chat_id=777', headers: botHeaders() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ user: null });
    const log = await t.call(null, { method: 'POST', url: '/api/v1/internal/bot/log', headers: botHeaders(), payload: { chat_id: '777', kind: 'unregistered', detail: 'امروز' } });
    expect(log.statusCode, log.body).toBe(200);
    const rows = await t.db.selectFrom('bot_log').selectAll().where('chat_id', '=', '777').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('unregistered');
    expect(rows[0]!.detail).toBe('امروز');
  });
  it('rejects a malformed chat id', async () => {
    expect((await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/resolve?chat_id=abc', headers: botHeaders() })).statusCode).toBe(400);
  });
});

describe('T56 — texts for a staff user carry no money', () => {
  const MONEY = /تومان|دلار|دینار|۵٬۰۰۰٬۰۰۰|۸۳۱٬۱۲۵٬۷۵۰/;
  it('text/report: manager sees the receipt in toman, staff sees no money at all', async () => {
    const m = await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/text/report', headers: botHeaders(managerId) });
    expect(m.statusCode, m.body).toBe(200);
    expect(m.json().text).toContain('تومان');
    expect(m.json().text).toContain('۵٬۰۰۰٬۰۰۰');
    const s = await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/text/report', headers: botHeaders(staffId) });
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().text).not.toMatch(MONEY);
    expect(s.json().text.length).toBeGreaterThan(0);
    const full = await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/text/report?full=true', headers: botHeaders(staffId) });
    expect(full.json().text).not.toMatch(MONEY);
  });
  it('text/order: manager sees totals, staff sees statuses only', async () => {
    const m = await t.call(null, { method: 'GET', url: `/api/v1/internal/bot/text/order?number=${orderNumber}`, headers: botHeaders(managerId) });
    expect(m.statusCode, m.body).toBe(200);
    expect(m.json().text).toContain('تومان');
    expect(m.json().text).toContain(AMOUNT_FA);
    expect(m.json().id).toBe(orderId);
    const s = await t.call(null, { method: 'GET', url: `/api/v1/internal/bot/text/order?number=${orderNumber.toLowerCase()}`, headers: botHeaders(staffId) });
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().text).toContain(PARTY_NAME);
    expect(s.json().text).toContain('وضعیت فروش');
    expect(s.json().text).not.toMatch(MONEY);
    expect(s.json().text).not.toContain('جمع:');
  });
  it('text/balance: staff is refused, manager gets the balance per currency', async () => {
    const s = await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/text/balance?q=نمونه', headers: botHeaders(staffId) });
    expect(s.statusCode).toBe(403);
    expect(JSON.stringify(s.json())).not.toMatch(/۵٬۰۰۰٬۰۰۰/);
    const m = await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/text/balance?q=نمونه', headers: botHeaders(managerId) });
    expect(m.statusCode, m.body).toBe(200);
    expect(m.json().text).toContain(PARTY_NAME);
    expect(m.json().text).toContain('تومان');
  });
  it('text/pending: staff never sees reported money documents', async () => {
    const rep = await t.call(manager, { method: 'POST', url: '/api/v1/documents', idempotency: uuid(), payload: { kind: 'receipt', party_id: partyId, amount: '1234567', currency: 'TOMAN', method: 'cash' } });
    expect(rep.statusCode, rep.body).toBe(201);
    const m = await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/text/pending', headers: botHeaders(managerId) });
    expect(m.statusCode).toBe(200);
    const s = await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/text/pending', headers: botHeaders(staffId) });
    expect(s.statusCode).toBe(200);
    expect(JSON.stringify(s.json())).not.toMatch(/۱٬۲۳۴٬۵۶۷|تومان/);
    expect(s.json().items.every((i: { type: string }) => i.type !== 'document')).toBe(true);
  });
  it('text endpoints need a linked user', async () => {
    expect((await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/text/report', headers: botHeaders() })).statusCode).toBe(401);
    expect((await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/text/report', headers: botHeaders(uuid()) })).statusCode).toBe(401);
  });
});

describe('§16 — notifications and recipients', () => {
  it('notifications/claim returns queued items for linked users and marks telegram_sent_at exactly once', async () => {
    const n = await t.db.insertInto('notifications').values({ user_id: managerId, kind: 'bundle_warning', title: 'بندیل در قرنطینه', entity: 'bundles', entity_id: null, group_key: `t:${uuid()}` }).returning('id').executeTakeFirstOrThrow();
    // A notification for a user without a chat stays in the queue.
    const orphanId = await t.createUser({ mobile: '09120000104', password: 'orphan-pass-4', role: 'staff' });
    const orphan = await t.db.insertInto('notifications').values({ user_id: orphanId, kind: 'task', title: 'کار جدید' }).returning('id').executeTakeFirstOrThrow();

    const res = await t.call(null, { method: 'POST', url: '/api/v1/internal/bot/notifications/claim', headers: botHeaders() });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items as Array<{ id: string; chat_id: string; title: string }>;
    const mine = items.find((i) => i.id === n.id);
    expect(mine).toBeDefined();
    expect(mine!.chat_id).toBe('2002');
    expect(mine!.title).toBe('بندیل در قرنطینه');
    expect(items.find((i) => i.id === orphan.id)).toBeUndefined();

    const row = await t.db.selectFrom('notifications').select('telegram_sent_at').where('id', '=', n.id).executeTakeFirstOrThrow();
    expect(row.telegram_sent_at).not.toBeNull();
    const orphanRow = await t.db.selectFrom('notifications').select('telegram_sent_at').where('id', '=', orphan.id).executeTakeFirstOrThrow();
    expect(orphanRow.telegram_sent_at).toBeNull();

    const again = await t.call(null, { method: 'POST', url: '/api/v1/internal/bot/notifications/claim', headers: botHeaders() });
    expect((again.json().items as Array<{ id: string }>).find((i) => i.id === n.id)).toBeUndefined();
  });

  it('report-recipients lists only managers with a chat id', async () => {
    const res = await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/report-recipients', headers: botHeaders() });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ id: string; chat_id: string; role: string }>;
    expect(items.map((i) => i.id)).toContain(managerId);
    expect(items.map((i) => i.id)).not.toContain(staffId); // staff is linked (2001) but not a manager
    for (const i of items) {
      expect(i.role).toBe('manager');
      expect(i.chat_id).toMatch(/^-?\d+$/);
    }
    // A manager without a chat is not listed.
    const silentManager = await t.createUser({ mobile: '09120000105', password: 'silent-pass-5', role: 'manager' });
    const after = await t.call(null, { method: 'GET', url: '/api/v1/internal/bot/report-recipients', headers: botHeaders() });
    expect((after.json().items as Array<{ id: string }>).map((i) => i.id)).not.toContain(silentManager);
  });
});

describe('§16 — the app hook: service key + user id act as that user', () => {
  it('GET /auth/me as the staff user, with the staff permissions', async () => {
    const res = await t.call(null, { method: 'GET', url: '/api/v1/auth/me', headers: botHeaders(staffId) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().user.id).toBe(staffId);
    expect(res.json().user.permissions).toEqual([]);
    const asManager = await t.call(null, { method: 'GET', url: '/api/v1/auth/me', headers: botHeaders(managerId) });
    expect(asManager.json().user.id).toBe(managerId);
    expect(asManager.json().user.permissions).toContain('finance.view');
  });
  it('a list route works and the confidentiality filter still applies to the bot user', async () => {
    const list = await t.call(null, { method: 'GET', url: '/api/v1/orders', headers: botHeaders(staffId) });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items.map((o: { id: string }) => o.id)).toContain(orderId);
    const one = await t.call(null, { method: 'GET', url: `/api/v1/orders/${orderId}`, headers: botHeaders(staffId) });
    expect(one.statusCode).toBe(200);
    expect(one.json()).not.toHaveProperty('internal_note');
    const asManager = await t.call(null, { method: 'GET', url: `/api/v1/orders/${orderId}`, headers: botHeaders(managerId) });
    expect(asManager.json()).toHaveProperty('internal_note');
  });
  it('a definitive write through the bot needs an Idempotency-Key and is replayed, not repeated', async () => {
    const key = uuid();
    const first = await t.call(null, { method: 'POST', url: '/api/v1/free-notes', headers: botHeaders(staffId), idempotency: key, payload: { text: 'رنگ خریدم', telegram_message_id: '2001:1' } });
    expect(first.statusCode, first.body).toBe(201);
    const second = await t.call(null, { method: 'POST', url: '/api/v1/free-notes', headers: botHeaders(staffId), idempotency: key, payload: { text: 'رنگ خریدم', telegram_message_id: '2001:1' } });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    const noKey = await t.call(null, { method: 'POST', url: '/api/v1/free-notes', headers: botHeaders(staffId), payload: { text: 'بدون کلید' } });
    expect(noKey.statusCode).toBe(400);
  });
  it('a wrong key is rejected and never falls back to another identity', async () => {
    const wrong = await t.call(null, { method: 'GET', url: '/api/v1/auth/me', headers: botHeaders(managerId, 'y'.repeat(BOT_KEY.length)) });
    expect(wrong.statusCode).toBe(401);
    const noUser = await t.call(null, { method: 'GET', url: '/api/v1/auth/me', headers: botHeaders() });
    expect(noUser.statusCode).toBe(401);
    const garbage = await t.call(null, { method: 'GET', url: '/api/v1/auth/me', headers: botHeaders('not-a-uuid') });
    expect(garbage.statusCode).toBe(401);
  });
});

function toFa(n: number): string {
  return String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);
}
