import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { userCreateSchema, userResetPasswordSchema, userUpdateSchema } from '@vitral/shared';
import { z } from 'zod';
import { sql } from 'kysely';
import type { AppContext } from '../../context.js';
import { audit } from '../../lib/audit.js';
import { requirePermission } from '../../lib/auth.js';
import { AppError } from '../../lib/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../lib/idempotency.js';
import { decodeCursor, encodeCursor, listQuery } from '../../lib/pagination.js';
import { lockForUpdate } from '../../lib/versioning.js';
import type { User } from '../../db/schema.js';
import { ARGON2_OPTIONS, presentUser } from './service.js';

const idParam = z.object({ id: z.string().uuid() });

export async function userRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  app.get('/users', async (req) => {
    requirePermission(req, 'settings.manage');
    const q = listQuery.extend({ active: z.enum(['true', 'false']).optional(), q: z.string().max(100).optional() }).parse(req.query);
    let query = db.selectFrom('users').selectAll().orderBy('created_at').orderBy('id').limit(q.limit + 1);
    if (q.active) query = query.where('active', '=', q.active === 'true');
    if (q.q) {
      const like = `%${q.q.replace(/[%_\\]/g, '\\$&')}%`;
      query = query.where((eb) => eb.or([eb('name', 'ilike', like), eb('mobile', 'like', like)]));
    }
    const cursor = decodeCursor(q.cursor);
    if (cursor) {
      query = query.where((eb) =>
        eb.or([
          eb('created_at', '>', new Date(cursor.at)),
          eb.and([eb('created_at', '=', new Date(cursor.at)), eb('id', '>', cursor.id)]),
        ]),
      );
    }
    const rows = await query.execute();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(presentUser),
      next_cursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  });

  app.get('/users/:id', async (req) => {
    requirePermission(req, 'settings.manage');
    const { id } = idParam.parse(req.params);
    const row = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new AppError('not_found');
    return presentUser(row);
  });

  app.post('/users', async (req, reply) => {
    const me = requirePermission(req, 'settings.manage');
    const key = requireIdempotencyKey(req);
    const body = userCreateSchema.parse(req.body);
    const hash = await argon2.hash(body.password, ARGON2_OPTIONS);
    const result = await withIdempotency(db, key, me.id, 'POST /users', async (trx) => {
      const exists = await trx.selectFrom('users').select('id').where('mobile', '=', body.mobile).executeTakeFirst();
      if (exists) throw new AppError('validation', 'این شماره موبایل قبلاً ثبت شده است', { mobile: 'تکراری' });
      const row = await trx
        .insertInto('users')
        .values({
          mobile: body.mobile,
          name: body.name,
          short_name: body.short_name ?? null,
          password_hash: hash,
          role: body.role,
          permissions: body.role === 'manager' ? [] : body.permissions,
          created_by: me.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, { userId: me.id, entity: 'users', entityId: row.id, action: 'create', after: presentUser(row) });
      return { status: 201, body: presentUser(row) };
    });
    return reply.status(result.status).send(result.body);
  });

  app.patch('/users/:id', async (req) => {
    const me = requirePermission(req, 'settings.manage');
    const { id } = idParam.parse(req.params);
    const body = userUpdateSchema.parse(req.body);
    if (id === me.id && (body.active === false || (body.role && body.role !== 'manager'))) {
      throw new AppError('validation', 'نمی‌توانید حساب یا نقش مدیریتی خودتان را غیرفعال کنید');
    }
    return db.transaction().execute(async (trx) => {
      const before = (await lockForUpdate(trx, 'users', id, body.version, presentUser)) as unknown as User;
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.short_name !== undefined) patch.short_name = body.short_name;
      if (body.role !== undefined) patch.role = body.role;
      if (body.permissions !== undefined) patch.permissions = body.permissions;
      if (body.active !== undefined) patch.active = body.active;
      if (body.active === true) {
        patch.failed_logins = 0;
        patch.locked_until = null;
      }
      const after = await trx
        .updateTable('users')
        .set({ ...patch, updated_at: new Date(), version: sql<number>`version + 1` })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      // Section 6: deactivation (or any change of role/permissions) ends the user's sessions at once.
      if (body.active === false || body.role !== undefined || body.permissions !== undefined) {
        await trx.deleteFrom('sessions').where('user_id', '=', id).execute();
      }
      const action = body.active === false ? 'deactivate' : body.active === true && !before.active ? 'activate' : 'update';
      await audit(trx, {
        userId: me.id,
        entity: 'users',
        entityId: id,
        action,
        before: presentUser(before),
        after: presentUser(after),
        reason: body.reason ?? null,
      });
      return presentUser(after);
    });
  });

  app.post('/users/:id/reset-password', async (req) => {
    const me = requirePermission(req, 'settings.manage');
    const { id } = idParam.parse(req.params);
    const body = userResetPasswordSchema.parse(req.body);
    const hash = await argon2.hash(body.new_password, ARGON2_OPTIONS);
    return db.transaction().execute(async (trx) => {
      await lockForUpdate(trx, 'users', id, body.version, presentUser);
      const after = await trx
        .updateTable('users')
        .set({ password_hash: hash, failed_logins: 0, locked_until: null, updated_at: new Date(), version: sql<number>`version + 1` })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx.deleteFrom('sessions').where('user_id', '=', id).execute();
      await audit(trx, { userId: me.id, entity: 'users', entityId: id, action: 'password_reset' });
      return presentUser(after);
    });
  });
}
