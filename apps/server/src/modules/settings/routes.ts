import type { FastifyInstance } from 'fastify';
import { settingUpdateSchema } from '@vitral/shared';
import { z } from 'zod';
import { sql } from 'kysely';
import type { AppContext } from '../../context.js';
import { audit } from '../../lib/audit.js';
import { can, requirePermission, requireUser, type AuthUser } from '../../lib/auth.js';
import { AppError } from '../../lib/errors.js';
import type { SettingRow } from '../../db/schema.js';
import { SETTINGS_CATALOG } from './catalog.js';

function present(row: SettingRow) {
  const def = SETTINGS_CATALOG[row.key];
  return {
    key: row.key,
    label: def?.label ?? row.key,
    value: row.value,
    readonly: def?.readonly ?? false,
    updated_at: row.updated_at,
    version: row.version,
  };
}

function visible(user: AuthUser, key: string): boolean {
  const def = SETTINGS_CATALOG[key];
  if (!def) return false;
  return !def.finance || can(user, 'finance.view');
}

export async function settingsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx;

  // Every signed-in user reads the settings the forms need; confidential ones only with finance.view.
  app.get('/settings', async (req) => {
    const me = requireUser(req);
    const rows = await db.selectFrom('settings').selectAll().orderBy('key').execute();
    return { items: rows.filter((r) => visible(me, r.key)).map(present) };
  });

  app.put('/settings/:key', async (req) => {
    const me = requirePermission(req, 'settings.manage');
    const { key } = z.object({ key: z.string().max(80) }).parse(req.params);
    const def = SETTINGS_CATALOG[key];
    if (!def || def.readonly) throw new AppError('not_found');
    if (def.finance && !can(me, 'finance.view')) throw new AppError('forbidden');
    const body = settingUpdateSchema.parse(req.body);
    const parsed = def.schema.safeParse(body.value);
    if (!parsed.success) {
      throw new AppError('validation', parsed.error.issues[0]?.message ?? 'مقدار نامعتبر است', {
        value: parsed.error.issues[0]?.message ?? 'نامعتبر',
      });
    }
    return db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('settings').selectAll().where('key', '=', key).forUpdate().executeTakeFirst();
      if (!before) throw new AppError('not_found');
      if (before.version !== body.version) throw new AppError('conflict', undefined, undefined, present(before));
      const after = await trx
        .updateTable('settings')
        .set({ value: JSON.stringify(parsed.data ?? null), updated_at: new Date(), version: sql<number>`version + 1` })
        .where('key', '=', key)
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, {
        userId: me.id,
        entity: 'settings',
        entityId: after.id,
        action: 'update',
        before: { key, value: before.value },
        after: { key, value: after.value },
        reason: body.reason ?? null,
      });
      return present(after);
    });
  });
}
