import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import argon2 from 'argon2';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db/index.js';
import { migrateToLatest } from '../src/db/migrator.js';
import { DiskStorage } from '../src/lib/storage.js';
import { buildApp } from '../src/app.js';
import { ARGON2_OPTIONS } from '../src/modules/users/service.js';

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  filesDir: string;
  close(): Promise<void>;
  /** Create a user directly in the database. */
  createUser(opts: { mobile: string; password: string; role: 'manager' | 'staff'; permissions?: string[]; name?: string }): Promise<string>;
  login(mobile: string, password: string): Promise<string>;
  /** Inject with session cookie, CSRF header and JSON body. */
  call(cookie: string | null, opts: InjectOptions & { idempotency?: string }): Promise<LightMyRequestResponse>;
}

/** Optional environment overrides (e.g. `BOT_SERVICE_KEY`); every key is a raw env string as `loadConfig` expects. */
export type TestEnvOverrides = Partial<Record<string, string>>;

export async function setupTestApp(overrides: TestEnvOverrides = {}): Promise<TestApp> {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://vitral:vitral@localhost:5432/vitral_test';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vitral-files-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_ENV: 'test',
    DATABASE_URL: url,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-test-secret',
    FILE_STORAGE_DIR: dir,
    BACKUP_DIR: dir,
    COOKIE_SECURE: 'false',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
    ...overrides,
  });
  const db = createDb(url);
  await sql`DROP SCHEMA public CASCADE`.execute(db);
  await sql`CREATE SCHEMA public`.execute(db);
  await migrateToLatest(db);
  const app = await buildApp({ config, db, storage: new DiskStorage(dir) });
  await app.ready();

  const call: TestApp['call'] = (cookie, { idempotency, ...opts }) => {
    const headers: Record<string, string> = { 'x-requested-with': 'vitral', ...((opts.headers as Record<string, string>) ?? {}) };
    if (cookie) headers.cookie = cookie;
    if (idempotency) headers['idempotency-key'] = idempotency;
    return app.inject({ ...opts, headers });
  };

  return {
    app,
    db,
    filesDir: dir,
    call,
    async close() {
      await app.close();
      await db.destroy();
    },
    async createUser({ mobile, password, role, permissions = [], name = 'کاربر آزمایشی' }) {
      const row = await db
        .insertInto('users')
        .values({ mobile, name, password_hash: await argon2.hash(password, ARGON2_OPTIONS), role, permissions })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },
    async login(mobile, password) {
      const res = await call(null, { method: 'POST', url: '/api/v1/auth/login', payload: { mobile, password } });
      if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
      const set = res.headers['set-cookie'];
      const raw = Array.isArray(set) ? set[0] : set;
      return (raw ?? '').split(';')[0] ?? '';
    },
  };
}

export const uuid = (): string => randomUUID();
