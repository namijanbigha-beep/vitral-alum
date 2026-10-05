<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\Crud;
use Vitral\Core\Db;
use Vitral\Core\Idempotency;
use Vitral\Core\Query;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\Schema;
use Vitral\Core\V;
use Vitral\Lib\Decimal;
use Vitral\Lib\Num;
use Vitral\Rules\Weights;

/** Port of apps/server/src/modules/products/routes.ts (products, fillers, catalogue). */
final class Products
{
    public const CATEGORIES = ['light_line', 'facade', 'door_window', 'general', 'misc'];

    /** @return array<string,Schema> */
    private static function base(bool $create): array
    {
        return [
            'code' => V::string()->trim()->max(40)->optional(),
            'name_fa' => $create ? V::text(200)->min(1, 'نام لازم است') : V::text(200)->min(1, 'نام لازم است')->optional(),
            'name_ar' => V::optText(200),
            'name_en' => V::optText(200),
            'category' => V::enum(self::CATEGORIES)->nullable()->optional(),
            'alloy' => V::optText(40),
            'section_area_mm2' => V::decimalString()->nullable()->optional(),
            'weight_g_per_m_no_filler' => V::decimalString()->nullable()->optional(),
            'common_lengths' => V::array(V::decimalString())->max(20)->optional(),
            'colors' => V::array(V::text(60))->max(50)->optional(),
            'drawing_version' => V::optText(40),
            'description' => V::optText(2000),
            'main_file_id' => V::uuid()->nullable()->optional(),
        ];
    }

    public static function presentProduct(array $p): array
    {
        return [
            'id' => $p['id'], 'code' => $p['code'], 'name_fa' => $p['name_fa'], 'name_ar' => $p['name_ar'], 'name_en' => $p['name_en'], 'category' => $p['category'], 'alloy' => $p['alloy'],
            'section_area_mm2' => $p['section_area_mm2'], 'weight_g_per_m_no_filler' => $p['weight_g_per_m_no_filler'],
            'suggested_g_per_m' => Weights::suggestedWeightPerMeter($p['section_area_mm2']),
            'common_lengths' => self::lengthsJson($p['common_lengths']), 'colors' => $p['colors'], 'drawing_version' => $p['drawing_version'], 'description' => $p['description'], 'main_file_id' => $p['main_file_id'],
            'active' => $p['active'],
            // undefined in Node when not loaded → key left out of the JSON
        ] + array_filter(['fillers' => $p['fillers'] ?? null, 'stock_kg' => $p['stock_kg'] ?? null, 'producible' => $p['producible'] ?? null], static fn ($v) => $v !== null) + [
            'created_at' => $p['created_at'], 'updated_at' => $p['updated_at'], 'version' => $p['version'],
        ];
    }

    public static function presentFiller(array $f): array
    {
        return [
            'id' => $f['id'], 'product_id' => $f['product_id'], 'filler_mm' => $f['filler_mm'], 'weight_g_per_m' => $f['weight_g_per_m'], 'source' => $f['source'], 'sample_length_m' => $f['sample_length_m'],
            'sample_weight_kg' => $f['sample_weight_kg'], 'status' => $f['status'], 'approved_by' => $f['approved_by'], 'approved_at' => $f['approved_at'], 'note' => $f['note'],
            'actual_avg_g_per_m' => $f['actual_avg_g_per_m'] ?? null, 'sample_count' => $f['sample_count'] ?? 0, 'version' => $f['version'], 'created_at' => $f['created_at'],
        ];
    }

    /**
     * common_lengths is numeric(5,2)[] in PostgreSQL, which node-pg returns as JS numbers ("6.00" → 6, "6.50" → 6.5):
     * stored here as a JSON list of numbers rounded to 2 places, and presented as numbers.
     * @return list<int|float>
     */
    public static function lengthsJson(mixed $lengths): array
    {
        $out = [];
        foreach (is_array($lengths) ? $lengths : [] as $v) {
            if ($v === null) continue;
            $f = (float) Num::round(is_float($v) ? json_encode($v) : (string) $v, 'length');
            $out[] = floor($f) === $f && abs($f) < 1e15 ? (int) $f : $f;
        }
        return $out;
    }

    private static function nextProductCode(Db $trx): string
    {
        $m = $trx->value("SELECT MAX(CASE WHEN BINARY code REGEXP '^P[0-9]+$' THEN CAST(SUBSTRING(code, 2) AS UNSIGNED) ELSE 0 END) AS m FROM products");
        return 'P' . str_pad((string) ((int) ($m ?? 0) + 1), 4, '0', STR_PAD_LEFT);
    }

