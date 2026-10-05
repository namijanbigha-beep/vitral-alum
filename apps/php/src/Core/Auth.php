<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * Port of apps/server/src/lib/auth.ts: opaque session token in an HttpOnly cookie, stored only as
 * HMAC-SHA256(SESSION_SECRET, token); sliding last_seen_at; bot service identity via X-Bot-Key.
 */
final class Auth
{
    public const SESSION_COOKIE = 'vt_session';

    public static function hashToken(string $secret, string $token): string
    {
        return hash_hmac('sha256', $token, $secret);
    }

    /** 32 random bytes, base64url without padding (Node randomBytes(32).toString('base64url')). */
    public static function newToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    public static function can(?AuthUser $user, string $permission): bool
    {
        return $user !== null && in_array($permission, $user->permissions, true);
    }

    /** Resolve the session cookie to an active user; deactivated users and expired sessions give null. */
    public static function loadSessionUser(Db $db, string $secret, ?string $token): ?AuthUser
    {
        if ($token === null || $token === '' || strlen($token) > 200) return null;
        $row = $db->one(
            'SELECT s.id AS session_id, s.last_seen_at, u.id AS user_id, u.name, u.role, u.permissions, u.active
               FROM sessions s INNER JOIN users u ON u.id = s.user_id
              WHERE s.token_hash = ? AND s.expires_at > NOW(3)',
            [self::hashToken($secret, $token)],
        );
        if (!$row || !$row['active']) return null;
        if (time() - strtotime((string) $row['last_seen_at']) > 300) {
            $db->exec('UPDATE sessions SET last_seen_at = NOW(3) WHERE id = ?', [$row['session_id']]);
        }
        return new AuthUser(
            $row['user_id'],
            $row['session_id'],
            $row['name'],
            $row['role'],
            Permissions::effective($row['role'], $row['permissions']),
        );
    }

    /** Bot service identity: an active user by id with the same effective permissions as a web session. */
    public static function loadBotUser(Db $db, string $userId): ?AuthUser
    {
        if (!preg_match('/^[0-9a-f-]{36}$/i', $userId)) return null;
        $row = $db->one('SELECT id, name, role, permissions, active FROM users WHERE id = ?', [$userId]);
        if (!$row || !$row['active']) return null;
        return new AuthUser($row['id'], 'bot', $row['name'], $row['role'], Permissions::effective($row['role'], $row['permissions']));
    }

    /** Set-Cookie value identical to @fastify/cookie: `vt_session=…; Path=/; Expires=…; HttpOnly; SameSite=Lax[; Secure]`. */
    public static function sessionCookie(string $token, int $expiresAt, bool $secure): string
    {
        return self::SESSION_COOKIE . '=' . $token . '; Path=/; Expires=' . gmdate('D, d M Y H:i:s', $expiresAt) . ' GMT; HttpOnly; SameSite=Lax' . ($secure ? '; Secure' : '');
    }

    public static function clearSessionCookie(bool $secure): string
    {
        return self::SESSION_COOKIE . '=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax' . ($secure ? '; Secure' : '');
    }

    /** password_hash with Argon2id when the PHP build has it, bcrypt otherwise (shared hosts vary). */
    public static function hashPassword(string $password): string
    {
        if (defined('PASSWORD_ARGON2ID')) {
            return password_hash($password, PASSWORD_ARGON2ID, ['memory_cost' => 19456, 'time_cost' => 2, 'threads' => 1]);
        }
        return password_hash($password, PASSWORD_BCRYPT, ['cost' => 11]);
    }

    public static function verifyPassword(string $hash, string $password): bool
    {
        return password_verify($password, $hash);
    }
}
