<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\Auth;
use Vitral\Core\AuthUser;
use Vitral\Core\Crud;
use Vitral\Core\Db;
use Vitral\Core\Idempotency;
use Vitral\Core\Notify;
use Vitral\Core\Numbering;
use Vitral\Core\Query;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\Schema;
use Vitral\Core\Settings;
use Vitral\Core\V;
use Vitral\Lib\BundlesService;
use Vitral\Lib\Decimal;
use Vitral\Lib\Num;
use Vitral\Lib\Stock;
use Vitral\Rules\Money;
use Vitral\Rules\Production as Rules;

/** Port of apps/server/src/modules/production/routes.ts (production runs, close, scorecard). */
final class Production
{
    private const PRESENT_KEYS = [
        'id', 'number', 'factory_party_id', 'factory_name', 'location_id', 'service', 'started_at', 'due_at', 'contract_id',
        'rate_per_kg', 'rate_currency', 'weight_basis', 'fixed_fee', 'scrap_owner', 'status',
        'ingot_allocated_kg', 'ingot_consumed_kg', 'good_kg', 'rejected_kg', 'scrap_kg', 'returned_material_kg',
        'unexplained_kg', 'close_reason', 'closed_by', 'closed_at', 'press', 'shift', 'heat_treatment', 'note',
        'fee_document_id', 'shortage_document_id', 'fee_incomplete', 'lines', 'bundle_summary', 'balance', 'version', 'created_at',
    ];

    /** Keys the row does not have (undefined in Node) are left out, as JSON.stringify does. */
    public static function presentRun(array $p, ?AuthUser $user = null): array
    {
        $p['fee_incomplete'] = ($p['rate_per_kg'] ?? null) === null || ($p['weight_basis'] ?? null) === null;
        $out = [];
        foreach (self::PRESENT_KEYS as $k) if (array_key_exists($k, $p)) $out[$k] = $p[$k];
        if ($user && !Auth::can($user, 'finance.view')) unset($out['fee_document_id'], $out['shortage_document_id']);
        return $out;
    }

    private static function lineSchema(): Schema
    {
        return V::object([
            'order_line_id' => V::uuid()->nullable()->optional(), 'product_id' => V::uuid(), 'die_id' => V::uuid()->nullable()->optional(),
            'filler_mm' => V::decimalString()->nullable()->optional(), 'length_m' => V::decimalString()->nullable()->optional(),
            'target_kg' => V::decimalString()->nullable()->optional(), 'target_bars' => V::int()->min(0)->nullable()->optional(),
        ]);
    }

    /** @return array<string,Schema> */
    private static function base(bool $create): array
    {
        return [
            'factory_party_id' => $create ? V::uuid() : V::uuid()->optional(),
            'service' => $create ? V::enum(['extrusion', 'smelting'])->default('extrusion') : V::enum(['extrusion', 'smelting'])->optional(),
            'started_at' => V::isoDate()->optional(),
            'due_at' => V::isoDate()->nullable()->optional(),
            'ingot_allocated_kg' => V::decimalString()->optional(),
            'press' => V::optText(80), 'shift' => V::optText(40), 'heat_treatment' => V::optText(80), 'note' => V::optText(2000),
        ];
    }

    /** @return array<string,mixed>|null */
    public static function loadRun(Db $db, string $id): ?array
    {
        $r = $db->one('SELECT production_runs.*, parties.name AS factory_name FROM production_runs LEFT JOIN parties ON parties.id = production_runs.factory_party_id WHERE production_runs.id = ?', [$id]);
        if (!$r) return null;
        $lines = $db->all(
            'SELECT production_run_lines.*, products.code AS product_code, products.name_fa AS product_name, orders.number AS order_number, order_lines.min_length_m, order_lines.color AS order_color
             FROM production_run_lines LEFT JOIN products ON products.id = production_run_lines.product_id LEFT JOIN order_lines ON order_lines.id = production_run_lines.order_line_id
             LEFT JOIN orders ON orders.id = order_lines.order_id WHERE run_id = ? ORDER BY production_run_lines.created_at',
            [$id],
        );
        $summary = BundlesService::bundleTotalsForRun($db, $id);
        $threshold = Settings::get($db, 'production_balance_threshold_percent') ?? '1';
        $balance = Rules::runBalance($r['ingot_consumed_kg'], $summary['good_kg'], $summary['rejected_kg'], $r['scrap_kg'], $r['returned_material_kg'], $threshold);
        return $r + ['lines' => $lines, 'bundle_summary' => $summary, 'balance' => $balance];
    }

