// Regression tests for the reports / import / xlsx fixes found by the Node ↔ PHP conformance run.
// Runs against Node (default) and PHP (VITRAL_TARGET=php).
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readXlsxRows } from '../src/lib/xlsx-read.js';
import { setupTestApp, type TestApp, uuid } from './helpers.js';

let t: TestApp;
let m: string;
let managerId: string;

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function ok(r: LightMyRequestResponse, status = 200): any {
  expect(r.statusCode, `${r.statusCode} ${r.body}`).toBe(status);
  return r.json();
}
const get = (url: string) => t.call(m, { method: 'GET', url: `/api/v1${url}` });
const post = (url: string, payload?: object) => t.call(m, { method: 'POST', url: `/api/v1${url}`, payload, idempotency: uuid() });

/** Preview + commit one import batch; returns the commit body. */
async function importRows(kind: string, rows: string[][]) {
  const p = ok(await post('/import/preview', { kind, rows }), 201);
  expect(p.errors, JSON.stringify(p.errors)).toEqual([]);
  return ok(await post(`/import/${p.id}/commit`, {}));
}

beforeAll(async () => {
  t = await setupTestApp();
  managerId = await t.createUser({ mobile: '09120000001', password: 'manager-pass-1', role: 'manager', name: 'مدیر' });
  m = await t.login('09120000001', 'manager-pass-1');
  await importRows('products', [['کد', 'نام فارسی', 'وزن هر متر'], ['7168', 'مولیون', '791']]);
  await importRows('parties', [['نام', 'نقش‌ها'], ['مشتری الف', 'مشتری'], ['کارخانه ب', 'کارخانه']]);
});
afterAll(() => t.close());

describe('§18 — open orders import', () => {
  it('commits (the batch date read back from JSON is a string) and numbers the order', async () => {
    const res = await importRows('open_orders', [['شماره قدیم', 'مشتری', 'تاریخ', 'ردیف‌ها', 'قیمت', 'دریافتی تا امروز'], ['A-12', 'مشتری الف', '1405/01/10', '7168 × 500', '850000', '100000']]);
    expect(res.created).toEqual({ orders: 1, documents: 1 });
    const order = await t.db.selectFrom('orders').select(['number', 'title']).where('title', '=', 'شماره قدیم A-12').executeTakeFirstOrThrow();
    expect(order.number).toMatch(/^VT-\d{4}$/);
  });
});

describe('xlsx downloads — Content-Disposition', () => {
  it('a Persian export name gets an ASCII fallback and an RFC 5987 filename*', async () => {
    const r = await post('/export/xlsx', { name: 'گزارش فروش', header: ['کد', 'کیلو'], rows: [['7168', 12.5]] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-type']).toContain(XLSX);
    expect(r.headers['content-disposition']).toBe(`attachment; filename="___.xlsx"; filename*=UTF-8''${encodeURIComponent('گزارش_فروش.xlsx')}`);
    expect(readXlsxRows(r.rawPayload)).toEqual([['کد', 'کیلو'], ['7168', '12.5']]);
  });
  it('an ASCII name keeps the plain form; non-word characters are replaced as before', async () => {
    const r = await post('/export/xlsx', { name: 'sales / é!', header: ['a'], rows: [] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="sales_.xlsx"');
    expect((await get('/import/templates/products.xlsx')).headers['content-disposition']).toBe('attachment; filename="products.xlsx"');
  });
});

describe('stock positions — deterministic order', () => {
  it('lists the oldest position first (inventory report), whatever the insert order', async () => {
    const rows = [['نوع', 'محصول یا ماده', 'محل', 'کیلو', 'تاریخ'], ['شمش', 'دوم', 'کارخانه ب', '10', '1405/01/05'], ['شمش', 'اول', 'کارخانه ب', '20', '1405/01/02'], ['شمش', 'سوم', 'کارخانه ب', '30', '1405/01/09']];
    await importRows('opening_stock', rows);
    const inv = ok(await get('/reports/inventory'));
    expect(inv.rows.map((r: string[]) => r[2])).toEqual(['اول', 'دوم', 'سوم']);
    expect(inv.items.map((i: { kg: string }) => i.kg)).toEqual(['20.000', '10.000', '30.000']);
  });
});

describe('reports — DATE columns follow Tehran business days', () => {
  it('from=to=1405/01/01 covers exactly the Gregorian date 2026-03-21, not the UTC dates of the range instants', async () => {
    // 1405/01/01 starts at 2026-03-20T20:30Z; its DATE is 2026-03-21.
    for (const [number, date] of [['EXP-A', '2026-03-20'], ['EXP-B', '2026-03-21'], ['EXP-C', '2026-03-22']] as const) {
      await t.db.insertInto('documents').values({ number, kind: 'expense', amount: '1000', currency: 'TOMAN', status: 'posted', date, expense_type: 'general', created_by: managerId } as never).execute();
    }
    const one = ok(await get('/reports/expenses?from=1405/01/01&to=1405/01/01'));
    expect(one.rows.map((r: string[]) => r[0])).toEqual(['EXP-B']);
    const two = ok(await get(`/reports/expenses?from=${encodeURIComponent('۱۴۰۴/۱۲/۲۹')}&to=1405/01/01`));
    expect(two.rows.map((r: string[]) => r[0])).toEqual(['EXP-B', 'EXP-A']);
    const xl = await get('/reports/expenses?from=1405/01/02&to=1405/01/02&xlsx=true');
    expect(readXlsxRows(xl.rawPayload).slice(1).map((r) => r[0])).toEqual(['EXP-C']);
  });
});
