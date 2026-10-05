<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\Auth;
use Vitral\Core\AuthUser;
use Vitral\Core\Db;
use Vitral\Core\Idempotency;
use Vitral\Core\Json;
use Vitral\Core\Notify;
use Vitral\Core\Numbering;
use Vitral\Core\Pagination;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\Schema;
use Vitral\Core\Settings;
use Vitral\Core\Undef;
use Vitral\Core\V;
use Vitral\Lib\Decimal;
use Vitral\Lib\Num;
use Vitral\Lib\Stock;
use Vitral\Rules\Production as Rules;

/** Port of apps/server/src/modules/coating/routes.ts (paint / anodize runs). */
final class Coating
{
    private const PRESENT_KEYS = [
        'id', 'number', 'party_id', 'party_name', 'service', 'color_code', 'contract_id', 'rate_per_kg', 'rate_currency',
        'includes_material', 'material_lot_id', 'material_units', 'input_basis', 'input_basis_kg', 'basis_reason', 'status',
        'sent_at', 'due_at', 'closed_at', 'transfer_id', 'fee_document_id', 'fee_incomplete', 'note',
        'items', 'totals', 'version', 'created_at',
    ];

    /** Keys the row does not have (undefined in Node) are left out, as JSON.stringify does. */
    public static function presentCoatingRun(array $c, ?AuthUser $user = null): array
    {
        $c['fee_incomplete'] = ($c['rate_per_kg'] ?? null) === null;
        $out = [];
        foreach (self::PRESENT_KEYS as $k) if (array_key_exists($k, $c)) $out[$k] = $c[$k];
        if ($user && !Auth::can($user, 'finance.view')) unset($out['fee_document_id']);
        return $out;
    }

    /** @return array<string,mixed>|null */
    public static function loadCoatingRun(Db $db, string $id): ?array
    {
        $r = $db->one('SELECT coating_runs.*, parties.name AS party_name FROM coating_runs LEFT JOIN parties ON parties.id = coating_runs.party_id WHERE coating_runs.id = ?', [$id]);
        if (!$r) return null;
        $items = $db->all(
            'SELECT coating_run_items.*, bundles.code AS bundle_code, bundles.form AS bundle_form, bundles.status AS bundle_status, bundles.location_id AS bundle_location_id
             FROM coating_run_items INNER JOIN bundles ON bundles.id = coating_run_items.bundle_id WHERE run_id = ? ORDER BY coating_run_items.created_at',
            [$id],
        );
        $raw = Decimal::zero();
        $rawReturned = Decimal::zero();
        $coated = Decimal::zero();
        $returned = 0;
        foreach ($items as $i) {
            $raw = $raw->add($i['raw_kg']);
            if ($i['coated_kg'] !== null) {
                $returned++;
                $rawReturned = $rawReturned->add($i['raw_kg']);
                $coated = $coated->add($i['coated_kg']);
            }
        }
        $gain = $returned ? Rules::weightGain($rawReturned, $coated) : null;
        $totals = [
            'raw_kg' => Num::round($raw, 'weight'), 'returned_count' => $returned, 'item_count' => count($items), 'coated_kg' => $returned ? Num::round($coated, 'weight') : null,
            'gain_kg' => $gain['gain_kg'] ?? null, 'gain_percent' => $gain['percent'] ?? null, 'fee' => Rules::coatingFee($r['input_basis_kg'], $r['rate_per_kg']),
        ];
        return $r + [
            'items' => array_map(static fn ($i) => $i + ['gain' => $i['coated_kg'] === null ? null : Rules::weightGain($i['raw_kg'], $i['coated_kg'])], $items),
            'totals' => $totals,
        ];
    }

    /** Settings `coating_gain_range_percent` (paint) and `anodize_gain_range_percent` (anodize); D4 — NULL until the client decides. */
    private static function gainRange(Db $db, string $service): ?array
    {
        $v = Settings::get($db, $service === 'anodize' ? 'anodize_gain_range_percent' : 'coating_gain_range_percent');
        $v = $v instanceof \stdClass ? Json::toArray($v) : $v;
        return is_array($v) && array_key_exists('min', $v) && array_key_exists('max', $v) ? $v : null;
    }

