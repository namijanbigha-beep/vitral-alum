import { amountToArabicWords, amountToPersianWords, Dec, formatJalali, formatNumber, jalaliOf, toPersianDigits, type Currency } from '@vitral/shared';
import { baseCss, esc } from './render.js';

export type Lang = 'fa' | 'ar' | 'en';

const L: Record<string, Record<Lang, string>> = {
  proforma: { fa: 'پیش فاکتور فروش', ar: 'فاتورة أولية للبيع', en: 'Proforma Invoice' }, invoice: { fa: 'فاکتور فروش', ar: 'فاتورة بيع', en: 'Invoice' }, credit: { fa: 'اشعار برگشت', ar: 'إشعار دائن', en: 'Credit Note' },
  seller: { fa: 'مشخصات فروشنده', ar: 'بيانات البائع', en: 'Seller' }, buyer: { fa: 'مشخصات مشتری', ar: 'بيانات العميل', en: 'Buyer' }, seller_name: { fa: 'نام فروشنده', ar: 'اسم البائع', en: 'Seller name' }, buyer_name: { fa: 'نام خریدار', ar: 'اسم المشتري', en: 'Buyer name' },
  phone: { fa: 'تلفن', ar: 'الهاتف', en: 'Phone' }, address: { fa: 'نشانی', ar: 'العنوان', en: 'Address' }, goods: { fa: 'مشخصات کالا', ar: 'تفاصيل البضاعة', en: 'Goods' }, number: { fa: 'شماره', ar: 'الرقم', en: 'No.' }, date: { fa: 'تاریخ', ar: 'التاريخ', en: 'Date' },
  row: { fa: 'ردیف', ar: 'م', en: '#' }, code: { fa: 'کد', ar: 'الرمز', en: 'Code' }, desc: { fa: 'شرح کالا', ar: 'وصف البضاعة', en: 'Description' }, color: { fa: 'رنگ', ar: 'اللون', en: 'Colour' }, load_type: { fa: 'نوع بار', ar: 'نوع البضاعة', en: 'Type' }, gpm: { fa: 'وزن هر متر (گرم)', ar: 'وزن المتر (غرام)', en: 'g/m' },
  qty: { fa: 'مقدار', ar: 'الكمية', en: 'Quantity' }, unit_price: { fa: 'مبلغ واحد', ar: 'سعر الوحدة', en: 'Unit price' }, total: { fa: 'مبلغ کل', ar: 'الإجمالي', en: 'Total' }, filler: { fa: 'فیلر', ar: 'سُمك الجدار', en: 'Wall' }, length: { fa: 'طول', ar: 'الطول', en: 'Length' }, per_kg: { fa: 'هر کیلوگرم', ar: 'لكل كيلوغرام', en: 'per kg' },
  die_making: { fa: 'ساخت قالب', ar: 'تصنيع قالب', en: 'Die making' }, from_die: { fa: 'از قالب', ar: 'من القالب', en: 'From die' }, sum: { fa: 'جمع کل', ar: 'المجموع', en: 'Total' }, prepay: { fa: 'پیش‌پرداخت', ar: 'الدفعة المقدمة', en: 'Prepayment' }, paid: { fa: 'پرداخت شده', ar: 'المدفوع', en: 'Paid' }, remaining: { fa: 'باقیمانده', ar: 'المتبقي', en: 'Balance' },
  terms: { fa: 'شرایط فروش', ar: 'شروط البيع', en: 'Terms' }, validity: { fa: 'مدت اعتبار پیش‌فاکتور', ar: 'صلاحية الفاتورة الأولية', en: 'Validity' }, notes: { fa: 'توضیحات', ar: 'ملاحظات', en: 'Notes' }, seller_sign: { fa: 'مهر و امضای فروشنده', ar: 'ختم وتوقيع البائع', en: 'Seller stamp & signature' }, buyer_sign: { fa: 'مهر و امضای خریدار', ar: 'ختم وتوقيع المشتري', en: 'Buyer stamp & signature' },
  page: { fa: 'صفحه', ar: 'صفحة', en: 'Page' }, cont: { fa: 'ادامه اقلام در صفحه بعد', ar: 'تتمة في الصفحة التالية', en: 'Continued on next page' }, cash: { fa: 'نقدی', ar: 'نقداً', en: 'Cash' }, credit_terms: { fa: 'اعتباری', ar: 'بالأجل', en: 'Credit' }, sum_qty: { fa: 'جمع مقدار', ar: 'مجموع الكمية', en: 'Total quantity' },
  words: { fa: 'جمع کل به حروف', ar: 'المجموع بالحروف', en: 'Amount in words' }, kg: { fa: 'کیلوگرم', ar: 'كغ', en: 'kg' }, piece: { fa: 'عدد', ar: 'قطعة', en: 'pc' }, bar: { fa: 'شاخه', ar: 'قضيب', en: 'bar' }, mm: { fa: 'میلی‌متر', ar: 'مم', en: 'mm' }, m: { fa: 'متر', ar: 'م', en: 'm' }, shamsi: { fa: '', ar: 'هجري شمسي', en: 'Jalali' },
  vat: { fa: 'مالیات', ar: 'الضريبة', en: 'VAT' }, delivery_ref: { fa: 'ارجاع به محموله', ar: 'إشارة إلى الشحنة', en: 'Shipment ref.' }, settle_kg: { fa: 'وزن مبنای تسویه', ar: 'وزن التسوية', en: 'Settlement weight' }, draft: { fa: 'پیش‌نویس', ar: 'مسودة', en: 'DRAFT' }, version: { fa: 'نسخه', ar: 'النسخة', en: 'Rev.' }, issued_by: { fa: 'صادرکننده', ar: 'أصدرها', en: 'Issued by' }, print: { fa: 'چاپ', ar: 'طباعة', en: 'Print' },
};
const CUR: Record<Currency, Record<Lang, string>> = { TOMAN: { fa: 'تومان', ar: 'تومان', en: 'Toman' }, USD: { fa: 'دلار', ar: 'دولار أمريكي', en: 'USD' }, IQD: { fa: 'دینار عراقی', ar: 'دينار عراقي', en: 'IQD' } };
const t = (k: string, lang: Lang) => L[k]?.[lang] ?? k;
const n = (v: unknown, kind?: Parameters<typeof formatNumber>[1]) => (v === null || v === undefined ? '—' : formatNumber(String(v), kind) ?? '—');
const jd = (d: Date | string | null | undefined) => (d ? toPersianDigits(formatJalali(jalaliOf(new Date(d)))) : '—');
const words = (amount: string, cur: Currency, lang: Lang) => (lang === 'ar' ? amountToArabicWords(amount, cur) : amountToPersianWords(amount, cur));

