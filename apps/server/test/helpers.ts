import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import {
  ColumnNode,
  InsertQueryNode,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PrimitiveValueListNode,
  sql,
  ValueListNode,
  ValueNode,
  ValuesNode,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type KyselyPlugin,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from 'kysely';
import type { Database } from '../src/db/schema.js';
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
  if (process.env.VITRAL_TARGET === 'php') return setupPhpTestApp(overrides);
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

// ---------------------------------------------------------------------------------------------------------------
// PHP target (VITRAL_TARGET=php, `pnpm --filter @vitral/server test:php`): the same tests run against apps/php.
// Per test file: the MySQL test database is reset (apps/php/bin/reset-test-db.php), `php -S` serves
// apps/php/public/router-dev.php on a free port, and
//   - app.inject / call     → real HTTP, answered as a LightMyRequest-like response (statusCode, headers, body, json(), rawPayload);
//   - app.routeList         → read once from the test bridge;
//   - createUser            → test bridge (hashing done by PHP);
//   - db                    → a Kysely instance (MySQL dialect) whose driver sends each query to the test bridge.
//                            Transactions are refused (every query is its own HTTP request); inserts get a PHP-style uuid id.
// Database: env TEST_PHP_DB_HOST / _PORT / _NAME / _USER / _PASS (default vitral:vitral@127.0.0.1:3306/vitral_php_test).
// ---------------------------------------------------------------------------------------------------------------

const PHP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../php');

interface PhpHttpResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  rawPayload: Buffer;
  body: string;
  payload: string;
  json(): any;
}

function phpRequest(port: number, opts: { method: string; url: string; headers?: Record<string, string>; body?: Buffer }): Promise<PhpHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: opts.method, path: opts.url, headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const rawPayload = Buffer.concat(chunks);
          const body = rawPayload.toString('utf8');
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, rawPayload, body, payload: body, json: () => JSON.parse(body) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Kysely driver over POST /__test/sql. */
class PhpBridgeDriver implements Driver {
  constructor(private readonly bridge: (route: string, body?: unknown) => Promise<any>) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    const bridge = this.bridge;
    return {
      async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
        const params = compiled.parameters.map((v) => {
          if (v instanceof Date) return v.toISOString().replace('T', ' ').replace('Z', '');
          if (typeof v === 'bigint') return v.toString();
          if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
          return v;
        });
        const out = await bridge('/__test/sql', { sql: compiled.sql, params });
        const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
        const rows = (out.rows as Record<string, unknown>[]).map((row) => {
          for (const k of Object.keys(row)) if (typeof row[k] === 'string' && iso.test(row[k] as string)) row[k] = new Date(row[k] as string);
          return row;
        });
        const isRead = /^\s*(select|with|show|explain)\b/i.test(compiled.sql);
        return {
          rows: rows as R[],
          ...(isRead ? {} : { numAffectedRows: BigInt(out.numAffectedRows), insertId: out.insertId && out.insertId !== '0' ? BigInt(out.insertId) : undefined }),
        };
      },
      // eslint-disable-next-line require-yield
      async *streamQuery() {
        throw new Error('PHP target: streaming queries are not supported through the test bridge');
      },
    };
  }
  async beginTransaction(): Promise<void> {
    throw new Error('PHP target: t.db transactions are not supported (each query is a separate HTTP request to the PHP test bridge)');
  }
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

/** MySQL has no uuid / JSON column defaults: give every insert an `id` and the INSERT_DEFAULTS of apps/php Db.php. */
class PhpInsertDefaultsPlugin implements KyselyPlugin {
  constructor(private readonly defaults: Record<string, Record<string, string>>) {}
  transformQuery({ node }: { node: RootOperationNode }): RootOperationNode {
    if (!InsertQueryNode.is(node) || !node.columns || !node.values || !ValuesNode.is(node.values)) return node;
    const table = node.into?.table.identifier.name ?? '';
    const have = new Set(node.columns.map((c) => c.column.name));
    const extra: Array<[string, () => unknown]> = [];
    if (!have.has('id')) extra.push(['id', () => randomUUID()]);
    for (const [col, def] of Object.entries(this.defaults[table] ?? {})) {
      if (!have.has(col)) extra.push([col, () => (def === '@today' ? new Date().toISOString().slice(0, 10) : def)]);
    }
    if (extra.length === 0) return node;
    const values = node.values.values.map((list) => {
      const added = extra.map(([, make]) => make());
      if (PrimitiveValueListNode.is(list)) return PrimitiveValueListNode.create([...list.values, ...added]);
      if (ValueListNode.is(list)) return ValueListNode.create([...list.values, ...added.map((v) => ValueNode.create(v))]);
      return list;
    });
    return {
      ...node,
      columns: [...node.columns, ...extra.map(([c]) => ColumnNode.create(c))],
      values: ValuesNode.create(values),
    } as RootOperationNode;
  }
  async transformResult(args: { result: QueryResult<UnknownRow> }): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}

