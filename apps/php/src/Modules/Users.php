<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\Auth as Session;
use Vitral\Core\Db;
use Vitral\Core\Idempotency;
use Vitral\Core\Pagination;
use Vitral\Core\Permissions;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\V;
use Vitral\Core\Versioning;

/** Port of apps/server/src/modules/users (routes.ts + service.ts). */
final class Users
{
    /** The single public view of a user. Never includes password_hash or the Telegram chat id. */
    public static function present(array $u): array
    {
        return [
            'id' => $u['id'],
            'mobile' => $u['mobile'],
            'name' => $u['name'],
            'short_name' => $u['short_name'],
            'role' => $u['role'],
            'permissions' => $u['permissions'],
            'effective_permissions' => Permissions::effective($u['role'], $u['permissions']),
            'active' => $u['active'],
            'locked_until' => $u['locked_until'],
            'telegram_linked' => $u['telegram_chat_id'] !== null,
            'created_at' => $u['created_at'],
            'updated_at' => $u['updated_at'],
            'version' => $u['version'],
        ];
    }

    public static function register(Router $r, App $app): void
    {
        $present = [self::class, 'present'];

        $r->get('/users', static function (Request $req) use ($app, $present) {
            $req->requirePermission('settings.manage');
            $q = V::listQuery()->extend([
                'active' => V::enum(['true', 'false'])->optional(),
                'q' => V::string()->max(100)->optional(),
            ])->parse($req->query);
            $where = [];
            $params = [];
            if (isset($q['active'])) {
                $where[] = 'active = ?';
                $params[] = $q['active'] === 'true' ? 1 : 0;
            }
            if (isset($q['q']) && $q['q'] !== '') {
                $where[] = '(name LIKE ? OR mobile LIKE ?)';
                $like = Db::like($q['q']);
                array_push($params, $like, $like);
            }
            $cursor = Pagination::decodeCursor($q['cursor'] ?? null);
            if ($cursor) {
                $where[] = '(created_at > ? OR (created_at = ? AND id > ?))';
                $at = Pagination::atParam($cursor);
                array_push($params, $at, $at, $cursor['id']);
            }
            $sql = 'SELECT * FROM users' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY created_at, id LIMIT ' . ($q['limit'] + 1);
            return Pagination::page($app->db()->all($sql, $params), $q['limit'], $present);
        });

        // Names only, for assigning tasks and @mentions; any signed-in user.
        $r->get('/users/directory', static function (Request $req) use ($app) {
            $req->requireUser();
            return ['items' => $app->db()->all('SELECT id, name, short_name, role FROM users WHERE active = 1 ORDER BY name')];
        });

        $r->get('/users/:id', static function (Request $req) use ($app, $present) {
            $req->requirePermission('settings.manage');
            ['id' => $id] = V::idParam()->parse($req->params);
            $row = $app->db()->find('users', $id);
            if (!$row) throw new AppError('not_found');
            return $present($row);
        });

        $r->post('/users', static function (Request $req) use ($app, $present) {
            $me = $req->requirePermission('settings.manage');
            $key = Idempotency::requireKey($req);
            $body = V::object([
                'mobile' => V::mobile(),
                'name' => V::string()->trim()->min(1, 'نام لازم است')->max(120),
                'short_name' => V::string()->trim()->max(40)->nullable()->optional(),
                'password' => V::password(),
                'role' => V::role(),
                'permissions' => V::array(V::permission())->default([]),
            ])->parse($req->body());
            $hash = Session::hashPassword($body['password']);
            $result = Idempotency::run($app->db(), $key, $me->id, 'POST /users', static function (Db $trx) use ($body, $hash, $me, $present) {
                if ($trx->value('SELECT id FROM users WHERE mobile = ?', [$body['mobile']]) !== null) {
                    throw new AppError('validation', 'این شماره موبایل قبلاً ثبت شده است', ['mobile' => 'تکراری']);
                }
                $row = $trx->insert('users', [
                    'mobile' => $body['mobile'],
                    'name' => $body['name'],
                    'short_name' => $body['short_name'] ?? null,
                    'password_hash' => $hash,
                    'role' => $body['role'],
                    'permissions' => $body['role'] === 'manager' ? [] : $body['permissions'],
                    'created_by' => $me->id,
                ]);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'users', 'entityId' => $row['id'], 'action' => 'create', 'after' => $present($row)]);
                return ['status' => 201, 'body' => $present($row)];
            });
            return Response::json($result['body'], $result['status']);
        });

        $r->patch('/users/:id', static function (Request $req) use ($app, $present) {
            $me = $req->requirePermission('settings.manage');
            ['id' => $id] = V::idParam()->parse($req->params);
            $body = V::object([
                'version' => V::int()->nonnegative(),
                'name' => V::string()->trim()->min(1)->max(120)->optional(),
                'short_name' => V::string()->trim()->max(40)->nullable()->optional(),
                'role' => V::role()->optional(),
                'permissions' => V::array(V::permission())->optional(),
                'active' => V::boolean()->optional(),
                'reason' => V::string()->trim()->max(500)->optional(),
            ])->parse($req->body());
            $active = $body['active'] ?? null;
            if ($id === $me->id && ($active === false || (isset($body['role']) && $body['role'] !== 'manager'))) {
                throw new AppError('validation', 'نمی‌توانید حساب یا نقش مدیریتی خودتان را غیرفعال کنید');
            }
            return $app->db()->transaction(static function (Db $trx) use ($id, $body, $active, $me, $present) {
                $before = Versioning::lockForUpdate($trx, 'users', $id, $body['version'], $present);
                $patch = [];
                foreach (['name', 'short_name', 'role', 'permissions', 'active'] as $k) {
                    if (array_key_exists($k, $body)) $patch[$k] = $body[$k];
                }
                if ($active === true) {
                    $patch['failed_logins'] = 0;
                    $patch['locked_until'] = null;
                }
                $after = $trx->updateById('users', $id, $patch + Db::bump());
                // Section 6: deactivation (or any change of role/permissions) ends the user's sessions at once.
                if ($active === false || array_key_exists('role', $body) || array_key_exists('permissions', $body)) {
                    $trx->exec('DELETE FROM sessions WHERE user_id = ?', [$id]);
                }
                $action = $active === false ? 'deactivate' : ($active === true && !$before['active'] ? 'activate' : 'update');
                Audit::log($trx, [
                    'userId' => $me->id,
                    'entity' => 'users',
                    'entityId' => $id,
                    'action' => $action,
                    'before' => $present($before),
                    'after' => $present($after),
                    'reason' => $body['reason'] ?? null,
                ]);
                return $present($after);
            });
        });

        $r->post('/users/:id/reset-password', static function (Request $req) use ($app, $present) {
            $me = $req->requirePermission('settings.manage');
            ['id' => $id] = V::idParam()->parse($req->params);
            $body = V::object(['version' => V::int()->nonnegative(), 'new_password' => V::password()])->parse($req->body());
            $hash = Session::hashPassword($body['new_password']);
            return $app->db()->transaction(static function (Db $trx) use ($id, $body, $hash, $me, $present) {
                Versioning::lockForUpdate($trx, 'users', $id, $body['version'], $present);
                $after = $trx->updateById('users', $id, ['password_hash' => $hash, 'failed_logins' => 0, 'locked_until' => null] + Db::bump());
                $trx->exec('DELETE FROM sessions WHERE user_id = ?', [$id]);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'users', 'entityId' => $id, 'action' => 'password_reset']);
                return $present($after);
            });
        });
    }
}
