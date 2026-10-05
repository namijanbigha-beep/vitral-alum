<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * A small zod (v3) work-alike, so module ports keep the exact validation behaviour of the Node API:
 * same default English messages, same field paths (`items.0.qty`, `_` for the root), unknown keys stripped,
 * `undefined` (missing) vs `null`, defaults, refinements and transforms in chain order.
 * Build schemas with the V factory; every modifier returns a new schema (schemas are shareable).
 *
 * Deviation: an empty JSON array `[]` is accepted where an object is expected (PHP cannot tell `[]` from `{}`
 * once decoded into an array; Json::decode keeps `{}` as \stdClass, so the reverse case is exact).
 */
final class Schema
{
    /** Marker returned by run() when the value failed. */
    private const INVALID = "\0__invalid__\0";

    public string $kind;
    /** @var list<array{0:string,1:mixed,2:?string}> type checks in order: [name, arg, custom message] */
    private array $checks = [];
    /** @var list<array{0:string,1:callable,2:?string,3:?array}> effects in order: ['refine'|'transform'|'super', fn, message, path] */
    private array $effects = [];
    private bool $optional = false;
    private bool $nullable = false;
    private bool $hasDefault = false;
    private mixed $default = null;
    private bool $hasCatch = false;
    private mixed $catchValue = null;
    private bool $coerce = false;
    /** @var callable|null */
    private $preprocess = null;
    /** @var array<string,Schema> */
    private array $shape = [];
    private bool $passthrough = false;
    private ?Schema $element = null;
    private ?Schema $keySchema = null;
    /** @var list<Schema> */
    private array $options = [];
    /** @var list<string|int|float|bool> */
    private array $values = [];
    private mixed $literal = null;

    public function __construct(string $kind)
    {
        $this->kind = $kind;
    }

    // ---------------------------------------------------------------- builders used by V

    /** @internal */
    public static function make(string $kind, array $props = []): self
    {
        $s = new self($kind);
        foreach ($props as $k => $v) $s->$k = $v;
        return $s;
    }

    private function with(callable $fn): self
    {
        $c = clone $this;
        $fn($c);
        return $c;
    }

    private function check(string $name, mixed $arg = null, ?string $message = null): self
    {
        return $this->with(function (self $c) use ($name, $arg, $message) {
            $c->checks[] = [$name, $arg, $message];
        });
    }

    // ---------------------------------------------------------------- modifiers (zod names)

    public function optional(): self { return $this->with(fn (self $c) => $c->optional = true); }
    public function nullable(): self { return $this->with(fn (self $c) => $c->nullable = true); }
    public function nullish(): self { return $this->with(function (self $c) { $c->nullable = true; $c->optional = true; }); }

    public function default(mixed $value): self
    {
        return $this->with(function (self $c) use ($value) {
            $c->hasDefault = true;
            $c->default = $value;
        });
    }

    public function catch(mixed $value): self
    {
        return $this->with(function (self $c) use ($value) {
            $c->hasCatch = true;
            $c->catchValue = $value;
        });
    }

    /** @param callable(mixed):bool $fn */
    public function refine(callable $fn, ?string $message = null, ?array $path = null): self
    {
        return $this->with(fn (self $c) => $c->effects[] = ['refine', $fn, $message, $path]);
    }

    /** @param callable(mixed, callable(string $message, array $path=):void):void $fn */
    public function superRefine(callable $fn): self
    {
        return $this->with(fn (self $c) => $c->effects[] = ['super', $fn, null, null]);
    }

    /**
     * @param callable(mixed, callable(string $message, array $path=):void):mixed $fn
     * The second argument adds an issue (as ctx.addIssue); the transform result is then discarded.
     */
    public function transform(callable $fn): self
    {
        return $this->with(fn (self $c) => $c->effects[] = ['transform', $fn, null, null]);
    }

