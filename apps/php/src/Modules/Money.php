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
use Vitral\Core\Pagination;
use Vitral\Core\Query;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\Schema;
use Vitral\Core\Undef;
use Vitral\Core\V;
use Vitral\Lib\Decimal;
use Vitral\Lib\Num;
use Vitral\Lib\OrdersService;
use Vitral\Rules\Money as R;

/** Port of apps/server/src/modules/money/routes.ts: accounts, fx rates, documents, allocations, expense shares, party statement. */
final class Money
{
    public const KINDS = ['invoice', 'sales_return', 'purchase', 'toll_fee', 'expense', 'receipt', 'payment', 'barter', 'opening_balance', 'fx_difference'];
    public const STATUSES = ['draft', 'reported', 'posted', 'void', 'needs_completion'];
    public const METHODS = ['cash', 'card', 'bank_transfer', 'exchange_house', 'cheque', 'other'];
    /** Kinds whose amount is a cost (confidential for users without finance.view). */
    public const COST_KINDS = ['purchase', 'toll_fee', 'expense'];

    private const PRESENT_KEYS = [
        'id', 'number', 'kind', 'status', 'party_id', 'party_name', 'order_id', 'order_number', 'date', 'due_date', 'amount', 'currency', 'method', 'account_id', 'account_name', 'tracking_no',
        'description', 'note', 'file_ids', 'posted_by', 'posted_at', 'reported_by', 'locked', 'print_count', 'expense_type', 'expense_category', 'purchase_kind', 'material_lot_id',
        'agreed_kg', 'received_kg', 'unit_price', 'settlement_basis_kg', 'barter_sign', 'barter_kg', 'source_type', 'source_id', 'transfer_id', 'reverses_document_id', 'reversed_by_document_id',
        'lines', 'allocations_out', 'allocations_in', 'allocated', 'remaining', 'shares', 'version', 'created_at', 'updated_at',
    ];

    private const ALLOC_IN_SQL = "(SELECT COALESCE(SUM(COALESCE(a.amount_in_target_currency, a.amount)),0) FROM allocations a JOIN documents f ON f.id = a.from_document_id WHERE a.to_document_id = documents.id AND f.status = 'posted')";
    private const ALLOC_OUT_SQL = '(SELECT COALESCE(SUM(a.amount),0) FROM allocations a WHERE a.from_document_id = documents.id)';

    private static function truthy(mixed $v): bool
    {
        return !($v === null || $v === false || $v === '' || $v === 0);
    }

    private static function isCost(string $kind): bool
    {
        return in_array($kind, self::COST_KINDS, true);
    }

    /**
     * The public view of a document. Keys missing from $r are left out (Node's `undefined` is dropped by JSON).
     * @return array<string,mixed>
     */
    public static function presentDocument(array $r, ?AuthUser $user = null): array
    {
        $out = [];
        foreach (self::PRESENT_KEYS as $k) if (array_key_exists($k, $r)) $out[$k] = $r[$k];
        if ($user && !Auth::can($user, 'finance.view') && self::isCost((string) $r['kind'])) {
            unset($out['amount'], $out['unit_price'], $out['remaining'], $out['allocated'], $out['allocations_in'], $out['shares']);
        }
        return $out;
    }

    /** The document with its lines, allocations (out and in), expense shares and allocated / remaining amounts; null when missing. */
    public static function loadDocument(Db $db, string $id): ?array
    {
        $d = $db->one(
            'SELECT documents.*, parties.name AS party_name, orders.number AS order_number, accounts.name AS account_name FROM documents
             LEFT JOIN parties ON parties.id = documents.party_id LEFT JOIN orders ON orders.id = documents.order_id LEFT JOIN accounts ON accounts.id = documents.account_id
             WHERE documents.id = ?',
            [$id],
        );
        if (!$d) return null;
        $lines = $db->all('SELECT * FROM document_lines WHERE document_id = ? ORDER BY sort', [$id]);
        $out = $db->all(
            'SELECT allocations.*, t.number AS to_number, t.kind AS to_kind, o.number AS order_number FROM allocations
             LEFT JOIN documents t ON t.id = allocations.to_document_id LEFT JOIN orders o ON o.id = allocations.order_id
             WHERE from_document_id = ? ORDER BY allocations.created_at',
            [$id],
        );
        $inn = $db->all(
            'SELECT allocations.*, f.number AS from_number, f.kind AS from_kind, f.status AS from_status FROM allocations
             INNER JOIN documents f ON f.id = allocations.from_document_id WHERE to_document_id = ? ORDER BY allocations.created_at',
            [$id],
        );
        $shares = $d['kind'] === 'expense'
            ? $db->all('SELECT expense_shares.*, orders.number AS order_number FROM expense_shares INNER JOIN orders ON orders.id = expense_shares.order_id WHERE document_id = ? ORDER BY expense_shares.created_at', [$id])
            : null;
        $cur = $d['currency'];
        $allocatedOut = Decimal::zero();
        foreach ($out as $x) $allocatedOut = $allocatedOut->add($x['amount']);
        $allocatedIn = Decimal::zero();
        foreach ($inn as $x) if ($x['from_status'] === 'posted') $allocatedIn = $allocatedIn->add($x['amount_in_target_currency'] ?? $x['amount']);
        $settles = $d['kind'] === 'receipt' || $d['kind'] === 'payment';
        $allocated = $settles ? $allocatedOut : $allocatedIn;
        $res = $d + [
            'lines' => $lines, 'allocations_out' => $out, 'allocations_in' => $inn,
            'allocated' => Num::round($allocated, $cur),
            'remaining' => $d['amount'] === null ? null : Num::round(Decimal::of($d['amount'])->sub($allocated), $cur),
        ];
        if ($shares !== null) $res['shares'] = $shares;
        return $res;
    }