    public static function register(Router $r, App $app): void
    {
        $line = self::lineSchema();
        Crud::routes($r, $app, [
            'table' => 'production_runs', 'path' => '/production-runs',
            'createSchema' => V::object(self::base(true) + ['lines' => V::array($line)->max(100)->default([])]),
            'updateSchema' => V::object(V::versionField() + self::base(false) + ['lines' => V::array($line)->max(100)->optional()]),
            'listSchema' => V::object(['q' => V::string()->max(100)->optional(), 'status' => V::enum(['open', 'closed'])->optional(), 'factory_party_id' => V::uuid()->optional(), 'order_id' => V::uuid()->optional()]),
            'present' => static fn (array $row, AuthUser $user) => self::presentRun($row, $user),
            'idempotent' => true,
            'orderBy' => 'started_at',
            'filter' => static function (Query $qb, array $q) {
                if (($q['q'] ?? '') !== '') $qb->where('production_runs.number LIKE ?', [Db::like((string) $q['q'])]);
                if (!empty($q['status'])) $qb->where('production_runs.status = ?', [(string) $q['status']]);
                if (!empty($q['factory_party_id'])) $qb->where('production_runs.factory_party_id = ?', [(string) $q['factory_party_id']]);
                if (!empty($q['order_id'])) $qb->where('EXISTS (SELECT 1 FROM production_run_lines prl JOIN order_lines ol ON ol.id = prl.order_line_id WHERE prl.run_id = production_runs.id AND ol.order_id = ?)', [(string) $q['order_id']]);
            },
            'loadOne' => static fn (Db $trx, string $id) => self::loadRun($trx, $id),
            'beforeCreate' => static function (Db $trx, array $input) {
                $rest = $input;
                unset($rest['lines']);
                $loc = $trx->value("SELECT id FROM locations WHERE party_id = ? AND kind = 'factory' LIMIT 1", [(string) $rest['factory_party_id']]);
                if ($loc === null) throw new AppError('validation', 'این طرف نقش کارخانه (یا ریخته‌گر) ندارد', ['factory_party_id' => 'کارخانه نیست']);
                $c = Contracts::activeContract($trx, (string) $rest['factory_party_id'], $rest['service'] === 'smelting' ? 'smelting' : 'extrusion');
                return array_merge($rest, [
                    'number' => Numbering::next($trx, 'production_run'), 'location_id' => $loc, 'contract_id' => $c['id'] ?? null,
                    'rate_per_kg' => $c['rate_per_kg'] ?? null, 'rate_currency' => $c['currency'] ?? 'TOMAN', 'weight_basis' => $c['weight_basis'] ?? null, 'fixed_fee' => $c['fixed_fee'] ?? null,
                    'scrap_owner' => $c['scrap_owner'] ?? null, 'scrap_credit_rate' => $c['scrap_credit_rate'] ?? null,
                    'started_at' => Schema::jsTruthy($rest['started_at'] ?? null) ? Db::dt($rest['started_at']) : Db::now(),
                    'due_at' => Schema::jsTruthy($rest['due_at'] ?? null) ? Db::dt($rest['due_at']) : null,
                ]);
            },
            'afterCreate' => static function (Db $trx, array $row, array $input, AuthUser $user) {
                foreach ($input['lines'] as $l) $trx->insertNoReturn('production_run_lines', $l + ['run_id' => $row['id'], 'created_by' => $user->id]);
            },
            'beforeUpdate' => static function (Db $trx, array $before, array $patch, AuthUser $user) {
                if ($before['status'] === 'closed') throw new AppError('validation', 'نوبت بسته‌شده ویرایش نمی‌شود');
                $lines = $patch['lines'] ?? null;
                $rest = $patch;
                unset($rest['lines']);
                if ($lines) {
                    if ($trx->value('SELECT id FROM bundles WHERE production_run_id = ? LIMIT 1', [$before['id']]) !== null) {
                        throw new AppError('validation', 'ردیف‌های نوبتی که بندیل دارد تغییر نمی‌کند؛ ردیف جدید اضافه کنید');
                    }
                    $trx->exec('DELETE FROM production_run_lines WHERE run_id = ?', [$before['id']]);
                    foreach ($lines as $l) $trx->insertNoReturn('production_run_lines', $l + ['run_id' => $before['id'], 'created_by' => $user->id]);
                }
                unset($rest['factory_party_id'], $rest['service']);
                if (Schema::jsTruthy($rest['started_at'] ?? null)) $rest['started_at'] = Db::dt($rest['started_at']);
                if (Schema::jsTruthy($rest['due_at'] ?? null)) $rest['due_at'] = Db::dt($rest['due_at']);
                return $rest;
            },
        ]);

        $r->post('/production-runs/:id/lines', static function (Request $req) use ($app, $line) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $body = $line->parse($req->body());
            $db = $app->db();
            $run = $db->one('SELECT status FROM production_runs WHERE id = ?', [$id]);
            if (!$run) throw new AppError('not_found');
            if ($run['status'] === 'closed') throw new AppError('validation', 'نوبت بسته است');
            $row = $db->insert('production_run_lines', $body + ['run_id' => $id, 'created_by' => $me->id]);
            return Response::json($row, 201);
        });

