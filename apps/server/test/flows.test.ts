/**
 * Spec §11 fixed tests that need the real HTTP API and database rather than a pure rule:
 * T23, T24, T37, T38, T39, T40, T41, T43, T44, T48, T49, T50, T51, T52, T54.
 */
import type { LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findConfidentialKeys } from '../src/lib/confidential.js';
import { buildXlsx } from '../src/lib/xlsx.js';
import { readXlsxRows } from '../src/lib/xlsx-read.js';
import { IMPORT_FIELDS } from '../src/modules/import/routes.js';
import { setupTestApp, type TestApp, uuid } from './helpers.js';

let t: TestApp;
let m: string; // manager cookie
let warehouse: string;
let customer: string;

const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
function expectStatus(r: LightMyRequestResponse, status: number): Record<string, any> {
  expect(r.statusCode, `${r.statusCode} ${r.body}`).toBe(status);
  return json(r);
}
const post = (url: string, payload: object, status = 201) => t.call(m, { method: 'POST', url, payload, idempotency: uuid() }).then((r) => expectStatus(r, status));
const patch = (url: string, payload: object) => t.call(m, { method: 'PATCH', url, payload }).then((r) => expectStatus(r, 200));
const get = (url: string, status = 200) => t.call(m, { method: 'GET', url }).then((r) => expectStatus(r, status));

let seq = 0;
async function party(name: string, roles: string[]) {
  return (await post('/api/v1/parties', { name: `${name} ${++seq}`, roles })).id as string;
}
async function product(name_fa: string) {
  const id = (await post('/api/v1/products', { name_fa, code: `P-${++seq}`, common_lengths: ['6'] })).id as string;
  const f = await post(`/api/v1/products/${id}/fillers`, { filler_mm: null, weight_g_per_m: '1000', source: 'drawing' });
  await post(`/api/v1/products/${id}/fillers/${f.id}/approve`, {}, 200);
  return id;
}
async function locationOf(partyId: string, kind: string): Promise<string> {
  return (await get(`/api/v1/locations?party_id=${partyId}&kind=${kind}`)).items[0].id;
}
/** Approved order with one profile line. */
async function approvedOrder(productId: string, line: Record<string, unknown> = {}, partyId = customer) {
  const o = await post('/api/v1/orders', { party_id: partyId, prepay_percent: '0', lines: [{ kind: 'profile', product_id: productId, calc_mode: 'manual', length_m: '6', qty_kg: '1000', unit_price: '400000', ...line }] });
  return post(`/api/v1/orders/${o.id}/approve`, { version: o.version }, 200);
}
/** A definitive ok bundle in the warehouse (source opening). */
async function stockBundle(productId: string, kg: string, code = `S-${++seq}`, line: Record<string, unknown> = {}) {
  return post('/api/v1/bundles', { code, weight_kg: kg, source: 'opening', lines: [{ product_id: productId, length_m: '6', ...line }] });
}
/** Posted ingot purchase received into `to` — one debt, one stock row (T41). */
async function ingotInStock(supplier: string, kg: string, unitPrice: string, to: string) {
  const p = await post('/api/v1/purchases', { party_id: supplier, purchase_kind: 'ingot', agreed_kg: kg, unit_price: unitPrice });
  await post(`/api/v1/documents/${p.id}/post`, { version: p.version }, 200);
  const cur = await get(`/api/v1/purchases/${p.id}`);
  await post(`/api/v1/purchases/${p.id}/receive`, { version: cur.version, kg, to_location_id: to }, 200);
  return { purchaseId: p.id as string, lotId: p.material_lot_id as string };
}
const reserve = (orderId: string, items: unknown[]) => t.call(m, { method: 'POST', url: `/api/v1/orders/${orderId}/reserve`, payload: { items }, idempotency: uuid() });
const balance = async (partyId: string) => ((await get(`/api/v1/parties/${partyId}/summary`)).balances ?? {}) as Record<string, string>;
const positions = async (itemId: string) => (await get(`/api/v1/stock/positions`)).items.filter((p: any) => p.item_id === itemId) as Array<{ location_id: string; kg: string }>;

beforeAll(async () => {
  t = await setupTestApp();
  await t.createUser({ mobile: '09120000001', password: 'manager-pass-1', role: 'manager', name: 'مدیر' });
  m = await t.login('09120000001', 'manager-pass-1');
  warehouse = (await get('/api/v1/locations?kind=own_warehouse')).items[0].id;
  customer = await party('مشتری', ['customer']);
});
afterAll(() => t.close());

