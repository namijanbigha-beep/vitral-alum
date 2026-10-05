import type { FastifyInstance, FastifyRequest } from 'fastify';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { sql, type Kysely, type SelectQueryBuilder, type SqlBool } from 'kysely';
import { z, type ZodTypeAny } from 'zod';
import type { Permission } from '@vitral/shared';
import type { AppContext } from '../context.js';
import type { Database } from '../db/schema.js';
import { audit } from './audit.js';
import { requirePermission, requireUser, type AuthUser } from './auth.js';
import { AppError } from './errors.js';
import { requireIdempotencyKey, withIdempotency } from './idempotency.js';
import { decodeCursor, encodeCursor, listQuery } from './pagination.js';
import type { Db, Trx } from '../db/index.js';

export const idParam = z.object({ id: z.string().uuid() });

type Table = keyof Database & string;
type AnyQB = SelectQueryBuilder<any, any, any>;

export interface CrudOptions<T extends Table> {
  table: T;
  path: string;
  entity?: string;
  createSchema: ZodTypeAny;
  updateSchema: ZodTypeAny;
  listSchema?: ZodTypeAny;
  readPermission?: Permission;
  writePermission?: Permission;
  present: (row: Record<string, unknown>, user: AuthUser) => unknown;
  /** Add filters/search to the list query. */
  filter?: (qb: AnyQB, query: Record<string, unknown>, user: AuthUser) => AnyQB;
  /** Transform validated input before insert (may compute numbers, defaults, FK checks). */
  beforeCreate?: (trx: Trx, input: Record<string, unknown>, user: AuthUser) => Promise<Record<string, unknown>>;
  beforeUpdate?: (trx: Trx, before: Record<string, unknown>, patch: Record<string, unknown>, user: AuthUser) => Promise<Record<string, unknown>>;
  afterCreate?: (trx: Trx, row: Record<string, unknown>, input: Record<string, unknown>, user: AuthUser) => Promise<void>;
  afterUpdate?: (trx: Trx, before: Record<string, unknown>, after: Record<string, unknown>, user: AuthUser) => Promise<void>;
  /** Column used for default ordering (default created_at). */
  orderBy?: string;
  /** Posted writes require Idempotency-Key (true for every definitive record). */
  idempotent?: boolean;
  /** Load one row with joins for GET /:id (default: selectAll from table). */
  loadOne?: (trx: Trx | Db, id: string, user: AuthUser) => Promise<Record<string, unknown> | undefined>;
}

export function userCan(req: FastifyRequest, p: Permission | undefined): AuthUser {
  return p ? requirePermission(req, p) : requireUser(req);
}