export interface Seller { name: string; name_ar?: string | null; name_en?: string | null; phone?: string | null; address?: string | null; address_ar?: string | null; address_en?: string | null; logo?: string | null }
export interface DocMeta { env: string; version: number; issued_by: string; print_count: number; draft: boolean }

function head(lang: Lang, seller: Seller, title: string, number: string, date: Date | string | null, meta: DocMeta): string {
  const sellerName = lang === 'ar' ? seller.name_ar || seller.name : lang === 'en' ? seller.name_en || seller.name : seller.name;
  return `<div class="wm">${meta.env !== 'production' ? 'نمونه آزمایشی — سند واقعی نیست' : meta.draft ? t('draft', lang) : ''}</div>
  <div class="head"><div style="display:flex;gap:10px;align-items:center">${seller.logo ? `<img src="${seller.logo}" style="height:46px">` : ''}<div><h1>${esc(sellerName)}</h1><div class="muted">${esc(seller.phone ?? '')}</div></div></div>
  <div style="text-align:center"><h1>${esc(title)}</h1></div>
  <div style="text-align:${lang === 'en' ? 'right' : 'left'}"><div>${t('number', lang)}: <b>${toPersianDigits(esc(number))}</b></div><div>${t('date', lang)}: ${jd(date)} ${lang === 'ar' ? `<span class="muted">(${t('shamsi', lang)})</span>` : ''}</div><div class="muted">${t('version', lang)} ${toPersianDigits(String(meta.version))} · ${t('print', lang)} ${toPersianDigits(String(meta.print_count))} · ${t('issued_by', lang)}: ${esc(meta.issued_by)}</div></div></div>`;
}

function parties(lang: Lang, seller: Seller, buyer: { name: string; name_ar?: string | null; phone?: string | null; address?: string | null }): string {
  const sAddr = lang === 'ar' ? seller.address_ar || seller.address : lang === 'en' ? seller.address_en || seller.address : seller.address;
  const sName = lang === 'ar' ? seller.name_ar || seller.name : lang === 'en' ? seller.name_en || seller.name : seller.name;
  return `<div class="grid2"><div class="box"><b>${t('seller', lang)}</b><div>${t('seller_name', lang)}: ${esc(sName)}</div><div>${t('phone', lang)}: ${toPersianDigits(esc(seller.phone ?? '—'))}</div><div>${t('address', lang)}: ${esc(sAddr ?? '—')}</div></div>
  <div class="box"><b>${t('buyer', lang)}</b><div>${t('buyer_name', lang)}: ${esc(lang === 'ar' ? buyer.name_ar || buyer.name : buyer.name)}</div><div>${t('phone', lang)}: ${toPersianDigits(esc(buyer.phone ?? '—'))}</div><div>${t('address', lang)}: ${esc(buyer.address ?? '—')}</div></div></div>`;
}

export interface SaleLine { code?: string | null; name: string; name_ar?: string | null; name_en?: string | null; image?: string | null; filler_mm?: string | null; length_m?: string | null; die_code?: string | null; kind: string; color?: string | null; load_type?: string | null; gpm?: string | null; qty: string | null; qty_unit: 'kg' | 'piece' | 'bar' | 'm'; unit_price: string | null; price_basis: string; currency: Currency; amount: string | null; vat_rate?: string | null; vat_amount?: string | null }
export interface SaleDoc {
  kind: 'proforma' | 'invoice' | 'credit'; number: string; date: Date | string | null; seller: Seller; buyer: { name: string; name_ar?: string | null; phone?: string | null; address?: string | null };
  lines: SaleLine[]; currency: Currency; totals: Partial<Record<Currency, string>>; total_kg: string; terms: 'cash' | 'credit'; prepay_percent?: string | null; prepay_amount?: string | null; paid?: string | null; remaining?: string | null;
  validity?: string | null; notes?: string | null; delivery_days?: number | null; meta: DocMeta; shipment_ref?: string | null; settlement_kg?: string | null; incomplete?: boolean; missing_ar?: boolean;
}

