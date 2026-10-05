<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\Auth as Session;
use Vitral\Core\Db;
use Vitral\Core\Permissions;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\V;

/** Port of apps/server/src/modules/auth/routes.ts: login (with lockout), logout, me, change-password. */
final class Auth
{
    private const MAX_FAILED = 5;
    private const LOCK_MINUTES = 15;

    /** Spent on unknown mobiles so they take as long as a wrong password (same algorithm and cost as real hashes). */
    private const DUMMY_ARGON2 = '$argon2id$v=19$m=19456,t=2,p=1$dTdNZS5DWXd2MWZXZk5IeA$9mgcR/DcUIr7d4ToOgZi1LVATOkk9SlfFtj26GxP8B8';
    private const DUMMY_BCRYPT = '$2y$11$y/rHZ4fikyHiHv3BsSvdD.pFk7pah8S5SQDTdH3ngX27AfMRdHo4a';

    public static function register(Router $r, App $app): void
    {
        $r->post('/auth/login', static fn (Request $req) => self::login($req, $app), [
            'rateLimit' => ['max' => $app->config->int('LOGIN_RATE_LIMIT_PER_MINUTE'), 'window' => 60],
        ]);
        $r->post('/auth/logout', static fn (Request $req) => self::logout($req, $app));
        $r->get('/auth/me', static fn (Request $req) => self::me($req, $app));
        $r->post('/auth/change-password', static fn (Request $req) => self::changePassword($req, $app));
    }

    private static function login(Request $req, App $app): Response
    {
        $db = $app->db();
        $body = V::object(['mobile' => V::mobile(), 'password' => V::string()->min(1)->max(200)])->parse($req->body());
        $user = $db->one('SELECT * FROM users WHERE mobile = ?', [$body['mobile']]);
        $invalid = new AppError('unauthorized', 'شماره موبایل یا رمز درست نیست');

        if (!$user || !$user['active']) {
            Session::verifyPassword(defined('PASSWORD_ARGON2ID') ? self::DUMMY_ARGON2 : self::DUMMY_BCRYPT, $body['password']);
            throw $invalid;
        }
        if ($user['locked_until'] !== null && strtotime($user['locked_until']) > time()) {
            throw new AppError('locked', 'حساب پس از ' . self::MAX_FAILED . ' تلاش ناموفق موقتاً قفل است؛ ' . self::LOCK_MINUTES . ' دقیقه بعد تلاش کنید');
        }

        if (!Session::verifyPassword($user['password_hash'], $body['password'])) {
            $failed = $user['failed_logins'] + 1;
            $lock = $failed >= self::MAX_FAILED;
            $db->transaction(function (Db $trx) use ($user, $failed, $lock) {
                $trx->update('users', [
                    'failed_logins' => $lock ? 0 : $failed,
                    'locked_until' => $lock ? Db::dt(new \DateTimeImmutable('+' . self::LOCK_MINUTES . ' minutes')) : Db::dt($user['locked_until']),
                ], 'id = ?', [$user['id']]);
                if ($lock) Audit::log($trx, ['userId' => null, 'entity' => 'users', 'entityId' => $user['id'], 'action' => 'locked', 'reason' => 'failed logins']);
            });
            if ($lock) throw new AppError('locked', 'حساب پس از ' . self::MAX_FAILED . ' تلاش ناموفق برای ' . self::LOCK_MINUTES . ' دقیقه قفل شد');
            throw $invalid;
        }

        $token = Session::newToken();
        $expires = time() + $app->config->int('SESSION_TTL_DAYS') * 86400;
        $db->transaction(function (Db $trx) use ($user, $token, $expires, $req, $app, $body) {
            $set = ['failed_logins' => 0, 'locked_until' => null];
            // a hash made with an older algorithm/cost is upgraded transparently on a successful login
            if (password_needs_rehash($user['password_hash'], defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_BCRYPT, defined('PASSWORD_ARGON2ID') ? ['memory_cost' => 19456, 'time_cost' => 2, 'threads' => 1] : ['cost' => 11])) {
                $set['password_hash'] = Session::hashPassword($body['password']);
            }
            $trx->update('users', $set, 'id = ?', [$user['id']]);
            self::createSession($trx, $app, $user['id'], $token, $expires, $req);
            // Housekeeping: drop this user's expired sessions.
            $trx->exec('DELETE FROM sessions WHERE user_id = ? AND expires_at < NOW(3)', [$user['id']]);
        });
        return Response::json(['ok' => true])->cookie(Session::sessionCookie($token, $expires, $app->config->bool('COOKIE_SECURE')));
    }

    private static function createSession(Db $trx, App $app, string $userId, string $token, int $expires, Request $req): void
    {
        $ua = mb_substr($req->header('user-agent') ?? '', 0, 300);
        $trx->insertNoReturn('sessions', [
            'user_id' => $userId,
            'created_by' => $userId,
            'token_hash' => Session::hashToken($app->config->str('SESSION_SECRET'), $token),
            'expires_at' => Db::dt('@' . $expires),
            'user_agent' => $ua !== '' ? $ua : null,
        ]);
    }

    private static function logout(Request $req, App $app): Response
    {
        $token = $req->cookies[Session::SESSION_COOKIE] ?? null;
        if ($token !== null && $token !== '') {
            $app->db()->exec('DELETE FROM sessions WHERE token_hash = ?', [Session::hashToken($app->config->str('SESSION_SECRET'), $token)]);
        }
        return Response::json(['ok' => true])->cookie(Session::clearSessionCookie($app->config->bool('COOKIE_SECURE')));
    }

    private static function me(Request $req, App $app): array
    {
        $me = $req->requireUser();
        $row = $app->db()->one('SELECT id, mobile, name, short_name, role, version FROM users WHERE id = ?', [$me->id]);
        if (!$row) throw new AppError('unauthorized');
        return [
            'user' => $row + ['permissions' => $me->permissions],
            'permission_labels' => Permissions::LABELS,
            'app_env' => $app->config->str('APP_ENV'),
        ];
    }

    private static function changePassword(Request $req, App $app): Response
    {
        $me = $req->requireUser();
        $body = V::object([
            'current_password' => V::string()->min(1)->max(200),
            'new_password' => V::password(),
        ])->parse($req->body());
        $db = $app->db();
        $user = $db->find('users', $me->id);
        if (!$user || !Session::verifyPassword($user['password_hash'], $body['current_password'])) {
            throw new AppError('validation', 'رمز فعلی درست نیست', ['current_password' => 'رمز فعلی درست نیست']);
        }
        $hash = Session::hashPassword($body['new_password']);
        $token = Session::newToken();
        $expires = time() + $app->config->int('SESSION_TTL_DAYS') * 86400;
        $db->transaction(function (Db $trx) use ($me, $hash, $token, $expires, $req, $app) {
            $trx->update('users', ['password_hash' => $hash] + Db::bump(), 'id = ?', [$me->id]);
            // Every other session ends; this device gets a fresh one.
            $trx->exec('DELETE FROM sessions WHERE user_id = ?', [$me->id]);
            self::createSession($trx, $app, $me->id, $token, $expires, $req);
            Audit::log($trx, ['userId' => $me->id, 'entity' => 'users', 'entityId' => $me->id, 'action' => 'password_changed']);
        });
        return Response::json(['ok' => true])->cookie(Session::sessionCookie($token, $expires, $app->config->bool('COOKIE_SECURE')));
    }
}