        /** Ingot available to this run: Vitral-owned ingot/billet lots at the factory location, from the ledger. */
        $r->get('/production-runs/:id/ingot', static function (Request $req) use ($app) {
            $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $run = $app->db()->one('SELECT location_id, factory_party_id FROM production_runs WHERE id = ?', [$id]);
            if (!$run) throw new AppError('not_found');
            return ['items' => self::ingotAtLocation($app->db(), $run['location_id'])];
        });

        /** Close (technical.approve): R08 balance, ingot consumption, scrap, die counters, toll_fee document (R07), shortage purchase. */
        $r->post('/production-runs/:id/close', static function (Request $req) use ($app) {
            $me = $req->requirePermission('technical.approve');
            ['id' => $id] = V::idParam()->parse($req->params);
            $key = Idempotency::requireKey($req);
            $body = V::object([
                'version' => V::int(), 'ingot_consumed_kg' => V::decimalString(), 'scrap_kg' => V::decimalString()->default('0'), 'returned_material_kg' => V::decimalString()->default('0'),
                'close_reason' => V::optText(2000), 'rework_cost' => V::decimalString()->nullable()->optional(),
            ])->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /production-runs/close', static fn (Db $trx) => self::close($trx, $id, $body, $me));
            return $res['body'];
        });