    // strings
    public function min(int|float $n, ?string $message = null): self { return $this->check('min', $n, $message); }
    public function max(int|float $n, ?string $message = null): self { return $this->check('max', $n, $message); }
    public function length(int $n, ?string $message = null): self { return $this->check('length', $n, $message); }
    public function trim(): self { return $this->check('trim'); }
    public function toLowerCase(): self { return $this->check('lower'); }
    public function regex(string $pattern, ?string $message = null): self { return $this->check('regex', $pattern, $message); }
    public function uuid(?string $message = null): self { return $this->check('uuid', null, $message); }
    public function email(?string $message = null): self { return $this->check('email', null, $message); }
    public function url(?string $message = null): self { return $this->check('url', null, $message); }
    /** z.string().date(): YYYY-MM-DD with a real calendar date. */
    public function date(?string $message = null): self { return $this->check('date', null, $message); }
    /** @param array{offset?:bool,local?:bool,precision?:int} $opts */
    public function datetime(array $opts = [], ?string $message = null): self { return $this->check('datetime', $opts, $message); }
    public function startsWith(string $prefix, ?string $message = null): self { return $this->check('startsWith', $prefix, $message); }
    // numbers
    public function int(?string $message = null): self { return $this->check('int', null, $message); }
    public function gt(int|float $n, ?string $message = null): self { return $this->check('gt', $n, $message); }
    public function gte(int|float $n, ?string $message = null): self { return $this->check('min', $n, $message); }
    public function lt(int|float $n, ?string $message = null): self { return $this->check('lt', $n, $message); }
    public function lte(int|float $n, ?string $message = null): self { return $this->check('max', $n, $message); }
    public function positive(?string $message = null): self { return $this->check('gt', 0, $message); }
    public function nonnegative(?string $message = null): self { return $this->check('min', 0, $message); }
    public function finite(?string $message = null): self { return $this->check('finite', null, $message); }

    // objects
    /** @param array<string,Schema> $shape */
    public function extend(array $shape): self { return $this->with(fn (self $c) => $c->shape = array_merge($c->shape, $shape)); }
    public function merge(Schema $other): self { return $this->extend($other->shape); }
    public function passthrough(): self { return $this->with(fn (self $c) => $c->passthrough = true); }
    public function strip(): self { return $this->with(fn (self $c) => $c->passthrough = false); }
    /** @param list<string>|null $keys */
    public function partial(?array $keys = null): self
    {
        return $this->with(function (self $c) use ($keys) {
            foreach ($c->shape as $k => $s) if ($keys === null || in_array($k, $keys, true)) $c->shape[$k] = $s->optional();
        });
    }
    /** @param list<string> $keys */
    public function pick(array $keys): self { return $this->with(fn (self $c) => $c->shape = array_intersect_key($c->shape, array_flip($keys))); }
    /** @param list<string> $keys */
    public function omit(array $keys): self { return $this->with(fn (self $c) => $c->shape = array_diff_key($c->shape, array_flip($keys))); }
    /** @return array<string,Schema> */
    public function shape(): array { return $this->shape; }

    // ---------------------------------------------------------------- parsing

    /**
     * Parse or throw AppError('validation', 'اطلاعات واردشده درست نیست', fields) — the ZodError branch of
     * app.ts setErrorHandler: fields[path.join('.') || '_'] = message, the last issue per path winning.
     */
    public function parse(mixed $input): mixed
    {
        $r = $this->safeParse($input);
        if ($r['success']) return $r['data'];
        throw new AppError('validation', 'اطلاعات واردشده درست نیست', self::fieldsOf($r['issues']));
    }

    /** @return array{success:bool,data?:mixed,issues?:list<array{path:list<string|int>,message:string}>} */
    public function safeParse(mixed $input): array
    {
        $issues = [];
        $aborted = false;
        $out = $this->run($input, [], $issues, $aborted);
        if ($issues || $aborted) return ['success' => false, 'issues' => $issues ?: [['path' => [], 'message' => 'Invalid input']]];
        return ['success' => true, 'data' => $out instanceof Undef ? null : $out];
    }

