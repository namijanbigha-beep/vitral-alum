<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\AuthUser;
use Vitral\Core\Db;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\Settings as SettingsStore;
use Vitral\Core\V;
use Vitral\Lib\Decimal;
use Vitral\Lib\DailyReport;
use Vitral\Lib\FileType;
use Vitral\Lib\Jalali;
use Vitral\Lib\Num;
use Vitral\Lib\OrdersService;
use Vitral\Lib\PdfRender;
use Vitral\Lib\PdfTemplates;
use Vitral\Rules\Money as MoneyRules;

/**
 * Port of apps/server/src/modules/pdf/routes.ts: proforma, invoice / credit note, packing list, commercial invoice,
 * party statement, daily report and bundle label.
 *
 *   format=html  script-free preview (strict CSP), never archived or counted
 *   format=pdf|png
 *     - Chromium available (CHROMIUM_PATH executable + proc_open allowed): real PDF / PNG; sale documents and transfer
 *       papers are archived in `files` (kind document_pdf), print_count + 1, audit «print» (T48: no financial document)
 *     - otherwise (shared hosting): the same page with a nonce-bound print script, exactly the Node fallback
 */
final class Pdf
{
    private const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

    private static function fmt(): \Vitral\Core\Schema
    {
        return V::object(['format' => V::enum(['pdf', 'png', 'html'])->default('pdf'), 'lang' => V::enum(['fa', 'ar'])->default('fa')]);
    }

    /** @return array<string,mixed> Seller of templates.ts */
    public static function sellerInfo(App $app): array
    {
        $db = $app->db();
        $s = SettingsStore::many($db, ['seller_name_fa', 'seller_name_ar', 'seller_name_en', 'seller_address_fa', 'seller_address_ar', 'seller_address_en', 'seller_phone', 'seller_logo_file_id']);
        $str = static fn (string $k) => isset($s[$k]) && is_string($s[$k]) ? $s[$k] : null;
        $logo = $str('seller_logo_file_id') !== null ? self::fileDataUri($app, $str('seller_logo_file_id'), false) : null;
        return [
            'name' => $str('seller_name_fa') ?? 'ویترال آلومینیوم', 'name_ar' => $str('seller_name_ar'), 'name_en' => $str('seller_name_en'),
            'address' => $str('seller_address_fa'), 'address_ar' => $str('seller_address_ar'), 'address_en' => $str('seller_address_en'),
            'phone' => $str('seller_phone'), 'logo' => $logo,
        ];
    }

    /** An image file as a data: URI (the thumbnail when asked and present); null for non-images or unreadable files. */
    public static function fileDataUri(App $app, string $fileId, bool $thumb = true): ?string
    {
        $f = $app->db()->one('SELECT storage_key, thumb_key, mime FROM files WHERE id = ?', [$fileId]);
        if (!$f || !str_starts_with((string) $f['mime'], 'image/')) return null;
        try {
            $useThumb = $thumb && $f['thumb_key'];
            $buf = $app->storage()->read($useThumb ? $f['thumb_key'] : $f['storage_key']);
            // Thumbnails are WebP on this server (JPEG in Node): name the bytes as they are.
            $mime = $useThumb ? (FileType::detectMime($buf) ?? 'image/jpeg') : $f['mime'];
            return 'data:' . $mime . ';base64,' . base64_encode($buf);
        } catch (\Throwable) {
            return null;
        }
    }

    /** @return array{env:string,version:int,issued_by:string,print_count:int,draft:bool} */
    private static function meta(App $app, AuthUser $user, int $version, int $printCount, bool $draft): array
    {
        return ['env' => $app->config->str('APP_ENV') ?: 'production', 'version' => $version, 'issued_by' => $user->name, 'print_count' => $printCount, 'draft' => $draft];
    }

    /** encodeURIComponent of JavaScript. */
    private static function uri(string $s): string
    {
        return strtr(rawurlencode($s), ['%21' => '!', '%2A' => '*', '%27' => "'", '%28' => '(', '%29' => ')']);
    }

