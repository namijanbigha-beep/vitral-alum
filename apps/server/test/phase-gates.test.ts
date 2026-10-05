/**
 * Spec §20 phase gates that need the whole API:
 *  - phase 3: «یک محموله صادراتی از سفارش تا فاکتور و دریافت» (export shipment from order to invoice and receipt);
 *  - phase 5: «کار ساخته‌شده با /task و ویس در اپ دیده و بسته می‌شود» (a task created via the bot, with a voice, closed in the app).
 * Plus the review fixes that hang off them: document policy (module 6), anodize gain range (module 5), rework cost (module 4).
 */
import type { LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestApp, type TestApp, uuid } from './helpers.js';

const BOT_KEY = 'bot-service-key-for-phase-gates-0123456789';

let t: TestApp;
let m: string; // manager cookie
let staff: string; // staff cookie
let managerId: string;
let staffId: string;
let warehouse: string;

const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
function expectStatus(r: LightMyRequestResponse, status: number): Record<string, any> {
  expect(r.statusCode, `${r.statusCode} ${r.body.slice(0, 400)}`).toBe(status);
  return json(r);
}
const post = (url: string, payload: object, status = 201, cookie = m) => t.call(cookie, { method: 'POST', url, payload, idempotency: uuid() }).then((r) => expectStatus(r, status));
const put = (url: string, payload: object, status = 200) => t.call(m, { method: 'PUT', url, payload }).then((r) => expectStatus(r, status));
const get = (url: string, status = 200, cookie = m) => t.call(cookie, { method: 'GET', url }).then((r) => expectStatus(r, status));
const bot = (user: string) => ({ 'x-bot-key': BOT_KEY, 'x-bot-user': user });

