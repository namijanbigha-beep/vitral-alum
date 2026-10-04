import type { Trx, Db } from '../db/index.js';

const NEVER_LOGGED = new Set(['password_hash', 'token_hash', 'password', 'new_password', 'current_password']);

function clean(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clean);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!NEVER_LOGGED.has(k)) out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

export interface AuditEntry {
  userId: string | null;
  entity: string;
  entityId: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Principle 7: append-only change history, written inside the caller's transaction. */
export async function audit(trx: Trx | Db, e: AuditEntry): Promise<void> {
  await trx
    .insertInto('audit_log')
    .values({
      user_id: e.userId,
      created_by: e.userId,
      entity: e.entity,
      entity_id: e.entityId,
      action: e.action,
      before: e.before === undefined ? null : JSON.stringify(clean(e.before)),
      after: e.after === undefined ? null : JSON.stringify(clean(e.after)),
      reason: e.reason ?? null,
    })
    .execute();
}
