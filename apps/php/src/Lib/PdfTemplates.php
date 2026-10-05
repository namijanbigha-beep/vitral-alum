<?php
declare(strict_types=1);

namespace Vitral\Lib;

/**
 * Port of apps/server/src/modules/pdf/templates.ts: proforma / invoice / credit note (fa & ar), packing list (fa/ar/en),
 * commercial invoice (ar/en), party statement, A6 bundle label and the daily report. The markup is the Node markup
 * character for character, so previews, print pages and Chromium PDFs look the same on both servers.
 *
 * Inputs are arrays with the keys of the TypeScript interfaces (SaleDoc, PackingDoc, CommercialDoc, StatementDoc,
 * DailyDoc). Dates are ISO strings or DateTimeInterface.
 */
final class PdfTemplates
{
    private const L = [
        'proforma' => ['fa' => 'پیش فاکتور فروش', 'ar' => 'فاتورة أولية للبيع', 'en' => 'Proforma Invoice'], 'invoice' => ['fa' => 'فاکتور فروش', 'ar' => 'فاتورة بيع', 'en' => 'Invoice'], 'credit' => ['fa' => 'اشعار برگشت', 'ar' => 'إشعار دائن', 'en' => 'Credit Note'],
        'seller' => ['fa' => 'مشخصات فروشنده', 'ar' => 'بيانات البائع', 'en' => 'Seller'], 'buyer' => ['fa' => 'مشخصات مشتری', 'ar' => 'بيانات العميل', 'en' => 'Buyer'], 'seller_name' => ['fa' => 'نام فروشنده', 'ar' => 'اسم البائع', 'en' => 'Seller name'], 'buyer_name' => ['fa' => 'نام خریدار', 'ar' => 'اسم المشتري', 'en' => 'Buyer name'],
        'phone' => ['fa' => 'تلفن', 'ar' => 'الهاتف', 'en' => 'Phone'], 'address' => ['fa' => 'نشانی', 'ar' => 'العنوان', 'en' => 'Address'], 'goods' => ['fa' => 'مشخصات کالا', 'ar' => 'تفاصيل البضاعة', 'en' => 'Goods'], 'number' => ['fa' => 'شماره', 'ar' => 'الرقم', 'en' => 'No.'], 'date' => ['fa' => 'تاریخ', 'ar' => 'التاريخ', 'en' => 'Date'],
        'row' => ['fa' => 'ردیف', 'ar' => 'م', 'en' => '#'], 'code' => ['fa' => 'کد', 'ar' => 'الرمز', 'en' => 'Code'], 'desc' => ['fa' => 'شرح کالا', 'ar' => 'وصف البضاعة', 'en' => 'Description'], 'color' => ['fa' => 'رنگ', 'ar' => 'اللون', 'en' => 'Colour'], 'load_type' => ['fa' => 'نوع بار', 'ar' => 'نوع البضاعة', 'en' => 'Type'], 'gpm' => ['fa' => 'وزن هر متر (گرم)', 'ar' => 'وزن المتر (غرام)', 'en' => 'g/m'],
        'qty' => ['fa' => 'مقدار', 'ar' => 'الكمية', 'en' => 'Quantity'], 'unit_price' => ['fa' => 'مبلغ واحد', 'ar' => 'سعر الوحدة', 'en' => 'Unit price'], 'total' => ['fa' => 'مبلغ کل', 'ar' => 'الإجمالي', 'en' => 'Total'], 'filler' => ['fa' => 'فیلر', 'ar' => 'سُمك الجدار', 'en' => 'Wall'], 'length' => ['fa' => 'طول', 'ar' => 'الطول', 'en' => 'Length'], 'per_kg' => ['fa' => 'هر کیلوگرم', 'ar' => 'لكل كيلوغرام', 'en' => 'per kg'],
        'die_making' => ['fa' => 'ساخت قالب', 'ar' => 'تصنيع قالب', 'en' => 'Die making'], 'from_die' => ['fa' => 'از قالب', 'ar' => 'من القالب', 'en' => 'From die'], 'sum' => ['fa' => 'جمع کل', 'ar' => 'المجموع', 'en' => 'Total'], 'prepay' => ['fa' => 'پیش‌پرداخت', 'ar' => 'الدفعة المقدمة', 'en' => 'Prepayment'], 'paid' => ['fa' => 'پرداخت شده', 'ar' => 'المدفوع', 'en' => 'Paid'], 'remaining' => ['fa' => 'باقیمانده', 'ar' => 'المتبقي', 'en' => 'Balance'],
        'terms' => ['fa' => 'شرایط فروش', 'ar' => 'شروط البيع', 'en' => 'Terms'], 'validity' => ['fa' => 'مدت اعتبار پیش‌فاکتور', 'ar' => 'صلاحية الفاتورة الأولية', 'en' => 'Validity'], 'notes' => ['fa' => 'توضیحات', 'ar' => 'ملاحظات', 'en' => 'Notes'], 'seller_sign' => ['fa' => 'مهر و امضای فروشنده', 'ar' => 'ختم وتوقيع البائع', 'en' => 'Seller stamp & signature'], 'buyer_sign' => ['fa' => 'مهر و امضای خریدار', 'ar' => 'ختم وتوقيع المشتري', 'en' => 'Buyer stamp & signature'],
        'page' => ['fa' => 'صفحه', 'ar' => 'صفحة', 'en' => 'Page'], 'cont' => ['fa' => 'ادامه اقلام در صفحه بعد', 'ar' => 'تتمة في الصفحة التالية', 'en' => 'Continued on next page'], 'cash' => ['fa' => 'نقدی', 'ar' => 'نقداً', 'en' => 'Cash'], 'credit_terms' => ['fa' => 'اعتباری', 'ar' => 'بالأجل', 'en' => 'Credit'], 'sum_qty' => ['fa' => 'جمع مقدار', 'ar' => 'مجموع الكمية', 'en' => 'Total quantity'],
        'words' => ['fa' => 'جمع کل به حروف', 'ar' => 'المجموع بالحروف', 'en' => 'Amount in words'], 'kg' => ['fa' => 'کیلوگرم', 'ar' => 'كغ', 'en' => 'kg'], 'piece' => ['fa' => 'عدد', 'ar' => 'قطعة', 'en' => 'pc'], 'bar' => ['fa' => 'شاخه', 'ar' => 'قضيب', 'en' => 'bar'], 'mm' => ['fa' => 'میلی‌متر', 'ar' => 'مم', 'en' => 'mm'], 'm' => ['fa' => 'متر', 'ar' => 'م', 'en' => 'm'], 'shamsi' => ['fa' => '', 'ar' => 'هجري شمسي', 'en' => 'Jalali'],
        'vat' => ['fa' => 'مالیات', 'ar' => 'الضريبة', 'en' => 'VAT'], 'delivery_ref' => ['fa' => 'ارجاع به محموله', 'ar' => 'إشارة إلى الشحنة', 'en' => 'Shipment ref.'], 'settle_kg' => ['fa' => 'وزن مبنای تسویه', 'ar' => 'وزن التسوية', 'en' => 'Settlement weight'], 'draft' => ['fa' => 'پیش‌نویس', 'ar' => 'مسودة', 'en' => 'DRAFT'], 'version' => ['fa' => 'نسخه', 'ar' => 'النسخة', 'en' => 'Rev.'], 'issued_by' => ['fa' => 'صادرکننده', 'ar' => 'أصدرها', 'en' => 'Issued by'], 'print' => ['fa' => 'چاپ', 'ar' => 'طباعة', 'en' => 'Print'],
    ];
    public const CUR = ['TOMAN' => ['fa' => 'تومان', 'ar' => 'تومان', 'en' => 'Toman'], 'USD' => ['fa' => 'دلار', 'ar' => 'دولار أمريكي', 'en' => 'USD'], 'IQD' => ['fa' => 'دینار عراقی', 'ar' => 'دينار عراقي', 'en' => 'IQD']];

