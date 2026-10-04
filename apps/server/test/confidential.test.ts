import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findConfidentialKeys } from '../src/lib/confidential.js';
import { setupTestApp, type TestApp } from './helpers.js';

let t: TestApp;
let staff: string;
let manager: string;
let staffId: string;

beforeAll(async () => {
  t = await setupTestApp();
  await t.createUser({ mobile: '09120000001', password: 'manager-pass-1', role: 'manager' });
  staffId = await t.createUser({ mobile: '09120000002', password: 'staff-pass-22', role: 'staff', permissions: ['settings.manage'] });
  manager = await t.login('09120000001', 'manager-pass-1');
  staff = await t.login('09120000002', 'staff-pass-22');
});
afterAll(() => t.close());

describe('T36 — staff without finance.view gets no confidential key from any GET endpoint', () => {
  it('walks every registered GET route', async () => {
    const routes = t.app.routeList
      .filter((r) => r.method === 'GET' || r.method === 'HEAD')
      .map((r) => r.url)
      .filter((u) => u.startsWith('/api/v1') && !u.includes('/health'));
    expect(routes.length).toBeGreaterThan(3);
    const checked: string[] = [];
    for (const route of routes) {
      const url = route.replace(':id', staffId).replace(':key', 'seller_phone');
      const res = await t.call(staff, { method: 'GET', url });
      if (res.statusCode === 200 && (res.headers['content-type'] ?? '').toString().includes('json')) {
        expect(findConfidentialKeys(res.json()), `leak on ${url}`).toEqual([]);
        checked.push(url);
      }
    }
    expect(checked).toContain('/api/v1/settings');
    expect(checked).toContain('/api/v1/auth/me');
  });

  it('settings: the paint rate is a finance key and only the manager sees it', async () => {
    const s = await t.call(staff, { method: 'GET', url: '/api/v1/settings' });
    expect(s.json().items.map((i: { key: string }) => i.key)).not.toContain('default_paint_rate_per_kg');
    const m = await t.call(manager, { method: 'GET', url: '/api/v1/settings' });
    const rate = m.json().items.find((i: { key: string }) => i.key === 'default_paint_rate_per_kg');
    expect(rate.value).toEqual({ amount: '80000', currency: 'TOMAN' });
    const put = await t.call(staff, { method: 'PUT', url: '/api/v1/settings/default_paint_rate_per_kg', payload: { version: 1, value: { amount: '90000', currency: 'TOMAN' } } });
    expect(put.statusCode).toBe(403);
  });

  it('findConfidentialKeys covers exact names, prefixes and suffixed names', () => {
    expect(findConfidentialKeys({ unit_cost: 1, a: { profit_x: 1, b: [{ default_paint_rate_per_kg: 1 }] }, cost: 1, costly: 1 })).toEqual([
      'unit_cost',
      'a.profit_x',
      'a.b[0].default_paint_rate_per_kg',
    ]);
  });
});
