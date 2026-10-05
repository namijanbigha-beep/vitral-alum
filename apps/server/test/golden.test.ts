/**
 * Spec §12 — the golden scenario, end to end through the HTTP API.
 *   a) one production run, 18 bundles for four products, the Persian text report (T26, T27, T28, R23)
 *   b) proforma VT-0001 (T12, T13, T30), Persian and Arabic
 *   c) wholesale proforma V{yymmdd}-{seq} (T14, T31)
 *   d) the full order cycle with the T18 numbers: ingot → factory → production → coating → packing → shipment → invoice → receipt → costing (R12, R14, R15)
 */
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestApp, type TestApp, uuid } from './helpers.js';

let t: TestApp;
let m: string; // manager cookie

const REPORT_DAY = '2026-09-14T08:00:00.000Z'; // 1405/06/23 in Tehran
const json = (r: LightMyRequestResponse) => r.json() as Record<string, any>;
function expectStatus(r: LightMyRequestResponse, status: number): Record<string, any> {
  expect(r.statusCode, `${r.statusCode} ${r.body}`).toBe(status);
  return json(r);
}
const post = (url: string, payload: object, status = 201) => t.call(m, { method: 'POST', url, payload, idempotency: uuid() }).then((r) => expectStatus(r, status));
const patch = (url: string, payload: object) => t.call(m, { method: 'PATCH', url, payload }).then((r) => expectStatus(r, 200));
const get = (url: string, status = 200) => t.call(m, { method: 'GET', url }).then((r) => expectStatus(r, status));

async function party(name: string, roles: string[], extra: Record<string, unknown> = {}) {
  return (await post('/api/v1/parties', { name, roles, ...extra })).id as string;
}
async function product(name_fa: string, code: string, extra: Record<string, unknown> = {}) {
  return (await post('/api/v1/products', { name_fa, code, common_lengths: ['6'], ...extra })).id as string;
}
/** An approved filler weight (the reference, module 1). */
async function approvedFiller(productId: string, gpm: string, filler_mm: string | null) {
  const f = await post(`/api/v1/products/${productId}/fillers`, { filler_mm, weight_g_per_m: gpm, source: 'drawing' });
  await post(`/api/v1/products/${productId}/fillers/${f.id}/approve`, {}, 200);
  return f.id as string;
}
async function locationOf(partyId: string, kind: string): Promise<string> {
  const l = await get(`/api/v1/locations?party_id=${partyId}&kind=${kind}`);
  expect(l.items.length).toBe(1);
  return l.items[0].id;
}
async function ownWarehouse(): Promise<string> {
  const l = await get('/api/v1/locations?kind=own_warehouse');
  return l.items[0].id;
}

beforeAll(async () => {
  t = await setupTestApp();
  await t.createUser({ mobile: '09120000001', password: 'manager-pass-1', role: 'manager', name: 'مدیر' });
  m = await t.login('09120000001', 'manager-pass-1');
});
afterAll(() => t.close());

