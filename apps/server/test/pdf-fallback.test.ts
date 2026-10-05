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

  it('format=html stays a script-free preview', async () => {
    const r = await t.call(manager, { method: 'GET', url: `/api/v1/parties/${partyId}/statement.pdf?format=html` });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('<script');
    expect(String(r.headers['content-security-policy'])).not.toContain('script-src');
  });
});