    private const P = ['title' => ['ریز بار و بسته‌بندی', 'قائمة التعبئة والشحن', 'Packing List'], 'from' => ['مبدأ', 'المصدر', 'From'], 'to' => ['مقصد', 'الوجهة', 'To'], 'resp' => ['مسئول', 'المسؤول', 'Responsible'], 'driver' => ['راننده', 'السائق', 'Driver'], 'plate' => ['پلاک', 'اللوحة', 'Plate'], 'product' => ['محصول', 'المنتج', 'Product'], 'filler' => ['فیلر', 'سُمك', 'Wall'], 'color' => ['رنگ', 'اللون', 'Colour'], 'length' => ['طول', 'الطول', 'Length'], 'packages' => ['بسته', 'عدد الطرود', 'Packages'], 'bpp' => ['شاخه در بسته', 'قضبان/طرد', 'Bars/pkg'], 'bars' => ['کل شاخه', 'إجمالي القضبان', 'Bars'], 'net' => ['وزن خالص', 'الوزن الصافي', 'Net kg'], 'gross' => ['ناخالص', 'القائم', 'Gross kg'], 'src' => ['منبع وزن', 'مصدر الوزن', 'Weight source'], 'total' => ['جمع', 'المجموع', 'Total'], 'partial' => ['ناقص', 'جزئي', 'partial'], 'group' => ['جمع گروه', 'مجموع المجموعة', 'Group total']];

    public const KIND_FA = ['invoice' => 'فاکتور فروش', 'sales_return' => 'برگشت فروش', 'purchase' => 'خرید', 'toll_fee' => 'اجرت', 'expense' => 'هزینه', 'receipt' => 'دریافت', 'payment' => 'پرداخت', 'barter' => 'تهاتر', 'opening_balance' => 'مانده افتتاحیه', 'fx_difference' => 'تسعیر'];
    private const MONEY_STATUS_FA = ['draft' => 'پیش‌نویس', 'reported' => 'گزارش‌شده', 'posted' => 'قطعی', 'void' => 'باطل', 'needs_completion' => 'نیازمند تکمیل'];
    private const STATUS_FA = ['ok' => 'سالم', 'damaged' => 'دارای خرابی', 'wrong_product' => 'اشتباه تولید', 'pending_review' => 'در انتظار بررسی', 'scrapped' => 'ضایعات'];
    private const TRANSFER_STATUS_FA = ['draft' => 'پیش‌نویس', 'dispatched' => 'ارسال‌شده', 'in_transit' => 'در مسیر', 'at_border' => 'مرز', 'partially_received' => 'دریافت بخشی', 'received' => 'دریافت‌شده', 'delivered' => 'تحویل‌شده'];

    // ---------------------------------------------------------------- helpers (t, n, jd, words, esc)

    private static function t(string $k, string $lang): string
    {
        return self::L[$k][$lang] ?? $k;
    }

    /** JavaScript truthiness for values coming from rows (null, false, '', 0 are falsy; '0.00' is truthy). */
    public static function js(mixed $v): bool
    {
        return !($v === null || $v === false || $v === '' || $v === 0 || $v === 0.0);
    }

    private static function str(mixed $v): string
    {
        if ($v instanceof \DateTimeInterface) return \Vitral\Core\Json::iso($v);
        if (is_bool($v)) return $v ? 'true' : 'false';
        if ($v instanceof Decimal) return $v->toFixed();
        if (is_array($v)) return implode(',', array_map([self::class, 'str'], $v));
        return (string) $v;
    }

    /** n(): Persian number (R19 rounding when a kind is given), «—» for null. */
    public static function n(mixed $v, ?string $kind = null): string
    {
        if ($v === null) return '—';
        if (!$v instanceof Decimal) $v = self::str($v);
        return Num::formatNumber($v, $kind) ?? '—';
    }

    /** jd(): Jalali date of an instant in Tehran, Persian digits; «—» for none. */
    public static function jd(mixed $d): string
    {
        if (!self::js($d)) return '—';
        return Num::toPersianDigits(Jalali::format(Jalali::of($d instanceof \DateTimeInterface ? $d : (string) $d)));
    }

    private static function words(string $amount, string $cur, string $lang): string
    {
        return $lang === 'ar' ? Words::amountToArabic($amount, $cur) : Words::amountToPersian($amount, $cur);
    }

    private static function esc(mixed $s): string
    {
        return PdfRender::esc($s === null ? null : ($s instanceof Decimal || $s instanceof \DateTimeInterface ? self::str($s) : $s));
    }

    private static function fa(mixed $s): string
    {
        return Num::toPersianDigits((string) $s);
    }

    // ---------------------------------------------------------------- shared blocks

