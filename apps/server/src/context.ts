import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Storage } from './lib/storage.js';

export interface AppContext {
  config: Config;
  db: Db;
  storage: Storage;
}
