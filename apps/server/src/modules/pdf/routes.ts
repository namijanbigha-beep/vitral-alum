import type { FastifyInstance, FastifyReply } from 'fastify';
import { Dec, round, type Currency } from '@vitral/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Db, Trx } from '../../db/index.js';
import { audit } from '../../lib/audit.js';
import { can, requirePermission, requireUser, type AuthUser } from '../../lib/auth.js';
import { dateOnly, idParam } from '../../lib/crud.js';
import { AppError } from '../../lib/errors.js';
import { getSettings } from '../../lib/settings.js';
import { sha256 } from '../files/service.js';
import { partyStatement } from '../money/routes.js';
import { lineAmount } from '../../rules/money.js';
import { lineBasisQty, loadLines, orderTotals, postedReceiptsForOrder } from '../orders/service.js';
import { loadFontCss, renderPdf } from './render.js';
import { bundleLabelHtml, commercialInvoiceHtml, packingListHtml, saleDocumentHtml, statementHtml, type DocMeta, type SaleDoc, type SaleLine, type Seller } from './templates.js';

const fmt = z.object({ format: z.enum(['pdf', 'png', 'html']).default('pdf'), lang: z.enum(['fa', 'ar']).default('fa') });
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

async function sellerInfo(db: Db, storage: AppContext['storage']): Promise<Seller> {
  const s = await getSettings(db, ['seller_name_fa', 'seller_name_ar', 'seller_name_en', 'seller_address_fa', 'seller_address_ar', 'seller_address_en', 'seller_phone', 'seller_logo_file_id']);
  const logo = typeof s.seller_logo_file_id === 'string' ? await fileDataUri(db, storage, s.seller_logo_file_id, false) : null;
  return { name: (s.seller_name_fa as string) ?? 'ویترال آلومینیوم', name_ar: s.seller_name_ar as string | null, name_en: s.seller_name_en as string | null, address: s.seller_address_fa as string | null, address_ar: s.seller_address_ar as string | null, address_en: s.seller_address_en as string | null, phone: s.seller_phone as string | null, logo };
}

