<?php
declare(strict_types=1);

namespace Vitral\Lib;

use Vitral\Core\Db;
use Vitral\Rules\Money;
use Vitral\Rules\Weights;

/**
 * Port of apps/server/src/modules/orders/service.ts. Rows are the associative arrays Db returns
 * (DECIMAL as strings, booleans as bool). Currency maps are plain arrays (currency => string); an empty map is `[]`,
 * so callers emitting JSON cast it with `(object)` (see Orders::presentOrder) to keep Node's `{}`.
 */
final class OrdersService
{
    public const NEXT_ACTION_LABELS = [
        'issue_proforma' => 'صدور پیش‌فاکتور', 'approve' => 'تأیید سفارش', 'reserve_stock' => 'انتخاب موجودی', 'send_ingot' => 'ارسال شمش', 'record_purchase' => 'ثبت خرید', 'record_bundles' => 'ثبت بندیل',
        'send_to_coating' => 'ارسال به رنگ', 'record_coating_return' => 'ثبت برگشت رنگ', 'decide_quarantine' => 'تصمیم قرنطینه', 'pack_and_ship' => 'بسته‌بندی و ارسال', 'issue_invoice' => 'صدور فاکتور',
    ];

    /** JavaScript truthiness for row values (a DECIMAL string "0.000" is truthy, "" and null are not). */
    private static function truthy(mixed $v): bool
    {
        return !($v === null || $v === false || $v === '' || $v === 0);
    }

    /** Quantity used for pricing, per price basis. */
    public static function lineBasisQty(array $l): ?string
    {
        switch ($l['price_basis'] ?? null) {
            case 'per_kg': return $l['qty_kg'] === null ? null : (string) $l['qty_kg'];
            case 'per_bar': return $l['qty_bars'] === null ? null : (string) $l['qty_bars'];
            case 'per_meter': return self::truthy($l['qty_bars'] ?? null) && self::truthy($l['length_m'] ?? null) ? Decimal::of($l['qty_bars'])->mul($l['length_m'])->toFixed() : null;
            case 'per_piece': return ($l['qty_pieces'] ?? null) === null ? null : (string) $l['qty_pieces'];
        }
        return null;
    }

    /**
     * Apply calc_mode (module 3): from_bars → kg by R02; from_weight → estimated bars; manual → as given.
     * @param array<string,mixed> $l a partial line (missing keys = undefined)
     * @return array{qty_kg:?string,qty_bars:?string,qty_is_estimate:bool}
     */
    public static function computeLineQty(array $l): array
    {
        $gpm = $l['weight_g_per_m'] ?? null;
        if (($l['kind'] ?? null) !== 'profile') return ['qty_kg' => $l['qty_kg'] ?? null, 'qty_bars' => $l['qty_bars'] ?? null, 'qty_is_estimate' => false];
        if (($l['calc_mode'] ?? null) === 'from_bars') {
            $est = Weights::estimatedLineKg($gpm, $l['length_m'] ?? null, $l['qty_bars'] ?? null);
            return ['qty_kg' => $est['kg'] ?? null, 'qty_bars' => $l['qty_bars'] ?? null, 'qty_is_estimate' => true];
        }
        if (($l['calc_mode'] ?? null) === 'from_weight') {
            $est = Weights::estimatedBarsForKg($l['qty_kg'] ?? null, $gpm, $l['length_m'] ?? null);
            return ['qty_kg' => $l['qty_kg'] ?? null, 'qty_bars' => $est['exact'] ?? null, 'qty_is_estimate' => true];
        }
        return ['qty_kg' => $l['qty_kg'] ?? null, 'qty_bars' => $l['qty_bars'] ?? null, 'qty_is_estimate' => self::truthy($l['qty_is_estimate'] ?? null)];
    }

