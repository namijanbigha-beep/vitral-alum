import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import * as m0001 from './migrations/0001_base.js';

/** Versioned migrations, listed explicitly so the order never depends on the file system. */
const MIGRATIONS: Record<string, Migration> = {
  '0001_base': m0001,
};

class StaticProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return MIGRATIONS;
  }
}

export function createMigrator<T>(db: Kysely<T>): Migrator {
  return new Migrator({ db: db as Kysely<unknown>, provider: new StaticProvider() });
}

export async function migrateToLatest<T>(db: Kysely<T>): Promise<void> {
  const { error, results } = await createMigrator(db).migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Error') console.error(`migration ${r.migrationName} failed`);
  }
  if (error) throw error;
}
