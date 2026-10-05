<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\AuthUser;
use Vitral\Core\Db;
use Vitral\Core\Idempotency;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\Schema;
use Vitral\Core\V;
use Vitral\Lib\Costing;
use Vitral\Lib\Decimal;
use Vitral\Lib\Jalali;
use Vitral\Lib\Num;
use Vitral\Lib\Xlsx;

/**
 * Port of apps/server/src/modules/reports/routes.ts: order costing (module 9) and cost confirmation, the dashboard (§15),
 * period profit, the reports table (§15, JSON or .xlsx) and the generic list export.
 */
final class Reports
{
    /** SQL of the open remainder of a posted document (allocations from posted documents). */
    private const REMAINING = "documents.amount - (SELECT COALESCE(SUM(COALESCE(a.amount_in_target_currency, a.amount)),0) FROM allocations a JOIN documents f ON f.id = a.from_document_id WHERE a.to_document_id = documents.id AND f.status = 'posted')";

    private static function rangeQuery(): Schema
    {
        return V::object([
            'from' => V::string()->max(12)->optional(),
            'to' => V::string()->max(12)->optional(),
            'party_id' => V::string()->uuid()->optional(),
            'order_id' => V::string()->uuid()->optional(),
            'product_id' => V::string()->uuid()->optional(),
            'currency' => V::enum(Num::CURRENCIES)->optional(),
            'country' => V::string()->max(80)->optional(),
            'color' => V::string()->max(60)->optional(),
            'xlsx' => V::boolQuery()->optional(),
        ]);
    }

    /** @return array{start:?string,end:?string} MySQL DATETIME literals (UTC) or null */
    private static function range(array $q): array
    {
        $start = !empty($q['from']) ? Jalali::dayRange(Daily::jalaliDateArg(Num::toLatinDigits($q['from'])))['start'] : null;
        $end = !empty($q['to']) ? Jalali::dayRange(Daily::jalaliDateArg(Num::toLatinDigits($q['to'])))['end'] : null;
        // startDay/endDay: Tehran calendar dates ([startDay, endDay)) for DATE columns, as lib/dates.ts tehranDateKey.
        return ['start' => Db::dt($start), 'end' => Db::dt($end), 'startDay' => $start ? self::tehranDateKey(strtotime($start)) : null, 'endDay' => $end ? self::tehranDateKey(strtotime($end)) : null];
    }

    /** Tehran calendar date (Y-m-d) of a Unix time: what a DATE column holds for that business day. */
    public static function tehranDateKey(int $ts): string
    {
        return gmdate('Y-m-d', $ts + Jalali::TEHRAN_OFFSET_SECONDS);
    }

    public static function xlsx(string $name, array $header, array $rows): Response
    {
        return Response::raw(Xlsx::buildXlsx([['name' => $name, 'header' => $header, 'rows' => $rows]]), Xlsx::MIME)
            ->header('content-disposition', Xlsx::attachment("{$name}.xlsx"));
    }

    private static function intOrNull(mixed $v): ?int
    {
        return $v === null ? null : (int) $v;
    }

    /** JS Number(x) truthiness of a numeric string (null/"0"/"0.000" → false). */
    private static function nonZero(mixed $v): bool
    {
        return $v !== null && $v !== '' && !Decimal::of((string) $v)->isZero();
    }

    private static function pct(string $num, string $den): string
    {
        return Num::round(Decimal::of($num)->div($den)->mul(100), 'percent');
    }