    /** @param array<string,mixed> $seller @param array{env:string,version:int,issued_by:string,print_count:int,draft:bool} $meta */
    private static function head(string $lang, array $seller, string $title, string $number, mixed $date, array $meta): string
    {
        $sellerName = $lang === 'ar' ? (self::js($seller['name_ar'] ?? null) ? $seller['name_ar'] : $seller['name']) : ($lang === 'en' ? (self::js($seller['name_en'] ?? null) ? $seller['name_en'] : $seller['name']) : $seller['name']);
        $wm = $meta['env'] !== 'production' ? 'نمونه آزمایشی — سند واقعی نیست' : ($meta['draft'] ? self::t('draft', $lang) : '');
        $logo = self::js($seller['logo'] ?? null) ? '<img src="' . $seller['logo'] . '" style="height:46px">' : '';
        $shamsi = $lang === 'ar' ? '<span class="muted">(' . self::t('shamsi', $lang) . ')</span>' : '';
        return '<div class="wm">' . $wm . '</div>
  <div class="head"><div style="display:flex;gap:10px;align-items:center">' . $logo . '<div><h1>' . self::esc($sellerName) . '</h1><div class="muted">' . self::esc($seller['phone'] ?? '') . '</div></div></div>
  <div style="text-align:center"><h1>' . self::esc($title) . '</h1></div>
  <div style="text-align:' . ($lang === 'en' ? 'right' : 'left') . '"><div>' . self::t('number', $lang) . ': <b>' . self::fa(self::esc($number)) . '</b></div><div>' . self::t('date', $lang) . ': ' . self::jd($date) . ' ' . $shamsi . '</div><div class="muted">' . self::t('version', $lang) . ' ' . self::fa((string) $meta['version']) . ' · ' . self::t('print', $lang) . ' ' . self::fa((string) $meta['print_count']) . ' · ' . self::t('issued_by', $lang) . ': ' . self::esc($meta['issued_by']) . '</div></div></div>';
    }

    private static function parties(string $lang, array $seller, array $buyer): string
    {
        $pick = static fn (array $o, string $base, string $ar, string $en) => $lang === 'ar' ? (self::js($o[$ar] ?? null) ? $o[$ar] : ($o[$base] ?? null)) : ($lang === 'en' ? (self::js($o[$en] ?? null) ? $o[$en] : ($o[$base] ?? null)) : ($o[$base] ?? null));
        $sAddr = $pick($seller, 'address', 'address_ar', 'address_en');
        $sName = $pick($seller, 'name', 'name_ar', 'name_en');
        $bName = $lang === 'ar' ? (self::js($buyer['name_ar'] ?? null) ? $buyer['name_ar'] : $buyer['name']) : $buyer['name'];
        return '<div class="grid2"><div class="box"><b>' . self::t('seller', $lang) . '</b><div>' . self::t('seller_name', $lang) . ': ' . self::esc($sName) . '</div><div>' . self::t('phone', $lang) . ': ' . self::fa(self::esc($seller['phone'] ?? '—')) . '</div><div>' . self::t('address', $lang) . ': ' . self::esc($sAddr ?? '—') . '</div></div>
  <div class="box"><b>' . self::t('buyer', $lang) . '</b><div>' . self::t('buyer_name', $lang) . ': ' . self::esc($bName) . '</div><div>' . self::t('phone', $lang) . ': ' . self::fa(self::esc($buyer['phone'] ?? '—')) . '</div><div>' . self::t('address', $lang) . ': ' . self::esc($buyer['address'] ?? '—') . '</div></div></div>';
    }

    // ---------------------------------------------------------------- sale document

