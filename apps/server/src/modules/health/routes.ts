import { statfs } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { AppContext } from '../../context.js';

export async function diskUsagePercent(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    if (!s.blocks) return null;
    return Math.round(((s.blocks - s.bavail) / s.blocks) * 1000) / 10;
  } catch {
    return null;
  }
}

/** Public health check: database reachability and disk use of the file store. No data, no versions. */
export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/health', async (_req, reply) => {
    let dbOk = false;
    try {
      await sql`SELECT 1`.execute(ctx.db);
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const disk = await diskUsagePercent(ctx.config.FILE_STORAGE_DIR);
    const diskOk = disk !== null && disk < 95;
    const body = {
      status: dbOk && diskOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'down',
      disk_used_percent: disk === null ? null : String(disk),
      disk_warning: disk !== null && disk > 80,
    };
    return reply.status(dbOk ? 200 : 503).send(body);
  });
}