    /** A DATE / DATETIME bound for `date` comparisons: 'YYYY-MM-DD' kept, anything else as a UTC DATETIME literal. */
    private static function dateParam(\DateTimeInterface|string $v): string
    {
        if (is_string($v) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $v)) return $v;
        return (string) Db::dt($v);
    }

    /** JS Date → pg `date` column (UTC calendar day). */
    private static function toDate(\DateTimeInterface|string $v): string
    {
        if (is_string($v) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $v)) return $v;
        return substr((string) Db::dt($v), 0, 10);
    }

    /** @return array{kind:string,amount:string,currency:string,status:string} */
    private static function signed(array $d): array
    {
        $signedKinds = in_array($d['kind'], ['barter', 'fx_difference', 'opening_balance'], true);
        return [
            'kind' => $d['kind'],
            'amount' => $signedKinds ? Decimal::of($d['amount'] ?? 0)->mul($d['barter_sign'] ?? 1)->toFixed() : (string) ($d['amount'] ?? '0'),
            'currency' => $d['currency'],
            'status' => $d['status'],
        ];
    }

    /**
     * Party statement: posted documents in order with a running balance per currency (R12 sign convention).
     * $from inclusive, $to exclusive ('YYYY-MM-DD', ISO string or DateTime). Currency maps are plain arrays.
     * @return array{opening:array<string,string>,rows:list<array<string,mixed>>,closing:array<string,string>}
     */
    public static function partyStatement(Db $db, string $partyId, \DateTimeInterface|string|null $from = null, \DateTimeInterface|string|null $to = null): array
    {
        $sql = "SELECT * FROM documents WHERE party_id = ? AND status = 'posted'";
        $params = [$partyId];
        if ($from !== null) { $sql .= ' AND `date` >= ?'; $params[] = self::dateParam($from); }
        if ($to !== null) { $sql .= ' AND `date` < ?'; $params[] = self::dateParam($to); }
        $docs = $db->all($sql . ' ORDER BY `date`, created_at', $params);
        $opening = [];
        if ($from !== null) {
            $prev = $db->all("SELECT kind, amount, currency, status, barter_sign FROM documents WHERE party_id = ? AND status = 'posted' AND `date` < ?", [$partyId, self::dateParam($from)]);
            $opening = R::partyBalance(array_map([self::class, 'signed'], $prev));
        }
        $running = [];
        foreach ($opening as $c => $v) $running[$c] = Decimal::of($v);
        $rows = [];
        foreach ($docs as $d) {
            $c = $d['currency'];
            $delta = Decimal::of(R::partyBalance([self::signed($d)])[$c] ?? '0');
            $running[$c] = ($running[$c] ?? Decimal::zero())->add($delta);
            $rows[] = [
                'id' => $d['id'], 'number' => $d['number'], 'kind' => $d['kind'], 'date' => $d['date'], 'description' => $d['description'], 'currency' => $c,
                'debit' => $delta->gt(0) ? Num::round($delta, $c) : null,
                'credit' => $delta->lt(0) ? Num::round($delta->abs(), $c) : null,
                'balance' => Num::round($running[$c], $c),
            ];
        }
        $closing = [];
        foreach ($running as $c => $v) $closing[$c] = Num::round($v, (string) $c);
        return ['opening' => $opening, 'rows' => $rows, 'closing' => $closing];
    }

    /**
     * Insert one allocation, refusing over-allocation of the source document like the PostgreSQL trigger does
     * (the MySQL trigger is optional on shared hosts, so the check is repeated here under a row lock).
     * @param array<string,mixed> $row allocations values (from_document_id, amount, currency, …)
     * @throws AppError over_allocation
     */
    public static function insertAllocation(Db $trx, array $row): void
    {
        $docAmount = $trx->value('SELECT amount FROM documents WHERE id = ? FOR UPDATE', [$row['from_document_id']]);
        $existing = $trx->value('SELECT COALESCE(SUM(amount),0) FROM allocations WHERE from_document_id = ?', [$row['from_document_id']]);
        if ($docAmount === null || Decimal::of((string) $existing)->add($row['amount'])->gt((string) $docAmount)) throw new AppError('over_allocation');
        try {
            $trx->insertNoReturn('allocations', $row);
        } catch (\PDOException $e) {
            if (str_contains($e->getMessage(), 'over_allocation')) throw new AppError('over_allocation');
            throw $e;
        }
    }

    /** Expense shares (R16): manual amounts or split by order weight (sum of order lines kg). */
    private static function writeShares(Db $trx, array $d, array $orderIds, ?array $manual, string $userId): void
    {
        $trx->exec('DELETE FROM expense_shares WHERE document_id = ?', [$d['id']]);
        if ($d['expense_type'] === 'order' && self::truthy($d['order_id'])) {
            $trx->insertNoReturn('expense_shares', ['document_id' => $d['id'], 'order_id' => $d['order_id'], 'amount' => $d['amount'], 'currency' => $d['currency'], 'created_by' => $userId]);
            return;
        }
        if ($d['expense_type'] !== 'shared') return;
        if ($manual) {
            $sum = Decimal::zero();
            foreach ($manual as $m) $sum = $sum->add($m['amount']);
            if (!$sum->eq($d['amount'])) throw new AppError('validation', "جمع سهم‌ها ({$sum}) با مبلغ هزینه ({$d['amount']}) برابر نیست", ['shares' => 'ناسازگار']);
            foreach ($manual as $m) {
                $trx->insertNoReturn('expense_shares', ['document_id' => $d['id'], 'order_id' => $m['order_id'], 'amount' => $m['amount'], 'currency' => $d['currency'], 'manual' => true, 'created_by' => $userId]);
            }
            return;
        }
        if (!$orderIds) throw new AppError('validation', 'هزینه مشترک سفارش‌ها یا سهم دستی لازم دارد', ['order_ids' => 'لازم است']);
        $weights = $trx->all('SELECT order_id, COALESCE(SUM(qty_kg),0) AS kg FROM order_lines WHERE order_id IN (' . Db::placeholders($orderIds) . ') GROUP BY order_id', array_values($orderIds));
        $byOrder = [];
        foreach ($weights as $w) $byOrder[$w['order_id']] = (string) $w['kg'];
        $ordered = array_map(static fn ($id) => ['id' => $id, 'kg' => $byOrder[$id] ?? '0'], array_values($orderIds));
        try {
            $shares = R::splitByWeight($d['amount'], array_map(static fn ($o) => $o['kg'], $ordered), $d['currency']);
        } catch (\Throwable) {
            throw new AppError('validation', 'وزن سفارش‌ها صفر است؛ سهم‌ها را دستی بدهید', ['shares' => 'لازم است']);
        }
        foreach ($ordered as $i => $o) {
            $trx->insertNoReturn('expense_shares', ['document_id' => $d['id'], 'order_id' => $o['id'], 'amount' => $shares[$i], 'currency' => $d['currency'], 'weight_kg' => $o['kg'], 'created_by' => $userId]);
        }
    }

    /** Allocate a receipt/payment to invoices/orders/purchases (R24 across currencies with an agreed rate). */
    private static function allocate(Db $trx, array $d, array $items, AuthUser $me): void
    {
        if ($d['kind'] !== 'receipt' && $d['kind'] !== 'payment') throw new AppError('validation', 'فقط دریافت/پرداخت تخصیص می‌گیرد');
        foreach ($items as $it) {
            $to = $it['to_document_id'] ?? null;
            $orderId = $it['order_id'] ?? null;
            if (!self::truthy($to) === !self::truthy($orderId)) throw new AppError('validation', 'هر تخصیص یا به سند است یا به سفارش', ['allocations' => 'نامعتبر']);
            $targetCurrency = $d['currency'];
            $targetAmount = null;
            $fxId = null;
            if (self::truthy($to)) {
                $t = $trx->find('documents', $to);
                if (!$t || $t['status'] !== 'posted') throw new AppError('validation', 'سند مقصد باید قطعی باشد', ['to_document_id' => 'نامعتبر']);
                if ($d['kind'] === 'receipt' && $t['kind'] !== 'invoice') throw new AppError('validation', 'دریافت فقط به فاکتور تخصیص می‌یابد');
                if ($d['kind'] === 'payment' && !self::isCost($t['kind'])) throw new AppError('validation', 'پرداخت فقط به خرید/اجرت/هزینه تخصیص می‌یابد');
                if ($t['party_id'] !== $d['party_id']) throw new AppError('validation', 'طرف حساب سند مقصد با این سند یکی نیست');
                $targetCurrency = $t['currency'];
            } else {
                $o = $trx->one('SELECT currency, party_id FROM orders WHERE id = ?', [$orderId]);
                if (!$o) throw new AppError('validation', 'سفارش یافت نشد', ['order_id' => 'نامعتبر']);
                if ($o['party_id'] !== $d['party_id']) throw new AppError('validation', 'سفارش متعلق به این طرف نیست');
                $targetCurrency = $o['currency'];
            }
            if ($targetCurrency !== $d['currency']) {
                if (!self::truthy($it['rate'] ?? null) || !self::truthy($it['rate_from'] ?? null) || !self::truthy($it['rate_to'] ?? null)) {
                    throw new AppError('validation', 'تسویه بین دو ارز نرخ توافقی لازم دارد', ['rate' => 'لازم است']);
                }
                $targetAmount = R::crossCurrencySettlement($it['amount'], $d['currency'], $targetCurrency, $it['rate'], $it['rate_from'], $it['rate_to']);
                $fxId = $trx->insertNoReturn('fx_rates', ['from_currency' => $it['rate_from'], 'to_currency' => $it['rate_to'], 'rate' => $it['rate'], 'kind' => 'agreed_settlement', 'source_text' => "تسویه {$d['number']}", 'created_by' => $me->id]);
            }
            self::insertAllocation($trx, [
                'from_document_id' => $d['id'], 'to_document_id' => $to, 'order_id' => $orderId, 'amount' => $it['amount'], 'currency' => $d['currency'],
                'amount_in_target_currency' => $targetAmount, 'target_currency' => $targetAmount !== null ? $targetCurrency : null, 'fx_rate_id' => $fxId, 'created_by' => $me->id,
            ]);
        }
    }

    private static function docLineSchema(): Schema
    {
        return V::object([
            'description' => V::text(300)->min(1), 'qty' => V::decimalString()->nullable()->optional(), 'unit' => V::optText(20), 'unit_price' => V::decimalString()->nullable()->optional(),
            'amount' => V::decimalString()->optional(), 'vat_rate' => V::decimalString()->nullable()->optional(), 'order_line_id' => V::uuid()->nullable()->optional(),
            'meta' => V::record(V::unknown())->nullable()->optional(),
        ]);
    }

    private static function allocItemSchema(): Schema
    {
        return V::object([
            'to_document_id' => V::uuid()->optional(), 'order_id' => V::uuid()->optional(), 'amount' => V::decimalString(), 'rate' => V::decimalString()->optional(),
            'rate_from' => V::enum(Num::CURRENCIES)->optional(), 'rate_to' => V::enum(Num::CURRENCIES)->optional(),
        ]);
    }

    /** VAT-inclusive total of document lines: Σ amount + amount × vat ÷ 100. */
    private static function vatAmount(mixed $amount, mixed $vatRate): Decimal
    {
        return self::truthy($vatRate) && self::truthy($amount) ? Decimal::of($amount)->mul($vatRate)->div(100) : Decimal::zero();
    }

    public static function register(Router $r, App $app): void
    {
        $db = static fn (): Db => $app->db();

        Crud::routes($r, $app, [
            'table' => 'accounts', 'path' => '/accounts', 'writePermission' => 'finance.post', 'readPermission' => 'finance.view',
            'createSchema' => V::object(['name' => V::text(120)->min(1), 'kind' => V::enum(['bank', 'cash']), 'currency' => V::enum(Num::CURRENCIES)->default('TOMAN')]),
            'updateSchema' => V::object(V::versionField() + ['name' => V::text(120)->min(1)->optional(), 'active' => V::boolean()->optional()]),
            'present' => static fn (array $r) => ['id' => $r['id'], 'name' => $r['name'], 'kind' => $r['kind'], 'currency' => $r['currency'], 'active' => $r['active'], 'version' => $r['version']],
            'orderBy' => 'name',
        ]);

        Crud::routes($r, $app, [
            'table' => 'fx_rates', 'path' => '/fx-rates', 'writePermission' => 'finance.post',
            'createSchema' => V::object([
                'from_currency' => V::enum(Num::CURRENCIES), 'to_currency' => V::enum(Num::CURRENCIES), 'rate' => V::decimalString(),
                'kind' => V::enum(['agreed_settlement', 'report_daily'])->default('report_daily'), 'at' => V::isoDate()->optional(), 'source_text' => V::optText(200),
            ])->refine(static fn ($x) => $x['from_currency'] !== $x['to_currency'], 'دو ارز باید متفاوت باشند'),
            'updateSchema' => V::object(V::versionField()),
            'listSchema' => V::object([
                'from_currency' => V::enum(Num::CURRENCIES)->optional(), 'to_currency' => V::enum(Num::CURRENCIES)->optional(), 'kind' => V::enum(['agreed_settlement', 'report_daily'])->optional(),
            ]),
            'present' => static fn (array $r) => ['id' => $r['id'], 'from_currency' => $r['from_currency'], 'to_currency' => $r['to_currency'], 'rate' => $r['rate'], 'kind' => $r['kind'], 'at' => $r['at'], 'source_text' => $r['source_text']],
            'filter' => static function (Query $qb, array $q): void {
                foreach (['from_currency', 'to_currency', 'kind'] as $k) if (self::truthy($q[$k] ?? null)) $qb->where(Db::ident("fx_rates.{$k}") . ' = ?', [(string) $q[$k]]);
            },
            'beforeCreate' => static fn (Db $t, array $i) => array_merge($i, ['at' => isset($i['at']) ? Db::dt((string) $i['at']) : Db::now()]),
            'orderBy' => 'at',
        ]);

        // Latest daily rate for a pair (reports only; settlements use the agreed rate stored on the allocation).
        $r->get('/fx-rates/latest', static function (Request $req) use ($db) {
            $req->requireUser();
            $q = V::object(['from_currency' => V::enum(Num::CURRENCIES), 'to_currency' => V::enum(Num::CURRENCIES)])->parse($req->query);
            return $db()->one("SELECT * FROM fx_rates WHERE from_currency = ? AND to_currency = ? AND kind = 'report_daily' ORDER BY at DESC LIMIT 1", [$q['from_currency'], $q['to_currency']]);
        });

        $r->get('/documents', static function (Request $req) use ($db) {
            $me = $req->requireUser();
            $q = V::listQuery()->extend([
                'kind' => V::enum(self::KINDS)->optional(), 'status' => V::enum(self::STATUSES)->optional(), 'party_id' => V::uuid()->optional(), 'order_id' => V::uuid()->optional(),
                'q' => V::string()->max(60)->optional(), 'from' => V::isoDate()->optional(), 'to' => V::isoDate()->optional(), 'open' => V::boolQuery()->optional(), 'pending' => V::boolQuery()->optional(),
            ])->parse($req->query);
            $where = [];
            $params = [];
            if (!Auth::can($me, 'finance.view')) { $where[] = 'documents.kind NOT IN (' . Db::placeholders(self::COST_KINDS) . ')'; array_push($params, ...self::COST_KINDS); }
            if (self::truthy($q['kind'] ?? null)) { $where[] = 'documents.kind = ?'; $params[] = $q['kind']; }
            if (self::truthy($q['status'] ?? null)) { $where[] = 'documents.status = ?'; $params[] = $q['status']; }
            if (!empty($q['pending'])) $where[] = "documents.status IN ('reported','needs_completion')";
            if (self::truthy($q['party_id'] ?? null)) { $where[] = 'documents.party_id = ?'; $params[] = $q['party_id']; }
            if (self::truthy($q['order_id'] ?? null)) { $where[] = 'documents.order_id = ?'; $params[] = $q['order_id']; }
            if (self::truthy($q['q'] ?? null)) {
                $like = "%{$q['q']}%";
                $where[] = '(documents.number LIKE ? OR documents.description LIKE ? OR documents.tracking_no LIKE ?)';
                array_push($params, $like, $like, $like);
            }
            if (self::truthy($q['from'] ?? null)) { $where[] = 'documents.`date` >= ?'; $params[] = Db::dt($q['from']); }
            if (self::truthy($q['to'] ?? null)) { $where[] = 'documents.`date` < ?'; $params[] = Db::dt($q['to']); }
            if (!empty($q['open'])) {
                $where[] = "documents.status = 'posted'";
                $where[] = "documents.kind IN ('invoice','purchase','toll_fee','expense')";
                $where[] = 'documents.amount > ' . self::ALLOC_IN_SQL;
            }
            $cur = Pagination::decodeCursor($q['cursor'] ?? null);
            if ($cur) {
                $where[] = '(documents.`date`, documents.id) < (?, ?)';
                array_push($params, Db::dt($cur['at']), $cur['id']);
            }
            $params[] = $q['limit'] + 1;
            $rows = $db()->all(
                'SELECT documents.*, parties.name AS party_name, orders.number AS order_number, ' . self::ALLOC_OUT_SQL . ' AS alloc_out, ' . self::ALLOC_IN_SQL . ' AS alloc_in
                 FROM documents LEFT JOIN parties ON parties.id = documents.party_id LEFT JOIN orders ON orders.id = documents.order_id'
                . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY documents.`date` DESC, documents.id DESC LIMIT ?',
                $params,
            );
            $page = array_slice($rows, 0, $q['limit']);
            $last = $page ? $page[count($page) - 1] : null;
            return [
                'items' => array_map(static function (array $d) use ($me) {
                    $settles = $d['kind'] === 'receipt' || $d['kind'] === 'payment';
                    $allocated = Decimal::of((string) ($settles ? $d['alloc_out'] : $d['alloc_in']));
                    return self::presentDocument($d + [
                        'allocated' => Num::round($allocated, $d['currency']),
                        'remaining' => $d['amount'] === null ? null : Num::round(Decimal::of($d['amount'])->sub($allocated), $d['currency']),
                    ], $me);
                }, $page),
                'next_cursor' => count($rows) > $q['limit'] && $last ? Pagination::encodeCursor($last['date'], $last['id']) : null,
            ];
        });

        $r->get('/documents/:id', static function (Request $req) use ($db) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $d = self::loadDocument($db(), $id);
            if (!$d) throw new AppError('not_found');
            if (!Auth::can($me, 'finance.view') && self::isCost($d['kind'])) throw new AppError('forbidden');
            return self::presentDocument($d, $me);
        });

        $createSchema = V::object([
            'kind' => V::enum(self::KINDS), 'party_id' => V::uuid()->nullable()->optional(), 'order_id' => V::uuid()->nullable()->optional(), 'order_ids' => V::array(V::uuid())->max(50)->optional(),
            'amount' => V::decimalString()->nullable()->optional(), 'currency' => V::enum(Num::CURRENCIES)->optional(), 'date' => V::isoDate()->optional(), 'due_date' => V::isoDate()->nullable()->optional(),
            'method' => V::enum(self::METHODS)->nullable()->optional(), 'account_id' => V::uuid()->nullable()->optional(), 'tracking_no' => V::optText(80), 'description' => V::optText(500), 'note' => V::optText(2000),
            'file_ids' => V::array(V::uuid())->max(20)->optional(), 'lines' => V::array(self::docLineSchema())->max(200)->optional(),
            'expense_type' => V::enum(['order', 'shared', 'general'])->nullable()->optional(), 'expense_category' => V::optText(60),
            'shares' => V::array(V::object(['order_id' => V::uuid(), 'amount' => V::decimalString()]))->optional(),
            'barter_sign' => V::union([V::literal(1), V::literal(-1)])->optional(), 'barter_kg' => V::decimalString()->nullable()->optional(),
            'reverses_document_id' => V::uuid()->nullable()->optional(), 'settlement_kg' => V::decimalString()->nullable()->optional(), 'post' => V::boolean()->default(false),
            'allocations' => V::array(self::allocItemSchema())->max(50)->optional(),
        ]);

        // Create a document. Staff may create (draft/reported); posting needs finance.post. Invoices can be built from an order.
        $r->post('/documents', static function (Request $req) use ($db, $createSchema) {
            $me = $req->requireUser();
            $key = Idempotency::requireKey($req);
            $body = $createSchema->parse($req->body());
            if ($body['post']) $req->requirePermission('finance.post');
            if (self::isCost($body['kind']) && !Auth::can($me, 'finance.view')) throw new AppError('forbidden', 'ثبت خرید/اجرت/هزینه فقط با دسترسی مالی');
            $res = Idempotency::run($db(), $key, $me->id, 'POST /documents', static function (Db $trx) use ($body, $me) {
                $at = self::truthy($body['date'] ?? null) ? new \DateTimeImmutable($body['date']) : new \DateTimeImmutable('now');
                $kind = $body['kind'];
                $partyId = $body['party_id'] ?? null;
                $currency = $body['currency'] ?? 'TOMAN';
                $amount = $body['amount'] ?? null;
                $lines = [];
                $orderId = $body['order_id'] ?? null;
                $basisKg = $body['settlement_kg'] ?? null;
                if ($kind === 'invoice' || $kind === 'sales_return') {
                    if ($kind === 'sales_return' && self::truthy($body['reverses_document_id'] ?? null)) {
                        $inv = $trx->one("SELECT * FROM documents WHERE id = ? AND kind = 'invoice'", [$body['reverses_document_id']]);
                        if (!$inv) throw new AppError('validation', 'فاکتور مرجع یافت نشد', ['reverses_document_id' => 'نامعتبر']);
                        $partyId = $partyId ?? $inv['party_id'];
                        $orderId = $orderId ?? $inv['order_id'];
                        $currency = $body['currency'] ?? $inv['currency'];
                    }
                    if (self::truthy($orderId)) {
                        $o = $trx->find('orders', $orderId);
                        if (!$o) throw new AppError('validation', 'سفارش یافت نشد', ['order_id' => 'نامعتبر']);
                        if ($kind === 'invoice' && $o['status_sales'] !== 'approved') throw new AppError('validation', 'فاکتور فقط برای سفارش تأییدشده صادر می‌شود');
                        $partyId = $partyId ?? $o['party_id'];
                        $currency = $body['currency'] ?? $o['currency'];
                        if (!array_key_exists('lines', $body)) {
                            $ol = OrdersService::loadLines($trx, $orderId);
                            // Settlement on final net scale: the approved «sale» ticket of the delivery replaces estimated kg for per-kg lines.
                            if ($kind === 'invoice' && $o['settlement_basis'] === 'final_net_scale' && !self::truthy($basisKg)) {
                                $t = $trx->one(
                                    "SELECT scale_tickets.net_direct_kg, scale_tickets.gross_kg, scale_tickets.tare_kg, scale_tickets.packaging_kg FROM scale_tickets
                                     INNER JOIN transfers ON transfers.id = scale_tickets.transfer_id
                                     WHERE scale_tickets.status = 'approved' AND scale_tickets.approved_for LIKE ? AND transfers.order_ids LIKE ?
                                     ORDER BY scale_tickets.approved_at IS NULL DESC, scale_tickets.approved_at DESC LIMIT 1",
                                    ['%"sale"%', '%"' . $orderId . '"%'],
                                );
                                if ($t) {
                                    $basisKg = $t['net_direct_kg'] ?? (self::truthy($t['gross_kg']) && self::truthy($t['tare_kg'])
                                        ? Num::round(Decimal::of($t['gross_kg'])->sub($t['tare_kg'])->sub($t['packaging_kg'] ?? 0), 'weight') : null);
                                }
                            }
                            $perKgTotal = Decimal::zero();
                            foreach ($ol as $l) if ($l['price_basis'] === 'per_kg' && self::truthy($l['qty_kg'])) $perKgTotal = $perKgTotal->add($l['qty_kg']);
                            foreach ($ol as $l) {
                                if ($l['currency'] !== $currency) continue;
                                $qty = match ($l['price_basis']) {
                                    'per_kg' => $l['qty_kg'],
                                    'per_bar' => $l['qty_bars'],
                                    'per_piece' => $l['qty_pieces'] === null ? null : (string) $l['qty_pieces'],
                                    default => $l['qty_kg'],
                                };
                                if (self::truthy($basisKg) && $l['price_basis'] === 'per_kg' && self::truthy($l['qty_kg']) && !$perKgTotal->isZero()) {
                                    $qty = Num::round(Decimal::of($basisKg)->mul($l['qty_kg'])->div($perKgTotal), 'weight');
                                }
                                $amt = R::lineAmount($qty, $l['unit_price'], $currency, $l['discount_amount'], $l['discount_percent']);
                                if ($amt === null) throw new AppError('validation', 'ردیف «' . ($l['description'] ?? $l['product_id']) . '» قیمت ندارد', ['lines' => 'قیمت ناقص']);
                                $lines[] = [
                                    'description' => $l['description'] ?? $l['load_type_label'] ?? 'ردیف', 'qty' => $qty,
                                    'unit' => match ($l['price_basis']) { 'per_kg' => 'kg', 'per_bar' => 'bar', 'per_piece' => 'piece', default => 'm' },
                                    'unit_price' => $l['unit_price'], 'amount' => $amt, 'vat_rate' => $l['vat_rate'], 'order_line_id' => $l['id'],
                                    'meta' => ['product_id' => $l['product_id'], 'color' => $l['color'], 'length_m' => $l['length_m'], 'name_ar' => $l['name_ar'], 'name_en' => $l['name_en']],
                                ];
                            }
                        }
                    }
                }
                if (array_key_exists('lines', $body)) {
                    $lines = array_map(static fn (array $l) => array_merge($l, [
                        'amount' => $l['amount'] ?? (self::truthy($l['qty'] ?? null) && self::truthy($l['unit_price'] ?? null) ? Num::round(Decimal::of($l['qty'])->mul($l['unit_price']), $currency) : '0'),
                    ]), $body['lines']);
                }
                if ($lines) {
                    $sum = Decimal::zero();
                    foreach ($lines as $l) $sum = $sum->add($l['amount'])->add(self::vatAmount($l['amount'], $l['vat_rate'] ?? null));
                    $amount = Num::round($sum, $currency);
                }
                if (in_array($kind, ['receipt', 'payment', 'barter', 'opening_balance', 'fx_difference', 'invoice', 'sales_return'], true) && !self::truthy($partyId)) {
                    throw new AppError('validation', 'طرف حساب لازم است', ['party_id' => 'لازم است']);
                }
                if ($kind === 'expense' && ($body['expense_type'] ?? null) === 'order' && !self::truthy($orderId)) throw new AppError('validation', 'هزینه سفارشی باید به سفارش وصل باشد', ['order_id' => 'لازم است']);
                if (($kind === 'receipt' || $kind === 'payment') && ($amount === null || Decimal::of($amount)->lte(0))) throw new AppError('validation', 'مبلغ لازم است', ['amount' => 'لازم است']);
                $status = $amount === null ? 'needs_completion' : ($body['post'] ? 'posted' : ($kind === 'receipt' || $kind === 'payment' ? 'reported' : 'draft'));
                $d = $trx->insert('documents', [
                    'number' => Numbering::next($trx, $kind, $at), 'kind' => $kind, 'party_id' => $partyId, 'order_id' => $orderId, 'amount' => $amount, 'currency' => $currency, 'date' => self::toDate($at),
                    'due_date' => self::truthy($body['due_date'] ?? null) ? self::toDate($body['due_date']) : null, 'method' => $body['method'] ?? null, 'account_id' => $body['account_id'] ?? null, 'tracking_no' => $body['tracking_no'] ?? null,
                    'description' => $body['description'] ?? null, 'note' => $body['note'] ?? null, 'file_ids' => $body['file_ids'] ?? [], 'status' => $status,
                    'posted_by' => $status === 'posted' ? $me->id : null, 'posted_at' => $status === 'posted' ? Db::now() : null, 'reported_by' => $me->id,
                    'expense_type' => $kind === 'expense' ? ($body['expense_type'] ?? (self::truthy($orderId) ? 'order' : (!empty($body['order_ids']) ? 'shared' : 'general'))) : null,
                    'expense_category' => $body['expense_category'] ?? null,
                    'barter_sign' => in_array($kind, ['barter', 'opening_balance', 'fx_difference'], true) ? ($body['barter_sign'] ?? 1) : null,
                    'barter_kg' => $body['barter_kg'] ?? null, 'reverses_document_id' => $body['reverses_document_id'] ?? null, 'settlement_basis_kg' => $basisKg, 'created_by' => $me->id,
                ]);
                $sort = 0;
                foreach ($lines as $l) {
                    $trx->insertNoReturn('document_lines', [
                        'document_id' => $d['id'], 'description' => $l['description'], 'qty' => $l['qty'] ?? null, 'unit' => $l['unit'] ?? null, 'unit_price' => $l['unit_price'] ?? null,
                        'amount' => $l['amount'], 'vat_rate' => $l['vat_rate'] ?? null,
                        'vat_amount' => self::truthy($l['vat_rate'] ?? null) ? Num::round(Decimal::of($l['amount'])->mul($l['vat_rate'])->div(100), $currency) : null,
                        'order_line_id' => $l['order_line_id'] ?? null, 'meta' => self::truthy($l['meta'] ?? null) ? $l['meta'] : null, 'sort' => $sort++, 'created_by' => $me->id,
                    ]);
                }
                if ($kind === 'expense' && $amount !== null) self::writeShares($trx, $d, $body['order_ids'] ?? [], $body['shares'] ?? null, $me->id);
                if (!empty($body['allocations'])) self::allocate($trx, $d, $body['allocations'], $me);
                if (self::truthy($body['reverses_document_id'] ?? null) && $kind === 'sales_return') {
                    $trx->update('documents', ['reversed_by_document_id' => $d['id']] + Db::bump(), 'id = ?', [$body['reverses_document_id']]);
                }
                if ($status === 'reported') {
                    $label = $d['kind'] === 'receipt' ? 'دریافت' : 'پرداخت';
                    Notify::managers($trx, ['kind' => 'document_reported', 'title' => "{$label} {$d['number']} به مبلغ {$amount} {$currency} گزارش شد؛ منتظر تأیید", 'entity' => 'documents', 'entityId' => $d['id'], 'groupKey' => "reported:{$d['id']}"]);
                }
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'documents', 'entityId' => $d['id'], 'action' => 'create', 'after' => $d]);
                return ['status' => 201, 'body' => self::presentDocument(self::loadDocument($trx, $d['id']), $me)];
            });
            return Response::json($res['body'], $res['status']);
        });

        $act = static function (Request $req, string $name, ?string $perm, Schema $schema, callable $work) use ($db) {
            $me = $perm ? $req->requirePermission($perm) : $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $key = Idempotency::requireKey($req);
            $raw = $req->body();
            if ($raw instanceof Undef || $raw === null) $raw = new \stdClass();
            // z.object({ version }).and(schema): both sides parse the same input, every issue is reported, outputs merge.
            $body = V::object(['version' => V::int()])->extend($schema->shape())->parse($raw);
            $res = Idempotency::run($db(), $key, $me->id, "POST /documents/{$name}", static function (Db $trx) use ($id, $me, $body, $work, $name) {
                $d = $trx->find('documents', $id, true);
                if (!$d) throw new AppError('not_found');
                if ($d['version'] !== $body['version']) throw AppError::conflict(self::presentDocument(self::loadDocument($trx, $id), $me));
                $work($trx, $d, $me, $body);
                $after = $trx->find('documents', $id);
                Audit::log($trx, [
                    'userId' => $me->id, 'entity' => 'documents', 'entityId' => $id, 'action' => $name,
                    'before' => ['status' => $d['status'], 'amount' => $d['amount']], 'after' => ['status' => $after['status'], 'amount' => $after['amount']],
                    'reason' => isset($body['reason']) ? (string) $body['reason'] : null,
                ]);
                return ['status' => 200, 'body' => self::presentDocument(self::loadDocument($trx, $id), $me)];
            });
            return $res['body'];
        };

        // Edit a non-posted document (T37: posted → refused).
        $r->patch('/documents/:id', static function (Request $req) use ($db) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $body = V::object(V::versionField() + [
                'amount' => V::decimalString()->nullable()->optional(), 'date' => V::isoDate()->optional(), 'due_date' => V::isoDate()->nullable()->optional(),
                'method' => V::enum(self::METHODS)->nullable()->optional(), 'account_id' => V::uuid()->nullable()->optional(), 'tracking_no' => V::optText(80), 'description' => V::optText(500),
                'note' => V::optText(2000), 'file_ids' => V::array(V::uuid())->max(20)->optional(), 'party_id' => V::uuid()->nullable()->optional(),
                'lines' => V::array(self::docLineSchema())->max(200)->optional(), 'expense_category' => V::optText(60),
            ])->parse($req->body());
            return $db()->transaction(static function (Db $trx) use ($id, $body, $me) {
                $d = $trx->find('documents', $id, true);
                if (!$d) throw new AppError('not_found');
                if ($d['version'] !== $body['version']) throw AppError::conflict(self::presentDocument(self::loadDocument($trx, $id), $me));
                if ($d['status'] === 'posted' || $d['status'] === 'void' || $d['locked']) throw new AppError('validation', 'سند قطعی تغییر نمی‌کند؛ برای اصلاح سند برگشتی/اصلاحی بزنید');
                if (self::isCost($d['kind']) && !Auth::can($me, 'finance.view')) throw new AppError('forbidden');
                $rest = $body;
                unset($rest['version'], $rest['lines'], $rest['date'], $rest['due_date']);
                // Node spreads `reason` into the UPDATE as well (no such column: the request fails) — kept as is.
                $amount = array_key_exists('amount', $rest) ? $rest['amount'] : $d['amount'];
                if (array_key_exists('lines', $body)) {
                    $trx->exec('DELETE FROM document_lines WHERE document_id = ?', [$id]);
                    $sort = 0;
                    $sum = Decimal::zero();
                    foreach ($body['lines'] as $l) {
                        $amt = $l['amount'] ?? (self::truthy($l['qty'] ?? null) && self::truthy($l['unit_price'] ?? null) ? Num::round(Decimal::of($l['qty'])->mul($l['unit_price']), $d['currency']) : '0');
                        $sum = $sum->add($amt)->add(self::truthy($l['vat_rate'] ?? null) ? Decimal::of($amt)->mul($l['vat_rate'])->div(100) : 0);
                        $trx->insertNoReturn('document_lines', [
                            'document_id' => $id, 'description' => $l['description'], 'qty' => $l['qty'] ?? null, 'unit' => $l['unit'] ?? null, 'unit_price' => $l['unit_price'] ?? null,
                            'amount' => $amt, 'vat_rate' => $l['vat_rate'] ?? null, 'order_line_id' => $l['order_line_id'] ?? null,
                            'meta' => self::truthy($l['meta'] ?? null) ? $l['meta'] : null, 'sort' => $sort++, 'created_by' => $me->id,
                        ]);
                    }
                    $amount = Num::round($sum, $d['currency']);
                }
                $set = array_merge($rest, [
                    'amount' => $amount,
                    'status' => $amount === null ? 'needs_completion' : ($d['status'] === 'needs_completion' ? 'draft' : $d['status']),
                ]);
                if (self::truthy($body['date'] ?? null)) $set['date'] = self::toDate($body['date']);
                if (array_key_exists('due_date', $body)) $set['due_date'] = self::truthy($body['due_date']) ? self::toDate($body['due_date']) : null;
                $after = $trx->updateById('documents', $id, array_merge($set, Db::bump()));
                if ($after['kind'] === 'expense' && self::truthy($after['amount']) && $after['amount'] !== $d['amount']) {
                    $prev = $trx->all('SELECT * FROM expense_shares WHERE document_id = ?', [$id]);
                    self::writeShares($trx, $after, array_map(static fn ($p) => $p['order_id'], $prev), null, $me->id);
                }
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'documents', 'entityId' => $id, 'action' => 'update', 'before' => $d, 'after' => $after]);
                return self::presentDocument(self::loadDocument($trx, $id), $me);
            });
        });

        // Post (finance.post): the document becomes immutable and counts in balances (T43).
        $r->post('/documents/:id/post', static fn (Request $req) => $act($req, 'post', 'finance.post', V::object([]), static function (Db $trx, array $d, AuthUser $me) {
            if ($d['status'] === 'posted') throw new AppError('validation', 'سند قبلاً قطعی شده است');
            if ($d['status'] === 'void') throw new AppError('validation', 'سند باطل است');
            if ($d['amount'] === null) throw new AppError('validation', 'سند ناقص است؛ مبلغ لازم است', ['amount' => 'لازم است']);
            if (($d['kind'] === 'receipt' || $d['kind'] === 'payment') && !self::truthy($d['method'])) throw new AppError('validation', 'روش دریافت/پرداخت لازم است', ['method' => 'لازم است']);
            $trx->update('documents', ['status' => 'posted', 'posted_by' => $me->id, 'posted_at' => Db::now(), 'locked' => true] + Db::bump(), 'id = ?', [$d['id']]);
            if ($d['kind'] === 'invoice' && self::truthy($d['order_id'])) $trx->update('orders', Db::bump(), 'id = ?', [$d['order_id']]);
        }));

        // Void (finance.post, reason required): status → void, allocations removed; the row itself stays for history.
        $r->post('/documents/:id/void', static fn (Request $req) => $act($req, 'void', 'finance.post', V::object(['reason' => V::string()->trim()->min(3)->max(1000)]), static function (Db $trx, array $d, AuthUser $me, array $body) {
            if ($d['status'] === 'void') throw new AppError('validation', 'سند قبلاً باطل شده است');
            $incoming = $trx->one("SELECT allocations.id FROM allocations INNER JOIN documents f ON f.id = allocations.from_document_id WHERE to_document_id = ? AND f.status = 'posted' LIMIT 1", [$d['id']]);
            if ($incoming) throw new AppError('validation', 'این سند تخصیص دریافت/پرداخت دارد؛ اول تخصیص‌ها را آزاد کنید');
            $trx->exec('DELETE FROM allocations WHERE from_document_id = ?', [$d['id']]);
            if ($d['kind'] === 'expense') $trx->exec('DELETE FROM expense_shares WHERE document_id = ?', [$d['id']]);
            // Reversal document («ابطال با سند معکوس»): same kind and amount, both rows void and pointing at each other.
            $revId = $trx->insertNoReturn('documents', [
                'number' => Numbering::next($trx, $d['kind']), 'kind' => $d['kind'], 'party_id' => $d['party_id'], 'order_id' => $d['order_id'], 'amount' => $d['amount'], 'currency' => $d['currency'],
                'status' => 'void', 'locked' => true, 'reverses_document_id' => $d['id'], 'description' => "ابطال {$d['number']}: {$body['reason']}", 'created_by' => $me->id,
            ]);
            $trx->update('documents', ['status' => 'void', 'locked' => true, 'reversed_by_document_id' => $revId] + Db::bump(), 'id = ?', [$d['id']]);
            if (self::truthy($d['reverses_document_id'])) $trx->update('documents', ['reversed_by_document_id' => null] + Db::bump(), 'id = ?', [$d['reverses_document_id']]);
        }));

        $r->post('/documents/:id/allocate', static fn (Request $req) => $act($req, 'allocate', 'finance.post', V::object(['items' => V::array(self::allocItemSchema())->min(1)->max(50)]), static function (Db $trx, array $d, AuthUser $me, array $body) {
            self::allocate($trx, $d, $body['items'], $me);
        }));

        $r->post('/documents/:id/unallocate', static fn (Request $req) => $act($req, 'unallocate', 'finance.post', V::object(['allocation_id' => V::uuid()]), static function (Db $trx, array $d, AuthUser $me, array $body) {
            $a = $trx->one('SELECT * FROM allocations WHERE id = ? AND from_document_id = ?', [(string) $body['allocation_id'], $d['id']]);
            if (!$a) throw new AppError('not_found');
            $trx->exec('DELETE FROM allocations WHERE id = ?', [$a['id']]);
        }));

        // Manual expense shares (finance.post).
        $r->post('/documents/:id/shares', static fn (Request $req) => $act($req, 'shares', 'finance.post', V::object(['shares' => V::array(V::object(['order_id' => V::uuid(), 'amount' => V::decimalString()]))->min(1)]), static function (Db $trx, array $d, AuthUser $me, array $body) {
            if ($d['kind'] !== 'expense' || $d['amount'] === null) throw new AppError('validation', 'فقط هزینه با مبلغ سهم‌بندی می‌شود');
            $trx->update('documents', ['expense_type' => 'shared'] + Db::bump(), 'id = ?', [$d['id']]);
            self::writeShares($trx, ['expense_type' => 'shared'] + $d, [], $body['shares'], $me->id);
        }));

        // Party ledger (statement) with running balances; also drives the statement PDF.
        $r->get('/parties/:id/statement', static function (Request $req) use ($db) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $q = V::object(['from' => V::isoDate()->optional(), 'to' => V::isoDate()->optional()])->parse($req->query);
            $party = $db()->one('SELECT id, name, name_ar, phones, address FROM parties WHERE id = ?', [$id]);
            if (!$party) throw new AppError('not_found');
            $st = self::partyStatement($db(), $id, self::truthy($q['from'] ?? null) ? $q['from'] : null, self::truthy($q['to'] ?? null) ? $q['to'] : null);
            if (!Auth::can($me, 'finance.view')) $st['rows'] = array_values(array_filter($st['rows'], static fn ($x) => !self::isCost($x['kind'])));
            return ['party' => $party, 'opening' => (object) $st['opening'], 'rows' => $st['rows'], 'closing' => (object) $st['closing']];
        });

        // Open items for a party: invoices (receivable) and purchases/fees/expenses (payable) with remaining amounts.
        $r->get('/parties/:id/open-items', static function (Request $req) use ($db) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $rows = $db()->all(
                'SELECT documents.*, ' . self::ALLOC_IN_SQL . " AS alloc_in FROM documents WHERE party_id = ? AND status = 'posted' AND kind IN ('invoice','purchase','toll_fee','expense') ORDER BY `date`",
                [$id],
            );
            $items = [];
            foreach ($rows as $d) {
                $p = self::presentDocument($d + [
                    'allocated' => Num::round((string) $d['alloc_in'], $d['currency']),
                    'remaining' => Num::round(Decimal::of($d['amount'] ?? 0)->sub((string) $d['alloc_in']), $d['currency']),
                ], $me);
                if (self::truthy($p['remaining'] ?? null) && Decimal::of($p['remaining'])->gt(0)) $items[] = $p;
            }
            $unallocated = $db()->all(
                'SELECT documents.*, ' . self::ALLOC_OUT_SQL . " AS alloc_out FROM documents WHERE party_id = ? AND status = 'posted' AND kind IN ('receipt','payment') AND documents.amount > " . self::ALLOC_OUT_SQL,
                [$id],
            );
            return [
                'items' => $items,
                'unallocated' => array_map(static fn ($d) => self::presentDocument($d + [
                    'allocated' => Num::round((string) $d['alloc_out'], $d['currency']),
                    'remaining' => Num::round(Decimal::of($d['amount'] ?? 0)->sub((string) $d['alloc_out']), $d['currency']),
                ], $me), $unallocated),
            ];
        });

        // Pending confirmations for the manager: reported receipts/payments and incomplete documents.
        $r->get('/documents/pending', static function (Request $req) use ($db) {
            $me = $req->requirePermission('finance.view');
            $rows = $db()->all(
                "SELECT documents.*, parties.name AS party_name, users.short_name AS reported_by_name FROM documents
                 LEFT JOIN parties ON parties.id = documents.party_id LEFT JOIN users ON users.id = documents.reported_by
                 WHERE documents.status IN ('reported','needs_completion') ORDER BY documents.created_at",
            );
            return ['items' => array_map(static fn ($d) => self::presentDocument($d, $me), $rows)];
        });
    }
}
