import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PERMISSIONS, ROLE_LABELS, type Permission, type Role } from '@vitral/shared';
import { api, newRequestId } from '../api/client.js';
import type { UserRow } from '../api/types.js';
import { errorInfo, Field, SaveStatus, type SaveState } from '../components/forms.js';
import { useAuth } from '../lib/auth.js';
import { fa, faDateTime } from '../lib/format.js';

export function UsersPage() {
  const q = useQuery({ queryKey: ['users'], queryFn: () => api<{ items: UserRow[] }>('GET', '/users?limit=100') });
  return (
    <div className="stack">
      <div className="row between">
        <h1>کاربران</h1>
        <Link className="btn primary" to="/settings/users/new">کاربر جدید</Link>
      </div>
      {q.error && <div className="alert danger">{errorInfo(q.error).message}</div>}
      <div className="list">
        {q.data?.items.map((u) => (
          <Link key={u.id} className="item" to={`/settings/users/${u.id}`}>
            <div className="grow">
              <div className="title">{u.name} {u.short_name && <span className="muted">({u.short_name})</span>}</div>
              <div className="muted" dir="ltr" style={{ textAlign: 'end' }}>{fa(u.mobile)}</div>
            </div>
            <span className="badge">{ROLE_LABELS[u.role]}</span>
            {!u.active && <span className="badge danger">غیرفعال</span>}
            {u.locked_until && new Date(u.locked_until) > new Date() && <span className="badge warn">قفل</span>}
          </Link>
        ))}
      </div>
    </div>
  );
}

function PermissionChecks({ role, value, onChange, labels }: { role: Role; value: Permission[]; onChange: (v: Permission[]) => void; labels: Record<Permission, string> }) {
  if (role === 'manager') return <p className="muted">مدیر همه مجوزها را دارد.</p>;
  return (
    <div className="checks">
      {PERMISSIONS.map((p) => (
        <label key={p}>
          <input type="checkbox" checked={value.includes(p)} onChange={(e) => onChange(e.target.checked ? [...value, p] : value.filter((x) => x !== p))} />
          <span><b dir="ltr">{p}</b><br /><span className="muted">{labels[p]}</span></span>
        </label>
      ))}
    </div>
  );
}

