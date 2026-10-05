import type { FastifyRequest } from 'fastify';
import type { Db, Trx } from '../db/index.js';
import { AppError } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredResponse {
  status: number;
  body: unknown;
}

export function requireIdempotencyKey(req: FastifyRequest): string {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !UUID_RE.test(key)) {
    throw new AppError('validation', 'کلید یکتای درخواست (Idempotency-Key) لازم است', {
      'Idempotency-Key': 'UUID لازم است',
    });
  }
  return key.toLowerCase();
}

/**
 * Principle 4: run `work` once per request id. The key row is inserted first inside the same transaction,
 * so a concurrent duplicate blocks on the unique index until this one commits and then replays its response.
 * If `work` throws, the transaction (and the key) roll back and the client may retry with the same key.
 */
export async function withIdempotency(
  db: Db,
  requestId: string,
  userId: string | null,
  endpoint: string,
  work: (trx: Trx) => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  return db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto('idempotency_keys')
      .values({ request_id: requestId, user_id: userId, created_by: userId, endpoint, response: null })
      .onConflict((oc) => oc.column('request_id').doNothing())
      .returning('id')
      .executeTakeFirst();

    if (!inserted) {
      const existing = await trx
        .selectFrom('idempotency_keys')
        .select(['user_id', 'endpoint', 'response'])
        .where('request_id', '=', requestId)
        .executeTakeFirstOrThrow();
      if (existing.user_id !== userId || existing.endpoint !== endpoint || existing.response === null) {
        throw new AppError('conflict', 'این کلید یکتا قبلاً برای درخواست دیگری به کار رفته است');
      }
      return { ...(existing.response as unknown as StoredResponse), replayed: true };
    }

    const result = await work(trx);
    await trx
      .updateTable('idempotency_keys')
      .set({ response: JSON.stringify(result) })
      .where('request_id', '=', requestId)
      .execute();
    return { ...result, replayed: false };
  });
}
