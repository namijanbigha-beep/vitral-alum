<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * Port of apps/server/src/lib/crud.ts: list (cursor pages) / get / create / patch routes with the version check,
 * audit and (optionally) idempotency. Options:
 *   table, path, entity?, createSchema, updateSchema, listSchema?, readPermission?, writePermission?,
 *   present(row, AuthUser): mixed,
 *   filter?(Query, array $query, AuthUser): void,
 *   beforeCreate?(Db, array $input, AuthUser): array, beforeUpdate?(Db, array $before, array $patch, AuthUser): array,
 *   afterCreate?(Db, array $row, array $input, AuthUser): void, afterUpdate?(Db, array $before, array $after, AuthUser): void,
 *   orderBy? (default created_at), idempotent? (POST requires Idempotency-Key), loadOne?(Db, string $id, AuthUser): ?array
 */
final class Crud
{
    /** @param array<string,mixed> $o */
    public static function routes(Router $r, App $app, array $o): void
    {
        $table = $o['table'];
        $entity = $o['entity'] ?? $table;
        $orderCol = $o['orderBy'] ?? 'created_at';
        $userCan = static fn (Request $req, ?string $p): AuthUser => $p ? $req->requirePermission($p) : $req->requireUser();
        $present = $o['present'];

        $r->get($o['path'], function (Request $req) use ($app, $o, $table, $orderCol, $userCan, $present) {
            $user = $userCan($req, $o['readPermission'] ?? null);
            $base = isset($o['listSchema']) ? V::listQuery()->merge($o['listSchema']) : V::listQuery();
            $q = $base->passthrough()->parse($req->query);
            $qb = Query::from($table)->limit($q['limit'] + 1);
            if (isset($o['filter'])) ($o['filter'])($qb, $q, $user);
            $desc = ($q['order'] ?? null) === 'desc';
            $qb->orderBy("{$table}.{$orderCol}", $desc ? 'desc' : 'asc')->orderBy("{$table}.id", $desc ? 'desc' : 'asc');
            $cursor = Pagination::decodeCursor($q['cursor'] ?? null);
            if ($cursor) {
                $cmp = $desc ? '<' : '>';
                $qb->where('(' . Db::ident("{$table}.{$orderCol}") . ', ' . Db::ident("{$table}.id") . ") {$cmp} (?, ?)", [Pagination::atParam($cursor), $cursor['id']]);
            }
            $rows = $qb->all($app->db());
            return Pagination::page($rows, $q['limit'], static fn ($row) => $present($row, $user), $orderCol);
        });

        $r->get($o['path'] . '/:id', function (Request $req) use ($app, $o, $table, $userCan, $present) {
            $user = $userCan($req, $o['readPermission'] ?? null);
            $id = V::idParam()->parse($req->params)['id'];
            $row = isset($o['loadOne']) ? ($o['loadOne'])($app->db(), $id, $user) : $app->db()->find($table, $id);
            if (!$row) throw new AppError('not_found');
            return $present($row, $user);
        });

        $r->post($o['path'], function (Request $req) use ($app, $o, $table, $entity, $userCan, $present) {
            $user = $userCan($req, $o['writePermission'] ?? null);
            $input = $o['createSchema']->parse($req->body());
            $work = function (Db $trx) use ($o, $table, $entity, $input, $user, $present) {
                $values = isset($o['beforeCreate']) ? ($o['beforeCreate'])($trx, $input, $user) : $input;
                $row = $trx->insert($table, array_merge($values, ['created_by' => $user->id]));
                if (isset($o['afterCreate'])) ($o['afterCreate'])($trx, $row, $input, $user);
                Audit::log($trx, ['userId' => $user->id, 'entity' => $entity, 'entityId' => $row['id'], 'action' => 'create', 'after' => $row]);
                $full = isset($o['loadOne']) ? (($o['loadOne'])($trx, $row['id'], $user) ?? $row) : $row;
                return ['status' => 201, 'body' => $present($full, $user)];
            };
            if (!empty($o['idempotent'])) {
                $key = $req->idempotencyKey();
                $res = Idempotency::run($app->db(), $key, $user->id, 'POST ' . $o['path'], $work);
            } else {
                $res = $app->db()->transaction($work);
            }
            return Response::json($res['body'], $res['status']);
        });

        $r->patch($o['path'] . '/:id', function (Request $req) use ($app, $o, $table, $entity, $userCan, $present) {
            $user = $userCan($req, $o['writePermission'] ?? null);
            $id = V::idParam()->parse($req->params)['id'];
            $body = $o['updateSchema']->parse($req->body());
            $version = $body['version'];
            $reason = $body['reason'] ?? null;
            unset($body['version'], $body['reason']);
            return $app->db()->transaction(function (Db $trx) use ($o, $table, $entity, $id, $version, $reason, $body, $user, $present) {
                $before = $trx->find($table, $id, true);
                if (!$before) throw new AppError('not_found');
                if ($before['version'] !== $version) throw AppError::conflict($present($before, $user));
                $patch = isset($o['beforeUpdate']) ? ($o['beforeUpdate'])($trx, $before, $body, $user) : $body;
                $after = $trx->updateById($table, $id, array_merge($patch, Db::bump()));
                if (isset($o['afterUpdate'])) ($o['afterUpdate'])($trx, $before, $after, $user);
                Audit::log($trx, ['userId' => $user->id, 'entity' => $entity, 'entityId' => $id, 'action' => 'update', 'before' => $before, 'after' => $after, 'reason' => $reason]);
                $full = isset($o['loadOne']) ? (($o['loadOne'])($trx, $id, $user) ?? $after) : $after;
                return $present($full, $user);
            });
        });
    }
}