    /** @param list<array{path:list<string|int>,message:string}> $issues */
    public static function fieldsOf(array $issues): array
    {
        $fields = [];
        foreach ($issues as $i) {
            $key = implode('.', $i['path']);
            $fields[$key === '' ? '_' : $key] = $i['message'];
        }
        return $fields;
    }

    /**
     * zod's parse statuses: a failed type check aborts ($aborted = true); a failed min/max/regex/refine only makes the
     * value dirty (issues were added, parent refinements still run, transforms do not).
     * @param list<string|int> $path
     * @param list<array{path:list<string|int>,message:string}> $issues
     */
    public function run(mixed $value, array $path, array &$issues, mixed &$aborted = false): mixed
    {
        $aborted = false;
        if ($this->preprocess) $value = ($this->preprocess)($value);
        $before = count($issues);
        $out = $this->runInner($value, $path, $issues, $aborted);
        if ($this->hasCatch && ($aborted || count($issues) > $before)) {
            array_splice($issues, $before);
            $aborted = false;
            return self::copy($this->catchValue);
        }
        return $out;
    }

    private function runInner(mixed $value, array $path, array &$issues, bool &$aborted): mixed
    {
        if ($value instanceof Undef) {
            if ($this->hasDefault) {
                $value = self::copy($this->default);
            } elseif ($this->optional || in_array($this->kind, ['unknown', 'any'], true)) {
                return Undef::Value;
            } else {
                $issues[] = ['path' => $path, 'message' => 'Required'];
                $aborted = true;
                return null;
            }
        }
        if ($value === null && $this->nullable) return null;

        $before = count($issues);
        $out = $this->parseType($value, $path, $issues);
        if ($out === self::INVALID) {
            $aborted = true;
            return null;
        }
        $dirty = count($issues) > $before;

        foreach ($this->effects as [$type, $fn, $message, $ePath]) {
            if ($type === 'refine') {
                if (!$fn($out)) {
                    $issues[] = ['path' => array_merge($path, $ePath ?? []), 'message' => $message ?? 'Invalid input'];
                    $dirty = true;
                }
                continue;
            }
            if ($type === 'transform' && $dirty) {
                $aborted = true;
                return null;
            }
            $added = false;
            $add = function (string $msg, array $p = []) use (&$issues, $path, &$added) {
                $issues[] = ['path' => array_merge($path, $p), 'message' => $msg];
                $added = true;
            };
            $res = $fn($out, $add);
            if ($type === 'super') {
                if ($added) $dirty = true;
                continue;
            }
            if ($added) {
                $aborted = true;
                return null;
            }
            $out = $res;
        }
        return $out;
    }

    private static function copy(mixed $v): mixed
    {
        return is_object($v) && !($v instanceof Undef) ? clone $v : $v;
    }

    public static function typeOf(mixed $v): string
    {
        return match (true) {
            $v instanceof Undef => 'undefined',
            $v === null => 'null',
            is_string($v) => 'string',
            is_bool($v) => 'boolean',
            is_int($v) => 'number',
            is_float($v) => is_nan($v) ? 'nan' : 'number',
            Json::isList($v) && $v !== [] => 'array',
            is_array($v) && $v === [] => 'array',
            is_array($v), $v instanceof \stdClass => 'object',
            default => 'unknown',
        };
    }

    private function typeIssue(array $path, array &$issues, string $expected, mixed $value): string
    {
        $issues[] = ['path' => $path, 'message' => "Expected {$expected}, received " . self::typeOf($value)];
        return self::INVALID;
    }

