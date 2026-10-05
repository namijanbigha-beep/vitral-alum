<?php
declare(strict_types=1);

namespace Vitral\Core;

use Vitral\Lib\Num;

/**
 * Schema factory (the `z` of the Node code) plus the shared schemas of packages/shared/src/schemas.ts,
 * lib/crud.ts and lib/pagination.ts with their Persian messages.
 *
 *   $body = V::object(['name' => V::string()->trim()->min(1, 'نام لازم است')->max(120)])->parse($req->body());
 */
final class V
{
    public static function undef(): Undef { return Undef::Value; }

    public static function string(): Schema { return Schema::make('string'); }
    public static function number(): Schema { return Schema::make('number'); }
    public static function int(): Schema { return Schema::make('number')->int(); }
    public static function boolean(): Schema { return Schema::make('boolean'); }
    public static function unknown(): Schema { return Schema::make('unknown'); }
    public static function any(): Schema { return Schema::make('any'); }
    public static function null(): Schema { return Schema::make('null'); }
    public static function literal(string|int|float|bool $value): Schema { return Schema::make('literal', ['literal' => $value]); }

    /** @param list<string> $values @param string|null $message custom message for a value outside the list */
    public static function enum(array $values, ?string $message = null): Schema
    {
        return Schema::make('enum', ['values' => array_values($values), 'checks' => [['enum', null, $message]]]);
    }

    /** @param array<string,Schema> $shape */
    public static function object(array $shape): Schema { return Schema::make('object', ['shape' => $shape]); }
    public static function array(Schema $element): Schema { return Schema::make('array', ['element' => $element]); }
    /** z.record(value) or z.record(key, value) */
    public static function record(Schema $keyOrValue, ?Schema $value = null): Schema
    {
        return $value === null
            ? Schema::make('record', ['element' => $keyOrValue])
            : Schema::make('record', ['keySchema' => $keyOrValue, 'element' => $value]);
    }
    /** @param list<Schema> $options */
    public static function union(array $options): Schema { return Schema::make('union', ['options' => $options]); }
    /** z.preprocess(fn, schema) */
    public static function preprocess(callable $fn, Schema $schema): Schema
    {
        $c = clone $schema;
        (function () use ($fn) { $this->preprocess = $fn; })->call($c);
        return $c;
    }

    public static function coerceNumber(): Schema { return Schema::make('number', ['coerce' => true]); }
    public static function coerceBoolean(): Schema { return Schema::make('boolean', ['coerce' => true]); }
    public static function coerceString(): Schema { return Schema::make('string', ['coerce' => true]); }

    // ---------------------------------------------------------------- packages/shared/src/schemas.ts

    /** Mobile is the login id: any digit script, normalised to 09xxxxxxxxx. */
    public static function mobile(): Schema
    {
        return self::string()
            ->transform(static fn (string $v) => (string) preg_replace(['/^\+98/', '/^0098/'], '0', (string) preg_replace('/[\s-]/u', '', Num::toLatinDigits($v))))
            ->refine(static fn (string $v) => (bool) preg_match('/^09\d{9}$/', $v), 'شماره موبایل باید ۱۱ رقم و با ۰۹ شروع شود');
    }

    public static function password(): Schema
    {
        return self::string()->min(8, 'رمز باید حداقل ۸ نویسه باشد')->max(200);
    }

    /** Decimal fields travel as strings; Persian/Arabic digits accepted (R20). Output: canonical string. */
    public static function decimalString(): Schema
    {
        return self::string()->transform(static function (string $v, callable $addIssue) {
            $n = Num::parseNumber($v);
            if ($n === null) {
                $addIssue('عدد نامعتبر است');
                return null;
            }
            return $n;
        });
    }

    public static function permission(): Schema { return self::enum(Permissions::ALL); }
    public static function role(): Schema { return self::enum(Permissions::ROLES); }

    // ---------------------------------------------------------------- lib/crud.ts helpers

    /** UUID, lower-cased (PostgreSQL's uuid type stores and returns lower case; CHAR(36) does not). */
    public static function uuid(): Schema { return self::string()->uuid()->transform(static fn (string $v) => strtolower($v)); }
    /** YYYY-MM-DD */
    public static function dateOnly(): Schema { return self::string()->regex('/^\d{4}-\d{2}-\d{2}$/', 'تاریخ باید YYYY-MM-DD باشد'); }
    /** ISO date-time with optional offset (z.string().datetime({ offset: true })). */
    public static function isoDate(): Schema { return self::string()->datetime(['offset' => true]); }
    public static function text(int $max = 500): Schema { return self::string()->trim()->max($max); }
    public static function optText(int $max = 500): Schema { return self::string()->trim()->max($max)->nullable()->optional(); }
    /** Query-string boolean: 'true'/'1' → true, 'false'/'0'/'' → false. */
    public static function boolQuery(): Schema
    {
        return self::preprocess(static function ($v) {
            if (!is_string($v)) return $v;
            $l = strtolower($v);
            if (in_array($l, ['true', '1'], true)) return true;
            if (in_array($l, ['false', '0', ''], true)) return false;
            return $v;
        }, self::boolean());
    }
    /** { version, reason? } of every PATCH. @return array<string,Schema> */
    public static function versionField(): array
    {
        return ['version' => self::int()->nonnegative(), 'reason' => self::string()->trim()->max(500)->optional()];
    }

    /** lib/pagination.ts listQuery: limit 1..100 (default 50) and an opaque cursor. */
    public static function listQuery(): Schema
    {
        return self::object([
            'limit' => self::coerceNumber()->int()->min(1)->max(100)->default(50),
            'cursor' => self::string()->max(200)->optional(),
        ]);
    }

    /** `z.object({ id: z.string().uuid() })` for route params. */
    public static function idParam(): Schema
    {
        return self::object(['id' => self::uuid()]);
    }
}