    /**
     * Render and respond. `$onPdf` (archive + print counter) runs before the body is returned, so a failed archive
     * surfaces as an error, never as a silent print.
     */
    public static function send(App $app, string $html, string $format, string $filename, ?callable $onPdf = null): Response
    {
        if ($format === 'html') {
            return Response::raw($html, 'text/html; charset=utf-8')->header('content-security-policy', self::PREVIEW_CSP);
        }
        if (!PdfRender::chromiumAvailable($app->config)) {
            // Shared hosting has no Chromium: hand the same page to the browser and open its print dialog («Save as PDF»).
            $nonce = str_replace('-', '', Db::uuid());
            $page = self::replaceFirst('</body>', "<script nonce=\"{$nonce}\">addEventListener('load',()=>setTimeout(()=>print(),300))</script></body>", $html);
            // Still a print (T48): count it and audit it; there is no server-side PDF to archive.
            if ($onPdf) $onPdf(null);
            return Response::raw($page, 'text/html; charset=utf-8')->header('content-security-policy', self::PREVIEW_CSP . "; script-src 'nonce-{$nonce}'");
        }
        $r = PdfRender::renderPdf($app->config, $html, $format === 'png');
        if ($onPdf) $onPdf($r['pdf']);
        $body = $format === 'png' ? (string) $r['png'] : $r['pdf'];
        return Response::raw($body, $format === 'png' ? 'image/png' : 'application/pdf')
            ->header('content-disposition', 'inline; filename="' . self::uri($filename) . '.' . $format . '"');
    }

    private static function replaceFirst(string $needle, string $replacement, string $haystack): string
    {
        $pos = strpos($haystack, $needle);
        return $pos === false ? $haystack : substr_replace($haystack, $replacement, $pos, strlen($needle));
    }

    /** Archive the PDF in `files` (kind document_pdf) and bump the print counter; never creates a financial document (T48). */
    private static function archive(App $app, string $entity, string $id, ?string $pdf, string $name, AuthUser $user): void
    {
        if ($pdf === null) {
            // Printed from the browser (no Chromium on the host): count + audit, nothing to archive.
            $app->db()->transaction(static function (Db $trx) use ($entity, $id, $name, $user) {
                $trx->exec('UPDATE ' . Db::ident($entity) . ' SET print_count = print_count + 1 WHERE id = ?', [$id]);
                Audit::log($trx, ['userId' => $user->id, 'entity' => $entity, 'entityId' => $id, 'action' => 'print', 'after' => ['file_id' => null, 'name' => $name, 'printed_in_browser' => true]]);
            });
            return;
        }
        $storage = $app->storage();
        $key = $storage->put($pdf);
        try {
            $app->db()->transaction(static function (Db $trx) use ($entity, $id, $pdf, $name, $user, $key) {
                $fileId = $trx->insertNoReturn('files', [
                    'storage_key' => $key, 'thumb_key' => null, 'original_name' => $name, 'mime' => 'application/pdf', 'size' => strlen($pdf), 'sha256' => hash('sha256', $pdf),
                    'kind' => 'document_pdf', 'caption' => null, 'sensitive' => false, 'owner_entity' => $entity, 'owner_id' => $id, 'sort_order' => 0, 'created_by' => $user->id,
                ]);
                $trx->insertNoReturn('file_links', ['file_id' => $fileId, 'entity' => $entity, 'entity_id' => $id, 'created_by' => $user->id]);
                $trx->exec('UPDATE ' . Db::ident($entity) . ' SET print_count = print_count + 1 WHERE id = ?', [$id]);
                Audit::log($trx, ['userId' => $user->id, 'entity' => $entity, 'entityId' => $id, 'action' => 'print', 'after' => ['file_id' => $fileId, 'name' => $name]]);
            });
        } catch (\Throwable $e) {
            $storage->remove($key);
            throw $e;
        }
    }

