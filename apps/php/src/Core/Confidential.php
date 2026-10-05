<?php
declare(strict_types=1);

namespace Vitral\Core;

/** Port of apps/server/src/lib/confidential.ts — the principle-6 output filter. */
final class Confidential
{
    /** @return list<string> paths of every confidential key anywhere in a JSON value */
    public static function find(mixed $value, string $path = ''): array
    {
        $out = [];
        if (Json::isList($value)) {
            foreach ($value as $i => $v) array_push($out, ...self::find($v, "{$path}[{$i}]"));
            return $out;
        }
        if (is_array($value) || $value instanceof \stdClass) {
            foreach (Json::toArray($value) as $k => $v) {
                $p = $path !== '' ? "{$path}.{$k}" : (string) $k;
                if (Permissions::isConfidentialKey((string) $k)) $out[] = $p;
                array_push($out, ...self::find($v, $p));
            }
        }
        return $out;
    }

    /** Deep copy with every confidential key removed. */
    public static function strip(mixed $value): mixed
    {
        if (Json::isList($value)) return array_map([self::class, 'strip'], $value);
        if ($value instanceof \stdClass) return $value;
        if (is_array($value)) {
            $out = [];
            foreach ($value as $k => $v) {
                if (!Permissions::isConfidentialKey((string) $k)) $out[$k] = self::strip($v);
            }
            return $out ?: new \stdClass();
        }
        return $value;
    }
}
