import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string | undefined, string>;

export interface UsersTable {
  id: Generated<string>;
  mobile: string;
  name: string;
  short_name: string | null;
  password_hash: string;
  role: 'manager' | 'staff';
  permissions: ColumnType<string[], string[] | undefined, string[]>;
  telegram_chat_id: string | null;
  active: Generated<boolean>;
  failed_logins: Generated<number>;
  locked_until: Date | null;
  created_at: Timestamp;
  created_by: string | null;
  updated_at: Timestamp;
  version: Generated<number>;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  user_agent: string | null;
  last_seen_at: Timestamp;
  created_at: Timestamp;
  created_by: string | null;
}

export interface AuditLogTable {
  id: Generated<string>;
  at: Timestamp;
  user_id: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  before: Json | null;
  after: Json | null;
  reason: string | null;
  created_at: Timestamp;
  created_by: string | null;
}

export interface IdempotencyKeysTable {
  id: Generated<string>;
  request_id: string;
  user_id: string | null;
  endpoint: string;
  response: Json | null;
  created_at: Timestamp;
  created_by: string | null;
}

export interface SettingsTable {
  id: Generated<string>;
  key: string;
  value: Json;
  created_at: Timestamp;
  created_by: string | null;
  updated_at: Timestamp;
  version: Generated<number>;
}

export interface CountersTable {
  id: Generated<string>;
  kind: string;
  /** Counter period: 0 = never resets, Jalali year (1405), or Jalali day as yyyymmdd (14050623). */
  year: number;
  last_value: number;
  created_at: Timestamp;
  created_by: string | null;
}

export interface FilesTable {
  id: Generated<string>;
  storage_key: string;
  original_name: string;
  mime: string;
  size: number;
  sha256: string;
  kind: string;
  caption: string | null;
  sensitive: Generated<boolean>;
  owner_entity: string | null;
  owner_id: string | null;
  sort_order: Generated<number>;
  thumb_key: string | null;
  created_at: Timestamp;
  created_by: string | null;
  updated_at: Timestamp;
  version: Generated<number>;
}

export interface FileLinksTable {
  id: Generated<string>;
  file_id: string;
  entity: string;
  entity_id: string;
  created_at: Timestamp;
  created_by: string | null;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  audit_log: AuditLogTable;
  idempotency_keys: IdempotencyKeysTable;
  settings: SettingsTable;
  counters: CountersTable;
  files: FilesTable;
  file_links: FileLinksTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type FileRow = Selectable<FilesTable>;
export type SettingRow = Selectable<SettingsTable>;
