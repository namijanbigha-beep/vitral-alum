<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\Auth as Session;
use Vitral\Core\AuthUser;
use Vitral\Core\Crud;
use Vitral\Core\Db;
use Vitral\Core\Idempotency;
use Vitral\Core\Json;
use Vitral\Core\Notify;
use Vitral\Core\Numbering;
use Vitral\Core\Query;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\Schema;
use Vitral\Core\Undef;
use Vitral\Core\V;
use Vitral\Lib\DailyReport;
use Vitral\Lib\Decimal;
use Vitral\Lib\Jalali;
use Vitral\Lib\Num;
use Vitral\Lib\Stock;
use Vitral\Lib\Xlsx;
use Vitral\Lib\Zip;

/**
 * Port of apps/server/src/modules/daily/routes.ts: free notes (+ review / convert), tasks (+ done / comments),
 * notifications, share links, the daily report (+ snapshot), gallery and photo zips, global search,
 * Telegram link codes and correction requests.
 */
final class Daily
{
    public const TOPICS = ['paint_purchase', 'tool_purchase', 'bill_payment', 'freight_cost', 'misc_delivery', 'damage', 'other'];

    public static function sha(string $s): string
    {
        return hash('sha256', $s);
    }

    /** Body or `{}` when the request had none (`req.body ?? {}`). */
    public static function bodyOrEmpty(Request $req): mixed
    {
        $b = $req->body();
        return $b instanceof Undef || $b === null ? [] : $b;
    }

    public static function presentNote(array $n, ?AuthUser $user): array
    {
        $out = $n;
        if (!$user || !Session::can($user, 'finance.view')) {
            $mine = $user !== null && ($n['created_by'] ?? null) === $user->id;
            if (!empty($n['sensitive']) && !$mine) {
                return ['id' => $n['id'] ?? null, 'status' => $n['status'] ?? null, 'sensitive' => true, 'created_at' => $n['created_at'] ?? null, 'created_by' => $n['created_by'] ?? null];
            }
            if (!$mine) unset($out['amount'], $out['currency']);
        }
        return $out;
    }

    /** jalaliDateArg of lib/dates.ts: «1405/07/10» (any digits) or today in Tehran; \RangeException when invalid. */
    public static function jalaliDateArg(?string $input, \DateTimeInterface|string|null $at = null): array
    {
        if ($input === null || $input === '') return Jalali::of($at);
        $j = Jalali::parse($input);
        if ($j === null) throw new \RangeException('تاریخ شمسی نامعتبر است');
        return $j;
    }

    /**
     * Auto caption from the event the photo belongs to (never from the picture itself).
     * @param array{start?:?string,end?:?string,party_id?:?string,product_id?:?string,stage?:?string,bundle_id?:?string} $f
     * @return list<array<string,mixed>>
     */
    public static function galleryItems(Db $db, array $f): array
    {
        $sql = "SELECT files.id, files.kind, files.mime, files.caption, files.created_at, files.owner_entity, files.owner_id, files.thumb_key,
                       bundles.code AS bundle_code, bundles.weight_kg AS bundle_kg, bundles.production_run_id, parties.name AS factory_name, locations.name AS location_name,
                       transfers.number AS transfer_number, scale_tickets.stage AS ticket_stage, coating_runs.number AS coating_number
                  FROM files
                  LEFT JOIN bundles ON bundles.id = files.owner_id AND files.owner_entity = 'bundles'
                  LEFT JOIN transfers ON transfers.id = files.owner_id AND files.owner_entity = 'transfers'
                  LEFT JOIN scale_tickets ON scale_tickets.id = files.owner_id AND files.owner_entity = 'scale_tickets'
                  LEFT JOIN coating_runs ON coating_runs.id = files.owner_id AND files.owner_entity = 'coating_runs'
                  LEFT JOIN parties ON parties.id = bundles.factory_party_id
                  LEFT JOIN locations ON locations.id = bundles.location_id
                 WHERE files.`sensitive` = 0 AND files.mime LIKE 'image/%' AND files.owner_entity IN ('bundles', 'transfers', 'scale_tickets', 'coating_runs', 'production_runs')";
        $params = [];
        if (!empty($f['start'])) {
            $sql .= ' AND files.created_at >= ?';
            $params[] = Db::dt($f['start']);
        }
        if (!empty($f['end'])) {
            $sql .= ' AND files.created_at < ?';
            $params[] = Db::dt($f['end']);
        }
        if (!empty($f['bundle_id'])) {
            $sql .= ' AND files.owner_id = ?';
            $params[] = $f['bundle_id'];
        }
        if (!empty($f['party_id'])) {
            $sql .= ' AND bundles.factory_party_id = ?';
            $params[] = $f['party_id'];
        }
        if (!empty($f['product_id'])) {
            $sql .= ' AND EXISTS (SELECT 1 FROM bundle_lines bl WHERE bl.bundle_id = bundles.id AND bl.product_id = ?)';
            $params[] = $f['product_id'];
        }
        if (!empty($f['stage'])) {
            $sql .= ' AND files.owner_entity = ?';
            $params[] = $f['stage'] === 'production' ? 'bundles' : ($f['stage'] === 'coating' ? 'coating_runs' : ($f['stage'] === 'scale' ? 'scale_tickets' : 'transfers'));
        }
        $rows = $db->all($sql . ' ORDER BY files.created_at DESC LIMIT 500', $params);
        $out = [];
        foreach ($rows as $r) {
            $stage = $r['owner_entity'] === 'bundles' ? 'تولید' : ($r['owner_entity'] === 'coating_runs' ? 'رنگ' : ($r['owner_entity'] === 'scale_tickets' ? 'باسکول' : 'بار'));
            $ref = $r['bundle_code'] ? 'بندیل ' . $r['bundle_code'] : ($r['transfer_number'] ? 'بار ' . $r['transfer_number'] : ($r['coating_number'] ? 'نوبت رنگ ' . $r['coating_number'] : null));
            $parts = [$r['factory_name'] ?? $r['location_name'], $stage, $ref, $r['bundle_kg'] ? Num::round($r['bundle_kg'], 'weight') . ' کیلو' : null];
            $parts = array_values(array_filter($parts, static fn ($p) => $p !== null && $p !== ''));
            $out[] = [
                'id' => $r['id'], 'kind' => $r['kind'], 'caption' => $r['caption'], 'auto_caption' => implode(' · ', $parts), 'created_at' => $r['created_at'],
                'owner_entity' => $r['owner_entity'], 'owner_id' => $r['owner_id'], 'has_thumb' => (bool) $r['thumb_key'], 'bundle_code' => $r['bundle_code'], 'stage' => $stage,
            ];
        }
        return $out;
    }

