import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestApp, type TestApp } from './helpers.js';

// Shared hosting (cPanel) has no Chromium: a PDF request must still give the user a printable page, not a 500.
let t: TestApp;
let manager: string;
let partyId: string;

beforeAll(async () => {
  t = await setupTestApp({ CHROMIUM_PATH: '/nonexistent/chromium' });
  await t.createUser({ mobile: '09120000301', password: 'manager-pass-1', role: 'manager', name: 'مدیر' });
  manager = await t.login('09120000301', 'manager-pass-1');
  const party = await t.call(manager, { method: 'POST', url: '/api/v1/parties', payload: { name: 'مشتری چاپ', kind: 'customer' } });
  expect(party.statusCode, party.body).toBe(201);
  partyId = party.json().id;
});
afterAll(() => t.close());

describe('PDF without Chromium', () => {
  it('format=pdf falls back to the print page with a nonce-bound print script', async () => {
    const r = await t.call(manager, { method: 'GET', url: `/api/v1/parties/${partyId}/statement.pdf?format=pdf` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    const csp = String(r.headers['content-security-policy']);
    const nonce = /'nonce-([a-f0-9]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(r.body).toContain(`<script nonce="${nonce}">`);
    expect(r.body).toContain('print()');
    expect(r.body).toContain('مشتری چاپ');
  });

  it('T48 — a browser print still counts and is audited, with nothing archived', async () => {
    const p = await t.call(manager, { method: 'POST', url: '/api/v1/products', payload: { name_fa: 'پروفیل چاپ مرورگر', weight_g_per_m_no_filler: '500' } });
    expect(p.statusCode, p.body).toBe(201);
    const o = await t.call(manager, { method: 'POST', url: '/api/v1/orders', idempotency: crypto.randomUUID(), payload: { party_id: partyId, lines: [{ kind: 'profile', product_id: p.json().id, calc_mode: 'manual', qty_kg: '10', unit_price: '400000' }] } });
    expect(o.statusCode, o.body).toBe(201);
    for (const n of [1, 2]) {
      const r = await t.call(manager, { method: 'GET', url: `/api/v1/orders/${o.json().id}/proforma?format=pdf` });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('print()');
      const after = await t.call(manager, { method: 'GET', url: `/api/v1/orders/${o.json().id}` });
      expect(after.json().print_count).toBe(n);
      expect(after.json().status_sales).toBe('proforma');
    }
    const files = await t.call(manager, { method: 'GET', url: `/api/v1/files?owner_entity=orders&owner_id=${o.json().id}` });
    if (files.statusCode === 200) expect((files.json().items ?? []).filter((f: { kind: string }) => f.kind === 'document_pdf')).toHaveLength(0);
  });

  it('format=html stays a script-free preview', async () => {
    const r = await t.call(manager, { method: 'GET', url: `/api/v1/parties/${partyId}/statement.pdf?format=html` });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('<script');
    expect(String(r.headers['content-security-policy'])).not.toContain('script-src');
  });
});