    public static function register(Router $r, App $app): void
    {
        $r->get('/coating-runs', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $q = V::listQuery()->extend([
                'order' => V::enum(['asc', 'desc'])->default('desc'), 'status' => V::enum(['open', 'partially_returned', 'returned', 'closed'])->optional(),
                'party_id' => V::uuid()->optional(), 'service' => V::enum(['paint', 'anodize'])->optional(), 'bundle_id' => V::uuid()->optional(),
            ])->parse($req->query);
            $where = [];
            $params = [];
            if (!empty($q['status'])) { $where[] = 'coating_runs.status = ?'; $params[] = $q['status']; }
            if (!empty($q['party_id'])) { $where[] = 'coating_runs.party_id = ?'; $params[] = $q['party_id']; }
            if (!empty($q['service'])) { $where[] = 'coating_runs.service = ?'; $params[] = $q['service']; }
            if (!empty($q['bundle_id'])) { $where[] = 'EXISTS (SELECT 1 FROM coating_run_items i WHERE i.run_id = coating_runs.id AND i.bundle_id = ?)'; $params[] = $q['bundle_id']; }
            $desc = $q['order'] === 'desc';
            $cur = Pagination::decodeCursor($q['cursor'] ?? null);
            if ($cur) {
                $where[] = '(coating_runs.sent_at, coating_runs.id) ' . ($desc ? '<' : '>') . ' (?, ?)';
                array_push($params, Db::dt($cur['at']), $cur['id']);
            }
            $dir = $desc ? 'DESC' : 'ASC';
            $rows = $app->db()->all(
                'SELECT coating_runs.*, parties.name AS party_name,
                   (SELECT COALESCE(SUM(raw_kg), 0) FROM coating_run_items i WHERE i.run_id = coating_runs.id) AS raw_kg,
                   (SELECT COUNT(*) FROM coating_run_items i WHERE i.run_id = coating_runs.id) AS item_count,
                   (SELECT COUNT(*) FROM coating_run_items i WHERE i.run_id = coating_runs.id AND i.coated_kg IS NOT NULL) AS returned_count
                 FROM coating_runs LEFT JOIN parties ON parties.id = coating_runs.party_id'
                . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
                . " ORDER BY coating_runs.sent_at {$dir}, coating_runs.id {$dir} LIMIT " . ($q['limit'] + 1),
                $params,
            );
            $page = array_slice($rows, 0, $q['limit']);
            $last = $page ? $page[count($page) - 1] : null;
            return [
                'items' => array_map(static function (array $x) use ($me) {
                    $totals = ['raw_kg' => Num::round((string) $x['raw_kg'], 'weight'), 'item_count' => (int) $x['item_count'], 'returned_count' => (int) $x['returned_count'], 'fee' => Rules::coatingFee($x['input_basis_kg'], $x['rate_per_kg'])];
                    return self::presentCoatingRun($x + ['totals' => $totals], $me);
                }, $page),
                'next_cursor' => count($rows) > $q['limit'] && $last ? Pagination::encodeCursor($last['sent_at'], $last['id']) : null,
            ];
        });

