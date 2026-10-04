import argon2 from 'argon2';
import { effectivePermissions } from '@vitral/shared';
import type { User } from '../../db/schema.js';

export const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** The single public view of a user. Never includes password_hash or the Telegram chat id. */
export function presentUser(u: User | Record<string, unknown>): Record<string, unknown> {
  const user = u as User;
  return {
    id: user.id,
    mobile: user.mobile,
    name: user.name,
    short_name: user.short_name,
    role: user.role,
    permissions: user.permissions,
    effective_permissions: effectivePermissions(user.role, user.permissions),
    active: user.active,
    locked_until: user.locked_until,
    telegram_linked: user.telegram_chat_id !== null,
    created_at: user.created_at,
    updated_at: user.updated_at,
    version: user.version,
  };
}