    /** Proforma / invoice / credit note (spec §14 layout, fa & ar). @param array<string,mixed> $d SaleDoc */
    public static function saleDocumentHtml(array $d, string $lang, string $fontCss): string
    {
        $hasVat = false;
        foreach ($d['lines'] as $l) {
            if (self::js($l['vat_rate'] ?? null) && !Decimal::of((string) $l['vat_rate'])->isZero()) $hasVat = true;
        }
        $rows = '';
        foreach (array_values($d['lines']) as $i => $l) {
            $name = $lang === 'ar' ? (self::js($l['name_ar'] ?? null) ? $l['name_ar'] : $l['name']) : $l['name'];
            $dieCode = $l['die_code'] ?? null;
            if ($l['kind'] === 'die_making') {
                $desc = self::esc($name) . '<div class="muted">' . self::t('die_making', $lang) . (self::js($dieCode) ? ' ' . self::fa(self::esc($dieCode)) : '') . '</div>';
            } else {
                $desc = '<div style="display:flex;gap:6px;align-items:center">' . (self::js($l['image'] ?? null) ? '<img class="img" src="' . $l['image'] . '">' : '') . '<div>' . self::esc($name)
                    . (self::js($dieCode) ? '<div class="muted">' . self::t('from_die', $lang) . ': ' . self::fa(self::esc($dieCode)) . '</div>' : '')
                    . (self::js($l['filler_mm'] ?? null) ? '<div class="muted">' . self::t('filler', $lang) . ': ' . self::n($l['filler_mm'], 'filler') . ' ' . self::t('mm', $lang) . '</div>' : '')
                    . (self::js($l['length_m'] ?? null) ? '<div class="muted">' . self::t('length', $lang) . ': ' . self::n($l['length_m'], 'length') . ' ' . self::t('m', $lang) . '</div>' : '')
                    . '</div></div>';
            }
            $unit = $l['qty_unit'];
            $qty = $l['qty'] === null ? '—' : ($unit === 'kg' ? self::n($l['qty'], 'weight') . ' ' . self::t('kg', $lang) : ($unit === 'piece' ? self::n($l['qty']) . ' ' . self::t('piece', $lang) : self::n($l['qty']) . ' ' . self::t($unit, $lang)));
            $cur = $l['currency'];
            $basis = $l['price_basis'] === 'per_kg' ? self::t('per_kg', $lang) : ($l['price_basis'] === 'per_piece' ? self::t('piece', $lang) : ($l['price_basis'] === 'per_bar' ? self::t('bar', $lang) : self::t('m', $lang)));
            $up = $l['unit_price'] === null ? '—' : self::n($l['unit_price'], $cur) . ' ' . self::CUR[$cur][$lang] . ' <span class="muted">' . $basis . '</span>';
            $vat = $hasVat ? '<td class="num">' . (self::js($l['vat_amount'] ?? null) ? self::n($l['vat_amount'], $cur) : '—') . '</td>' : '';
            $amount = $l['amount'] === null ? '—' : self::n($l['amount'], $cur) . ' ' . self::CUR[$cur][$lang];
            $rows .= '<tr><td class="num">' . self::fa((string) ($i + 1)) . '</td><td>' . self::fa(self::esc($l['code'] ?? '')) . '</td><td>' . $desc . '</td><td>' . self::esc($l['color'] ?? '—') . '</td><td>' . self::esc($l['load_type'] ?? '—') . '</td><td class="num">' . (self::js($l['gpm'] ?? null) ? self::n($l['gpm'], 'g_per_m') : '—') . '</td><td class="num">' . $qty . '</td><td class="num">' . $up . '</td>' . $vat . '<td class="num">' . $amount . '</td></tr>';
        }
        $totals = '';
        foreach ((array) $d['totals'] as $c => $v) {
            $totals .= '<div><b>' . self::t('sum', $lang) . ' (' . self::CUR[$c][$lang] . '):</b> ' . self::n($v, $c) . ' ' . self::CUR[$c][$lang] . '</div><div class="words"><b>' . self::t('words', $lang) . ':</b> ' . self::esc(self::words((string) $v, $c, $lang)) . '</div>';
        }
        $title = self::t($d['kind'], $lang);
        $termsText = '';
        $i = 0;
        foreach (explode("\n", (string) ($d['notes'] ?? '')) as $x) {
            if ($x === '') continue;
            $termsText .= '<div>' . self::fa((string) (++$i)) . '. ' . self::esc(str_replace('{prepay}', (string) ($d['prepay_percent'] ?? '۸۰'), $x)) . '</div>';
        }
        $meta = $d['meta'];
        $cur = $d['currency'];
        $css = PdfRender::baseCss('rtl', $fontCss, ['watermark' => $meta['draft'] || $meta['env'] !== 'production' ? 'x' : null, 'footer' => $title . ' ' . $d['number'] . ' · ' . self::t('version', $lang) . ' ' . $meta['version']]);
        $missingAr = !empty($d['missing_ar']) && $lang === 'ar' ? '<div class="muted">⚠ بعض أسماء المنتجات بدون ترجمة عربية؛ طُبع الاسم الفارسي.</div>' : '';
        $shipRef = self::js($d['shipment_ref'] ?? null)
            ? '<div class="muted">' . self::t('delivery_ref', $lang) . ': ' . self::fa(self::esc($d['shipment_ref'])) . (self::js($d['settlement_kg'] ?? null) ? ' · ' . self::t('settle_kg', $lang) . ': ' . self::n($d['settlement_kg'], 'weight') . ' ' . self::t('kg', $lang) : '') . '</div>'
            : '';
        $incomplete = !empty($d['incomplete']) ? '<div class="muted">' . ($lang === 'ar' ? 'بعض البنود بدون سعر' : 'برخی ردیف‌ها قیمت ندارند') . '</div>' : '';
        $prepay = $d['kind'] === 'proforma' && self::js($d['prepay_percent'] ?? null) ? '<div><b>' . self::t('prepay', $lang) . ':</b> ' . self::n($d['prepay_percent'], 'percent') . '٪ = ' . self::n($d['prepay_amount'] ?? null, $cur) . ' ' . self::CUR[$cur][$lang] . '</div>' : '';
        $validity = $d['kind'] === 'proforma' ? '<div><b>' . self::t('validity', $lang) . ':</b> ' . self::esc($d['validity'] ?? '—') . '</div>' : '';
        $delivery = isset($d['delivery_days']) && $d['delivery_days'] !== null ? '<div>* ' . ($lang === 'ar' ? 'مدة التسليم بعد الدفعة المقدمة' : 'زمان تحویل پس از پیش‌پرداخت') . ': ' . self::fa((string) $d['delivery_days']) . ' ' . ($lang === 'ar' ? 'يوم عمل' : 'روز کاری') . '.</div>' : '';
        return '<!doctype html><html lang="' . $lang . '"><head><meta charset="utf-8"><title>' . self::esc($title) . ' ' . self::esc($d['number']) . '</title><style>' . $css . '</style></head><body>
  ' . self::head($lang, $d['seller'], $title, (string) $d['number'], $d['date'] ?? null, $meta) . '
  ' . self::parties($lang, $d['seller'], $d['buyer']) . '
  ' . $missingAr . '
  ' . $shipRef . '
  <h2>' . self::t('goods', $lang) . '</h2>
  <table><thead><tr><th>' . self::t('row', $lang) . '</th><th>' . self::t('code', $lang) . '</th><th style="width:30%">' . self::t('desc', $lang) . '</th><th>' . self::t('color', $lang) . '</th><th>' . self::t('load_type', $lang) . '</th><th>' . self::t('gpm', $lang) . '</th><th>' . self::t('qty', $lang) . '</th><th>' . self::t('unit_price', $lang) . '</th>' . ($hasVat ? '<th>' . self::t('vat', $lang) . '</th>' : '') . '<th>' . self::t('total', $lang) . '</th></tr></thead><tbody>' . $rows . '</tbody>
  <tfoot><tr><td colspan="' . ($hasVat ? 10 : 9) . '" class="muted cont">' . self::t('cont', $lang) . '</td></tr></tfoot></table>
  <div class="box"><div><b>' . self::t('terms', $lang) . ':</b> ' . ($d['terms'] === 'cash' ? self::t('cash', $lang) : self::t('credit_terms', $lang)) . '</div><div><b>' . self::t('sum_qty', $lang) . ':</b> ' . self::n($d['total_kg'], 'weight') . ' ' . self::t('kg', $lang) . '</div>' . $totals . $incomplete . '
  ' . $prepay . '
  <div><b>' . self::t('paid', $lang) . ':</b> ' . self::n($d['paid'] ?? '0', $cur) . ' ' . self::CUR[$cur][$lang] . ' &nbsp; <b>' . self::t('remaining', $lang) . ':</b> ' . self::n($d['remaining'] ?? null, $cur) . ' ' . self::CUR[$cur][$lang] . '</div></div>
  ' . $validity . '
  <div class="box"><b>' . self::t('notes', $lang) . '</b>' . $termsText . $delivery . '</div>
  <div class="sig"><div>' . self::t('seller_sign', $lang) . '</div><div>' . self::t('buyer_sign', $lang) . '</div></div>
  </body></html>';
    }

    // ---------------------------------------------------------------- packing list

    private static function tri(string $k): string
    {
        return implode(' / ', array_map([self::class, 'esc'], self::P[$k]));
    }

