import { useState, type FormEvent } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../lib/auth.js';
import { errorInfo, Field } from '../components/forms.js';

export function LoginPage() {
  const { refresh } = useAuth();
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/login', { body: { mobile, password } });
      await refresh();
    } catch (err) {
      setError(errorInfo(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card stack" onSubmit={submit}>
        <h1 className="center">ورود به ویترال</h1>
        <Field label="شماره موبایل" required>
          <input dir="ltr" inputMode="tel" autoComplete="username" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="۰۹۱۲۳۴۵۶۷۸۹" required />
        </Field>
        <Field label="رمز" required>
          <input dir="ltr" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error && <div className="alert danger" role="alert">{error}</div>}
        <button className="btn primary block" disabled={busy}>
          {busy ? 'در حال ورود…' : 'ورود'}
        </button>
      </form>
    </div>
  );
}
