/**
 * Module 5 coating input basis, and the R13 ingot cost a production run sees after a purchase price is completed.
 * Runs against Node and (VITRAL_TARGET=php) the PHP twin.
 */
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestApp, type TestApp, uuid } from './helpers.js';

let t: TestApp;
let m: string;

function expectStatus(r: LightMyRequestResponse, status: number): Record<string, any> {
  expect(r.statusCode, `${r.statusCode} ${r.body}`).toBe(status);
  return r.json() as Record<string, any>;
}
const call = (url: string, payload: object) => t.call(m, { method: 'POST', url, payload, idempotency: uuid() });
const post = (url: string, payload: object, status = 201) => call(url, payload).then((r) => expectStatus(r, status));
const get = (url: string) => t.call(m, { method: 'GET', url }).then((r) => expectStatus(r, 200));
const patch = (url: string, payload: object) => t.call(m, { method: 'PATCH', url, payload }).then((r) => expectStatus(r, 200));

beforeAll(async () => {
  t = await setupTestApp();
  await t.createUser({ mobile: '09120000001', password: 'manager-pass-1', role: 'manager', name: 'مدیر' });
  m = await t.login('09120000001', 'manager-pass-1');
});
afterAll(() => t.close());

describe('POST /coating-runs/:id/basis', () => {
  it('scale_ticket without a ticket id → 400 with the scale_ticket_id field (not a 500), run unchanged', async () => {
    const painter = (await post('/api/v1/parties', { name: 'رنگ‌کار آزمون', roles: ['painter'] })).id as string;
    const product = (await post('/api/v1/products', { name_fa: 'پروفیل آزمون', code: 'CT-1' })).id as string;
    const bundle = await post('/api/v1/bundles', { code: 'CT-B1', weight_kg: '100', source: 'opening', lines: [{ product_id: product, length_m: '6' }] });
    const run = await post('/api/v1/coating-runs', { party_id: painter, service: 'paint', bundle_ids: [bundle.id] });

    const r = await call(`/api/v1/coating-runs/${run.id}/basis`, { version: run.version, input_basis: 'scale_ticket' });
    expect(expectStatus(r, 400)).toEqual({
      error: { code: 'validation', message: 'قبض باسکول تأییدشده برای این نوبت لازم است', fields: { scale_ticket_id: 'نامعتبر' } },
    });
    const unknown = await call(`/api/v1/coating-runs/${run.id}/basis`, { version: run.version, input_basis: 'scale_ticket', scale_ticket_id: uuid() });
    expect(expectStatus(unknown, 400).error.fields).toEqual({ scale_ticket_id: 'نامعتبر' });

    const after = expectStatus(await t.call(m, { method: 'GET', url: `/api/v1/coating-runs/${run.id}` }), 200);
    expect(after).toMatchObject({ version: run.version, input_basis: 'bundle_sum', input_basis_kg: '100.000' });
  });
});

describe('GET /production-runs/:id/ingot — R13 average cost', () => {
  it('a receipt booked before the price was known is valued with the price completed later on the purchase (ledger untouched)', async () => {
    const supplier = (await post('/api/v1/parties', { name: 'تأمین‌کننده شمش آزمون', roles: ['ingot_supplier'] })).id as string;
    const factory = (await post('/api/v1/parties', { name: 'کارخانه آزمون قیمت', roles: ['factory'] })).id as string;
    const factoryLoc = (await get(`/api/v1/locations?party_id=${factory}&kind=factory`)).items[0].id as string;
    const run = await post('/api/v1/production-runs', { factory_party_id: factory });

    const p = await post('/api/v1/purchases', { party_id: supplier, purchase_kind: 'ingot', agreed_kg: '1000' });
    expect(p.unit_price).toBeNull();
    await post(`/api/v1/purchases/${p.id}/receive`, { version: p.version, kg: '1000', to_location_id: factoryLoc }, 200);
    const before = (await get(`/api/v1/production-runs/${run.id}/ingot`)).items;
    expect(before).toEqual([expect.objectContaining({ item_id: p.material_lot_id, kg: '1000.000', avg_cost: null })]);

    const cur = await get(`/api/v1/purchases/${p.id}`);
    await patch(`/api/v1/purchases/${p.id}`, { version: cur.version, unit_price: '300000' });
    const after = (await get(`/api/v1/production-runs/${run.id}/ingot`)).items;
    expect(after).toEqual([expect.objectContaining({ item_id: p.material_lot_id, kg: '1000.000', avg_cost: '300000' })]);
    const moves = await t.db.selectFrom('stock_moves').select('unit_cost').where('ref_id', '=', p.id).execute();
    expect(moves.map((x) => x.unit_cost)).toEqual([null]);
  });
});
