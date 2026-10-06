import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Back } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';
import { useAct, useOne } from '../lib/hooks.js';
import { faDateTime } from '../lib/format.js';

type UpdateState = { current: string; supported: boolean; repo: string; has_token: boolean; writable: boolean };
type Latest = { current: string; tag: string; name: string; notes: string; published_at: string | null; size: string; is_newer: boolean };

const NO_REFRESH = { retry: false, refetchInterval: false, refetchOnWindowFocus: false } as const;

/** Managers on the PHP (shared-hosting) edition: the update endpoint exists. Hides the menu item elsewhere. */
export function useUpdateAvailable(): boolean {
  const { me } = useAuth();
  const st = useOne<UpdateState>(me?.user.role === 'manager' ? '/update' : null, { ...NO_REFRESH, staleTime: 300_000 });
  return !!st.data;
}

export function UpdateMenuItem() {
  if (!useUpdateAvailable()) return null;
  return <Link className="item" to="/settings/update"><div className="grow"><div className="title">به‌روزرسانی برنامه</div><div className="muted">نصب نسخه‌ی تازه از GitHub</div></div><span>‹</span></Link>;
}

/** Install a newer release from GitHub, without cPanel. */
export function UpdatePage() {
  const st = useOne<UpdateState>('/update', NO_REFRESH);
  const [check, setCheck] = useState(0);
  const latest = useOne<Latest>(check ? `/update/latest?n=${check}` : null, NO_REFRESH);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<{ from: string; to: string } | null>(null);
  const apply = useAct<{ tag: string }, { from: string; to: string }>('POST', '/update/apply', { onSuccess: (r) => { setDone(r); setConfirm(false); } });
  const [editRepo, setEditRepo] = useState(false);
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const save = useAct<{ repo: string; token?: string }>('POST', '/update/settings', { invalidate: [['one', '/update']], onSuccess: () => { setEditRepo(false); setToken(''); } });

  if (st.isLoading) return <p className="muted">در حال بارگذاری…</p>;
  if (!st.data) return <div className="stack"><Back to="/settings">بیشتر</Back><h1>به‌روزرسانی برنامه</h1><div className="alert danger">{st.error?.message ?? 'این بخش در این نصب وجود ندارد.'}</div></div>;
  const d = st.data;
  const l = latest.data;

  return (
    <div className="stack">
      <Back to="/settings">بیشتر</Back>
      <h1>به‌روزرسانی برنامه</h1>
      <div className="card stack">
        <p>نسخه‌ی نصب‌شده: <b dir="ltr">{d.current}</b></p>
        <p className="muted">مخزن: <span dir="ltr">{d.repo}</span>{d.has_token ? ' (با توکن دسترسی)' : ''} <button className="btn" onClick={() => { setRepo(d.repo); setEditRepo(!editRepo); }}>تغییر</button></p>
        {editRepo && <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(token ? { repo, token } : { repo }); }}>
          <label className="stack"><span>نام مخزن</span><input dir="ltr" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" required /></label>
          <label className="stack"><span>توکن دسترسی (فقط اگر مخزن خصوصی است)</span><input dir="ltr" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={d.has_token ? 'ذخیره شده؛ برای تغییر بنویسید' : 'github_pat_…'} /></label>
          <div className="row"><button className="btn primary" disabled={save.isPending}>ذخیره</button>{d.has_token && <button type="button" className="btn danger" disabled={save.isPending} onClick={() => save.mutate({ repo, token: '' })}>حذف توکن</button>}</div>
          {save.error?.message && <div className="error">{save.error.message}</div>}
        </form>}
        {!d.supported && <div className="alert">این نصب از راه برنامه به‌روز نمی‌شود (نصب برنامه‌نویس).</div>}
        {d.supported && !d.writable && <div className="alert danger">برنامه اجازه‌ی نوشتن در پوشه‌ی خودش را ندارد. از مسئول سرور بخواهید دسترسی نوشتن پوشه‌ی app را باز کند.</div>}
        {!done && <div className="row"><button className="btn primary" disabled={latest.isFetching} onClick={() => { setCheck(check + 1); setConfirm(false); }}>{latest.isFetching ? 'در حال بررسی…' : 'بررسی نسخه‌ی تازه'}</button></div>}
        {latest.error && <div className="alert danger">{latest.error.message}</div>}
      </div>

      {l && !done && <div className="card stack">
        {l.is_newer ? <>
          <h2>نسخه‌ی تازه: <span dir="ltr">{l.tag}</span></h2>
          {l.published_at && <p className="muted">منتشرشده {faDateTime(l.published_at)}</p>}
          {l.notes && <pre style={{ whiteSpace: 'pre-wrap' }}>{l.notes}</pre>}
          {!confirm && <button className="btn primary" disabled={!d.supported || !d.writable} onClick={() => setConfirm(true)}>نصب این نسخه</button>}
          {confirm && <div className="alert stack">
            <p>نصب حدود یک دقیقه طول می‌کشد. داده‌ها، تنظیمات و فایل‌ها دست نمی‌خورند و از کد فعلی یک نسخه‌ی پشتیبان نگه داشته می‌شود. بهتر است در این مدت کسی چیزی ثبت نکند.</p>
            <div className="row"><button className="btn primary" disabled={apply.isPending} onClick={() => apply.mutate({ tag: l.tag })}>{apply.isPending ? 'در حال نصب…' : 'بله، نصب کن'}</button><button className="btn" disabled={apply.isPending} onClick={() => setConfirm(false)}>انصراف</button></div>
          </div>}
          {apply.error?.message && <div className="alert danger">{apply.error.message}</div>}
        </> : <p><span className="badge ok">به‌روز است</span> آخرین نسخه همین نسخه‌ی نصب‌شده است.</p>}
      </div>}

      {done && <div className="card stack">
        <p><span className="badge ok">نصب شد</span> برنامه از <span dir="ltr">{done.from}</span> به <span dir="ltr">{done.to}</span> به‌روز شد.</p>
        <p className="muted">برای دیدن نسخه‌ی تازه صفحه را دوباره بارگذاری کنید. گوشی‌های دیگر هم با بستن و باز کردن برنامه نسخه‌ی تازه را می‌گیرند.</p>
        <button className="btn primary" onClick={() => window.location.reload()}>بارگذاری دوباره</button>
      </div>}
    </div>
  );
}
