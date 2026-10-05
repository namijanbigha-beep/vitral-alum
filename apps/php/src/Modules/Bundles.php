<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\AuthUser;
use Vitral\Core\Db;
use Vitral\Core\Idempotency;
use Vitral\Core\Notify;
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
use Vitral\Rules\Production;

/** Port of apps/server/src/modules/bundles/routes.ts. */
final class Bundles
{
    public const STATUSES = ['ok', 'damaged', 'wrong_product', 'pending_review', 'scrapped', 'consumed'];
    public const QUARANTINE = ['damaged', 'wrong_product', 'pending_review'];

    private const PRESENT_KEYS = [
        'id', 'code', 'code_is_temp', 'production_run_id', 'run_number', 'location_id', 'location_name', 'factory_party_id',
        'weight_kg', 'packaging_kg', 'form', 'color', 'status', 'draft', 'source', 'qc_note', 'defect', 'decision', 'decision_note',
        'decided_by', 'decided_at', 'raw_weight_kg', 'measured_filler_mm', 'measured_length_m', 'reserved_order_line_id', 'origin_bundle_ids',
        'warnings', 'note', 'reported_at', 'lines', 'reserved_kg', 'free_kg', 'moves', 'version', 'created_at', 'updated_at',
    ];

    private static function lineSchema(): Schema
    {
        return V::object([
            'product_id' => V::uuid(),
            'filler_mm' => V::decimalString()->nullable()->optional(),
            'length_m' => V::decimalString()->nullable()->optional(),
            'bars' => V::int()->min(0)->nullable()->optional(),
            'weight_kg' => V::decimalString()->nullable()->optional(),
            'order_line_id' => V::uuid()->nullable()->optional(),
        ]);
    }

    /** Keys missing from the row (undefined in Node) are left out, like JSON.stringify does. */
    public static function presentBundle(array $b): array
    {
        $out = [];
        foreach (self::PRESENT_KEYS as $k) if (array_key_exists($k, $b)) $out[$k] = $b[$k];
        return $out;
    }

    /** Lines with product code/name, for the given bundles. @param list<string> $ids @return list<array<string,mixed>> */
    private static function linesFor(Db $db, array $ids): array
    {
        if (!$ids) return [];
        return $db->all(
            'SELECT bundle_lines.*, products.code AS product_code, products.name_fa AS product_name FROM bundle_lines
             LEFT JOIN products ON products.id = bundle_lines.product_id WHERE bundle_id IN (' . Db::placeholders($ids) . ') ORDER BY sort',
            $ids,
        );
    }

    /** @return array<string,mixed>|null */
    public static function loadBundle(Db $db, string $id, bool $withMoves = false): ?array
    {
        $b = $db->one(
            'SELECT bundles.*, locations.name AS location_name, production_runs.number AS run_number FROM bundles
             LEFT JOIN locations ON locations.id = bundles.location_id LEFT JOIN production_runs ON production_runs.id = bundles.production_run_id
             WHERE bundles.id = ?',
            [$id],
        );
        if (!$b) return null;
        $lines = self::linesFor($db, [$id]);
        $reserved = (string) ($db->value("SELECT SUM(kg) FROM reservations WHERE bundle_id = ? AND status = 'active'", [$id]) ?? '0');
        $out = $b + ['lines' => $lines, 'reserved_kg' => Num::round($reserved, 'weight'), 'free_kg' => Num::round(Decimal::of($b['weight_kg'])->sub($reserved), 'weight')];
        if ($withMoves) {
            $out['moves'] = $db->all(
                "SELECT stock_moves.id, stock_moves.at, stock_moves.kg, stock_moves.state_from, stock_moves.state_to, stock_moves.ref_type, stock_moves.ref_id, f.name AS from_name, t.name AS to_name
                 FROM stock_moves LEFT JOIN locations f ON f.id = stock_moves.from_location_id LEFT JOIN locations t ON t.id = stock_moves.to_location_id
                 WHERE item_type = 'bundle' AND item_id = ? ORDER BY at",
                [$id],
            );
        }
        return $out;
    }

    /** Form → ledger state. */
    public static function formState(string $form): string
    {
        return $form === 'raw' ? 'raw' : 'coated';
    }

    /** Temporary code TMP-<yyyymmdd>-<n>, unique per day (spec §8 module 5). */
    private static function tempCode(Db $trx): string
    {
        $day = gmdate('Ymd');
        $n = (int) $trx->value('SELECT COUNT(*) FROM bundles WHERE code LIKE ?', ["TMP-{$day}-%"]);
        return "TMP-{$day}-" . ($n + 1);
    }

