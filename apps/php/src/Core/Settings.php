<?php
declare(strict_types=1);

namespace Vitral\Core;

/** Port of apps/server/src/lib/settings.ts. Values are JSON (decoded by Db). */
final class Settings
{
    public static function get(Db $db, string $key): mixed
    {
        $row = $db->one('SELECT value FROM settings WHERE `key` = ?', [$key]);
        return $row['value'] ?? null;
    }

    /** @param list<string> $keys @return array<string,mixed> */
    public static function many(Db $db, array $keys): array
    {
        if (!$keys) return [];
        $rows = $db->all('SELECT `key`, value FROM settings WHERE `key` IN (' . Db::placeholders($keys) . ')', $keys);
        $out = [];
        foreach ($rows as $r) $out[$r['key']] = $r['value'];
        return $out;
    }
}
