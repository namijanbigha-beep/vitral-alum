import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import type { SettingItem } from '../api/types.js';
import { errorInfo, Field, SaveStatus, type SaveState } from '../components/forms.js';
import { useAuth } from '../lib/auth.js';
import { faDateTime } from '../lib/format.js';
import { UpdateMenuItem } from './Update.js';

/** Which keys the generic form edits as plain text, number, list or JSON. */
const TEXT_KEYS = new Set([
  'seller_name_fa', 'seller_name_ar', 'seller_name_en', 'seller_address_fa', 'seller_address_ar', 'seller_address_en', 'seller_phone',
  'proforma_validity_text', 'sales_terms_fa', 'sales_terms_ar', 'time_zone', 'error_contact_name', 'error_contact_channel',
  'default_numbering_pattern', 'weight_per_meter_tolerance_percent', 'bundle_weight_median_threshold_percent',
  'production_balance_threshold_percent', 'default_prepay_percent',
]);
const INT_KEYS = new Set(['default_delivery_days', 'share_link_days']);
const LIST_KEYS = new Set(['product_categories', 'sample_colors', 'load_type_labels']);
const UNITS: Record<string, string> = {
  weight_per_meter_tolerance_percent: 'درصد',
  bundle_weight_median_threshold_percent: 'درصد',
  production_balance_threshold_percent: 'درصد',
  default_prepay_percent: 'درصد',
  default_delivery_days: 'روز',
  share_link_days: 'روز',
};

function toText(item: SettingItem): string {
  const v = item.value;
  if (v === null || v === undefined) return '';
  if (LIST_KEYS.has(item.key) && Array.isArray(v)) return v.join('\n');
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  return JSON.stringify(v, null, 2);
}

function fromText(item: SettingItem, text: string): unknown {
  const t = text.trim();
  if (TEXT_KEYS.has(item.key)) return t === '' ? null : t;
  if (INT_KEYS.has(item.key)) return t === '' ? null : Number(t.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))));
  if (LIST_KEYS.has(item.key)) return t === '' ? [] : t.split('\n').map((s) => s.trim()).filter(Boolean);
  return t === '' ? null : JSON.parse(t);
}

