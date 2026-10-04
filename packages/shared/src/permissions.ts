/** Section 6: roles and fine-grained permissions. */
export const ROLES = ['manager', 'staff'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'finance.view',
  'finance.post',
  'technical.approve',
  'inventory.adjust',
  'sales.approve',
  'settings.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  'finance.view': 'دیدن قیمت خرید، اجرت، بهای تمام‌شده و سود',
  'finance.post': 'قطعی‌کردن دریافت، پرداخت، فاکتور و نرخ ارز',
  'technical.approve': 'تأیید وزن مرجع، کنترل کیفیت و بستن نوبت تولید',
  'inventory.adjust': 'مانده افتتاحیه وزنی و اصلاح شمارش',
  'sales.approve': 'تأیید سفارش، قفل قیمت و فاکتور نهایی',
  'settings.manage': 'کاربران، قراردادها، نرخ‌ها، آستانه‌ها و پشتیبان',
};

export const ROLE_LABELS: Record<Role, string> = { manager: 'مدیر', staff: 'کارمند' };

/** A manager holds every permission; staff hold only what was granted. */
export function effectivePermissions(role: Role, granted: readonly string[]): Permission[] {
  if (role === 'manager') return [...PERMISSIONS];
  return PERMISSIONS.filter((p) => granted.includes(p));
}

/**
 * Principle 6: keys that must never reach a user without finance.view.
 * Exact names plus the cost_*, profit_*, margin_* prefixes. Any key ending in one of the exact names
 * (e.g. default_paint_rate_per_kg) is treated as confidential too.
 */
export const CONFIDENTIAL_KEYS = ['unit_cost', 'rate_per_kg', 'fixed_fee', 'maker_cost', 'freight_cost'] as const;
export const CONFIDENTIAL_PREFIXES = ['cost_', 'profit_', 'margin_'] as const;

export function isConfidentialKey(key: string): boolean {
  if (CONFIDENTIAL_PREFIXES.some((p) => key.startsWith(p))) return true;
  return CONFIDENTIAL_KEYS.some((k) => key === k || key.endsWith(`_${k}`));
}
