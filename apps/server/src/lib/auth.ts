import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { effectivePermissions, type Permission, type Role } from '@vitral/shared';
import type { Db } from '../db/index.js';
import { AppError } from './errors.js';

export const SESSION_COOKIE = 'vt_session';

export interface AuthUser {
  id: string;
  sessionId: string;
  name: string;
  role: Role;
  permissions: Permission[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export function hashToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function can(user: AuthUser | null, permission: Permission): boolean {
  return !!user && user.permissions.includes(permission);
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new AppError('unauthorized');
  return req.user;
}

export function requirePermission(req: FastifyRequest, permission: Permission): AuthUser {
  const user = requireUser(req);
  if (!can(user, permission)) throw new AppError('forbidden');
  return user;
}

/** Resolve the session cookie to an active user. Deactivated users and expired sessions resolve to null. */
export async function loadSessionUser(db: Db, secret: string, token: string | undefined): Promise<AuthUser | null> {
  if (!token || token.length > 200) return null;
  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'sessions.id as session_id',
      'sessions.last_seen_at',
      'users.id as user_id',
      'users.name',
      'users.role',
      'users.permissions',
      'users.active',
    ])
    .where('sessions.token_hash', '=', hashToken(secret, token))
    .where('sessions.expires_at', '>', new Date())
    .executeTakeFirst();
  if (!row || !row.active) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    await db.updateTable('sessions').set({ last_seen_at: new Date() }).where('id', '=', row.session_id).execute();
  }
  return {
    id: row.user_id,
    sessionId: row.session_id,
    name: row.name,
    role: row.role,
    permissions: effectivePermissions(row.role, row.permissions),
  };
}

export function setSessionCookie(reply: FastifyReply, token: string, expires: Date, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
}