    /** @return array<string,mixed> */
    public static function presentLine(array $l): array
    {
        $amount = Money::lineAmount(self::lineBasisQty($l), $l['unit_price'], $l['currency'], $l['discount_amount'], $l['discount_percent']);
        return [
            'id' => $l['id'], 'order_id' => $l['order_id'], 'sort' => $l['sort'], 'kind' => $l['kind'], 'product_id' => $l['product_id'], 'product_code' => $l['product_code'] ?? null, 'product_name' => $l['product_name'] ?? null, 'product_name_ar' => $l['product_name_ar'] ?? null, 'product_file_id' => $l['product_file_id'] ?? null,
            'product_filler_id' => $l['product_filler_id'], 'filler_mm' => $l['filler_mm'], 'length_m' => $l['length_m'], 'min_length_m' => $l['min_length_m'], 'color' => $l['color'], 'load_type_label' => $l['load_type_label'],
            'weight_g_per_m' => $l['weight_g_per_m'], 'weight_unapproved' => $l['weight_unapproved'], 'calc_mode' => $l['calc_mode'], 'qty_bars' => $l['qty_bars'], 'qty_kg' => $l['qty_kg'], 'qty_is_estimate' => $l['qty_is_estimate'], 'qty_pieces' => $l['qty_pieces'],
            'price_basis' => $l['price_basis'], 'unit_price' => $l['unit_price'], 'currency' => $l['currency'], 'discount_amount' => $l['discount_amount'], 'discount_percent' => $l['discount_percent'], 'amount' => $amount,
            'supply_method' => $l['supply_method'], 'die_id' => $l['die_id'], 'material_kind' => $l['material_kind'], 'coating_gain_estimate_percent' => $l['coating_gain_estimate_percent'],
            'estimated_coated_kg' => self::truthy($l['qty_kg']) && self::truthy($l['coating_gain_estimate_percent'])
                ? Num::round(Decimal::of($l['qty_kg'])->mul(Decimal::of(1)->add(Decimal::of($l['coating_gain_estimate_percent'])->div(100))), 'weight')
                : null,
            'vat_rate' => $l['vat_rate'], 'vat_amount' => $l['vat_amount'], 'name_ar' => $l['name_ar'], 'name_en' => $l['name_en'], 'description' => $l['description'], 'file_id' => $l['file_id'], 'note' => $l['note'], 'version' => $l['version'],
        ];
    }

    /**
     * Receipts allocated to the order directly or to its invoices; posted only.
     * @return array<string,string> currency => amount
     */
    public static function postedReceiptsForOrder(Db $db, string $orderId): array
    {
        $rows = $db->all(
            "SELECT allocations.currency, SUM(allocations.amount) AS amount FROM allocations
             INNER JOIN documents r ON r.id = allocations.from_document_id
             LEFT JOIN documents inv ON inv.id = allocations.to_document_id
             WHERE r.kind = 'receipt' AND r.status = 'posted' AND (allocations.order_id = ? OR inv.order_id = ?)
             GROUP BY allocations.currency",
            [$orderId, $orderId],
        );
        $out = [];
        foreach ($rows as $r) $out[$r['currency']] = Num::round((string) $r['amount'], $r['currency']);
        return $out;
    }

    /**
     * @param array<string,mixed> $order
     * @param list<array<string,mixed>> $lines
     * @param array<string,string> $paid
     * @return array{totals:array<string,string>,incomplete:bool,total_kg:string,prepay:array<string,string>,paid:array<string,string>,remaining:array<string,string>}
     */
    public static function orderTotals(array $order, array $lines, array $paid): array
    {
        $amounts = [];
        foreach ($lines as $l) {
            $amounts[] = ['amount' => Money::lineAmount(self::lineBasisQty($l), $l['unit_price'], $l['currency'], $l['discount_amount'], $l['discount_percent']), 'currency' => $l['currency']];
        }
        $t = Money::totalsByCurrency($amounts);
        $totalKg = Decimal::zero();
        foreach ($lines as $l) if (self::truthy($l['qty_kg'] ?? null)) $totalKg = $totalKg->add($l['qty_kg']);
        $prepay = [];
        $remaining = [];
        foreach ($t['totals'] as $c => $total) {
            $c = (string) $c;
            $p = Money::prepayment($total, $order['prepay_percent'] ?? '0', $paid[$c] ?? '0', $c);
            $prepay[$c] = self::truthy($order['prepay_amount'] ?? null) && $c === $order['currency'] ? Num::round((string) $order['prepay_amount'], $c) : $p['prepay'];
            $remaining[$c] = $p['remaining'];
        }
        return ['totals' => $t['totals'], 'incomplete' => $t['incomplete'], 'total_kg' => Num::round($totalKg, 'weight'), 'prepay' => $prepay, 'paid' => $paid, 'remaining' => $remaining];
    }