describe('T23 — R17: two concurrent reservations of 600 from 1,000 free', () => {
  it('one succeeds, the other gets insufficient_stock; the active reservation stays at 600', async () => {
    const p = await product('پروفیل رزرو');
    const o = await approvedOrder(p);
    const b = await stockBundle(p, '1000');
    expect(b.free_kg).toBe('1000.000');
    const [r1, r2] = await Promise.all([reserve(o.id, [{ order_line_id: o.lines[0].id, bundle_id: b.id, kg: '600' }]), reserve(o.id, [{ order_line_id: o.lines[0].id, bundle_id: b.id, kg: '600' }])]);
    const codes = [r1, r2].map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    const failed = [r1, r2].find((r) => r.statusCode === 409)!;
    expect(json(failed).error.code).toBe('insufficient_stock');
    const after = await get(`/api/v1/bundles/${b.id}`);
    expect(after.reserved_kg).toBe('600.000');
    expect(after.free_kg).toBe('400.000');
    const res = await get(`/api/v1/orders/${o.id}/reservations`);
    expect(res.items.filter((r: any) => r.status === 'active')).toHaveLength(1);
    // the remaining 400 can still go, 401 cannot
    expect((await reserve(o.id, [{ order_line_id: o.lines[0].id, bundle_id: b.id, kg: '401' }])).statusCode).toBe(409);
    expect((await reserve(o.id, [{ order_line_id: o.lines[0].id, bundle_id: b.id, kg: '400' }])).statusCode).toBe(200);
  });
});

describe('T24 — R18: a damaged bundle cannot be reserved', () => {
  it('rejects the reservation and keeps the bundle out of available stock', async () => {
    const p = await product('پروفیل آسیب');
    const o = await approvedOrder(p);
    const b = await stockBundle(p, '300');
    const q = await post(`/api/v1/bundles/${b.id}/quarantine`, { version: b.version, status: 'damaged', defect: 'خم‌شدگی' }, 200);
    expect(q.status).toBe('damaged');
    const r = await reserve(o.id, [{ order_line_id: o.lines[0].id, bundle_id: b.id }]);
    expect(r.statusCode).toBe(400);
    expect(json(r).error.message).toContain('قابل رزرو نیست');
    const avail = await get(`/api/v1/stock/available?product_id=${p}`);
    expect(avail.items).toEqual([]);
    const bPos = await positions(b.id);
    expect(bPos).toEqual([{ location_id: warehouse, kg: '300.000' }].map((x) => expect.objectContaining(x)));
    expect((await get(`/api/v1/stock/positions?location_id=${warehouse}&state=quarantine`)).items.map((x: any) => x.item_id)).toContain(b.id);
    // after a decision «accept» it is reservable again
    const dec = await post(`/api/v1/bundles/${b.id}/decide`, { version: q.version, decision: 'accept', note: 'قابل فروش' }, 200);
    expect(dec.status).toBe('ok');
    expect((await reserve(o.id, [{ order_line_id: o.lines[0].id, bundle_id: b.id }])).statusCode).toBe(200);
  });
});

describe('T37 — principle 3: a posted document is never edited or deleted; void creates a reversal', () => {
  it('rejects PATCH and DELETE; void marks both rows void and links them', async () => {
    const inv = await post('/api/v1/documents', { kind: 'invoice', party_id: customer, lines: [{ description: 'فروش', amount: '1000000' }], post: true });
    expect(inv.status).toBe('posted');
    const edit = await t.call(m, { method: 'PATCH', url: `/api/v1/documents/${inv.id}`, payload: { version: inv.version, description: 'تغییر' } });
    expect(edit.statusCode).toBe(400);
    const del = await t.call(m, { method: 'DELETE', url: `/api/v1/documents/${inv.id}` });
    expect(del.statusCode).toBeGreaterThanOrEqual(400);
    const same = await get(`/api/v1/documents/${inv.id}`);
    expect(same.status).toBe('posted');
    expect(same.amount).toBe('1000000.00');
    expect(same.version).toBe(inv.version);
    expect((await balance(customer)).TOMAN).toBe('1000000');
    const noReason = await t.call(m, { method: 'POST', url: `/api/v1/documents/${inv.id}/void`, payload: { version: inv.version }, idempotency: uuid() });
    expect(noReason.statusCode).toBe(400);
    const v = await post(`/api/v1/documents/${inv.id}/void`, { version: inv.version, reason: 'اشتباه در صدور' }, 200);
    expect(v.status).toBe('void');
    expect(v.reversed_by_document_id).toBeTruthy();
    const rev = await get(`/api/v1/documents/${v.reversed_by_document_id}`);
    expect(rev.kind).toBe('invoice');
    expect(rev.amount).toBe('1000000.00');
    expect(rev.status).toBe('void');
    expect(rev.reverses_document_id).toBe(inv.id);
    expect(rev.number).not.toBe(inv.number);
    expect((await balance(customer)).TOMAN ?? '0').toBe('0');
    const rows = await t.db.selectFrom('documents').select('id').where('id', 'in', [inv.id, rev.id]).execute();
    expect(rows).toHaveLength(2); // nothing is deleted
  });
});

