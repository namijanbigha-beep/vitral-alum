import { API } from '../api/client.js';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { formatNumber, toPersianDigits } from '@vitral/shared';

const fa = (s: unknown) => toPersianDigits(String(s ?? ''));
const kg = (v: unknown) => (v == null ? '—' : (formatNumber(String(v), 'weight') ?? '—'));

/** Guest page for share links (/s/:token): no login, no money, read-only; photos through the token-scoped file route. */
export function PublicSharePage() {
  const { token = '' } = useParams();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { fetch(`${API}/public/share/${token}`).then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error?.message ?? 'لینک نامعتبر'); return r.json(); }).then(setData).catch((e) => setErr(e.message)); }, [token]);
  const img = (id: string) => `${API}/public/share/${token}/files/${id}`;
  if (err) return <div className="login"><div className="card center"><h1>ویترال</h1><p className="alert danger">{err}</p></div></div>;
  if (!data) return <div className="login"><p className="muted">…</p></div>;
  const photos = (data.photos as Array<Record<string, unknown>>) ?? [];
  return (
    <div className="main stack" style={{ paddingBottom: '2rem' }}>
      <header className="row between"><b>ویترال آلومینیوم</b><span className="muted">اعتبار تا {fa(String(data.expires_at).slice(0, 10))}</span></header>
      {data.scope === 'daily_report' && (() => { const p = data.production as { text: string; text_full: string }; const tr = (data.transfers as Array<Record<string, unknown>>) ?? []; return <>
        <h1>گزارش روز {fa(String(data.date))}</h1>
        <pre className="report">{p.text_full}</pre>
        {tr.length > 0 && <div className="card"><h2>بارها</h2>{tr.map((t) => <div key={String(t.id)}>{fa(String(t.number))} · {String(t.from_name ?? '')} ← {String(t.to_name ?? '')} · {kg(t.kg)} کیلو</div>)}</div>}
      </>; })()}
      {data.scope === 'bundle_gallery' && (() => { const b = data.bundle as Record<string, unknown>; const lines = (b.lines as Array<Record<string, unknown>>) ?? []; return <>
        <h1>بندیل {fa(String(b.code))}</h1>
        <div className="card"><div>وزن: <b>{kg(b.weight_kg)} کیلو</b> · {String(b.form)}{b.color ? ` · ${String(b.color)}` : ''}</div>{b.factory_name ? <div className="muted">{String(b.factory_name)}</div> : null}{lines.map((l, i) => <div key={i}>{String(l.product_code ?? '')} {String(l.product_name)}{l.bars ? ` · ${fa(l.bars)} شاخه` : ''}{l.length_m ? ` · ${fa(l.length_m)} متر` : ''}</div>)}</div>
      </>; })()}
      {data.scope === 'document' && (() => { const d = data.document as Record<string, unknown>; const lines = (d.lines as Array<Record<string, unknown>>) ?? []; return <>
        <h1>{d.kind === 'invoice' ? 'فاکتور' : 'برگشت فروش'} {fa(String(d.number))}</h1>
        <div className="card"><div>{String(d.party_name ?? '')} · {fa(String(d.date).slice(0, 10))}</div><table className="table"><thead><tr><th>شرح</th><th>تعداد</th><th>قیمت</th><th>مبلغ</th></tr></thead><tbody>{lines.map((l, i) => <tr key={i}><td>{String(l.description)}</td><td>{l.qty ? fa(formatNumber(String(l.qty))) : '—'} {String(l.unit ?? '')}</td><td>{l.unit_price ? fa(formatNumber(String(l.unit_price))) : '—'}</td><td>{fa(formatNumber(String(l.amount)))}</td></tr>)}</tbody></table><div><b>جمع: {fa(formatNumber(String(d.amount)))} {String(d.currency)}</b></div>{data.pdf_file_id ? <a className="btn" href={img(String(data.pdf_file_id))} target="_blank" rel="noreferrer">دانلود PDF</a> : null}</div>
      </>; })()}
      {photos.length > 0 && <div className="gallery">{photos.map((p) => <figure key={String(p.id)}><a href={img(String(p.id))} target="_blank" rel="noreferrer"><img src={`${img(String(p.id))}?thumb=1`} alt="" loading="lazy" /></a><figcaption>{String(p.auto_caption ?? p.caption ?? '')}</figcaption></figure>)}</div>}
    </div>
  );
}