    private static function refTypeFor(string $source): string
    {
        return match ($source) {
            'production' => 'production_output',
            'purchase' => 'purchase_receipt',
            'opening' => 'opening',
            default => 'customer_return',
        };
    }

    /**
     * Warnings at report time (never blocking): R03 weight/metre vs approved filler weight, R22 outlier, min length, duplicate code.
     * @param array{code?:?string,id?:?string,production_run_id:?string,weight_kg:string,packaging_kg:?string,lines:list<array<string,mixed>>} $input
     * @return list<array{code:string,message:string,data?:array<string,mixed>}>
     */
    public static function bundleWarnings(Db $trx, array $input): array
    {
        $out = [];
        $tol = Settings::get($trx, 'weight_per_meter_tolerance_percent') ?? '5';
        $medianTol = Settings::get($trx, 'bundle_weight_median_threshold_percent') ?? '40';
        $code = $input['code'] ?? null;
        $id = $input['id'] ?? null;
        if (Schema::jsTruthy($code)) {
            $sql = "SELECT id FROM bundles WHERE code = ? AND status <> 'consumed'";
            $params = [$code];
            if (Schema::jsTruthy($id)) {
                $sql .= ' AND id <> ?';
                $params[] = $id;
            }
            if ($trx->one($sql . ' LIMIT 1', $params)) $out[] = ['code' => 'duplicate_code', 'message' => "کد {$code} قبلاً ثبت شده؛ بندیل در حالت «نیازمند بررسی» قرار گرفت"];
        }
        $lines = $input['lines'];
        $single = count($lines) === 1 ? $lines[0] : null;
        foreach ($lines as $l) {
            $kg = count($lines) === 1 ? $input['weight_kg'] : ($l['weight_kg'] ?? null);
            if ($kg !== null && Schema::jsTruthy($l['bars'] ?? null) && Schema::jsTruthy($l['length_m'] ?? null)) {
                $filler = $l['filler_mm'] ?? null;
                $ref = Schema::jsTruthy($filler)
                    ? $trx->value("SELECT weight_g_per_m FROM product_fillers WHERE product_id = ? AND status = 'approved' AND filler_mm = ? LIMIT 1", [$l['product_id'], $filler])
                    : $trx->value("SELECT weight_g_per_m FROM product_fillers WHERE product_id = ? AND status = 'approved' AND filler_mm IS NULL LIMIT 1", [$l['product_id']]);
                $r = Production::bundleWeightPerMeter($kg, count($lines) === 1 ? $input['packaging_kg'] : null, $l['bars'], $l['length_m'], $ref);
                if ($r && $r['diff_percent'] !== null && Decimal::of($r['diff_percent'])->abs()->gt($tol)) {
                    $out[] = [
                        'code' => 'weight_per_meter',
                        'message' => "وزن هر متر {$r['g_per_m']} گرم است؛ {$r['diff_percent']}٪ اختلاف با وزن تأییدشده {$ref}",
                        'data' => ['product_id' => $l['product_id'], 'g_per_m' => $r['g_per_m'], 'diff_percent' => $r['diff_percent'], 'reference' => $ref],
                    ];
                }
            }
            if (Schema::jsTruthy($l['order_line_id'] ?? null) && Schema::jsTruthy($l['length_m'] ?? null)) {
                $min = $trx->value('SELECT min_length_m FROM order_lines WHERE id = ?', [$l['order_line_id']]);
                if (Schema::jsTruthy($min) && Decimal::of($l['length_m'])->lt($min)) {
                    $out[] = ['code' => 'min_length', 'message' => "طول {$l['length_m']} متر از حداقل طول سفارش ({$min}) کمتر است", 'data' => ['order_line_id' => $l['order_line_id']]];
                }
            }
        }
        if ($single && Schema::jsTruthy($input['production_run_id'] ?? null)) {
            $sql = 'SELECT bundles.weight_kg FROM bundles INNER JOIN bundle_lines ON bundle_lines.bundle_id = bundles.id
                    WHERE bundles.production_run_id = ? AND bundle_lines.product_id = ? AND bundles.draft = 0
                      AND (SELECT COUNT(*) FROM bundle_lines x WHERE x.bundle_id = bundles.id) = 1';
            $params = [$input['production_run_id'], $single['product_id']];
            if (Schema::jsTruthy($id)) {
                $sql .= ' AND bundles.id <> ?';
                $params[] = $id;
            }
            $peers = $trx->column($sql, $params);
            $o = Production::bundleWeightOutlier($input['weight_kg'], $peers, $medianTol);
            if ($o && $o['warn']) {
                $out[] = ['code' => 'weight_outlier', 'message' => "وزن بندیل {$input['weight_kg']} با میانه {$o['median_kg']} کیلوگرم بندیل‌های همین محصول در این نوبت فاصله دارد", 'data' => ['median_kg' => $o['median_kg']]];
            }
        }
        return $out;
    }

