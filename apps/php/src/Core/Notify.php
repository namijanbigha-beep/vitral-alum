<?php
declare(strict_types=1);

namespace Vitral\Core;

/** Port of apps/server/src/lib/notify.ts: in-app notifications; an open duplicate (same user + group_key) collapses. */
final class Notify
{
    /** @param array{userId:string,kind:string,title:string,entity?:?string,entityId?:?string,groupKey?:?string} $n */
    public static function send(Db $trx, array $n): void
    {
        try {
            $trx->insertNoReturn('notifications', [
                'user_id' => $n['userId'],
                'kind' => $n['kind'],
                'title' => $n['title'],
                'entity' => $n['entity'] ?? null,
                'entity_id' => $n['entityId'] ?? null,
                'group_key' => $n['groupKey'] ?? null,
            ]);
        } catch (\PDOException $e) {
            // ON CONFLICT DO NOTHING (the emulated partial unique index on open group keys)
            if (!Db::isDuplicateKey($e)) throw $e;
        }
    }

    /** @param array{kind:string,title:string,entity?:?string,entityId?:?string,groupKey?:?string} $n */
    public static function managers(Db $trx, array $n): void
    {
        foreach ($trx->column("SELECT id FROM users WHERE role = 'manager' AND active = 1") as $id) {
            self::send($trx, ['userId' => $id] + $n);
        }
    }
}
