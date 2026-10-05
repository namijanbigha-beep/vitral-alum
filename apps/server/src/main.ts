import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrateToLatest } from './db/migrator.js';
import { DiskStorage } from './lib/storage.js';
import { buildApp } from './app.js';
import { startScheduler } from './scheduler.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
await migrateToLatest(db);
const app = await buildApp({ config, db, storage: new DiskStorage(config.FILE_STORAGE_DIR) });
await app.listen({ port: config.PORT, host: config.HOST });
const stopScheduler = startScheduler(db, config, app.log);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stopScheduler();
    await app.close();
    await db.destroy();
    process.exit(0);
  });
}