// ───────────────────────────── (b) proforma VT-0001 ─────────────────────────────
describe('§12-b — proforma VT-0001 (T12, T13, T30)', () => {
  let orderId: string;
  it('creates the order with the two lines and the exact totals', async () => {
    const customer = await party('مشتری تهران', ['customer'], { city: 'تهران' });
    const mullion = await product('مولیون', '7168', { category: 'facade' });
    const filler = await approvedFiller(mullion, '791', '1.2');
    const o = await post('/api/v1/orders', {
      party_id: customer, payment_terms: 'cash', prepay_percent: '80', order_date: '2026-08-25', // 1405/06/03
      lines: [
        { kind: 'die_making', description: 'مولیون اختصاصی', load_type_label: 'ساخت قالب', qty_pieces: 1, price_basis: 'per_piece', unit_price: '80000000' },
        { kind: 'profile', product_id: mullion, product_filler_id: filler, length_m: '6', color: 'آنادایز نقره‌ای', load_type_label: 'استاندارد', calc_mode: 'from_weight', qty_kg: '977.795', price_basis: 'per_kg', unit_price: '850000' },
      ],
    });
    orderId = o.id;
    expect(o.number).toBe('VT-0001');
    expect(o.lines.map((l: any) => l.amount)).toEqual(['80000000', '831125750']); // T12
    expect(o.lines[1].weight_g_per_m).toBe('791.0');
    expect(o.lines[1].filler_mm).toBe('1.20');
    expect(o.totals.totals).toEqual({ TOMAN: '911125750' }); // T12
    expect(o.totals.prepay).toEqual({ TOMAN: '728900600' }); // T13
    expect(o.totals.paid).toEqual({});
    expect(o.totals.remaining).toEqual({ TOMAN: '911125750' }); // T13
    expect(o.totals.total_kg).toBe('977.795');
    expect(o.totals.incomplete).toBe(false);
  });
  it('renders the Persian proforma with the amount in words (T30) and the kg quantity', async () => {
    const r = await t.call(m, { method: 'GET', url: `/api/v1/orders/${orderId}/proforma?format=html` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('نهصد و یازده میلیون و صد و بیست و پنج هزار و هفتصد و پنجاه تومان');
    expect(r.body).toContain('VT-0001');
    expect(r.body).toContain('۹۷۷٫۷۹۵');
    expect(r.body).toContain('کیلوگرم');
  });
  it('renders the Arabic version with the same numbers', async () => {
    const r = await t.call(m, { method: 'GET', url: `/api/v1/orders/${orderId}/proforma?format=html&lang=ar` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('تسعمائة و أحد عشر مليون و مائة و خمسة و عشرون ألف و سبعمائة و خمسون تومان');
    expect(r.body).toContain('۹۷۷٫۷۹۵');
  });
});

// ───────────────────────────── (c) wholesale proforma ─────────────────────────────
describe('§12-c — wholesale proforma V{yymmdd}-{seq} (T14, T31)', () => {
  it('numbers from the Jalali order date and totals four lines to 375,000,000 / 500 kg / prepay 300,000,000', async () => {
    const customer = await party('بنکدار تهران', ['customer'], { city: 'تهران' });
    const inlay = await product('لاین توکار', '21', { category: 'light_line' });
    const light = await product('لاین نوری', '25', { category: 'light_line' });
    const fInlay = await approvedFiller(inlay, '180', null);
    const fLight = await approvedFiller(light, '230', null);
    const line = (product_id: string, product_filler_id: string, color: string, qty_kg: string) => ({ kind: 'profile', product_id, product_filler_id, length_m: '6', color, load_type_label: 'تبدیلی', calc_mode: 'from_weight', qty_kg, price_basis: 'per_kg', unit_price: '750000' });
    const o = await post('/api/v1/orders', {
      party_id: customer, numbering_kind: 'wholesale_proforma', payment_terms: 'cash', prepay_percent: '80', delivery_days: 20, order_date: '2026-09-14', // 1405/06/23
      lines: [line(inlay, fInlay, 'سفید', '100'), line(inlay, fInlay, 'مشکی مات', '150'), line(light, fLight, 'سفید', '100'), line(light, fLight, 'مشکی مات', '150')],
    });
    expect(o.number).toBe('V050623-1');
    expect(o.lines.map((l: any) => l.amount)).toEqual(['75000000', '112500000', '75000000', '112500000']);
    expect(o.totals.totals).toEqual({ TOMAN: '375000000' });
    expect(o.totals.total_kg).toBe('500.000');
    expect(o.totals.prepay).toEqual({ TOMAN: '300000000' });
    expect(o.delivery_days).toBe(20);
    const html = await t.call(m, { method: 'GET', url: `/api/v1/orders/${o.id}/proforma?format=html` });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('سیصد و هفتاد و پنج میلیون تومان'); // T31
    expect(html.body).toContain('V050623-1');
    // a second wholesale proforma on the same day continues the daily counter; the main series is untouched
    const o2 = await post('/api/v1/orders', { party_id: customer, numbering_kind: 'wholesale_proforma', order_date: '2026-09-14', lines: [] });
    expect(o2.number).toBe('V050623-2');
  });
});

// ───────────────────────────── (a) bundle report of one day ─────────────────────────────
describe('§12-a — 18 bundles, four products, the text report (T26, T27, T28)', () => {
  const ids: Record<string, string> = {};
  const versions: Record<string, number> = {};
  let runId: string;
  let frame: string, leaf: string, tee: string, strip: string;
  let factory: string;

  async function bundle(code: string | null, weight: string, lines: Array<Record<string, unknown>>) {
    const b = await post('/api/v1/bundles', { production_run_id: runId, code: code ?? undefined, weight_kg: weight, reported_at: REPORT_DAY, lines });
    ids[code ?? b.code] = b.id;
    versions[code ?? b.code] = b.version;
    return b;
  }

  it('records the run and the 18 bundles exactly as listed; 809 is one record with two lines; two bundles get temporary codes', async () => {
    factory = await party('کارخانه اکستروژن الف', ['factory']);
    frame = await product('فریم', 'FR-1');
    leaf = await product('لنگه', 'LF-1');
    tee = await product('سپری', 'TE-1');
    strip = await product('زوار تک‌جداره', 'ST-1');
    const run = await post('/api/v1/production-runs', { factory_party_id: factory, started_at: REPORT_DAY, lines: [{ product_id: frame }, { product_id: leaf }, { product_id: strip }] });
    runId = run.id;
    expect(run.fee_incomplete).toBe(true); // no contract: T08, the bundles are still recorded

    // frame — 3,124
    await bundle('812', '394', [{ product_id: frame, bars: 70, length_m: '6' }]);
    await bundle('813', '594', [{ product_id: frame }]);
    for (const [c, w] of [['807', '397'], ['808', '397'], ['816', '396'], ['818', '334'], ['817', '399']]) await bundle(c!, w!, [{ product_id: frame }]);
    const mixed = await bundle('809', '542', [{ product_id: frame, weight_kg: '213' }, { product_id: tee, weight_kg: '329' }]);
    expect(mixed.lines).toHaveLength(2);
    expect(mixed.weight_kg).toBe('542.000');
    // leaf — 2,157
    for (const [c, w] of [['806', '349'], ['811', '352'], ['821', '479'], ['819', '318'], ['822', '302'], ['820', '357']]) await bundle(c!, w!, [{ product_id: leaf }]);
    // tee (wrongly produced) — 2,182 incl. the 329 of 809
    await bundle('810', '494', [{ product_id: tee }]);
    const t1 = await bundle(null, '679', [{ product_id: tee }]);
    const t2 = await bundle(null, '680', [{ product_id: tee }]);
    expect(t1.code_is_temp).toBe(true);
    expect(t2.code_is_temp).toBe(true);
    expect(t1.code).toMatch(/^TMP-/);
    expect(t2.code).toMatch(/^TMP-/);
    expect(t1.code).not.toBe(t2.code);
    ids.TMP1 = t1.id; ids.TMP2 = t2.id; versions.TMP1 = t1.version; versions.TMP2 = t2.version;
    // strip — 237
    await bundle('803', '237', [{ product_id: strip }]);

    // a mixed bundle whose line weights do not add up is refused
    const bad = await t.call(m, { method: 'POST', url: '/api/v1/bundles', payload: { production_run_id: runId, code: '899', weight_kg: '542', lines: [{ product_id: frame, weight_kg: '213' }, { product_id: tee, weight_kg: '300' }] }, idempotency: uuid() });
    expect(bad.statusCode).toBe(400);
  });

  it('T26/T27 — only 813 gets the weight-outlier warning (median of single-product frames 397); 334 and 479 do not', async () => {
    // Warnings are evaluated against the bundles known at that moment; re-evaluating 813 against the complete run.
    const b813 = await patch(`/api/v1/bundles/${ids['813']}`, { version: versions['813'], note: 'بازبینی وزن' });
    const w = (b813.warnings as Array<{ code: string; data?: { median_kg: string } }>).find((x) => x.code === 'weight_outlier');
    expect(w).toBeTruthy();
    expect(['396.500', '397.000']).toContain(w!.data!.median_kg);
    for (const code of ['812', '807', '808', '816', '818', '817']) {
      const b = await get(`/api/v1/bundles/${ids[code]}`);
      expect((b.warnings as Array<{ code: string }>).map((x) => x.code), code).not.toContain('weight_outlier');
    }
    const b818 = await patch(`/api/v1/bundles/${ids['818']}`, { version: (await get(`/api/v1/bundles/${ids['818']}`)).version, note: 'بازبینی' });
    expect((b818.warnings as Array<{ code: string }>).map((x) => x.code)).not.toContain('weight_outlier');
    const b821 = await patch(`/api/v1/bundles/${ids['821']}`, { version: versions['821'], note: 'بازبینی' });
    expect((b821.warnings as Array<{ code: string }>).map((x) => x.code)).not.toContain('weight_outlier'); // 36 % < 40 %
  });

  it('marks the tee bundles wrong_product and 822 damaged; they appear in «needs decision»', async () => {
    for (const code of ['810', 'TMP1', 'TMP2']) {
      const b = await post(`/api/v1/bundles/${ids[code]}/quarantine`, { version: (await get(`/api/v1/bundles/${ids[code]}`)).version, status: 'wrong_product', defect: 'اشتباه تولید' }, 200);
      expect(b.status).toBe('wrong_product');
    }
    const d = await post(`/api/v1/bundles/${ids['822']}/quarantine`, { version: versions['822'], status: 'damaged', defect: 'خرابی' }, 200);
    expect(d.status).toBe('damaged');
    const q = await get('/api/v1/bundles?quarantine=true&limit=50');
    expect(q.items.map((b: any) => b.id).sort()).toEqual([ids['810'], ids.TMP1, ids.TMP2, ids['822']].sort());
    const dash = await get('/api/v1/reports/dashboard');
    expect(dash.decisions.quarantine.map((b: any) => b.id).sort()).toEqual([ids['810'], ids.TMP1, ids.TMP2, ids['822']].sort());
  });

  it('T28 — report: 3,124 / 2,157 / 2,182 / 237; total 7,700; 18 bundles; the text has the exact footer lines', async () => {
    const r = await get('/api/v1/reports/daily?date=1405/06/23');
    const p = r.production;
    expect(p.bundle_count).toBe(18);
    expect(p.total_kg).toBe('7700.000');
    const byName = Object.fromEntries(p.groups.map((g: any) => [g.product_name, g.total_kg]));
    expect(byName).toEqual({ 'فریم': '3124.000', 'لنگه': '2157.000', 'سپری': '2182.000', 'زوار تک‌جداره': '237.000' });
    expect(p.text).toContain('📋 گزارش موجودی تولید شده پروفیل خام');
    expect(p.text).toContain('🟥 کد بندیل » وزن بندیل 🟥');
    expect(p.text).toContain('🔹 فریم: ۳۱۲۴ کیلو');
    expect(p.text).toContain('۸۱۲ ◂ ۳۹۴');
    expect(p.text).toContain('━━━━━━━━━━');
    expect(p.text).toContain('✅ جمع کل: ۷۷۰۰ کیلو');
    expect(p.text).toContain('📦 تعداد بندیل: ۱۸');
    // 809 appears once per product line but is counted once; the full text shows bars and g/m
    expect(p.text.split('\n').filter((l: string) => l.startsWith('۸۰۹ ◂'))).toHaveLength(2);
    expect(p.text_full).toContain('۷۰ شاخه');
    expect(p.text_full).toMatch(/۹۳۸[.٫]۱ گرم\/متر/); // T04: (394 ÷ (70 × 6)) × 1000
    expect(p.text_full).toContain('درهم');
    // the run summary agrees (R23: records, not lines)
    const run = await get(`/api/v1/production-runs/${runId}`);
    expect(run.bundle_summary.bundle_count).toBe(18);
    expect(run.bundle_summary.total_kg).toBe('7700.000');
    expect(run.bundle_summary.per_product[frame]).toBe('3124.000');
    expect(run.bundle_summary.per_product[tee]).toBe('2182.000');
  });

  it('T24 / R18 — wrong_product and damaged bundles cannot be reserved; a healthy one can', async () => {
    const customer = await party('مشتری سپری', ['customer']);
    const o = await post('/api/v1/orders', { party_id: customer, lines: [{ kind: 'profile', product_id: tee, calc_mode: 'manual', qty_kg: '500', unit_price: '500000' }, { kind: 'profile', product_id: leaf, calc_mode: 'manual', qty_kg: '500', unit_price: '500000' }] });
    const approved = await post(`/api/v1/orders/${o.id}/approve`, { version: o.version }, 200);
    const [teeLine, leafLine] = approved.lines;
    for (const code of ['810', 'TMP1']) {
      const r = await t.call(m, { method: 'POST', url: `/api/v1/orders/${o.id}/reserve`, payload: { items: [{ order_line_id: teeLine.id, bundle_id: ids[code] }] }, idempotency: uuid() });
      expect(r.statusCode, code).toBe(400);
      expect(json(r).error.message).toContain('قابل رزرو نیست');
    }
    const damaged = await t.call(m, { method: 'POST', url: `/api/v1/orders/${o.id}/reserve`, payload: { items: [{ order_line_id: leafLine.id, bundle_id: ids['822'] }] }, idempotency: uuid() });
    expect(damaged.statusCode).toBe(400);
    const ok = await post(`/api/v1/orders/${o.id}/reserve`, { items: [{ order_line_id: leafLine.id, bundle_id: ids['806'] }] }, 200);
    expect(ok.statuses.supply).toBe('partial');
    const b806 = await get(`/api/v1/bundles/${ids['806']}`);
    expect(b806.reserved_order_line_id).toBe(leafLine.id);
    expect(b806.free_kg).toBe('0.000');
  });
});

// ───────────────────────────── (d) full order cycle ─────────────────────────────
describe('§12-d — full order cycle with the T18 numbers', () => {
  let customer: string, factory: string, painter: string, supplier: string;
  let warehouse: string, factoryLoc: string, painterLoc: string;
  let productId: string, orderId: string, lineId: string, lotId: string, runId: string, coatingId: string, transferId: string, invoiceId: string;
  const bundleIds: string[] = [];

  const balance = async (partyId: string) => (await get(`/api/v1/parties/${partyId}/summary`)).balances as Record<string, string>;

  it('sets up parties, contracts and an approved order of 1,000 kg at 440,000', async () => {
    customer = await party('مشتری چرخه کامل', ['customer'], { city: 'تهران' });
    factory = await party('کارخانه ب', ['factory']);
    painter = await party('رنگ‌کار ج', ['painter']);
    supplier = await party('تأمین‌کننده شمش', ['ingot_supplier']);
    warehouse = await ownWarehouse();
    factoryLoc = await locationOf(factory, 'factory');
    painterLoc = await locationOf(painter, 'painter');
    await post('/api/v1/contracts', { party_id: factory, service: 'extrusion', rate_per_kg: '20000', weight_basis: 'good_output', scrap_owner: 'vitral', valid_from: '2026-01-01' });
    await post('/api/v1/contracts', { party_id: painter, service: 'paint', rate_per_kg: '80000', includes_material: true, valid_from: '2026-01-01' });
    productId = await product('پروفیل چرخه', 'CY-1');
    const filler = await approvedFiller(productId, '1000', null);
    const o = await post('/api/v1/orders', { party_id: customer, prepay_percent: '0', lines: [{ kind: 'profile', product_id: productId, product_filler_id: filler, length_m: '6', color: 'سفید', calc_mode: 'from_weight', qty_kg: '1000', unit_price: '440000', supply_method: 'toll_production', coating_gain_estimate_percent: '5' }] });
    orderId = o.id;
    lineId = o.lines[0].id;
    expect(o.totals.totals).toEqual({ TOMAN: '440000000' });
    expect(o.lines[0].estimated_coated_kg).toBe('1050.000');
    const a = await post(`/api/v1/orders/${orderId}/approve`, { version: o.version }, 200);
    expect(a.status_sales).toBe('approved');
    expect(a.statuses.next_action).toBe('send_ingot');
  });

  it('T41 — buys 1,000 kg ingot at 300,000: one debt, one stock increase', async () => {
    const p = await post('/api/v1/purchases', { party_id: supplier, purchase_kind: 'ingot', agreed_kg: '1000', unit_price: '300000', lot: { alloy: '6063' } });
    expect(p.amount).toBe('300000000.00');
    lotId = p.material_lot_id;
    await post(`/api/v1/documents/${p.id}/post`, { version: p.version }, 200);
    expect((await balance(supplier)).TOMAN).toBe('-300000000');
    const cur = await get(`/api/v1/purchases/${p.id}`);
    const r = await post(`/api/v1/purchases/${p.id}/receive`, { version: cur.version, kg: '1000', to_location_id: warehouse }, 200);
    expect(r.received_kg).toBe('1000.000');
    const lot = await get(`/api/v1/material-lots/${lotId}`);
    expect(lot.total_kg).toBe('1000.000');
    expect(lot.avg_cost).toBe('300000');
    expect(lot.positions).toEqual([expect.objectContaining({ location_id: warehouse, kg: '1000.000' })]);
  });

  it('sends the ingot to the factory (dispatch + receive) keeping its book value', async () => {
    const tr = await post('/api/v1/transfers', { kind: 'to_production', from_location_id: warehouse, to_location_id: factoryLoc, lines: [{ material_lot_id: lotId, kg: '1000' }] });
    const d = await post(`/api/v1/transfers/${tr.id}/dispatch`, { version: tr.version }, 200);
    expect(d.status).toBe('in_transit');
    const r = await post(`/api/v1/transfers/${tr.id}/receive`, { version: d.version }, 200);
    expect(r.status).toBe('received');
    const lot = await get(`/api/v1/material-lots/${lotId}`);
    expect(lot.positions).toEqual([expect.objectContaining({ location_id: factoryLoc, kg: '1000.000' })]);
    expect(lot.avg_cost).toBe('300000');
    const ps = await get(`/api/v1/stock/party-account/${factory}`);
    expect(ps.received_kg).toBe('1000.000');
  });

  it('runs production: 1,000 kg good raw in two bundles; closing consumes the ingot and books the fee (20,000 × 1,000)', async () => {
    const run = await post('/api/v1/production-runs', { factory_party_id: factory, lines: [{ order_line_id: lineId, product_id: productId, target_kg: '1000' }] });
    runId = run.id;
    expect(run.rate_per_kg).toBe('20000.00');
    expect(run.weight_basis).toBe('good_output');
    const avail = await get(`/api/v1/production-runs/${runId}/ingot`);
    expect(avail.items).toEqual([expect.objectContaining({ item_id: lotId, kg: '1000.000', avg_cost: '300000' })]);
    for (const code of ['C-01', 'C-02']) {
      const b = await post('/api/v1/bundles', { production_run_id: runId, code, weight_kg: '500', lines: [{ product_id: productId, order_line_id: lineId, bars: 83, length_m: '6' }] });
      bundleIds.push(b.id);
      expect(b.location_id).toBe(factoryLoc);
    }
    const st = await get(`/api/v1/orders/${orderId}`);
    expect(st.statuses.supply).toBe('full');
    expect(st.statuses.operations).toBe('raw_ready');
    expect(st.statuses.next_action).toBe('send_to_coating');
    const closed = await post(`/api/v1/production-runs/${runId}/close`, { version: run.version, ingot_consumed_kg: '1000', scrap_kg: '0' }, 200);
    expect(closed.status).toBe('closed');
    expect(closed.good_kg).toBe('1000.000');
    expect(closed.balance.unexplained_kg).toBe('0.000');
    expect(closed.balance.yield_percent).toBe('100.0');
    const fee = await get(`/api/v1/documents/${closed.fee_document_id}`);
    expect(fee.kind).toBe('toll_fee');
    expect(fee.amount).toBe('20000000.00');
    expect(fee.status).toBe('posted');
    expect((await balance(factory)).TOMAN).toBe('-20000000');
    const lot = await get(`/api/v1/material-lots/${lotId}`);
    expect(lot.total_kg).toBe('0.000');
    // T42 / principle 9: money never changes the weight account
    const ws = await get(`/api/v1/stock/party-account/${factory}`);
    expect(ws.consumed_kg).toBe('1000.000');
    expect(ws.produced_kg).toBe('1000.000');
  });

  it('T06/T07 — coating: fee on 1,000 kg input (80,000,000); return 1,050 kg = +5.0 %', async () => {
    const c = await post('/api/v1/coating-runs', { party_id: painter, service: 'paint', color_code: 'سفید', bundle_ids: bundleIds });
    coatingId = c.id;
    expect(c.rate_per_kg).toBe('80000.00');
    expect(c.input_basis_kg).toBe('1000.000');
    expect(c.totals.fee).toBe('80000000');
    expect(c.items).toHaveLength(2);
    expect((await get(`/api/v1/orders/${orderId}`)).statuses.operations).toBe('at_painter');
    const pos = await get(`/api/v1/stock/positions?location_id=${painterLoc}`);
    expect(pos.items.filter((p: any) => p.item_type === 'bundle')).toHaveLength(2);
    const returned = await post(`/api/v1/coating-runs/${coatingId}/return`, { version: c.version, items: c.items.map((i: any) => ({ item_id: i.id, coated_kg: '525' })) }, 200);
    expect(returned.status).toBe('returned');
    expect(returned.totals.coated_kg).toBe('1050.000');
    expect(returned.totals.gain_kg).toBe('50.000');
    expect(returned.totals.gain_percent).toBe('5.0');
    expect(returned.totals.fee).toBe('80000000'); // output weight has no effect (R05)
    const closed = await post(`/api/v1/coating-runs/${coatingId}/close`, { version: returned.version }, 200);
    expect(closed.status).toBe('closed');
    const fee = await get(`/api/v1/documents/${closed.fee_document_id}`);
    expect(fee.amount).toBe('80000000.00');
    expect(fee.status).toBe('posted');
    expect((await balance(painter)).TOMAN).toBe('-80000000');
    for (const id of bundleIds) {
      const b = await get(`/api/v1/bundles/${id}`);
      expect(b.form).toBe('painted');
      expect(b.weight_kg).toBe('525.000');
      expect(b.raw_weight_kg).toBe('500.000');
      expect(b.location_id).toBe(warehouse);
    }
    expect((await get(`/api/v1/orders/${orderId}`)).statuses.next_action).toBe('pack_and_ship');
  });

  it('packs and ships: packing list, dispatch, approved sale scale ticket, delivery to the customer', async () => {
    const tr = await post('/api/v1/transfers', { kind: 'to_customer', from_location_id: warehouse, order_ids: [orderId], lines: bundleIds.map((bundle_id) => ({ bundle_id, order_id: orderId, order_line_id: lineId })), driver_name: 'راننده', plate: '12ب345-11' });
    transferId = tr.id;
    expect(tr.totals.kg).toBe('1050.000');
    const packed = await t.call(m, { method: 'PUT', url: `/api/v1/transfers/${transferId}/packing`, payload: { version: tr.version, lines: [{ product_id: productId, order_id: orderId, order_line_id: lineId, color: 'سفید', length_m: '6', packages: 12, bars_per_package: 14, weight_kg: '1050' }] } }).then((r) => expectStatus(r, 200));
    expect(packed.totals.bars).toBe(168); // R04
    const d = await post(`/api/v1/transfers/${transferId}/dispatch`, { version: packed.version }, 200);
    expect(d.status).toBe('in_transit');
    expect((await get(`/api/v1/orders/${orderId}`)).statuses.shipping).toBe('full');
    const ticket = await post('/api/v1/scale-tickets', { transfer_id: transferId, stage: 'destination', net_direct_kg: '1050', ticket_no: '7' });
    const approvedTicket = await post(`/api/v1/scale-tickets/${ticket.id}/approve`, { version: ticket.version, approved_for: ['sale'] }, 200);
    expect(approvedTicket.status).toBe('approved');
    const r = await post(`/api/v1/transfers/${transferId}/receive`, { version: d.version, receiver_name: 'انباردار مشتری' }, 200);
    expect(r.status).toBe('delivered');
    expect(r.totals.received_kg).toBe('1050.000');
    for (const id of bundleIds) expect((await get(`/api/v1/bundles/${id}`)).status).toBe('consumed');
    const st = await get(`/api/v1/orders/${orderId}`);
    expect(st.statuses.shipping).toBe('delivered');
    expect(st.statuses.next_action).toBe('issue_invoice');
    const warehousePos = await get(`/api/v1/stock/positions?location_id=${warehouse}`);
    expect(warehousePos.items.filter((p: any) => bundleIds.includes(p.item_id))).toHaveLength(0);
  });

  it('invoices 462,000,000 on the final net weight and settles it; R12 balances follow', async () => {
    const inv = await post('/api/v1/documents', { kind: 'invoice', order_id: orderId, post: true });
    invoiceId = inv.id;
    expect(inv.status).toBe('posted');
    expect(inv.amount).toBe('462000000.00');
    expect(inv.settlement_basis_kg).toBe('1050.000');
    expect(inv.lines[0].qty).toBe('1050.000');
    expect((await balance(customer)).TOMAN).toBe('462000000'); // Vitral is owed
    const rec = await post('/api/v1/documents', { kind: 'receipt', party_id: customer, amount: '462000000', method: 'bank_transfer', post: true, allocations: [{ to_document_id: invoiceId, amount: '462000000' }] });
    expect(rec.status).toBe('posted');
    expect(rec.allocated).toBe('462000000');
    expect((await balance(customer)).TOMAN).toBe('0');
    const st = await get(`/api/v1/orders/${orderId}`);
    expect(st.totals.paid).toEqual({ TOMAN: '462000000' });
    expect(st.statuses.finance).toBe('settled');
    expect(st.statuses.next_action).toBeNull();
    const invHtml = await t.call(m, { method: 'GET', url: `/api/v1/documents/${invoiceId}/pdf?format=html` });
    expect(invHtml.statusCode).toBe(200);
    expect(invHtml.body).toContain('چهارصد و شصت و دو میلیون تومان');
  });

  it('T18 — costing: cost 400,000,000 (incl. coating 80,000,000), profit 62,000,000 = base 40,000,000 + weight-gain share 22,000,000', async () => {
    const c = await get(`/api/v1/orders/${orderId}/costing`);
    const by = Object.fromEntries(c.components.map((x: any) => [x.key.split(':')[0], x]));
    expect(by.ingot.amount).toBe('300000000');
    expect(by.ingot.status).toBe('final');
    expect(by.toll.amount).toBe('20000000');
    expect(by.toll.status).toBe('final');
    expect(by.coating.amount).toBe('80000000');
    expect(by.coating.status).toBe('final');
    expect(c.components).toHaveLength(3);
    expect(c.cost_incomplete).toBe(false);
    expect(c.total_cost).toBe('400000000');
    expect(c.raw_kg).toBe('1000.000');
    expect(c.coated_kg).toBe('1050.000');
    expect(c.dispatched_raw_kg).toBe('1000.000');
    expect(c.dispatched_final_kg).toBe('1050.000');
    expect(c.sold_gain_kg).toBe('50.000');
    expect(c.sales).toEqual({ proforma: '440000000', invoiced: '462000000', status: 'final' });
    expect(c.profit.realised).toEqual({ sales: '462000000', cost: '400000000', profit: '62000000' });
    expect(c.profit.split).toEqual({ gain_share: '22000000', base_share: '40000000', total: '62000000' });
    expect(c.profit.collected).toEqual({ received: '462000000', paid: '0', net: '462000000' });
    expect(c.pricing.effective_price_per_kg).toBe('440000');
    expect(c.pricing.base_per_kg).toBe('400000');
    expect(c.pricing.suggested_per_kg).toBe('440000'); // T25
    // the period profit on the dashboard sees the same realised figure once
    const dash = await get('/api/v1/reports/dashboard');
    const toman = dash.profit.by_currency.find((x: any) => x.currency === 'TOMAN');
    expect(toman.realised).toBe('62000000');
    expect(toman.coating_gain_share).toBe('22000000');
  });
});
