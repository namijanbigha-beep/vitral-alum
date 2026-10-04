import { createDb } from './index.js';
import { createMigrator } from './migrator.js';

const direction = process.argv[2] ?? 'latest';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = createDb(url);
const migrator = createMigrator(db);
const { error, results } =
  direction === 'down' ? await migrator.migrateDown() : await migrator.migrateToLatest();
for (const r of results ?? []) console.log(`${r.status}: ${r.migrationName} (${r.direction})`);
await db.destroy();
if (error) {
  console.error(error);
  process.exit(1);
}