describe('T38 — module 6: 1,000 kg out, 995 received', () => {
  it('origin −1,000 once, destination +995 once, 5 kg written off with a reason, nothing left in transit', async () => {
    const supplier = await party('تأمین‌کننده', ['ingot_supplier']);
    const factory = await party('کارخانه', ['factory']);
    const factoryLoc = await locationOf(factory, 'factory');
    const { lotId } = await ingotInStock(supplier, '1000', '100000', warehouse);
    const tr = await post('/api/v1/transfers', { kind: 'to_production', from_location_id: warehouse, to_location_id: factoryLoc, lines: [{ material_lot_id: lotId, kg: '1000' }] });
    const d = await post(`/api/v1/transfers/${tr.id}/dispatch`, { version: tr.version }, 200);
    const transit = (await get('/api/v1/locations?limit=100')).items.find((l: any) => l.kind === 'in_transit').id;
    expect(await positions(lotId)).toEqual([expect.objectContaining({ location_id: transit, kg: '1000.000' })]);
    const noReason = await t.call(m, { method: 'POST', url: `/api/v1/transfers/${tr.id}/receive`, payload: { version: d.version, lines: [{ line_id: d.lines[0].id, received_kg: '995' }] }, idempotency: uuid() });
    expect(noReason.statusCode).toBe(400);
    const r = await post(`/api/v1/transfers/${tr.id}/receive`, { version: d.version, lines: [{ line_id: d.lines[0].id, received_kg: '995', diff_reason: 'scale_difference', diff_note: 'اختلاف باسکول' }] }, 200);
    expect(r.status).toBe('received');
    expect(r.lines[0].received_kg).toBe('995.000');
    expect(r.lines[0].diff_reason).toBe('scale_difference');
    expect(await positions(lotId)).toEqual([expect.objectContaining({ location_id: factoryLoc, kg: '995.000' })]);
    const moves = (await get(`/api/v1/stock/moves?item_id=${lotId}&limit=50`)).items as Array<Record<string, any>>;
    const out = moves.filter((x) => x.ref_type === 'transfer_dispatch');
    expect(out).toHaveLength(1);
    expect(out[0]!.kg).toBe('1000.000');
    expect(out[0]!.from_location_id).toBe(warehouse);
    const inn = moves.filter((x) => x.ref_type === 'transfer_receive');
    expect(inn.map((x) => [x.to_location_id, x.kg]).sort()).toEqual([[factoryLoc, '995.000'], [null, '5.000']].sort());
    expect(inn.find((x) => x.to_location_id === null)!.note).toContain('scale_difference');
    expect(moves.filter((x) => x.ref_type === 'purchase_receipt')).toHaveLength(1);
    const w = (await get(`/api/v1/transfers/${tr.id}/weights`));
    expect(w.declared_kg).toBe('1000.000');
    expect(w.received_kg).toBe('995.000');
  });
});

describe('T39 — module 5: 10 bundles to the painter, 6 return', () => {
  it('4 stay with the painter, the gain is computed on 6 only, the fee is on all 10 at input weight', async () => {
    const factory = await party('کارخانه رنگ', ['factory']);
    const painter = await party('رنگ‌کار', ['painter']);
    const painterLoc = await locationOf(painter, 'painter');
    await post('/api/v1/contracts', { party_id: painter, service: 'paint', rate_per_kg: '80000', includes_material: true, valid_from: '2026-01-01' });
    const p = await product('پروفیل رنگ');
    const run = await post('/api/v1/production-runs', { factory_party_id: factory, lines: [{ product_id: p }] });
    const ids: string[] = [];
    for (let i = 1; i <= 10; i += 1) ids.push((await post('/api/v1/bundles', { production_run_id: run.id, code: `R-${i}`, weight_kg: '100', lines: [{ product_id: p, length_m: '6' }] })).id);
    const c = await post('/api/v1/coating-runs', { party_id: painter, service: 'paint', color_code: 'مشکی مات', bundle_ids: ids });
    expect(c.items).toHaveLength(10);
    expect(c.input_basis_kg).toBe('1000.000');
    expect(c.totals.fee).toBe('80000000');
    const r = await post(`/api/v1/coating-runs/${c.id}/return`, { version: c.version, items: c.items.slice(0, 6).map((i: any) => ({ item_id: i.id, coated_kg: '105' })) }, 200);
    expect(r.status).toBe('partially_returned');
    expect(r.totals.returned_count).toBe(6);
    expect(r.totals.item_count).toBe(10);
    expect(r.totals.coated_kg).toBe('630.000');
    expect(r.totals.gain_kg).toBe('30.000'); // R06 on the 6 returned only
    expect(r.totals.gain_percent).toBe('5.0');
    expect(r.totals.fee).toBe('80000000'); // R05 on the input of all 10
    expect(r.items.filter((i: any) => i.coated_kg === null)).toHaveLength(4);
    const atPainter = (await get(`/api/v1/stock/positions?location_id=${painterLoc}`)).items.filter((x: any) => x.item_type === 'bundle');
    expect(atPainter).toHaveLength(4);
    expect(atPainter.map((x: any) => x.kg)).toEqual(['100.000', '100.000', '100.000', '100.000']);
    const acct = await get(`/api/v1/stock/party-account/${painter}`);
    expect(acct.coating_in_kg).toBe('1000.000');
    expect(acct.on_hand_total_kg).toBe('400.000');
    const closeEarly = await t.call(m, { method: 'POST', url: `/api/v1/coating-runs/${c.id}/close`, payload: { version: r.version }, idempotency: uuid() });
    expect(closeEarly.statusCode).toBe(400);
    expect(json(closeEarly).error.message).toContain('برنگشته');
    // the painter still owes no money: the fee document is written at close
    expect((await balance(painter)).TOMAN ?? '0').toBe('0');
  });
});