    /** First phone of a `phones` JSON column. */
    private static function firstPhone(mixed $phones): ?string
    {
        return is_array($phones) && isset($phones[0]) ? (string) $phones[0] : null;
    }

    private static function address(array $party): ?string
    {
        $parts = array_filter([$party['city'] ?? null, $party['address'] ?? null], [PdfTemplates::class, 'js']);
        return $parts ? implode('، ', $parts) : null;
    }

    /** jalaliDateArg of lib/dates.ts: «1405/07/10» (any digits) or today's Jalali date in Tehran. */
    public static function jalaliDateArg(?string $input): array
    {
        if ($input === null || $input === '') return Jalali::of();
        $j = Jalali::parse($input);
        if ($j === null) throw new \RangeException('تاریخ شمسی نامعتبر است');
        return $j;
    }

    public static function register(Router $r, App $app): void
    {
        // ── Proforma (from the order; no financial document) ─────────────────────────
        $r->get('/orders/:id/proforma', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $q = self::fmt()->parse($req->query);
            $db = $app->db();
            $order = $db->find('orders', $id) ?? throw new AppError('not_found');
            $lines = OrdersService::loadLines($db, $id);
            $party = $db->one('SELECT name, name_ar, phones, address, city FROM parties WHERE id = ?', [$order['party_id']]) ?? throw new \RuntimeException('no result');
            $seller = self::sellerInfo($app);
            $paid = OrdersService::postedReceiptsForOrder($db, $id);
            $fontCss = PdfRender::loadFontCss($app->config);
            $settings = SettingsStore::many($db, ['sales_terms_fa', 'sales_terms_ar', 'proforma_validity_text', 'default_prepay_percent']);
            $totals = OrdersService::orderTotals($order, $lines, $paid);
            $cur = (string) $order['currency'];
            $saleLines = [];
            $missingAr = false;
            foreach ($lines as $l) {
                if ($q['lang'] === 'ar' && $l['kind'] === 'profile' && !PdfTemplates::js($l['name_ar'] ?? null) && !PdfTemplates::js($l['product_name_ar'] ?? null)) $missingAr = true;
                $basisQty = OrdersService::lineBasisQty($l);
                $dieCode = null;
                if (PdfTemplates::js($l['die_id'] ?? null)) $dieCode = $db->value('SELECT code FROM dies WHERE id = ?', [$l['die_id']]);
                $pb = $l['price_basis'];
                $saleLines[] = [
                    'code' => $l['product_code'] ?? null,
                    'name' => $l['kind'] === 'profile' ? ($l['product_name'] ?? $l['description'] ?? '') : ($l['description'] ?? $l['kind']),
                    'name_ar' => $l['name_ar'] ?? $l['product_name_ar'] ?? null, 'name_en' => $l['name_en'] ?? null,
                    'image' => PdfTemplates::js($l['product_file_id'] ?? null) ? self::fileDataUri($app, $l['product_file_id']) : null,
                    'filler_mm' => $l['filler_mm'] ?? null, 'length_m' => $l['length_m'] ?? null, 'die_code' => $dieCode,
                    'kind' => $l['kind'], 'color' => $l['color'] ?? null, 'load_type' => $l['load_type_label'] ?? null, 'gpm' => $l['weight_g_per_m'] ?? null,
                    'qty' => $basisQty, 'qty_unit' => $pb === 'per_kg' ? 'kg' : ($pb === 'per_piece' ? 'piece' : ($pb === 'per_bar' ? 'bar' : 'm')),
                    'unit_price' => $l['unit_price'], 'price_basis' => $pb, 'currency' => $l['currency'],
                    'amount' => MoneyRules::lineAmount($basisQty, $l['unit_price'], (string) $l['currency'], $l['discount_amount'] ?? 0, $l['discount_percent'] ?? 0),
                    'vat_rate' => $l['vat_rate'] ?? null, 'vat_amount' => $l['vat_amount'] ?? null,
                ];
            }
            $tt = (array) $totals['totals'];
            $prepayPercent = $order['prepay_percent'] ?? (isset($settings['default_prepay_percent']) ? (string) $settings['default_prepay_percent'] : null);
            $settingStr = static fn (string $k) => isset($settings[$k]) && is_string($settings[$k]) ? $settings[$k] : null;
            $doc = [
                'kind' => 'proforma', 'number' => $order['number'], 'date' => $order['order_date'], 'seller' => $seller,
                'buyer' => ['name' => $party['name'], 'name_ar' => $party['name_ar'], 'phone' => self::firstPhone($party['phones']), 'address' => self::address($party)],
                'lines' => $saleLines, 'currency' => $cur, 'totals' => $tt, 'total_kg' => $totals['total_kg'], 'terms' => $order['payment_terms'],
                'prepay_percent' => $prepayPercent, 'prepay_amount' => ((array) $totals['prepay'])[$cur] ?? $order['prepay_amount'], 'paid' => ((array) $totals['paid'])[$cur] ?? '0',
                'remaining' => ((array) $totals['remaining'])[$cur] ?? $tt[$cur] ?? null,
                'validity' => $order['validity_text'] ?? $settingStr('proforma_validity_text'),
                'notes' => $order['invoice_notes'] ?? $settingStr($q['lang'] === 'ar' ? 'sales_terms_ar' : 'sales_terms_fa'),
                'delivery_days' => $order['delivery_days'], 'incomplete' => (bool) $totals['incomplete'], 'missing_ar' => $missingAr,
                // Module 3: the proforma is the document sent to the customer, so it never carries the «پیش‌نویس» mark.
                'meta' => self::meta($app, $me, (int) $order['revision'], (int) $order['print_count'] + 1, false),
            ];
            $html = PdfTemplates::saleDocumentHtml($doc, $q['lang'], $fontCss);
            return self::send($app, $html, $q['format'], "proforma-{$order['number']}-{$q['lang']}", static function (?string $pdf) use ($app, $id, $order, $q, $me, $db) {
                self::archive($app, 'orders', $id, $pdf, "proforma-{$order['number']}-{$q['lang']}-v{$order['revision']}.pdf", $me);
                // Issuing the PDF moves a draft order to «پیش‌فاکتور» (module 3); approval stays a separate sales.approve step.
                $moved = $db->exec("UPDATE orders SET status_sales = 'proforma', updated_at = NOW(3) WHERE id = ? AND status_sales = 'draft'", [$id]);
                if ($moved > 0) Audit::log($db, ['userId' => $me->id, 'entity' => 'orders', 'entityId' => $id, 'action' => 'issue_proforma', 'before' => ['status_sales' => 'draft'], 'after' => ['status_sales' => 'proforma']]);
            });
        });

