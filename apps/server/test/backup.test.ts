import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { setupTestApp, type TestApp, uuid } from './helpers.js';

const OPS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../ops');
const SRC_URL = process.env.TEST_DATABASE_URL ?? 'postgres://vitral:vitral@localhost:5432/vitral_test';
const DST_URL = process.env.TEST_RESTORE_DATABASE_URL ?? 'postgres://vitral:vitral@localhost:5432/vitral_test_restore';

let t: TestApp;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(() => t.close());

const hasTools = (() => {
  try {
    execFileSync('pg_dump', ['--version']);
    execFileSync('openssl', ['version']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTools)('T53 — backup and restore into an empty database', () => {
  it('row counts and file sha256 match', async () => {
    await t.createUser({ mobile: '09120000001', password: 'manager-pass-1', role: 'manager' });
    const m = await t.login('09120000001', 'manager-pass-1');
    for (let i = 0; i < 3; i += 1) {
      const img = await sharp({ create: { width: 200 + i, height: 100, channels: 3, background: '#2a6' } }).jpeg().toBuffer();
      const boundary = `----vt${uuid().replace(/-/g, '')}`;
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nbundle\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b${i}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
        img,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const res = await t.call(m, { method: 'POST', url: '/api/v1/files', payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, idempotency: uuid() });
      expect(res.statusCode).toBe(201);
    }

    const backupDir = await mkdtemp(path.join(os.tmpdir(), 'vt-backup-'));
    const restoreDir = await mkdtemp(path.join(os.tmpdir(), 'vt-restore-'));
    const env = { ...process.env, DATABASE_URL: SRC_URL, FILE_STORAGE_DIR: t.filesDir, BACKUP_DIR: backupDir, BACKUP_ENCRYPTION_KEY: 'test-key' };
    execFileSync(path.join(OPS, 'backup.sh'), ['manual'], { env, stdio: 'pipe' });
    const [file] = await readdir(backupDir);
    expect(file).toMatch(/^vitral-manual-.*\.tar\.enc$/);

    const dst = createDb(DST_URL);
    await sql`DROP SCHEMA public CASCADE`.execute(dst);
    await sql`CREATE SCHEMA public`.execute(dst);
    execFileSync(path.join(OPS, 'restore.sh'), [path.join(backupDir, file!)], { env: { ...env, DATABASE_URL: DST_URL, FILE_STORAGE_DIR: restoreDir }, stdio: 'pipe' });

    for (const table of ['users', 'sessions', 'audit_log', 'settings', 'files', 'idempotency_keys', 'counters'] as const) {
      const a = await t.db.selectFrom(table).select(t.db.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
      const b = await dst.selectFrom(table).select(dst.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
      expect(b.n, table).toBe(a.n);
    }
    const srcFiles = await t.db.selectFrom('files').select(['storage_key', 'sha256']).orderBy('storage_key').execute();
    const dstFiles = await dst.selectFrom('files').select(['storage_key', 'sha256']).orderBy('storage_key').execute();
    expect(dstFiles).toEqual(srcFiles);
    const { createHash } = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    for (const f of dstFiles) {
      const onDisk = createHash('sha256').update(await readFile(path.join(restoreDir, f.storage_key))).digest('hex');
      expect(onDisk).toBe(f.sha256);
    }
    // Restore refuses a non-empty target.
    expect(() => execFileSync(path.join(OPS, 'restore.sh'), [path.join(backupDir, file!)], { env: { ...env, DATABASE_URL: DST_URL, FILE_STORAGE_DIR: restoreDir }, stdio: 'pipe' })).toThrow();
    await dst.destroy();
  });
});