    private static function insertLines(Db $trx, string $bundleId, array $lines, string $userId): void
    {
        $sort = 0;
        foreach ($lines as $l) $trx->insertNoReturn('bundle_lines', $l + ['bundle_id' => $bundleId, 'sort' => $sort++, 'created_by' => $userId]);
    }

    public static function register(Router $r, App $app): void
    {
        $line = self::lineSchema();
        $createSchema = V::object([
            'production_run_id' => V::uuid()->nullable()->optional(), 'location_id' => V::uuid()->optional(), 'factory_party_id' => V::uuid()->nullable()->optional(),
            'code' => V::string()->trim()->min(1)->max(60)->optional(),
            'weight_kg' => V::decimalString(), 'packaging_kg' => V::decimalString()->nullable()->optional(), 'form' => V::enum(['raw', 'painted', 'anodized'])->default('raw'), 'color' => V::optText(60),
            'source' => V::enum(['production', 'purchase', 'opening', 'return'])->default('production'), 'draft' => V::boolean()->default(false), 'note' => V::optText(2000),
            'reported_at' => V::isoDate()->optional(),
            'lines' => V::array($line)->min(1)->max(50),
        ]);
        $updateSchema = V::object([
            'version' => V::int(), 'code' => V::string()->trim()->min(1)->max(60)->optional(), 'color' => V::optText(60), 'note' => V::optText(2000), 'qc_note' => V::optText(2000),
            'weight_kg' => V::decimalString()->optional(), 'packaging_kg' => V::decimalString()->nullable()->optional(), 'lines' => V::array($line)->min(1)->max(50)->optional(), 'reason' => V::optText(1000),
        ]);

        $r->get('/bundles', static function (Request $req) use ($app) {
            $req->requireUser();
            $q = V::listQuery()->extend([
                'order' => V::enum(['asc', 'desc'])->default('desc'), 'q' => V::string()->trim()->max(60)->optional(), 'production_run_id' => V::uuid()->optional(), 'location_id' => V::uuid()->optional(),
                'product_id' => V::uuid()->optional(), 'order_line_id' => V::uuid()->optional(), 'status' => V::enum(self::STATUSES)->optional(),
                'form' => V::enum(['raw', 'painted', 'anodized'])->optional(), 'color' => V::string()->max(60)->optional(), 'available' => V::boolQuery()->optional(), 'quarantine' => V::boolQuery()->optional(),
                'draft' => V::boolQuery()->optional(), 'temp' => V::boolQuery()->optional(),
            ])->parse($req->query);
            $where = [];
            $params = [];
            $add = static function (string $sql, array $p = []) use (&$where, &$params) {
                $where[] = "({$sql})";
                array_push($params, ...$p);
            };
            // Node interpolates q into the pattern unescaped
            if (($q['q'] ?? '') !== '') $add('bundles.code LIKE ?', ['%' . $q['q'] . '%']);
            if (!empty($q['production_run_id'])) $add('bundles.production_run_id = ?', [$q['production_run_id']]);
            if (!empty($q['location_id'])) $add('bundles.location_id = ?', [$q['location_id']]);
            if (!empty($q['status'])) $add('bundles.status = ?', [$q['status']]);
            if (!empty($q['form'])) $add('bundles.form = ?', [$q['form']]);
            if (($q['color'] ?? '') !== '') $add('bundles.color = ?', [$q['color']]);
            if (array_key_exists('draft', $q)) $add('bundles.draft = ?', [$q['draft']]);
            if (!empty($q['temp'])) $add('bundles.code_is_temp = 1');
            if (!empty($q['quarantine'])) $add("bundles.status IN ('damaged', 'wrong_product', 'pending_review')");
            if (!empty($q['available'])) $add("bundles.status = 'ok' AND bundles.draft = 0");
            if (!empty($q['product_id'])) $add('EXISTS (SELECT 1 FROM bundle_lines bl WHERE bl.bundle_id = bundles.id AND bl.product_id = ?)', [$q['product_id']]);
            if (!empty($q['order_line_id'])) $add('bundles.reserved_order_line_id = ? OR EXISTS (SELECT 1 FROM bundle_lines bl WHERE bl.bundle_id = bundles.id AND bl.order_line_id = ?)', [$q['order_line_id'], $q['order_line_id']]);
            $desc = $q['order'] === 'desc';
            $cur = Pagination::decodeCursor($q['cursor'] ?? null);
            if ($cur) $add('(bundles.reported_at, bundles.id) ' . ($desc ? '<' : '>') . ' (?, ?)', [Db::dt($cur['at']), $cur['id']]);
            $dir = $desc ? 'DESC' : 'ASC';
            $sql = "SELECT bundles.*, locations.name AS location_name,
                      (SELECT SUM(kg) FROM reservations r WHERE r.bundle_id = bundles.id AND r.status = 'active') AS reserved_kg
                    FROM bundles LEFT JOIN locations ON locations.id = bundles.location_id"
                . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
                . " ORDER BY bundles.reported_at {$dir}, bundles.id {$dir} LIMIT " . ($q['limit'] + 1);
            $db = $app->db();
            $rows = $db->all($sql, $params);
            $page = array_slice($rows, 0, $q['limit']);
            $lines = self::linesFor($db, array_column($page, 'id'));
            $by = [];
            foreach ($lines as $l) $by[$l['bundle_id']][] = $l;
            $last = $page ? $page[count($page) - 1] : null;
            return [
                'items' => array_map(static function (array $b) use ($by) {
                    $b['reserved_kg'] ??= '0'; // COALESCE(SUM(kg), 0) of PostgreSQL prints a bare 0
                    return self::presentBundle($b + ['lines' => $by[$b['id']] ?? [], 'free_kg' => Num::round(Decimal::of($b['weight_kg'])->sub($b['reserved_kg']), 'weight')]);
                }, $page),
                'next_cursor' => count($rows) > $q['limit'] && $last ? Pagination::encodeCursor($last['reported_at'], $last['id']) : null,
            ];
        });

        $r->get('/bundles/:id', static function (Request $req) use ($app) {
            $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $b = self::loadBundle($app->db(), $id, true);
            if (!$b) throw new AppError('not_found');
            return self::presentBundle($b);
        });

        /** Report a bundle (any user). A draft stays off the ledger until finalised. */
        $r->post('/bundles', static function (Request $req) use ($app, $createSchema) {
            $me = $req->requireUser();
            $key = Idempotency::requireKey($req);
            $body = $createSchema->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /bundles', static function (Db $trx) use ($body, $me) {
                $locationId = $body['location_id'] ?? null;
                $factory = $body['factory_party_id'] ?? null;
                $runId = $body['production_run_id'] ?? null;
                if (Schema::jsTruthy($runId)) {
                    $run = $trx->one('SELECT location_id, factory_party_id, status FROM production_runs WHERE id = ?', [$runId]);
                    if (!$run) throw new AppError('validation', 'نوبت تولید یافت نشد', ['production_run_id' => 'نامعتبر']);
                    if ($run['status'] === 'closed') throw new AppError('validation', 'نوبت بسته است؛ بندیل جدید ثبت نمی‌شود');
                    $locationId ??= $run['location_id'];
                    $factory ??= $run['factory_party_id'];
                }
                if (!$locationId) $locationId = Stock::OWN_WAREHOUSE($trx);
                $code = $body['code'] ?? self::tempCode($trx);
                $warnings = self::bundleWarnings($trx, ['code' => $body['code'] ?? null, 'production_run_id' => $runId, 'weight_kg' => $body['weight_kg'], 'packaging_kg' => $body['packaging_kg'] ?? null, 'lines' => $body['lines']]);
                $sumLines = Decimal::zero();
                $allWeighed = true;
                foreach ($body['lines'] as $l) {
                    if (Schema::jsTruthy($l['weight_kg'] ?? null)) $sumLines = $sumLines->add($l['weight_kg']);
                    else $allWeighed = false;
                }
                if (count($body['lines']) > 1 && $allWeighed && !$sumLines->eq($body['weight_kg'])) {
                    throw new AppError('validation', 'جمع وزن ردیف‌ها (' . $sumLines->toFixed(3) . ") با وزن بندیل ({$body['weight_kg']}) برابر نیست", ['weight_kg' => 'ناسازگار']);
                }
                $duplicate = (bool) array_filter($warnings, static fn ($w) => $w['code'] === 'duplicate_code');
                $b = $trx->insert('bundles', [
                    'code' => $code, 'code_is_temp' => !isset($body['code']), 'production_run_id' => $runId, 'location_id' => $locationId, 'factory_party_id' => $factory,
                    'weight_kg' => $body['weight_kg'], 'packaging_kg' => $body['packaging_kg'] ?? null, 'form' => $body['form'], 'color' => $body['color'] ?? null, 'source' => $body['source'],
                    'draft' => $body['draft'], 'status' => $duplicate ? 'pending_review' : 'ok', 'defect' => $duplicate ? 'duplicate_code' : null, 'note' => $body['note'] ?? null,
                    'reported_at' => isset($body['reported_at']) ? Db::dt($body['reported_at']) : Db::now(), 'warnings' => $warnings, 'created_by' => $me->id,
                ]);
                self::insertLines($trx, $b['id'], $body['lines'], $me->id);
                if (!$body['draft']) {
                    Stock::move($trx, [
                        'item_type' => 'bundle', 'item_id' => $b['id'], 'from_location_id' => null, 'to_location_id' => $locationId, 'kg' => $body['weight_kg'],
                        'state_to' => $duplicate ? 'quarantine' : self::formState($body['form']), 'ref_type' => self::refTypeFor($body['source']), 'ref_id' => $b['production_run_id'] ?? $b['id'], 'userId' => $me->id,
                    ]);
                }
                if ($warnings) {
                    Notify::managers($trx, ['kind' => 'bundle_warning', 'title' => "بندیل {$code}: " . implode('؛ ', array_column($warnings, 'message')), 'entity' => 'bundles', 'entityId' => $b['id'], 'groupKey' => "bundle_warn:{$b['id']}"]);
                }
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'bundles', 'entityId' => $b['id'], 'action' => 'create', 'after' => $b]);
                return ['status' => 201, 'body' => self::presentBundle(self::loadBundle($trx, $b['id']))];
            });
            return Response::json($res['body'], $res['status']);
        });

        /** Edit: code/colour/notes always; weight and lines only while draft, afterwards weight via a reasoned count adjustment (technical.approve). */
        $r->patch('/bundles/:id', static function (Request $req) use ($app, $updateSchema) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $body = $updateSchema->parse($req->body());
            return $app->db()->transaction(static function (Db $trx) use ($req, $id, $body, $me) {
                $b = $trx->find('bundles', $id, true);
                if (!$b) throw new AppError('not_found');
                if ($b['version'] !== $body['version']) throw AppError::conflict(self::presentBundle(self::loadBundle($trx, $id)));
                if ($b['status'] === 'consumed' || $b['status'] === 'scrapped') throw new AppError('validation', 'این بندیل مصرف یا ضایعات شده است');
                $patch = [];
                if (isset($body['code']) && $body['code'] !== $b['code']) {
                    $patch['code'] = $body['code'];
                    $patch['code_is_temp'] = false;
                }
                foreach (['color', 'note', 'qc_note', 'packaging_kg'] as $k) if (array_key_exists($k, $body)) $patch[$k] = $body[$k];
                $weightChange = isset($body['weight_kg']) && !Decimal::of($body['weight_kg'])->eq($b['weight_kg']);
                if ($b['draft']) {
                    if (isset($body['weight_kg'])) $patch['weight_kg'] = $body['weight_kg'];
                    if (isset($body['lines'])) {
                        $trx->exec('DELETE FROM bundle_lines WHERE bundle_id = ?', [$id]);
                        self::insertLines($trx, $id, $body['lines'], $me->id);
                    }
                } else {
                    if (isset($body['lines'])) throw new AppError('validation', 'ردیف‌های بندیل قطعی تغییر نمی‌کند؛ از تفکیک/ادغام استفاده کنید');
                    if ($weightChange) {
                        $req->requirePermission('technical.approve');
                        if (!Schema::jsTruthy($body['reason'] ?? null)) throw new AppError('validation', 'تغییر وزن بندیل قطعی دلیل لازم دارد', ['reason' => 'لازم است']);
                        $diff = Decimal::of($body['weight_kg'])->sub($b['weight_kg']);
                        $state = $b['status'] === 'ok' ? self::formState($b['form']) : 'quarantine';
                        Stock::move($trx, $diff->gt(0)
                            ? ['item_type' => 'bundle', 'item_id' => $id, 'from_location_id' => null, 'to_location_id' => $b['location_id'], 'kg' => $diff->toFixed(3), 'state_to' => $state, 'ref_type' => 'count_adjustment', 'ref_id' => $id, 'note' => $body['reason'], 'userId' => $me->id]
                            : ['item_type' => 'bundle', 'item_id' => $id, 'from_location_id' => $b['location_id'], 'to_location_id' => null, 'kg' => $diff->abs()->toFixed(3), 'state_from' => $state, 'ref_type' => 'count_adjustment', 'ref_id' => $id, 'note' => $body['reason'], 'userId' => $me->id]);
                        $patch['weight_kg'] = $body['weight_kg'];
                    }
                }
                $lines = $body['lines'] ?? array_map(
                    static fn ($l) => ['product_id' => $l['product_id'], 'filler_mm' => $l['filler_mm'], 'length_m' => $l['length_m'], 'bars' => $l['bars'], 'weight_kg' => $l['weight_kg'], 'order_line_id' => $l['order_line_id']],
                    $trx->all('SELECT * FROM bundle_lines WHERE bundle_id = ? ORDER BY sort', [$id]),
                );
                $patch['warnings'] = self::bundleWarnings($trx, [
                    'id' => $id, 'code' => $patch['code'] ?? ($b['code_is_temp'] ? null : $b['code']), 'production_run_id' => $b['production_run_id'],
                    'weight_kg' => $patch['weight_kg'] ?? $b['weight_kg'], 'packaging_kg' => $patch['packaging_kg'] ?? $b['packaging_kg'], 'lines' => $lines,
                ]);
                $after = $trx->updateById('bundles', $id, $patch + Db::bump());
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'bundles', 'entityId' => $id, 'action' => 'update', 'before' => $b, 'after' => $after, 'reason' => $body['reason'] ?? null]);
                return self::presentBundle(self::loadBundle($trx, $id));
            });
        });

        /**
         * The `act` helper: permission, id, Idempotency-Key, `{version} & schema`, row lock + version check, work, audit of the
         * status fields, the reloaded bundle.
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
            $res = Idempotency::run($app->db(), $key, $me->id, "POST /bundles/{$name}", static function (Db $trx) use ($id, $body, $me, $name, $work) {
                $b = $trx->find('bundles', $id, true);
                if (!$b) throw new AppError('not_found');
                if ($b['version'] !== $body['version']) throw AppError::conflict(self::presentBundle(self::loadBundle($trx, $id)));
                $work($trx, $b, $me, $body);
                $after = $trx->find('bundles', $id);
                if (!$after) throw new \RuntimeException('no result');
                $pick = static fn (array $x) => ['status' => $x['status'], 'draft' => $x['draft'], 'decision' => $x['decision'], 'location_id' => $x['location_id']];
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'bundles', 'entityId' => $id, 'action' => $name, 'before' => $pick($b), 'after' => $pick($after), 'reason' => $body['reason'] ?? $body['note'] ?? null]);
                return ['status' => 200, 'body' => self::presentBundle(self::loadBundle($trx, $id))];
            });
            return $res['body'];
        };

        /** Draft → definitive: the ledger row is written now. */
        $r->post('/bundles/:id/finalize', static fn (Request $req) => $act($req, 'finalize', null, [], static function (Db $trx, array $b, AuthUser $me) {
            if (!$b['draft']) throw new AppError('validation', 'این بندیل قطعی است');
            Stock::move($trx, [
                'item_type' => 'bundle', 'item_id' => $b['id'], 'from_location_id' => null, 'to_location_id' => $b['location_id'], 'kg' => $b['weight_kg'],
                'state_to' => $b['status'] === 'ok' ? self::formState($b['form']) : 'quarantine', 'ref_type' => self::refTypeFor($b['source']), 'ref_id' => $b['production_run_id'] ?? $b['id'], 'userId' => $me->id,
            ]);
            $trx->update('bundles', ['draft' => false] + Db::bump(), 'id = ?', [$b['id']]);
        }));

        /** Delete a draft (no ledger row exists). */
        $r->delete('/bundles/:id', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $app->db()->transaction(static function (Db $trx) use ($id, $me) {
                $b = $trx->find('bundles', $id, true);
                if (!$b) throw new AppError('not_found');
                if (!$b['draft']) throw new AppError('validation', 'بندیل قطعی حذف نمی‌شود؛ فقط قرنطینه یا ضایعات');
                $trx->exec('DELETE FROM bundle_lines WHERE bundle_id = ?', [$id]);
                $trx->exec('DELETE FROM bundles WHERE id = ?', [$id]);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'bundles', 'entityId' => $id, 'action' => 'delete_draft', 'before' => $b]);
            });
            return ['ok' => true];
        });

        /** Quarantine (T49): status + defect; the kg stays at the location but in state «quarantine», excluded from available stock. */
        $r->post('/bundles/:id/quarantine', static fn (Request $req) => $act($req, 'quarantine', null, [
            'status' => V::enum(self::QUARANTINE), 'defect' => V::optText(200), 'qc_note' => V::optText(2000),
            'measured_filler_mm' => V::decimalString()->nullable()->optional(), 'measured_length_m' => V::decimalString()->nullable()->optional(),
        ], static function (Db $trx, array $b, AuthUser $me, array $body) {
            if ($b['draft']) throw new AppError('validation', 'بندیل پیش‌نویس را اول قطعی کنید');
            if ($b['status'] !== 'ok') throw new AppError('validation', 'این بندیل در قرنطینه است');
            $reserved = $trx->value("SELECT id FROM reservations WHERE bundle_id = ? AND status = 'active' LIMIT 1", [$b['id']]);
            if ($reserved !== null) $trx->update('reservations', ['status' => 'released'] + Db::bump(), "bundle_id = ? AND status = 'active'", [$b['id']]);
            Stock::move($trx, [
                'item_type' => 'bundle', 'item_id' => $b['id'], 'from_location_id' => $b['location_id'], 'to_location_id' => $b['location_id'], 'kg' => $b['weight_kg'],
                'state_from' => self::formState($b['form']), 'state_to' => 'quarantine', 'ref_type' => 'count_adjustment', 'ref_id' => $b['id'], 'note' => "قرنطینه: {$body['status']}", 'userId' => $me->id,
            ]);
            $trx->update('bundles', [
                'status' => $body['status'], 'defect' => $body['defect'] ?? null, 'qc_note' => $body['qc_note'] ?? null, 'measured_filler_mm' => $body['measured_filler_mm'] ?? null,
                'measured_length_m' => $body['measured_length_m'] ?? null, 'reserved_order_line_id' => null, 'decision' => null, 'decision_note' => null,
            ] + Db::bump(), 'id = ?', [$b['id']]);
            Notify::managers($trx, ['kind' => 'bundle_quarantine', 'title' => "بندیل {$b['code']} قرنطینه شد ({$body['status']})؛ تصمیم لازم است", 'entity' => 'bundles', 'entityId' => $b['id'], 'groupKey' => "quarantine:{$b['id']}"]);
        }));

        /** Decision (T50, technical.approve): accept → ok; rework → stays, decision recorded; discount_sale → ok with flag; scrap → bundle consumed, scrap lot created. */
        $r->post('/bundles/:id/decide', static fn (Request $req) => $act($req, 'decide', 'technical.approve', [
            'decision' => V::enum(['accept', 'rework', 'discount_sale', 'scrap']), 'note' => V::optText(2000),
        ], static function (Db $trx, array $b, AuthUser $me, array $body) {
            if (!in_array($b['status'], self::QUARANTINE, true)) throw new AppError('validation', 'این بندیل در قرنطینه نیست');
            $decision = $body['decision'];
            $base = ['decision' => $decision, 'decision_note' => $body['note'] ?? null, 'decided_by' => $me->id, 'decided_at' => Db::now()] + Db::bump();
            if ($decision === 'accept' || $decision === 'discount_sale') {
                Stock::move($trx, [
                    'item_type' => 'bundle', 'item_id' => $b['id'], 'from_location_id' => $b['location_id'], 'to_location_id' => $b['location_id'], 'kg' => $b['weight_kg'],
                    'state_from' => 'quarantine', 'state_to' => self::formState($b['form']), 'ref_type' => 'count_adjustment', 'ref_id' => $b['id'], 'note' => "تصمیم قرنطینه: {$decision}", 'userId' => $me->id,
                ]);
                $trx->update('bundles', ['status' => 'ok'] + $base, 'id = ?', [$b['id']]);
            } elseif ($decision === 'rework') {
                $trx->update('bundles', $base, 'id = ?', [$b['id']]);
            } else {
                $lotId = $trx->insertNoReturn('material_lots', ['kind' => 'scrap', 'owner_party_id' => null, 'description' => "ضایعات از بندیل {$b['code']}", 'created_by' => $me->id]);
                Stock::move($trx, ['item_type' => 'bundle', 'item_id' => $b['id'], 'from_location_id' => $b['location_id'], 'to_location_id' => null, 'kg' => $b['weight_kg'], 'state_from' => 'quarantine', 'state_to' => 'consumed', 'ref_type' => 'scrap_conversion', 'ref_id' => $lotId, 'userId' => $me->id]);
                Stock::move($trx, ['item_type' => 'material_lot', 'item_id' => $lotId, 'from_location_id' => null, 'to_location_id' => $b['location_id'], 'kg' => $b['weight_kg'], 'state_to' => 'scrap', 'ref_type' => 'scrap_conversion', 'ref_id' => $b['id'], 'userId' => $me->id]);
                $trx->update('bundles', ['status' => 'scrapped'] + $base, 'id = ?', [$b['id']]);
            }
        }));

        /** Split one bundle into parts (weights must add up); origin recorded on the parts. */
        $r->post('/bundles/:id/split', static fn (Request $req) => $act($req, 'split', null, [
            'parts' => V::array(V::object([
                'code' => V::string()->trim()->min(1)->max(60)->optional(),
                'weight_kg' => V::decimalString(),
                'bars' => V::int()->min(0)->nullable()->optional(),
            ]))->min(2)->max(20),
        ], static function (Db $trx, array $b, AuthUser $me, array $body) {
            if ($b['draft'] || $b['status'] !== 'ok') throw new AppError('validation', 'فقط بندیل قطعی سالم تفکیک می‌شود');
            $parts = $body['parts'];
            $sum = Decimal::sum(array_column($parts, 'weight_kg'));
            if (!$sum->eq($b['weight_kg'])) throw new AppError('validation', 'جمع وزن قطعات (' . $sum->toFixed(3) . ") باید برابر وزن بندیل ({$b['weight_kg']}) باشد", ['parts' => 'ناسازگار']);
            $have = Stock::itemBalance($trx, 'bundle', $b['id'], $b['location_id']);
            if (Decimal::of($have)->lt($b['weight_kg'])) throw new AppError('insufficient_stock');
            $lines = $trx->all('SELECT * FROM bundle_lines WHERE bundle_id = ?', [$b['id']]);
            if (count($lines) !== 1) throw new AppError('validation', 'بندیل چندمحصولی تفکیک نمی‌شود');
            $line = $lines[0];
            $form = self::formState($b['form']);
            Stock::move($trx, ['item_type' => 'bundle', 'item_id' => $b['id'], 'from_location_id' => $b['location_id'], 'to_location_id' => null, 'kg' => $b['weight_kg'], 'state_from' => $form, 'state_to' => 'consumed', 'ref_type' => 'count_adjustment', 'ref_id' => $b['id'], 'note' => 'تفکیک', 'userId' => $me->id]);
            $i = 1;
            foreach ($parts as $p) {
                $nb = $trx->insertNoReturn('bundles', [
                    'code' => $p['code'] ?? "{$b['code']}-{$i}", 'code_is_temp' => !isset($p['code']) && $b['code_is_temp'], 'production_run_id' => $b['production_run_id'], 'location_id' => $b['location_id'],
                    'factory_party_id' => $b['factory_party_id'], 'weight_kg' => $p['weight_kg'], 'form' => $b['form'], 'color' => $b['color'], 'source' => $b['source'],
                    'origin_bundle_ids' => [$b['id']], 'warnings' => [], 'created_by' => $me->id,
                ]);
                $trx->insertNoReturn('bundle_lines', [
                    'bundle_id' => $nb, 'product_id' => $line['product_id'], 'filler_mm' => $line['filler_mm'], 'length_m' => $line['length_m'], 'bars' => $p['bars'] ?? null,
                    'weight_kg' => $p['weight_kg'], 'order_line_id' => $line['order_line_id'], 'created_by' => $me->id,
                ]);
                Stock::move($trx, ['item_type' => 'bundle', 'item_id' => $nb, 'from_location_id' => null, 'to_location_id' => $b['location_id'], 'kg' => $p['weight_kg'], 'state_to' => $form, 'ref_type' => 'count_adjustment', 'ref_id' => $b['id'], 'note' => "تفکیک از {$b['code']}", 'userId' => $me->id]);
                $i++;
            }
            $trx->update('reservations', ['status' => 'released'] + Db::bump(), "bundle_id = ? AND status = 'active'", [$b['id']]);
            $trx->update('bundles', ['status' => 'consumed', 'reserved_order_line_id' => null] + Db::bump(), 'id = ?', [$b['id']]);
        }));

        /** Attach already-uploaded files (photos from the bot or the web form) to a bundle. */
        $r->post('/bundles/:id/files', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $key = Idempotency::requireKey($req);
            $body = V::object(['file_ids' => V::array(V::uuid())->min(1)->max(20)])->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /bundles/:id/files', static function (Db $trx) use ($id, $body, $me) {
                self::loadBundle($trx, $id);
                foreach ($body['file_ids'] as $fid) {
                    try {
                        $trx->insertNoReturn('file_links', ['file_id' => $fid, 'entity' => 'bundles', 'entity_id' => $id, 'created_by' => $me->id]);
                    } catch (\PDOException $e) {
                        if (!Db::isDuplicateKey($e)) throw $e;
                    }
                    $trx->exec("UPDATE files SET owner_entity = 'bundles', owner_id = ? WHERE id = ? AND owner_id IS NULL", [$id, $fid]);
                }
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'bundles', 'entityId' => $id, 'action' => 'attach_files', 'after' => ['file_ids' => $body['file_ids']]]);
                return ['status' => 200, 'body' => ['ok' => true]];
            });
            return Response::json($res['body'], $res['status']);
        });

        /** Bundle gallery: files linked to bundles of a run (for the share link, T44). */
        $r->get('/bundles/:id/files', static function (Request $req) use ($app) {
            $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            return ['items' => $app->db()->all(
                "SELECT files.id, files.original_name, files.mime, files.size, files.created_at FROM file_links INNER JOIN files ON files.id = file_links.file_id
                 WHERE file_links.entity = 'bundles' AND file_links.entity_id = ? ORDER BY file_links.created_at",
                [$id],
            )];
        });
    }
}
