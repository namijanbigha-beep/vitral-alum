<?php
declare(strict_types=1);

namespace Vitral\Core;

/** Port of apps/server/src/lib/pagination.ts: opaque cursors, {items, next_cursor} pages of at most 100. */
final class Pagination
{
    /** `at` is the ordering value of the last row: an ISO timestamp (as returned by Db) or a text key. */
    public static function encodeCursor(string $at, string $id): string
    {
        if (preg_match('/^\d{4}-\d{2}-\d{2}T/', $at) && strtotime($at) !== false) {
            $payload = ['at' => Json::iso(new \DateTimeImmutable($at)), 'id' => $id];
        } else {
            $payload = ['at' => $at, 'id' => $id, 'str' => true];
        }
        return rtrim(strtr(base64_encode(Json::encode($payload)), '+/', '-_'), '=');
    }

    /** @return array{at:string,id:string,str?:bool}|null */
    public static function decodeCursor(?string $cursor): ?array
    {
        if ($cursor === null || $cursor === '') return null;
        $raw = base64_decode(strtr($cursor, '-_', '+/'), false);
        if ($raw === false) return null;
        try {
            $v = Json::decode($raw);
        } catch (\JsonException) {
            return null;
        }
        if (!is_array($v) || !isset($v['at'], $v['id']) || !is_string($v['at']) || !is_string($v['id'])) return null;
        if (Schema::jsLength($v['at']) > 300) return null;
        if (!preg_match('/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/', $v['id'])) return null;
        if (array_key_exists('str', $v) && !is_bool($v['str'])) return null;
        $str = (bool) ($v['str'] ?? false);
        if (!$str && strtotime($v['at']) === false) return null;
        $out = ['at' => $v['at'], 'id' => strtolower($v['id'])];
        if (array_key_exists('str', $v)) $out['str'] = $v['str'];
        return $out;
    }

    /** The cursor's `at` as a SQL parameter: DATETIME literal for timestamps, the text otherwise. */
    public static function atParam(array $cursor): string
    {
        return !empty($cursor['str']) ? $cursor['at'] : (string) Db::dt($cursor['at']);
    }

    /**
     * Build the page from rows fetched with LIMIT limit+1.
     * @param list<array<string,mixed>> $rows
     * @param callable(array):mixed $present
     * @return array{items:list<mixed>,next_cursor:?string}
     */
    public static function page(array $rows, int $limit, callable $present, string $orderCol = 'created_at'): array
    {
        $page = array_slice($rows, 0, $limit);
        $last = $page ? $page[count($page) - 1] : null;
        return [
            'items' => array_map($present, $page),
            'next_cursor' => count($rows) > $limit && $last ? self::encodeCursor((string) $last[$orderCol], (string) $last['id']) : null,
        ];
    }
}