function multipart(fields: Record<string, string>, file: { name: string; data: Buffer; type: string }) {
  const boundary = `----vt${uuid().replace(/-/g, '')}`;
  const parts: Buffer[] = Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** A minimal Ogg/Opus voice note, the format Telegram sends. */
function oggVoice(): Buffer {
  const page = Buffer.alloc(28);
  page.write('OggS', 0);
  page[5] = 2;
  page[26] = 1;
  page[27] = 19;
  return Buffer.concat([page, Buffer.from('OpusHead'), Buffer.from([1, 1, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0]), Buffer.alloc(64)]);
}

let seq = 0;
const party = async (name: string, roles: string[], extra: object = {}) => (await post('/api/v1/parties', { name: `${name} ${++seq}`, roles, ...extra })).id as string;
async function product(name_fa: string): Promise<string> {
  const id = (await post('/api/v1/products', { name_fa, name_ar: 'إطار', name_en: 'Frame profile', code: `PG-${++seq}`, common_lengths: ['6'] })).id as string;
  const f = await post(`/api/v1/products/${id}/fillers`, { filler_mm: null, weight_g_per_m: '1000', source: 'drawing' });
  await post(`/api/v1/products/${id}/fillers/${f.id}/approve`, {}, 200);
  return id;
}
const balance = async (partyId: string) => ((await get(`/api/v1/parties/${partyId}/summary`)).balances ?? {}) as Record<string, string>;

beforeAll(async () => {
  t = await setupTestApp({ BOT_SERVICE_KEY: BOT_KEY });
  managerId = await t.createUser({ mobile: '09120000301', password: 'manager-pass-1', role: 'manager', name: 'مدیر' });
  staffId = await t.createUser({ mobile: '09120000302', password: 'staff-pass-22', role: 'staff', name: 'علی رضایی' });
  m = await t.login('09120000301', 'manager-pass-1');
  staff = await t.login('09120000302', 'staff-pass-22');
  warehouse = (await get('/api/v1/locations?kind=own_warehouse')).items[0].id;
});
afterAll(() => t.close());

describe('§20 phase 3 gate — one export shipment from order to invoice and receipt', () => {
  it('USD order → packed export load with documents → border → delivery → invoice on the border net → receipt settles it', async () => {
    const customer = await party('Baghdad Trading', ['customer'], { name_ar: 'شركة بغداد', country: 'عراق', city: 'بغداد', default_currency: 'USD' });
    const p = await product('فریم صادراتی');

    // order in USD, approved (price locked)
    const draft = await post('/api/v1/orders', { party_id: customer, currency: 'USD', prepay_percent: '0', destination_country: 'عراق', lines: [{ kind: 'profile', product_id: p, calc_mode: 'manual', length_m: '6', qty_kg: '1000', price_basis: 'per_kg', unit_price: '2.5', currency: 'USD' }] });
    const order = await post(`/api/v1/orders/${draft.id}/approve`, { version: draft.version }, 200);
    const lineId = order.lines[0].id as string;

    // stock ready in the warehouse, reserved for the order
    const bundle = await post('/api/v1/bundles', { code: 'EX-1', weight_kg: '1000', source: 'opening', lines: [{ product_id: p, length_m: '6', bars: 166 }] });
    await post(`/api/v1/orders/${order.id}/reserve`, { items: [{ order_line_id: lineId, bundle_id: bundle.id }] }, 200);

    // the export load: consignee, border, delivery term; the default policy asks for a load photo and a scale ticket (module 6)
    const tr = await post('/api/v1/transfers', { kind: 'to_customer', is_export: true, from_location_id: warehouse, order_ids: [order.id], consignee: 'شركة بغداد — مستودع الكرادة', destination_country: 'عراق', destination_city: 'بغداد', border: 'باشماق', delivery_term: 'DAP', driver_name: 'راننده صادرات', plate: '45ع678-11', lines: [{ bundle_id: bundle.id, order_id: order.id, order_line_id: lineId }] });
    expect(tr.documents_policy).toEqual(['load_photo', 'scale_ticket']);
    expect(tr.documents_missing).toEqual(['load_photo', 'scale_ticket']);
    const packed = await put(`/api/v1/transfers/${tr.id}/packing`, { version: tr.version, lines: [{ product_id: p, order_id: order.id, order_line_id: lineId, length_m: '6', packages: 10, bars_per_package: 14, weight_kg: '1000', gross_kg: '1012' }] });
    expect(packed.totals.packages).toBe(10);
    expect(packed.totals.bars).toBe(140);
    const photo = multipart({ kind: 'load', owner_entity: 'transfers', owner_id: tr.id }, { name: 'load.png', data: PNG, type: 'image/png' });
    expectStatus(await t.call(m, { method: 'POST', url: '/api/v1/files', payload: photo.payload, headers: photo.headers, idempotency: uuid() }), 201);
    expect((await get(`/api/v1/transfers/${tr.id}`)).documents_missing).toEqual(['scale_ticket']);

    // export documents from the same data (§14): packing list for everyone, commercial invoice only with finance.view
    const pl = await t.call(staff, { method: 'GET', url: `/api/v1/transfers/${tr.id}/packing-list?format=html` });
    expect(pl.statusCode).toBe(200);
    expect(pl.body).toContain('Packing List');
    expect(pl.body).toContain('قائمة التعبئة والشحن');
    expect((await t.call(staff, { method: 'GET', url: `/api/v1/transfers/${tr.id}/commercial-invoice?format=html` })).statusCode).toBe(403);
    const ci = await t.call(m, { method: 'GET', url: `/api/v1/transfers/${tr.id}/commercial-invoice?format=html` });
    expect(ci.statusCode).toBe(200);
    expect(ci.body).toContain('Commercial Invoice');
    expect(ci.body).toContain('شركة بغداد — مستودع الكرادة');
    expect(ci.body).toContain('باشماق');
    expect(ci.body).toContain('DAP');
    expect(ci.body).toContain('USD');
    expect(await t.db.selectFrom('documents').select('id').where('kind', '=', 'invoice').where('order_id', '=', order.id).execute()).toHaveLength(0); // CI is not a second sale

    // on the road: dispatch → border with the border scale ticket approved for the sale
    const d = await post(`/api/v1/transfers/${tr.id}/dispatch`, { version: packed.version }, 200);
    expect(d.status).toBe('in_transit');
    const atBorder = await post(`/api/v1/transfers/${tr.id}/border`, { version: d.version, border: 'باشماق' }, 200);
    expect(atBorder.status).toBe('at_border');
    const ticket = await post('/api/v1/scale-tickets', { transfer_id: tr.id, stage: 'border', site: 'باشماق', ticket_no: 'B-77', net_direct_kg: '998' });
    await post(`/api/v1/scale-tickets/${ticket.id}/approve`, { version: ticket.version, approved_for: ['sale'] }, 200);
    const delivered = await post(`/api/v1/transfers/${tr.id}/receive`, { version: (await get(`/api/v1/transfers/${tr.id}`)).version, receiver_name: 'أمين المستودع' }, 200);
    expect(delivered.status).toBe('delivered');
    expect(delivered.documents_missing).toEqual([]);
    let st = (await get(`/api/v1/orders/${order.id}`)).statuses;
    expect(st.shipping).toBe('delivered');
    expect(st.next_action).toBe('issue_invoice');

    // invoice on the approved border net (998 × 2.5 = 2,495 USD), with the shipment reference
    const inv = await post('/api/v1/documents', { kind: 'invoice', order_id: order.id, post: true });
    expect(inv.status).toBe('posted');
    expect(inv.currency).toBe('USD');
    expect(inv.settlement_basis_kg).toBe('998.000');
    expect(inv.amount).toBe('2495.00');
    expect((await balance(customer)).USD).toBe('2495.00');
    const invAr = await t.call(m, { method: 'GET', url: `/api/v1/documents/${inv.id}/pdf?format=html&lang=ar` });
    expect(invAr.statusCode).toBe(200);
    expect(invAr.body).toContain('فاتورة بيع');
    expect(invAr.body).toContain('دولار أمريكي');

    // receipt in USD settles it
    const rec = await post('/api/v1/documents', { kind: 'receipt', party_id: customer, amount: '2495', currency: 'USD', method: 'exchange_house', post: true, allocations: [{ to_document_id: inv.id, amount: '2495' }] });
    expect(rec.status).toBe('posted');
    expect(Number((await balance(customer)).USD)).toBe(0);
    st = (await get(`/api/v1/orders/${order.id}`)).statuses;
    expect(st.finance).toBe('settled');
    expect(st.next_action).toBeNull();
    expect((await get(`/api/v1/bundles/${bundle.id}`)).status).toBe('consumed');
  });

  it('the document policy is a setting: unknown documents are refused, a new requirement shows up as missing', async () => {
    const s = (await get('/api/v1/settings')).items.find((x: any) => x.key === 'transfer_document_policy');
    expect(s.value).toEqual({ to_customer: ['load_photo', 'scale_ticket'], ingot_in: ['load_photo', 'scale_ticket'] });
    expect((await t.call(m, { method: 'PUT', url: '/api/v1/settings/transfer_document_policy', payload: { version: s.version, value: { to_customer: ['passport'] } } })).statusCode).toBe(400);
    expect((await t.call(staff, { method: 'PUT', url: '/api/v1/settings/transfer_document_policy', payload: { version: s.version, value: {} } })).statusCode).toBe(403);
    await put('/api/v1/settings/transfer_document_policy', { version: s.version, value: { to_customer: ['load_photo', 'scale_ticket', 'packing_list', 'waybill'], between_locations: ['vehicle_photo'] } });
    const customer = await party('مشتری مدارک', ['customer']);
    const p = await product('پروفیل مدارک');
    const o = await post('/api/v1/orders', { party_id: customer, lines: [{ kind: 'profile', product_id: p, calc_mode: 'manual', length_m: '6', qty_kg: '100', unit_price: '1' }] });
    const tr = await post('/api/v1/transfers', { kind: 'to_customer', from_location_id: warehouse, order_ids: [o.id] });
    expect(tr.documents_missing).toEqual(['load_photo', 'scale_ticket', 'packing_list', 'waybill']);
    const other = await post('/api/v1/transfers', { kind: 'general', from_location_id: warehouse });
    expect(other.documents_policy).toEqual([]);
    expect(other.documents_missing).toEqual([]);
  });
});

describe('§20 phase 5 gate — a task made through the bot (with a voice) is seen and closed in the app', () => {
  it('bot (service key + manager) creates and attaches the voice; staff sees it in the app and closes it; audit and notifications follow', async () => {
    // the bot acts as the linked manager — exactly what Handlers.task sends
    const created = await t.call(null, { method: 'POST', url: '/api/v1/tasks', headers: bot(managerId), idempotency: uuid(), payload: { title: 'بار فردا را از کارخانه تحویل بگیر', assignee_user_id: staffId } });
    const task = expectStatus(created, 201);
    expect(task.created_by).toBe(managerId);
    expect(task.status).toBe('open');
    // the voice that follows is uploaded as the manager and attached to the same task
    const v = multipart({ kind: 'voice', owner_entity: 'tasks', owner_id: task.id }, { name: 'file_7.oga', data: oggVoice(), type: 'audio/ogg' });
    const voice = expectStatus(await t.call(null, { method: 'POST', url: '/api/v1/files', payload: v.payload, headers: { ...v.headers, ...bot(managerId) }, idempotency: uuid() }), 201);
    expect(voice.mime).toBe('audio/ogg');
    const withVoice = expectStatus(await t.call(null, { method: 'PATCH', url: `/api/v1/tasks/${task.id}`, headers: bot(managerId), payload: { version: task.version, voice_file_id: voice.id } }), 200);

    // staff: notified, sees it in the app list and detail, can play the voice
    const notes = await get('/api/v1/notifications', 200, staff);
    expect(notes.items.find((n: any) => n.kind === 'task_new' && n.entity_id === task.id)).toBeTruthy();
    expect((await get('/api/v1/tasks?status=open', 200, staff)).items.map((x: any) => x.id)).toContain(task.id);
    const seen = await get(`/api/v1/tasks/${task.id}`, 200, staff);
    expect(seen.voice_file_id).toBe(voice.id);
    expect(seen.creator_name).toBeDefined();
    expect((await t.call(staff, { method: 'GET', url: `/api/v1/files/${voice.id}/download` })).statusCode).toBe(200);

    // staff closes it in the app (session), with a note
    const done = await post(`/api/v1/tasks/${task.id}/done`, { version: withVoice.version, done_note: 'تحویل شد' }, 200, staff);
    expect(done.status).toBe('done');
    expect(done.done_note).toBe('تحویل شد');
    expect(done.done_at).toBeTruthy();
    const trail = await t.db.selectFrom('audit_log').select(['action', 'user_id']).where('entity', '=', 'tasks').where('entity_id', '=', task.id).orderBy('at').execute();
    expect(trail).toEqual([{ action: 'create', user_id: managerId }, { action: 'update', user_id: managerId }, { action: 'done', user_id: staffId }]);
    const mgrNotes = await get('/api/v1/notifications', 200, m);
    const closedNote = mgrNotes.items.find((n: any) => n.kind === 'task_done' && n.entity_id === task.id);
    expect(closedNote.title).toContain('تحویل شد');
    // a repeated tap (same request) or a second close does nothing more
    expect((await t.call(staff, { method: 'POST', url: `/api/v1/tasks/${task.id}/done`, payload: { version: done.version }, idempotency: uuid() })).statusCode).toBe(400);
    expect(await t.db.selectFrom('notifications').select('id').where('kind', '=', 'task_done').where('entity_id', '=', task.id).execute()).toHaveLength(1);
  });

  it('staff cannot create tasks, through the bot or the app (spec module 10 / §16 /task: مدیر)', async () => {
    const viaBot = await t.call(null, { method: 'POST', url: '/api/v1/tasks', headers: bot(staffId), idempotency: uuid(), payload: { title: 'x', assignee_user_id: staffId } });
    expect(viaBot.statusCode).toBe(403);
    const viaApp = await t.call(staff, { method: 'POST', url: '/api/v1/tasks', idempotency: uuid(), payload: { title: 'x', assignee_user_id: managerId } });
    expect(viaApp.statusCode).toBe(403);
  });
});

describe('module 5 — the anodize normal weight-gain range is its own setting', () => {
  it('anodize_gain_range_percent is settable and flags an anodize return outside it; paint keeps its own (unset) range', async () => {
    const s = (await get('/api/v1/settings')).items.find((x: any) => x.key === 'anodize_gain_range_percent');
    expect(s.value).toBeNull();
    expect((await t.call(m, { method: 'PUT', url: '/api/v1/settings/anodize_gain_range_percent', payload: { version: s.version, value: { min: '3', max: '1' } } })).statusCode).toBe(400);
    await put('/api/v1/settings/anodize_gain_range_percent', { version: s.version, value: { min: '0.5', max: '2' } });

    const p = await product('پروفیل آنادایز');
    const anodizer = await party('آنادایزکار', ['anodizer']);
    const painter = await party('رنگکار بازه', ['painter']);
    const raw = async (code: string) => (await post('/api/v1/bundles', { code, weight_kg: '100', source: 'opening', lines: [{ product_id: p, length_m: '6' }] })).id as string;
    const an = await post('/api/v1/coating-runs', { party_id: anodizer, service: 'anodize', color_code: 'آنادایز نقره‌ای', bundle_ids: [await raw('AN-1'), await raw('AN-2')] });
    const back = await post(`/api/v1/coating-runs/${an.id}/return`, { version: an.version, items: [{ item_id: an.items[0].id, coated_kg: '101' }, { item_id: an.items[1].id, coated_kg: '105' }] }, 200);
    const flags = Object.fromEntries(back.items.map((i: any) => [i.bundle_code, i.gain_needs_review]));
    expect(flags).toEqual({ 'AN-1': false, 'AN-2': true }); // 1.0 % in range, 5.0 % above 2 %
    const notes = await t.db.selectFrom('notifications').select('title').where('kind', '=', 'coating_gain_review').where('entity_id', '=', an.id).execute();
    expect(notes[0]!.title).toContain('AN-2');

    // paint: no range configured (D4) → no range warning; a negative gain is still «نیازمند بررسی»
    const pt = await post('/api/v1/coating-runs', { party_id: painter, service: 'paint', color_code: 'سفید', bundle_ids: [await raw('PT-1'), await raw('PT-2')] });
    const ptBack = await post(`/api/v1/coating-runs/${pt.id}/return`, { version: pt.version, items: [{ item_id: pt.items[0].id, coated_kg: '115' }, { item_id: pt.items[1].id, coated_kg: '99' }] }, 200);
    expect(Object.fromEntries(ptBack.items.map((i: any) => [i.bundle_code, i.gain_needs_review]))).toEqual({ 'PT-1': false, 'PT-2': true });
  });
});

describe('module 4 — rework cost on closing a production run', () => {
  async function runFor(factory: string, orders: Array<{ id: string; lineId: string; kg: string }>, p: string) {
    return post('/api/v1/production-runs', { factory_party_id: factory, lines: orders.map((o) => ({ product_id: p, order_line_id: o.lineId, target_kg: o.kg })) });
  }
  async function approved(customer: string, p: string, kg: string) {
    const o = await post('/api/v1/orders', { party_id: customer, prepay_percent: '0', lines: [{ kind: 'profile', product_id: p, calc_mode: 'manual', length_m: '6', qty_kg: kg, unit_price: '400000' }] });
    const a = await post(`/api/v1/orders/${o.id}/approve`, { version: o.version }, 200);
    return { id: a.id as string, lineId: a.lines[0].id as string, kg };
  }

  it('becomes an expense document on the run, shared over its orders by weight (R16), and shows in the order costing', async () => {
    const factory = await party('کارخانه دوباره‌کاری', ['factory']);
    const customer = await party('مشتری دوباره‌کاری', ['customer']);
    const p = await product('پروفیل دوباره‌کاری');
    const o1 = await approved(customer, p, '600');
    const o2 = await approved(customer, p, '400');
    const run = await runFor(factory, [{ ...o1, kg: '600' }, { ...o2, kg: '400' }], p);
    await post('/api/v1/bundles', { production_run_id: run.id, code: 'RW-1', weight_kg: '100', lines: [{ product_id: p, order_line_id: o1.lineId, length_m: '6' }] });
    await post(`/api/v1/production-runs/${run.id}/close`, { version: (await get(`/api/v1/production-runs/${run.id}`)).version, ingot_consumed_kg: '100', rework_cost: '5000000' }, 200);
    const docs = await t.db.selectFrom('documents').selectAll().where('source_type', '=', 'production_run').where('source_id', '=', run.id).where('kind', '=', 'expense').execute();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toEqual(expect.objectContaining({ amount: '5000000.00', currency: 'TOMAN', status: 'posted', expense_type: 'shared', expense_category: 'rework', party_id: factory }));
    const shares = await t.db.selectFrom('expense_shares').select(['order_id', 'amount']).where('document_id', '=', docs[0]!.id).execute();
    expect(Object.fromEntries(shares.map((s) => [s.order_id, s.amount]))).toEqual({ [o1.id]: '3000000.00', [o2.id]: '2000000.00' }); // T21 split
    const costing = await get(`/api/v1/orders/${o1.id}/costing`);
    expect(costing.components.find((c: any) => c.ref_id === docs[0]!.id).amount).toBe('3000000.00');
  });

  it('is not Vitral\'s cost when the contract puts rework on the factory (rework_payer = party)', async () => {
    const factory = await party('کارخانه پرداخت دوباره‌کاری', ['factory']);
    await post('/api/v1/contracts', { party_id: factory, service: 'extrusion', rate_per_kg: '10000', weight_basis: 'good_output', rework_payer: 'party', valid_from: '2026-01-01' });
    const p = await product('پروفیل کارخانه‌پرداخت');
    const run = await post('/api/v1/production-runs', { factory_party_id: factory, lines: [{ product_id: p }] });
    await post('/api/v1/bundles', { production_run_id: run.id, code: 'RW-9', weight_kg: '50', lines: [{ product_id: p, length_m: '6' }] });
    const closed = await post(`/api/v1/production-runs/${run.id}/close`, { version: (await get(`/api/v1/production-runs/${run.id}`)).version, ingot_consumed_kg: '50', rework_cost: '700000' }, 200);
    expect(closed.status).toBe('closed');
    const n = await sql<{ n: string }>`SELECT COUNT(*)::text AS n FROM documents WHERE kind = 'expense' AND source_id = ${run.id}`.execute(t.db);
    expect(n.rows[0]!.n).toBe('0');
    const a = await t.db.selectFrom('audit_log').select('after').where('entity_id', '=', run.id).where('action', '=', 'close').executeTakeFirstOrThrow();
    expect(a.after).toEqual(expect.objectContaining({ rework_cost: '700000', rework_document_id: null }));
  });
});