describe('T40 — module 8: free note «رنگ خریدم و پولش را دادم» converted twice', () => {
  it('yields one purchase and one linked payment, no duplicates', async () => {
    const seller = await party('فروشنده رنگ', ['tool_supplier']);
    const n = await post('/api/v1/free-notes', { text: 'رنگ خریدم و پولش را دادم', topic: 'paint_purchase', amount: '5000000', currency: 'TOMAN', party_id: seller, kg: '20' });
    const key = uuid();
    const body = { version: n.version, effect: 'purchase_and_payment', method: 'cash' };
    const first = await t.call(m, { method: 'POST', url: `/api/v1/free-notes/${n.id}/convert`, payload: body, idempotency: key }).then((r) => expectStatus(r, 200));
    expect(first.replayed).toBe(false);
    expect(first.documents.map((d: any) => d.kind).sort()).toEqual(['payment', 'purchase']);
    // second click: same key (replay) and a fresh key (note already converted) — both return the same two documents
    const again = await t.call(m, { method: 'POST', url: `/api/v1/free-notes/${n.id}/convert`, payload: body, idempotency: key }).then((r) => expectStatus(r, 200));
    expect(again.documents.map((d: any) => d.id).sort()).toEqual(first.documents.map((d: any) => d.id).sort());
    const fresh = await t.call(m, { method: 'POST', url: `/api/v1/free-notes/${n.id}/convert`, payload: body, idempotency: uuid() }).then((r) => expectStatus(r, 200));
    expect(fresh.replayed).toBe(true);
    expect(fresh.documents.map((d: any) => d.id).sort()).toEqual(first.documents.map((d: any) => d.id).sort());
    const docs = await t.db.selectFrom('documents').select(['id', 'kind', 'status', 'amount']).where('source_type', '=', 'free_note').where('source_id', '=', n.id).execute();
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.status === 'posted')).toBe(true);
    const purchase = first.documents.find((d: any) => d.kind === 'purchase');
    const pd = await get(`/api/v1/purchases/${purchase.id}`);
    expect(pd.paid).toBe('5000000');
    expect(pd.remaining).toBe('0');
    expect(pd.received_kg).toBe('20.000');
    expect((await balance(seller)).TOMAN ?? '0').toBe('0');
    const note = await get(`/api/v1/free-notes/${n.id}`);
    expect(note.status).toBe('converted');
    expect(note.converted_documents).toHaveLength(2);
  });
});

describe('T41 — principle 10: purchase, then physical receipt, then payment', () => {
  it('one debt, one stock increase, one debt decrease', async () => {
    const supplier = await party('تأمین‌کننده شمش', ['ingot_supplier']);
    const p = await post('/api/v1/purchases', { party_id: supplier, purchase_kind: 'ingot', agreed_kg: '2000', unit_price: '150000', lot: { alloy: '6063' } });
    expect(p.status).toBe('draft');
    expect((await balance(supplier)).TOMAN ?? '0').toBe('0'); // drafts never count (R12)
    await post(`/api/v1/documents/${p.id}/post`, { version: p.version }, 200);
    expect((await balance(supplier)).TOMAN).toBe('-300000000');
    expect(await positions(p.material_lot_id)).toEqual([]);
    const cur = await get(`/api/v1/purchases/${p.id}`);
    await post(`/api/v1/purchases/${p.id}/receive`, { version: cur.version, kg: '2000' }, 200);
    expect(await positions(p.material_lot_id)).toEqual([expect.objectContaining({ location_id: warehouse, kg: '2000.000' })]);
    expect((await balance(supplier)).TOMAN).toBe('-300000000'); // weight changed, money did not
    const pay = await post('/api/v1/documents', { kind: 'payment', party_id: supplier, amount: '300000000', method: 'bank_transfer', post: true, allocations: [{ to_document_id: p.id, amount: '300000000' }] });
    expect(pay.status).toBe('posted');
    expect((await balance(supplier)).TOMAN).toBe('0');
    expect(await positions(p.material_lot_id)).toEqual([expect.objectContaining({ kg: '2000.000' })]); // T42 / principle 9
    const docs = await t.db.selectFrom('documents').select('kind').where('party_id', '=', supplier).execute();
    expect(docs.map((d) => d.kind).sort()).toEqual(['payment', 'purchase']);
    const moves = await t.db.selectFrom('stock_moves').select('id').where('item_id', '=', p.material_lot_id).execute();
    expect(moves).toHaveLength(1);
    const open = await get(`/api/v1/parties/${supplier}/open-items`);
    expect(open.items).toEqual([]);
    expect(open.unallocated).toEqual([]);
  });
});

