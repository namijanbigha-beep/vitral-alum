import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextNumber, renderPattern, counterPeriod } from '../src/lib/numbering.js';
import { setupTestApp, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

describe('principle 11 — server-side gap-free numbering', () => {
  it('renders the two known patterns in Jalali', () => {
    const at = new Date('2026-09-14T08:00:00Z'); // 1405/06/23
    expect(renderPattern('VT-{seq:4}', 1, at, 'Asia/Tehran')).toBe('VT-0001');
    expect(renderPattern('V{yymmdd}-{seq}', 9, at, 'Asia/Tehran')).toBe('V050623-9');
    expect(counterPeriod('VT-{seq:4}', at, 'Asia/Tehran')).toBe(0);
    expect(counterPeriod('V{yymmdd}-{seq}', at, 'Asia/Tehran')).toBe(14050623);
    expect(counterPeriod('{yyyy}/{seq}', at, 'Asia/Tehran')).toBe(1405);
  });
  it('is sequential, and a rolled-back transaction leaves no gap', async () => {
    const a = await t.db.transaction().execute((trx) => nextNumber(trx, 'proforma'));
    expect(a).toBe('VT-0001');
    await t.db
      .transaction()
      .execute(async (trx) => {
        await nextNumber(trx, 'proforma');
        throw new Error('rollback');
      })
      .catch(() => undefined);
    const b = await t.db.transaction().execute((trx) => nextNumber(trx, 'proforma'));
    expect(b).toBe('VT-0002');
  });
  it('is unique under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => t.db.transaction().execute((trx) => nextNumber(trx, 'transfer'))),
    );
    expect(new Set(results).size).toBe(20);
    expect(results.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `VT-${String(i + 1).padStart(4, '0')}`));
  });
  it('per-kind pattern from settings resets daily', async () => {
    await t.db
      .updateTable('settings')
      .set({ value: JSON.stringify({ wholesale: 'V{yymmdd}-{seq}' }) })
      .where('key', '=', 'numbering_patterns')
      .execute();
    const d1 = new Date('2026-09-14T08:00:00Z');
    const d2 = new Date('2026-09-15T08:00:00Z');
    expect(await t.db.transaction().execute((trx) => nextNumber(trx, 'wholesale', d1))).toBe('V050623-1');
    expect(await t.db.transaction().execute((trx) => nextNumber(trx, 'wholesale', d1))).toBe('V050623-2');
    expect(await t.db.transaction().execute((trx) => nextNumber(trx, 'wholesale', d2))).toBe('V050624-1');
  });
});