    public static function register(Router $r, App $app): void
    {
        // ---- module 9 ----
        $r->get('/orders/:id/costing', static function (Request $req) use ($app) {
            $req->requirePermission('finance.view');
            ['id' => $id] = V::idParam()->parse($req->params);
            $q = V::object(['markup_percent' => V::decimalString()->optional(), 'manual_price_per_kg' => V::decimalString()->optional()])->parse($req->query);
            $db = $app->db();
            if ($db->value('SELECT id FROM orders WHERE id = ?', [$id]) === null) throw new AppError('not_found');
            return Costing::orderCosting($db, $id, $q['markup_percent'] ?? '10', $q['manual_price_per_kg'] ?? null);
        });
        $r->post('/orders/:id/confirm-cost', static function (Request $req) use ($app) {
            $me = $req->requirePermission('finance.view');
            ['id' => $id] = V::idParam()->parse($req->params);
            $key = Idempotency::requireKey($req);
            $body = V::object(['version' => V::int()])->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /orders/confirm-cost', static function (Db $trx) use ($id, $body, $me) {
                $o = $trx->find('orders', $id, true);
                if (!$o) throw new AppError('not_found');
                if ($o['version'] !== $body['version']) throw new AppError('conflict');
                $c = Costing::orderCosting($trx, $id);
                if ($c['cost_incomplete']) {
                    throw new AppError('validation', 'هزینه ناقص است: ' . count($c['incomplete_keys']) . ' جزء بدون مبلغ', ['components' => implode(', ', $c['incomplete_keys'])]);
                }
                $trx->update('orders', ['cost_confirmed_at' => Db::raw('NOW(3)'), 'cost_confirmed_by' => $me->id] + Db::bump(), 'id = ?', [$id]);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'orders', 'entityId' => $id, 'action' => 'confirm_cost', 'after' => ['total_cost' => $c['total_cost']]]);
                return ['status' => 200, 'body' => ['ok' => true, 'total_cost' => $c['total_cost']]];
            });
            return $res['body'];
        });

        // ---- dashboard (§15): decisions first, then numbers ----
        $r->get('/reports/dashboard', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $finance = $req->can('finance.view');
            $db = $app->db();
            $nowTs = microtime(true);
            $weekAgo = Db::dt(new \DateTimeImmutable('@' . sprintf('%.3F', $nowTs - 7 * 86400)));
            $now = Db::dt(new \DateTimeImmutable('@' . sprintf('%.3F', $nowTs)));
            $decisions = [
                'quarantine' => $db->all("SELECT id, code, status, weight_kg, defect FROM bundles WHERE status IN ('damaged', 'wrong_product', 'pending_review') AND draft = 0 LIMIT 50"),
                'incomplete_tickets' => $db->all("SELECT scale_tickets.id, scale_tickets.stage, transfers.number FROM scale_tickets LEFT JOIN transfers ON transfers.id = scale_tickets.transfer_id WHERE scale_tickets.status = 'needs_completion' LIMIT 50"),
                'free_notes' => $finance
                    ? $db->all("SELECT id, `text`, topic, status, created_at FROM free_notes WHERE status IN ('new', 'needs_info') LIMIT 50")
                    : $db->all("SELECT id, `text`, topic, status, created_at FROM free_notes WHERE status IN ('new', 'needs_info') AND created_by = ? LIMIT 50", [$me->id]),
                'reported_money' => $finance ? $db->all("SELECT id, number, kind, amount, currency FROM documents WHERE status = 'reported' LIMIT 50") : [],
                'incomplete_costs' => $finance ? $db->all("SELECT id, number, kind, description, source_type FROM documents WHERE status = 'needs_completion' LIMIT 50") : [],
                'correction_requests' => $finance ? $db->all("SELECT id, entity, entity_id, reason, created_at FROM correction_requests WHERE status = 'open' LIMIT 50") : [],
                'due_orders' => $db->all(
                    "SELECT orders.id, orders.number, orders.due_date, parties.name AS party_name FROM orders INNER JOIN parties ON parties.id = orders.party_id
                      WHERE orders.status_sales = 'approved' AND orders.archived = 0 AND orders.due_date IS NOT NULL AND orders.due_date < ? ORDER BY orders.due_date LIMIT 50",
                    [self::tehranDateKey((int) floor($nowTs + 3 * 86400))],
                ),
                'overdue_tasks' => $db->all(
                    "SELECT tasks.id, tasks.title, tasks.due_at, users.short_name AS assignee FROM tasks LEFT JOIN users ON users.id = tasks.assignee_user_id
                      WHERE tasks.status = 'open' AND tasks.due_at < ?" . ($me->role === 'manager' ? '' : ' AND tasks.assignee_user_id = ?') . ' LIMIT 50',
                    $me->role === 'manager' ? [$now] : [$now, $me->id],
                ),
                'missing_documents' => $db->all("SELECT id, title, entity, entity_id, created_at FROM notifications WHERE kind = 'missing_document' AND read_at IS NULL AND user_id = ? LIMIT 50", [$me->id]),
                'weight_differences' => $db->all(
                    'SELECT transfers.id, transfers.number, SUM(transfer_lines.kg - COALESCE(transfer_lines.received_kg, transfer_lines.kg)) AS diff_kg
                       FROM transfer_lines INNER JOIN transfers ON transfers.id = transfer_lines.transfer_id
                      WHERE transfer_lines.diff_reason IS NOT NULL AND transfers.received_at > ? GROUP BY transfers.id, transfers.number LIMIT 50',
                    [$weekAgo],
                ),
            ];

            // Where is the weight (location × state), with approximate value for finance users.
            $weight = [];
            $lotAvg = [];
            foreach (Stock::positionsDetailed($db) as $p) {
                $w = $weight[$p['location_id']] ?? ['location_id' => $p['location_id'], 'name' => $p['location_name'], 'kind' => $p['location_kind'], 'states' => [], 'total_kg' => '0', 'value' => $finance ? '0' : null];
                $k = $p['state'] ?? 'unknown';
                $w['states'][$k] = Num::round(Decimal::of($w['states'][$k] ?? 0)->add($p['kg']), 'weight');
                $w['total_kg'] = Num::round(Decimal::of($w['total_kg'])->add($p['kg']), 'weight');
                if ($finance && $p['item_type'] === 'material_lot' && !$p['owner_party_id']) {
                    if (!array_key_exists($p['item_id'], $lotAvg)) $lotAvg[$p['item_id']] = Materials::lotAverage($db, $p['item_id'])['avg'];
                    $a = $lotAvg[$p['item_id']];
                    if ($a !== null && $a !== '') $w['value'] = Num::round(Decimal::of($w['value'] ?? 0)->add(Decimal::of($p['kg'])->mul($a)), 'TOMAN');
                }
                $weight[$p['location_id']] = $w;
            }

            $money = null;
            $profit = null;
            if ($finance) {
                $rec = $db->all(
                    'SELECT documents.currency, SUM(' . self::REMAINING . ') AS `open`, SUM(CASE WHEN documents.due_date < NOW(3) THEN ' . self::REMAINING . " ELSE 0 END) AS overdue
                       FROM documents INNER JOIN parties ON parties.id = documents.party_id
                      WHERE documents.kind = 'invoice' AND documents.status = 'posted' GROUP BY documents.currency",
                );
                $pay = $db->all(
                    'SELECT documents.currency, documents.kind, SUM(' . self::REMAINING . ") AS `open` FROM documents
                      WHERE documents.kind IN ('purchase', 'toll_fee', 'expense') AND documents.status = 'posted' AND documents.party_id IS NOT NULL GROUP BY documents.currency, documents.kind",
                );
                $money = [
                    'receivables' => array_map(static fn ($x) => ['currency' => $x['currency'], 'open' => Num::round($x['open'] ?? '0', $x['currency']), 'overdue' => Num::round($x['overdue'] ?? '0', $x['currency'])], $rec),
                    'payables' => array_map(static fn ($x) => ['currency' => $x['currency'], 'kind' => $x['kind'], 'open' => Num::round($x['open'] ?? '0', $x['currency'])], $pay),
                ];
                $q = self::rangeQuery()->parse($req->query);
                $profit = self::periodProfit($db, self::range($q));
            }
            $factories = $db->all(
                "SELECT parties.id, parties.name, COUNT(*) AS runs, SUM(ingot_consumed_kg) AS consumed, SUM(good_kg) AS good, SUM(rejected_kg) AS rejected,
                        SUM(CASE WHEN due_at IS NOT NULL AND closed_at > due_at THEN 1 ELSE 0 END) AS late
                   FROM production_runs INNER JOIN parties ON parties.id = production_runs.factory_party_id
                  WHERE production_runs.status = 'closed' GROUP BY parties.id, parties.name",
            );
            $painters = $db->all(
                'SELECT parties.id, parties.name, coating_runs.color_code, SUM(raw_kg) AS `raw`, SUM(coated_kg) AS coated, COUNT(*) AS items
                   FROM coating_run_items INNER JOIN coating_runs ON coating_runs.id = coating_run_items.run_id INNER JOIN parties ON parties.id = coating_runs.party_id
                  WHERE coating_run_items.coated_kg IS NOT NULL GROUP BY parties.id, parties.name, coating_runs.color_code',
            );
            $disk = Health::diskUsagePercent($app->config->str('FILE_STORAGE_DIR'));
            return [
                'decisions' => $decisions, 'weight' => array_values($weight), 'money' => $money, 'profit' => $profit,
                'scorecards' => [
                    'factories' => array_map(static fn ($f) => array_merge($f, [
                        'runs' => (int) $f['runs'], 'late' => self::intOrNull($f['late']),
                        'yield_percent' => self::nonZero($f['consumed']) ? self::pct($f['good'], $f['consumed']) : null,
                        'reject_percent' => self::nonZero($f['consumed']) ? self::pct($f['rejected'], $f['consumed']) : null,
                    ]), $factories),
                    'painters' => array_map(static fn ($p) => array_merge($p, [
                        'items' => (int) $p['items'],
                        'gain_percent' => self::nonZero($p['raw']) ? Num::round(Decimal::of($p['coated'])->sub($p['raw'])->div($p['raw'])->mul(100), 'percent') : null,
                    ]), $painters),
                ],
                'disk_usage_percent' => $disk, 'disk_warning' => $disk !== null && $disk > 80,
            ];
        });

        // ---- reports table (§15) ----
        $report = static function (string $name, ?string $perm, callable $build) use ($r, $app): void {
            $r->get("/reports/{$name}", static function (Request $req) use ($perm, $build, $app, $name) {
                $me = $perm ? $req->requirePermission($perm) : $req->requireUser();
                $q = self::rangeQuery()->parse($req->query);
                $res = $build($app->db(), $q, $me);
                if (!empty($q['xlsx'])) return self::xlsx($name, $res['header'], $res['rows']);
                $out = ['header' => $res['header'], 'rows' => $res['rows']];
                if (array_key_exists('items', $res)) $out['items'] = $res['items'];
                return $out;
            });
        };

        $report('sales', 'finance.view', static function (Db $db, array $q) {
            $rg = self::range($q);
            $sql = "SELECT documents.id, documents.number, documents.kind, documents.`date`, documents.amount, documents.currency, parties.name AS party, parties.country, orders.number AS order_number
                      FROM documents INNER JOIN parties ON parties.id = documents.party_id LEFT JOIN orders ON orders.id = documents.order_id
                     WHERE documents.kind IN ('invoice', 'sales_return') AND documents.status = 'posted'";
            $p = [];
            if ($rg['start']) { $sql .= ' AND documents.`date` >= ?'; $p[] = $rg['startDay']; }
            if ($rg['end']) { $sql .= ' AND documents.`date` < ?'; $p[] = $rg['endDay']; }
            if (!empty($q['party_id'])) { $sql .= ' AND documents.party_id = ?'; $p[] = $q['party_id']; }
            if (!empty($q['currency'])) { $sql .= ' AND documents.currency = ?'; $p[] = $q['currency']; }
            if (!empty($q['country'])) { $sql .= ' AND parties.country = ?'; $p[] = $q['country']; }
            if (!empty($q['order_id'])) { $sql .= ' AND documents.order_id = ?'; $p[] = $q['order_id']; }
            if (!empty($q['product_id'])) { $sql .= " AND EXISTS (SELECT 1 FROM document_lines dl WHERE dl.document_id = documents.id AND JSON_UNQUOTE(JSON_EXTRACT(dl.meta, '$.product_id')) = ?)"; $p[] = $q['product_id']; }
            $rows = $db->all($sql . ' ORDER BY documents.`date`', $p);
            $totals = [];
            foreach ($rows as $x) {
                $v = $x['kind'] === 'invoice' ? Decimal::of($x['amount'] ?? 0) : Decimal::of($x['amount'] ?? 0)->neg();
                $totals[$x['currency']] = ($totals[$x['currency']] ?? Decimal::zero())->add($v);
            }
            $t = [];
            foreach ($totals as $c => $v) $t[$c] = Num::round($v, (string) $c);
            return [
                'header' => ['شماره', 'نوع', 'تاریخ', 'مشتری', 'کشور', 'سفارش', 'مبلغ', 'ارز'],
                'rows' => array_map(static fn ($x) => [$x['number'], $x['kind'] === 'invoice' ? 'فاکتور' : 'برگشت', $x['date'], $x['party'], $x['country'], $x['order_number'], $x['kind'] === 'invoice' ? $x['amount'] : '-' . ($x['amount'] ?? 'null'), $x['currency']], $rows),
                'items' => ['totals' => $t ?: new \stdClass()],
            ];
        });

        $report('receivables', 'finance.view', static function (Db $db, array $q) {
            $sql = 'SELECT documents.id, documents.number, documents.`date`, documents.due_date, documents.currency, documents.amount, parties.name AS party, parties.id AS party_id, ' . self::REMAINING . " AS remaining
                      FROM documents INNER JOIN parties ON parties.id = documents.party_id WHERE documents.kind = 'invoice' AND documents.status = 'posted'";
            $p = [];
            if (!empty($q['party_id'])) { $sql .= ' AND documents.party_id = ?'; $p[] = $q['party_id']; }
            if (!empty($q['currency'])) { $sql .= ' AND documents.currency = ?'; $p[] = $q['currency']; }
            $rows = array_values(array_filter($db->all($sql . ' ORDER BY parties.name, documents.due_date IS NULL, documents.due_date', $p), static fn ($x) => $x['remaining'] !== null && Decimal::of($x['remaining'])->gt(0)));
            $now = gmdate('Y-m-d\TH:i:s.v\Z');
            return [
                'header' => ['مشتری', 'فاکتور', 'تاریخ', 'سررسید', 'مبلغ', 'مانده', 'ارز', 'گذشته از سررسید'],
                'rows' => array_map(static fn ($x) => [$x['party'], $x['number'], $x['date'], $x['due_date'], $x['amount'], Num::round($x['remaining'], $x['currency']), $x['currency'], $x['due_date'] !== null && $x['due_date'] < $now ? 'بله' : 'خیر'], $rows),
                'items' => array_map(static fn ($x) => array_merge($x, ['remaining' => Num::round($x['remaining'], $x['currency'])]), $rows),
            ];
        });

        $report('payables', 'finance.view', static function (Db $db, array $q) {
            $sql = 'SELECT documents.id, documents.number, documents.kind, documents.`date`, documents.currency, documents.amount, documents.purchase_kind, documents.expense_category, documents.source_type,
                           parties.name AS party, parties.id AS party_id, ' . self::REMAINING . " AS remaining
                      FROM documents INNER JOIN parties ON parties.id = documents.party_id WHERE documents.kind IN ('purchase', 'toll_fee', 'expense') AND documents.status = 'posted'";
            $p = [];
            if (!empty($q['party_id'])) { $sql .= ' AND documents.party_id = ?'; $p[] = $q['party_id']; }
            if (!empty($q['currency'])) { $sql .= ' AND documents.currency = ?'; $p[] = $q['currency']; }
            $rows = array_values(array_filter($db->all($sql . ' ORDER BY parties.name', $p), static fn ($x) => $x['remaining'] !== null && Decimal::of($x['remaining'])->gt(0)));
            $type = static fn ($x) => $x['kind'] === 'toll_fee'
                ? ($x['source_type'] === 'coating_run' ? 'اجرت رنگ' : 'اجرت تولید')
                : ($x['kind'] === 'purchase'
                    ? ($x['purchase_kind'] === 'die' ? 'قالب' : ($x['purchase_kind'] === 'ingot' || $x['purchase_kind'] === 'billet' ? 'شمش' : 'خرید'))
                    : ($x['expense_category'] === 'freight' ? 'حمل' : 'هزینه'));
            return [
                'header' => ['طرف', 'نوع', 'سند', 'تاریخ', 'مبلغ', 'مانده', 'ارز'],
                'rows' => array_map(static fn ($x) => [$x['party'], $type($x), $x['number'], $x['date'], $x['amount'], Num::round($x['remaining'], $x['currency']), $x['currency']], $rows),
                'items' => array_map(static fn ($x) => array_merge($x, ['type' => $type($x), 'remaining' => Num::round($x['remaining'], $x['currency'])]), $rows),
            ];
        });

        $report('order-profit', 'finance.view', static function (Db $db, array $q) {
            $rg = self::range($q);
            $sql = "SELECT orders.id, orders.number, orders.currency, parties.name AS party FROM orders INNER JOIN parties ON parties.id = orders.party_id WHERE orders.status_sales = 'approved'";
            $p = [];
            if ($rg['start']) { $sql .= ' AND orders.order_date >= ?'; $p[] = $rg['startDay']; }
            if ($rg['end']) { $sql .= ' AND orders.order_date < ?'; $p[] = $rg['endDay']; }
            if (!empty($q['party_id'])) { $sql .= ' AND orders.party_id = ?'; $p[] = $q['party_id']; }
            if (!empty($q['order_id'])) { $sql .= ' AND orders.id = ?'; $p[] = $q['order_id']; }
            $items = [];
            foreach ($db->all($sql . ' ORDER BY orders.order_date DESC LIMIT 300', $p) as $o) {
                $c = Costing::orderCosting($db, $o['id']);
                $items[] = ['id' => $o['id'], 'number' => $o['number'], 'party' => $o['party'], 'currency' => $o['currency'], 'sales' => $c['sales'], 'total_cost' => $c['total_cost'], 'cost_incomplete' => $c['cost_incomplete'], 'profit' => $c['profit'], 'raw_kg' => $c['raw_kg'], 'sold_gain_kg' => $c['sold_gain_kg']];
            }
            return [
                'header' => ['سفارش', 'مشتری', 'ارز', 'فروش', 'وضعیت فروش', 'هزینه', 'وضعیت هزینه', 'سود برآوردی', 'سود قطعی', 'سهم پایه', 'سهم اضافه‌وزن', 'وصول خالص'],
                'rows' => array_map(static fn ($i) => [
                    $i['number'], $i['party'], $i['currency'], $i['sales']['status'] === 'final' ? $i['sales']['invoiced'] : $i['sales']['proforma'], $i['sales']['status'] === 'final' ? 'قطعی' : 'برآوردی',
                    $i['total_cost'], $i['cost_incomplete'] ? 'هزینه ناقص' : 'کامل', $i['profit']['estimated']['profit'] ?? null, $i['profit']['realised']['profit'] ?? null,
                    $i['profit']['split']['base_share'] ?? null, $i['profit']['split']['gain_share'] ?? null, $i['profit']['collected']['net'],
                ], $items),
                'items' => $items,
            ];
        });

        $report('coating-gain', 'finance.view', static function (Db $db, array $q) {
            $sql = 'SELECT bundles.id, bundles.code, bundles.status, bundles.color, coating_runs.number AS run, parties.name AS painter, coating_run_items.raw_kg, coating_run_items.coated_kg, coating_run_items.gain_needs_review, coating_run_items.returned_at
                      FROM coating_run_items INNER JOIN coating_runs ON coating_runs.id = coating_run_items.run_id INNER JOIN bundles ON bundles.id = coating_run_items.bundle_id INNER JOIN parties ON parties.id = coating_runs.party_id
                     WHERE coating_run_items.coated_kg IS NOT NULL';
            $p = [];
            if (!empty($q['party_id'])) { $sql .= ' AND coating_runs.party_id = ?'; $p[] = $q['party_id']; }
            if (!empty($q['color'])) { $sql .= ' AND coating_runs.color_code = ?'; $p[] = $q['color']; }
            $rows = $db->all($sql . ' ORDER BY coating_run_items.returned_at IS NULL DESC, coating_run_items.returned_at DESC LIMIT 1000', $p);
            return [
                'header' => ['بندیل', 'رنگ', 'رنگکار', 'نوبت', 'خام', 'پوشش‌شده', 'افزایش', 'درصد', 'نیازمند بررسی', 'وضعیت'],
                'rows' => array_map(static function ($x) {
                    $g = Decimal::of($x['coated_kg'])->sub($x['raw_kg']);
                    return [$x['code'], $x['color'], $x['painter'], $x['run'], $x['raw_kg'], $x['coated_kg'], Num::round($g, 'weight'), Decimal::of($x['raw_kg'])->isZero() ? null : Num::round($g->div($x['raw_kg'])->mul(100), 'percent'), $x['gain_needs_review'] ? 'بله' : '', $x['status'] === 'consumed' ? 'فروخته‌شده' : 'در انبار'];
                }, $rows),
                'items' => $rows,
            ];
        });

        $report('workshops', null, static function (Db $db, array $q, AuthUser $me) {
            $finance = \Vitral\Core\Auth::can($me, 'finance.view');
            $sql = 'SELECT id, name, roles FROM parties WHERE (roles LIKE ? OR roles LIKE ? OR roles LIKE ? OR roles LIKE ?) AND merged_into_id IS NULL';
            $p = ['%"factory"%', '%"painter"%', '%"anodizer"%', '%"smelter"%'];
            if (!empty($q['party_id'])) { $sql .= ' AND id = ?'; $p[] = $q['party_id']; }
            $items = [];
            foreach ($db->all($sql, $p) as $party) {
                $runs = $db->one(
                    "SELECT COUNT(*) AS runs, SUM(ingot_consumed_kg) AS consumed, SUM(good_kg) AS good, SUM(rejected_kg) AS rejected, SUM(CASE WHEN due_at IS NOT NULL AND closed_at > due_at THEN 1 ELSE 0 END) AS late
                       FROM production_runs WHERE factory_party_id = ? AND status = 'closed'",
                    [$party['id']],
                );
                $coat = $db->one(
                    "SELECT SUM(raw_kg) AS `raw`, SUM(coated_kg) AS coated, SUM(CASE WHEN qc = 'rejected' THEN 1 ELSE 0 END) AS rejected
                       FROM coating_run_items INNER JOIN coating_runs ON coating_runs.id = coating_run_items.run_id WHERE coating_runs.party_id = ? AND coated_kg IS NOT NULL",
                    [$party['id']],
                );
                $money = $finance ? array_map(
                    static fn ($m) => ['currency' => $m['currency'], 'kind' => $m['kind'], 'a' => $m['a'] ?? '0'],
                    $db->all("SELECT currency, kind, SUM(amount) AS a FROM documents WHERE party_id = ? AND status = 'posted' GROUP BY currency, kind", [$party['id']]),
                ) : [];
                $fees = $finance ? $db->one("SELECT SUM(amount) AS a, SUM(settlement_basis_kg) AS kg FROM documents WHERE party_id = ? AND kind = 'toll_fee' AND status = 'posted'", [$party['id']]) : null;
                $consumed = $runs['consumed'] ?? '0';
                $items[] = $party + [
                    'runs' => (int) $runs['runs'], 'late' => self::intOrNull($runs['late']),
                    'yield_percent' => self::nonZero($consumed) ? self::pct($runs['good'] ?? '0', $consumed) : null,
                    'reject_percent' => self::nonZero($consumed) ? self::pct($runs['rejected'] ?? '0', $consumed) : null,
                    'coating_gain_percent' => self::nonZero($coat['raw']) ? Num::round(Decimal::of($coat['coated'] ?? '0')->sub($coat['raw'])->div($coat['raw'])->mul(100), 'percent') : null,
                    'coating_rejected' => self::intOrNull($coat['rejected']), 'money' => $money,
                    'actual_cost_per_kg' => $fees && self::nonZero($fees['kg']) ? Num::round(Decimal::of($fees['a'] ?? '0')->div($fees['kg']), 'TOMAN') : null,
                ];
            }
            return [
                'header' => array_merge(['کارگاه', 'نوبت‌ها', 'تأخیر', 'بازده ٪', 'مردودی ٪', 'افزایش وزن ٪', 'مردودی رنگ'], $finance ? ['هزینه واقعی هر کیلو'] : []),
                'rows' => array_map(static fn ($i) => array_merge([$i['name'], $i['runs'], $i['late'], $i['yield_percent'], $i['reject_percent'], $i['coating_gain_percent'], $i['coating_rejected']], $finance ? [$i['actual_cost_per_kg']] : []), $items),
                'items' => $items,
            ];
        });

        $report('inventory', null, static function (Db $db, array $q) {
            $f = [];
            if (!empty($q['party_id'])) $f['party_id'] = $q['party_id'];
            if (!empty($q['product_id'])) $f['product_id'] = $q['product_id'];
            $items = Stock::positionsDetailed($db, $f);
            $str = static fn ($v) => $v === null ? 'undefined' : (is_bool($v) ? ($v ? 'true' : 'false') : (string) $v);
            return [
                'header' => ['محل', 'نوع', 'کد/شرح', 'محصول', 'شکل/وضعیت', 'مالک', 'کیلو'],
                'rows' => array_map(static fn ($p) => [
                    $p['location_name'],
                    $p['item_type'] === 'bundle' ? 'بندیل' : 'مواد',
                    $p['item_type'] === 'bundle' ? $str($p['bundle']['code'] ?? null) : $str($p['lot']['description'] ?? $p['lot']['kind'] ?? null),
                    $p['item_type'] === 'bundle' ? implode('، ', array_map(static fn ($l) => (string) $l['product_name'], $p['bundle']['lines'] ?? [])) : (string) ($p['lot']['alloy'] ?? ''),
                    $p['state'], $p['owner_party_id'] ? 'طرف' : 'ویترال', $p['kg'],
                ], $items),
                'items' => $items,
            ];
        });

        $report('stock-moves', null, static function (Db $db, array $q) {
            $rg = self::range($q);
            $sql = "SELECT stock_moves.at, stock_moves.item_type, stock_moves.kg, stock_moves.state_from, stock_moves.state_to, stock_moves.ref_type, f.name AS from_name, t.name AS to_name, bundles.code
                      FROM stock_moves LEFT JOIN locations f ON f.id = stock_moves.from_location_id LEFT JOIN locations t ON t.id = stock_moves.to_location_id
                      LEFT JOIN bundles ON bundles.id = stock_moves.item_id AND stock_moves.item_type = 'bundle' WHERE 1 = 1";
            $p = [];
            if ($rg['start']) { $sql .= ' AND stock_moves.at >= ?'; $p[] = $rg['start']; }
            if ($rg['end']) { $sql .= ' AND stock_moves.at < ?'; $p[] = $rg['end']; }
            $rows = $db->all($sql . ' ORDER BY stock_moves.at DESC LIMIT 5000', $p);
            return [
                'header' => ['زمان', 'نوع', 'کد', 'از', 'به', 'کیلو', 'حالت قبل', 'حالت بعد', 'مرجع'],
                'rows' => array_map(static fn ($m) => [$m['at'], $m['item_type'], $m['code'], $m['from_name'], $m['to_name'], $m['kg'], $m['state_from'], $m['state_to'], $m['ref_type']], $rows),
            ];
        });

        $report('dies', null, static function (Db $db) {
            $rows = $db->all(
                "SELECT dies.id, dies.code, dies.status, dies.total_produced_kg, dies.run_count, dies.last_run_at, products.code AS product_code, locations.name AS location,
                        (SELECT COUNT(*) FROM die_events e WHERE e.die_id = dies.id AND e.kind = 'repair') AS repairs,
                        (SELECT COUNT(*) FROM die_events e WHERE e.die_id = dies.id AND e.kind = 'filler_check') AS filler_checks
                   FROM dies LEFT JOIN products ON products.id = dies.product_id LEFT JOIN locations ON locations.id = dies.location_id ORDER BY dies.code",
            );
            foreach ($rows as &$d) {
                $d['repairs'] = (int) $d['repairs'];
                $d['filler_checks'] = (int) $d['filler_checks'];
            }
            unset($d);
            return [
                'header' => ['قالب', 'محصول', 'وضعیت', 'محل', 'کیلو تجمعی', 'نوبت‌ها', 'آخرین تولید', 'تعمیرها', 'چک فیلر'],
                'rows' => array_map(static fn ($d) => [$d['code'], $d['product_code'], $d['status'], $d['location'], $d['total_produced_kg'], $d['run_count'], $d['last_run_at'], $d['repairs'], $d['filler_checks']], $rows),
                'items' => $rows,
            ];
        });

        $report('materials', 'finance.view', static function (Db $db, array $q) {
            $rg = self::range($q);
            $sql = "SELECT material_lots.kind, stock_moves.ref_type, COALESCE(SUM(kg),0) AS kg, SUM(kg * unit_cost) AS value
                      FROM stock_moves INNER JOIN material_lots ON material_lots.id = stock_moves.item_id WHERE stock_moves.item_type = 'material_lot'";
            $p = [];
            if ($rg['start']) { $sql .= ' AND stock_moves.at >= ?'; $p[] = $rg['start']; }
            if ($rg['end']) { $sql .= ' AND stock_moves.at < ?'; $p[] = $rg['end']; }
            $rows = $db->all($sql . ' GROUP BY material_lots.kind, stock_moves.ref_type', $p);
            return ['header' => ['ماده', 'نوع گردش', 'کیلو', 'ارزش'], 'rows' => array_map(static fn ($x) => [$x['kind'], $x['ref_type'], $x['kg'], $x['value']], $rows), 'items' => $rows];
        });

        $report('expenses', 'finance.view', static function (Db $db, array $q) {
            $rg = self::range($q);
            $sql = "SELECT documents.number, documents.`date`, documents.expense_type, documents.expense_category, documents.amount, documents.currency, documents.status, parties.name AS party, orders.number AS order_number, documents.description
                      FROM documents LEFT JOIN parties ON parties.id = documents.party_id LEFT JOIN orders ON orders.id = documents.order_id
                     WHERE documents.kind = 'expense' AND documents.status <> 'void'";
            $p = [];
            if ($rg['start']) { $sql .= ' AND documents.`date` >= ?'; $p[] = $rg['startDay']; }
            if ($rg['end']) { $sql .= ' AND documents.`date` < ?'; $p[] = $rg['endDay']; }
            if (!empty($q['order_id'])) {
                $sql .= ' AND (documents.order_id = ? OR EXISTS (SELECT 1 FROM expense_shares es WHERE es.document_id = documents.id AND es.order_id = ?))';
                array_push($p, $q['order_id'], $q['order_id']);
            }
            $rows = $db->all($sql . ' ORDER BY documents.`date` DESC', $p);
            return [
                'header' => ['شماره', 'تاریخ', 'نوع', 'دسته', 'طرف', 'سفارش', 'شرح', 'مبلغ', 'ارز', 'وضعیت'],
                'rows' => array_map(static fn ($x) => [$x['number'], $x['date'], $x['expense_type'], $x['expense_category'], $x['party'], $x['order_number'], $x['description'], $x['amount'], $x['currency'], $x['status']], $rows),
                'items' => $rows,
            ];
        });

        // Generic list export: any permitted list endpoint's rows to xlsx (web passes the columns it shows).
        $r->post('/export/xlsx', static function (Request $req) {
            $req->requireUser();
            $body = V::object([
                'name' => V::string()->max(60)->default('export'),
                'header' => V::array(V::string()->max(100))->max(50),
                'rows' => V::array(V::array(V::union([V::string(), V::number(), V::null()])->nullable())->max(50))->max(5000),
            ])->parse($req->body());
            return self::xlsx((string) preg_replace('/[^A-Za-z0-9_\x{0600}-\x{06FF}-]+/u', '_', $body['name']), $body['header'], $body['rows']);
        });
    }

    /** Period profit: realised per order (complete costs only), ingot/scrap trading, general expenses. Per currency; never summed across currencies. */
    private static function periodProfit(Db $db, array $rg): array
    {
        $sql = "SELECT id, number, currency FROM orders WHERE status_sales = 'approved'";
        $p = [];
        if ($rg['start']) { $sql .= ' AND order_date >= ?'; $p[] = $rg['startDay']; }
        if ($rg['end']) { $sql .= ' AND order_date < ?'; $p[] = $rg['endDay']; }
        $orders = $db->all($sql . ' LIMIT 500', $p);
        $per = [];
        $incomplete = [];
        foreach ($orders as $o) {
            $c = Costing::orderCosting($db, $o['id']);
            $acc = $per[$o['currency']] ?? ['estimated' => Decimal::zero(), 'realised' => Decimal::zero(), 'collected' => Decimal::zero(), 'gain_share' => Decimal::zero()];
            if ($c['profit']['estimated']) $acc['estimated'] = $acc['estimated']->add($c['profit']['estimated']['profit']);
            if ($c['profit']['realised']) {
                $acc['realised'] = $acc['realised']->add($c['profit']['realised']['profit']);
                if ($c['profit']['split']) $acc['gain_share'] = $acc['gain_share']->add($c['profit']['split']['gain_share']);
            } elseif ($c['sales']['status'] === 'final') {
                $incomplete[] = ['id' => $o['id'], 'number' => $o['number'], 'keys' => $c['incomplete_keys']];
            }
            $acc['collected'] = $acc['collected']->add($c['profit']['collected']['net']);
            $per[$o['currency']] = $acc;
        }
        $gsql = "SELECT currency, COALESCE(SUM(amount),0) AS a FROM documents WHERE kind = 'expense' AND expense_type = 'general' AND status = 'posted'";
        $gp = [];
        if ($rg['start']) { $gsql .= ' AND `date` >= ?'; $gp[] = $rg['startDay']; }
        if ($rg['end']) { $gsql .= ' AND `date` < ?'; $gp[] = $rg['endDay']; }
        $general = [];
        foreach ($db->all($gsql . ' GROUP BY currency', $gp) as $g) $general[$g['currency']] ??= $g['a'];
        $ssql = "SELECT id, currency, amount, material_lot_id, agreed_kg FROM documents WHERE kind = 'invoice' AND status = 'posted' AND material_lot_id IS NOT NULL";
        $sp = [];
        if ($rg['start']) { $ssql .= ' AND `date` >= ?'; $sp[] = $rg['startDay']; }
        if ($rg['end']) { $ssql .= ' AND `date` < ?'; $sp[] = $rg['endDay']; }
        $trading = [];
        foreach ($db->all($ssql, $sp) as $s) {
            $v = $db->value("SELECT SUM(kg * unit_cost) FROM stock_moves WHERE ref_type = 'sale_dispatch' AND ref_id = ?", [$s['id']]);
            if ($v !== null && $s['amount'] !== null && $s['amount'] !== '') $trading[$s['currency']] = ($trading[$s['currency']] ?? Decimal::zero())->add(Decimal::of($s['amount'])->sub((string) $v));
        }
        $by = [];
        foreach ($per as $cur => $v) {
            $cur = (string) $cur;
            $g = $general[$cur] ?? 0;
            $by[] = [
                'currency' => $cur, 'estimated' => Num::round($v['estimated'], $cur), 'realised' => Num::round($v['realised'], $cur), 'collected' => Num::round($v['collected'], $cur),
                'coating_gain_share' => Num::round($v['gain_share'], $cur), 'trading' => isset($trading[$cur]) ? Num::round($trading[$cur], $cur) : '0',
                'general_expenses' => Num::round($g, $cur), 'total' => Num::round($v['realised']->add($trading[$cur] ?? 0)->sub($g), $cur),
            ];
        }
        return ['by_currency' => $by, 'incomplete_orders' => $incomplete, 'note' => 'جمع ارزها فقط با نرخ و تاریخ نرخ معتبر است؛ این گزارش ارزها را جمع نمی‌زند.'];
    }
}
