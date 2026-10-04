import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { changePasswordSchema, loginSchema, PERMISSION_LABELS } from '@vitral/shared';
import { sql } from 'kysely';
import type { AppContext } from '../../context.js';
import { audit } from '../../lib/audit.js';
import {
  clearSessionCookie,
  hashToken,
  newToken,
  requireUser,
  SESSION_COOKIE,
  setSessionCookie,
} from '../../lib/auth.js';
import { AppError } from '../../lib/errors.js';
import { ARGON2_OPTIONS } from '../users/service.js';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Used to spend the same time on unknown mobiles as on wrong passwords.
let dummyHash: string | null = null;

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, config } = ctx;

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = loginSchema.parse(req.body);
      const user = await db.selectFrom('users').selectAll().where('mobile', '=', body.mobile).executeTakeFirst();
      const invalid = new AppError('unauthorized', 'شماره موبایل یا رمز درست نیست');

      if (!user || !user.active) {
        dummyHash ??= await argon2.hash('not-a-real-password', ARGON2_OPTIONS);
        await argon2.verify(dummyHash, body.password);
        throw invalid;
      }
      if (user.locked_until && user.locked_until > new Date()) {
        throw new AppError('locked', `حساب پس از ${MAX_FAILED} تلاش ناموفق موقتاً قفل است؛ ${LOCK_MINUTES} دقیقه بعد تلاش کنید`);
      }

      const ok = await argon2.verify(user.password_hash, body.password);
      if (!ok) {
        const failed = user.failed_logins + 1;
        const lock = failed >= MAX_FAILED;
        await db.transaction().execute(async (trx) => {
          await trx
            .updateTable('users')
            .set({
              failed_logins: lock ? 0 : failed,
              locked_until: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.locked_until,
            })
            .where('id', '=', user.id)
            .execute();
          if (lock) {
            await audit(trx, { userId: null, entity: 'users', entityId: user.id, action: 'locked', reason: 'failed logins' });
          }
        });
        if (lock) throw new AppError('locked', `حساب پس از ${MAX_FAILED} تلاش ناموفق برای ${LOCK_MINUTES} دقیقه قفل شد`);
        throw invalid;
      }

      const token = newToken();
      const expires = new Date(Date.now() + config.SESSION_TTL_DAYS * 86_400_000);
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('users')
          .set({ failed_logins: 0, locked_until: null })
          .where('id', '=', user.id)
          .execute();
        await trx
          .insertInto('sessions')
          .values({
            user_id: user.id,
            created_by: user.id,
            token_hash: hashToken(config.SESSION_SECRET, token),
            expires_at: expires,
            user_agent: (req.headers['user-agent'] ?? '').slice(0, 300) || null,
          })
          .execute();
        // Housekeeping: drop this user's expired sessions.
        await trx.deleteFrom('sessions').where('user_id', '=', user.id).where('expires_at', '<', sql<Date>`now()`).execute();
      });
      setSessionCookie(reply, token, expires, config.COOKIE_SECURE);
      return { ok: true };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await db.deleteFrom('sessions').where('token_hash', '=', hashToken(config.SESSION_SECRET, token)).execute();
    clearSessionCookie(reply, config.COOKIE_SECURE);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const me = requireUser(req);
    const row = await db
      .selectFrom('users')
      .select(['id', 'mobile', 'name', 'short_name', 'role', 'version'])
      .where('id', '=', me.id)
      .executeTakeFirstOrThrow();
    return {
      user: { ...row, permissions: me.permissions },
      permission_labels: PERMISSION_LABELS,
      app_env: config.APP_ENV,
    };
  });

  app.post('/auth/change-password', async (req, reply) => {
    const me = requireUser(req);
    const body = changePasswordSchema.parse(req.body);
    const user = await db.selectFrom('users').selectAll().where('id', '=', me.id).executeTakeFirstOrThrow();
    if (!(await argon2.verify(user.password_hash, body.current_password))) {
      throw new AppError('validation', 'رمز فعلی درست نیست', { current_password: 'رمز فعلی درست نیست' });
    }
    const hash = await argon2.hash(body.new_password, ARGON2_OPTIONS);
    const token = newToken();
    const expires = new Date(Date.now() + config.SESSION_TTL_DAYS * 86_400_000);
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({ password_hash: hash, updated_at: new Date(), version: sql<number>`version + 1` })
        .where('id', '=', me.id)
        .execute();
      // Every other session ends; this device gets a fresh one.
      await trx.deleteFrom('sessions').where('user_id', '=', me.id).execute();
      await trx
        .insertInto('sessions')
        .values({
          user_id: me.id,
          created_by: me.id,
          token_hash: hashToken(config.SESSION_SECRET, token),
          expires_at: expires,
          user_agent: (req.headers['user-agent'] ?? '').slice(0, 300) || null,
        })
        .execute();
      await audit(trx, { userId: me.id, entity: 'users', entityId: me.id, action: 'password_changed' });
    });
    setSessionCookie(reply, token, expires, config.COOKIE_SECURE);
    return { ok: true };
  });
}