    /** Packing list: trilingual header (fa / ar / en), groups by product with group and grand totals. */
    public static function packingListHtml(array $d, string $fontCss): string
    {
        $groups = [];
        foreach ($d['lines'] as $l) $groups[(string) $l['product']][] = $l;
        $rows = '';
        $tot = ['packages' => 0, 'bars' => 0, 'net' => Decimal::zero(), 'gross' => Decimal::zero()];
        foreach ($groups as $prod => $ls) {
            $g = ['packages' => 0, 'bars' => 0, 'net' => Decimal::zero(), 'gross' => Decimal::zero()];
            foreach ($ls as $l) {
                $g['packages'] += (int) $l['packages'];
                $g['bars'] += (int) ($l['bars'] ?? 0);
                $g['net'] = $g['net']->add($l['weight_kg'] ?? '0');
                $g['gross'] = $g['gross']->add($l['gross_kg'] ?? '0');
                $rows .= '<tr><td>' . self::esc($l['product']) . (self::js($l['product_ar'] ?? null) ? '<div class="muted">' . self::esc($l['product_ar']) . '</div>' : '') . (self::js($l['product_en'] ?? null) ? '<div class="muted">' . self::esc($l['product_en']) . '</div>' : '')
                    . '</td><td class="num">' . (self::js($l['filler_mm']) ? self::n($l['filler_mm'], 'filler') : '—') . '</td><td>' . self::esc($l['color'] ?? '—') . '</td><td class="num">' . (self::js($l['length_m']) ? self::n($l['length_m'], 'length') : '—')
                    . '</td><td class="num">' . self::n($l['packages']) . (!empty($l['is_partial']) ? ' <span class="muted">(' . self::tri('partial') . ')</span>' : '') . '</td><td class="num">' . self::n($l['bars_per_package']) . '</td><td class="num">' . self::n($l['bars'])
                    . '</td><td class="num">' . (self::js($l['weight_kg']) ? self::n($l['weight_kg'], 'weight') : '—') . '</td><td class="num">' . (self::js($l['gross_kg']) ? self::n($l['gross_kg'], 'weight') : '—') . '</td><td class="muted">' . ($l['weight_mode'] === 'per_package' ? 'هر بسته / per package' : 'جمع گروه / group total') . '</td></tr>';
            }
            $rows .= '<tr style="background:#f6f6f6"><td colspan="4"><b>' . self::tri('group') . ': ' . self::esc($prod) . '</b></td><td class="num"><b>' . self::n($g['packages']) . '</b></td><td></td><td class="num"><b>' . self::n($g['bars']) . '</b></td><td class="num"><b>' . self::n($g['net'], 'weight') . '</b></td><td class="num"><b>' . ($g['gross']->isZero() ? '—' : self::n($g['gross'], 'weight')) . '</b></td><td></td></tr>';
            $tot['packages'] += $g['packages'];
            $tot['bars'] += $g['bars'];
            $tot['net'] = $tot['net']->add($g['net']);
            $tot['gross'] = $tot['gross']->add($g['gross']);
        }
        $meta = $d['meta'];
        $css = PdfRender::baseCss('rtl', $fontCss, ['watermark' => $meta['env'] !== 'production' ? 'x' : null, 'footer' => self::P['title'][0] . ' ' . $d['number']]);
        return '<!doctype html><html lang="fa"><head><meta charset="utf-8"><title>' . self::tri('title') . ' ' . self::esc($d['number']) . '</title><style>' . $css . '</style></head><body>
  ' . self::head('fa', $d['seller'], self::tri('title'), (string) $d['number'], $d['date'] ?? null, $meta) . '
  ' . (!empty($d['incomplete_date']) ? '<div class="muted">⚠ تاریخ ناقص؛ سند قطعی نیست</div>' : '') . '
  <div class="box grid2"><div>' . self::tri('from') . ': ' . self::esc($d['from'] ?? '—') . '</div><div>' . self::tri('to') . ': ' . self::esc($d['to'] ?? '—') . '</div><div>' . self::tri('resp') . ': ' . self::esc($d['responsible'] ?? '—') . '</div><div>' . self::tri('driver') . ': ' . self::esc($d['driver'] ?? '—') . ' · ' . self::tri('plate') . ': ' . self::fa(self::esc($d['plate'] ?? '—')) . '</div></div>
  <table><thead><tr><th>' . self::tri('product') . '</th><th>' . self::tri('filler') . '</th><th>' . self::tri('color') . '</th><th>' . self::tri('length') . '</th><th>' . self::tri('packages') . '</th><th>' . self::tri('bpp') . '</th><th>' . self::tri('bars') . '</th><th>' . self::tri('net') . '</th><th>' . self::tri('gross') . '</th><th>' . self::tri('src') . '</th></tr></thead><tbody>' . $rows . '</tbody>
  <tfoot><tr><th colspan="4">' . self::tri('total') . '</th><th class="num">' . self::n($tot['packages']) . '</th><th></th><th class="num">' . self::n($tot['bars']) . '</th><th class="num">' . self::n($tot['net'], 'weight') . '</th><th class="num">' . ($tot['gross']->isZero() ? '—' : self::n($tot['gross'], 'weight')) . '</th><th></th></tr></tfoot></table>
  <div class="sig"><div>' . self::tri('resp') . '</div><div>' . self::tri('driver') . '</div></div></body></html>';
    }

    // ---------------------------------------------------------------- commercial invoice

