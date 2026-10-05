import type { Insertable, Selectable, Updateable } from 'kysely';
import type { DB } from './generated.js';

export type Database = DB;
export type Row<T extends keyof DB> = Selectable<DB[T]>;
export type NewRow<T extends keyof DB> = Insertable<DB[T]>;
export type RowUpdate<T extends keyof DB> = Updateable<DB[T]>;

export type User = Row<'users'>;
export type NewUser = NewRow<'users'>;
export type UserUpdate = RowUpdate<'users'>;
export type FileRow = Row<'files'>;
export type SettingRow = Row<'settings'>;
