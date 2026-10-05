import type { Trx, Db } from '../db/index.js';

/** In-app notification; duplicates with the same open group_key collapse (one row per user/group). */
export async function notify(
  trx: Trx | Db,
  n: { userId: string; kind: string; title: string; entity?: string; entityId?: string; groupKey?: string },
): Promise<void> {
  await trx
    .insertInto('notifications')
    .values({ user_id: n.userId, kind: n.kind, title: n.title, entity: n.entity ?? null, entity_id: n.entityId ?? null, group_key: n.groupKey ?? null })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function notifyManagers(trx: Trx | Db, n: Omit<Parameters<typeof notify>[1], 'userId'>): Promise<void> {
  const managers = await trx.selectFrom('users').select('id').where('role', '=', 'manager').where('active', '=', true).execute();
  for (const m of managers) await notify(trx, { ...n, userId: m.id });
}
