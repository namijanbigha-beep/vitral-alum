<?php
declare(strict_types=1);

namespace Vitral\Core;

/** Port of apps/server/src/lib/audit.ts (principle 7: append-only change history in the caller's transaction). */
final class Audit
{
    private const NEVER_LOGGED = ['password_hash', 'token_hash', 'password', 'new_password', 'current_password'];

    private static function clean(mixed $value): mixed
    {
        $value = Json::normalize($value);
        if ($value === null) return null;
        if (Json::isList($value)) return array_map([self::class, 'clean'], $value);
        if (is_array($value)) {
            $out = [];
            foreach ($value as $k => $v) if (!in_array($k, self::NEVER_LOGGED, true)) $out[$k] = $v;
            return $out;
        }
        return $value;
    }

    /**
     * @param array{userId:?string,entity:string,entityId:?string,action:string,before?:mixed,after?:mixed,reason?:?string} $e
     *        omit before/after for NULL (the Node `undefined`)
     */
    public static function log(Db $trx, array $e): void
    {
        $trx->insertNoReturn('audit_log', [
            'user_id' => $e['userId'],
            'created_by' => $e['userId'],
            'entity' => $e['entity'],
            'entity_id' => $e['entityId'],
            'action' => $e['action'],
            'before' => array_key_exists('before', $e) ? Json::encode(self::clean($e['before'])) : null,
            'after' => array_key_exists('after', $e) ? Json::encode(self::clean($e['after'])) : null,
            'reason' => $e['reason'] ?? null,
        ]);
    }
}
