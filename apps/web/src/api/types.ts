import type { Permission, Role } from '@vitral/shared';

export interface Me {
  user: { id: string; mobile: string; name: string; short_name: string | null; role: Role; permissions: Permission[]; version: number };
  permission_labels: Record<Permission, string>;
  app_env: string;
}

export interface UserRow {
  id: string;
  mobile: string;
  name: string;
  short_name: string | null;
  role: Role;
  permissions: Permission[];
  effective_permissions: Permission[];
  active: boolean;
  locked_until: string | null;
  telegram_linked: boolean;
  created_at: string;
  version: number;
}

export interface SettingItem {
  key: string;
  label: string;
  value: unknown;
  readonly: boolean;
  updated_at: string;
  version: number;
}

export interface Health {
  status: 'ok' | 'degraded';
  db: 'ok' | 'down';
  disk_used_percent: string | null;
  disk_warning: boolean;
}