/** Proforma / invoice / credit note (spec §14 layout, fa & ar). */
export function saleDocumentHtml(d: SaleDoc, lang: 'fa' | 'ar', fontCss: string): string {
  const hasVat = d.lines.some((l) => l.vat_rate && !new Dec(l.vat_rate).isZero());
  const rows = d.lines.map((l, i) => {
    const name = lang === 'ar' ? l.name_ar || l.name : l.name;
    const desc = l.kind === 'die_making' ? `${esc(name)}<div class="muted">${t('die_making', lang)}${l.die_code ? ` ${toPersianDigits(esc(l.die_code))}` : ''}</div>` : `<div style="display:flex;gap:6px;align-items:center">${l.image ? `<img class="img" src="${l.image}">` : ''}<div>${esc(name)}${l.die_code ? `<div class="muted">${t('from_die', lang)}: ${toPersianDigits(esc(l.die_code))}</div>` : ''}${l.filler_mm ? `<div class="muted">${t('filler', lang)}: ${n(l.filler_mm, 'filler')} ${t('mm', lang)}</div>` : ''}${l.length_m ? `<div class="muted">${t('length', lang)}: ${n(l.length_m, 'length')} ${t('m', lang)}</div>` : ''}</div></div>`;
    const qty = l.qty === null ? '—' : l.qty_unit === 'kg' ? `${n(l.qty, 'weight')} ${t('kg', lang)}` : l.qty_unit === 'piece' ? `${n(l.qty)} ${t('piece', lang)}` : `${n(l.qty)} ${t(l.qty_unit, lang)}`;
    const up = l.unit_price === null ? '—' : `${n(l.unit_price, l.currency)} ${CUR[l.currency][lang]} <span class="muted">${l.price_basis === 'per_kg' ? t('per_kg', lang) : l.price_basis === 'per_piece' ? t('piece', lang) : l.price_basis === 'per_bar' ? t('bar', lang) : t('m', lang)}</span>`;
    return `<tr><td class="num">${toPersianDigits(String(i + 1))}</td><td>${toPersianDigits(esc(l.code ?? ''))}</td><td>${desc}</td><td>${esc(l.color ?? '—')}</td><td>${esc(l.load_type ?? '—')}</td><td class="num">${l.gpm ? n(l.gpm, 'g_per_m') : '—'}</td><td class="num">${qty}</td><td class="num">${up}</td>${hasVat ? `<td class="num">${l.vat_amount ? n(l.vat_amount, l.currency) : '—'}</td>` : ''}<td class="num">${l.amount === null ? '—' : `${n(l.amount, l.currency)} ${CUR[l.currency][lang]}`}</td></tr>`;
  }).join('');
  const totals = Object.entries(d.totals).map(([c, v]) => `<div><b>${t('sum', lang)} (${CUR[c as Currency][lang]}):</b> ${n(v, c as Currency)} ${CUR[c as Currency][lang]}</div><div class="words"><b>${t('words', lang)}:</b> ${esc(words(v!, c as Currency, lang))}</div>`).join('');
  const title = t(d.kind, lang);
  const termsText = (d.notes ?? '').split('\n').filter(Boolean).map((x, i) => `<div>${toPersianDigits(String(i + 1))}. ${esc(x.replace(/\{prepay\}/g, d.prepay_percent ?? '۸۰'))}</div>`).join('');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${esc(title)} ${esc(d.number)}</title><style>${baseCss('rtl', fontCss, { watermark: d.meta.draft || d.meta.env !== 'production' ? 'x' : null, footer: `${title} ${d.number} · ${t('version', lang)} ${d.meta.version}` })}</style></head><body>
  ${head(lang, d.seller, title, d.number, d.date, d.meta)}
  ${parties(lang, d.seller, d.buyer)}
  ${d.missing_ar && lang === 'ar' ? `<div class="muted">⚠ بعض أسماء المنتجات بدون ترجمة عربية؛ طُبع الاسم الفارسي.</div>` : ''}
  ${d.shipment_ref ? `<div class="muted">${t('delivery_ref', lang)}: ${toPersianDigits(esc(d.shipment_ref))}${d.settlement_kg ? ` · ${t('settle_kg', lang)}: ${n(d.settlement_kg, 'weight')} ${t('kg', lang)}` : ''}</div>` : ''}
  <h2>${t('goods', lang)}</h2>
  <table><thead><tr><th>${t('row', lang)}</th><th>${t('code', lang)}</th><th style="width:30%">${t('desc', lang)}</th><th>${t('color', lang)}</th><th>${t('load_type', lang)}</th><th>${t('gpm', lang)}</th><th>${t('qty', lang)}</th><th>${t('unit_price', lang)}</th>${hasVat ? `<th>${t('vat', lang)}</th>` : ''}<th>${t('total', lang)}</th></tr></thead><tbody>${rows}</tbody>
  <tfoot><tr><td colspan="${hasVat ? 10 : 9}" class="muted cont">${t('cont', lang)}</td></tr></tfoot></table>
  <div class="box"><div><b>${t('terms', lang)}:</b> ${d.terms === 'cash' ? t('cash', lang) : t('credit_terms', lang)}</div><div><b>${t('sum_qty', lang)}:</b> ${n(d.total_kg, 'weight')} ${t('kg', lang)}</div>${totals}${d.incomplete ? `<div class="muted">${lang === 'ar' ? 'بعض البنود بدون سعر' : 'برخی ردیف‌ها قیمت ندارند'}</div>` : ''}
  ${d.kind === 'proforma' && d.prepay_percent ? `<div><b>${t('prepay', lang)}:</b> ${n(d.prepay_percent, 'percent')}٪ = ${n(d.prepay_amount, d.currency)} ${CUR[d.currency][lang]}</div>` : ''}
  <div><b>${t('paid', lang)}:</b> ${n(d.paid ?? '0', d.currency)} ${CUR[d.currency][lang]} &nbsp; <b>${t('remaining', lang)}:</b> ${n(d.remaining, d.currency)} ${CUR[d.currency][lang]}</div></div>
  ${d.kind === 'proforma' ? `<div><b>${t('validity', lang)}:</b> ${esc(d.validity ?? '—')}</div>` : ''}
  <div class="box"><b>${t('notes', lang)}</b>${termsText}${d.delivery_days != null ? `<div>* ${lang === 'ar' ? 'مدة التسليم بعد الدفعة المقدمة' : 'زمان تحویل پس از پیش‌پرداخت'}: ${toPersianDigits(String(d.delivery_days))} ${lang === 'ar' ? 'يوم عمل' : 'روز کاری'}.</div>` : ''}</div>
  <div class="sig"><div>${t('seller_sign', lang)}</div><div>${t('buyer_sign', lang)}</div></div>
  </body></html>`;
}

export interface PackingDoc { number: string; date: Date | string | null; from: string | null; to: string | null; responsible: string | null; driver: string | null; plate: string | null; seller: Seller; lines: Array<{ product: string; product_ar?: string | null; product_en?: string | null; filler_mm: string | null; color: string | null; length_m: string | null; packages: number; bars_per_package: number | null; bars: number | null; weight_kg: string | null; gross_kg: string | null; weight_mode: string; is_partial: boolean }>; meta: DocMeta; incomplete_date?: boolean }
const P: Record<string, [string, string, string]> = { title: ['ریز بار و بسته‌بندی', 'قائمة التعبئة والشحن', 'Packing List'], from: ['مبدأ', 'المصدر', 'From'], to: ['مقصد', 'الوجهة', 'To'], resp: ['مسئول', 'المسؤول', 'Responsible'], driver: ['راننده', 'السائق', 'Driver'], plate: ['پلاک', 'اللوحة', 'Plate'], product: ['محصول', 'المنتج', 'Product'], filler: ['فیلر', 'سُمك', 'Wall'], color: ['رنگ', 'اللون', 'Colour'], length: ['طول', 'الطول', 'Length'], packages: ['بسته', 'عدد الطرود', 'Packages'], bpp: ['شاخه در بسته', 'قضبان/طرد', 'Bars/pkg'], bars: ['کل شاخه', 'إجمالي القضبان', 'Bars'], net: ['وزن خالص', 'الوزن الصافي', 'Net kg'], gross: ['ناخالص', 'القائم', 'Gross kg'], src: ['منبع وزن', 'مصدر الوزن', 'Weight source'], total: ['جمع', 'المجموع', 'Total'], partial: ['ناقص', 'جزئي', 'partial'], group: ['جمع گروه', 'مجموع المجموعة', 'Group total'] };
const tri = (k: string) => P[k]!.map(esc).join(' / ');

/** Packing list: trilingual header (fa / ar / en), groups by product with group and grand totals. */
export function packingListHtml(d: PackingDoc, fontCss: string): string {
  const groups = new Map<string, typeof d.lines>();
  for (const l of d.lines) (groups.get(l.product) ?? groups.set(l.product, []).get(l.product)!).push(l);
  let rows = '';
  const tot = { packages: 0, bars: 0, net: new Dec(0), gross: new Dec(0) };
  for (const [prod, ls] of groups) {
    const g = { packages: 0, bars: 0, net: new Dec(0), gross: new Dec(0) };
    for (const l of ls) {
      g.packages += l.packages; g.bars += l.bars ?? 0; g.net = g.net.plus(l.weight_kg ?? 0); g.gross = g.gross.plus(l.gross_kg ?? 0);
      rows += `<tr><td>${esc(l.product)}${l.product_ar ? `<div class="muted">${esc(l.product_ar)}</div>` : ''}${l.product_en ? `<div class="muted">${esc(l.product_en)}</div>` : ''}</td><td class="num">${l.filler_mm ? n(l.filler_mm, 'filler') : '—'}</td><td>${esc(l.color ?? '—')}</td><td class="num">${l.length_m ? n(l.length_m, 'length') : '—'}</td><td class="num">${n(l.packages)}${l.is_partial ? ` <span class="muted">(${tri('partial')})</span>` : ''}</td><td class="num">${n(l.bars_per_package)}</td><td class="num">${n(l.bars)}</td><td class="num">${l.weight_kg ? n(l.weight_kg, 'weight') : '—'}</td><td class="num">${l.gross_kg ? n(l.gross_kg, 'weight') : '—'}</td><td class="muted">${l.weight_mode === 'per_package' ? 'هر بسته / per package' : 'جمع گروه / group total'}</td></tr>`;
    }
    rows += `<tr style="background:#f6f6f6"><td colspan="4"><b>${tri('group')}: ${esc(prod)}</b></td><td class="num"><b>${n(g.packages)}</b></td><td></td><td class="num"><b>${n(g.bars)}</b></td><td class="num"><b>${n(g.net, 'weight')}</b></td><td class="num"><b>${g.gross.isZero() ? '—' : n(g.gross, 'weight')}</b></td><td></td></tr>`;
    tot.packages += g.packages; tot.bars += g.bars; tot.net = tot.net.plus(g.net); tot.gross = tot.gross.plus(g.gross);
  }
  return `<!doctype html><html lang="fa"><head><meta charset="utf-8"><title>${tri('title')} ${esc(d.number)}</title><style>${baseCss('rtl', fontCss, { watermark: d.meta.env !== 'production' ? 'x' : null, footer: `${P.title![0]} ${d.number}` })}</style></head><body>
  ${head('fa', d.seller, tri('title'), d.number, d.date, d.meta)}
  ${d.incomplete_date ? '<div class="muted">⚠ تاریخ ناقص؛ سند قطعی نیست</div>' : ''}
  <div class="box grid2"><div>${tri('from')}: ${esc(d.from ?? '—')}</div><div>${tri('to')}: ${esc(d.to ?? '—')}</div><div>${tri('resp')}: ${esc(d.responsible ?? '—')}</div><div>${tri('driver')}: ${esc(d.driver ?? '—')} · ${tri('plate')}: ${toPersianDigits(esc(d.plate ?? '—'))}</div></div>
  <table><thead><tr><th>${tri('product')}</th><th>${tri('filler')}</th><th>${tri('color')}</th><th>${tri('length')}</th><th>${tri('packages')}</th><th>${tri('bpp')}</th><th>${tri('bars')}</th><th>${tri('net')}</th><th>${tri('gross')}</th><th>${tri('src')}</th></tr></thead><tbody>${rows}</tbody>
  <tfoot><tr><th colspan="4">${tri('total')}</th><th class="num">${n(tot.packages)}</th><th></th><th class="num">${n(tot.bars)}</th><th class="num">${n(tot.net, 'weight')}</th><th class="num">${tot.gross.isZero() ? '—' : n(tot.gross, 'weight')}</th><th></th></tr></tfoot></table>
  <div class="sig"><div>${tri('resp')}</div><div>${tri('driver')}</div></div></body></html>`;
}

export interface CommercialDoc { number: string; date: Date | string | null; seller: Seller; buyer: { name: string; name_ar?: string | null; address?: string | null }; consignee: string | null; delivery_term: string | null; border: string | null; currency: Currency; lines: Array<{ description: string; description_ar?: string | null; net_kg: string | null; gross_kg: string | null; packages: number; unit_price: string | null; amount: string | null }>; total: string; meta: DocMeta }
/** Commercial invoice for export (Arabic + English). */
export function commercialInvoiceHtml(d: CommercialDoc, fontCss: string): string {
  const b = (ar: string, en: string) => `${esc(ar)} / ${esc(en)}`;
  const rows = d.lines.map((l, i) => `<tr><td class="num">${i + 1}</td><td>${esc(l.description)}${l.description_ar ? `<div class="muted">${esc(l.description_ar)}</div>` : ''}</td><td class="num">${l.net_kg ? n(l.net_kg, 'weight') : '—'}</td><td class="num">${l.gross_kg ? n(l.gross_kg, 'weight') : '—'}</td><td class="num">${n(l.packages)}</td><td class="num">${l.unit_price ? n(l.unit_price, d.currency) : '—'}</td><td class="num">${l.amount ? n(l.amount, d.currency) : '—'}</td></tr>`).join('');
  return `<!doctype html><html lang="ar"><head><meta charset="utf-8"><title>Commercial Invoice ${esc(d.number)}</title><style>${baseCss('rtl', fontCss, { watermark: d.meta.env !== 'production' ? 'x' : null, footer: `Commercial Invoice ${d.number}` })}</style></head><body>
  ${head('ar', d.seller, 'فاتورة تجارية / Commercial Invoice', d.number, d.date, d.meta)}
  <div class="grid2"><div class="box"><b>${b('البائع', 'Seller')}</b><div>${esc(d.seller.name_ar || d.seller.name_en || d.seller.name)}</div><div class="muted">${esc(d.seller.address_en ?? d.seller.address_ar ?? '')}</div></div><div class="box"><b>${b('المشتري', 'Buyer')}</b><div>${esc(d.buyer.name_ar || d.buyer.name)}</div><div class="muted">${esc(d.buyer.address ?? '')}</div></div>
  <div class="box"><b>${b('المرسل إليه', 'Consignee')}</b><div>${esc(d.consignee ?? d.buyer.name)}</div></div><div class="box"><div>${b('شرط التسليم', 'Delivery term')}: ${esc(d.delivery_term ?? '—')}</div><div>${b('المنفذ الحدودي', 'Border')}: ${esc(d.border ?? '—')}</div></div></div>
  <table><thead><tr><th>#</th><th>${b('وصف البضاعة', 'Description')}</th><th>${b('الوزن الصافي', 'Net kg')}</th><th>${b('الوزن القائم', 'Gross kg')}</th><th>${b('الطرود', 'Packages')}</th><th>${b('سعر الوحدة', 'Unit price')} (${CUR[d.currency].en})</th><th>${b('الإجمالي', 'Amount')}</th></tr></thead><tbody>${rows}</tbody>
  <tfoot><tr><th colspan="6">${b('المجموع', 'Total')}</th><th class="num">${n(d.total, d.currency)} ${CUR[d.currency].en}</th></tr></tfoot></table>
  <div class="box words"><b>${b('المبلغ بالحروف', 'Amount in words')}:</b> ${esc(amountToArabicWords(d.total, d.currency))}</div>
  <div class="sig"><div>${b('ختم وتوقيع البائع', 'Seller stamp & signature')}</div><div>${b('ختم وتوقيع المشتري', 'Buyer stamp & signature')}</div></div></body></html>`;
}

export interface StatementDoc { party: { name: string; name_ar?: string | null; phone?: string | null; address?: string | null }; seller: Seller; from: string | null; to: string | null; opening: Partial<Record<Currency, string>>; rows: Array<{ number: string; kind: string; date: Date; description: string | null; currency: string; debit: string | null; credit: string | null; balance: string }>; closing: Partial<Record<Currency, string>>; meta: DocMeta; workshop?: boolean }
const KIND_FA: Record<string, string> = { invoice: 'فاکتور فروش', sales_return: 'برگشت فروش', purchase: 'خرید', toll_fee: 'اجرت', expense: 'هزینه', receipt: 'دریافت', payment: 'پرداخت', barter: 'تهاتر', opening_balance: 'مانده افتتاحیه', fx_difference: 'تسعیر' };
/** Party statement / كشف حساب: per currency, opening, rows with running balance, closing. */
export function statementHtml(d: StatementDoc, lang: 'fa' | 'ar', fontCss: string): string {
  const title = lang === 'ar' ? 'كشف حساب' : d.workshop ? 'صورتحساب کارگاه' : 'صورتحساب مشتری';
  const curs = [...new Set([...Object.keys(d.opening), ...d.rows.map((r) => r.currency), ...Object.keys(d.closing)])] as Currency[];
  const sections = curs.map((c) => {
    const rows = d.rows.filter((r) => r.currency === c).map((r) => `<tr><td>${jd(r.date)}</td><td>${toPersianDigits(esc(r.number))}</td><td>${esc(KIND_FA[r.kind] ?? r.kind)}${r.description ? ` — ${esc(r.description)}` : ''}</td><td class="num">${r.debit ? n(r.debit, c) : ''}</td><td class="num">${r.credit ? n(r.credit, c) : ''}</td><td class="num">${n(r.balance, c)}</td></tr>`).join('');
    return `<h2>${CUR[c][lang]}</h2><table><thead><tr><th>${t('date', lang)}</th><th>${t('number', lang)}</th><th>${lang === 'ar' ? 'البيان' : 'شرح'}</th><th>${lang === 'ar' ? 'مدين' : 'بدهکار'}</th><th>${lang === 'ar' ? 'دائن' : 'بستانکار'}</th><th>${lang === 'ar' ? 'الرصيد' : 'مانده'}</th></tr></thead>
    <tbody><tr><td colspan="5">${lang === 'ar' ? 'الرصيد الافتتاحي' : 'مانده قبلی'}</td><td class="num">${n(d.opening[c] ?? '0', c)}</td></tr>${rows}</tbody><tfoot><tr><th colspan="5">${lang === 'ar' ? 'الرصيد الختامي' : 'مانده نهایی'}</th><th class="num">${n(d.closing[c] ?? '0', c)} ${CUR[c][lang]}</th></tr></tfoot></table>`;
  }).join('');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title} ${esc(d.party.name)}</title><style>${baseCss('rtl', fontCss, { watermark: d.meta.env !== 'production' ? 'x' : null, footer: `${title} ${d.party.name}` })}</style></head><body>
  ${head(lang, d.seller, title, '', new Date(), d.meta)}
  <div class="box"><b>${t('buyer_name', lang)}:</b> ${esc(lang === 'ar' ? d.party.name_ar || d.party.name : d.party.name)} · ${t('phone', lang)}: ${toPersianDigits(esc(d.party.phone ?? '—'))}<div class="muted">${d.from ? `${lang === 'ar' ? 'من' : 'از'} ${toPersianDigits(d.from)}` : ''} ${d.to ? `${lang === 'ar' ? 'إلى' : 'تا'} ${toPersianDigits(d.to)}` : ''}</div></div>
  ${sections || '<div class="muted">سندی نیست</div>'}
  <div class="muted">مانده مثبت = طلب ویترال از طرف؛ مانده منفی = بدهی ویترال.</div></body></html>`;
}