/** Standard list / get / create / patch routes with cursor pagination, version check, audit and idempotency. */
export function crudRoutes<T extends Table>(app: FastifyInstance, ctx: AppContext, o: CrudOptions<T>): void {
  const db = ctx.db as unknown as Kysely<any>;
  const entity = o.entity ?? o.table;
  const orderCol = o.orderBy ?? 'created_at';

  app.get(o.path, async (req) => {
    const user = userCan(req, o.readPermission);
    const base = o.listSchema ? listQuery.merge(o.listSchema as z.AnyZodObject) : listQuery;
    const q = base.passthrough().parse(req.query) as Record<string, unknown> & { limit: number; cursor?: string };
    let qb: AnyQB = (db.selectFrom(o.table as string) as AnyQB).selectAll(o.table as string).limit(q.limit + 1);
    if (o.filter) qb = o.filter(qb, q, user);
    const desc = q.order === 'desc';
    qb = qb.orderBy(`${o.table}.${orderCol}`, desc ? 'desc' : 'asc').orderBy(`${o.table}.id`, desc ? 'desc' : 'asc');
    const cursor = decodeCursor(q.cursor);
    if (cursor) {
      const cmp = desc ? '<' : '>';
      qb = qb.where(sql<SqlBool>`(${sql.ref(`${o.table}.${orderCol}`)}, ${sql.ref(`${o.table}.id`)}) ${sql.raw(cmp)} (${cursor.str ? cursor.at : new Date(cursor.at)}, ${cursor.id}::uuid)`);
    }
    const rows = (await qb.execute()) as Record<string, unknown>[];
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => o.present(r, user)),
      next_cursor: rows.length > q.limit && last ? encodeCursor(last[orderCol] as Date, last.id as string) : null,
    };
  });

  app.get(`${o.path}/:id`, async (req) => {
    const user = userCan(req, o.readPermission);
    const { id } = idParam.parse(req.params);
    const row = o.loadOne
      ? await o.loadOne(ctx.db, id, user)
      : ((await db.selectFrom(o.table).selectAll().where(sql.ref(`${o.table}.id`), '=', id).executeTakeFirst()) as Record<string, unknown> | undefined);
    if (!row) throw new AppError('not_found');
    return o.present(row, user);
  });

  app.post(o.path, async (req, reply) => {
    const user = userCan(req, o.writePermission);
    const input = o.createSchema.parse(req.body) as Record<string, unknown>;
    const work = async (trxIn: Trx) => {
      const trx = trxIn as unknown as Kysely<any>;
      const values = o.beforeCreate ? await o.beforeCreate(trxIn, input, user) : input;
      const row = (await trx
        .insertInto(o.table)
        .values({ ...values, created_by: user.id } as never)
        .returningAll()
        .executeTakeFirstOrThrow()) as Record<string, unknown>;
      if (o.afterCreate) await o.afterCreate(trxIn, row, input, user);
      await audit(trxIn, { userId: user.id, entity, entityId: row.id as string, action: 'create', after: row });
      const full = o.loadOne ? ((await o.loadOne(trxIn, row.id as string, user)) ?? row) : row;
      return { status: 201, body: o.present(full, user) };
    };
    if (o.idempotent) {
      const key = requireIdempotencyKey(req);
      const r = await withIdempotency(ctx.db, key, user.id, `POST ${o.path}`, work);
      return reply.status(r.status).send(r.body);
    }
    const r = await ctx.db.transaction().execute(work);
    return reply.status(r.status).send(r.body);
  });

  app.patch(`${o.path}/:id`, async (req) => {
    const user = userCan(req, o.writePermission);
    const { id } = idParam.parse(req.params);
    const body = o.updateSchema.parse(req.body) as Record<string, unknown> & { version: number; reason?: string };
    const { version, reason, ...rest } = body;
    return ctx.db.transaction().execute(async (trxIn) => {
      const trx = trxIn as unknown as Kysely<any>;
      const before = (await trx.selectFrom(o.table).selectAll().where(sql.ref(`${o.table}.id`), '=', id).forUpdate().executeTakeFirst()) as
        | Record<string, unknown>
        | undefined;
      if (!before) throw new AppError('not_found');
      if (before.version !== version) throw new AppError('conflict', undefined, undefined, o.present(before, user));
      const patch = o.beforeUpdate ? await o.beforeUpdate(trxIn, before, rest, user) : rest;
      const after = (await (trx.updateTable(o.table as string) as any)
        .set({ ...patch, updated_at: new Date(), version: sql`version + 1` })
        .where(sql.ref(`${o.table}.id`), '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()) as Record<string, unknown>;
      if (o.afterUpdate) await o.afterUpdate(trxIn, before, after, user);
      await audit(trxIn, { userId: user.id, entity, entityId: id, action: 'update', before, after, reason: reason ?? null });
      const full = o.loadOne ? ((await o.loadOne(trxIn, id, user)) ?? after) : after;
      return o.present(full, user);
    });
  });
}

/** Escape for ILIKE. */
export const like = (s: string): string => `%${s.replace(/[%_\\]/g, '\\$&')}%`;

export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاریخ باید YYYY-MM-DD باشد');
export const isoDate = z.string().datetime({ offset: true });
export const uuid = z.string().uuid();
/** Query-string boolean: 'true'/'1' → true, 'false'/'0' → false. (z.coerce.boolean() would turn 'false' into true.) */
export const boolQuery = z.preprocess((v) => (typeof v === 'string' ? (['true', '1'].includes(v.toLowerCase()) ? true : ['false', '0', ''].includes(v.toLowerCase()) ? false : v) : v), z.boolean());
export const text = (max = 500) => z.string().trim().max(max);
export const optText = (max = 500) => z.string().trim().max(max).nullable().optional();
export const versionField = { version: z.number().int().nonnegative(), reason: z.string().trim().max(500).optional() };
