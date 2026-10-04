import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'kysely';
import type { AppContext } from '../../context.js';
import { audit } from '../../lib/audit.js';
import { requirePermission } from '../../lib/auth.js';
import { AppError } from '../../lib/errors.js';

const restoreLogSchema = z.object({
  tested_at: z.string().datetime(),
  duration_minutes: z.number().int().min(0).max(100_000),
  result: z.enum(['ok', 'failed']),
  note: z.string().trim().max(1000).optional(),
});

/**
 * Backups themselves run from ops/backup.sh (cron in the backup container).
 * The app lists what exists and keeps the monthly restore-test log (section 17).
 */
export async function backupRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, config } = ctx;

  app.get('/backup', async (req) => {
    requirePermission(req, 'settings.manage');
    let entries: Array<{ name: string; size: string; modified_at: string }> = [];
    try {
      const names = (await readdir(config.BACKUP_DIR)).filter((n) => /^vitral-.*\.(tar|enc|age|gpg)$/.test(n));
      entries = await Promise.all(
        names.map(async (name) => {
          const s = await stat(path.join(config.BACKUP_DIR, name));
          return { name, size: String(s.size), modified_at: s.mtime.toISOString() };
        }),
      );
      entries.sort((a, b) => (a.modified_at < b.modified_at ? 1 : -1));
    } catch {
      entries = [];
    }
    const log = await db.selectFrom('settings').select(['value', 'version']).where('key', '=', 'restore_test_log').executeTakeFirst();
    return {
      backups: entries,
      backup_dir_available: entries.length > 0 || (await stat(config.BACKUP_DIR).then(() => true).catch(() => false)),
      restore_tests: log?.value ?? [],
      encryption_configured: Boolean(config.BACKUP_ENCRYPTION_KEY),
    };
  });

  app.post('/backup/restore-test', async (req, reply) => {
    const me = requirePermission(req, 'settings.manage');
    const body = restoreLogSchema.parse(req.body);
    const entry = { ...body, by: me.id, recorded_at: new Date().toISOString() };
    await db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom('settings').selectAll().where('key', '=', 'restore_test_log').forUpdate().executeTakeFirst();
      if (!row) throw new AppError('not_found');
      const list = Array.isArray(row.value) ? (row.value as unknown[]) : [];
      await trx
        .updateTable('settings')
        .set({ value: JSON.stringify([entry, ...list].slice(0, 60)), updated_at: new Date(), version: sql<number>`version + 1` })
        .where('key', '=', 'restore_test_log')
        .execute();
      await audit(trx, { userId: me.id, entity: 'settings', entityId: row.id, action: 'restore_test_logged', after: entry });
    });
    return reply.status(201).send(entry);
  });
}