/** A6 bundle label: code, product, filler, length, bars, weight, g/m, date, link. */
export function bundleLabelHtml(b: { code: string; product: string; filler_mm: string | null; length_m: string | null; bars: number | null; weight_kg: string; g_per_m: string | null; reported_at: Date; url: string | null }, fontCss: string): string {
  return `<!doctype html><html lang="fa"><head><meta charset="utf-8"><title>برچسب ${esc(b.code)}</title><style>${baseCss('rtl', fontCss, { pageSize: 'A6', footer: b.code })} body{font-size:14px} .big{font-size:40px;font-weight:800;text-align:center;letter-spacing:2px} .kv{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;margin-top:10px}</style></head><body>
  <div class="big">${toPersianDigits(esc(b.code))}</div><div style="text-align:center;font-size:18px">${esc(b.product)}</div>
  <div class="kv"><div>فیلر: ${b.filler_mm ? n(b.filler_mm, 'filler') + ' میلی‌متر' : '—'}</div><div>طول: ${b.length_m ? n(b.length_m, 'length') + ' متر' : '—'}</div><div>تعداد: ${b.bars !== null ? n(b.bars) + ' شاخه' : '—'}</div><div>وزن: <b>${n(b.weight_kg, 'weight')} کیلوگرم</b></div><div>وزن هر متر: ${b.g_per_m ? n(b.g_per_m, 'g_per_m') + ' گرم' : '—'}</div><div>تاریخ: ${jd(b.reported_at)}</div></div>
  ${b.url ? `<div class="muted" style="margin-top:12px;direction:ltr;text-align:center;word-break:break-all">${esc(b.url)}</div>` : ''}</body></html>`;
}

