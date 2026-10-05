<?php
declare(strict_types=1);

namespace Vitral\Core;

/** Port of packages/shared/src/permissions.ts — section 6 roles and fine-grained permissions. */
final class Permissions
{
    public const ROLES = ['manager', 'staff'];

    public const ALL = [
        'finance.view',
        'finance.post',
        'technical.approve',
        'inventory.adjust',
        'sales.approve',
        'settings.manage',
    ];

    public const LABELS = [
        'finance.view' => 'دیدن قیمت خرید، اجرت، بهای تمام‌شده و سود',
        'finance.post' => 'قطعی‌کردن دریافت، پرداخت، فاکتور و نرخ ارز',
        'technical.approve' => 'تأیید وزن مرجع، کنترل کیفیت و بستن نوبت تولید',
        'inventory.adjust' => 'مانده افتتاحیه وزنی و اصلاح شمارش',
        'sales.approve' => 'تأیید سفارش، قفل قیمت و فاکتور نهایی',
        'settings.manage' => 'کاربران، قراردادها، نرخ‌ها، آستانه‌ها و پشتیبان',
    ];

    public const ROLE_LABELS = ['manager' => 'مدیر', 'staff' => 'کارمند'];

    /** Principle 6: never sent to a user without finance.view. Exact names (also as a `_name` suffix) and prefixes. */
    public const CONFIDENTIAL_KEYS = ['unit_cost', 'rate_per_kg', 'fixed_fee', 'maker_cost', 'freight_cost'];
    public const CONFIDENTIAL_PREFIXES = ['cost_', 'profit_', 'margin_'];

    /**
     * A manager holds every permission; staff hold only what was granted (in canonical order).
     * @param list<string>|mixed $granted
     * @return list<string>
     */
    public static function effective(string $role, mixed $granted): array
    {
        if ($role === 'manager') return self::ALL;
        $granted = is_array($granted) ? $granted : [];
        return array_values(array_filter(self::ALL, static fn ($p) => in_array($p, $granted, true)));
    }

    public static function isConfidentialKey(string $key): bool
    {
        foreach (self::CONFIDENTIAL_PREFIXES as $p) if (str_starts_with($key, $p)) return true;
        foreach (self::CONFIDENTIAL_KEYS as $k) if ($key === $k || str_ends_with($key, '_' . $k)) return true;
        return false;
    }
}