        $r->get('/coating-runs/:id', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $run = self::loadCoatingRun($app->db(), $id);
            if (!$run) throw new AppError('not_found');
            return self::presentCoatingRun($run, $me);
        });

        /** Send bundles to a painter/anodizer: a to_coating transfer (received at once) plus one ledger move per bundle. Rate from the active contract. */
        $r->post('/coating-runs', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $key = Idempotency::requireKey($req);
            $body = V::object([
                'party_id' => V::uuid(), 'service' => V::enum(['paint', 'anodize']), 'color_code' => V::optText(60), 'bundle_ids' => V::array(V::uuid())->min(1)->max(200),
                'due_at' => V::isoDate()->nullable()->optional(), 'sent_at' => V::isoDate()->optional(),
                'includes_material' => V::boolean()->nullable()->optional(), 'material_lot_id' => V::uuid()->nullable()->optional(), 'material_units' => V::decimalString()->nullable()->optional(),
                'input_basis' => V::enum(['bundle_sum', 'scale_ticket', 'agreed'])->default('bundle_sum'), 'input_basis_kg' => V::decimalString()->nullable()->optional(),
                'basis_reason' => V::optText(1000), 'note' => V::optText(2000),
            ])->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /coating-runs', static function (Db $trx) use ($body, $me) {
                $loc = $trx->value("SELECT id FROM locations WHERE party_id = ? AND kind = 'painter' LIMIT 1", [$body['party_id']]);
                if ($loc === null) throw new AppError('validation', 'این طرف نقش رنگ‌کار/آنودایزر ندارد', ['party_id' => 'رنگ‌کار نیست']);
                $c = Contracts::activeContract($trx, $body['party_id'], $body['service']);
                $rate = $c['rate_per_kg'] ?? ($body['service'] === 'anodize' ? Settings::get($trx, 'default_anodize_rate_per_kg') : null);
                if ($body['input_basis'] === 'agreed' && (!Schema::jsTruthy($body['input_basis_kg'] ?? null) || !Schema::jsTruthy($body['basis_reason'] ?? null))) {
                    throw new AppError('validation', 'مبنای توافقی وزن و دلیل لازم دارد', ['basis_reason' => 'لازم است']);
                }
                $ids = $body['bundle_ids'];
                $bundles = $trx->all('SELECT * FROM bundles WHERE id IN (' . Db::placeholders($ids) . ') ORDER BY created_at, id FOR UPDATE', $ids);
                if (count($bundles) !== count($ids)) throw new AppError('validation', 'برخی بندیل‌ها یافت نشد', ['bundle_ids' => 'نامعتبر']);
                foreach ($bundles as $b) {
                    if ($b['draft'] || $b['status'] !== 'ok') throw new AppError('validation', "بندیل {$b['code']} پیش‌نویس یا در قرنطینه است");
                    if ($b['form'] !== 'raw') throw new AppError('validation', "بندیل {$b['code']} خام نیست");
                    $open = $trx->value(
                        "SELECT coating_run_items.id FROM coating_run_items INNER JOIN coating_runs ON coating_runs.id = coating_run_items.run_id
                         WHERE bundle_id = ? AND coating_run_items.coated_kg IS NULL AND coating_runs.status <> 'closed' LIMIT 1",
                        [$b['id']],
                    );
                    if ($open !== null) throw new AppError('validation', "بندیل {$b['code']} الان در یک نوبت رنگ باز است");
                }
                $sentAt = isset($body['sent_at']) ? new \DateTimeImmutable($body['sent_at']) : new \DateTimeImmutable('now');
                $rawSum = Decimal::sum(array_column($bundles, 'weight_kg'));
                $basisKg = $body['input_basis'] === 'bundle_sum' ? $rawSum->toFixed(3) : ($body['input_basis_kg'] ?? null);
                $from = $bundles[0]['location_id'];
                $transferId = $trx->insertNoReturn('transfers', [
                    'number' => Numbering::next($trx, 'transfer', $sentAt), 'kind' => 'to_coating', 'from_location_id' => $from, 'to_location_id' => $loc, 'status' => 'received',
                    'departed_at' => Db::dt($sentAt), 'received_at' => Db::dt($sentAt), 'dispatched_by' => $me->id, 'created_by' => $me->id, 'note' => $body['note'] ?? null,
                ]);
                $run = $trx->insert('coating_runs', [
                    'number' => Numbering::next($trx, 'coating_run', $sentAt), 'party_id' => $body['party_id'], 'service' => $body['service'], 'color_code' => $body['color_code'] ?? null,
                    'contract_id' => $c['id'] ?? null, 'rate_per_kg' => $rate, 'rate_currency' => $c['currency'] ?? 'TOMAN',
                    'includes_material' => $body['includes_material'] ?? $c['includes_material'] ?? null, 'material_lot_id' => $body['material_lot_id'] ?? null, 'material_units' => $body['material_units'] ?? null,
                    'input_basis' => $body['input_basis'], 'input_basis_kg' => $basisKg, 'basis_reason' => $body['basis_reason'] ?? null,
                    'sent_at' => Db::dt($sentAt), 'due_at' => isset($body['due_at']) ? Db::dt($body['due_at']) : null, 'transfer_id' => $transferId, 'note' => $body['note'] ?? null, 'created_by' => $me->id,
                ]);
                foreach ($bundles as $b) {
                    $trx->insertNoReturn('transfer_lines', ['transfer_id' => $transferId, 'bundle_id' => $b['id'], 'kg' => $b['weight_kg'], 'received_kg' => $b['weight_kg'], 'received_at' => Db::dt($sentAt), 'created_by' => $me->id]);
                    $trx->insertNoReturn('coating_run_items', ['run_id' => $run['id'], 'bundle_id' => $b['id'], 'raw_kg' => $b['weight_kg'], 'created_by' => $me->id]);
                    Stock::move($trx, ['at' => $sentAt, 'item_type' => 'bundle', 'item_id' => $b['id'], 'from_location_id' => $b['location_id'], 'to_location_id' => $loc, 'kg' => $b['weight_kg'], 'state_from' => 'raw', 'state_to' => 'raw', 'ref_type' => 'coating_send', 'ref_id' => $run['id'], 'userId' => $me->id]);
                    $trx->update('bundles', ['location_id' => $loc, 'raw_weight_kg' => $b['weight_kg']] + Db::bump(), 'id = ?', [$b['id']]);
                }
                if ($rate === null) {
                    Notify::managers($trx, ['kind' => 'fee_incomplete', 'title' => "نوبت رنگ {$run['number']} نرخ ندارد؛ قرارداد " . ($body['service'] === 'paint' ? 'رنگ' : 'آنودایز') . ' را ثبت کنید', 'entity' => 'coating_runs', 'entityId' => $run['id'], 'groupKey' => "coating_rate:{$run['id']}"]);
                }
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'coating_runs', 'entityId' => $run['id'], 'action' => 'create', 'after' => $run]);
                return ['status' => 201, 'body' => self::presentCoatingRun(self::loadCoatingRun($trx, $run['id']), $me)];
            });
            return Response::json($res['body'], $res['status']);
        });

        /**
         * @param array<string,Schema> $shape
         * @param callable(Db,array,AuthUser,array):void $work
         */
        $act = static function (Request $req, string $name, ?string $perm, array $shape, callable $work) use ($app) {
            $me = $perm ? $req->requirePermission($perm) : $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $key = Idempotency::requireKey($req);
            $raw = $req->body();
            if ($raw instanceof Undef || $raw === null) $raw = new \stdClass();
            $body = V::object(['version' => V::int()] + $shape)->parse($raw);
            $res = Idempotency::run($app->db(), $key, $me->id, "POST /coating-runs/{$name}", static function (Db $trx) use ($id, $body, $me, $name, $work) {
                $run = $trx->find('coating_runs', $id, true);
                if (!$run) throw new AppError('not_found');
                if ($run['version'] !== $body['version']) throw AppError::conflict(self::presentCoatingRun(self::loadCoatingRun($trx, $id), $me));
                if ($run['status'] === 'closed') throw new AppError('validation', 'نوبت رنگ بسته شده است');
                $work($trx, $run, $me, $body);
                $after = $trx->find('coating_runs', $id);
                if (!$after) throw new \RuntimeException('no result');
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'coating_runs', 'entityId' => $id, 'action' => $name, 'before' => ['status' => $run['status']], 'after' => ['status' => $after['status']], 'reason' => $body['reason'] ?? null]);
                return ['status' => 200, 'body' => self::presentCoatingRun(self::loadCoatingRun($trx, $id), $me)];
            });
            return $res['body'];
        };

        /** Return items: coated weight per bundle, R06 gain flagged when outside the configured range; bundles move back (coated) to the warehouse. */
        $r->post('/coating-runs/:id/return', static fn (Request $req) => $act($req, 'return', null, [
            'to_location_id' => V::uuid()->optional(),
            'returned_at' => V::isoDate()->optional(),
            'items' => V::array(V::object([
                'item_id' => V::uuid(), 'coated_kg' => V::decimalString(), 'bars_returned' => V::int()->min(0)->nullable()->optional(),
                'qc' => V::enum(['ok', 'needs_review', 'rejected'])->default('ok'), 'note' => V::optText(1000),
            ]))->min(1)->max(200),
        ], static function (Db $trx, array $r, AuthUser $me, array $body) {
            $to = $body['to_location_id'] ?? Stock::OWN_WAREHOUSE($trx);
            $at = isset($body['returned_at']) ? new \DateTimeImmutable($body['returned_at']) : new \DateTimeImmutable('now');
            $range = self::gainRange($trx, $r['service']);
            $form = $r['service'] === 'paint' ? 'painted' : 'anodized';
            $flagged = [];
            foreach ($body['items'] as $it) {
                $item = $trx->one('SELECT * FROM coating_run_items WHERE id = ? AND run_id = ? FOR UPDATE', [$it['item_id'], $r['id']]);
                if (!$item) throw new AppError('validation', 'آیتم نوبت یافت نشد', ['item_id' => 'نامعتبر']);
                if ($item['coated_kg'] !== null) throw new AppError('validation', 'این بندیل قبلاً برگشت خورده است');
                $b = $trx->find('bundles', $item['bundle_id'], true);
                if (!$b) throw new \RuntimeException('no result');
                $g = Rules::weightGain($item['raw_kg'], $it['coated_kg']);
                // Module 5: outside the normal range of this service (paint or anodize, if set) or negative → «نیازمند بررسی».
                $needsReview = Decimal::of($g['gain_kg'])->lt(0)
                    || ($range !== null && $g['percent'] !== null && (Decimal::of($g['percent'])->lt($range['min']) || Decimal::of($g['percent'])->gt($range['max'])));
                if ($needsReview) $flagged[] = "{$b['code']} ({$g['percent']}٪)";
                $trx->update('coating_run_items', [
                    'coated_kg' => $it['coated_kg'], 'bars_returned' => $it['bars_returned'] ?? null, 'qc' => $it['qc'], 'note' => $it['note'] ?? null,
                    'returned_at' => Db::dt($at), 'gain_needs_review' => $needsReview,
                ] + Db::bump(), 'id = ?', [$item['id']]);
                // Weight changes between send and return: the bundle leaves with raw kg and arrives with coated kg (gain appears as a positive adjustment at the painter).
                $diff = Decimal::of($it['coated_kg'])->sub($b['weight_kg']);
                if ($diff->gt(0)) {
                    Stock::move($trx, ['at' => $at, 'item_type' => 'bundle', 'item_id' => $b['id'], 'from_location_id' => null, 'to_location_id' => $b['location_id'], 'kg' => $diff->toFixed(3), 'state_to' => 'raw', 'ref_type' => 'coating_return', 'ref_id' => $r['id'], 'note' => 'افزایش وزن پوشش', 'userId' => $me->id]);
                } elseif ($diff->lt(0)) {
                    Stock::move($trx, ['at' => $at, 'item_type' => 'bundle', 'item_id' => $b['id'], 'from_location_id' => $b['location_id'], 'to_location_id' => null, 'kg' => $diff->abs()->toFixed(3), 'state_from' => 'raw', 'ref_type' => 'coating_return', 'ref_id' => $r['id'], 'note' => 'کاهش وزن در پوشش', 'userId' => $me->id]);
                }
                $toState = $it['qc'] === 'rejected' ? 'quarantine' : Bundles::formState($form);
                Stock::move($trx, ['at' => $at, 'item_type' => 'bundle', 'item_id' => $b['id'], 'from_location_id' => $b['location_id'], 'to_location_id' => $to, 'kg' => $it['coated_kg'], 'state_from' => 'raw', 'state_to' => $toState, 'ref_type' => 'coating_return', 'ref_id' => $r['id'], 'userId' => $me->id]);
                $trx->update('bundles', [
                    'location_id' => $to, 'weight_kg' => $it['coated_kg'], 'form' => $form, 'color' => $r['color_code'] ?? $b['color'], 'status' => $it['qc'] === 'rejected' ? 'damaged' : 'ok',
                    'defect' => $it['qc'] === 'rejected' ? 'coating_rejected' : $b['defect'], 'qc_note' => $it['note'] ?? $b['qc_note'],
                ] + Db::bump(), 'id = ?', [$b['id']]);
            }
            $pending = $trx->value('SELECT id FROM coating_run_items WHERE run_id = ? AND coated_kg IS NULL LIMIT 1', [$r['id']]);
            $trx->update('coating_runs', ['status' => $pending !== null ? 'partially_returned' : 'returned'] + Db::bump(), 'id = ?', [$r['id']]);
            if ($flagged) {
                Notify::managers($trx, ['kind' => 'coating_gain_review', 'title' => "افزایش وزن خارج از بازه در نوبت رنگ {$r['number']}: " . implode('، ', $flagged), 'entity' => 'coating_runs', 'entityId' => $r['id'], 'groupKey' => "gain:{$r['id']}"]);
            }
        }));

        /** Change basis before close (agreed kg needs a reason); items' qc. */
        $r->post('/coating-runs/:id/basis', static fn (Request $req) => $act($req, 'basis', 'technical.approve', [
            'input_basis' => V::enum(['bundle_sum', 'scale_ticket', 'agreed']), 'input_basis_kg' => V::decimalString()->nullable()->optional(),
            'basis_reason' => V::optText(1000), 'scale_ticket_id' => V::uuid()->optional(),
        ], static function (Db $trx, array $r, AuthUser $me, array $body) {
            $kg = null;
            if ($body['input_basis'] === 'bundle_sum') {
                $sum = $trx->value('SELECT COALESCE(SUM(raw_kg), 0) FROM coating_run_items WHERE run_id = ?', [$r['id']]);
                $kg = Num::round((string) $sum, 'weight');
            } elseif ($body['input_basis'] === 'scale_ticket') {
                $t = $trx->one('SELECT * FROM scale_tickets WHERE id = ? AND coating_run_id = ?', [(string) ($body['scale_ticket_id'] ?? 'undefined'), $r['id']]);
                if (!$t || $t['status'] !== 'approved') throw new AppError('validation', 'قبض باسکول تأییدشده برای این نوبت لازم است', ['scale_ticket_id' => 'نامعتبر']);
                $kg = $t['net_direct_kg'] ?? (Schema::jsTruthy($t['gross_kg']) && Schema::jsTruthy($t['tare_kg']) ? Num::round(Decimal::of($t['gross_kg'])->sub($t['tare_kg'])->sub($t['packaging_kg'] ?? 0), 'weight') : null);
            } else {
                if (!Schema::jsTruthy($body['input_basis_kg'] ?? null) || !Schema::jsTruthy($body['basis_reason'] ?? null)) throw new AppError('validation', 'مبنای توافقی وزن و دلیل لازم دارد', ['basis_reason' => 'لازم است']);
                $kg = $body['input_basis_kg'];
            }
            $trx->update('coating_runs', ['input_basis' => $body['input_basis'], 'input_basis_kg' => $kg, 'basis_reason' => $body['basis_reason'] ?? null] + Db::bump(), 'id = ?', [$r['id']]);
        }));

        /** Close (technical.approve): all items returned; fee R05 = input basis × rate (output weight irrelevant, T39); paint powder consumed when supplied by Vitral. */
        $r->post('/coating-runs/:id/close', static fn (Request $req) => $act($req, 'close', 'technical.approve', ['reason' => V::optText(1000)], static function (Db $trx, array $r, AuthUser $me) {
            if ($trx->value('SELECT id FROM coating_run_items WHERE run_id = ? AND coated_kg IS NULL LIMIT 1', [$r['id']]) !== null) throw new AppError('validation', 'همه بندیل‌ها هنوز برنگشته‌اند');
            $fee = Rules::coatingFee($r['input_basis_kg'], $r['rate_per_kg']);
            $docId = $trx->insertNoReturn('documents', [
                'number' => Numbering::next($trx, 'toll_fee'), 'kind' => 'toll_fee', 'party_id' => $r['party_id'], 'amount' => $fee, 'currency' => $r['rate_currency'], 'status' => $fee === null ? 'needs_completion' : 'posted',
                'posted_by' => $fee === null ? null : $me->id, 'posted_at' => $fee === null ? null : Db::now(),
                'source_type' => 'coating_run', 'source_id' => $r['id'], 'settlement_basis_kg' => $r['input_basis_kg'], 'unit_price' => $r['rate_per_kg'],
                'description' => 'اجرت ' . ($r['service'] === 'paint' ? 'رنگ' : 'آنودایز') . " نوبت {$r['number']}", 'created_by' => $me->id,
            ]);
            if ($r['includes_material'] === false && Schema::jsTruthy($r['material_lot_id']) && Schema::jsTruthy($r['material_units'])) {
                $lot = $trx->find('material_lots', $r['material_lot_id']);
                if ($lot) {
                    $kg = $lot['unit'] === 'kg' ? Decimal::of($r['material_units']) : Decimal::of($r['material_units'])->mul($lot['kg_per_unit'] ?? 0);
                    $loc = $trx->value("SELECT id FROM locations WHERE party_id = ? AND kind = 'painter' LIMIT 1", [$r['party_id']]);
                    if ($loc === null) throw new \RuntimeException('no result');
                    if ($kg->gt(0)) Stock::move($trx, ['item_type' => 'material_lot', 'item_id' => $lot['id'], 'from_location_id' => $loc, 'to_location_id' => null, 'kg' => $kg->toFixed(3), 'state_from' => 'paint', 'state_to' => 'consumed', 'ref_type' => 'material_consume', 'ref_id' => $r['id'], 'userId' => $me->id]);
                }
            }
            if ($fee === null) Notify::managers($trx, ['kind' => 'fee_incomplete', 'title' => "اجرت نوبت رنگ {$r['number']} بدون نرخ؛ هزینه ناقص", 'entity' => 'documents', 'entityId' => $docId, 'groupKey' => "coating_fee:{$r['id']}"]);
            $trx->update('coating_runs', ['status' => 'closed', 'closed_at' => Db::now(), 'closed_by' => $me->id, 'fee_document_id' => $docId] + Db::bump(), 'id = ?', [$r['id']]);
        }));

        /** Painter scorecard: lateness, avg gain, rejects. */
        $r->get('/coating-runs/scorecard', static function (Request $req) use ($app) {
            $req->requireUser();
            $rows = $app->db()->all(
                "SELECT coating_runs.party_id, parties.name, coating_runs.service, COUNT(DISTINCT coating_runs.id) AS runs, SUM(raw_kg) AS raw, SUM(coated_kg) AS coated,
                        SUM(CASE WHEN qc = 'rejected' THEN 1 ELSE 0 END) AS rejected,
                        COUNT(DISTINCT CASE WHEN due_at IS NOT NULL AND returned_at > due_at THEN coating_runs.id END) AS late
                 FROM coating_runs INNER JOIN parties ON parties.id = coating_runs.party_id INNER JOIN coating_run_items ON coating_run_items.run_id = coating_runs.id
                 WHERE coating_run_items.coated_kg IS NOT NULL GROUP BY coating_runs.party_id, parties.name, coating_runs.service",
            );
            return ['items' => array_map(static fn ($x) => [
                'party_id' => $x['party_id'], 'name' => $x['name'], 'service' => $x['service'], 'runs' => (int) $x['runs'], 'late' => (int) $x['late'],
                'rejected_items' => (int) $x['rejected'], 'gain' => Rules::weightGain($x['raw'], $x['coated']),
            ], $rows)];
        });
    }
}
