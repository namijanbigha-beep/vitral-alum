import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { formatJalali, formatNumber, parseJalali, parseNumber, toGregorian, toJalali, toLatinDigits, toPersianDigits, type RoundKind } from '@vitral/shared';
import { api } from '../api/client.js';
import { useAuth } from '../lib/auth.js';
import { downloadBlob, qs, useList, type ActResult } from '../lib/hooks.js';

export const fa = (s: unknown): string => toPersianDigits(String(s ?? ''));
/** NUMERIC string → Persian digits with thousands separators; null stays «—» (NULL ≠ 0). */
export const num = (v: unknown, kind?: RoundKind): string => (v === null || v === undefined || v === '' ? '—' : (formatNumber(String(v), kind) ?? '—'));
export const CUR_FA: Record<string, string> = { TOMAN: 'تومان', USD: 'دلار', IQD: 'دینار' };
export const money = (v: unknown, cur: string): string => (v === null || v === undefined ? '—' : `${num(v, cur as RoundKind)} ${CUR_FA[cur] ?? cur}`);
export const jdate = (iso: string | null | undefined): string => (iso ? fa(formatJalali(toJalali(...(iso.slice(0, 10).split('-').map(Number) as [number, number, number])))) : '—');
export const jdt = (iso: string | null | undefined): string => { if (!iso) return '—'; const d = new Date(iso); const t = new Date(d.getTime() + 3.5 * 3600e3); return `${fa(formatJalali(toJalali(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())))} ${fa(String(t.getUTCHours()).padStart(2, '0'))}:${fa(String(t.getUTCMinutes()).padStart(2, '0'))}`; };

/** Numeric input: accepts Persian/Arabic digits and separators, stores a plain decimal string or null (never 0 for empty). */
export function NumInput({ value, onChange, placeholder, unit, disabled, dir = 'ltr' }: { value: string | null | undefined; onChange: (v: string | null) => void; placeholder?: string; unit?: string; disabled?: boolean; dir?: 'ltr' | 'rtl' }) {
  const [text, setText] = useState(value == null ? '' : fa(value));
  useEffect(() => { setText(value == null ? '' : fa(value)); }, [value]);
  const input = <input inputMode="decimal" dir={dir} value={text} disabled={disabled} placeholder={placeholder} onChange={(e) => { const t = e.target.value; setText(t); const p = t.trim() === '' ? null : parseNumber(toLatinDigits(t).replace(/[,٬\s]/g, '')); if (t.trim() === '' || p !== null) onChange(p); }} onBlur={() => { if (value != null) setText(fa(value)); }} style={{ borderColor: text.trim() !== '' && value == null ? 'var(--danger)' : undefined }} />;
  return unit ? <div className="unit">{input}<span>{unit}</span></div> : input;
}

/** Jalali date input (YYYY/MM/DD), stores ISO YYYY-MM-DD. */
export function JalaliInput({ value, onChange, disabled }: { value: string | null | undefined; onChange: (iso: string | null) => void; disabled?: boolean }) {
  const toText = (iso: string | null | undefined) => { if (!iso) return ''; const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return fa(formatJalali(toJalali(y!, m!, d!))); };
  const [text, setText] = useState(toText(value));
  useEffect(() => { setText(toText(value)); }, [value]);
  return <input dir="ltr" inputMode="numeric" placeholder="۱۴۰۵/۰۷/۱۲" value={text} disabled={disabled} onChange={(e) => { const t = e.target.value; setText(t); if (!t.trim()) return onChange(null); const j = parseJalali(toLatinDigits(t)); if (j) { const g = toGregorian(j.jy, j.jm, j.jd); onChange(`${g.gy}-${String(g.gm).padStart(2, '0')}-${String(g.gd).padStart(2, '0')}`); } }} style={{ borderColor: text.trim() && !parseJalali(toLatinDigits(text)) ? 'var(--danger)' : undefined }} />;
}

export function Select<T extends string>({ value, onChange, options, allowEmpty, disabled }: { value: T | '' | null | undefined; onChange: (v: T | null) => void; options: Array<[T, string]>; allowEmpty?: string; disabled?: boolean }) {
  return <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange((e.target.value || null) as T | null)}>{allowEmpty !== undefined && <option value="">{allowEmpty}</option>}{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
}