    /** The update schema of crudRoutes: every base field `.optional()` (zod: optional wraps, so no default applies). */
    private static function allOptional(array $base): array
    {
        $out = [];
        foreach ($base as $k => $s) $out[$k] = $s->optional();
        return $out;
    }

    private static function iso(?string $s): ?\DateTimeImmutable
    {
        return $s === null || $s === '' ? null : new \DateTimeImmutable($s);
    }

    public static function register(Router $r, App $app): void
    {
        // ---- free notes (spec module 8) ----
        $noteFields = static fn (bool $create) => [
            'text' => V::text(4000)->min(1),
            'topic' => V::enum(self::TOPICS)->nullable()->optional(),
            'amount' => V::decimalString()->nullable()->optional(),
            'currency' => V::enum(Num::CURRENCIES)->nullable()->optional(),
            'party_id' => V::string()->uuid()->nullable()->optional(),
            'order_id' => V::string()->uuid()->nullable()->optional(),
            'location_id' => V::string()->uuid()->nullable()->optional(),
            'qty' => V::decimalString()->nullable()->optional(),
            'kg' => V::decimalString()->nullable()->optional(),
            'occurred_at' => V::isoDate()->nullable()->optional(),
            'sensitive' => $create ? V::boolean()->default(false) : V::boolean()->optional(),
            'file_ids' => V::array(V::string()->uuid())->max(10)->optional(),
            'telegram_message_id' => V::optText(60),
        ];
        Crud::routes($r, $app, [
            'table' => 'free_notes', 'path' => '/free-notes', 'idempotent' => true,
            'createSchema' => V::object($noteFields(true)),
            'updateSchema' => V::object(V::versionField() + self::allOptional($noteFields(false))),
            'listSchema' => V::object([
                'status' => V::enum(['new', 'needs_info', 'reviewed', 'converted', 'rejected'])->optional(),
                'mine' => V::boolQuery()->optional(),
                'topic' => V::enum(self::TOPICS)->optional(),
            ]),
            'present' => static fn (array $row, AuthUser $u) => self::presentNote($row, $u),
            'filter' => static function (Query $qb, array $q, AuthUser $user): void {
                if (!empty($q['status'])) $qb->where('free_notes.status = ?', [(string) $q['status']]);
                if (!empty($q['topic'])) $qb->where('free_notes.topic = ?', [(string) $q['topic']]);
                if (!empty($q['mine']) || !Session::can($user, 'finance.view')) $qb->where('free_notes.created_by = ? OR free_notes.`sensitive` = 0', [$user->id]);
            },
            'beforeCreate' => static function (Db $t, array $i): array {
                unset($i['file_ids']);
                $occ = $i['occurred_at'] ?? null;
                unset($i['occurred_at']);
                return $i + ['occurred_at' => $occ ? new \DateTimeImmutable($occ) : new \DateTimeImmutable('now')];
            },
            'afterCreate' => static function (Db $trx, array $row, array $input, AuthUser $user): void {
                foreach ($input['file_ids'] ?? [] as $fid) {
                    $trx->exec('INSERT IGNORE INTO file_links (id, file_id, entity, entity_id, created_by) VALUES (?, ?, ?, ?, ?)', [Db::uuid(), $fid, 'free_notes', $row['id'], $user->id]);
                }
                Notify::managers($trx, ['kind' => 'free_note', 'title' => 'ثبت آزاد جدید: ' . Xlsx::jsSlice((string) $input['text'], 0, 60), 'entity' => 'free_notes', 'entityId' => $row['id'], 'groupKey' => "note:{$row['id']}"]);
            },
            'beforeUpdate' => static function (Db $t, array $before, array $patch, AuthUser $user): array {
                if ($before['created_by'] !== $user->id && !Session::can($user, 'finance.post')) throw new AppError('forbidden');
                if ($before['status'] === 'converted') throw new AppError('validation', 'ثبت تبدیل‌شده تغییر نمی‌کند');
                unset($patch['file_ids']);
                if (array_key_exists('occurred_at', $patch)) $patch['occurred_at'] = self::iso($patch['occurred_at']);
                return $patch;
            },
            'loadOne' => static function (Db $trx, string $id): ?array {
                $n = $trx->one(
                    'SELECT free_notes.*, users.short_name AS user_name, parties.name AS party_name FROM free_notes
                       LEFT JOIN users ON users.id = free_notes.created_by LEFT JOIN parties ON parties.id = free_notes.party_id
                      WHERE free_notes.id = ?',
                    [$id],
                );
                if (!$n) return null;
                $files = $trx->all(
                    "SELECT files.id, files.mime, files.caption, files.`sensitive` FROM file_links INNER JOIN files ON files.id = file_links.file_id
                      WHERE entity = 'free_notes' AND entity_id = ?",
                    [$id],
                );
                $ids = is_array($n['converted_document_ids']) ? $n['converted_document_ids'] : [];
                $docs = $ids ? $trx->all('SELECT id, number, kind, status FROM documents WHERE id IN (' . Db::placeholders($ids) . ')', $ids) : [];
                return $n + ['files' => $files, 'converted_documents' => $docs];
            },
        ]);

        $r->post('/free-notes/:id/review', static function (Request $req) use ($app) {
            $me = $req->requirePermission('finance.post');
            ['id' => $id] = V::idParam()->parse($req->params);
            $body = V::object([
                'version' => V::int(),
                'status' => V::enum(['needs_info', 'reviewed', 'rejected']),
                'review_note' => V::optText(1000),
            ])->parse($req->body());
            return $app->db()->transaction(static function (Db $trx) use ($id, $body, $me) {
                $n = $trx->find('free_notes', $id, true);
                if (!$n) throw new AppError('not_found');
                if ($n['version'] !== $body['version']) throw AppError::conflict(self::presentNote($n, $me));
                if ($n['status'] === 'converted') throw new AppError('validation', 'ثبت تبدیل‌شده است');
                $note = $body['review_note'] ?? null;
                $after = $trx->updateById('free_notes', $id, ['status' => $body['status'], 'review_note' => $note, 'reviewed_by' => $me->id, 'reviewed_at' => Db::raw('NOW(3)')] + Db::bump());
                if ($n['created_by']) {
                    $title = $body['status'] === 'needs_info' ? 'ثبت شما نیاز به اطلاعات دارد: ' . ($note ?? '') : ($body['status'] === 'rejected' ? 'ثبت شما رد شد' : 'ثبت شما بررسی شد');
                    Notify::send($trx, ['userId' => $n['created_by'], 'kind' => 'note_reviewed', 'title' => $title, 'entity' => 'free_notes', 'entityId' => $id]);
                }
                $trx->exec('UPDATE notifications SET read_at = NOW(3) WHERE group_key = ? AND read_at IS NULL', ["note:{$id}"]);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'free_notes', 'entityId' => $id, 'action' => 'review', 'before' => ['status' => $n['status']], 'after' => ['status' => $after['status']], 'reason' => $note]);
                return self::presentNote($after, $me);
            });
        });

        // Convert a free note into documents (T40); idempotent twice over (Idempotency-Key and conversion_request_id).
        $r->post('/free-notes/:id/convert', static function (Request $req) use ($app) {
            $me = $req->requirePermission('finance.post');
            ['id' => $id] = V::idParam()->parse($req->params);
            $key = Idempotency::requireKey($req);
            $body = V::object([
                'version' => V::int(),
                'effect' => V::enum(['expense', 'purchase', 'payment_for_purchase', 'purchase_and_payment', 'link_transfer']),
                'party_id' => V::string()->uuid()->optional(),
                'amount' => V::decimalString()->optional(),
                'currency' => V::enum(Num::CURRENCIES)->optional(),
                'order_id' => V::string()->uuid()->nullable()->optional(),
                'expense_type' => V::enum(['order', 'shared', 'general'])->optional(),
                'expense_category' => V::optText(60),
                'purchase_kind' => V::enum(['ingot', 'billet', 'scrap', 'paint_powder', 'tool', 'other'])->optional(),
                'kg' => V::decimalString()->optional(),
                'receive_to_location_id' => V::string()->uuid()->optional(),
                'method' => V::enum(['cash', 'card', 'bank_transfer', 'exchange_house', 'cheque', 'other'])->default('cash'),
                'account_id' => V::string()->uuid()->nullable()->optional(),
                'purchase_document_id' => V::string()->uuid()->optional(),
                'transfer_id' => V::string()->uuid()->optional(),
                'description' => V::optText(300),
            ])->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /free-notes/convert', static fn (Db $trx) => self::convert($trx, $id, $key, $body, $me));
            return $res['body'];
        });

        // ---- tasks ----
        $taskFields = static fn () => [
            'title' => V::text(200)->min(1),
            'description' => V::optText(4000),
            'assignee_user_id' => V::string()->uuid(),
            'due_at' => V::isoDate()->nullable()->optional(),
            'order_id' => V::string()->uuid()->nullable()->optional(),
            'party_id' => V::string()->uuid()->nullable()->optional(),
            'transfer_id' => V::string()->uuid()->nullable()->optional(),
            'voice_file_id' => V::string()->uuid()->nullable()->optional(),
        ];
        Crud::routes($r, $app, [
            'table' => 'tasks', 'path' => '/tasks', 'idempotent' => true, 'orderBy' => 'created_at',
            'createSchema' => V::object($taskFields()),
            'updateSchema' => V::object(V::versionField() + self::allOptional($taskFields())),
            'listSchema' => V::object([
                'status' => V::enum(['open', 'done', 'cancelled'])->optional(),
                'assignee_user_id' => V::string()->uuid()->optional(),
                'overdue' => V::boolQuery()->optional(),
                'order_id' => V::string()->uuid()->optional(),
            ]),
            'present' => static fn (array $row) => $row,
            'filter' => static function (Query $qb, array $q, AuthUser $user): void {
                if ($user->role !== 'manager') $qb->where('tasks.assignee_user_id = ?', [$user->id]);
                if (!empty($q['status'])) $qb->where('tasks.status = ?', [(string) $q['status']]);
                if (!empty($q['assignee_user_id'])) $qb->where('tasks.assignee_user_id = ?', [(string) $q['assignee_user_id']]);
                if (!empty($q['order_id'])) $qb->where('tasks.order_id = ?', [(string) $q['order_id']]);
                if (!empty($q['overdue'])) $qb->where("tasks.status = 'open'")->where('tasks.due_at < NOW(3)');
            },
            'beforeCreate' => static function (Db $t, array $i, AuthUser $user): array {
                if ($user->role !== 'manager') throw new AppError('forbidden', 'فقط مدیر کار می‌سازد');
                $i['due_at'] = self::iso($i['due_at'] ?? null);
                return $i;
            },
            'afterCreate' => static function (Db $trx, array $row): void {
                Notify::send($trx, ['userId' => $row['assignee_user_id'], 'kind' => 'task_new', 'title' => "کار جدید: {$row['title']}", 'entity' => 'tasks', 'entityId' => $row['id']]);
            },
            'beforeUpdate' => static function (Db $t, array $before, array $patch, AuthUser $user): array {
                if ($user->role !== 'manager' && $before['assignee_user_id'] !== $user->id) throw new AppError('forbidden');
                if (array_key_exists('due_at', $patch)) $patch['due_at'] = self::iso($patch['due_at']);
                return $patch;
            },
            'loadOne' => static function (Db $trx, string $id, AuthUser $user): ?array {
                $t = $trx->one(
                    'SELECT tasks.*, a.short_name AS assignee_name, c.short_name AS creator_name FROM tasks
                       LEFT JOIN users a ON a.id = tasks.assignee_user_id LEFT JOIN users c ON c.id = tasks.created_by
                      WHERE tasks.id = ?',
                    [$id],
                );
                if (!$t) return null;
                if ($user->role !== 'manager' && $t['assignee_user_id'] !== $user->id) throw new AppError('forbidden');
                $comments = $trx->all(
                    'SELECT task_comments.*, users.short_name AS user_name FROM task_comments LEFT JOIN users ON users.id = task_comments.user_id
                      WHERE task_id = ? ORDER BY task_comments.created_at',
                    [$id],
                );
                return $t + ['comments' => $comments];
            },
        ]);

        $r->post('/tasks/:id/done', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $key = Idempotency::requireKey($req);
            $body = V::object(['version' => V::int(), 'done_note' => V::optText(2000), 'done_file_id' => V::string()->uuid()->nullable()->optional()])->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /tasks/done', static function (Db $trx) use ($id, $body, $me) {
                $t = $trx->find('tasks', $id, true);
                if (!$t) throw new AppError('not_found');
                if ($me->role !== 'manager' && $t['assignee_user_id'] !== $me->id) throw new AppError('forbidden');
                if ($t['version'] !== $body['version']) throw AppError::conflict($t);
                if ($t['status'] !== 'open') throw new AppError('validation', 'کار باز نیست');
                $note = $body['done_note'] ?? null;
                $after = $trx->updateById('tasks', $id, ['status' => 'done', 'done_at' => Db::raw('NOW(3)'), 'done_note' => $note, 'done_file_id' => $body['done_file_id'] ?? null] + Db::bump());
                if ($t['created_by'] && $t['created_by'] !== $me->id) {
                    Notify::send($trx, ['userId' => $t['created_by'], 'kind' => 'task_done', 'title' => "کار «{$t['title']}» انجام شد" . ($note ? ': ' . $note : ''), 'entity' => 'tasks', 'entityId' => $id]);
                }
                $auditAfter = array_key_exists('done_note', $body) ? ['done_note' => $note] : [];
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'tasks', 'entityId' => $id, 'action' => 'done', 'after' => $auditAfter ?: new \stdClass()]);
                return ['status' => 200, 'body' => $after];
            });
            return $res['body'];
        });

        $r->post('/tasks/:id/comments', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $body = V::object(['text' => V::optText(2000), 'file_id' => V::string()->uuid()->nullable()->optional()])
                ->refine(static fn ($b) => (($b['text'] ?? null) !== null && $b['text'] !== '') || !empty($b['file_id']), 'متن یا فایل لازم است')
                ->parse($req->body());
            $db = $app->db();
            $t = $db->one('SELECT assignee_user_id, created_by, title FROM tasks WHERE id = ?', [$id]);
            if (!$t) throw new AppError('not_found');
            if ($me->role !== 'manager' && $t['assignee_user_id'] !== $me->id) throw new AppError('forbidden');
            $c = $db->insert('task_comments', ['task_id' => $id, 'user_id' => $me->id, 'text' => $body['text'] ?? null, 'file_id' => $body['file_id'] ?? null, 'created_by' => $me->id]);
            $other = $me->id === $t['assignee_user_id'] ? $t['created_by'] : $t['assignee_user_id'];
            if ($other && $other !== $me->id) Notify::send($db, ['userId' => $other, 'kind' => 'task_comment', 'title' => "نظر جدید روی کار «{$t['title']}»", 'entity' => 'tasks', 'entityId' => $id]);
            return Response::json($c, 201);
        });

        // ---- notifications ----
        $r->get('/notifications', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $q = V::object(['unread' => V::boolQuery()->optional(), 'limit' => V::coerceNumber()->int()->min(1)->max(100)->default(50)])->parse($req->query);
            $db = $app->db();
            $items = $db->all('SELECT * FROM notifications WHERE user_id = ?' . (!empty($q['unread']) ? ' AND read_at IS NULL' : '') . ' ORDER BY created_at DESC LIMIT ' . (int) $q['limit'], [$me->id]);
            $unread = (int) $db->value('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL', [$me->id]);
            return ['items' => $items, 'unread' => $unread];
        });
        $r->post('/notifications/read', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $body = V::object(['ids' => V::array(V::string()->uuid())->max(200)->optional(), 'all' => V::boolean()->optional()])->parse(self::bodyOrEmpty($req));
            $sql = 'UPDATE notifications SET read_at = NOW(3) WHERE user_id = ? AND read_at IS NULL';
            $params = [$me->id];
            if (empty($body['all'])) {
                if (empty($body['ids'])) return ['ok' => true];
                $sql .= ' AND id IN (' . Db::placeholders($body['ids']) . ')';
                array_push($params, ...$body['ids']);
            }
            $app->db()->exec($sql, $params);
            return ['ok' => true];
        });

        // ---- share links (T44) ----
        $r->post('/share-links', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $body = V::object([
                'scope_type' => V::enum(['daily_report', 'document', 'bundle_gallery']),
                'scope_id' => V::string()->uuid()->optional(),
                'scope_date' => V::string()->optional(),
                'expires_in_days' => V::int()->min(1)->max(90)->default(7),
            ])->parse($req->body());
            if ($body['scope_type'] === 'daily_report' && empty($body['scope_date'])) throw new AppError('validation', 'تاریخ گزارش لازم است', ['scope_date' => 'لازم است']);
            if ($body['scope_type'] !== 'daily_report' && empty($body['scope_id'])) throw new AppError('validation', 'شناسه لازم است', ['scope_id' => 'لازم است']);
            $db = $app->db();
            if ($body['scope_type'] === 'document') {
                $kind = $db->value('SELECT kind FROM documents WHERE id = ?', [$body['scope_id']]);
                if ($kind === null) throw new AppError('not_found');
                if (!in_array($kind, ['invoice', 'sales_return'], true)) throw new AppError('validation', 'فقط فاکتور و برگشت فروش قابل اشتراک است');
            }
            $token = Session::newToken();
            $ms = (int) floor(microtime(true) * 1000) + (int) $body['expires_in_days'] * 86400000;
            $expires = (new \DateTimeImmutable('@' . intdiv($ms, 1000)))->modify('+' . ($ms % 1000) . ' milliseconds');
            $scopeDate = !empty($body['scope_date']) ? DailyReport::dateKey(self::jalaliDateArg($body['scope_date'])) : null;
            $row = $db->insert('share_links', [
                'token_hash' => self::sha($token), 'scope_type' => $body['scope_type'], 'scope_id' => $body['scope_id'] ?? null,
                'scope_date' => $scopeDate, 'expires_at' => $expires, 'created_by' => $me->id,
            ]);
            Audit::log($db, ['userId' => $me->id, 'entity' => 'share_links', 'entityId' => $row['id'], 'action' => 'create', 'after' => ['scope_type' => $row['scope_type'], 'scope_id' => $row['scope_id'], 'expires_at' => $row['expires_at']]]);
            return Response::json(['id' => $row['id'], 'url' => "/s/{$token}", 'expires_at' => $row['expires_at'], 'scope_type' => $row['scope_type']], 201);
        });
        $r->get('/share-links', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $sql = 'SELECT id, scope_type, scope_id, scope_date, expires_at, revoked, open_count, last_opened_at, created_at, created_by FROM share_links';
            $params = [];
            if ($me->role !== 'manager') {
                $sql .= ' WHERE created_by = ?';
                $params[] = $me->id;
            }
            return ['items' => $app->db()->all($sql . ' ORDER BY created_at DESC LIMIT 200', $params)];
        });
        $r->post('/share-links/:id/revoke', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $db = $app->db();
            $l = $db->find('share_links', $id);
            if (!$l) throw new AppError('not_found');
            if ($l['created_by'] !== $me->id && $me->role !== 'manager') throw new AppError('forbidden');
            $db->exec('UPDATE share_links SET revoked = 1 WHERE id = ?', [$id]);
            Audit::log($db, ['userId' => $me->id, 'entity' => 'share_links', 'entityId' => $id, 'action' => 'revoke']);
            return ['ok' => true];
        });

        // ---- daily report ----
        $r->get('/reports/daily', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $q = V::object(['date' => V::string()->max(12)->optional(), 'snapshot' => V::boolQuery()->optional(), 'run_id' => V::string()->uuid()->optional()])->parse($req->query);
            try {
                $date = self::jalaliDateArg(isset($q['date']) && $q['date'] !== '' ? Num::toLatinDigits($q['date']) : null);
            } catch (\Throwable) {
                throw new AppError('validation', 'تاریخ شمسی نامعتبر است', ['date' => 'نامعتبر']);
            }
            $finance = $req->can('finance.view');
            $db = $app->db();
            if (!empty($q['snapshot']) && $finance) {
                $s = $db->one('SELECT * FROM daily_reports WHERE `date` = ?', [DailyReport::dateKey($date)]);
                if ($s) return Json::toArray($s['snapshot']) + ['snapshot_at' => $s['generated_at']];
            }
            $rep = DailyReport::buildDailyReport($db, $date, ['finance' => $finance, 'userId' => $me->id]);
            $snap = $db->value('SELECT generated_at FROM daily_reports WHERE `date` = ?', [DailyReport::dateKey($date)]);
            return $rep + ['snapshot_at' => $snap];
        });
        $r->post('/reports/daily/snapshot', static function (Request $req) use ($app) {
            $me = $req->requirePermission('settings.manage');
            $q = V::object(['date' => V::string()->max(12)->optional()])->parse(self::bodyOrEmpty($req));
            $date = self::jalaliDateArg(isset($q['date']) && $q['date'] !== '' ? Num::toLatinDigits($q['date']) : null);
            DailyReport::snapshotDailyReport($app->db(), $date, $me->id);
            return ['ok' => true];
        });

        // ---- gallery & downloads ----
        $r->get('/gallery', static function (Request $req) use ($app) {
            $req->requireUser();
            $q = V::object([
                'date' => V::string()->max(12)->optional(),
                'party_id' => V::string()->uuid()->optional(),
                'product_id' => V::string()->uuid()->optional(),
                'stage' => V::enum(['production', 'coating', 'transfer', 'scale'])->optional(),
                'bundle_id' => V::string()->uuid()->optional(),
            ])->parse($req->query);
            $range = isset($q['date']) && $q['date'] !== '' ? Jalali::dayRange(self::jalaliDateArg(Num::toLatinDigits($q['date']))) : [];
            return ['items' => self::galleryItems($app->db(), array_merge($q, $range))];
        });
        $r->get('/bundles/:id/photos.zip', static function (Request $req) use ($app) {
            $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $db = $app->db();
            $b = $db->one('SELECT bundles.code, bundles.reported_at, parties.name AS factory FROM bundles LEFT JOIN parties ON parties.id = bundles.factory_party_id WHERE bundles.id = ?', [$id]);
            if (!$b) throw new AppError('not_found');
            $ids = $db->column("SELECT id FROM files WHERE owner_entity = 'bundles' AND owner_id = ?", [$id]);
            $day = Num::toLatinDigits(self::fmt($b['reported_at']));
            $zip = self::zipOf($app, $ids, static fn (array $f, int $i) => "{$day}_" . self::safe($b['factory'] ?? 'vitral') . '_' . self::safe($b['code']) . "_{$i}" . self::ext($f['original_name']));
            return Response::raw($zip, 'application/zip')->header('content-disposition', Xlsx::attachment('bundle_' . self::safe($b['code']) . '.zip'));
        });
        $r->get('/reports/daily/photos.zip', static function (Request $req) use ($app) {
            $req->requireUser();
            $q = V::object(['date' => V::string()->max(12)->optional()])->parse($req->query);
            $date = self::jalaliDateArg(isset($q['date']) && $q['date'] !== '' ? Num::toLatinDigits($q['date']) : null);
            $range = Jalali::dayRange($date);
            $items = self::galleryItems($app->db(), $range);
            $byId = [];
            foreach ($items as $it) $byId[$it['id']] ??= $it;
            $day = self::fmt($range['start']);
            $zip = self::zipOf($app, array_column($items, 'id'), static function (array $f, int $i) use ($byId, $day) {
                $it = $byId[$f['id']] ?? null;
                $place = $it ? explode(' · ', $it['auto_caption'])[0] : 'vitral';
                return "{$day}_" . self::safe($place) . '_' . self::safe($it ? ($it['bundle_code'] ?? $it['stage'] ?? '') : '') . "_{$i}" . self::ext($f['original_name']);
            });
            return Response::raw($zip, 'application/zip')->header('content-disposition', Xlsx::attachment("report_{$day}.zip"));
        });

        // ---- global search ----
        $r->get('/search', static function (Request $req) use ($app) {
            $req->requireUser();
            ['q' => $q] = V::object(['q' => V::string()->trim()->min(1)->max(80)])->parse($req->query);
            $like = '%' . Num::toLatinDigits($q) . '%';
            $db = $app->db();
            return [
                'parties' => $db->all('SELECT id, name, roles, phones FROM parties WHERE merged_into_id IS NULL AND (name LIKE ? OR phones LIKE ?) LIMIT 10', [$like, $like]),
                'products' => $db->all('SELECT id, code, name_fa FROM products WHERE code LIKE ? OR name_fa LIKE ? OR name_ar LIKE ? LIMIT 10', [$like, $like, $like]),
                'orders' => $db->all('SELECT orders.id, orders.number, orders.status_sales, parties.name AS party_name FROM orders INNER JOIN parties ON parties.id = orders.party_id WHERE orders.number LIKE ? OR orders.title LIKE ? LIMIT 10', [$like, $like]),
                'transfers' => $db->all('SELECT id, number, kind, status, plate FROM transfers WHERE number LIKE ? OR plate LIKE ? OR driver_name LIKE ? LIMIT 10', [$like, $like, $like]),
                'bundles' => $db->all('SELECT id, code, weight_kg, status, form FROM bundles WHERE code LIKE ? AND draft = 0 LIMIT 10', [$like]),
            ];
        });

        // ---- telegram link code (spec §16) ----
        $r->post('/telegram/link-code', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $code = (string) random_int(100000, 999998);
            $db = $app->db();
            $db->exec('DELETE FROM telegram_link_codes WHERE user_id = ? AND used_at IS NULL', [$me->id]);
            $db->insertNoReturn('telegram_link_codes', ['user_id' => $me->id, 'code_hash' => self::sha($code), 'expires_at' => new \DateTimeImmutable('+10 minutes'), 'created_by' => $me->id]);
            return ['code' => $code, 'expires_in_seconds' => 600];
        });
        $r->post('/telegram/unlink', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            $app->db()->update('users', ['telegram_chat_id' => null] + Db::bump(), 'id = ?', [$me->id]);
            return ['ok' => true];
        });

        // Correction requests on posted documents (dashboard «درخواست‌های اصلاح سند قطعی»).
        Crud::routes($r, $app, [
            'table' => 'correction_requests', 'path' => '/correction-requests', 'idempotent' => true,
            'createSchema' => V::object(['entity' => V::enum(['documents', 'transfers', 'production_runs', 'bundles']), 'entity_id' => V::string()->uuid(), 'reason' => V::text(2000)->min(3)]),
            'updateSchema' => V::object(V::versionField() + ['status' => V::enum(['done', 'rejected']), 'resolution' => V::optText(2000)]),
            'listSchema' => V::object(['status' => V::enum(['open', 'done', 'rejected'])->optional()]),
            'present' => static fn (array $row) => $row,
            'filter' => static function (Query $qb, array $q): void {
                if (!empty($q['status'])) $qb->where('correction_requests.status = ?', [(string) $q['status']]);
            },
            'afterCreate' => static function (Db $trx, array $row): void {
                Notify::managers($trx, ['kind' => 'correction_request', 'title' => 'درخواست اصلاح: ' . Xlsx::jsSlice((string) $row['reason'], 0, 80), 'entity' => $row['entity'], 'entityId' => $row['entity_id'], 'groupKey' => "corr:{$row['id']}"]);
            },
            'beforeUpdate' => static function (Db $t, array $b, array $patch, AuthUser $user): array {
                if (!Session::can($user, 'finance.post')) throw new AppError('forbidden');
                return $patch + ['resolved_by' => $user->id, 'resolved_at' => Db::raw('NOW(3)')];
            },
        ]);
    }

    /** @return array{status:int,body:mixed} */
    private static function convert(Db $trx, string $id, string $key, array $body, AuthUser $me): array
    {
        $n = $trx->find('free_notes', $id, true);
        if (!$n) throw new AppError('not_found');
        $convIds = is_array($n['converted_document_ids']) ? $n['converted_document_ids'] : [];
        if ($n['status'] === 'converted' && $n['conversion_request_id']) {
            $ids = $convIds ?: [$id];
            $docs = $trx->all('SELECT id, number, kind, status FROM documents WHERE id IN (' . Db::placeholders($ids) . ')', $ids);
            return ['status' => 200, 'body' => ['note_id' => $id, 'documents' => $docs, 'transfer_id' => $n['converted_transfer_id'], 'replayed' => true]];
        }
        if ($n['version'] !== $body['version']) throw AppError::conflict(self::presentNote($n, $me));
        $partyId = $body['party_id'] ?? $n['party_id'];
        $amount = $body['amount'] ?? $n['amount'];
        $currency = $body['currency'] ?? $n['currency'] ?? 'TOMAN';
        $desc = $body['description'] ?? Xlsx::jsSlice((string) $n['text'], 0, 200);
        $docDate = $n['occurred_at'] !== null ? substr((string) $n['occurred_at'], 0, 10) : gmdate('Y-m-d');
        $created = [];
        $transferId = null;
        $effect = $body['effect'];
        if ($effect === 'link_transfer') {
            if (empty($body['transfer_id'])) throw new AppError('validation', 'شماره بار لازم است', ['transfer_id' => 'لازم است']);
            $transferId = $body['transfer_id'];
            try {
                foreach ($trx->column("SELECT file_id FROM file_links WHERE entity = 'free_notes' AND entity_id = ?", [$id]) as $fid) {
                    $trx->exec('INSERT IGNORE INTO file_links (id, file_id, entity, entity_id, created_by) VALUES (?, ?, ?, ?, ?)', [Db::uuid(), $fid, 'transfers', $transferId, $me->id]);
                }
            } catch (\PDOException) {
                // the Node code swallows a failed link insert (.catch(() => undefined))
            }
        } else {
            if ($amount === null) throw new AppError('validation', 'مبلغ لازم است', ['amount' => 'لازم است']);
            $orderId = array_key_exists('order_id', $body) && $body['order_id'] !== null ? $body['order_id'] : $n['order_id'];
            if ($effect === 'expense') {
                $docId = $trx->insertNoReturn('documents', [
                    'number' => Numbering::next($trx, 'expense'), 'kind' => 'expense', 'party_id' => $partyId, 'order_id' => $orderId, 'amount' => $amount, 'currency' => $currency,
                    'status' => 'posted', 'posted_by' => $me->id, 'posted_at' => Db::raw('NOW(3)'),
                    'expense_type' => $body['expense_type'] ?? ($orderId ? 'order' : 'general'), 'expense_category' => $body['expense_category'] ?? $n['topic'],
                    'description' => $desc, 'source_type' => 'free_note', 'source_id' => $id, 'date' => $docDate, 'created_by' => $me->id,
                ]);
                if ($orderId) $trx->insertNoReturn('expense_shares', ['document_id' => $docId, 'order_id' => $orderId, 'amount' => $amount, 'currency' => $currency, 'created_by' => $me->id]);
                $created[] = $docId;
            }
            $purchaseId = $body['purchase_document_id'] ?? null;
            if ($effect === 'purchase' || $effect === 'purchase_and_payment') {
                if (!$partyId) throw new AppError('validation', 'فروشنده لازم است', ['party_id' => 'لازم است']);
                $kind = $body['purchase_kind'] ?? ($n['topic'] === 'paint_purchase' ? 'paint_powder' : ($n['topic'] === 'tool_purchase' ? 'tool' : 'other'));
                $lotId = null;
                if ($kind !== 'other') $lotId = $trx->insertNoReturn('material_lots', ['kind' => $kind, 'description' => $desc, 'created_by' => $me->id]);
                $kg = $body['kg'] ?? $n['kg'];
                $hasKg = $kg !== null && $kg !== '';
                $docId = $trx->insertNoReturn('documents', [
                    'number' => Numbering::next($trx, 'purchase'), 'kind' => 'purchase', 'party_id' => $partyId, 'amount' => $amount, 'currency' => $currency,
                    'status' => 'posted', 'posted_by' => $me->id, 'posted_at' => Db::raw('NOW(3)'), 'purchase_kind' => $kind, 'material_lot_id' => $lotId, 'agreed_kg' => $kg,
                    'unit_price' => $hasKg && !Decimal::of($kg)->isZero() ? Num::round(Decimal::of($amount)->div($kg), $currency) : null,
                    'description' => $desc, 'source_type' => 'free_note', 'source_id' => $id, 'date' => $docDate, 'created_by' => $me->id,
                ]);
                if ($lotId && $hasKg) {
                    $to = $body['receive_to_location_id'] ?? $n['location_id'] ?? Stock::OWN_WAREHOUSE($trx);
                    Stock::move($trx, [
                        'item_type' => 'material_lot', 'item_id' => $lotId, 'from_location_id' => null, 'to_location_id' => $to, 'kg' => $kg,
                        'state_to' => $kind === 'paint_powder' ? 'paint' : ($kind === 'tool' ? 'tool' : ($kind === 'scrap' ? 'scrap' : 'ingot')),
                        'ref_type' => 'purchase_receipt', 'ref_id' => $docId, 'unit_cost' => Num::round(Decimal::of($amount)->div($kg), $currency), 'currency' => $currency, 'userId' => $me->id,
                    ]);
                    $trx->exec('UPDATE documents SET received_kg = ? WHERE id = ?', [$kg, $docId]);
                }
                $created[] = $docId;
                $purchaseId = $docId;
            }
            if ($effect === 'payment_for_purchase' || $effect === 'purchase_and_payment') {
                if (!$purchaseId) throw new AppError('validation', 'سند خرید لازم است', ['purchase_document_id' => 'لازم است']);
                $p = $trx->find('documents', $purchaseId);
                if (!$p) throw new \RuntimeException('no result');
                $docId = $trx->insertNoReturn('documents', [
                    'number' => Numbering::next($trx, 'payment'), 'kind' => 'payment', 'party_id' => $p['party_id'], 'amount' => $amount, 'currency' => $currency,
                    'method' => $body['method'], 'account_id' => $body['account_id'] ?? null, 'status' => 'posted', 'posted_by' => $me->id, 'posted_at' => Db::raw('NOW(3)'),
                    'description' => "پرداخت {$p['number']}: {$desc}", 'source_type' => 'free_note', 'source_id' => $id, 'date' => $docDate, 'created_by' => $me->id,
                ]);
                $alloc = Decimal::min(Decimal::of($amount), Decimal::of($p['amount'] ?? $amount));
                // the over-allocation trigger may be missing on shared hosts: check here as well
                $already = (string) ($trx->value('SELECT COALESCE(SUM(amount), 0) FROM allocations WHERE from_document_id = ?', [$docId]) ?? '0');
                if (Decimal::of($already)->add($alloc)->gt($amount)) throw new AppError('over_allocation');
                try {
                    $trx->insertNoReturn('allocations', ['from_document_id' => $docId, 'to_document_id' => $p['id'], 'amount' => $alloc->toFixed(2), 'currency' => $currency, 'created_by' => $me->id]);
                } catch (\PDOException $e) {
                    if (str_contains($e->getMessage(), 'over_allocation')) throw new AppError('over_allocation');
                    throw $e;
                }
                $created[] = $docId;
            }
        }
        $trx->update('free_notes', [
            'status' => 'converted', 'converted_document_ids' => $created, 'converted_transfer_id' => $transferId, 'conversion_request_id' => $key,
            'reviewed_by' => $me->id, 'reviewed_at' => Db::raw('NOW(3)'),
        ] + Db::bump(), 'id = ?', [$id]);
        $trx->exec('UPDATE notifications SET read_at = NOW(3) WHERE group_key = ? AND read_at IS NULL', ["note:{$id}"]);
        if ($n['created_by']) Notify::send($trx, ['userId' => $n['created_by'], 'kind' => 'note_converted', 'title' => 'ثبت شما به سند تبدیل شد', 'entity' => 'free_notes', 'entityId' => $id]);
        Audit::log($trx, ['userId' => $me->id, 'entity' => 'free_notes', 'entityId' => $id, 'action' => 'convert', 'after' => ['effect' => $effect, 'documents' => $created, 'transfer_id' => $transferId]]);
        $docs = $created ? $trx->all('SELECT id, number, kind, status FROM documents WHERE id IN (' . Db::placeholders($created) . ')', $created) : [];
        return ['status' => 200, 'body' => ['note_id' => $id, 'documents' => $docs, 'transfer_id' => $transferId, 'replayed' => false]];
    }

    /** yyyymmdd of the Jalali (Tehran) date of an instant (require_fmt). */
    private static function fmt(string $at): string
    {
        $j = Jalali::of($at);
        return sprintf('%d%02d%02d', $j['jy'], $j['jm'], $j['jd']);
    }

    private static function safe(string $s): string
    {
        return (string) preg_replace('/[\\\\\/:*?"<>|\s\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]+/u', '_', $s);
    }

    private static function ext(string $name): string
    {
        return preg_match('/\.[a-z0-9]{2,5}$/i', $name, $m) ? strtolower($m[0]) : '.jpg';
    }

    /** @param list<string> $ids @param callable(array,int):string $namer */
    private static function zipOf(App $app, array $ids, callable $namer): string
    {
        $files = $ids ? $app->db()->all('SELECT * FROM files WHERE id IN (' . Db::placeholders($ids) . ') AND `sensitive` = 0 ORDER BY created_at, id', array_values($ids)) : [];
        $entries = [];
        $i = 1;
        foreach ($files as $f) $entries[] = ['name' => $namer($f, $i++), 'data' => $app->storage()->read($f['storage_key']), 'mtime' => $f['created_at']];
        return Zip::buildZip($entries);
    }
}