        // ── Invoice / credit note PDF from a financial document ──────────────────────
        $r->get('/documents/:id/pdf', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $q = self::fmt()->parse($req->query);
            $db = $app->db();
            $d = $db->find('documents', $id) ?? throw new AppError('not_found');
            if ($d['kind'] !== 'invoice' && $d['kind'] !== 'sales_return') throw new AppError('validation', 'فقط فاکتور فروش و برگشت فروش چاپ می‌شوند');
            if (!$d['party_id']) throw new AppError('validation', 'سند طرف حساب ندارد');
            $lines = $db->all(
                'SELECT document_lines.*, products.code AS product_code, products.name_ar AS product_name_ar, products.main_file_id AS product_file_id,
                        order_lines.filler_mm, order_lines.length_m, order_lines.color, order_lines.load_type_label, order_lines.weight_g_per_m,
                        order_lines.price_basis, order_lines.name_ar, order_lines.kind AS line_kind
                   FROM document_lines
                   LEFT JOIN order_lines ON order_lines.id = document_lines.order_line_id
                   LEFT JOIN products ON products.id = order_lines.product_id
                  WHERE document_id = ? ORDER BY document_lines.sort',
                [$id],
            );
            $party = $db->one('SELECT name, name_ar, phones, address, city FROM parties WHERE id = ?', [$d['party_id']]) ?? throw new \RuntimeException('no result');
            $seller = self::sellerInfo($app);
            $fontCss = PdfRender::loadFontCss($app->config);
            $settings = SettingsStore::many($db, ['sales_terms_fa', 'sales_terms_ar']);
            $transferNumber = $d['transfer_id'] ? $db->value('SELECT number FROM transfers WHERE id = ?', [$d['transfer_id']]) : null;
            $cur = (string) $d['currency'];
            $paidSum = $db->value(
                "SELECT SUM(allocations.amount) AS s FROM allocations INNER JOIN documents src ON src.id = allocations.from_document_id
                  WHERE allocations.to_document_id = ? AND src.status = 'posted'",
                [$id],
            );
            $paid = Num::round($paidSum ?? '0', $cur);
            $totalKg = Decimal::zero();
            foreach ($lines as $l) {
                if ($l['unit'] === 'kg' && PdfTemplates::js($l['qty'])) $totalKg = $totalKg->add((string) $l['qty']);
            }
            $saleLines = array_map(static fn (array $l) => [
                'code' => $l['product_code'], 'name' => $l['description'], 'name_ar' => $l['name_ar'] ?? $l['product_name_ar'], 'kind' => $l['line_kind'] ?? 'service',
                'filler_mm' => $l['filler_mm'], 'length_m' => $l['length_m'], 'color' => $l['color'], 'load_type' => $l['load_type_label'], 'gpm' => $l['weight_g_per_m'],
                'qty' => $l['qty'], 'qty_unit' => $l['unit'] === 'kg' ? 'kg' : ($l['unit'] === 'piece' ? 'piece' : ($l['unit'] === 'bar' ? 'bar' : 'm')),
                'unit_price' => $l['unit_price'], 'price_basis' => $l['price_basis'] ?? ($l['unit'] === 'kg' ? 'per_kg' : 'per_piece'), 'currency' => $cur,
                'amount' => $l['amount'], 'vat_rate' => $l['vat_rate'] ?? null, 'vat_amount' => $l['vat_amount'] ?? null,
            ], $lines);
            $amount = (string) ($d['amount'] ?? '0');
            $notesKey = $q['lang'] === 'ar' ? 'sales_terms_ar' : 'sales_terms_fa';
            $doc = [
                'kind' => $d['kind'] === 'invoice' ? 'invoice' : 'credit', 'number' => $d['number'], 'date' => $d['date'], 'seller' => $seller,
                'buyer' => ['name' => $party['name'], 'name_ar' => $party['name_ar'], 'phone' => self::firstPhone($party['phones']), 'address' => self::address($party)],
                'lines' => $saleLines, 'currency' => $cur, 'totals' => [$cur => Num::round($amount, $cur)], 'total_kg' => Num::round($totalKg, 'weight'), 'terms' => 'cash',
                'paid' => $paid, 'remaining' => Num::round(Decimal::of($amount)->sub($paid), $cur),
                'notes' => isset($settings[$notesKey]) && is_string($settings[$notesKey]) ? $settings[$notesKey] : null,
                'shipment_ref' => $transferNumber, 'settlement_kg' => $d['settlement_basis_kg'] ?? null,
                'meta' => self::meta($app, $me, (int) $d['version'], (int) $d['print_count'] + 1, $d['status'] !== 'posted'),
            ];
            $html = PdfTemplates::saleDocumentHtml($doc, $q['lang'], $fontCss);
            return self::send($app, $html, $q['format'], "{$d['kind']}-{$d['number']}-{$q['lang']}", static fn (?string $pdf) => self::archive($app, 'documents', $id, $pdf, "{$d['kind']}-{$d['number']}-{$q['lang']}.pdf", $me));
        });

        // ── Packing list & commercial invoice from a transfer ────────────────────────
        $transferContext = static function (string $id) use ($app): array {
            $db = $app->db();
            $t = $db->find('transfers', $id) ?? throw new AppError('not_found');
            $from = $t['from_location_id'] ? $db->one('SELECT name FROM locations WHERE id = ?', [$t['from_location_id']]) : null;
            $to = $t['to_location_id'] ? $db->one(
                'SELECT locations.name, parties.name AS party_name, parties.name_ar AS party_name_ar, parties.address, parties.id AS party_id
                   FROM locations LEFT JOIN parties ON parties.id = locations.party_id WHERE locations.id = ?',
                [$t['to_location_id']],
            ) : null;
            $packing = $db->all(
                'SELECT packing_lines.*, products.name_fa, products.name_ar, products.name_en FROM packing_lines
                   LEFT JOIN products ON products.id = packing_lines.product_id WHERE transfer_id = ? ORDER BY packing_lines.sort',
                [$id],
            );
            return ['t' => $t, 'from' => $from, 'to' => $to, 'packing' => $packing, 'seller' => self::sellerInfo($app), 'fontCss' => PdfRender::loadFontCss($app->config)];
        };

        $r->get('/transfers/:id/packing-list', static function (Request $req) use ($app, $transferContext) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $q = self::fmt()->parse($req->query);
            ['t' => $t, 'from' => $from, 'to' => $to, 'packing' => $packing, 'seller' => $seller, 'fontCss' => $fontCss] = $transferContext($id);
            if (!$packing) throw new AppError('validation', 'لیست بسته‌بندی خالی است؛ ابتدا ریز بار را ثبت کنید');
            $dispatcher = $t['dispatched_by'] ? $app->db()->one('SELECT name, short_name FROM users WHERE id = ?', [$t['dispatched_by']]) : null;
            $html = PdfTemplates::packingListHtml([
                'number' => $t['number'], 'date' => $t['departed_at'] ?? $t['created_at'], 'from' => $from['name'] ?? null, 'to' => $to['party_name'] ?? $to['name'] ?? null,
                'responsible' => $dispatcher['short_name'] ?? $dispatcher['name'] ?? null, 'driver' => $t['driver_name'], 'plate' => $t['plate'], 'seller' => $seller,
                'lines' => array_map(static fn (array $p) => [
                    'product' => $p['name_fa'] ?? $p['description'] ?? '—', 'product_ar' => $p['name_ar'], 'product_en' => $p['name_en'], 'filler_mm' => $p['filler_mm'], 'color' => $p['color'],
                    'length_m' => $p['length_m'], 'packages' => $p['packages'], 'bars_per_package' => $p['bars_per_package'], 'bars' => $p['bars'], 'weight_kg' => $p['weight_kg'],
                    'gross_kg' => $p['gross_kg'], 'weight_mode' => $p['weight_mode'], 'is_partial' => $p['is_partial'],
                ], $packing),
                'meta' => self::meta($app, $me, (int) $t['version'], (int) $t['print_count'] + 1, $t['status'] === 'draft'), 'incomplete_date' => !$t['departed_at'],
            ], $fontCss);
            return self::send($app, $html, $q['format'], "packing-{$t['number']}", static fn (?string $pdf) => self::archive($app, 'transfers', $id, $pdf, "packing-{$t['number']}.pdf", $me));
        });

        $r->get('/transfers/:id/commercial-invoice', static function (Request $req) use ($app, $transferContext) {
            $me = $req->requirePermission('finance.view');
            ['id' => $id] = V::idParam()->parse($req->params);
            $q = self::fmt()->parse($req->query);
            ['t' => $t, 'to' => $to, 'packing' => $packing, 'seller' => $seller, 'fontCss' => $fontCss] = $transferContext($id);
            $db = $app->db();
            $billTo = $t['bill_to_party_id'] ? $db->one('SELECT name, name_ar, address FROM parties WHERE id = ?', [$t['bill_to_party_id']]) : null;
            $buyer = $billTo ?? ['name' => $to['party_name'] ?? $to['name'] ?? '—', 'name_ar' => $to['party_name_ar'] ?? null, 'address' => $to['address'] ?? null];
            // Prices come from the orders on this transfer (per product + line); fall back to unpriced rows.
            $orderIds = is_array($t['order_ids']) ? array_values($t['order_ids']) : [];
            $priced = $orderIds ? $db->all('SELECT id, product_id, unit_price, currency, price_basis FROM order_lines WHERE order_id IN (' . Db::placeholders($orderIds) . ')', $orderIds) : [];
            $cur = (string) ($priced[0]['currency'] ?? 'USD');
            $total = Decimal::zero();
            $lines = [];
            foreach ($packing as $p) {
                $ol = null;
                foreach ($priced as $x) if ($x['id'] === $p['order_line_id']) { $ol = $x; break; }
                if ($ol === null) foreach ($priced as $x) if ($x['product_id'] === $p['product_id'] && $x['price_basis'] === 'per_kg') { $ol = $x; break; }
                $amount = $ol && PdfTemplates::js($ol['unit_price']) && PdfTemplates::js($p['weight_kg']) ? Num::round(Decimal::of((string) $ol['unit_price'])->mul((string) $p['weight_kg']), $cur) : null;
                if ($amount !== null) $total = $total->add($amount);
                $lines[] = ['description' => $p['name_en'] ?? $p['name_fa'] ?? $p['description'] ?? '—', 'description_ar' => $p['name_ar'], 'net_kg' => $p['weight_kg'], 'gross_kg' => $p['gross_kg'], 'packages' => $p['packages'], 'unit_price' => $ol['unit_price'] ?? null, 'amount' => $amount];
            }
            $html = PdfTemplates::commercialInvoiceHtml([
                'number' => $t['number'], 'date' => $t['departed_at'] ?? $t['created_at'], 'seller' => $seller, 'buyer' => $buyer, 'consignee' => $t['consignee'],
                'delivery_term' => $t['delivery_term'], 'border' => $t['border'], 'currency' => $cur, 'lines' => $lines, 'total' => Num::round($total, $cur),
                'meta' => self::meta($app, $me, (int) $t['version'], (int) $t['print_count'] + 1, $t['status'] === 'draft'),
            ], $fontCss);
            return self::send($app, $html, $q['format'], "commercial-invoice-{$t['number']}", static fn (?string $pdf) => self::archive($app, 'transfers', $id, $pdf, "commercial-invoice-{$t['number']}.pdf", $me));
        });

        // ── Party statement ──────────────────────────────────────────────────────────
        $r->get('/parties/:id/statement.pdf', static function (Request $req) use ($app) {
            $me = $req->requirePermission('finance.view');
            ['id' => $id] = V::idParam()->parse($req->params);
            $q = self::fmt()->extend(['from' => V::dateOnly()->optional(), 'to' => V::dateOnly()->optional()])->parse($req->query);
            $db = $app->db();
            $party = $db->one('SELECT name, name_ar, phones, address, roles FROM parties WHERE id = ?', [$id]) ?? throw new AppError('not_found');
            $to = isset($q['to']) ? gmdate('Y-m-d', (int) strtotime($q['to'] . 'T00:00:00Z') + 86400) : null;
            $st = Money::partyStatement($db, $id, $q['from'] ?? null, $to);
            $roles = is_array($party['roles']) ? $party['roles'] : [];
            $html = PdfTemplates::statementHtml([
                'party' => ['name' => $party['name'], 'name_ar' => $party['name_ar'], 'phone' => self::firstPhone($party['phones']), 'address' => $party['address']],
                'seller' => self::sellerInfo($app), 'from' => $q['from'] ?? null, 'to' => $q['to'] ?? null,
                'opening' => (array) $st['opening'], 'rows' => $st['rows'], 'closing' => (array) $st['closing'],
                'meta' => self::meta($app, $me, 1, 1, false), 'workshop' => in_array('factory', $roles, true) || in_array('painter', $roles, true),
            ], $q['lang'], PdfRender::loadFontCss($app->config));
            return self::send($app, $html, $q['format'], "statement-{$party['name']}");
        });

        // ── Daily report (module 10 «کل گزارش روز به PDF», §14 / §15) ────────────────
        $r->get('/reports/daily.pdf', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $q = V::object([
                'date' => V::string()->max(12)->optional(),
                'format' => V::enum(['pdf', 'html'])->default('pdf'),
                'full' => V::enum(['0', '1'])->default('0'),
            ])->parse($req->query);
            try {
                $date = self::jalaliDateArg(isset($q['date']) && $q['date'] !== '' ? Num::toLatinDigits($q['date']) : null);
            } catch (\Throwable) {
                throw new AppError('validation', 'تاریخ شمسی نامعتبر است', ['date' => 'نامعتبر']);
            }
            $finance = $req->can('finance.view');
            $report = DailyReport::buildDailyReport($app->db(), $date, ['finance' => $finance, 'userId' => $me->id]);
            $day = new \DateTimeImmutable(Jalali::dayRange($date)['start']);
            $html = PdfTemplates::dailyReportHtml([
                'report' => $report, 'finance' => $finance, 'full' => $q['full'] === '1', 'seller' => self::sellerInfo($app),
                'day' => $day->modify('+12 hours'), 'meta' => self::meta($app, $me, 1, 1, false),
            ], PdfRender::loadFontCss($app->config));
            return self::send($app, $html, $q['format'], 'daily-' . str_replace('/', '-', (string) $report['date']));
        });

        // ── Bundle label (A6) ────────────────────────────────────────────────────────
        $r->get('/bundles/:id/label', static function (Request $req) use ($app) {
            $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $q = self::fmt()->parse($req->query);
            $db = $app->db();
            $b = $db->find('bundles', $id) ?? throw new AppError('not_found');
            $lines = $db->all(
                'SELECT products.name_fa, bundle_lines.filler_mm, bundle_lines.length_m, bundle_lines.bars FROM bundle_lines
                   INNER JOIN products ON products.id = bundle_lines.product_id WHERE bundle_id = ? ORDER BY bundle_lines.sort',
                [$id],
            );
            $bars = 0;
            $totalM = Decimal::zero();
            $names = [];
            foreach ($lines as $l) {
                $bars += (int) ($l['bars'] ?? 0);
                if (PdfTemplates::js($l['bars']) && PdfTemplates::js($l['length_m'])) $totalM = $totalM->add(Decimal::of((int) $l['bars'])->mul((string) $l['length_m']));
                $names[(string) $l['name_fa']] = true;
            }
            $gpm = $totalM->gt(0) ? Num::round(Decimal::of((string) $b['weight_kg'])->mul(1000)->div($totalM), 'g_per_m') : null;
            $publicUrl = $app->config->get('PUBLIC_URL');
            $product = implode(' / ', array_keys($names));
            $html = PdfTemplates::bundleLabelHtml([
                'code' => $b['code'], 'product' => $product !== '' ? $product : '—', 'filler_mm' => $lines[0]['filler_mm'] ?? null, 'length_m' => $lines[0]['length_m'] ?? null,
                'bars' => $bars ?: null, 'weight_kg' => $b['weight_kg'], 'g_per_m' => $gpm, 'reported_at' => $b['reported_at'],
                'url' => $publicUrl ? rtrim((string) $publicUrl, '/') . "/bundles/{$b['id']}" : null,
            ], PdfRender::loadFontCss($app->config));
            return self::send($app, $html, $q['format'], "label-{$b['code']}");
        });
    }
}
