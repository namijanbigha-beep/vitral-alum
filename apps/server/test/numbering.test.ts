import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextNumber, renderPattern, counterPeriod } from '../src/lib/numbering.js';
import { setupTestApp, type TestApp } from './helpers.js';

// PHP target (VITRAL_TARGET=php): the same assertions, with numbering run by apps/php (Core/Numbering.php) through the
// PHP CLI against the test database — each call is its own process and its own transaction, like the Node calls below.
const PHP_MODE = process.env.VITRAL_TARGET === 'php';
const PHP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../php');
const execFileP = promisify(execFile);

async function php(code: string, env: Record<string, string> = {}): Promise<string> {
  const script = `require ${JSON.stringify(path.join(PHP_DIR, 'src/bootstrap.php'))};
$db = new Vitral\\Core\\Db(['host' => getenv('DB_HOST'), 'port' => getenv('DB_PORT'), 'name' => getenv('DB_NAME'), 'user' => getenv('DB_USER'), 'pass' => (string) getenv('DB_PASS')]);
$at = getenv('VT_AT') ? new DateTimeImmutable(getenv('VT_AT')) : null;
${code}`;
  const { stdout } = await execFileP(process.env.PHP_BIN ?? 'php', ['-r', script], {
    env: {
      ...process.env,
      DB_HOST: process.env.TEST_PHP_DB_HOST ?? '127.0.0.1',
      DB_PORT: process.env.TEST_PHP_DB_PORT ?? '3306',
      DB_NAME: process.env.TEST_PHP_DB_NAME ?? 'vitral_php_test',
      DB_USER: process.env.TEST_PHP_DB_USER ?? 'vitral',
      DB_PASS: process.env.TEST_PHP_DB_PASS ?? 'vitral',
      ...env,
    },
  });
  return stdout;
}

/** nextNumber in its own transaction; `rollback` throws after numbering so the transaction is rolled back. */
async function numberInTrx(kind: string, at?: Date, rollback = false): Promise<string> {
  if (PHP_MODE) {
    return php(
      `try { echo $db->transaction(function ($t) use ($at) { $n = Vitral\\Core\\Numbering::next($t, getenv('VT_KIND'), $at); if (getenv('VT_ROLLBACK')) throw new RuntimeException('rollback'); return $n; }); } catch (RuntimeException $e) { if ($e->getMessage() !== 'rollback') throw $e; }`,
      { VT_KIND: kind, VT_AT: at ? at.toISOString() : '', VT_ROLLBACK: rollback ? '1' : '' },
    );
  }
  return t.db.transaction().execute(async (trx) => {
    const n = await nextNumber(trx, kind, at);
    if (rollback) throw new Error('rollback');
    return n;
  });
}

const render = async (pattern: string, seq: number, at: Date, tz: string): Promise<string> =>
  PHP_MODE ? php(`echo Vitral\\Core\\Numbering::renderPattern(getenv('VT_P'), ${seq}, $at, getenv('VT_TZ'));`, { VT_P: pattern, VT_AT: at.toISOString(), VT_TZ: tz }) : renderPattern(pattern, seq, at, tz);
const period = async (pattern: string, at: Date, tz: string): Promise<number> =>
  PHP_MODE ? Number(await php(`echo Vitral\\Core\\Numbering::counterPeriod(getenv('VT_P'), $at, getenv('VT_TZ'));`, { VT_P: pattern, VT_AT: at.toISOString(), VT_TZ: tz })) : counterPeriod(pattern, at, tz);

let t: TestApp;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

describe('principle 11 — server-side gap-free numbering', () => {
  it('renders the two known patterns in Jalali', async () => {
    const at = new Date('2026-09-14T08:00:00Z'); // 1405/06/23
    expect(await render('VT-{seq:4}', 1, at, 'Asia/Tehran')).toBe('VT-0001');
    expect(await render('V{yymmdd}-{seq}', 9, at, 'Asia/Tehran')).toBe('V050623-9');
    expect(await period('VT-{seq:4}', at, 'Asia/Tehran')).toBe(0);
    expect(await period('V{yymmdd}-{seq}', at, 'Asia/Tehran')).toBe(14050623);
    expect(await period('{yyyy}/{seq}', at, 'Asia/Tehran')).toBe(1405);
  });
  it('is sequential, and a rolled-back transaction leaves no gap', async () => {
    const a = await numberInTrx('proforma');
    expect(a).toBe('VT-0001');
    await numberInTrx('proforma', undefined, true).catch(() => undefined);
    const b = await numberInTrx('proforma');
    expect(b).toBe('VT-0002');
  });
  it('is unique under concurrency', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => numberInTrx('transfer')));
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
    expect(await numberInTrx('wholesale', d1)).toBe('V050623-1');
    expect(await numberInTrx('wholesale', d1)).toBe('V050623-2');
    expect(await numberInTrx('wholesale', d2)).toBe('V050624-1');
  });
});
