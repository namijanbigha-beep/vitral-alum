import type { Trx } from '../db/index.js';
import type { Database } from '../db/schema.js';
import { AppError } from './errors.js';
import { sql } from 'kysely';

type VersionedTable = 'users' | 'settings' | 'files';

/**
 * Principle 5: optimistic concurrency per record. Locks the row, compares `version`,
 * and throws 409 with the current record (passed through `present`) when the client's copy is stale.
 */
export async function lockForUpdate<T extends VersionedTable>(
  trx: Trx,
  table: T,
  id: string,
  expectedVersion: number,
  present: (row: Record<string, unknown>) => unknown,
): Promise<Record<string, unknown>> {
  const row = (await trx
    .selectFrom(table as 'users')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  if (!row) throw new AppError('not_found');
  if (row.version !== expectedVersion) {
    throw new AppError('conflict', undefined, undefined, present(row));
  }
  return row;
}

export const bumpVersion = { version: sql<number>`version + 1`, updated_at: sql<Date>`now()` };

export type { Database };
