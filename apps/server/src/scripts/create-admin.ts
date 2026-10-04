/**
 * Creates the first manager. There is no shared default password (section 17).
 * Usage: ADMIN_MOBILE=09xxxxxxxxx ADMIN_NAME="..." ADMIN_PASSWORD="..." pnpm create-admin
 */
import argon2 from 'argon2';
import { mobileSchema, passwordSchema } from '@vitral/shared';
import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { migrateToLatest } from '../db/migrator.js';
import { audit } from '../lib/audit.js';
import { ARGON2_OPTIONS } from '../modules/users/service.js';

const config = loadConfig();
const mobile = mobileSchema.parse(process.env.ADMIN_MOBILE ?? '');
const password = passwordSchema.parse(process.env.ADMIN_PASSWORD ?? '');
const name = (process.env.ADMIN_NAME ?? '').trim() || 'مدیر';

const db = createDb(config.DATABASE_URL);
await migrateToLatest(db);
const existing = await db.selectFrom('users').select('id').where('role', '=', 'manager').executeTakeFirst();
if (existing) {
  console.error('A manager already exists; add more users from the app settings.');
  await db.destroy();
  process.exit(1);
}
const hash = await argon2.hash(password, ARGON2_OPTIONS);
await db.transaction().execute(async (trx) => {
  const row = await trx
    .insertInto('users')
    .values({ mobile, name, password_hash: hash, role: 'manager', permissions: [] })
    .returning('id')
    .executeTakeFirstOrThrow();
  await audit(trx, { userId: row.id, entity: 'users', entityId: row.id, action: 'create', after: { mobile, name, role: 'manager' }, reason: 'install script' });
});
console.log(`Manager ${name} (${mobile}) created.`);
await db.destroy();
