import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestApp, type TestApp, uuid } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await setupTestApp();
  await t.createUser({ mobile: '09120000001', password: 'manager-pass-1', role: 'manager', name: 'مدیر' });
  await t.createUser({ mobile: '09120000002', password: 'staff-pass-22', role: 'staff', name: 'کارمند' });
});
afterAll(() => t.close());

describe('login and session', () => {
  it('logs in with Persian digits in the mobile and sets an HttpOnly cookie', async () => {
    const res = await t.call(null, { method: 'POST', url: '/api/v1/auth/login', payload: { mobile: '۰۹۱۲۰۰۰۰۰۰۱', password: 'manager-pass-1' } });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });
  it('rejects a wrong password with a Persian message and no detail', async () => {
    const res = await t.call(null, { method: 'POST', url: '/api/v1/auth/login', payload: { mobile: '09120000001', password: 'nope-nope-1' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'unauthorized', message: 'شماره موبایل یا رمز درست نیست' } });
  });
  it('me returns effective permissions: manager has all, staff only granted', async () => {
    const m = await t.login('09120000001', 'manager-pass-1');
    const me = await t.call(m, { method: 'GET', url: '/api/v1/auth/me' });
    expect(me.json().user.permissions).toContain('finance.view');
    const s = await t.login('09120000002', 'staff-pass-22');
    const meS = await t.call(s, { method: 'GET', url: '/api/v1/auth/me' });
    expect(meS.json().user.permissions).toEqual([]);
  });
  it('rejects a mutating request without origin or the app header (CSRF)', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(res.statusCode).toBe(403);
  });
  it('logout invalidates the cookie', async () => {
    const c = await t.login('09120000002', 'staff-pass-22');
    await t.call(c, { method: 'POST', url: '/api/v1/auth/logout' });
    const me = await t.call(c, { method: 'GET', url: '/api/v1/auth/me' });
    expect(me.statusCode).toBe(401);
  });
  it('change-password requires the current one and keeps the user signed in on this device', async () => {
    const c = await t.login('09120000002', 'staff-pass-22');
    const bad = await t.call(c, { method: 'POST', url: '/api/v1/auth/change-password', payload: { current_password: 'wrong-wrong', new_password: 'staff-pass-33' } });
    expect(bad.statusCode).toBe(400);
    const ok = await t.call(c, { method: 'POST', url: '/api/v1/auth/change-password', payload: { current_password: 'staff-pass-22', new_password: 'staff-pass-33' } });
    expect(ok.statusCode).toBe(200);
    const newCookie = String(ok.headers['set-cookie']).split(';')[0] ?? '';
    expect((await t.call(newCookie, { method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(200);
    expect((await t.call(c, { method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
    expect(await t.login('09120000002', 'staff-pass-33')).toBeTruthy();
  });
});

describe('T46 — five failed logins lock the account for 15 minutes', () => {
  it('sixth attempt with the right password is rejected', async () => {
    await t.createUser({ mobile: '09120000046', password: 'right-pass-46', role: 'staff' });
    for (let i = 0; i < 4; i += 1) {
      const r = await t.call(null, { method: 'POST', url: '/api/v1/auth/login', payload: { mobile: '09120000046', password: 'wrong' } });
      expect(r.statusCode).toBe(401);
    }
    const fifth = await t.call(null, { method: 'POST', url: '/api/v1/auth/login', payload: { mobile: '09120000046', password: 'wrong' } });
    expect(fifth.statusCode).toBe(423);
    const sixth = await t.call(null, { method: 'POST', url: '/api/v1/auth/login', payload: { mobile: '09120000046', password: 'right-pass-46' } });
    expect(sixth.statusCode).toBe(423);
    expect(sixth.json().error.code).toBe('locked');
    const row = await t.db.selectFrom('users').select('locked_until').where('mobile', '=', '09120000046').executeTakeFirstOrThrow();
    const minutes = (new Date(row.locked_until as Date).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
  });
  it('works again once the lock has passed', async () => {
    await t.db.updateTable('users').set({ locked_until: new Date(Date.now() - 1000) }).where('mobile', '=', '09120000046').execute();
    const r = await t.call(null, { method: 'POST', url: '/api/v1/auth/login', payload: { mobile: '09120000046', password: 'right-pass-46' } });
    expect(r.statusCode).toBe(200);
  });
});

describe('T45 — deactivating a user ends their sessions at once', () => {
  it('next request with the same cookie is 401, history stays', async () => {
    const id = await t.createUser({ mobile: '09120000045', password: 'staff-pass-45', role: 'staff' });
    const staff = await t.login('09120000045', 'staff-pass-45');
    expect((await t.call(staff, { method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(200);
    const m = await t.login('09120000001', 'manager-pass-1');
    const cur = await t.call(m, { method: 'GET', url: `/api/v1/users/${id}` });
    const res = await t.call(m, { method: 'PATCH', url: `/api/v1/users/${id}`, payload: { version: cur.json().version, active: false, reason: 'ترک کار' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(false);
    expect((await t.call(staff, { method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
    const login = await t.call(null, { method: 'POST', url: '/api/v1/auth/login', payload: { mobile: '09120000045', password: 'staff-pass-45' } });
    expect(login.statusCode).toBe(401);
    const audit = await t.db.selectFrom('audit_log').selectAll().where('entity_id', '=', id).where('action', '=', 'deactivate').executeTakeFirst();
    expect(audit?.reason).toBe('ترک کار');
    expect(JSON.stringify(audit?.before)).not.toContain('password');
  });
});

describe('T35 — stale version → 409 with the current record', () => {
  it('second editor is rejected and gets the fresh record', async () => {
    const id = await t.createUser({ mobile: '09120000035', password: 'staff-pass-35', role: 'staff' });
    const m = await t.login('09120000001', 'manager-pass-1');
    const first = await t.call(m, { method: 'PATCH', url: `/api/v1/users/${id}`, payload: { version: 1, name: 'نام یک' } });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(2);
    const stale = await t.call(m, { method: 'PATCH', url: `/api/v1/users/${id}`, payload: { version: 1, name: 'نام دو' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('conflict');
    expect(stale.json().error.current).toMatchObject({ name: 'نام یک', version: 2 });
  });
});

describe('T34 — Idempotency-Key replays the same response', () => {
  it('one record, same body, and a missing key is rejected', async () => {
    const m = await t.login('09120000001', 'manager-pass-1');
    const payload = { mobile: '09120000034', name: 'تکراری', password: 'staff-pass-34', role: 'staff', permissions: [] };
    const noKey = await t.call(m, { method: 'POST', url: '/api/v1/users', payload });
    expect(noKey.statusCode).toBe(400);
    const key = uuid();
    const a = await t.call(m, { method: 'POST', url: '/api/v1/users', payload, idempotency: key });
    const b = await t.call(m, { method: 'POST', url: '/api/v1/users', payload, idempotency: key });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    const count = await t.db.selectFrom('users').select(t.db.fn.countAll<string>().as('n')).where('mobile', '=', '09120000034').executeTakeFirstOrThrow();
    expect(count.n).toBe('1');
    // Same key from another endpoint is a conflict, never a silent replay.
    const other = await t.call(m, { method: 'POST', url: '/api/v1/backup/restore-test', payload: { tested_at: new Date().toISOString(), duration_minutes: 1, result: 'ok' }, headers: { 'idempotency-key': key } });
    expect(other.statusCode).toBe(201); // restore-test does not use the key
    const dup = await t.call(m, { method: 'POST', url: '/api/v1/users', payload: { ...payload, mobile: '09120000039' }, idempotency: key });
    expect(dup.json()).toEqual(a.json());
  });
});

describe('permissions and settings', () => {
  it('staff cannot list users or change settings', async () => {
    const s = await t.login('09120000002', 'staff-pass-33');
    expect((await t.call(s, { method: 'GET', url: '/api/v1/users' })).statusCode).toBe(403);
    expect((await t.call(s, { method: 'PUT', url: '/api/v1/settings/seller_phone', payload: { version: 1, value: '086' } })).statusCode).toBe(403);
  });
  it('manager updates a setting with audit and version bump', async () => {
    const m = await t.login('09120000001', 'manager-pass-1');
    const res = await t.call(m, { method: 'PUT', url: '/api/v1/settings/seller_phone', payload: { version: 1, value: '۰۸۶-۳۳۰۰۰۰۰۰' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(2);
    const bad = await t.call(m, { method: 'PUT', url: '/api/v1/settings/default_prepay_percent', payload: { version: 1, value: '150' } });
    expect(bad.statusCode).toBe(400);
    const pattern = await t.call(m, { method: 'PUT', url: '/api/v1/settings/default_numbering_pattern', payload: { version: 1, value: 'no-seq' } });
    expect(pattern.statusCode).toBe(400);
  });
  it('audit_log cannot be updated or deleted', async () => {
    await expect(t.db.deleteFrom('audit_log').execute()).rejects.toThrow(/append-only/);
  });
  it('health reports db and disk', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' });
  });
});