    /** Commercial invoice for export (Arabic + English). */
    public static function commercialInvoiceHtml(array $d, string $fontCss): string
    {
        $b = static fn (string $ar, string $en) => self::esc($ar) . ' / ' . self::esc($en);
        $cur = $d['currency'];
        $rows = '';
        foreach (array_values($d['lines']) as $i => $l) {
            $rows .= '<tr><td class="num">' . ($i + 1) . '</td><td>' . self::esc($l['description']) . (self::js($l['description_ar'] ?? null) ? '<div class="muted">' . self::esc($l['description_ar']) . '</div>' : '') . '</td><td class="num">' . (self::js($l['net_kg']) ? self::n($l['net_kg'], 'weight') : '—') . '</td><td class="num">' . (self::js($l['gross_kg']) ? self::n($l['gross_kg'], 'weight') : '—') . '</td><td class="num">' . self::n($l['packages']) . '</td><td class="num">' . (self::js($l['unit_price']) ? self::n($l['unit_price'], $cur) : '—') . '</td><td class="num">' . (self::js($l['amount']) ? self::n($l['amount'], $cur) : '—') . '</td></tr>';
        }
        $s = $d['seller'];
        $meta = $d['meta'];
        $sellerName = self::js($s['name_ar'] ?? null) ? $s['name_ar'] : (self::js($s['name_en'] ?? null) ? $s['name_en'] : $s['name']);
        $sellerAddr = $s['address_en'] ?? $s['address_ar'] ?? '';
        $buyerName = self::js($d['buyer']['name_ar'] ?? null) ? $d['buyer']['name_ar'] : $d['buyer']['name'];
        $css = PdfRender::baseCss('rtl', $fontCss, ['watermark' => $meta['env'] !== 'production' ? 'x' : null, 'footer' => 'Commercial Invoice ' . $d['number']]);
        return '<!doctype html><html lang="ar"><head><meta charset="utf-8"><title>Commercial Invoice ' . self::esc($d['number']) . '</title><style>' . $css . '</style></head><body>
  ' . self::head('ar', $s, 'فاتورة تجارية / Commercial Invoice', (string) $d['number'], $d['date'] ?? null, $meta) . '
  <div class="grid2"><div class="box"><b>' . $b('البائع', 'Seller') . '</b><div>' . self::esc($sellerName) . '</div><div class="muted">' . self::esc($sellerAddr) . '</div></div><div class="box"><b>' . $b('المشتري', 'Buyer') . '</b><div>' . self::esc($buyerName) . '</div><div class="muted">' . self::esc($d['buyer']['address'] ?? '') . '</div></div>
  <div class="box"><b>' . $b('المرسل إليه', 'Consignee') . '</b><div>' . self::esc($d['consignee'] ?? $d['buyer']['name']) . '</div></div><div class="box"><div>' . $b('شرط التسليم', 'Delivery term') . ': ' . self::esc($d['delivery_term'] ?? '—') . '</div><div>' . $b('المنفذ الحدودي', 'Border') . ': ' . self::esc($d['border'] ?? '—') . '</div></div></div>
  <table><thead><tr><th>#</th><th>' . $b('وصف البضاعة', 'Description') . '</th><th>' . $b('الوزن الصافي', 'Net kg') . '</th><th>' . $b('الوزن القائم', 'Gross kg') . '</th><th>' . $b('الطرود', 'Packages') . '</th><th>' . $b('سعر الوحدة', 'Unit price') . ' (' . self::CUR[$cur]['en'] . ')</th><th>' . $b('الإجمالي', 'Amount') . '</th></tr></thead><tbody>' . $rows . '</tbody>
  <tfoot><tr><th colspan="6">' . $b('المجموع', 'Total') . '</th><th class="num">' . self::n($d['total'], $cur) . ' ' . self::CUR[$cur]['en'] . '</th></tr></tfoot></table>
  <div class="box words"><b>' . $b('المبلغ بالحروف', 'Amount in words') . ':</b> ' . self::esc(Words::amountToArabic((string) $d['total'], $cur)) . '</div>
  <div class="sig"><div>' . $b('ختم وتوقيع البائع', 'Seller stamp & signature') . '</div><div>' . $b('ختم وتوقيع المشتري', 'Buyer stamp & signature') . '</div></div></body></html>';
    }

    // ---------------------------------------------------------------- party statement

    /** Party statement / كشف حساب: per currency, opening, rows with running balance, closing. */
    public static function statementHtml(array $d, string $lang, string $fontCss): string
    {
        $title = $lang === 'ar' ? 'كشف حساب' : (!empty($d['workshop']) ? 'صورتحساب کارگاه' : 'صورتحساب مشتری');
        $opening = (array) ($d['opening'] ?? []);
        $closing = (array) ($d['closing'] ?? []);
        $curs = [];
        foreach (array_keys($opening) as $c) $curs[(string) $c] = true;
        foreach ($d['rows'] as $r) $curs[(string) $r['currency']] = true;
        foreach (array_keys($closing) as $c) $curs[(string) $c] = true;
        $sections = '';
        foreach (array_keys($curs) as $c) {
            $rows = '';
            foreach ($d['rows'] as $r) {
                if ($r['currency'] !== $c) continue;
                $rows .= '<tr><td>' . self::jd($r['date']) . '</td><td>' . self::fa(self::esc($r['number'])) . '</td><td>' . self::esc(self::KIND_FA[$r['kind']] ?? $r['kind']) . (self::js($r['description'] ?? null) ? ' — ' . self::esc($r['description']) : '') . '</td><td class="num">' . (self::js($r['debit'] ?? null) ? self::n($r['debit'], $c) : '') . '</td><td class="num">' . (self::js($r['credit'] ?? null) ? self::n($r['credit'], $c) : '') . '</td><td class="num">' . self::n($r['balance'], $c) . '</td></tr>';
            }
            $sections .= '<h2>' . self::CUR[$c][$lang] . '</h2><table><thead><tr><th>' . self::t('date', $lang) . '</th><th>' . self::t('number', $lang) . '</th><th>' . ($lang === 'ar' ? 'البيان' : 'شرح') . '</th><th>' . ($lang === 'ar' ? 'مدين' : 'بدهکار') . '</th><th>' . ($lang === 'ar' ? 'دائن' : 'بستانکار') . '</th><th>' . ($lang === 'ar' ? 'الرصيد' : 'مانده') . '</th></tr></thead>
    <tbody><tr><td colspan="5">' . ($lang === 'ar' ? 'الرصيد الافتتاحي' : 'مانده قبلی') . '</td><td class="num">' . self::n($opening[$c] ?? '0', $c) . '</td></tr>' . $rows . '</tbody><tfoot><tr><th colspan="5">' . ($lang === 'ar' ? 'الرصيد الختامي' : 'مانده نهایی') . '</th><th class="num">' . self::n($closing[$c] ?? '0', $c) . ' ' . self::CUR[$c][$lang] . '</th></tr></tfoot></table>';
        }
        $p = $d['party'];
        $meta = $d['meta'];
        $name = $lang === 'ar' ? (self::js($p['name_ar'] ?? null) ? $p['name_ar'] : $p['name']) : $p['name'];
        $range = (self::js($d['from'] ?? null) ? ($lang === 'ar' ? 'من' : 'از') . ' ' . self::fa($d['from']) : '') . ' ' . (self::js($d['to'] ?? null) ? ($lang === 'ar' ? 'إلى' : 'تا') . ' ' . self::fa($d['to']) : '');
        $css = PdfRender::baseCss('rtl', $fontCss, ['watermark' => $meta['env'] !== 'production' ? 'x' : null, 'footer' => $title . ' ' . $p['name']]);
        return '<!doctype html><html lang="' . $lang . '"><head><meta charset="utf-8"><title>' . $title . ' ' . self::esc($p['name']) . '</title><style>' . $css . '</style></head><body>
  ' . self::head($lang, $d['seller'], $title, '', new \DateTimeImmutable('now', new \DateTimeZone('UTC')), $meta) . '
  <div class="box"><b>' . self::t('buyer_name', $lang) . ':</b> ' . self::esc($name) . ' · ' . self::t('phone', $lang) . ': ' . self::fa(self::esc($p['phone'] ?? '—')) . '<div class="muted">' . $range . '</div></div>
  ' . ($sections !== '' ? $sections : '<div class="muted">سندی نیست</div>') . '
  <div class="muted">مانده مثبت = طلب ویترال از طرف؛ مانده منفی = بدهی ویترال.</div></body></html>';
    }