/** List endpoints without a GET-by-id route: resolve the picked row from the list instead of a 404 round trip. */
const NO_GET_BY_ID = new Set(['/users/directory']);

/** Search-as-you-type picker for parties/products/locations/dies/orders… `label` extracts the display line. */
export function Picker<T extends { id: string }>({ path, params, value, onChange, label, placeholder, disabled, extra }: { path: string; params?: Record<string, string | undefined>; value: string | null | undefined; onChange: (id: string | null, row: T | null) => void; label: (r: T) => string; placeholder?: string; disabled?: boolean; extra?: ReactNode }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const list = useList<T>(path, { ...params, q: q || undefined }, { limit: 20, enabled: open });
  const [picked, setPicked] = useState<T | null>(null);
  useEffect(() => { if (value && (!picked || picked.id !== value)) void (NO_GET_BY_ID.has(path) ? Promise.reject(new Error('list only')) : api<T>('GET', `${path}/${value}`)).catch(() => api<{ items: T[] }>('GET', `${path}?limit=100`).then((l) => l.items.find((r) => r.id === value) ?? null)).then(setPicked).catch(() => setPicked(null)); if (!value) setPicked(null); }, [value, path, picked]);
  return (
    <div className="picker">
      {value && picked && !open ? (
        <div className="row"><span className="grow">{label(picked)}</span>{!disabled && <button type="button" className="btn" onClick={(e) => { e.preventDefault(); onChange(null, null); setOpen(true); }}>تغییر</button>}{extra}</div>
      ) : (
        <>
          <input value={q} placeholder={placeholder ?? 'جستجو…'} disabled={disabled} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
          {open && (
            <div className="dropdown">
              {list.items.slice(0, 20).map((r) => <button type="button" key={r.id} onClick={(e) => { e.preventDefault(); setPicked(r); onChange(r.id, r); setOpen(false); setQ(''); }}>{label(r)}</button>)}
              {list.isFetching && <div className="muted" style={{ padding: 6 }}>…</div>}
              {!list.isFetching && list.items.length === 0 && <div className="muted" style={{ padding: 6 }}>موردی نیست</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function Money({ v, cur }: { v: unknown; cur: string }) {
  const { can } = useAuth();
  if (!can('finance.view')) return null;
  return <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>{money(v, cur)}</span>;
}

export function Table({ head, rows, empty = 'موردی نیست' }: { head: string[]; rows: Array<ReactNode[]>; empty?: string }) {
  return (
    <div className="table-wrap"><table className="table"><thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
      <tbody>{rows.length === 0 ? <tr><td colSpan={head.length} className="muted center">{empty}</td></tr> : rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>
  );
}

export function MoreButton({ list }: { list: { hasMore: boolean; more: () => void; isFetching: boolean } }) {
  if (!list.hasMore) return null;
  return <button className="btn block" disabled={list.isFetching} onClick={list.more}>بیشتر</button>;
}

/** 409 banner: shows the server's current values and offers reload (never silent overwrite). */
export function ConflictBanner({ err, onReload, fields }: { err: ActResult | null; onReload?: () => void; fields?: Record<string, string> }) {
  if (!err) return null;
  if (err.conflict) {
    return <div className="alert warn"><b>این رکورد را شخص دیگری تغییر داده.</b> مقادیر فعلی سرور: {Object.entries(err.conflict).filter(([k]) => !['id', 'created_at', 'updated_at', 'created_by'].includes(k) && (!fields || k in fields)).slice(0, 8).map(([k, v]) => <span key={k} className="badge">{fields?.[k] ?? k}: {typeof v === 'object' ? '…' : fa(String(v))}</span>)} {onReload && <button className="btn" onClick={onReload}>بازخوانی (ورودی شما حفظ می‌شود)</button>}</div>;
  }
  return <div className="alert danger">{err.message}{err.fields && Object.keys(err.fields).length > 0 && <ul style={{ margin: '0.3rem 0 0', paddingInlineStart: '1.2rem' }}>{Object.entries(err.fields).map(([k, v]) => <li key={k}>{fields?.[k] ?? k}: {v}</li>)}</ul>}</div>;
}

export function Status({ s, map }: { s: string | null | undefined; map: Record<string, [string, string?]> }) {
  const m = s ? map[s] : undefined;
  return <span className={`badge ${m?.[1] ?? ''}`}>{m?.[0] ?? s ?? '—'}</span>;
}

export function Confirm({ title, children, onConfirm, onCancel, danger, busy }: { title: string; children?: ReactNode; onConfirm: () => void; onCancel: () => void; danger?: boolean; busy?: boolean }) {
  return <div className="modal-bg" onClick={onCancel}><div className="modal card" onClick={(e) => e.stopPropagation()}><h2>{title}</h2>{children}<div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}><button type="button" className="btn" onClick={onCancel}>انصراف</button><button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={onConfirm}>تأیید</button></div></div></div>;
}

/** PDF / PNG / preview buttons for a document endpoint (spec §14). */
export function PdfButtons({ path, name, langs = ['fa', 'ar'], params = {}, png = true, label }: { path: string; name: string; langs?: Array<'fa' | 'ar'>; params?: Record<string, string | number | undefined>; png?: boolean; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const go = async (lang: string, format: string) => { setBusy(true); setErr(false); try { if (format === 'html') window.open(`/api/v1${path}${qs({ ...params, lang, format })}`, '_blank'); else await downloadBlob(`${path}${qs({ ...params, lang, format })}`, `${name}-${lang}.${format}`); } catch { setErr(true); } finally { setBusy(false); } };
  return <div className="row">{langs.map((l) => <span key={l} className="row" style={{ gap: 4 }}><button className="btn" disabled={busy} onClick={() => void go(l, 'pdf')}>{label ?? `PDF ${l === 'fa' ? 'فارسی' : 'عربی'}`}</button>{png && <button className="btn" disabled={busy} onClick={() => void go(l, 'png')}>تصویر</button>}<button className="btn" disabled={busy} onClick={() => void go(l, 'html')}>پیش‌نمایش</button></span>)}{err && <span className="error">دانلود نشد</span>}</div>;
}

export function FileUpload({ kind, owner, onDone, accept = 'image/*,application/pdf', label = 'افزودن فایل', capture, sensitive }: { kind: string; owner?: { entity: string; id: string }; onDone: (f: { id: string }) => void; accept?: string; label?: string; capture?: boolean; sensitive?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return <label className="btn" style={{ cursor: 'pointer' }}>{busy ? 'در حال ارسال…' : label}{err && <span className="error"> {err}</span>}
    <input type="file" accept={accept} capture={capture ? 'environment' : undefined} hidden disabled={busy} onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setBusy(true); setErr(null); try { const fd = new FormData(); fd.set('kind', kind); if (sensitive) fd.set('sensitive', 'true'); if (owner) { fd.set('owner_entity', owner.entity); fd.set('owner_id', owner.id); } fd.set('file', f, f.name); onDone(await api<{ id: string }>('POST', '/files', { form: fd, idempotencyKey: crypto.randomUUID() })); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); e.target.value = ''; } }} /></label>;
}

export function Thumb({ id, size = 64 }: { id: string; size?: number }) {
  return <a href={`/api/v1/files/${id}/download`} target="_blank" rel="noreferrer"><img src={`/api/v1/files/${id}/thumb`} width={size} height={size} style={{ objectFit: 'cover', borderRadius: 8 }} alt="" loading="lazy" /></a>;
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (t: T) => void; tabs: Array<[T, string]> }) {
  return <div className="tabs">{tabs.map(([v, l]) => <button key={v} className={v === value ? 'active' : ''} onClick={() => onChange(v)}>{l}</button>)}</div>;
}

export function Back({ to, children }: { to: string; children: ReactNode }) { return <Link className="muted" to={to}>‹ {children}</Link>; }

export function KV({ items }: { items: Array<[string, ReactNode]> }) {
  return <dl className="kv">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v ?? '—'}</dd></div>)}</dl>;
}