    /**
     * Fillers with the actual average g/m from bundles of this product+filler (module 1).
     * The average is computed with Decimal (PostgreSQL numeric precision) rather than MySQL's 4-digit division scale.
     * @return list<array<string,mixed>>
     */
    public static function fillersWithActual(Db $db, string $productId): array
    {
        // PostgreSQL sorts NULL last in ascending order
        $fillers = $db->all('SELECT * FROM product_fillers WHERE product_id = ? ORDER BY filler_mm IS NULL, filler_mm, created_at', [$productId]);
        $rows = $db->all(
            "SELECT bundle_lines.filler_mm, COALESCE(bundle_lines.weight_kg, bundles.weight_kg) AS kg, COALESCE(bundles.packaging_kg, 0) AS pack, bundle_lines.bars, bundle_lines.length_m
             FROM bundle_lines INNER JOIN bundles ON bundles.id = bundle_lines.bundle_id
             WHERE bundle_lines.product_id = ? AND bundles.draft = 0 AND bundles.form = 'raw' AND bundle_lines.bars > 0
               AND (SELECT COUNT(*) FROM bundle_lines bl2 WHERE bl2.bundle_id = bundles.id) = 1",
            [$productId],
        );
        /** @var array<string,array{sum:Decimal,vals:int,n:int}> $groups */
        $groups = [];
        foreach ($rows as $r) {
            $key = $r['filler_mm'] === null ? "\0null" : (string) $r['filler_mm'];
            $groups[$key] ??= ['sum' => Decimal::zero(), 'vals' => 0, 'n' => 0];
            $groups[$key]['n']++;
            if ($r['length_m'] === null || $r['kg'] === null) continue;
            $denom = Decimal::of((int) $r['bars'])->mul($r['length_m']);
            if ($denom->isZero()) continue;
            $groups[$key]['sum'] = $groups[$key]['sum']->add(Decimal::of($r['kg'])->sub($r['pack'])->div($denom)->mul(1000));
            $groups[$key]['vals']++;
        }
        return array_map(static function (array $f) use ($groups) {
            $a = $groups[$f['filler_mm'] === null ? "\0null" : (string) $f['filler_mm']] ?? null;
            $avg = $a && $a['vals'] > 0 ? Num::round($a['sum']->div($a['vals']), 'g_per_m') : null;
            return self::presentFiller($f + ['actual_avg_g_per_m' => $avg, 'sample_count' => $a['n'] ?? 0]);
        }, $fillers);
    }