    // ---------------------------------------------------------------- bundle label

    /** A6 bundle label: code, product, filler, length, bars, weight, g/m, date, link. */
    public static function bundleLabelHtml(array $b, string $fontCss): string
    {
        $css = PdfRender::baseCss('rtl', $fontCss, ['pageSize' => 'A6', 'footer' => $b['code']]);
        return '<!doctype html><html lang="fa"><head><meta charset="utf-8"><title>برچسب ' . self::esc($b['code']) . '</title><style>' . $css . ' body{font-size:14px} .big{font-size:40px;font-weight:800;text-align:center;letter-spacing:2px} .kv{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;margin-top:10px}</style></head><body>
  <div class="big">' . self::fa(self::esc($b['code'])) . '</div><div style="text-align:center;font-size:18px">' . self::esc($b['product']) . '</div>
  <div class="kv"><div>فیلر: ' . (self::js($b['filler_mm']) ? self::n($b['filler_mm'], 'filler') . ' میلی‌متر' : '—') . '</div><div>طول: ' . (self::js($b['length_m']) ? self::n($b['length_m'], 'length') . ' متر' : '—') . '</div><div>تعداد: ' . ($b['bars'] !== null ? self::n($b['bars']) . ' شاخه' : '—') . '</div><div>وزن: <b>' . self::n($b['weight_kg'], 'weight') . ' کیلوگرم</b></div><div>وزن هر متر: ' . (self::js($b['g_per_m']) ? self::n($b['g_per_m'], 'g_per_m') . ' گرم' : '—') . '</div><div>تاریخ: ' . self::jd($b['reported_at']) . '</div></div>
  ' . (self::js($b['url']) ? '<div class="muted" style="margin-top:12px;direction:ltr;text-align:center;word-break:break-all">' . self::esc($b['url']) . '</div>' : '') . '</body></html>';
    }

    // ---------------------------------------------------------------- daily report

    /** Weight as in the report text (§12-a): Persian digits, no trailing decimal zeros («۳۹۴»، «۲۱۳٫۵»). */
    public static function kgt(mixed $v): string
    {
        if ($v === null) return '—';
        return (string) preg_replace_callback('/٫([۰-۹]*?)۰+$/u', static fn ($m) => $m[1] !== '' ? '٫' . $m[1] : '', self::n($v, 'weight'));
    }