describe('T43 — module 8: allocating 100 to invoices of 70 and 50', () => {
  it('is refused with over_allocation and leaves no partial allocation', async () => {
    const inv1 = await post('/api/v1/documents', { kind: 'invoice', party_id: customer, lines: [{ description: 'الف', amount: '70' }], post: true });
    const inv2 = await post('/api/v1/documents', { kind: 'invoice', party_id: customer, lines: [{ description: 'ب', amount: '50' }], post: true });
    const rec = await post('/api/v1/documents', { kind: 'receipt', party_id: customer, amount: '100', method: 'cash', post: true });
    const r = await t.call(m, { method: 'POST', url: `/api/v1/documents/${rec.id}/allocate`, payload: { version: rec.version, items: [{ to_document_id: inv1.id, amount: '70' }, { to_document_id: inv2.id, amount: '50' }] }, idempotency: uuid() });
    expect(r.statusCode).toBe(409);
    expect(json(r).error.code).toBe('over_allocation');
    const after = await get(`/api/v1/documents/${rec.id}`);
    expect(after.allocations_out).toEqual([]);
    expect(after.remaining).toBe('100');
    // also refused when the allocations ride along with the receipt itself
    const combined = await t.call(m, { method: 'POST', url: '/api/v1/documents', payload: { kind: 'receipt', party_id: customer, amount: '100', method: 'cash', post: true, allocations: [{ to_document_id: inv1.id, amount: '70' }, { to_document_id: inv2.id, amount: '50' }] }, idempotency: uuid() });
    expect(combined.statusCode).toBe(409);
    // 70 + 30 is fine
    const ok = await post(`/api/v1/documents/${rec.id}/allocate`, { version: rec.version, items: [{ to_document_id: inv1.id, amount: '70' }, { to_document_id: inv2.id, amount: '30' }] }, 200);
    expect(ok.remaining).toBe('0');
  });
});