    public static function register(Router $r, App $app): void
    {
        Crud::routes($r, $app, [
            'table' => 'products',
            'path' => '/products',
            'createSchema' => V::object(self::base(true)),
            'updateSchema' => V::object(V::versionField() + self::base(false) + ['active' => V::boolean()->optional()]),
            'listSchema' => V::object([
                'q' => V::string()->max(100)->optional(), 'category' => V::enum(self::CATEGORIES)->optional(), 'active' => V::enum(['true', 'false'])->optional(),
                'color' => V::string()->max(60)->optional(), 'filler' => V::string()->max(10)->optional(), 'in_stock' => V::enum(['true'])->optional(),
            ]),
            'present' => static fn (array $row) => self::presentProduct($row),
            'filter' => static function (Query $qb, array $q) {
                if (($q['q'] ?? '') !== '') {
                    $like = Db::like((string) $q['q']);
                    $qb->where('products.name_fa LIKE ? OR products.code LIKE ? OR products.name_en LIKE ?', [$like, $like, $like]);
                }
                if (!empty($q['category'])) $qb->where('products.category = ?', [(string) $q['category']]);
                if (!empty($q['active'])) $qb->where('products.active = ?', [$q['active'] === 'true']);
                if (($q['color'] ?? '') !== '') $qb->where('JSON_CONTAINS(products.colors, ?)', [json_encode((string) $q['color'], JSON_UNESCAPED_UNICODE)]);
                if (($q['filler'] ?? '') !== '') $qb->where('EXISTS (SELECT 1 FROM product_fillers pf WHERE pf.product_id = products.id AND pf.filler_mm = ?)', [(string) $q['filler']]);
                if (!empty($q['in_stock'])) $qb->where("EXISTS (SELECT 1 FROM bundle_lines bl JOIN bundles b ON b.id = bl.bundle_id WHERE bl.product_id = products.id AND b.status = 'ok' AND b.draft = 0 AND b.reserved_order_line_id IS NULL)");
            },
            'orderBy' => 'code',
            'beforeCreate' => static function (Db $trx, array $input) {
                $code = $input['code'] ?? '';
                if (array_key_exists('common_lengths', $input)) $input['common_lengths'] = self::lengthsJson($input['common_lengths']);
                return ['code' => $code !== '' ? $code : self::nextProductCode($trx)] + $input;
            },
            'beforeUpdate' => static function (Db $trx, array $before, array $patch) {
                if (array_key_exists('common_lengths', $patch)) $patch['common_lengths'] = self::lengthsJson($patch['common_lengths']);
                return $patch;
            },
            'loadOne' => static function (Db $trx, string $id) {
                $p = $trx->find('products', $id);
                if (!$p) return null;
                $fillers = self::fillersWithActual($trx, $id);
                $kg = $trx->value(
                    "SELECT COALESCE(SUM(COALESCE(bundle_lines.weight_kg, bundles.weight_kg)), 0) AS kg FROM bundle_lines INNER JOIN bundles ON bundles.id = bundle_lines.bundle_id
                     WHERE bundle_lines.product_id = ? AND bundles.status = 'ok' AND bundles.draft = 0",
                    [$id],
                );
                $die = $trx->value("SELECT id FROM dies WHERE product_id = ? AND status = 'ready' LIMIT 1", [$id]);
                return ['fillers' => $fillers, 'stock_kg' => Num::round((string) $kg, 'weight'), 'producible' => $die !== null] + $p;
            },
        ]);

        // Catalogue cards: products with fillers, stock and producible flags in one query set (no N+1).
        $r->get('/products/catalog', static function (Request $req) use ($app) {
            $req->requireUser();
            $q = V::object([
                'q' => V::string()->max(100)->optional(),
                'category' => V::enum(self::CATEGORIES)->optional(),
                'limit' => V::coerceNumber()->int()->min(1)->max(100)->default(100),
            ])->parse($req->query);
            $db = $app->db();
            $pq = Query::from('products')->where('active = 1')->orderBy('code')->limit($q['limit']);
            if (($q['q'] ?? '') !== '') $pq->where('name_fa LIKE ? OR code LIKE ?', [Db::like($q['q']), Db::like($q['q'])]);
            if (!empty($q['category'])) $pq->where('category = ?', [$q['category']]);
            $products = $pq->all($db);
            $ids = array_column($products, 'id');
            if (!$ids) return ['items' => []];
            $in = Db::placeholders($ids);
            $fillers = $db->all("SELECT * FROM product_fillers WHERE product_id IN ({$in}) AND status = 'approved' ORDER BY created_at, id", $ids);
            $stock = $db->all(
                "SELECT bundle_lines.product_id, SUM(COALESCE(bundle_lines.weight_kg, bundles.weight_kg)) AS kg FROM bundle_lines INNER JOIN bundles ON bundles.id = bundle_lines.bundle_id
                 WHERE bundle_lines.product_id IN ({$in}) AND bundles.status = 'ok' AND bundles.draft = 0 AND bundles.reserved_order_line_id IS NULL GROUP BY bundle_lines.product_id",
                $ids,
            );
            $stockBy = array_column($stock, 'kg', 'product_id');
            $dies = array_flip($db->column("SELECT product_id FROM dies WHERE product_id IN ({$in}) AND status = 'ready'", $ids));
            return ['items' => array_map(static fn (array $p) => self::presentProduct($p + [
                'fillers' => array_values(array_map([self::class, 'presentFiller'], array_filter($fillers, static fn ($f) => $f['product_id'] === $p['id']))),
                'stock_kg' => Num::round((string) ($stockBy[$p['id']] ?? '0'), 'weight'),
                'producible' => isset($dies[$p['id']]),
            ]), $products)];
        });

        // --- fillers ---
        $fillerCreate = V::object([
            'filler_mm' => V::decimalString()->nullable()->optional(),
            'weight_g_per_m' => V::decimalString()->optional(),
            'source' => V::enum(['drawing', 'sample', 'formula', 'agreed']),
            'sample_length_m' => V::decimalString()->optional(),
            'sample_weight_kg' => V::decimalString()->optional(),
            'note' => V::optText(1000),
        ]);
        $fidParams = V::object(['id' => V::uuid(), 'fid' => V::uuid()]);

        $r->get('/products/:id/fillers', static function (Request $req) use ($app) {
            $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            return ['items' => self::fillersWithActual($app->db(), $id)];
        });

        $r->post('/products/:id/fillers', static function (Request $req) use ($app, $fillerCreate) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $body = $fillerCreate->parse($req->body());
            $product = $app->db()->find('products', $id);
            if (!$product) throw new AppError('not_found');
            $gpm = $body['weight_g_per_m'] ?? null;
            if ($body['source'] === 'sample') {
                if (!isset($body['sample_length_m'], $body['sample_weight_kg'])) throw new AppError('validation', 'طول و وزن نمونه لازم است', ['sample_weight_kg' => 'لازم است']);
                $gpm = Num::round(Decimal::of($body['sample_weight_kg'])->div($body['sample_length_m'])->mul(1000), 'g_per_m');
            } elseif ($body['source'] === 'formula') {
                $gpm = Weights::suggestedWeightPerMeter($product['section_area_mm2']);
                if ($gpm === null) throw new AppError('validation', 'سطح مقطع محصول نامشخص است؛ فرمول R01 قابل اجرا نیست', ['section_area_mm2' => 'نامشخص']);
            }
            if ($gpm === null) throw new AppError('validation', 'وزن هر متر لازم است', ['weight_g_per_m' => 'لازم است']);
            $row = $app->db()->transaction(static function (Db $trx) use ($id, $body, $gpm, $me) {
                $r = $trx->insert('product_fillers', [
                    'product_id' => $id, 'filler_mm' => $body['filler_mm'] ?? null, 'weight_g_per_m' => $gpm, 'source' => $body['source'],
                    'sample_length_m' => $body['sample_length_m'] ?? null, 'sample_weight_kg' => $body['sample_weight_kg'] ?? null, 'note' => $body['note'] ?? null, 'created_by' => $me->id,
                ]);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'product_fillers', 'entityId' => $r['id'], 'action' => 'propose', 'after' => $r]);
                return $r;
            });
            return Response::json(self::presentFiller($row), 201);
        });

        $r->patch('/products/:id/fillers/:fid', static function (Request $req) use ($app, $fidParams) {
            $me = $req->requireUser();
            ['fid' => $fid] = $fidParams->parse($req->params);
            $body = V::object(V::versionField() + [
                'weight_g_per_m' => V::decimalString()->optional(),
                'filler_mm' => V::decimalString()->nullable()->optional(),
                'note' => V::optText(1000),
            ])->parse($req->body());
            return $app->db()->transaction(static function (Db $trx) use ($fid, $body, $me) {
                $before = $trx->find('product_fillers', $fid, true);
                if (!$before) throw new AppError('not_found');
                if ($before['version'] !== $body['version']) throw AppError::conflict(self::presentFiller($before));
                if ($before['status'] === 'approved' && !in_array('technical.approve', $me->permissions, true)) throw new AppError('forbidden', 'وزن تأییدشده فقط با مجوز فنی تغییر می‌کند');
                $patch = $body;
                unset($patch['version'], $patch['reason']);
                $after = $trx->updateById('product_fillers', $fid, $patch + Db::bump());
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'product_fillers', 'entityId' => $fid, 'action' => 'update', 'before' => $before, 'after' => $after, 'reason' => $body['reason'] ?? null]);
                return self::presentFiller($after);
            });
        });

        /** technical.approve: the approved value becomes the reference; a previous approved row for the same filler is demoted. */
        $r->post('/products/:id/fillers/:fid/approve', static function (Request $req) use ($app, $fidParams) {
            $me = $req->requirePermission('technical.approve');
            ['id' => $id, 'fid' => $fid] = $fidParams->parse($req->params);
            $key = Idempotency::requireKey($req);
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST fillers/approve', static function (Db $trx) use ($id, $fid, $me) {
                $f = $trx->one('SELECT * FROM product_fillers WHERE id = ? AND product_id = ? FOR UPDATE', [$fid, $id]);
                if (!$f) throw new AppError('not_found');
                $trx->update(
                    'product_fillers',
                    ['status' => 'proposed', 'note' => Db::raw("CONCAT(COALESCE(note, ''), ' (جایگزین شد)')")] + Db::bump(),
                    "product_id = ? AND status = 'approved' AND id <> ? AND COALESCE(filler_mm, -1) = ?",
                    [$id, $fid, $f['filler_mm'] ?? -1],
                );
                $after = $trx->updateById('product_fillers', $fid, ['status' => 'approved', 'approved_by' => $me->id, 'approved_at' => Db::now()] + Db::bump());
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'product_fillers', 'entityId' => $fid, 'action' => 'approve', 'before' => $f, 'after' => $after]);
                return ['status' => 200, 'body' => self::presentFiller($after)];
            });
            return $res['body'];
        });
    }
}