    /** The totals with every currency map as a JSON object (Node prints `{}` for an empty map). */
    public static function totalsJson(array $totals): array
    {
        foreach (['totals', 'prepay', 'paid', 'remaining'] as $k) {
            if (isset($totals[$k]) && is_array($totals[$k])) $totals[$k] = (object) $totals[$k];
        }
        return $totals;
    }

    /**
     * The four computed axes (module 3). Everything derives from real records; nothing is stored.
     * @param list<array<string,mixed>> $lines
     * @return array{supply:string,operations:string,shipping:string,finance:string,next_action:?string}
     */
    public static function computeStatuses(Db $db, array $order, array $lines, array $totals): array
    {
        $lineIds = array_map(static fn ($l) => $l['id'], $lines);
        $physical = array_values(array_filter($lines, static fn ($l) => $l['kind'] === 'profile' || $l['kind'] === 'material'));
        $needKg = Decimal::zero();
        foreach ($physical as $l) if (self::truthy($l['qty_kg'] ?? null)) $needKg = $needKg->add($l['qty_kg']);
        $supply = 'unallocated';
        $operations = 'none';
        $shipping = 'not_shipped';
        if ($lineIds) {
            $in = Db::placeholders($lineIds);
            $alloc = $db->value("SELECT COALESCE(SUM(kg),0) AS kg FROM reservations WHERE order_line_id IN ({$in}) AND status IN ('active','consumed')", $lineIds);
            $produced = $db->value(
                "SELECT COALESCE(SUM(COALESCE(bundle_lines.weight_kg, bundles.weight_kg)),0) AS kg FROM bundle_lines
                 INNER JOIN bundles ON bundles.id = bundle_lines.bundle_id
                 WHERE bundle_lines.order_line_id IN ({$in}) AND bundles.draft = 0",
                $lineIds,
            );
            $allocated = Decimal::of((string) $alloc)->add((string) $produced);
            $supply = $allocated->isZero() ? 'unallocated' : ($allocated->gte($needKg) && !$needKg->isZero() ? 'full' : 'partial');

            $bundles = $db->all(
                "SELECT bundles.id, bundles.status, bundles.form, bundles.draft,
                        MAX(CASE WHEN coating_run_items.id IS NOT NULL AND coating_run_items.returned_at IS NULL THEN 1 ELSE 0 END) AS at_painter
                 FROM bundles LEFT JOIN coating_run_items ON coating_run_items.bundle_id = bundles.id
                 WHERE (bundles.reserved_order_line_id IN ({$in}) OR EXISTS (SELECT 1 FROM bundle_lines bl WHERE bl.bundle_id = bundles.id AND bl.order_line_id IN ({$in})))
                   AND bundles.status <> 'consumed'
                 GROUP BY bundles.id, bundles.status, bundles.form, bundles.draft",
                [...$lineIds, ...$lineIds],
            );
            $openRuns = $db->one(
                "SELECT production_runs.id FROM production_run_lines INNER JOIN production_runs ON production_runs.id = production_run_lines.run_id
                 WHERE production_run_lines.order_line_id IN ({$in}) AND production_runs.status = 'open' LIMIT 1",
                $lineIds,
            );
            $needsColor = false;
            foreach ($physical as $l) if (self::truthy($l['color']) && !preg_match('/خام|raw/iu', (string) $l['color'])) $needsColor = true;
            $any = static function (callable $f) use ($bundles): bool {
                foreach ($bundles as $b) if ($f($b)) return true;
                return false;
            };
            if ($any(static fn ($b) => $b['status'] !== 'ok')) $operations = 'needs_fix';
            elseif ($any(static fn ($b) => (bool) $b['at_painter'])) $operations = 'at_painter';
            elseif ($bundles && !$any(static fn ($b) => !($b['form'] !== 'raw' || !$needsColor))) $operations = 'ready_to_ship';
            elseif ($bundles) $operations = 'raw_ready';
            elseif ($openRuns) $operations = 'in_production';

            $ship = $db->one(
                "SELECT COALESCE(SUM(CASE WHEN transfers.status <> 'draft' THEN transfer_lines.kg ELSE 0 END),0) AS kg,
                        MIN(CASE WHEN transfers.status = 'delivered' THEN 1 ELSE 0 END) AS all_delivered, COUNT(*) AS n
                 FROM transfer_lines INNER JOIN transfers ON transfers.id = transfer_lines.transfer_id
                 WHERE transfers.kind = 'to_customer' AND transfer_lines.order_id = ? AND transfers.status <> 'draft'",
                [$order['id']],
            );
            $shippedKg = Decimal::of((string) $ship['kg']);
            if ((int) $ship['n'] > 0 && !$shippedKg->isZero()) $shipping = $shippedKg->gte($needKg) ? ((bool) $ship['all_delivered'] ? 'delivered' : 'full') : 'partial';
        }

        $finance = 'no_receipt';
        $cur = $order['currency'];
        $paid = Decimal::of($totals['paid'][$cur] ?? '0');
        $total = Decimal::of($totals['totals'][$cur] ?? '0');
        $invoiced = $db->value(
            "SELECT COALESCE(SUM(amount),0) AS a FROM documents WHERE order_id = ? AND kind = 'invoice' AND status = 'posted' AND currency = ?",
            [$order['id'], $cur],
        );
        $inv = Decimal::of((string) $invoiced);
        if (!$paid->isZero()) {
            $basis = $inv->isZero() ? $total : $inv;
            if ($paid->gt($basis) && !$basis->isZero()) $finance = 'credit';
            elseif ($basis->isZero() || $paid->lt($basis)) $finance = $inv->isZero() ? 'prepaid' : 'partial';
            else $finance = 'settled';
        }

        $some = static function (callable $f) use ($physical): bool {
            foreach ($physical as $l) if ($f($l)) return true;
            return false;
        };
        $next = null;
        $s = $order['status_sales'];
        if ($s === 'draft') $next = 'issue_proforma';
        elseif ($s === 'proforma') $next = 'approve';
        elseif ($s === 'approved') {
            if ($shipping === 'delivered' && $finance !== 'settled' && $inv->isZero()) $next = 'issue_invoice';
            elseif ($shipping === 'delivered') $next = null;
            elseif ($operations === 'ready_to_ship') $next = 'pack_and_ship';
            elseif ($operations === 'at_painter') $next = 'record_coating_return';
            elseif ($operations === 'raw_ready') $next = $some(static fn ($l) => self::truthy($l['color'])) ? 'send_to_coating' : 'pack_and_ship';
            elseif ($operations === 'needs_fix') $next = 'decide_quarantine';
            elseif ($operations === 'in_production') $next = 'record_bundles';
            elseif ($supply === 'unallocated') {
                $next = $some(static fn ($l) => $l['supply_method'] === 'stock') ? 'reserve_stock'
                    : ($some(static fn ($l) => $l['supply_method'] === 'buy_finished' || $l['supply_method'] === 'buy_raw_then_paint') ? 'record_purchase' : 'send_ingot');
            } else $next = 'record_bundles';
        }
        return ['supply' => $supply, 'operations' => $operations, 'shipping' => $shipping, 'finance' => $finance, 'next_action' => $next];
    }

    /** @return list<array<string,mixed>> order_lines.* plus product_code / product_name / product_name_ar / product_file_id */
    public static function loadLines(Db $db, string $orderId): array
    {
        return $db->all(
            'SELECT order_lines.*, products.code AS product_code, products.name_fa AS product_name, products.name_ar AS product_name_ar, products.main_file_id AS product_file_id
             FROM order_lines LEFT JOIN products ON products.id = order_lines.product_id
             WHERE order_lines.order_id = ? ORDER BY order_lines.sort, order_lines.created_at',
            [$orderId],
        );
    }

    /** @return array{order:array<string,mixed>,lines:list<array<string,mixed>>} */
    public static function snapshotOrder(array $order, array $lines): array
    {
        return ['order' => $order, 'lines' => array_values($lines)];
    }
}