function SettingRow({ item }: { item: SettingItem }) {
  const qc = useQueryClient();
  const [text, setText] = useState(toText(item));
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    setText(toText(item));
  }, [item.version, item.key]);

  const save = useMutation({
    mutationFn: async () => {
      let value: unknown;
      try {
        value = fromText(item, text);
      } catch {
        throw new Error('JSON نامعتبر است');
      }
      return api<SettingItem>('PUT', `/settings/${item.key}`, { body: { version: item.version, value } });
    },
    onMutate: () => {
      setState('saving');
      setError(undefined);
    },
    onSuccess: (updated) => {
      setState('saved');
      qc.setQueryData<{ items: SettingItem[] }>(['settings'], (old) => (old ? { items: old.items.map((i) => (i.key === updated.key ? updated : i)) } : old));
    },
    onError: (e) => {
      setState('failed');
      const info = errorInfo(e);
      setError(info.conflict ? 'این مقدار را شخص دیگری تغییر داده؛ صفحه را بازخوانی کنید' : info.fields.value ?? (e instanceof Error ? e.message : info.message));
    },
  });

  const dirty = text !== toText(item);
  const multiline = LIST_KEYS.has(item.key) || item.key.startsWith('sales_terms') || item.key === 'proforma_validity_text' || (!TEXT_KEYS.has(item.key) && !INT_KEYS.has(item.key));
  return (
    <div className="card compact">
      <Field label={item.label} error={error} unit={UNITS[item.key]}>
        {multiline ? (
          <textarea rows={LIST_KEYS.has(item.key) ? 4 : 3} value={text} onChange={(e) => setText(e.target.value)} disabled={item.readonly} placeholder={item.value === null ? 'نامشخص' : ''} />
        ) : (
          <input value={text} onChange={(e) => setText(e.target.value)} disabled={item.readonly} inputMode={INT_KEYS.has(item.key) || UNITS[item.key] ? 'decimal' : undefined} placeholder={item.value === null ? 'نامشخص' : ''} dir={item.key === 'default_numbering_pattern' || item.key === 'time_zone' ? 'ltr' : undefined} />
        )}
      </Field>
      <div className="row between">
        <span className="muted">آخرین تغییر: {faDateTime(item.updated_at)}</span>
        <div className="row">
          <SaveStatus state={state} onRetry={() => save.mutate()} />
          {!item.readonly && (
            <button className="btn primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              ذخیره
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { can } = useAuth();
  const manage = can('settings.manage');
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api<{ items: SettingItem[] }>('GET', '/settings'), enabled: manage });
  const Item = ({ to, title, sub }: { to: string; title: string; sub?: string }) => (
    <Link className="item" to={to}><div className="grow"><div className="title">{title}</div>{sub && <div className="muted">{sub}</div>}</div><span>‹</span></Link>
  );
  return (
    <div className="stack">
      <h1>بیشتر</h1>
      <p className="muted">منوی اصلی چهار بخش دارد (خلاصه، محصولات، سفارش‌ها، حساب‌ها)؛ بقیه بخش‌ها اینجاست.</p>
      <div className="list">
        <Item to="/help" title="راهنمای کار" sub="قدم‌های کوتاه هر بخش با مثال عددی" />
      </div>
      <h2>کارخانه و انبار</h2>
      <div className="list">
        <Item to="/bundles" title="بندیل‌ها" />
        <Item to="/production" title="نوبت‌های تولید" />
        <Item to="/coating" title="رنگ و پوشش" />
        <Item to="/transfers" title="بارها و حواله‌ها" />
        <Item to="/scale" title="قبض‌های باسکول" />
        <Item to="/stock" title="انبار و وزن کجاست" />
        <Item to="/materials" title="مواد اولیه و خرید" sub="شمش، بیلت، ضایعات، رنگ" />
      </div>
      <h2>کاتالوگ</h2>
      <div className="list">
        <Item to="/dies" title="قالب‌ها" />
        <Item to="/die-orders" title="سفارش ساخت قالب" sub="شش گام از نقشه تا ثبت رسمی" />
        <Item to="/contracts" title="قراردادها و نرخ‌ها" />
        <Item to="/locations" title="مکان‌ها" />
      </div>
      <h2>مالی</h2>
      <div className="list">
        <Item to="/documents" title="اسناد مالی" sub="دریافت، پرداخت، فاکتور، هزینه" />
        <Item to="/accounts" title="حساب‌ها و صندوق" />
        <Item to="/fx-rates" title="نرخ ارز" />
        <Item to="/settings/corrections" title="درخواست‌های اصلاح" sub="اصلاح سند قطعی بدون دستکاری" />
      </div>
      <h2>روزانه و گزارش</h2>
      <div className="list">
        <Item to="/reports/daily" title="گزارش روزانه" />
        <Item to="/reports/inventory" title="گزارش‌ها" sub="فروش، مطالبات، موجودی، کارگاه‌ها و…" />
        <Item to="/notes" title="یادداشت‌های آزاد" sub="متن و ویس، رسیدگی مالی" />
        <Item to="/tasks" title="کارها" />
        <Item to="/gallery" title="گالری عکس‌ها" />
      </div>
      <h2>حساب من</h2>
      <div className="list">
        <Item to="/settings/telegram" title="اتصال تلگرام" sub="دریافت کد و ارسال به بات" />
        <Item to="/settings/password" title="تغییر رمز من" />
        <Item to="/settings/share-links" title="لینک‌های مهمان" sub="ساخته‌شده برای مشتری یا شریک؛ ابطال" />
      </div>
      {manage && <>
        <h2>مدیریت</h2>
        <div className="list">
          <Item to="/settings/users" title="کاربران" sub="ایجاد کارمند، مجوزها، غیرفعال‌کردن" />
          <Item to="/settings/backup" title="پشتیبان" sub="فهرست پشتیبان‌ها و سابقه آزمون بازیابی" />
          <Item to="/import" title="ورود داده از Excel" sub="پیش‌نمایش، ثبت، برگشت" />
          <UpdateMenuItem />
        </div>
        <h2>تنظیمات عمومی</h2>
        <p className="muted">مقدار خالی یعنی «نامشخص»؛ سامانه آن را صفر فرض نمی‌کند.</p>
        {q.isLoading && <p className="muted">در حال بارگذاری…</p>}
        {q.error && <div className="alert danger">{errorInfo(q.error).message}</div>}
        {q.data?.items.filter((i) => i.key !== 'restore_test_log' && i.key !== 'seller_logo_file_id').map((item) => <SettingRow key={item.key} item={item} />)}
      </>}
    </div>
  );
}
