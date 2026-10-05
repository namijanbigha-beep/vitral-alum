import { sql, type Kysely } from 'kysely';

/**
 * T49 / module 4: a repeated bundle code at the same factory is a warning that puts the bundle in
 * «needs review»; it must not block the recording. The unique index from 0002 contradicted that
 * (the insert failed with 23505), so it becomes a plain lookup index.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS bundles_factory_code_key`.execute(db);
  await sql`CREATE INDEX bundles_factory_code_idx ON bundles (factory_party_id, code)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS bundles_factory_code_idx`.execute(db);
  await sql`CREATE UNIQUE INDEX bundles_factory_code_key ON bundles (factory_party_id, code) WHERE code_is_temp = false AND factory_party_id IS NOT NULL`.execute(db);
}
