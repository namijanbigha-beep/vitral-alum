import type { InputHTMLAttributes, ReactNode } from 'react';
import { ApiRequestError } from '../api/client.js';

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export function Field({
  label,
  required,
  error,
  unit,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string | undefined;
  unit?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {required && <b className="req">*</b>}
      </span>
      {unit ? (
        <div className="unit">
          {children}
          <span>{unit}</span>
        </div>
      ) : (
        children
      )}
      {error && <div className="error">{error}</div>}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />;
}

export function SaveStatus({ state, onRetry }: { state: SaveState; onRetry?: () => void }) {
  if (state === 'idle') return <div className="save-state" />;
  if (state === 'saving') return <div className="save-state">در حال ذخیره…</div>;
  if (state === 'saved') return <div className="save-state saved">ذخیره شد</div>;
  return (
    <div className="save-state failed">
      ثبت نشد{' '}
      {onRetry && (
        <button type="button" className="btn" style={{ minHeight: 32, padding: '0 0.6rem' }} onClick={onRetry}>
          تلاش مجدد
        </button>
      )}
    </div>
  );
}

export function errorInfo(e: unknown): { message: string; fields: Record<string, string>; conflict: boolean } {
  if (e instanceof ApiRequestError) {
    return { message: e.body.message, fields: e.body.fields ?? {}, conflict: e.status === 409 };
  }
  return { message: 'خطای ناشناخته', fields: {}, conflict: false };
}