export function UserFormPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const { me } = useAuth();
  const labels = me?.permission_labels ?? ({} as Record<Permission, string>);
  const q = useQuery({ queryKey: ['users', id], queryFn: () => api<UserRow>('GET', `/users/${id}`), enabled: !isNew });

  const [form, setForm] = useState<{ name: string; short_name: string; mobile: string; password: string; role: Role; permissions: Permission[] } | null>(
    isNew ? { name: '', short_name: '', mobile: '', password: '', role: 'staff', permissions: [] } : null,
  );
  const [reason, setReason] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [state, setState] = useState<SaveState>('idle');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(newRequestId);

  const user = q.data;
  const current = form ?? (user ? { name: user.name, short_name: user.short_name ?? '', mobile: user.mobile, password: '', role: user.role, permissions: user.permissions } : null);

  function onError(e: unknown) {
    const info = errorInfo(e);
    setState('failed');
    setFields(info.fields);
    setMessage(info.conflict ? 'این رکورد را شخص دیگری تغییر داده؛ بازخوانی کنید. اطلاعات واردشده شما حفظ شده است.' : info.message);
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!current) throw new Error('no form');
      if (isNew) {
        return api<UserRow>('POST', '/users', {
          idempotencyKey: requestId,
          body: { mobile: current.mobile, name: current.name, short_name: current.short_name || null, password: current.password, role: current.role, permissions: current.permissions },
        });
      }
      return api<UserRow>('PATCH', `/users/${id}`, {
        body: { version: user!.version, name: current.name, short_name: current.short_name || null, role: current.role, permissions: current.permissions, reason: reason || undefined },
      });
    },
    onMutate: () => { setState('saving'); setMessage(null); setFields({}); },
    onSuccess: (row) => {
      setState('saved');
      setRequestId(newRequestId());
      void qc.invalidateQueries({ queryKey: ['users'] });
      if (isNew) nav(`/settings/users/${row.id}`, { replace: true });
      else { qc.setQueryData(['users', id], row); setForm(null); }
    },
    onError,
  });

  const toggleActive = useMutation({
    mutationFn: () => api<UserRow>('PATCH', `/users/${id}`, { body: { version: user!.version, active: !user!.active, reason: reason || undefined } }),
    onSuccess: (row) => { qc.setQueryData(['users', id], row); void qc.invalidateQueries({ queryKey: ['users'] }); setMessage(row.active ? 'کاربر فعال شد' : 'کاربر غیرفعال شد و همه نشست‌هایش باطل شد'); },
    onError,
  });

  const resetPassword = useMutation({
    mutationFn: () => api<UserRow>('POST', `/users/${id}/reset-password`, { body: { version: user!.version, new_password: newPassword } }),
    onSuccess: (row) => { qc.setQueryData(['users', id], row); setNewPassword(''); setMessage('رمز جدید ثبت شد؛ کاربر باید دوباره وارد شود'); },
    onError,
  });

  if (!isNew && q.isLoading) return <p className="muted">در حال بارگذاری…</p>;
  if (!current) return <div className="alert danger">{q.error ? errorInfo(q.error).message : 'پیدا نشد'}</div>;
  const set = (patch: Partial<typeof current>) => setForm({ ...current, ...patch });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <div className="stack">
      <h1>{isNew ? 'کاربر جدید' : current.name}</h1>
      {message && <div className={`alert ${state === 'failed' ? 'danger' : 'ok'}`}>{message}</div>}
      <form className="card" onSubmit={submit}>
        <Field label="نام" required error={fields.name}><input value={current.name} onChange={(e) => set({ name: e.target.value })} required /></Field>
        <Field label="شماره موبایل (شناسه ورود)" required error={fields.mobile}>
          <input dir="ltr" inputMode="tel" value={current.mobile} onChange={(e) => set({ mobile: e.target.value })} disabled={!isNew} required />
        </Field>
        <Field label="نام نمایشی کوتاه" error={fields.short_name}><input value={current.short_name} onChange={(e) => set({ short_name: e.target.value })} placeholder="مثلاً چهار رقم آخر موبایل" /></Field>
        {isNew && (
          <Field label="رمز اولیه (حداقل ۸ نویسه)" required error={fields.password}>
            <input dir="ltr" type="password" autoComplete="new-password" value={current.password} onChange={(e) => set({ password: e.target.value })} minLength={8} required />
          </Field>
        )}
        <Field label="نقش" required error={fields.role}>
          <select value={current.role} onChange={(e) => set({ role: e.target.value as Role })} disabled={!isNew && user?.id === me?.user.id}>
            <option value="staff">کارمند</option>
            <option value="manager">مدیر</option>
          </select>
        </Field>
        <Field label="مجوزها">
          <PermissionChecks role={current.role} value={current.permissions} onChange={(permissions) => set({ permissions })} labels={labels} />
        </Field>
        {!isNew && <Field label="دلیل تغییر (در تاریخچه ثبت می‌شود)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        <div className="row between">
          <SaveStatus state={state} onRetry={() => save.mutate()} />
          <button className="btn primary" disabled={save.isPending}>{isNew ? 'ایجاد کاربر' : 'ذخیره'}</button>
        </div>
      </form>

      {!isNew && user && (
        <>
          <div className="card">
            <h2>وضعیت</h2>
            <p className="muted">ایجاد: {faDateTime(user.created_at)} · نسخه {fa(user.version)} · تلگرام: {user.telegram_linked ? 'متصل' : 'متصل نیست'}</p>
            {user.id !== me?.user.id && (
              <button className={`btn ${user.active ? 'danger' : 'primary'}`} disabled={toggleActive.isPending} onClick={() => toggleActive.mutate()}>
                {user.active ? 'غیرفعال‌کردن کاربر' : 'فعال‌کردن کاربر'}
              </button>
            )}
          </div>
          <form className="card" onSubmit={(e) => { e.preventDefault(); resetPassword.mutate(); }}>
            <h2>تعیین رمز جدید</h2>
            <Field label="رمز جدید (حداقل ۸ نویسه)" required error={fields.new_password}>
              <input dir="ltr" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} required />
            </Field>
            <button className="btn" disabled={resetPassword.isPending}>ثبت رمز جدید</button>
          </form>
        </>
      )}
    </div>
  );
}

export function ChangePasswordPage() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [state, setState] = useState<SaveState>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api('POST', '/auth/change-password', { body: { current_password: cur, new_password: next } }),
    onMutate: () => { setState('saving'); setMessage(null); },
    onSuccess: () => { setState('saved'); setCur(''); setNext(''); setMessage('رمز تغییر کرد؛ نشست‌های دیگر شما باطل شدند'); },
    onError: (e) => { setState('failed'); setMessage(errorInfo(e).fields.current_password ?? errorInfo(e).message); },
  });
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <h1>تغییر رمز</h1>
      {message && <div className={`alert ${state === 'failed' ? 'danger' : 'ok'}`}>{message}</div>}
      <Field label="رمز فعلی" required><input dir="ltr" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>
      <Field label="رمز جدید (حداقل ۸ نویسه)" required><input dir="ltr" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} required /></Field>
      <div className="row between"><SaveStatus state={state} /><button className="btn primary" disabled={m.isPending}>ثبت</button></div>
    </form>
  );
}