export interface DailyDoc {
  report: { date: string; decisions: { quarantine: Array<Record<string, unknown>>; weight_warnings: Array<Record<string, unknown>>; incomplete_documents: Array<Record<string, unknown>>; pending_money: number }; production: { groups: Array<{ product_name: string; total_kg: string; bundles: Array<{ code: string; weight_kg: string; bars: number | null; g_per_m: string | null; note: string | null; mixed: boolean; status: string }> }>; total_kg: string; bundle_count: number }; transfers: Array<Record<string, unknown>>; filler_checks: Array<Record<string, unknown>>; money: Array<Record<string, unknown>> | null; free_notes: Array<Record<string, unknown>>; tasks: { closed: Array<Record<string, unknown>>; open: Array<Record<string, unknown>> } };
  /** finance.view: money section and amounts; otherwise no money at all (principle 6). */
  finance: boolean;
  /** «نسخه کامل»: bars, weight per metre and notes next to each bundle (spec §12-a). */
  full: boolean;
  seller: Seller;
  /** A moment inside the report's Tehran day, for the printed Jalali date. */
  day: Date;
  meta: DocMeta;
}
const MONEY_STATUS_FA: Record<string, string> = { draft: 'پیش‌نویس', reported: 'گزارش‌شده', posted: 'قطعی', void: 'باطل', needs_completion: 'نیازمند تکمیل' };
/** Weight as in the report text (§12-a): Persian digits, no trailing decimal zeros («۳۹۴»، «۲۱۳٫۵»). */
const kgt = (v: unknown): string => (v === null || v === undefined ? '—' : n(v, 'weight').replace(/٫([۰-۹]*?)۰+$/, (_m, d: string) => (d ? `٫${d}` : '')));
const STATUS_FA: Record<string, string> = { ok: 'سالم', damaged: 'دارای خرابی', wrong_product: 'اشتباه تولید', pending_review: 'در انتظار بررسی', scrapped: 'ضایعات' };
const DOC_KIND_FA: Record<string, string> = { ...KIND_FA, scale_ticket: 'قبض باسکول' };
const TRANSFER_STATUS_FA: Record<string, string> = { draft: 'پیش‌نویس', dispatched: 'ارسال‌شده', in_transit: 'در مسیر', at_border: 'مرز', partially_received: 'دریافت بخشی', received: 'دریافت‌شده', delivered: 'تحویل‌شده' };

