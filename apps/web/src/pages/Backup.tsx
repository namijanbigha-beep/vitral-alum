import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client.js';
import { errorInfo, Field } from '../components/forms.js';
import { fa, faDateTime } from '../lib/format.js';

interface BackupInfo {
  backups: Array<{ name: string; size: string; modified_at: string }>;
  backup_dir_available: boolean;
  encryption_configured: boolean;
  restore_tests: Array<{ tested_at: string; duration_minutes: number; result: 'ok' | 'failed'; note?: string; recorded_at: string }>;
}

const mb = (bytes: string) => fa((Number(bytes) / 1_048_576).toFixed(1));

export function BackupPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['backup'], queryFn: () => api<BackupInfo>('GET', '/backup') });
  const [minutes, setMinutes] = useState('');
  const [result, setResult] = useState<'ok' | 'failed'>('ok');
  const [note, setNote] = useState('');
  const log = useMutation({
    mutationFn: () => api('POST', '/backup/restore-test', { body: { tested_at: new Date().toISOString(), duration_minutes: Number(minutes), result, note: note || undefined } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['backup'] }); setMinutes(''); setNote(''); },
  });
  const d = q.data;
  return (
    <div className="stack">
      <h1>پشتیبان</h1>
      {q.error && <div className="alert danger">{errorInfo(q.error).message}</div>}
      {d && !d.encryption_configured && <div className="alert warn">کلید رمزگذاری پشتیبان (BACKUP_ENCRYPTION_KEY) روی سرور تنظیم نشده است.</div>}
      <div className="card">
        <h2>پشتیبان‌های موجود</h2>
        <p className="muted">پشتیبان روزانه خودکار با <code dir="ltr">ops/backup.sh</code> گرفته می‌شود (۷ روزانه، ۴ هفتگی، ۳ ماهانه). خروجی دستی شامل مدارک در فاز بعد.</p>
        {d?.backups.length === 0 && <p className="muted">{d.backup_dir_available ? 'هنوز پشتیبانی گرفته نشده است.' : 'پوشه پشتیبان روی این سرور در دسترس نیست.'}</p>}
        <div className="list">
          {d?.backups.map((b) => (
            <div className="item" key={b.name}>
              <div className="grow"><div className="title" dir="ltr" style={{ textAlign: 'end' }}>{b.name}</div><div className="muted">{faDateTime(b.modified_at)}</div></div>
              <span className="badge">{mb(b.size)} مگابایت</span>
            </div>
          ))}
        </div>
      </div>
      <form className="card" onSubmit={(e) => { e.preventDefault(); log.mutate(); }}>
        <h2>ثبت آزمون بازیابی ماهانه</h2>
        <Field label="مدت بازیابی" required unit="دقیقه"><input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} required /></Field>
        <Field label="نتیجه" required>
          <select value={result} onChange={(e) => setResult(e.target.value as 'ok' | 'failed')}><option value="ok">موفق</option><option value="failed">ناموفق</option></select>
        </Field>
        <Field label="توضیح"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {log.error && <div className="alert danger">{errorInfo(log.error).message}</div>}
        <button className="btn primary" disabled={log.isPending}>ثبت</button>
      </form>
      <div className="card">
        <h2>سابقه آزمون بازیابی</h2>
        {d?.restore_tests.length === 0 && <p className="muted">هنوز آزمونی ثبت نشده است.</p>}
        <div className="list">
          {d?.restore_tests.map((r, i) => (
            <div className="item" key={i}>
              <div className="grow"><div className="title">{faDateTime(r.tested_at)}</div><div className="muted">{fa(r.duration_minutes)} دقیقه{r.note ? ` · ${r.note}` : ''}</div></div>
              <span className={`badge ${r.result === 'ok' ? 'ok' : 'danger'}`}>{r.result === 'ok' ? 'موفق' : 'ناموفق'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