async function setupPhpTestApp(overrides: TestEnvOverrides): Promise<TestApp> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vitral-php-files-'));
  const bridgeKey = randomBytes(24).toString('hex');
  const dbEnv = {
    DB_HOST: process.env.TEST_PHP_DB_HOST ?? '127.0.0.1',
    DB_PORT: process.env.TEST_PHP_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_PHP_DB_NAME ?? 'vitral_php_test',
    DB_USER: process.env.TEST_PHP_DB_USER ?? 'vitral',
    DB_PASS: process.env.TEST_PHP_DB_PASS ?? 'vitral',
  };
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...dbEnv,
    VITRAL_CONFIG_FROM_ENV: '1',
    VITRAL_TEST_BRIDGE_KEY: bridgeKey,
    PHP_CLI_SERVER_WORKERS: process.env.TEST_PHP_WORKERS ?? '8',
    APP_ENV: 'test',
    SESSION_SECRET: 'test-secret-test-secret-test-secret-test-secret',
    FILE_STORAGE_DIR: dir,
    BACKUP_DIR: dir,
    LOG_DIR: path.join(dir, 'logs'),
    COOKIE_SECURE: 'false',
    LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
    ...(Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) as Record<string, string>),
  };
  const php = process.env.PHP_BIN ?? 'php';
  execFileSync(php, [path.join(PHP_DIR, 'bin/reset-test-db.php')], { env, stdio: ['ignore', 'ignore', 'inherit'] });

  const port = await freePort();
  const server: ChildProcess = spawn(
    php,
    ['-d', 'upload_max_filesize=25M', '-d', 'post_max_size=26M', '-d', 'memory_limit=512M', '-d', 'display_errors=stderr', '-S', `127.0.0.1:${port}`, path.join(PHP_DIR, 'public/router-dev.php')],
    { env, cwd: path.join(PHP_DIR, 'public'), stdio: ['ignore', 'ignore', process.env.TEST_PHP_SERVER_LOG ? 'inherit' : 'ignore'], detached: true },
  );
  const stop = () => {
    try {
      if (server.pid) process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  };
  process.once('exit', stop);

  const bridge = async (route: string, body?: unknown): Promise<any> => {
    const res = await phpRequest(port, {
      method: body === undefined ? 'GET' : 'POST',
      url: route,
      headers: { 'x-test-bridge-key': bridgeKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
    });
    if (res.statusCode !== 200) {
      const err = (() => { try { return res.json(); } catch { return { error: res.body }; } })();
      throw new Error(`PHP bridge ${route}: ${err.error ?? res.body}`);
    }
    return res.json();
  };

  // wait until the server answers
  const started = Date.now();
  for (;;) {
    try {
      await bridge('/__test/insert-defaults');
      break;
    } catch (e) {
      if (server.exitCode !== null) throw new Error(`php -S exited with code ${server.exitCode}`);
      if (Date.now() - started > 15_000) throw new Error(`php -S did not start on port ${port}: ${String(e)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const insertDefaults = (await bridge('/__test/insert-defaults')) as Record<string, Record<string, string>>;
  const routeList = (await bridge('/__test/routes')) as Array<{ method: string; url: string }>;

  const inject = async (o: InjectOptions | string): Promise<LightMyRequestResponse> => {
    const opts: InjectOptions = typeof o === 'string' ? { url: o } : o;
    const headers: Record<string, string> = { host: 'localhost:80', 'user-agent': 'lightMyRequest' };
    for (const [k, v] of Object.entries((opts.headers as Record<string, unknown>) ?? {})) if (v !== undefined) headers[k.toLowerCase()] = String(v);
    let url = typeof opts.url === 'string' ? opts.url : String((opts.url as { pathname?: string })?.pathname ?? '/');
    if (opts.query) {
      const qs = typeof opts.query === 'string' ? opts.query : new URLSearchParams(opts.query as Record<string, string>).toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    const raw = opts.payload ?? (opts as { body?: unknown }).body;
    let body: Buffer | undefined;
    if (raw !== undefined && raw !== null) {
      if (Buffer.isBuffer(raw)) body = raw;
      else if (typeof raw === 'string') body = Buffer.from(raw);
      else {
        body = Buffer.from(JSON.stringify(raw));
        headers['content-type'] ??= 'application/json';
      }
      headers['content-length'] = String(body.length);
    }
    const res = await phpRequest(port, { method: (opts.method ?? 'GET').toUpperCase(), url, headers, body });
    return res as unknown as LightMyRequestResponse;
  };

  const app = { inject, routeList, close: async () => stop() } as unknown as FastifyInstance;
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => new PhpBridgeDriver(bridge),
      createIntrospector: (k) => new MysqlIntrospector(k),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    } satisfies Dialect,
    plugins: [new PhpInsertDefaultsPlugin(insertDefaults)],
  }) as unknown as Db;

  const call: TestApp['call'] = (cookie, { idempotency, ...opts }) => {
    const headers: Record<string, string> = { 'x-requested-with': 'vitral', ...((opts.headers as Record<string, string>) ?? {}) };
    if (cookie) headers.cookie = cookie;
    if (idempotency) headers['idempotency-key'] = idempotency;
    return inject({ ...opts, headers });
  };

  return {
    app,
    db,
    filesDir: dir,
    call,
    async close() {
      stop();
      process.removeListener('exit', stop);
    },
    async createUser({ mobile, password, role, permissions = [], name = 'کاربر آزمایشی' }) {
      const out = await bridge('/__test/create-user', { mobile, password, role, permissions, name });
      return out.id as string;
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