    private function parseType(mixed $value, array $path, array &$issues): mixed
    {
        if ($value instanceof JsonList) {
            if ($this->kind === 'object' || $this->kind === 'record') {
                $issues[] = ['path' => $path, 'message' => 'Expected object, received array'];
                return self::INVALID;
            }
            $value = [];
        }
        switch ($this->kind) {
            case 'unknown':
            case 'any':
                return $value;
            case 'null':
                return $value === null ? null : $this->typeIssue($path, $issues, 'null', $value);
            case 'string':
                if ($this->coerce && !($value instanceof Undef)) $value = self::jsString($value);
                if (!is_string($value)) return $this->typeIssue($path, $issues, 'string', $value);
                return $this->stringChecks($value, $path, $issues);
            case 'number':
                if ($this->coerce) $value = self::jsNumber($value);
                if (!is_int($value) && !is_float($value)) return $this->typeIssue($path, $issues, 'number', $value);
                if (is_float($value) && is_nan($value)) return $this->typeIssue($path, $issues, 'number', $value);
                return $this->numberChecks($value, $path, $issues);
            case 'boolean':
                if ($this->coerce) $value = self::jsTruthy($value);
                return is_bool($value) ? $value : $this->typeIssue($path, $issues, 'boolean', $value);
            case 'enum':
                if (!is_string($value)) {
                    return $this->typeIssue($path, $issues, self::joinValues($this->values), $value);
                }
                if (!in_array($value, $this->values, true)) {
                    $issues[] = ['path' => $path, 'message' => $this->checks[0][2] ?? 'Invalid enum value. Expected ' . self::joinValues($this->values) . ", received '{$value}'"];
                    return self::INVALID;
                }
                return $value;
            case 'literal':
                if ($value !== $this->literal) {
                    $issues[] = ['path' => $path, 'message' => 'Invalid literal value, expected ' . json_encode($this->literal, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)];
                    return self::INVALID;
                }
                return $value;
            case 'array':
                if (!Json::isList($value)) return $this->typeIssue($path, $issues, 'array', $value);
                $out = [];
                $childAborted = false;
                foreach ($value as $i => $item) {
                    $r = $this->element->run($item, [...$path, $i], $issues, $ab);
                    if ($ab) $childAborted = true;
                    $out[] = $r instanceof Undef ? null : $r;
                }
                if ($childAborted) return self::INVALID;
                foreach ($this->checks as [$name, $arg, $msg]) {
                    $n = count($value);
                    if ($name === 'min' && $n < $arg) $issues[] = ['path' => $path, 'message' => $msg ?? "Array must contain at least {$arg} element(s)"];
                    if ($name === 'max' && $n > $arg) $issues[] = ['path' => $path, 'message' => $msg ?? "Array must contain at most {$arg} element(s)"];
                    if ($name === 'length' && $n !== $arg) $issues[] = ['path' => $path, 'message' => $msg ?? "Array must contain exactly {$arg} element(s)"];
                }
                return $out;
            case 'object':
                if (!Json::isObject($value)) return $this->typeIssue($path, $issues, 'object', $value);
                $in = Json::toArray($value);
                $out = [];
                $childAborted = false;
                foreach ($this->shape as $key => $schema) {
                    $present = array_key_exists($key, $in);
                    $r = $schema->run($present ? $in[$key] : Undef::Value, [...$path, $key], $issues, $ab);
                    if ($ab) {
                        $childAborted = true;
                        continue;
                    }
                    if (!($r instanceof Undef) || $present) $out[$key] = $r instanceof Undef ? null : $r;
                }
                if ($childAborted) return self::INVALID;
                if ($this->passthrough) {
                    foreach ($in as $k => $v) if (!array_key_exists($k, $this->shape)) $out[$k] = $v;
                }
                return $out;
            case 'record':
                if (!Json::isObject($value)) return $this->typeIssue($path, $issues, 'object', $value);
                $out = [];
                $childAborted = false;
                foreach (Json::toArray($value) as $k => $v) {
                    $k = (string) $k;
                    $kr = $this->keySchema ? $this->keySchema->run($k, [...$path, $k], $issues, $abK) : $k;
                    $vr = $this->element->run($v, [...$path, $k], $issues, $abV);
                    if (($this->keySchema && $abK) || $abV) {
                        $childAborted = true;
                        continue;
                    }
                    $out[$kr] = $vr instanceof Undef ? null : $vr;
                }
                if ($childAborted) return self::INVALID;
                return $out ?: new \stdClass();
            case 'union':
                foreach ($this->options as $opt) {
                    $tmp = [];
                    $r = $opt->run($value, $path, $tmp, $ab);
                    if (!$tmp && !$ab) return $r;
                }
                $issues[] = ['path' => $path, 'message' => 'Invalid input'];
                return self::INVALID;
        }
        throw new \LogicException("unknown schema kind {$this->kind}");
    }