async function fileDataUri(db: Db | Trx, storage: AppContext['storage'], fileId: string, thumb = true): Promise<string | null> {
  const f = await db.selectFrom('files').select(['storage_key', 'thumb_key', 'mime']).where('id', '=', fileId).executeTakeFirst();
  if (!f || !f.mime.startsWith('image/')) return null;
  try {
    const buf = await storage.read((thumb && f.thumb_key) || f.storage_key);
    return `data:${thumb && f.thumb_key ? 'image/jpeg' : f.mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

export function pdfRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, storage, config } = ctx;
  const meta = (user: AuthUser, version: number, printCount: number, draft: boolean): DocMeta => ({ env: config.NODE_ENV, version, issued_by: user.name, print_count: printCount, draft });

  /**
   * Render and respond. `onPdf` (archive + print counter) runs BEFORE the body is sent: the inject/HTTP response must not
   * resolve while the archive transaction is still open, and a failed archive must surface as an error, not a silent print.
   */
  async function send(reply: FastifyReply, html: string, format: 'pdf' | 'png' | 'html', filename: string, onPdf?: (pdf: Buffer) => Promise<void>): Promise<void> {
    if (format === 'html') { reply.header('Content-Security-Policy', PREVIEW_CSP).type('text/html; charset=utf-8').send(html); return; }
    const r = await renderPdf(config, html, format === 'png');
    if (onPdf) await onPdf(r.pdf);
    const body = format === 'png' ? r.png! : r.pdf;
    reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}.${format}"`).type(format === 'png' ? 'image/png' : 'application/pdf').send(body);
  }

  /** Archive the PDF in `files` (kind document_pdf) and bump the print counter; never creates a financial document (T48). */
  async function archive(entity: 'orders' | 'documents' | 'transfers', id: string, pdf: Buffer, name: string, user: AuthUser): Promise<void> {
    const key = await storage.put(pdf);
    await db.transaction().execute(async (trx) => {
      const f = await trx.insertInto('files').values({ storage_key: key, thumb_key: null, original_name: name, mime: 'application/pdf', size: pdf.length, sha256: sha256(pdf), kind: 'document_pdf', caption: null, sensitive: false, owner_entity: entity, owner_id: id, sort_order: 0, created_by: user.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('file_links').values({ file_id: f.id, entity, entity_id: id, created_by: user.id }).execute();
      await trx.updateTable(entity).set({ print_count: sql`print_count + 1` }).where('id', '=', id).execute();
      await audit(trx, { userId: user.id, entity, entityId: id, action: 'print', after: { file_id: f.id, name } });
    });
  }

  // ── Proforma (from the order; no financial document) ─────────────────────────
  app.get('/orders/:id/proforma', async (req, reply) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const q = fmt.parse(req.query);
    const order = await db.selectFrom('orders').selectAll().where('id', '=', id).executeTakeFirst();
    if (!order) throw new AppError('not_found');
    const [lines, party, seller, paid, fontCss, settings] = await Promise.all([loadLines(db, id), db.selectFrom('parties').select(['name', 'name_ar', 'phones', 'address', 'city']).where('id', '=', order.party_id).executeTakeFirstOrThrow(), sellerInfo(db, storage), postedReceiptsForOrder(db, id), loadFontCss(config), getSettings(db, ['sales_terms_fa', 'sales_terms_ar', 'proforma_validity_text', 'default_prepay_percent'])]);
    const totals = orderTotals(order, lines, paid);
    const cur = order.currency as Currency;
    const saleLines: SaleLine[] = [];
    let missingAr = false;
    for (const l of lines) {
      if (q.lang === 'ar' && l.kind === 'profile' && !l.name_ar && !l.product_name_ar) missingAr = true;
      saleLines.push({
        code: l.product_code, name: l.kind === 'profile' ? (l.product_name ?? l.description ?? '') : (l.description ?? l.kind), name_ar: l.name_ar ?? l.product_name_ar, name_en: l.name_en,
        image: l.product_file_id ? await fileDataUri(db, storage, l.product_file_id) : null, filler_mm: l.filler_mm, length_m: l.length_m, die_code: l.die_id ? (await db.selectFrom('dies').select('code').where('id', '=', l.die_id).executeTakeFirst())?.code ?? null : null,
        kind: l.kind, color: l.color, load_type: l.load_type_label, gpm: l.weight_g_per_m, qty: lineBasisQty(l), qty_unit: l.price_basis === 'per_kg' ? 'kg' : l.price_basis === 'per_piece' ? 'piece' : l.price_basis === 'per_bar' ? 'bar' : 'm',
        unit_price: l.unit_price, price_basis: l.price_basis, currency: l.currency as Currency, amount: lineAmount(lineBasisQty(l), l.unit_price, l.currency as Currency, l.discount_amount, l.discount_percent), vat_rate: l.vat_rate, vat_amount: l.vat_amount,
      });
    }
    const prepayPercent = order.prepay_percent ?? (settings.default_prepay_percent as string | null);
    const doc: SaleDoc = {
      kind: 'proforma', number: order.number, date: order.order_date, seller, buyer: { name: party.name, name_ar: party.name_ar, phone: (party.phones as string[] | null)?.[0] ?? null, address: [party.city, party.address].filter(Boolean).join('، ') || null },
      lines: saleLines, currency: cur, totals: totals.totals, total_kg: totals.total_kg, terms: order.payment_terms as 'cash' | 'credit', prepay_percent: prepayPercent, prepay_amount: totals.prepay[cur] ?? order.prepay_amount, paid: totals.paid[cur] ?? '0', remaining: totals.remaining[cur] ?? totals.totals[cur] ?? null,
      validity: order.validity_text ?? (settings.proforma_validity_text as string | null), notes: order.invoice_notes ?? (settings[q.lang === 'ar' ? 'sales_terms_ar' : 'sales_terms_fa'] as string | null), delivery_days: order.delivery_days, incomplete: totals.incomplete, missing_ar: missingAr,
      meta: meta(me, order.revision, order.print_count + 1, order.status_sales === 'draft'),
    };
    const html = saleDocumentHtml(doc, q.lang, fontCss);
    await send(reply, html, q.format, `proforma-${order.number}-${q.lang}`, (pdf) => archive('orders', id, pdf, `proforma-${order.number}-${q.lang}-v${order.revision}.pdf`, me));
    return reply;
  });

  // ── Invoice / credit note PDF from a financial document ──────────────────────
  app.get('/documents/:id/pdf', async (req, reply) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const q = fmt.parse(req.query);
    const d = await db.selectFrom('documents').selectAll().where('id', '=', id).executeTakeFirst();
    if (!d) throw new AppError('not_found');
    if (d.kind !== 'invoice' && d.kind !== 'sales_return') throw new AppError('validation', 'فقط فاکتور فروش و برگشت فروش چاپ می‌شوند');
    if (!d.party_id) throw new AppError('validation', 'سند طرف حساب ندارد');
    const [lines, party, seller, fontCss, settings, transfer] = await Promise.all([
      db.selectFrom('document_lines').leftJoin('order_lines', 'order_lines.id', 'document_lines.order_line_id').leftJoin('products', 'products.id', 'order_lines.product_id').selectAll('document_lines').select(['products.code as product_code', 'products.name_ar as product_name_ar', 'products.main_file_id as product_file_id', 'order_lines.filler_mm', 'order_lines.length_m', 'order_lines.color', 'order_lines.load_type_label', 'order_lines.weight_g_per_m', 'order_lines.price_basis', 'order_lines.name_ar', 'order_lines.kind as line_kind']).where('document_id', '=', id).orderBy('document_lines.sort').execute(),
      db.selectFrom('parties').select(['name', 'name_ar', 'phones', 'address', 'city']).where('id', '=', d.party_id).executeTakeFirstOrThrow(), sellerInfo(db, storage), loadFontCss(config), getSettings(db, ['sales_terms_fa', 'sales_terms_ar']),
      d.transfer_id ? db.selectFrom('transfers').select('number').where('id', '=', d.transfer_id).executeTakeFirst() : null,
    ]);
    const cur = d.currency as Currency;
    const paidRows = await db.selectFrom('allocations').innerJoin('documents as src', 'src.id', 'allocations.from_document_id').select((eb) => eb.fn.sum<string>('allocations.amount').as('s')).where('allocations.to_document_id', '=', id).where('src.status', '=', 'posted').executeTakeFirst();
    const paid = round(new Dec(paidRows?.s ?? 0), cur);
    const totalKg = lines.reduce((a, l) => (l.unit === 'kg' && l.qty ? a.plus(l.qty) : a), new Dec(0));
    const doc: SaleDoc = {
      kind: d.kind === 'invoice' ? 'invoice' : 'credit', number: d.number, date: d.date, seller, buyer: { name: party.name, name_ar: party.name_ar, phone: (party.phones as string[] | null)?.[0] ?? null, address: [party.city, party.address].filter(Boolean).join('، ') || null },
      lines: lines.map((l): SaleLine => ({ code: l.product_code, name: l.description, name_ar: l.name_ar ?? l.product_name_ar, kind: l.line_kind ?? 'service', filler_mm: l.filler_mm, length_m: l.length_m, color: l.color, load_type: l.load_type_label, gpm: l.weight_g_per_m, qty: l.qty, qty_unit: l.unit === 'kg' ? 'kg' : l.unit === 'piece' ? 'piece' : l.unit === 'bar' ? 'bar' : 'm', unit_price: l.unit_price, price_basis: l.price_basis ?? (l.unit === 'kg' ? 'per_kg' : 'per_piece'), currency: cur, amount: l.amount, vat_rate: l.vat_rate, vat_amount: l.vat_amount })),
      currency: cur, totals: { [cur]: round(new Dec(d.amount ?? 0), cur) }, total_kg: round(totalKg, 'weight'), terms: 'cash', paid, remaining: round(new Dec(d.amount ?? 0).minus(paid), cur),
      notes: settings[q.lang === 'ar' ? 'sales_terms_ar' : 'sales_terms_fa'] as string | null, shipment_ref: transfer?.number ?? null, settlement_kg: d.settlement_basis_kg,
      meta: meta(me, d.version, d.print_count + 1, d.status !== 'posted'),
    };
    const html = saleDocumentHtml(doc, q.lang, fontCss);
    await send(reply, html, q.format, `${d.kind}-${d.number}-${q.lang}`, (pdf) => archive('documents', id, pdf, `${d.kind}-${d.number}-${q.lang}.pdf`, me));
    return reply;
  });

  // ── Packing list & commercial invoice from a transfer ────────────────────────
  async function transferContext(id: string) {
    const t = await db.selectFrom('transfers').selectAll().where('id', '=', id).executeTakeFirst();
    if (!t) throw new AppError('not_found');
    const [from, to, packing, seller, fontCss] = await Promise.all([
      t.from_location_id ? db.selectFrom('locations').select('name').where('id', '=', t.from_location_id).executeTakeFirst() : null,
      t.to_location_id ? db.selectFrom('locations').leftJoin('parties', 'parties.id', 'locations.party_id').select(['locations.name', 'parties.name as party_name', 'parties.name_ar as party_name_ar', 'parties.address', 'parties.id as party_id']).where('locations.id', '=', t.to_location_id).executeTakeFirst() : null,
      db.selectFrom('packing_lines').leftJoin('products', 'products.id', 'packing_lines.product_id').selectAll('packing_lines').select(['products.name_fa', 'products.name_ar', 'products.name_en']).where('transfer_id', '=', id).orderBy('packing_lines.sort').execute(),
      sellerInfo(db, storage), loadFontCss(config),
    ]);
    return { t, from, to, packing, seller, fontCss };
  }

  app.get('/transfers/:id/packing-list', async (req, reply) => {
    const me = requireUser(req);
    const { id } = idParam.parse(req.params);
    const q = fmt.parse(req.query);
    const { t, from, to, packing, seller, fontCss } = await transferContext(id);
    if (packing.length === 0) throw new AppError('validation', 'لیست بسته‌بندی خالی است؛ ابتدا ریز بار را ثبت کنید');
    const dispatcher = t.dispatched_by ? await db.selectFrom('users').select(['name', 'short_name']).where('id', '=', t.dispatched_by).executeTakeFirst() : null;
    const html = packingListHtml({
      number: t.number, date: t.departed_at ?? t.created_at, from: from?.name ?? null, to: to?.party_name ?? to?.name ?? null, responsible: dispatcher?.short_name ?? dispatcher?.name ?? null, driver: t.driver_name, plate: t.plate, seller,
      lines: packing.map((p) => ({ product: p.name_fa ?? p.description ?? '—', product_ar: p.name_ar, product_en: p.name_en, filler_mm: p.filler_mm, color: p.color, length_m: p.length_m, packages: p.packages, bars_per_package: p.bars_per_package, bars: p.bars, weight_kg: p.weight_kg, gross_kg: p.gross_kg, weight_mode: p.weight_mode, is_partial: p.is_partial })),
      meta: meta(me, t.version, t.print_count + 1, t.status === 'draft'), incomplete_date: !t.departed_at,
    }, fontCss);
    await send(reply, html, q.format, `packing-${t.number}`, (pdf) => archive('transfers', id, pdf, `packing-${t.number}.pdf`, me));
    return reply;
  });

  app.get('/transfers/:id/commercial-invoice', async (req, reply) => {
    const me = requirePermission(req, 'finance.view');
    const { id } = idParam.parse(req.params);
    const q = fmt.parse(req.query);
    const { t, to, packing, seller, fontCss } = await transferContext(id);
    const billTo = t.bill_to_party_id ? await db.selectFrom('parties').select(['name', 'name_ar', 'address']).where('id', '=', t.bill_to_party_id).executeTakeFirst() : null;
    const buyer = billTo ?? { name: to?.party_name ?? to?.name ?? '—', name_ar: to?.party_name_ar ?? null, address: to?.address ?? null };
    // Prices come from the orders on this transfer (per product + line); fall back to unpriced rows.
    const priced = t.order_ids.length ? await db.selectFrom('order_lines').select(['id', 'product_id', 'unit_price', 'currency', 'price_basis']).where('order_id', 'in', t.order_ids).execute() : [];
    const cur = (priced[0]?.currency ?? 'USD') as Currency;
    let total = new Dec(0);
    const lines = packing.map((p) => {
      const ol = priced.find((x) => x.id === p.order_line_id) ?? priced.find((x) => x.product_id === p.product_id && x.price_basis === 'per_kg');
      const amount = ol?.unit_price && p.weight_kg ? round(new Dec(ol.unit_price).mul(p.weight_kg), cur) : null;
      if (amount) total = total.plus(amount);
      return { description: p.name_en ?? p.name_fa ?? p.description ?? '—', description_ar: p.name_ar, net_kg: p.weight_kg, gross_kg: p.gross_kg, packages: p.packages, unit_price: ol?.unit_price ?? null, amount };
    });
    const html = commercialInvoiceHtml({ number: t.number, date: t.departed_at ?? t.created_at, seller, buyer, consignee: t.consignee, delivery_term: t.delivery_term, border: t.border, currency: cur, lines, total: round(total, cur), meta: meta(me, t.version, t.print_count + 1, t.status === 'draft') }, fontCss);
    await send(reply, html, q.format, `commercial-invoice-${t.number}`, (pdf) => archive('transfers', id, pdf, `commercial-invoice-${t.number}.pdf`, me));
    return reply;
  });

  // ── Party statement ──────────────────────────────────────────────────────────
  app.get('/parties/:id/statement.pdf', async (req, reply) => {
    const me = requirePermission(req, 'finance.view');
    const { id } = idParam.parse(req.params);
    const q = fmt.extend({ from: dateOnly.optional(), to: dateOnly.optional() }).parse(req.query);
    const party = await db.selectFrom('parties').select(['name', 'name_ar', 'phones', 'address', 'roles']).where('id', '=', id).executeTakeFirst();
    if (!party) throw new AppError('not_found');
    const st = await partyStatement(db, id, q.from ? new Date(q.from) : undefined, q.to ? new Date(new Date(q.to).getTime() + 86_400_000) : undefined);
    const [seller, fontCss] = await Promise.all([sellerInfo(db, storage), loadFontCss(config)]);
    const roles = party.roles as string[];
    const html = statementHtml({ party: { name: party.name, name_ar: party.name_ar, phone: (party.phones as string[] | null)?.[0] ?? null, address: party.address }, seller, from: q.from ?? null, to: q.to ?? null, ...st, meta: meta(me, 1, 1, false), workshop: roles.includes('factory') || roles.includes('painter') }, q.lang, fontCss);
    await send(reply, html, q.format, `statement-${party.name}`);
    return reply;
  });

  // ── Bundle label (A6) ────────────────────────────────────────────────────────
  app.get('/bundles/:id/label', async (req, reply) => {
    requireUser(req);
    const { id } = idParam.parse(req.params);
    const q = fmt.parse(req.query);
    const b = await db.selectFrom('bundles').selectAll().where('id', '=', id).executeTakeFirst();
    if (!b) throw new AppError('not_found');
    const line = await db.selectFrom('bundle_lines').innerJoin('products', 'products.id', 'bundle_lines.product_id').select(['products.name_fa', 'bundle_lines.filler_mm', 'bundle_lines.length_m', 'bundle_lines.bars']).where('bundle_id', '=', id).orderBy('bundle_lines.sort').execute();
    const bars = line.reduce((a, l) => a + (l.bars ?? 0), 0);
    const totalM = line.reduce((a, l) => (l.bars && l.length_m ? a.plus(new Dec(l.bars).mul(l.length_m)) : a), new Dec(0));
    const gpm = totalM.gt(0) ? round(new Dec(b.weight_kg).mul(1000).div(totalM), 'g_per_m') : null;
    const fontCss = await loadFontCss(config);
    const html = bundleLabelHtml({ code: b.code, product: [...new Set(line.map((l) => l.name_fa))].join(' / ') || '—', filler_mm: line[0]?.filler_mm ?? null, length_m: line[0]?.length_m ?? null, bars: bars || null, weight_kg: b.weight_kg, g_per_m: gpm, reported_at: b.reported_at, url: config.PUBLIC_URL ? `${config.PUBLIC_URL}/bundles/${b.id}` : null }, fontCss);
    await send(reply, html, q.format, `label-${b.code}`);
    return reply;
  });

  // Confidential guard: cost-kind PDFs are never produced; invoice PDF is allowed for everyone who can see the document list.
  void can;
}