/** Daily report (module 10, §14/§15): the same sections as the report text — decisions, production per product with totals, loads, filler checks, money (finance only), notes, tasks. */
export function dailyReportHtml(d: DailyDoc, fontCss: string): string {
  const r = d.report;
  const title = 'گزارش روزانه';
  const s = (v: unknown) => esc(v === null || v === undefined ? '—' : String(v));
  const dec = r.decisions;
  const decisions = [
    ...dec.quarantine.map((q) => `<tr><td>بندیل قرنطینه</td><td>${toPersianDigits(s(q.code))}</td><td>${s(STATUS_FA[String(q.status)] ?? q.status)}${q.defect ? ` — ${s(q.defect)}` : ''}${q.qc_note ? ` — ${s(q.qc_note)}` : ''}</td><td class="num">${kgt(q.weight_kg)}</td></tr>`),
    ...dec.weight_warnings.map((w) => `<tr><td>هشدار وزن</td><td>${toPersianDigits(s(w.code))}</td><td>${esc((Array.isArray(w.warnings) ? (w.warnings as Array<Record<string, unknown>>).map((x) => String(x.message ?? x.kind ?? '')) : []).join('، '))}</td><td class="num">${kgt(w.weight_kg)}</td></tr>`),
    ...dec.incomplete_documents.map((x) => `<tr><td>مدرک ناقص</td><td>${toPersianDigits(s(x.number ?? x.transfer_number))}</td><td>${s(DOC_KIND_FA[String(x.type === 'scale_ticket' ? 'scale_ticket' : x.kind)] ?? x.kind)}</td><td></td></tr>`),
  ].join('');
  const groups = r.production.groups.map((g) => `<tr style="background:#f6f6f6"><td colspan="${d.full ? 5 : 2}"><b>🔹 ${esc(g.product_name)}: ${kgt(g.total_kg)} کیلو</b></td></tr>${g.bundles.map((b) => `<tr><td>${toPersianDigits(esc(b.code))}${b.mixed ? ' <span class="muted">(درهم)</span>' : ''}</td><td class="num">${kgt(b.weight_kg)}</td>${d.full ? `<td class="num">${b.bars === null ? '—' : toPersianDigits(String(b.bars))}</td><td class="num">${b.g_per_m ? n(b.g_per_m, 'g_per_m') : '—'}</td><td>${[b.status !== 'ok' ? STATUS_FA[b.status] ?? b.status : '', b.note ?? ''].filter(Boolean).map(esc).join('، ')}</td>` : ''}</tr>`).join('')}`).join('');
  const transfers = r.transfers.map((t) => `<tr><td>${toPersianDigits(s(t.number))}</td><td>${s(t.from_name)} ← ${s(t.to_name)}</td><td class="num">${kgt(t.kg)}</td><td class="num">${t.received_kg && Number(t.received_kg) ? kgt(t.received_kg) : '—'}</td><td class="num">${n(t.tickets)}</td><td>${s(TRANSFER_STATUS_FA[String(t.status)] ?? t.status)}</td><td>${toPersianDigits(s(t.plate))}</td></tr>`).join('');
  const fillers = r.filler_checks.map((f) => `<tr><td>${toPersianDigits(s(f.die_code))}</td><td>${f.kind === 'filler_check' ? 'چک فیلر' : f.kind === 'repair' ? 'تعمیر' : 'آسیب'}</td><td class="num">${f.measured_filler_mm ? n(f.measured_filler_mm, 'filler') : '—'}</td><td>${s(f.detail)}</td></tr>`).join('');
  const money = d.finance && r.money ? r.money.map((m) => `<tr><td>${toPersianDigits(s(m.number))}</td><td>${m.kind === 'receipt' ? 'دریافت' : 'پرداخت'}</td><td>${s(m.party_name)}</td><td class="num">${n(m.amount, m.currency as Currency)} ${CUR[m.currency as Currency]?.fa ?? ''}</td><td>${s(MONEY_STATUS_FA[String(m.status)] ?? m.status)}</td><td>${s(m.reported_by_name)}</td></tr>`).join('') : '';
  const notes = r.free_notes.map((x) => `<tr><td>${s(x.user_name)}</td><td class="words">${s(x.text)}</td><td class="num">${x.kg ? kgt(x.kg) : '—'}</td>${d.finance ? `<td class="num">${x.amount ? `${n(x.amount, (x.currency as Currency) ?? 'TOMAN')} ${CUR[(x.currency as Currency) ?? 'TOMAN']?.fa ?? ''}` : '—'}</td>` : ''}</tr>`).join('');
  const tasks = [...r.tasks.closed.map((x) => `<tr><td>✅ بسته‌شده</td><td>${s(x.title)}</td><td>${s(x.assignee)}</td><td>${s(x.done_note)}</td></tr>`), ...r.tasks.open.map((x) => `<tr><td>باز</td><td>${s(x.title)}</td><td>${s(x.assignee)}</td><td>${x.due_at ? jd(x.due_at as string) : '—'}</td></tr>`)].join('');
  const empty = (cols: number) => `<tr><td colspan="${cols}" class="muted">موردی نیست</td></tr>`;
  return `<!doctype html><html lang="fa"><head><meta charset="utf-8"><title>${title} ${esc(r.date)}</title><style>${baseCss('rtl', fontCss, { watermark: d.meta.env !== 'production' ? 'x' : null, footer: `${title} ${r.date}` })}</style></head><body>
  ${head('fa', d.seller, title, r.date, d.day, d.meta)}
  <h2>۱. نیازمند تصمیم</h2><table><thead><tr><th>نوع</th><th>کد / شماره</th><th>شرح</th><th>وزن (کیلو)</th></tr></thead><tbody>${decisions || empty(4)}</tbody></table>
  ${d.finance && dec.pending_money ? `<div class="muted">${toPersianDigits(String(dec.pending_money))} دریافت/پرداخت در انتظار تأیید</div>` : ''}
  <h2>۲. موجودی تولیدشده — کد بندیل » وزن بندیل</h2><table><thead><tr><th>کد بندیل</th><th>وزن (کیلو)</th>${d.full ? '<th>شاخه</th><th>وزن هر متر (گرم)</th><th>توضیح</th>' : ''}</tr></thead><tbody>${groups || empty(d.full ? 5 : 2)}</tbody>
  <tfoot><tr><th>✅ جمع کل: ${kgt(r.production.total_kg)} کیلو</th><th colspan="${d.full ? 4 : 1}">📦 تعداد بندیل: ${toPersianDigits(String(r.production.bundle_count))}</th></tr></tfoot></table>
  <h2>۳. بارهای رفته و آمده</h2><table><thead><tr><th>شماره</th><th>مسیر</th><th>وزن (کیلو)</th><th>دریافتی (کیلو)</th><th>قبض</th><th>وضعیت</th><th>پلاک</th></tr></thead><tbody>${transfers || empty(7)}</tbody></table>
  <h2>۴. چک فیلر قالب‌ها</h2><table><thead><tr><th>قالب</th><th>رویداد</th><th>فیلر (میلی‌متر)</th><th>شرح</th></tr></thead><tbody>${fillers || empty(4)}</tbody></table>
  ${d.finance ? `<h2>۵. وجوه گزارش‌شده</h2><table><thead><tr><th>شماره</th><th>نوع</th><th>طرف</th><th>مبلغ</th><th>وضعیت</th><th>ثبت‌کننده</th></tr></thead><tbody>${money || empty(6)}</tbody></table>` : ''}
  <h2>${d.finance ? '۶' : '۵'}. ثبت‌های آزاد</h2><table><thead><tr><th>کاربر</th><th>متن</th><th>کیلو</th>${d.finance ? '<th>مبلغ</th>' : ''}</tr></thead><tbody>${notes || empty(d.finance ? 4 : 3)}</tbody></table>
  <h2>${d.finance ? '۷' : '۶'}. کارها</h2><table><thead><tr><th>وضعیت</th><th>عنوان</th><th>مسئول</th><th>توضیح / موعد</th></tr></thead><tbody>${tasks || empty(4)}</tbody></table>
  </body></html>`;
}