    private function stringChecks(string $value, array $path, array &$issues): string
    {
        foreach ($this->checks as [$name, $arg, $msg]) {
            switch ($name) {
                case 'trim':
                    $value = \Vitral\Lib\Num::jsTrim($value);
                    break;
                case 'lower':
                    $value = mb_strtolower($value);
                    break;
                case 'min':
                    if (self::jsLength($value) < $arg) $issues[] = ['path' => $path, 'message' => $msg ?? "String must contain at least {$arg} character(s)"];
                    break;
                case 'max':
                    if (self::jsLength($value) > $arg) $issues[] = ['path' => $path, 'message' => $msg ?? "String must contain at most {$arg} character(s)"];
                    break;
                case 'length':
                    if (self::jsLength($value) !== $arg) $issues[] = ['path' => $path, 'message' => $msg ?? "String must contain exactly {$arg} character(s)"];
                    break;
                case 'regex':
                    if (!preg_match($arg, $value)) $issues[] = ['path' => $path, 'message' => $msg ?? 'Invalid'];
                    break;
                case 'uuid':
                    if (!preg_match('/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/', $value)) $issues[] = ['path' => $path, 'message' => $msg ?? 'Invalid uuid'];
                    break;
                case 'email':
                    if (!preg_match("/^(?!\\.)(?!.*\\.\\.)([A-Z0-9_'+\\-\\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\\-]*\\.)+[A-Z]{2,}$/i", $value)) $issues[] = ['path' => $path, 'message' => $msg ?? 'Invalid email'];
                    break;
                case 'url':
                    if (!preg_match('~^[a-z][a-z0-9+.\-]*://[^\s]+$~i', $value) || parse_url($value) === false) $issues[] = ['path' => $path, 'message' => $msg ?? 'Invalid url'];
                    break;
                case 'date':
                    if (!preg_match('/^' . self::DATE_RE . '$/', $value)) $issues[] = ['path' => $path, 'message' => $msg ?? 'Invalid date'];
                    break;
                case 'datetime':
                    if (!preg_match(self::datetimeRegex($arg), $value)) $issues[] = ['path' => $path, 'message' => $msg ?? 'Invalid datetime'];
                    break;
                case 'startsWith':
                    if (!str_starts_with($value, $arg)) $issues[] = ['path' => $path, 'message' => $msg ?? "Invalid input: must start with \"{$arg}\""];
                    break;
            }
        }
        return $value;
    }

    private function numberChecks(int|float $value, array $path, array &$issues): int|float
    {
        foreach ($this->checks as [$name, $arg, $msg]) {
            switch ($name) {
                case 'int':
                    if (is_float($value) && (!is_finite($value) || floor($value) !== $value)) {
                        $issues[] = ['path' => $path, 'message' => $msg ?? 'Expected integer, received float'];
                    }
                    break;
                case 'min':
                    if ($value < $arg) $issues[] = ['path' => $path, 'message' => $msg ?? 'Number must be greater than or equal to ' . self::num($arg)];
                    break;
                case 'gt':
                    if ($value <= $arg) $issues[] = ['path' => $path, 'message' => $msg ?? 'Number must be greater than ' . self::num($arg)];
                    break;
                case 'max':
                    if ($value > $arg) $issues[] = ['path' => $path, 'message' => $msg ?? 'Number must be less than or equal to ' . self::num($arg)];
                    break;
                case 'lt':
                    if ($value >= $arg) $issues[] = ['path' => $path, 'message' => $msg ?? 'Number must be less than ' . self::num($arg)];
                    break;
                case 'finite':
                    if (!is_finite((float) $value)) $issues[] = ['path' => $path, 'message' => $msg ?? 'Number must be finite'];
                    break;
            }
        }
        // integral floats (5.0 from JSON) behave as JS numbers: keep them as int
        if (is_float($value) && is_finite($value) && floor($value) === $value && abs($value) < 9007199254740992) return (int) $value;
        return $value;
    }