describe('T44 — module 10: guest share link', () => {
  const noConfidential = (body: unknown) => {
    expect(findConfidentialKeys(body)).toEqual([]);
    const s = JSON.stringify(body);
    for (const k of ['"amount"', '"unit_price"', '"money"', '"balances"', '"rate_per_kg"']) expect(s).not.toContain(k);
  };
  it('opens without a session and without money before expiry; 404 after revoke or expiry', async () => {
    const p = await product('پروفیل گالری');
    const b = await stockBundle(p, '250');
    const link = await post('/api/v1/share-links', { scope_type: 'bundle_gallery', scope_id: b.id, expires_in_days: 2 });
    expect(link.url).toMatch(/^\/s\//);
    const token = link.url.slice('/s/'.length);
    const open = await t.app.inject({ method: 'GET', url: `/api/v1/public/share/${token}` });
    expect(open.statusCode).toBe(200);
    const body = open.json();
    expect(body.scope).toBe('bundle_gallery');
    expect(body.bundle.code).toBe(b.code);
    noConfidential(body);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/public/share/${token}x` })).statusCode).toBe(404);
    await post(`/api/v1/share-links/${link.id}/revoke`, {}, 200);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/public/share/${token}` })).statusCode).toBe(404);
    // the daily report variant carries no money either, and dies at expiry
    const daily = await post('/api/v1/share-links', { scope_type: 'daily_report', scope_date: '1405/06/23', expires_in_days: 1 });
    const token2 = daily.url.slice('/s/'.length);
    const r2 = await t.app.inject({ method: 'GET', url: `/api/v1/public/share/${token2}` });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().scope).toBe('daily_report');
    expect(r2.json().money).toBeUndefined();
    noConfidential(r2.json());
    await t.db.updateTable('share_links').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', daily.id).execute();
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/public/share/${token2}` })).statusCode).toBe(404);
    const list = await get('/api/v1/share-links');
    expect(list.items.find((l: any) => l.id === link.id).open_count).toBe(1);
    expect(list.items.find((l: any) => l.id === link.id).revoked).toBe(true);
  });
});

describe('T48 — §14: printing the proforma again', () => {
  it('raises print_count by one each time and creates no financial document', async () => {
    const p = await product('پروفیل چاپ');
    const o = await post('/api/v1/orders', { party_id: customer, lines: [{ kind: 'profile', product_id: p, calc_mode: 'manual', qty_kg: '10', unit_price: '400000' }] });
    expect(o.print_count).toBe(0);
    const docsBefore = await t.db.selectFrom('documents').select('id').execute();
    const first = await t.call(m, { method: 'GET', url: `/api/v1/orders/${o.id}/proforma?format=pdf` });
    expect(first.statusCode, first.body.slice(0, 200)).toBe(200);
    expect(first.headers['content-type']).toContain('application/pdf');
    expect(first.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await get(`/api/v1/orders/${o.id}`)).print_count).toBe(1);
    const second = await t.call(m, { method: 'GET', url: `/api/v1/orders/${o.id}/proforma?format=pdf` });
    expect(second.statusCode).toBe(200);
    expect((await get(`/api/v1/orders/${o.id}`)).print_count).toBe(2);
    const docsAfter = await t.db.selectFrom('documents').select('id').execute();
    expect(docsAfter).toHaveLength(docsBefore.length);
    const pdfs = await t.db.selectFrom('files').select('id').where('kind', '=', 'document_pdf').where('owner_entity', '=', 'orders').where('owner_id', '=', o.id).execute();
    expect(pdfs).toHaveLength(2);
    expect((await get(`/api/v1/orders/${o.id}`)).totals.paid).toEqual({});
  }, 90_000);
});

describe('T49 — module 4: duplicate bundle code at the same factory', () => {
  it('warns, goes to «needs review» and suggests adding a line (mixed) instead', async () => {
    const factory = await party('کارخانه تکرار', ['factory']);
    const p = await product('پروفیل تکرار');
    const run = await post('/api/v1/production-runs', { factory_party_id: factory, lines: [{ product_id: p }] });
    const first = await post('/api/v1/bundles', { production_run_id: run.id, code: 'D-900', weight_kg: '400', lines: [{ product_id: p, length_m: '6' }] });
    expect(first.status).toBe('ok');
    expect(first.warnings).toEqual([]);
    const second = await post('/api/v1/bundles', { production_run_id: run.id, code: 'D-900', weight_kg: '410', lines: [{ product_id: p, length_m: '6' }] });
    const w = (second.warnings as Array<{ code: string; message: string }>).find((x) => x.code === 'duplicate_code');
    expect(w).toBeTruthy();
    expect(w!.message).toContain('قبلاً ثبت شده');
    expect(second.status).toBe('pending_review');
    expect(second.defect).toBe('duplicate_code');
    // the recording was not blocked: both rows exist and the weight is in quarantine, not in free stock
    expect((await get(`/api/v1/bundles?q=D-900&limit=10`)).items).toHaveLength(2);
    expect((await get(`/api/v1/stock/available?product_id=${p}`)).items.reduce((a: number, x: any) => a + Number(x.kg), 0)).toBe(400);
    expect((await get(`/api/v1/reports/dashboard`)).decisions.quarantine.map((b: any) => b.id)).toContain(second.id);
    // fixing the code clears the warning
    const fixed = await patch(`/api/v1/bundles/${second.id}`, { version: second.version, code: 'D-901' });
    expect((fixed.warnings as Array<{ code: string }>).map((x) => x.code)).not.toContain('duplicate_code');
  });
});

describe('T50 — module 4: minimum length on an order line', () => {
  it('a 6 m bundle is fine; a 5.8 m bundle warns and cannot be reserved for that line', async () => {
    const factory = await party('کارخانه طول', ['factory']);
    const p = await product('پروفیل طول');
    const o = await approvedOrder(p, { min_length_m: '6' });
    const line = o.lines[0];
    const run = await post('/api/v1/production-runs', { factory_party_id: factory, lines: [{ product_id: p, order_line_id: line.id }] });
    const good = await post('/api/v1/bundles', { production_run_id: run.id, code: 'L-6', weight_kg: '300', lines: [{ product_id: p, order_line_id: line.id, length_m: '6', bars: 50 }] });
    expect((good.warnings as Array<{ code: string }>).map((x) => x.code)).not.toContain('min_length');
    const short = await post('/api/v1/bundles', { production_run_id: run.id, code: 'L-58', weight_kg: '290', lines: [{ product_id: p, order_line_id: line.id, length_m: '5.8', bars: 50 }] });
    const w = (short.warnings as Array<{ code: string; message: string }>).find((x) => x.code === 'min_length');
    expect(w).toBeTruthy();
    expect(w!.message).toContain('حداقل طول');
    expect(short.status).toBe('ok'); // a warning, not a quarantine
    const r = await reserve(o.id, [{ order_line_id: line.id, bundle_id: short.id }]);
    expect(r.statusCode).toBe(400);
    expect(json(r).error.message).toContain('حداقل طول');
    expect((await reserve(o.id, [{ order_line_id: line.id, bundle_id: good.id }])).statusCode).toBe(200);
    // the same 5.8 m bundle is fine for a line without a minimum
    const o2 = await approvedOrder(p);
    expect((await reserve(o2.id, [{ order_line_id: o2.lines[0].id, bundle_id: short.id }])).statusCode).toBe(200);
  });
});

describe('T51 — module 3: changing the price of an approved order', () => {
  it('needs a reason, makes a new revision and keeps the old one in order_revisions', async () => {
    const p = await product('پروفیل قیمت');
    const o = await approvedOrder(p);
    expect(o.revision).toBe(0);
    const line = o.lines[0];
    const noReason = await t.call(m, { method: 'PATCH', url: `/api/v1/orders/${o.id}`, payload: { version: o.version, lines: [{ ...pick(line), unit_price: '450000' }] } });
    expect(noReason.statusCode).toBe(400);
    expect(json(noReason).error.fields).toHaveProperty('reason');
    const changed = await patch(`/api/v1/orders/${o.id}`, { version: o.version, reason: 'افزایش قیمت شمش', lines: [{ ...pick(line), unit_price: '450000' }] });
    expect(changed.revision).toBe(1);
    expect(changed.lines[0].unit_price).toBe('450000.00');
    expect(changed.totals.totals).toEqual({ TOMAN: '450000000' });
    expect(changed.status_sales).toBe('approved');
    const revs = await get(`/api/v1/orders/${o.id}/revisions`);
    expect(revs.items).toHaveLength(1);
    expect(revs.items[0].revision).toBe(0);
    expect(revs.items[0].reason).toBe('افزایش قیمت شمش');
    expect(revs.items[0].snapshot.lines[0].unit_price).toBe('400000.00');
    const stale = await t.call(m, { method: 'PATCH', url: `/api/v1/orders/${o.id}`, payload: { version: o.version, reason: 'x', title: 'y' } });
    expect(stale.statusCode).toBe(409); // T35
    expect(json(stale).error.current.revision).toBe(1);
  });
});
function pick(l: Record<string, any>) {
  return { id: l.id, kind: l.kind, product_id: l.product_id, calc_mode: l.calc_mode, length_m: l.length_m, qty_kg: l.qty_kg, price_basis: l.price_basis, unit_price: l.unit_price };
}

describe('T52 — module 3: cancelling an order with three produced bundles', () => {
  it('frees the bundles; the fee and the ingot consumption stay', async () => {
    const factory = await party('کارخانه لغو', ['factory']);
    const factoryLoc = await locationOf(factory, 'factory');
    const supplier = await party('تأمین‌کننده لغو', ['ingot_supplier']);
    await post('/api/v1/contracts', { party_id: factory, service: 'extrusion', rate_per_kg: '15000', weight_basis: 'good_output', valid_from: '2026-01-01' });
    const { lotId } = await ingotInStock(supplier, '300', '200000', factoryLoc);
    const p = await product('پروفیل لغو');
    const o = await approvedOrder(p, { qty_kg: '300' });
    const line = o.lines[0];
    const run = await post('/api/v1/production-runs', { factory_party_id: factory, lines: [{ product_id: p, order_line_id: line.id, target_kg: '300' }] });
    const bundles = [];
    for (let i = 1; i <= 3; i += 1) bundles.push(await post('/api/v1/bundles', { production_run_id: run.id, code: `X-${i}`, weight_kg: '100', lines: [{ product_id: p, order_line_id: line.id, length_m: '6' }] }));
    await post(`/api/v1/orders/${o.id}/reserve`, { items: bundles.map((b) => ({ order_line_id: line.id, bundle_id: b.id })) }, 200);
    for (const b of bundles) expect((await get(`/api/v1/bundles/${b.id}`)).reserved_order_line_id).toBe(line.id);
    const closed = await post(`/api/v1/production-runs/${run.id}/close`, { version: run.version, ingot_consumed_kg: '300' }, 200);
    const fee = await get(`/api/v1/documents/${closed.fee_document_id}`);
    expect(fee.amount).toBe('4500000.00');
    expect(fee.status).toBe('posted');
    expect(await positions(lotId)).toEqual([]);
    const cur = await get(`/api/v1/orders/${o.id}`);
    const noReason = await t.call(m, { method: 'POST', url: `/api/v1/orders/${o.id}/cancel`, payload: { version: cur.version }, idempotency: uuid() });
    expect(noReason.statusCode).toBe(400);
    const cancelled = await post(`/api/v1/orders/${o.id}/cancel`, { version: cur.version, reason: 'مشتری منصرف شد' }, 200);
    expect(cancelled.status_sales).toBe('cancelled');
    expect(cancelled.cancel_reason).toBe('مشتری منصرف شد');
    for (const b of bundles) {
      const after = await get(`/api/v1/bundles/${b.id}`);
      expect(after.reserved_order_line_id).toBeNull();
      expect(after.status).toBe('ok');
      expect(after.free_kg).toBe('100.000');
    }
    expect((await get(`/api/v1/orders/${o.id}/reservations`)).items.every((r: any) => r.status === 'released')).toBe(true);
    const free = await get(`/api/v1/stock/available?product_id=${p}`);
    expect(free.items.reduce((a: number, x: any) => a + Number(x.free_kg), 0)).toBe(300);
    // money and weight history untouched
    expect((await get(`/api/v1/documents/${fee.id}`)).status).toBe('posted');
    expect((await balance(factory)).TOMAN).toBe('-4500000');
    const consume = await t.db.selectFrom('stock_moves').select('kg').where('ref_type', '=', 'production_consume').where('ref_id', '=', run.id).execute();
    expect(consume.map((c) => c.kg)).toEqual(['300.000']);
    expect((await get(`/api/v1/production-runs/${run.id}`)).status).toBe('closed');
    // a cancelled order is frozen
    expect((await t.call(m, { method: 'PATCH', url: `/api/v1/orders/${o.id}`, payload: { version: cancelled.version, title: 'x' } })).statusCode).toBe(400);
  });
});

describe('T54 — §18: product import with two bad rows', () => {
  it('previews every row with its error; nothing is imported until a clean commit', async () => {
    const defs = IMPORT_FIELDS.products;
    const header = defs.map((d) => d.aliases[0]!);
    const row = (o: Record<string, string>) => defs.map((d) => o[d.field] ?? '');
    const rows = [
      row({ code: '7168', name_fa: 'مولیون', section_area_mm2: '293', filler_mm: '1.2', weight_g_per_m: '۷۹۱', common_lengths: '6', colors: 'سفید، مشکی مات' }),
      row({ code: '7170', name_fa: '', weight_g_per_m: '500' }), // bad: no name
      row({ code: '7171', name_fa: 'زوار', weight_g_per_m: 'abc' }), // bad: not a number
      row({ code: '7172', name_fa: 'لاین نوری', section_area_mm2: '100' }),
    ];
    const xlsx = buildXlsx([{ name: 'products', header, rows }]);
    const parsed = readXlsxRows(xlsx);
    expect(parsed[0]).toEqual(header);
    expect(parsed).toHaveLength(5);
    const before = (await t.db.selectFrom('products').select('id').execute()).length;
    const preview = await post('/api/v1/import/preview', { kind: 'products', rows: parsed });
    expect(preview.row_count).toBe(4);
    expect(preview.can_commit).toBe(false);
    expect(preview.errors.map((e: any) => e.row).sort()).toEqual([3, 4]);
    expect(preview.errors.find((e: any) => e.row === 3).message).toContain('لازم است');
    expect(preview.errors.find((e: any) => e.row === 4).message).toContain('عدد نامعتبر');
    expect(preview.rows[0].weight_g_per_m).toBe('791');
    expect(preview.rows[3].weight_g_per_m).toBe('270.0'); // R01 suggestion when no weight is given
    expect((await t.db.selectFrom('products').select('id').execute()).length).toBe(before);
    const commit = await t.call(m, { method: 'POST', url: `/api/v1/import/${preview.id}/commit`, payload: {}, idempotency: uuid() });
    expect(commit.statusCode).toBe(400);
    expect(json(commit).error.message).toContain('هیچ ردیفی وارد نشد');
    expect((await t.db.selectFrom('products').select('id').execute()).length).toBe(before);
    // fix the two rows → clean preview → commit imports all four
    const fixed = readXlsxRows(buildXlsx([{ name: 'products', header, rows: [rows[0]!, row({ code: '7170', name_fa: 'فریم', weight_g_per_m: '500' }), row({ code: '7171', name_fa: 'زوار', weight_g_per_m: '120' }), rows[3]!] }]));
    const p2 = await post('/api/v1/import/preview', { kind: 'products', rows: fixed });
    expect(p2.errors).toEqual([]);
    expect(p2.can_commit).toBe(true);
    const done = await post(`/api/v1/import/${p2.id}/commit`, {}, 200);
    expect(done.created.products).toBe(4);
    expect(done.created.product_fillers).toBe(4);
    expect((await t.db.selectFrom('products').select('id').execute()).length).toBe(before + 4);
    const mullion = (await get('/api/v1/products?q=7168')).items[0];
    expect(mullion.name_fa).toBe('مولیون');
    expect(mullion.colors).toEqual(['سفید', 'مشکی مات']);
    const fillers = await get(`/api/v1/products/${mullion.id}/fillers`);
    expect(fillers.items[0]).toEqual(expect.objectContaining({ filler_mm: '1.20', weight_g_per_m: '791.0', status: 'approved' }));
    // the same batch cannot be committed twice
    expect((await t.call(m, { method: 'POST', url: `/api/v1/import/${p2.id}/commit`, payload: {}, idempotency: uuid() })).statusCode).toBe(400);
  });
});

describe('T44 — security: a guest link opens only the files inside its scope', () => {
  async function photo(owner: { entity: string; id: string }): Promise<string> {
    const img = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#a04020' } }).jpeg().toBuffer();
    const boundary = `----vt${uuid().replace(/-/g, '')}`;
    const field = (k: string, v: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    const payload = Buffer.concat([field('kind', 'bundle'), field('owner_entity', owner.entity), field('owner_id', owner.id), Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), img, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const r = await t.call(m, { method: 'POST', url: '/api/v1/files', payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, idempotency: uuid() });
    return expectStatus(r, 201).id as string;
  }
  const open = (token: string, fileId: string) => t.app.inject({ method: 'GET', url: `/api/v1/public/share/${token}/files/${fileId}` }).then((r) => r.statusCode);
  const tokenOf = (link: Record<string, any>) => String(link.url).slice('/s/'.length);

  it('daily_report: only that day\'s production bundles; bundle_gallery: only that bundle; document: only that document → otherwise 404', async () => {
    const factory = await party('کارخانه اشتراک', ['factory']);
    const p = await product('پروفیل اشتراک');
    const run = await post('/api/v1/production-runs', { factory_party_id: factory, lines: [{ product_id: p }] });
    const mk = (code: string, at: string) => post('/api/v1/bundles', { production_run_id: run.id, code, weight_kg: '300', reported_at: at, lines: [{ product_id: p, length_m: '6' }] });
    const today = await mk('SH-1', '2026-09-16T08:00:00.000Z'); // 1405/06/25
    const otherDay = await mk('SH-2', '2026-09-17T08:00:00.000Z'); // 1405/06/26
    const stock = await stockBundle(p, '120');
    const inScope = await photo({ entity: 'bundles', id: today.id });
    const otherDayPhoto = await photo({ entity: 'bundles', id: otherDay.id });
    const stockPhoto = await photo({ entity: 'bundles', id: stock.id });

    const daily = tokenOf(await post('/api/v1/share-links', { scope_type: 'daily_report', scope_date: '1405/06/25' }));
    const report = await t.app.inject({ method: 'GET', url: `/api/v1/public/share/${daily}` });
    expect(report.json().photos.map((x: any) => x.id)).toEqual([inScope]);
    expect(await open(daily, inScope)).toBe(200);
    expect(await open(daily, otherDayPhoto)).toBe(404);
    expect(await open(daily, stockPhoto)).toBe(404);

    const gallery = tokenOf(await post('/api/v1/share-links', { scope_type: 'bundle_gallery', scope_id: otherDay.id }));
    expect(await open(gallery, otherDayPhoto)).toBe(200);
    expect(await open(gallery, inScope)).toBe(404);
    expect(await open(gallery, stockPhoto)).toBe(404);

    const inv = await post('/api/v1/documents', { kind: 'invoice', party_id: customer, lines: [{ description: 'فروش', amount: '1000' }], post: true });
    const doc = tokenOf(await post('/api/v1/share-links', { scope_type: 'document', scope_id: inv.id }));
    expect(await open(doc, inScope)).toBe(404);
    expect(await open(doc, uuid())).toBe(404);
  });
});
