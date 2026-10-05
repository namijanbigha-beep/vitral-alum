/**
 * Purchases (module 8 / R13) regressions:
 *  - PATCH /purchases/:id with a `reason` records it on the audit row (it is not a document column);
 *  - completing the price of a purchase already received at an unknown price never rewrites the append-only ledger
 *    (principle 8): the receipt keeps unit_cost NULL and the lot's moving average takes the price from the purchase.
 */
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestApp, type TestApp, uuid } from './helpers.js';

let t: TestApp;
let m: string;
let warehouse: string;
let supplier: string;

function expectStatus(r: LightMyRequestResponse, status: number): Record<string, any> {
  expect(r.statusCode, `${r.statusCode} ${r.body}`).toBe(status);
  return r.json() as Record<string, any>;
}
const post = (url: string, payload: object, status = 201) => t.call(m, { method: 'POST', url, payload, idempotency: uuid() }).then((r) => expectStatus(r, status));
const patch = (url: string, payload: object) => t.call(m, { method: 'PATCH', url, payload }).then((r) => expectStatus(r, 200));
const get = (url: string) => t.call(m, { method: 'GET', url }).then((r) => expectStatus(r, 200));

beforeAll(async () => {
  t = await setupTestApp();
  await t.createUser({ mobile: '09120000001', password: 'manager-pass-1', role: 'manager', name: 'مدیر' });
  m = await t.login('09120000001', 'manager-pass-1');
  warehouse = (await get('/api/v1/locations?kind=own_warehouse')).items[0].id;
  supplier = (await post('/api/v1/parties', { name: 'تأمین‌کننده', roles: ['ingot_supplier'] })).id;
});
afterAll(() => t.close());

describe('PATCH /purchases/:id with a reason', () => {
  it('updates the purchase and keeps the reason on the audit row', async () => {
    const p = await post('/api/v1/purchases', { party_id: supplier, purchase_kind: 'other', amount: '5000' });
    const after = await patch(`/api/v1/purchases/${p.id}`, { version: p.version, reason: 'اصلاح شرح', description: 'شرح جدید' });
    expect(after.description).toBe('شرح جدید');
    expect(after.version).toBe(p.version + 1);
    expect(after).not.toHaveProperty('reason');
    const rows = await t.db.selectFrom('audit_log').select(['reason']).where('entity', '=', 'documents').where('entity_id', '=', p.id).where('action', '=', 'update').execute();
    expect(rows.map((r) => r.reason)).toEqual(['اصلاح شرح']);
  });
});

describe('R13 — price completed after an unpriced receipt', () => {
  it('leaves the ledger untouched and values the lot with the purchase price', async () => {
    const p = await post('/api/v1/purchases', { party_id: supplier, purchase_kind: 'ingot', agreed_kg: '50' });
    expect(p.status).toBe('needs_completion');
    const received = await post(`/api/v1/purchases/${p.id}/receive`, { version: p.version, kg: '50', to_location_id: warehouse }, 200);
    const before = await get(`/api/v1/material-lots/${p.material_lot_id}`);
    expect(before.avg_cost).toBeNull();
    expect(before.cost_incomplete).toBe(true);
    const ledger = () => t.db.selectFrom('stock_moves').select(['id', 'kg', 'unit_cost', 'currency']).where('ref_type', '=', 'purchase_receipt').where('ref_id', '=', p.id).execute();
    const movesBefore = await ledger();
    expect(movesBefore).toHaveLength(1);
    expect(movesBefore[0]!.unit_cost).toBeNull();

    const priced = await patch(`/api/v1/purchases/${p.id}`, { version: received.version, unit_price: '90000' });
    expect(priced.unit_price).toBe('90000.00');
    expect(priced.amount).toBe('4500000.00');
    expect(priced.status).toBe('draft');

    expect(await ledger()).toEqual(movesBefore); // append-only: the receipt row is not rewritten
    const lot = await get(`/api/v1/material-lots/${p.material_lot_id}`);
    expect(lot.avg_cost).toBe('90000');
    expect(lot.cost_incomplete).toBe(false);
    expect(lot.total_kg).toBe('50.000');
    // A later issue carries the now-known book value.
    await post('/api/v1/materials/consume', { lot_id: p.material_lot_id, location_id: warehouse, kg: '10' }, 200);
    const consume = await t.db.selectFrom('stock_moves').select(['unit_cost']).where('ref_type', '=', 'material_consume').where('item_id', '=', p.material_lot_id).execute();
    expect(consume.map((r) => r.unit_cost)).toEqual(['90000.00']);
  });
});