    private const DATE_RE = '((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))';

    /** zod v3 datetimeRegex(). */
    private static function datetimeRegex(array $o): string
    {
        $sec = '[0-5]\d';
        $precision = $o['precision'] ?? null;
        if ($precision) $sec .= '\.\d{' . $precision . '}';
        elseif ($precision === null) $sec .= '(\.\d+)?';
        $quant = $precision ? '+' : '?';
        $time = '([01]\d|2[0-3]):[0-5]\d(:' . $sec . ')' . $quant;
        $opts = [!empty($o['local']) ? 'Z?' : 'Z'];
        if (!empty($o['offset'])) $opts[] = '([+-]\d{2}:?\d{2})';
        return '/^' . self::DATE_RE . 'T' . $time . '(' . implode('|', $opts) . ')$/';
    }

    private static function num(int|float $n): string
    {
        return is_float($n) ? (string) json_encode($n) : (string) $n;
    }

    /** @param list<string|int|float|bool> $values */
    private static function joinValues(array $values): string
    {
        return implode(' | ', array_map(static fn ($v) => is_string($v) ? "'{$v}'" : json_encode($v), $values));
    }

    /** String length in UTF-16 code units, as JavaScript counts it. */
    public static function jsLength(string $s): int
    {
        $len = 0;
        foreach (mb_str_split($s) as $ch) $len += strlen($ch) === 4 ? 2 : 1;
        return $len;
    }

    /** Number(value) of JavaScript (z.coerce.number()). */
    public static function jsNumber(mixed $v): int|float
    {
        if ($v instanceof Undef) return NAN;
        if ($v === null) return 0;
        if (is_bool($v)) return $v ? 1 : 0;
        if (is_int($v) || is_float($v)) return $v;
        if (is_array($v)) {
            if ($v === []) return 0;
            if (count($v) === 1 && array_is_list($v)) return self::jsNumber(is_array($v[0]) ? NAN : self::jsString($v[0]));
            return NAN;
        }
        if (!is_string($v)) return NAN;
        $s = \Vitral\Lib\Num::jsTrim($v);
        if ($s === '') return 0;
        if (preg_match('/^0[xX][0-9a-fA-F]+$/', $s)) return hexdec(substr($s, 2));
        if (preg_match('/^0[oO][0-7]+$/', $s)) return octdec(substr($s, 2));
        if (preg_match('/^0[bB][01]+$/', $s)) return bindec(substr($s, 2));
        if (preg_match('/^[+-]?Infinity$/', $s)) return $s[0] === '-' ? -INF : INF;
        if (!preg_match('/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/', $s)) return NAN;
        if (preg_match('/^[+-]?\d+$/', $s) && strlen(ltrim($s, '+-')) < 16) return (int) $s;
        return (float) $s;
    }

    /** String(value) of JavaScript (z.coerce.string()). */
    public static function jsString(mixed $v): string
    {
        return match (true) {
            $v instanceof Undef => 'undefined',
            $v === null => 'null',
            is_bool($v) => $v ? 'true' : 'false',
            is_float($v) => (string) json_encode($v),
            is_array($v) && array_is_list($v) => implode(',', array_map([self::class, 'jsString'], $v)),
            is_array($v), $v instanceof \stdClass => '[object Object]',
            default => (string) $v,
        };
    }

    /** Boolean(value) of JavaScript (z.coerce.boolean()). */
    public static function jsTruthy(mixed $v): bool
    {
        if ($v instanceof Undef || $v === null || $v === false || $v === '' || $v === 0) return false;
        if (is_float($v)) return !($v == 0 || is_nan($v));
        return true;
    }
}
