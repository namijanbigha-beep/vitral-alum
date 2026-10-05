<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * JSON with JavaScript semantics.
 *  - decode: objects become associative arrays, except an EMPTY object which stays \stdClass so that `{}`
 *    survives a round trip (an empty PHP array encodes as `[]`).
 *  - encode: like JSON.stringify — unescaped Unicode and slashes, integral floats printed without «.0»,
 *    DateTimeInterface as ISO-8601 UTC with milliseconds, JsonSerializable honoured.
 */
final class Json
{
    private const FLAGS = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS | JSON_THROW_ON_ERROR;

    public static function encode(mixed $value): string
    {
        return json_encode(self::normalize($value), self::FLAGS);
    }

    /** @throws \JsonException */
    public static function decode(string $json): mixed
    {
        return self::fromObjects(json_decode($json, false, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING));
    }

    public static function fromObjects(mixed $v): mixed
    {
        if ($v instanceof \stdClass) {
            $arr = get_object_vars($v);
            if (!$arr) return new \stdClass();
            foreach ($arr as $k => $x) $arr[$k] = self::fromObjects($x);
            return $arr;
        }
        if (is_array($v)) {
            foreach ($v as $k => $x) $v[$k] = self::fromObjects($x);
        }
        return $v;
    }

    /** ISO-8601 in UTC with milliseconds, as Date.prototype.toISOString(). */
    public static function iso(\DateTimeInterface $d): string
    {
        return \DateTimeImmutable::createFromInterface($d)->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
    }

    public static function normalize(mixed $v): mixed
    {
        if (is_array($v)) {
            foreach ($v as $k => $x) $v[$k] = self::normalize($x);
            return $v;
        }
        if (is_float($v)) {
            if (!is_finite($v)) return null;
            if (floor($v) === $v && abs($v) < 9007199254740992) return (int) $v;
            return $v;
        }
        if ($v instanceof \DateTimeInterface) return self::iso($v);
        if ($v instanceof \JsonSerializable) return self::normalize($v->jsonSerialize());
        if ($v instanceof \stdClass) {
            $vars = get_object_vars($v);
            if (!$vars) return $v;
            $o = new \stdClass();
            foreach ($vars as $k => $x) $o->$k = self::normalize($x);
            return $o;
        }
        return $v;
    }

    /** A list in JSON terms (empty array included). */
    public static function isList(mixed $v): bool
    {
        return is_array($v) && array_is_list($v);
    }

    /** An object in JSON terms: non-list array or \stdClass. An empty PHP array counts as both. */
    public static function isObject(mixed $v): bool
    {
        return $v instanceof \stdClass || (is_array($v) && (!$v || !array_is_list($v)));
    }

    /** Object as associative array (\stdClass → array). */
    public static function toArray(mixed $v): array
    {
        if ($v instanceof \stdClass) return get_object_vars($v);
        return is_array($v) ? $v : [];
    }
}
