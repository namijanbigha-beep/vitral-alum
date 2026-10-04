import { CURRENCIES, decimalString } from '@vitral/shared';
import { z, type ZodTypeAny } from 'zod';

export interface SettingDef {
  label: string;
  schema: ZodTypeAny;
  /** Confidential (principle 6): only users with finance.view receive it. */
  finance?: boolean;
  /** Changed only through its own endpoint, not the generic settings form. */
  readonly?: boolean;
}

const text = (max = 500) => z.string().trim().max(max).nullable();
const percent = decimalString.refine((v) => Number(v) >= 0 && Number(v) <= 100, 'درصد باید بین ۰ و ۱۰۰ باشد');
const pattern = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((v) => /\{seq(:\d)?\}/.test(v), 'الگو باید {seq} داشته باشد')
  .refine((v) => /^[A-Za-z0-9\-_/{}:]+$/.test(v), 'فقط حروف لاتین، عدد و - _ / مجاز است');

export const SETTINGS_CATALOG: Record<string, SettingDef> = {
  seller_name_fa: { label: 'نام فروشنده (فارسی)', schema: text(200) },
  seller_name_ar: { label: 'نام فروشنده (عربی)', schema: text(200) },
  seller_name_en: { label: 'نام فروشنده (انگلیسی)', schema: text(200) },
  seller_address_fa: { label: 'نشانی (فارسی)', schema: text() },
  seller_address_ar: { label: 'نشانی (عربی)', schema: text() },
  seller_address_en: { label: 'نشانی (انگلیسی)', schema: text() },
  seller_phone: { label: 'تلفن', schema: text(100) },
  seller_logo_file_id: { label: 'لوگو', schema: z.string().uuid().nullable() },
  default_paint_rate_per_kg: {
    label: 'نرخ پیش‌فرض رنگ هر کیلو',
    finance: true,
    schema: z.object({ amount: decimalString, currency: z.enum(CURRENCIES) }).nullable(),
  },
  weight_per_meter_tolerance_percent: { label: 'آستانه اختلاف وزن هر متر (٪)', schema: percent.nullable() },
  bundle_weight_median_threshold_percent: { label: 'آستانه وزن بندیل نسبت به میانه (٪)', schema: percent.nullable() },
  production_balance_threshold_percent: { label: 'آستانه تراز نوبت تولید (٪)', schema: percent.nullable() },
  coating_gain_range_percent: {
    label: 'بازه طبیعی افزایش وزن رنگ (٪)',
    schema: z.object({ min: decimalString, max: decimalString }).nullable(),
  },
  default_prepay_percent: { label: 'درصد پیش‌پرداخت پیش‌فرض', schema: percent.nullable() },
  default_delivery_days: { label: 'روزهای تحویل پیش‌فرض', schema: z.number().int().min(0).max(365).nullable() },
  proforma_validity_text: { label: 'متن اعتبار پیش‌فاکتور', schema: text(2000) },
  sales_terms_fa: { label: 'شرایط فروش (فارسی)', schema: text(5000) },
  sales_terms_ar: { label: 'شرایط فروش (عربی)', schema: text(5000) },
  numbering_patterns: { label: 'الگوی شماره هر نوع سند', schema: z.record(z.string().max(40), pattern) },
  default_numbering_pattern: { label: 'الگوی پیش‌فرض شماره سند', schema: pattern },
  time_zone: {
    label: 'منطقه زمانی',
    schema: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'منطقه زمانی نامعتبر است'),
  },
  share_link_days: { label: 'مدت اعتبار لینک اشتراک (روز)', schema: z.number().int().min(1).max(365) },
  error_contact_name: { label: 'مسئول رسیدگی به خطا', schema: text(200) },
  error_contact_channel: { label: 'راه تماس مسئول خطا', schema: text(200) },
  product_categories: { label: 'دسته‌های محصول', schema: z.array(z.string().trim().min(1).max(60)).max(50) },
  sample_colors: { label: 'رنگ‌ها', schema: z.array(z.string().trim().min(1).max(60)).max(200) },
  load_type_labels: { label: 'انواع بار', schema: z.array(z.string().trim().min(1).max(60)).max(20) },
  restore_test_log: { label: 'سابقه آزمون بازیابی', schema: z.array(z.unknown()), readonly: true },
};
