<?php
declare(strict_types=1);

namespace Vitral\Lib;

use Vitral\Core\Db;
use Vitral\Rules\Money;

/**
 * Port of apps/server/src/modules/reports/costing.ts (module 9): every cost component with its basis, reference and
 * status; estimated / realised / collected profit; R15 split; R21 price. All arithmetic in Decimal.
 */
final class Costing
{
    private static function sum(array $xs): Decimal
    {
        $a = Decimal::zero();
        foreach ($xs as $x) $a = $a->add($x ?? 0);
        return $a;
    }

    /** JS truthiness of a value from the database (strings are truthy unless empty). */
    private static function t(mixed $v): bool
    {
        return $v !== null && $v !== '' && $v !== false && $v !== 0;
    }

    /** @return array<string,mixed> the OrderCosting object */
    public static function orderCosting(Db $db, string $orderId, string $markupPercent = '10', ?string $manualPricePerKg = null): array
    {
        $order = $db->find('orders', $orderId);
        if (!$order) throw new \RuntimeException('no result');
        $cur = (string) $order['currency'];
        $lines = OrdersService::loadLines($db, $orderId);
        $lineIds = array_column($lines, 'id');
        $components = [];
        $C = static function (array $c) use (&$components, $cur): void {
            $row = ['currency' => $c['currency'] ?? $cur];
            foreach ($c as $k => $v) {
                if ($k === 'currency') continue;
                if ($k === 'note' && $v === null) continue;
                $row[$k] = $v;
            }
            $components[] = $row;
        };

        // Bundles of this order (produced for its lines or reserved to them), with their run.
        $bundles = $lineIds ? $db->all(
            'SELECT bundles.id, bundles.weight_kg, bundles.raw_weight_kg, bundles.form, bundles.status, bundles.production_run_id, bundles.location_id FROM bundles
              WHERE (bundles.reserved_order_line_id IN (' . Db::placeholders($lineIds) . ')
                     OR EXISTS (SELECT 1 FROM bundle_lines bl WHERE bl.bundle_id = bundles.id AND bl.order_line_id IN (' . Db::placeholders($lineIds) . ')))
                AND bundles.draft = 0',
            array_merge($lineIds, $lineIds),
        ) : [];
        $bundleIds = array_column($bundles, 'id');
        $rawOf = static fn (array $b) => $b['form'] === 'raw' ? $b['weight_kg'] : ($b['raw_weight_kg'] ?? $b['weight_kg']);
        $rawKg = self::sum(array_map($rawOf, $bundles));
        $coatedBundles = array_values(array_filter($bundles, static fn ($b) => $b['form'] !== 'raw'));
        $coatedKg = $coatedBundles ? self::sum(array_column($coatedBundles, 'weight_kg')) : null;

        // Dispatched to the customer (delivered transfers).
        $dispatched = $bundleIds ? $db->all(
            "SELECT transfer_lines.bundle_id, transfer_lines.received_kg, transfer_lines.kg FROM transfer_lines INNER JOIN transfers ON transfers.id = transfer_lines.transfer_id
              WHERE transfers.kind = 'to_customer' AND transfers.status IN ('delivered', 'received', 'in_transit', 'partially_received')
                AND transfer_lines.bundle_id IN (" . Db::placeholders($bundleIds) . ')',
            $bundleIds,
        ) : [];
        $dispatchedIds = array_flip(array_filter(array_column($dispatched, 'bundle_id'), static fn ($x) => $x !== null));
        $dispatchedRaw = self::sum(array_map($rawOf, array_values(array_filter($bundles, static fn ($b) => isset($dispatchedIds[$b['id']])))));
        $dispatchedFinal = self::sum(array_map(static fn ($d) => $d['received_kg'] ?? $d['kg'], $dispatched));
        $soldGain = $dispatchedFinal->sub($dispatchedRaw);

        // 1. Ingot & 2. production fee & scrap credit — per run, pro-rated by this order's good kg in the run.
        $runIds = [];
        foreach ($bundles as $b) if ($b['production_run_id']) $runIds[$b['production_run_id']] = true;
        foreach (array_keys($runIds) as $runId) {
            $runId = (string) $runId;
            $run = $db->find('production_runs', $runId);
            if (!$run) throw new \RuntimeException('no result');
            $runGood = Decimal::of($run['good_kg'])->isZero()
                ? self::sum($db->column('SELECT weight_kg FROM bundles WHERE production_run_id = ? AND draft = 0', [$runId]))
                : Decimal::of($run['good_kg']);
            $ourKg = self::sum(array_map($rawOf, array_values(array_filter($bundles, static fn ($b) => $b['production_run_id'] === $runId))));
            $share = $runGood->isZero() ? Decimal::zero() : $ourKg->div($runGood);
            $consumed = $db->one("SELECT COALESCE(SUM(kg), 0) AS kg, SUM(kg * unit_cost) AS value, MAX(unit_cost IS NULL) AS unknown FROM stock_moves WHERE ref_type = 'production_consume' AND ref_id = ?", [$runId]);
            $unknown = self::t($consumed['unknown']);
            $consumedKg = Decimal::of($consumed['kg'])->mul($share);
            $ingotKnown = !$unknown && $consumed['value'] !== null && $run['status'] === 'closed';
            $C([
                'key' => "ingot:{$runId}", 'label' => 'شمش مصرفی',
                'amount' => $ingotKnown ? Num::round(Decimal::of($consumed['value'])->mul($share), $cur) : null,
                'basis_kg' => Num::round($consumedKg, 'weight'),
                'rate' => $ingotKnown && !$consumedKg->isZero() ? Num::round(Decimal::of($consumed['value'])->div($consumed['kg']), $cur) : null,
                'ref_type' => 'production_runs', 'ref_id' => $runId, 'ref_number' => $run['number'],
                'status' => $run['status'] !== 'closed' ? 'estimated' : ($ingotKnown ? 'final' : 'unknown'),
                'note' => $unknown ? 'شمش بدون قیمت خرید' : null,
            ]);
            $fee = $run['fee_document_id'] ? $db->one('SELECT amount, status, currency, number FROM documents WHERE id = ?', [$run['fee_document_id']]) : null;
            $feeAmount = $fee['amount'] ?? null;
            $C([
                'key' => "toll:{$runId}", 'label' => 'اجرت تولید',
                'amount' => self::t($feeAmount) ? Num::round(Decimal::of($feeAmount)->mul($share), $cur) : null,
                'currency' => $fee['currency'] ?? $cur,
                'basis_kg' => Num::round($ourKg, 'weight'), 'rate' => $run['rate_per_kg'], 'ref_type' => 'documents', 'ref_id' => $run['fee_document_id'],
                'ref_number' => $fee['number'] ?? $run['number'],
                'status' => self::t($feeAmount) && $fee['status'] === 'posted' ? 'final' : (self::t($run['rate_per_kg']) ? 'estimated' : 'unknown'),
                'note' => self::t($run['rate_per_kg']) ? null : 'نرخ اجرت قرارداد ثبت نشده (D1)',
            ]);
            if ($run['scrap_owner'] === 'vitral' && self::t($run['scrap_credit_rate']) && Decimal::of($run['scrap_kg'])->gt(0)) {
                $C([
                    'key' => "scrap:{$runId}", 'label' => 'اعتبار ضایعات برگشتی',
                    'amount' => Num::round(Decimal::of($run['scrap_kg'])->mul($run['scrap_credit_rate'])->mul($share)->neg(), $cur),
                    'basis_kg' => Num::round(Decimal::of($run['scrap_kg'])->mul($share), 'weight'), 'rate' => $run['scrap_credit_rate'],
                    'ref_type' => 'production_runs', 'ref_id' => $runId, 'ref_number' => $run['number'], 'status' => 'final',
                ]);
            }
        }

        // 3. Coating fee & paint material — per coating run, pro-rated by raw kg of our bundles in it.
        $coatingRuns = [];
        if ($bundleIds) {
            $ph = Db::placeholders($bundleIds);
            $coatingRuns = $db->all(
                "SELECT coating_runs.id, coating_runs.number, coating_runs.rate_per_kg, coating_runs.rate_currency, coating_runs.input_basis_kg, coating_runs.fee_document_id,
                        coating_runs.status, coating_runs.includes_material, coating_runs.service,
                        SUM(CASE WHEN coating_run_items.bundle_id IN ({$ph}) THEN coating_run_items.raw_kg ELSE 0 END) AS our_raw, SUM(coating_run_items.raw_kg) AS all_raw
                   FROM coating_run_items INNER JOIN coating_runs ON coating_runs.id = coating_run_items.run_id
                  GROUP BY coating_runs.id
                 HAVING SUM(CASE WHEN coating_run_items.bundle_id IN ({$ph}) THEN 1 ELSE 0 END) > 0",
                array_merge($bundleIds, $bundleIds),
            );
        }
        foreach ($coatingRuns as $cr) {
            $share = Decimal::of($cr['all_raw'])->isZero() ? Decimal::zero() : Decimal::of($cr['our_raw'])->div($cr['all_raw']);
            $fee = $cr['fee_document_id'] ? $db->one('SELECT amount, status, number FROM documents WHERE id = ?', [$cr['fee_document_id']]) : null;
            $feeAmount = $fee['amount'] ?? null;
            $est = self::t($cr['rate_per_kg']) && self::t($cr['input_basis_kg']) ? Decimal::of($cr['input_basis_kg'])->mul($cr['rate_per_kg']) : null;
            $C([
                'key' => "coating:{$cr['id']}", 'label' => $cr['service'] === 'paint' ? 'اجرت رنگ' : 'اجرت آنادایز',
                'amount' => self::t($feeAmount) ? Num::round(Decimal::of($feeAmount)->mul($share), $cur) : ($est ? Num::round($est->mul($share), $cur) : null),
                'currency' => $cr['rate_currency'],
                'basis_kg' => Num::round($cr['our_raw'], 'weight'), 'rate' => $cr['rate_per_kg'],
                'ref_type' => $cr['fee_document_id'] ? 'documents' : 'coating_runs', 'ref_id' => $cr['fee_document_id'] ?? $cr['id'], 'ref_number' => $fee['number'] ?? $cr['number'],
                'status' => self::t($feeAmount) && $fee['status'] === 'posted' ? 'final' : ($est ? 'estimated' : 'unknown'),
                'note' => self::t($cr['rate_per_kg']) ? null : 'نرخ رنگ ثبت نشده',
            ]);
            if ($cr['includes_material'] === false) {
                $mat = $db->one("SELECT COALESCE(SUM(kg), 0) AS kg, SUM(kg * unit_cost) AS value, MAX(unit_cost IS NULL) AS unknown FROM stock_moves WHERE ref_type = 'material_consume' AND ref_id = ?", [$cr['id']]);
                $ok = self::t($mat['value']) && !self::t($mat['unknown']);
                $C([
                    'key' => "paint:{$cr['id']}", 'label' => 'ماده رنگ', 'amount' => $ok ? Num::round(Decimal::of($mat['value'])->mul($share), $cur) : null,
                    'basis_kg' => Num::round(Decimal::of($mat['kg'])->mul($share), 'weight'), 'rate' => null, 'ref_type' => 'coating_runs', 'ref_id' => $cr['id'], 'ref_number' => $cr['number'],
                    'status' => $ok ? 'final' : 'unknown', 'note' => Decimal::of($mat['kg'])->isZero() ? 'مصرف رنگ ثبت نشده' : null,
                ]);
            } elseif ($cr['includes_material'] === null) {
                $C(['key' => "paint:{$cr['id']}", 'label' => 'ماده رنگ', 'amount' => null, 'basis_kg' => null, 'rate' => null, 'ref_type' => 'coating_runs', 'ref_id' => $cr['id'], 'ref_number' => $cr['number'], 'status' => 'unknown', 'note' => 'شمول ماده رنگ در اجرت نامشخص (D2)']);
            }
        }

        // 4. Dies made for this order's lines.
        $dieOrders = $lineIds ? $db->all('SELECT * FROM die_orders WHERE order_line_id IN (' . Db::placeholders($lineIds) . ')', $lineIds) : [];
        foreach ($dieOrders as $d) {
            $C(['key' => "die:{$d['id']}", 'label' => 'ساخت قالب', 'amount' => $d['maker_cost'], 'currency' => $d['currency'], 'basis_kg' => null, 'rate' => null, 'ref_type' => 'die_orders', 'ref_id' => $d['id'], 'ref_number' => $d['number'], 'status' => self::t($d['maker_cost']) ? ($d['purchase_document_id'] ? 'final' : 'estimated') : 'unknown']);
        }

        // 5. Freight / packaging / shared expenses and 6. purchases for this order (expense shares, R16).
        $shares = $db->all(
            "SELECT expense_shares.amount, expense_shares.currency, documents.id AS doc_id, documents.number, documents.status, documents.expense_category, documents.expense_type, expense_shares.weight_kg
               FROM expense_shares INNER JOIN documents ON documents.id = expense_shares.document_id
              WHERE expense_shares.order_id = ? AND documents.status <> 'void'",
            [$orderId],
        );
        foreach ($shares as $s) {
            $C(['key' => "expense:{$s['doc_id']}", 'label' => $s['expense_category'] === 'freight' ? 'حمل' : ($s['expense_type'] === 'shared' ? 'هزینه مشترک' : 'هزینه سفارش'), 'amount' => $s['amount'], 'currency' => $s['currency'], 'basis_kg' => $s['weight_kg'], 'rate' => null, 'ref_type' => 'documents', 'ref_id' => $s['doc_id'], 'ref_number' => $s['number'], 'status' => $s['status'] === 'posted' ? 'final' : 'estimated']);
        }
        $purchases = $db->all("SELECT id, number, amount, currency, status, agreed_kg, unit_price, purchase_kind FROM documents WHERE order_id = ? AND kind = 'purchase' AND status <> 'void'", [$orderId]);
        foreach ($purchases as $p) {
            $C(['key' => "purchase:{$p['id']}", 'label' => $p['purchase_kind'] === 'finished_profile' ? 'خرید محصول آماده' : ($p['purchase_kind'] === 'raw_profile' ? 'خرید پروفیل خام' : 'خرید'), 'amount' => $p['amount'], 'currency' => $p['currency'], 'basis_kg' => $p['agreed_kg'], 'rate' => $p['unit_price'], 'ref_type' => 'documents', 'ref_id' => $p['id'], 'ref_number' => $p['number'], 'status' => $p['amount'] === null ? 'unknown' : ($p['status'] === 'posted' ? 'final' : 'estimated')]);
        }

        // Totals in the order currency only; foreign-currency components are flagged and excluded (no silent mixing).
        $mixedCount = 0;
        foreach ($components as &$c) {
            if ($c['currency'] !== $cur && $c['amount'] !== null) {
                $c['note'] = (isset($c['note']) && $c['note'] !== '' ? $c['note'] . '؛ ' : '') . 'ارز متفاوت؛ در جمع نیامده';
                $mixedCount++;
            }
        }
        unset($c);
        $inCur = array_values(array_filter($components, static fn ($c) => $c['currency'] === $cur));
        $incompleteKeys = array_values(array_map(static fn ($c) => $c['key'], array_filter($components, static fn ($c) => $c['amount'] === null)));
        $costIncomplete = count($incompleteKeys) > 0 || $mixedCount > 0;
        $anyAmount = false;
        foreach ($inCur as $c) if ($c['amount'] !== null) $anyAmount = true;
        $totalCost = $anyAmount ? Num::round(self::sum(array_column($inCur, 'amount')), $cur) : null;

        // Sales: posted invoices (final) else proforma total (estimated).
        $paid = OrdersService::postedReceiptsForOrder($db, $orderId);
        $totals = OrdersService::orderTotals($order, $lines, $paid);
        $proforma = $totals['totals'][$cur] ?? '0';
        $inv = $db->value(
            "SELECT COALESCE(SUM(CASE WHEN kind = 'invoice' THEN amount ELSE -amount END), 0) FROM documents
              WHERE order_id = ? AND kind IN ('invoice', 'sales_return') AND status = 'posted' AND currency = ?",
            [$orderId, $cur],
        );
        $invoiced = Num::round((string) $inv, $cur);
        $salesFinal = !Decimal::of($invoiced)->isZero();
        $salesAmount = $salesFinal ? $invoiced : $proforma;

        $estimated = $totalCost === null ? null : ['sales' => Num::round($proforma, $cur), 'cost' => $totalCost, 'profit' => Num::round(Decimal::of($proforma)->sub($totalCost), $cur)];
        $realised = $salesFinal && !$costIncomplete && $totalCost !== null ? Money::realisedProfit($invoiced, $totalCost, $dispatchedRaw, $rawKg, $cur) : null;
        $payments = $db->value(
            "SELECT COALESCE(SUM(allocations.amount), 0) FROM allocations
               INNER JOIN documents p ON p.id = allocations.from_document_id INNER JOIN documents t ON t.id = allocations.to_document_id
              WHERE p.kind = 'payment' AND p.status = 'posted' AND p.currency = ?
                AND (t.order_id = ? OR EXISTS (SELECT 1 FROM expense_shares es WHERE es.document_id = t.id AND es.order_id = ?))",
            [$cur, $orderId, $orderId],
        );
        $received = $paid[$cur] ?? '0';
        $collected = ['received' => Num::round($received, $cur), 'paid' => Num::round((string) $payments, $cur), 'net' => Num::round(Decimal::of($received)->sub((string) $payments), $cur)];

        $effectivePrice = $dispatchedFinal->isZero()
            ? ($rawKg->isZero() ? null : Num::round(Decimal::of($salesAmount)->div($coatedKg ?? $rawKg), $cur))
            : Num::round(Decimal::of($salesAmount)->div($dispatchedFinal), $cur);
        $profitForSplit = $realised['profit'] ?? $estimated['profit'] ?? null;
        $gainForSplit = $dispatchedFinal->isZero() ? ($coatedKg ? $coatedKg->sub($rawKg) : Decimal::zero()) : $soldGain;
        $split = $profitForSplit !== null && $effectivePrice !== null ? Money::profitSplit($profitForSplit, $gainForSplit, $manualPricePerKg ?? $effectivePrice, $cur) : null;
        $basePerKg = $totalCost === null || $rawKg->isZero() ? null : Num::round(Decimal::of($totalCost)->div($rawKg), $cur);

        return [
            'order_id' => $orderId, 'currency' => $cur, 'components' => $components, 'total_cost' => $totalCost, 'cost_incomplete' => $costIncomplete, 'incomplete_keys' => $incompleteKeys,
            'raw_kg' => Num::round($rawKg, 'weight'), 'coated_kg' => $coatedKg ? Num::round($coatedKg, 'weight') : null, 'dispatched_raw_kg' => Num::round($dispatchedRaw, 'weight'),
            'dispatched_final_kg' => Num::round($dispatchedFinal, 'weight'), 'sold_gain_kg' => Num::round($soldGain, 'weight'),
            'sales' => ['proforma' => Num::round($proforma, $cur), 'invoiced' => $invoiced, 'status' => $salesFinal ? 'final' : 'estimated'],
            'profit' => ['estimated' => $estimated, 'realised' => $realised, 'collected' => $collected, 'split' => $split],
            'pricing' => ['base_per_kg' => $basePerKg, 'suggested_per_kg' => Money::suggestedPricePerKg($totalCost, $rawKg, $markupPercent, $cur), 'markup_percent' => $markupPercent, 'effective_price_per_kg' => $manualPricePerKg ?? $effectivePrice],
            'cost_confirmed_at' => $order['cost_confirmed_at'],
        ];
    }
}