    /** Daily report (module 10, §14/§15): decisions, production per product with totals, loads, filler checks, money (finance only), notes, tasks. */
    public static function dailyReportHtml(array $d, string $fontCss): string
    {
        $r = $d['report'];
        $title = 'گزارش روزانه';
        $s = static fn (mixed $v) => self::esc($v === null ? '—' : self::str($v));
        $dec = $r['decisions'];
        $full = (bool) $d['full'];
        $finance = (bool) $d['finance'];
        $decisions = '';
        foreach ($dec['quarantine'] as $q) {
            $decisions .= '<tr><td>بندیل قرنطینه</td><td>' . self::fa($s($q['code'] ?? null)) . '</td><td>' . $s(self::STATUS_FA[self::str($q['status'] ?? '')] ?? ($q['status'] ?? null)) . (self::js($q['defect'] ?? null) ? ' — ' . $s($q['defect']) : '') . (self::js($q['qc_note'] ?? null) ? ' — ' . $s($q['qc_note']) : '') . '</td><td class="num">' . self::kgt($q['weight_kg'] ?? null) . '</td></tr>';
        }
        foreach ($dec['weight_warnings'] as $w) {
            $msgs = [];
            if (is_array($w['warnings'] ?? null) && array_is_list($w['warnings'])) {
                foreach ($w['warnings'] as $x) {
                    $x = (array) $x;
                    $msgs[] = self::str($x['message'] ?? $x['kind'] ?? '');
                }
            }
            $decisions .= '<tr><td>هشدار وزن</td><td>' . self::fa($s($w['code'] ?? null)) . '</td><td>' . self::esc(implode('، ', $msgs)) . '</td><td class="num">' . self::kgt($w['weight_kg'] ?? null) . '</td></tr>';
        }
        foreach ($dec['incomplete_documents'] as $x) {
            $kind = ($x['type'] ?? null) === 'scale_ticket' ? 'scale_ticket' : self::str($x['kind'] ?? '');
            $docKinds = self::KIND_FA + ['scale_ticket' => 'قبض باسکول'];
            $decisions .= '<tr><td>مدرک ناقص</td><td>' . self::fa($s($x['number'] ?? $x['transfer_number'] ?? null)) . '</td><td>' . $s($docKinds[$kind] ?? ($x['kind'] ?? null)) . '</td><td></td></tr>';
        }
        $groups = '';
        foreach ($r['production']['groups'] as $g) {
            $groups .= '<tr style="background:#f6f6f6"><td colspan="' . ($full ? 5 : 2) . '"><b>🔹 ' . self::esc($g['product_name']) . ': ' . self::kgt($g['total_kg']) . ' کیلو</b></td></tr>';
            foreach ($g['bundles'] as $b) {
                $extra = '';
                if ($full) {
                    $notes = array_filter([$b['status'] !== 'ok' ? (self::STATUS_FA[$b['status']] ?? $b['status']) : '', $b['note'] ?? ''], [self::class, 'js']);
                    $extra = '<td class="num">' . ($b['bars'] === null ? '—' : self::fa((string) $b['bars'])) . '</td><td class="num">' . (self::js($b['g_per_m']) ? self::n($b['g_per_m'], 'g_per_m') : '—') . '</td><td>' . implode('، ', array_map([self::class, 'esc'], $notes)) . '</td>';
                }
                $groups .= '<tr><td>' . self::fa(self::esc($b['code'])) . (!empty($b['mixed']) ? ' <span class="muted">(درهم)</span>' : '') . '</td><td class="num">' . self::kgt($b['weight_kg']) . '</td>' . $extra . '</tr>';
            }
        }
        $transfers = '';
        foreach ($r['transfers'] as $t) {
            $rk = $t['received_kg'] ?? null;
            $transfers .= '<tr><td>' . self::fa($s($t['number'] ?? null)) . '</td><td>' . $s($t['from_name'] ?? null) . ' ← ' . $s($t['to_name'] ?? null) . '</td><td class="num">' . self::kgt($t['kg'] ?? null) . '</td><td class="num">' . (self::js($rk) && (float) $rk != 0.0 ? self::kgt($rk) : '—') . '</td><td class="num">' . self::n($t['tickets'] ?? null) . '</td><td>' . $s(self::TRANSFER_STATUS_FA[self::str($t['status'] ?? '')] ?? ($t['status'] ?? null)) . '</td><td>' . self::fa($s($t['plate'] ?? null)) . '</td></tr>';
        }
        $fillers = '';
        foreach ($r['filler_checks'] as $f) {
            $fillers .= '<tr><td>' . self::fa($s($f['die_code'] ?? null)) . '</td><td>' . (($f['kind'] ?? null) === 'filler_check' ? 'چک فیلر' : (($f['kind'] ?? null) === 'repair' ? 'تعمیر' : 'آسیب')) . '</td><td class="num">' . (self::js($f['measured_filler_mm'] ?? null) ? self::n($f['measured_filler_mm'], 'filler') : '—') . '</td><td>' . $s($f['detail'] ?? null) . '</td></tr>';
        }
        $money = '';
        if ($finance && is_array($r['money'] ?? null)) {
            foreach ($r['money'] as $m) {
                $cur = (string) ($m['currency'] ?? '');
                $money .= '<tr><td>' . self::fa($s($m['number'] ?? null)) . '</td><td>' . (($m['kind'] ?? null) === 'receipt' ? 'دریافت' : 'پرداخت') . '</td><td>' . $s($m['party_name'] ?? null) . '</td><td class="num">' . self::n($m['amount'] ?? null, isset(Num::PLACES[$cur]) ? $cur : null) . ' ' . (self::CUR[$cur]['fa'] ?? '') . '</td><td>' . $s(self::MONEY_STATUS_FA[self::str($m['status'] ?? '')] ?? ($m['status'] ?? null)) . '</td><td>' . $s($m['reported_by_name'] ?? null) . '</td></tr>';
            }
        }
        $notes = '';
        foreach ($r['free_notes'] as $x) {
            $cur = (string) ($x['currency'] ?? 'TOMAN');
            $amt = $finance ? '<td class="num">' . (self::js($x['amount'] ?? null) ? self::n($x['amount'], $cur) . ' ' . (self::CUR[$cur]['fa'] ?? '') : '—') . '</td>' : '';
            $notes .= '<tr><td>' . $s($x['user_name'] ?? null) . '</td><td class="words">' . $s($x['text'] ?? null) . '</td><td class="num">' . (self::js($x['kg'] ?? null) ? self::kgt($x['kg']) : '—') . '</td>' . $amt . '</tr>';
        }
        $tasks = '';
        foreach ($r['tasks']['closed'] as $x) $tasks .= '<tr><td>✅ بسته‌شده</td><td>' . $s($x['title'] ?? null) . '</td><td>' . $s($x['assignee'] ?? null) . '</td><td>' . $s($x['done_note'] ?? null) . '</td></tr>';
        foreach ($r['tasks']['open'] as $x) $tasks .= '<tr><td>باز</td><td>' . $s($x['title'] ?? null) . '</td><td>' . $s($x['assignee'] ?? null) . '</td><td>' . (self::js($x['due_at'] ?? null) ? self::jd($x['due_at']) : '—') . '</td></tr>';
        $empty = static fn (int $cols) => '<tr><td colspan="' . $cols . '" class="muted">موردی نیست</td></tr>';
        $or = static fn (string $html, string $fallback) => $html !== '' ? $html : $fallback;
        $meta = $d['meta'];
        $css = PdfRender::baseCss('rtl', $fontCss, ['watermark' => $meta['env'] !== 'production' ? 'x' : null, 'footer' => $title . ' ' . $r['date']]);
        return '<!doctype html><html lang="fa"><head><meta charset="utf-8"><title>' . $title . ' ' . self::esc($r['date']) . '</title><style>' . $css . '</style></head><body>
  ' . self::head('fa', $d['seller'], $title, (string) $r['date'], $d['day'], $meta) . '
  <h2>۱. نیازمند تصمیم</h2><table><thead><tr><th>نوع</th><th>کد / شماره</th><th>شرح</th><th>وزن (کیلو)</th></tr></thead><tbody>' . $or($decisions, $empty(4)) . '</tbody></table>
  ' . ($finance && self::js($dec['pending_money'] ?? 0) ? '<div class="muted">' . self::fa((string) $dec['pending_money']) . ' دریافت/پرداخت در انتظار تأیید</div>' : '') . '
  <h2>۲. موجودی تولیدشده — کد بندیل » وزن بندیل</h2><table><thead><tr><th>کد بندیل</th><th>وزن (کیلو)</th>' . ($full ? '<th>شاخه</th><th>وزن هر متر (گرم)</th><th>توضیح</th>' : '') . '</tr></thead><tbody>' . $or($groups, $empty($full ? 5 : 2)) . '</tbody>
  <tfoot><tr><th>✅ جمع کل: ' . self::kgt($r['production']['total_kg']) . ' کیلو</th><th colspan="' . ($full ? 4 : 1) . '">📦 تعداد بندیل: ' . self::fa((string) $r['production']['bundle_count']) . '</th></tr></tfoot></table>
  <h2>۳. بارهای رفته و آمده</h2><table><thead><tr><th>شماره</th><th>مسیر</th><th>وزن (کیلو)</th><th>دریافتی (کیلو)</th><th>قبض</th><th>وضعیت</th><th>پلاک</th></tr></thead><tbody>' . $or($transfers, $empty(7)) . '</tbody></table>
  <h2>۴. چک فیلر قالب‌ها</h2><table><thead><tr><th>قالب</th><th>رویداد</th><th>فیلر (میلی‌متر)</th><th>شرح</th></tr></thead><tbody>' . $or($fillers, $empty(4)) . '</tbody></table>
  ' . ($finance ? '<h2>۵. وجوه گزارش‌شده</h2><table><thead><tr><th>شماره</th><th>نوع</th><th>طرف</th><th>مبلغ</th><th>وضعیت</th><th>ثبت‌کننده</th></tr></thead><tbody>' . $or($money, $empty(6)) . '</tbody></table>' : '') . '
  <h2>' . ($finance ? '۶' : '۵') . '. ثبت‌های آزاد</h2><table><thead><tr><th>کاربر</th><th>متن</th><th>کیلو</th>' . ($finance ? '<th>مبلغ</th>' : '') . '</tr></thead><tbody>' . $or($notes, $empty($finance ? 4 : 3)) . '</tbody></table>
  <h2>' . ($finance ? '۷' : '۶') . '. کارها</h2><table><thead><tr><th>وضعیت</th><th>عنوان</th><th>مسئول</th><th>توضیح / موعد</th></tr></thead><tbody>' . $or($tasks, $empty(4)) . '</tbody></table>
  </body></html>';
    }
}
