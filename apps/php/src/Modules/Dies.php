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
use Vitral\Core\Json;
use Vitral\Core\Notify;
use Vitral\Core\Numbering;
use Vitral\Core\Query;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\Schema;
use Vitral\Core\V;
use Vitral\Lib\Num;

/** Port of apps/server/src/modules/dies/routes.ts (dies, die events, die orders with six steps). */
final class Dies
{
    public const DIE_STATUS = ['design', 'making', 'ready', 'needs_repair', 'retired'];
    public const STEPS = ['drawing_received', 'quoted', 'ordered', 'delivered', 'trial_run', 'registered'];

    /** @return array<string,Schema> */
    private static function base(bool $create): array
    {
        return [
            'code' => $create ? V::text(40)->min(1) : V::text(40)->min(1)->optional(),
            'name' => V::optText(200),
            'product_id' => V::uuid()->nullable()->optional(),
            'owner_party_id' => V::uuid()->nullable()->optional(),
            'location_id' => V::uuid()->nullable()->optional(),
            'compatible_press' => V::optText(100),
            'maker_party_id' => V::uuid()->nullable()->optional(),
            'status' => $create ? V::enum(self::DIE_STATUS)->default('ready') : V::enum(self::DIE_STATUS)->optional(),
            'note' => V::optText(2000),
        ];
    }

    /** @return array<string,Schema> */
    private static function dieOrderBase(bool $create): array
    {
        return [
            'customer_party_id' => V::uuid()->nullable()->optional(),
            'maker_party_id' => V::uuid()->nullable()->optional(),
            'die_id' => V::uuid()->nullable()->optional(),
            'order_line_id' => V::uuid()->nullable()->optional(),
            'maker_cost' => V::decimalString()->nullable()->optional(),
            'currency' => $create ? V::enum(Num::CURRENCIES)->default('TOMAN') : V::enum(Num::CURRENCIES)->optional(),
            'due_date' => V::dateOnly()->nullable()->optional(),
            'note' => V::optText(2000),
        ];
    }

    public static function presentDie(array $d): array
    {
        return [
            'id' => $d['id'], 'code' => $d['code'], 'name' => $d['name'], 'product_id' => $d['product_id'], 'owner_party_id' => $d['owner_party_id'], 'location_id' => $d['location_id'], 'compatible_press' => $d['compatible_press'],
            'maker_party_id' => $d['maker_party_id'], 'status' => $d['status'], 'total_produced_kg' => $d['total_produced_kg'], 'run_count' => $d['run_count'], 'last_run_at' => $d['last_run_at'], 'note' => $d['note'], 'version' => $d['version'], 'created_at' => $d['created_at'],
        ];
    }

    public static function presentDieOrder(array $d): array
    {
        return [
            'id' => $d['id'], 'number' => $d['number'], 'customer_party_id' => $d['customer_party_id'], 'maker_party_id' => $d['maker_party_id'], 'die_id' => $d['die_id'], 'order_line_id' => $d['order_line_id'], 'step' => $d['step'],
            'maker_cost' => $d['maker_cost'], 'currency' => $d['currency'], 'due_date' => $d['due_date'], 'steps' => $d['steps'], 'purchase_document_id' => $d['purchase_document_id'], 'note' => $d['note'], 'version' => $d['version'], 'created_at' => $d['created_at'],
        ];
    }

    /** INSERT … ON CONFLICT DO NOTHING of a file link. */
    private static function linkFile(Db $trx, string $fileId, string $entity, string $entityId, string $userId): void
    {
        try {
            $trx->insertNoReturn('file_links', ['file_id' => $fileId, 'entity' => $entity, 'entity_id' => $entityId, 'created_by' => $userId]);
        } catch (\PDOException $e) {
            if (!Db::isDuplicateKey($e)) throw $e;
        }
    }

