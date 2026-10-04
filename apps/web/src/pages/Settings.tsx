import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import type { SettingItem } from '../api/types.js';
import { errorInfo, Field, SaveStatus, type SaveState } from '../components/forms.js';
import { useAuth } from '../lib/auth.js';
import { faDateTime } from '../lib/format.js';

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
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api<{ items: SettingItem[] }>('GET', '/settings') });
  if (!can('settings.manage')) return <div className="alert danger">اجازه این بخش را ندارید</div>;
  return (
    <div className="stack">
      <h1>تنظیمات</h1>
      <div className="list">
        <Link className="item" to="/settings/users">
          <div className="grow"><div className="title">کاربران</div><div className="muted">ایجاد کارمند، مجوزها، غیرفعال‌کردن</div></div>
          <span>‹</span>
        </Link>
        <Link className="item" to="/settings/backup">
          <div className="grow"><div className="title">پشتیبان</div><div className="muted">فهرست پشتیبان‌ها و سابقه آزمون بازیابی</div></div>
          <span>‹</span>
        </Link>
        <Link className="item" to="/settings/password">
          <div className="grow"><div className="title">تغییر رمز من</div></div>
          <span>‹</span>
        </Link>
      </div>
      <h2>تنظیمات عمومی</h2>
      <p className="muted">مقدار خالی یعنی «نامشخص»؛ سامانه آن را صفر فرض نمی‌کند. قراردادها، نرخ‌ها و ورود داده در فازهای بعدی اضافه می‌شوند.</p>
      {q.isLoading && <p className="muted">در حال بارگذاری…</p>}
      {q.error && <div className="alert danger">{errorInfo(q.error).message}</div>}
      {q.data?.items.filter((i) => i.key !== 'restore_test_log' && i.key !== 'seller_logo_file_id').map((item) => <SettingRow key={item.key} item={item} />)}
    </div>
  );
}