        /** Factory scorecard (module 4): yield, reject %, lateness, run count — closed runs only. */
        $r->get('/production-runs/scorecard', static function (Request $req) use ($app) {
            $req->requireUser();
            $rows = $app->db()->all(
                "SELECT production_runs.factory_party_id, parties.name, COUNT(*) AS runs, SUM(ingot_consumed_kg) AS consumed, SUM(good_kg) AS good, SUM(rejected_kg) AS rejected,
                        SUM(CASE WHEN due_at IS NOT NULL AND closed_at > due_at THEN 1 ELSE 0 END) AS late
                 FROM production_runs INNER JOIN parties ON parties.id = production_runs.factory_party_id
                 WHERE production_runs.status = 'closed' GROUP BY production_runs.factory_party_id, parties.name",
            );
            return ['items' => array_map(static function (array $x) {
                $ok = $x['consumed'] !== null && !Decimal::of($x['consumed'])->isZero();
                return [
                    'factory_party_id' => $x['factory_party_id'], 'name' => $x['name'], 'runs' => (int) $x['runs'], 'late' => (int) $x['late'],
                    'yield_percent' => $ok ? Num::round(Decimal::of($x['good'])->div($x['consumed'])->mul(100), 'percent') : null,
                    'reject_percent' => $ok ? Num::round(Decimal::of($x['rejected'])->div($x['consumed'])->mul(100), 'percent') : null,
                ];
            }, $rows)];
        });
    }

    /** @return array{status:int,body:mixed} */
    private static function close(Db $trx, string $id, array $body, AuthUser $me): array
    {
        $run = $trx->find('production_runs', $id, true);
        if (!$run) throw new AppError('not_found');
        if ($run['version'] !== $body['version']) throw AppError::conflict(self::presentRun($run));
        if ($run['status'] === 'closed') throw new AppError('validation', 'نوبت قبلاً بسته شده است');
        if ($trx->value('SELECT id FROM bundles WHERE production_run_id = ? AND draft = 1 LIMIT 1', [$id]) !== null) {
            throw new AppError('validation', 'بندیل پیش‌نویس در این نوبت هست؛ اول قطعی یا حذف کنید');
        }
        $sums = BundlesService::bundleTotalsForRun($trx, $id);
        $threshold = Settings::get($trx, 'production_balance_threshold_percent') ?? '1';
        $bal = Rules::runBalance($body['ingot_consumed_kg'], $sums['good_kg'], $sums['rejected_kg'], $body['scrap_kg'], $body['returned_material_kg'], $threshold);
        $closeReason = $body['close_reason'] ?? null;
        if ($bal['needs_reason'] && !Schema::jsTruthy($closeReason)) {
            throw new AppError('validation', "اختلاف توضیح‌داده‌نشده {$bal['unexplained_kg']} کیلوگرم ({$bal['unexplained_percent']}٪) از آستانه {$threshold}٪ بیشتر است؛ دلیل مکتوب لازم است", ['close_reason' => 'لازم است']);
        }

        // Ingot consumption from Vitral's lots at the factory (oldest first); shortfall becomes a proposed purchase from the factory.
        $remaining = Decimal::of($body['ingot_consumed_kg']);
        $costSum = Decimal::zero();
        $costIncomplete = false;
        foreach (self::ingotAtLocation($trx, $run['location_id']) as $lot) {
            if ($remaining->lte(0)) break;
            $take = Decimal::min($remaining, Decimal::of($lot['kg']));
            if ($take->lte(0)) continue;
            Stock::move($trx, [
                'item_type' => 'material_lot', 'item_id' => $lot['item_id'], 'from_location_id' => $run['location_id'], 'to_location_id' => null, 'kg' => $take->toFixed(3),
                'state_from' => 'ingot', 'state_to' => 'consumed', 'ref_type' => 'production_consume', 'ref_id' => $id, 'unit_cost' => $lot['avg_cost'], 'currency' => 'TOMAN', 'userId' => $me->id,
            ]);
            if ($lot['avg_cost'] === null) $costIncomplete = true;
            else $costSum = $costSum->add($take->mul($lot['avg_cost']));
            $remaining = $remaining->sub($take);
        }
        $shortageDocId = null;
        if ($remaining->gt(0)) {
            $lotId = $trx->insertNoReturn('material_lots', ['kind' => 'ingot', 'owner_party_id' => null, 'description' => "کسری شمش نوبت {$run['number']} (تأمین کارخانه)", 'created_by' => $me->id]);
            $shortageDocId = $trx->insertNoReturn('documents', [
                'number' => Numbering::next($trx, 'purchase'), 'kind' => 'purchase', 'party_id' => $run['factory_party_id'], 'amount' => null, 'currency' => $run['rate_currency'], 'status' => 'needs_completion', 'purchase_kind' => 'ingot',
                'material_lot_id' => $lotId, 'agreed_kg' => $remaining->toFixed(3), 'received_kg' => $remaining->toFixed(3), 'source_type' => 'production_run', 'source_id' => $id,
                'description' => "خرید پیشنهادی شمش برای کسری نوبت {$run['number']}", 'created_by' => $me->id,
            ]);
            Stock::move($trx, ['item_type' => 'material_lot', 'item_id' => $lotId, 'from_location_id' => null, 'to_location_id' => $run['location_id'], 'kg' => $remaining->toFixed(3), 'state_to' => 'ingot', 'ref_type' => 'purchase_receipt', 'ref_id' => $shortageDocId, 'unit_cost' => null, 'userId' => $me->id]);
            Stock::move($trx, ['item_type' => 'material_lot', 'item_id' => $lotId, 'from_location_id' => $run['location_id'], 'to_location_id' => null, 'kg' => $remaining->toFixed(3), 'state_from' => 'ingot', 'state_to' => 'consumed', 'ref_type' => 'production_consume', 'ref_id' => $id, 'unit_cost' => null, 'userId' => $me->id]);
            $costIncomplete = true;
            Notify::managers($trx, ['kind' => 'ingot_shortage', 'title' => 'کسری شمش ' . Num::round($remaining, 'weight') . " کیلو در نوبت {$run['number']}؛ قیمت خرید از کارخانه لازم است", 'entity' => 'documents', 'entityId' => $shortageDocId, 'groupKey' => "shortage:{$id}"]);
        }

        // Scrap goes to the owner per contract (D3: unknown owner → at the factory, owner «نامشخص», no credit).
        if (Decimal::of($body['scrap_kg'])->gt(0)) {
            $owner = $run['scrap_owner'] === 'factory' ? $run['factory_party_id'] : null;
            $known = Schema::jsTruthy($run['scrap_owner']);
            $lotId = $trx->insertNoReturn('material_lots', ['kind' => 'scrap', 'owner_party_id' => $owner, 'description' => "ضایعات نوبت {$run['number']}" . ($known ? '' : ' (مالک نامشخص)'), 'created_by' => $me->id]);
            Stock::move($trx, ['item_type' => 'material_lot', 'item_id' => $lotId, 'from_location_id' => null, 'to_location_id' => $run['location_id'], 'kg' => $body['scrap_kg'], 'state_to' => 'scrap', 'ref_type' => 'production_output', 'ref_id' => $id, 'owner_party_id' => $owner, 'note' => $known ? null : 'مالک نامشخص', 'userId' => $me->id]);
        }

        // Die counters: cumulative, never overwritten.
        $perDie = $trx->all(
            'SELECT production_run_lines.die_id, SUM(COALESCE(bundle_lines.weight_kg, bundles.weight_kg)) AS kg
             FROM bundle_lines INNER JOIN bundles ON bundles.id = bundle_lines.bundle_id
             INNER JOIN production_run_lines ON production_run_lines.run_id = bundles.production_run_id AND production_run_lines.product_id = bundle_lines.product_id
             WHERE bundles.production_run_id = ? AND production_run_lines.die_id IS NOT NULL GROUP BY production_run_lines.die_id',
            [$id],
        );
        foreach ($perDie as $d) {
            if ($d['die_id']) {
                $trx->update('dies', ['total_produced_kg' => Db::raw('total_produced_kg + ?', [$d['kg']]), 'run_count' => Db::raw('run_count + 1'), 'last_run_at' => Db::now()] + Db::bump(), 'id = ?', [$d['die_id']]);
            }
        }

        // Toll fee (R07): basis from the contract only; NULL → document needs completion.
        $basisKg = $run['weight_basis'] === 'input' ? $body['ingot_consumed_kg'] : ($run['weight_basis'] === 'good_output' ? $sums['good_kg'] : null);
        $fee = Rules::productionFee($run['rate_per_kg'], $basisKg, $run['fixed_fee']);
        $feeDocId = $trx->insertNoReturn('documents', [
            'number' => Numbering::next($trx, 'toll_fee'), 'kind' => 'toll_fee', 'party_id' => $run['factory_party_id'], 'amount' => $fee, 'currency' => $run['rate_currency'], 'status' => $fee === null ? 'needs_completion' : 'posted',
            'posted_by' => $fee === null ? null : $me->id, 'posted_at' => $fee === null ? null : Db::now(), 'source_type' => 'production_run', 'source_id' => $id, 'settlement_basis_kg' => $basisKg, 'unit_price' => $run['rate_per_kg'],
            'description' => "اجرت تولید نوبت {$run['number']}", 'created_by' => $me->id,
        ]);
        if ($fee === null) Notify::managers($trx, ['kind' => 'fee_incomplete', 'title' => "اجرت نوبت {$run['number']} نرخ یا مبنا ندارد؛ هزینه ناقص", 'entity' => 'documents', 'entityId' => $feeDocId, 'groupKey' => "fee:{$id}"]);

        // Module 4: a rework cost given at close becomes an expense document sourced on this run and shared over the run's
        // orders by weight (R16), unless the contract puts it on the factory.
        $reworkDocId = null;
        $rework = $body['rework_cost'] ?? null;
        if (Schema::jsTruthy($rework) && Decimal::of($rework)->gt(0)) {
            $payer = $run['contract_id'] ? ($trx->value('SELECT rework_payer FROM contracts WHERE id = ?', [$run['contract_id']]) ?? null) : null;
            if ($payer !== 'party') $reworkDocId = self::reworkExpense($trx, $run, Num::round($rework, $run['rate_currency']), $me);
        }

        $after = $trx->updateById('production_runs', $id, [
            'status' => 'closed', 'ingot_consumed_kg' => $body['ingot_consumed_kg'], 'good_kg' => $sums['good_kg'], 'rejected_kg' => $sums['rejected_kg'], 'scrap_kg' => $body['scrap_kg'],
            'returned_material_kg' => $body['returned_material_kg'], 'unexplained_kg' => $bal['unexplained_kg'], 'close_reason' => $closeReason, 'closed_by' => $me->id, 'closed_at' => Db::now(),
            'fee_document_id' => $feeDocId, 'shortage_document_id' => $shortageDocId,
        ] + Db::bump());
        Audit::log($trx, [
            'userId' => $me->id, 'entity' => 'production_runs', 'entityId' => $id, 'action' => 'close', 'before' => $run,
            'after' => $after + ['ingot_cost' => $costIncomplete ? null : $costSum->toFixed(), 'rework_cost' => $rework, 'rework_document_id' => $reworkDocId],
            'reason' => $closeReason,
        ]);
        return ['status' => 200, 'body' => self::presentRun(self::loadRun($trx, $id), $me)];
    }

    /** Rework expense of a production run: posted by finance.post, otherwise reported for review; split over the run's orders by target kg (R16). */
    private static function reworkExpense(Db $trx, array $run, string $amount, AuthUser $me): string
    {
        $perOrder = $trx->all(
            'SELECT order_lines.order_id, SUM(production_run_lines.target_kg) AS kg FROM production_run_lines INNER JOIN order_lines ON order_lines.id = production_run_lines.order_line_id
             WHERE production_run_lines.run_id = ? GROUP BY order_lines.order_id ORDER BY order_lines.order_id',
            [$run['id']],
        );
        foreach ($perOrder as &$o) $o['kg'] ??= '0'; // COALESCE(SUM(…), 0)
        unset($o);
        $n = count($perOrder);
        $expenseType = $n === 1 ? 'order' : ($n > 1 ? 'shared' : 'general');
        $posted = Auth::can($me, 'finance.post');
        $docId = $trx->insertNoReturn('documents', [
            'number' => Numbering::next($trx, 'expense'), 'kind' => 'expense', 'party_id' => $run['factory_party_id'], 'amount' => $amount, 'currency' => $run['rate_currency'],
            'status' => $posted ? 'posted' : 'reported', 'posted_by' => $posted ? $me->id : null, 'posted_at' => $posted ? Db::now() : null, 'reported_by' => $me->id,
            'expense_type' => $expenseType, 'expense_category' => 'rework', 'order_id' => $expenseType === 'order' ? $perOrder[0]['order_id'] : null,
            'source_type' => 'production_run', 'source_id' => $run['id'], 'description' => "هزینه دوباره‌کاری نوبت {$run['number']}", 'created_by' => $me->id,
        ]);
        if ($perOrder) {
            $anyKg = (bool) array_filter($perOrder, static fn ($o) => Decimal::of($o['kg'])->gt(0));
            $weights = $anyKg ? array_column($perOrder, 'kg') : array_fill(0, $n, '1');
            $shares = Money::splitByWeight($amount, $weights, $run['rate_currency']);
            foreach ($perOrder as $i => $o) {
                $trx->insertNoReturn('expense_shares', ['document_id' => $docId, 'order_id' => $o['order_id'], 'amount' => $shares[$i], 'currency' => $run['rate_currency'], 'weight_kg' => $anyKg ? $o['kg'] : null, 'created_by' => $me->id]);
            }
        }
        if (!$posted) Notify::managers($trx, ['kind' => 'rework_cost', 'title' => "هزینه دوباره‌کاری نوبت {$run['number']} گزارش شد؛ قطعی‌کردن با مالی", 'entity' => 'documents', 'entityId' => $docId, 'groupKey' => "rework:{$run['id']}"]);
        return $docId;
    }

    /**
     * Vitral-owned ingot/billet lots with a positive balance at a location, with the moving-average unit cost (R13).
     * @return list<array{item_id:string,kg:string,avg_cost:?string,kind:string,alloy:?string}>
     */
    public static function ingotAtLocation(Db $db, string $locationId): array
    {
        $out = [];
        foreach (Stock::stockPositions($db, ['location_id' => $locationId, 'item_type' => 'material_lot']) as $p) {
            if (Decimal::of($p['kg'])->lte(0)) continue;
            $lot = $db->one('SELECT kind, alloy, owner_party_id, created_at FROM material_lots WHERE id = ?', [$p['item_id']]);
            if (!$lot || ($lot['kind'] !== 'ingot' && $lot['kind'] !== 'billet') || $lot['owner_party_id'] !== null) continue;
            $cost = $db->one(
                // stock_moves is append-only: a receipt booked before its price was known is valued with the price
                // later completed on its purchase document (same lookup as Materials::lotAverage).
                "SELECT SUM(stock_moves.kg * COALESCE(stock_moves.unit_cost, pd.unit_price)) AS v, SUM(stock_moves.kg) AS k,
                        MAX(COALESCE(stock_moves.unit_cost, pd.unit_price) IS NULL) AS unknown
                 FROM stock_moves LEFT JOIN documents pd ON pd.id = stock_moves.ref_id AND stock_moves.ref_type = 'purchase_receipt' AND pd.kind = 'purchase'
                 WHERE stock_moves.item_type = 'material_lot' AND stock_moves.item_id = ? AND stock_moves.to_location_id IS NOT NULL
                   AND stock_moves.ref_type IN ('purchase_receipt', 'opening', 'transfer_receive', 'smelting_output', 'count_adjustment')",
                [$p['item_id']],
            );
            $avg = !empty($cost['unknown']) || $cost['k'] === null || Decimal::of($cost['k'])->isZero() ? null : Num::round(Decimal::of($cost['v'])->div($cost['k']), 'TOMAN');
            $out[] = ['item_id' => $p['item_id'], 'kg' => $p['kg'], 'avg_cost' => $avg, 'kind' => $lot['kind'], 'alloy' => $lot['alloy']];
        }
        usort($out, static fn ($a, $b) => strcmp($a['item_id'], $b['item_id']));
        return $out;
    }
}