    public static function register(Router $r, App $app): void
    {
        Crud::routes($r, $app, [
            'table' => 'dies', 'path' => '/dies',
            'createSchema' => V::object(self::base(true)),
            'updateSchema' => V::object(V::versionField() + self::base(false)),
            'listSchema' => V::object(['q' => V::string()->max(100)->optional(), 'product_id' => V::uuid()->optional(), 'status' => V::enum([...self::DIE_STATUS, 'in_transit'])->optional(), 'location_id' => V::uuid()->optional()]),
            'present' => static fn (array $row) => self::presentDie($row),
            'filter' => static function (Query $qb, array $q) {
                if (($q['q'] ?? '') !== '') $qb->where('dies.code LIKE ? OR dies.name LIKE ?', [Db::like((string) $q['q']), Db::like((string) $q['q'])]);
                if (!empty($q['product_id'])) $qb->where('dies.product_id = ?', [(string) $q['product_id']]);
                if (!empty($q['status'])) $qb->where('dies.status = ?', [(string) $q['status']]);
                if (!empty($q['location_id'])) $qb->where('dies.location_id = ?', [(string) $q['location_id']]);
            },
            'orderBy' => 'code',
            'beforeUpdate' => static function (Db $trx, array $before, array $patch) {
                // Cumulative counters are never overwritten by hand (module 1).
                unset($patch['total_produced_kg'], $patch['run_count'], $patch['last_run_at']);
                if (!empty($patch['location_id']) && $patch['location_id'] !== $before['location_id']) throw new AppError('validation', 'جابه‌جایی قالب فقط با بار die_move ثبت می‌شود');
                return $patch;
            },
        ]);

        $r->get('/dies/:id/events', static function (Request $req) use ($app) {
            $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            return ['items' => $app->db()->all('SELECT * FROM die_events WHERE die_id = ? ORDER BY at DESC LIMIT 200', [$id])];
        });

        $r->post('/dies/:id/events', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $body = V::object([
                'kind' => V::enum(['repair', 'filler_check', 'damage', 'note']),
                'at' => V::isoDate()->optional(),
                'detail' => V::optText(2000),
                'measured_filler_mm' => V::decimalString()->nullable()->optional(),
                'file_ids' => V::array(V::uuid())->max(20)->optional(),
            ])->parse($req->body());
            $row = $app->db()->transaction(static function (Db $trx) use ($id, $body, $me) {
                if ($trx->value('SELECT id FROM dies WHERE id = ?', [$id]) === null) throw new AppError('not_found');
                $r = $trx->insert('die_events', [
                    'die_id' => $id, 'kind' => $body['kind'], 'at' => isset($body['at']) ? Db::dt($body['at']) : Db::now(),
                    'detail' => $body['detail'] ?? null, 'measured_filler_mm' => $body['measured_filler_mm'] ?? null, 'created_by' => $me->id,
                ]);
                foreach ($body['file_ids'] ?? [] as $fid) self::linkFile($trx, $fid, 'die_events', $r['id'], $me->id);
                if ($body['kind'] === 'damage') $trx->update('dies', ['status' => 'needs_repair'] + Db::bump(), 'id = ?', [$id]);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'die_events', 'entityId' => $r['id'], 'action' => 'create', 'after' => $r]);
                return $r;
            });
            return Response::json($row, 201);
        });

        // --- die orders (six steps) ---
        $presentDieOrder = static fn (array $row) => self::presentDieOrder($row);
        Crud::routes($r, $app, [
            'table' => 'die_orders', 'path' => '/die-orders',
            'createSchema' => V::object(self::dieOrderBase(true)),
            'updateSchema' => V::object(V::versionField() + self::dieOrderBase(false)),
            'present' => $presentDieOrder,
            'idempotent' => true,
            'beforeCreate' => static fn (Db $trx, array $input, AuthUser $user) => $input + [
                'number' => Numbering::next($trx, 'die_order'),
                'steps' => [['step' => 'drawing_received', 'at' => Json::iso(new \DateTimeImmutable('now')), 'by' => $user->id]],
            ],
            'beforeUpdate' => static function (Db $trx, array $before, array $patch, AuthUser $user) {
                if (array_key_exists('maker_cost', $patch) && !Auth::can($user, 'finance.post')) throw new AppError('forbidden', 'هزینه قالب‌ساز فقط با مجوز مالی ثبت می‌شود');
                return $patch;
            },
        ]);

        /** Advance one step; each step records date, user and optional files; steps 3/4 create and post the purchase document. */
        $r->post('/die-orders/:id/advance', static function (Request $req) use ($app) {
            $me = $req->requireUser();
            ['id' => $id] = V::idParam()->parse($req->params);
            $key = Idempotency::requireKey($req);
            $body = V::object([
                'version' => V::int(),
                'file_ids' => V::array(V::uuid())->max(20)->optional(),
                'note' => V::optText(1000),
                'location_id' => V::uuid()->optional(),
                'owner_party_id' => V::uuid()->nullable()->optional(),
                'production_run_id' => V::uuid()->optional(),
            ])->parse($req->body());
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST die-orders/advance', static function (Db $trx) use ($id, $body, $me) {
                $o = $trx->find('die_orders', $id, true);
                if (!$o) throw new AppError('not_found');
                if ($o['version'] !== $body['version']) throw AppError::conflict(self::presentDieOrder($o));
                $idx = array_search($o['step'], self::STEPS, true);
                $next = self::STEPS[($idx === false ? -1 : $idx) + 1] ?? null;
                if ($next === null) throw new AppError('validation', 'سفارش قالب در گام آخر است');
                if ($next === 'registered' && $me->role !== 'manager') throw new AppError('forbidden', 'ثبت رسمی قالب فقط با مدیر');
                $patch = ['step' => $next];
                if ($next === 'ordered') {
                    if (!$o['maker_party_id']) throw new AppError('validation', 'قالب‌ساز مشخص نیست', ['maker_party_id' => 'لازم است']);
                    $patch['purchase_document_id'] = $trx->insertNoReturn('documents', [
                        'number' => Numbering::next($trx, 'purchase'), 'kind' => 'purchase', 'party_id' => $o['maker_party_id'], 'amount' => $o['maker_cost'], 'currency' => $o['currency'], 'status' => 'draft',
                        'source_type' => 'die_order', 'source_id' => $o['id'], 'purchase_kind' => 'die', 'description' => 'ساخت قالب ' . $o['number'], 'created_by' => $me->id,
                    ]);
                }
                if ($next === 'delivered') {
                    if ($o['purchase_document_id']) {
                        $doc = $trx->one('SELECT amount FROM documents WHERE id = ?', [$o['purchase_document_id']]);
                        if (!$doc) throw new \RuntimeException('no result');
                        $none = $doc['amount'] === null;
                        $trx->update('documents', [
                            'status' => $none ? 'needs_completion' : 'posted', 'posted_by' => $none ? null : $me->id, 'posted_at' => $none ? null : Db::now(),
                        ] + Db::bump(), 'id = ?', [$o['purchase_document_id']]);
                    }
                    if ($o['die_id'] && !empty($body['location_id'])) $trx->update('dies', ['location_id' => $body['location_id'], 'status' => 'ready'] + Db::bump(), 'id = ?', [$o['die_id']]);
                }
                if ($next === 'registered' && $o['die_id']) {
                    $trx->update('dies', ['status' => 'ready', 'owner_party_id' => $body['owner_party_id'] ?? null] + Db::bump(), 'id = ?', [$o['die_id']]);
                    $productId = $trx->value('SELECT product_id FROM dies WHERE id = ?', [$o['die_id']]);
                    if ($productId) $trx->update('products', ['active' => true] + Db::bump(), 'id = ?', [$productId]);
                }
                $steps = is_array($o['steps']) ? $o['steps'] : [];
                $steps[] = [
                    'step' => $next, 'at' => Json::iso(new \DateTimeImmutable('now')), 'by' => $me->id, 'note' => $body['note'] ?? null,
                    'file_ids' => $body['file_ids'] ?? [], 'production_run_id' => $body['production_run_id'] ?? null,
                ];
                $after = $trx->updateById('die_orders', $id, $patch + ['steps' => $steps] + Db::bump());
                foreach ($body['file_ids'] ?? [] as $fid) self::linkFile($trx, $fid, 'die_orders', $id, $me->id);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'die_orders', 'entityId' => $id, 'action' => "step:{$next}", 'before' => $o, 'after' => $after]);
                if ($next === 'delivered') Notify::managers($trx, ['kind' => 'die_delivered', 'title' => 'قالب ' . $o['number'] . ' تحویل شد', 'entity' => 'die_orders', 'entityId' => $id, 'groupKey' => "die_delivered:{$id}"]);
                return ['status' => 200, 'body' => self::presentDieOrder($after)];
            });
            return $res['body'];
        });
    }
}
