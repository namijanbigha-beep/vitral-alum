<?php
declare(strict_types=1);

namespace Vitral\Lib;

/**
 * Arbitrary-precision decimal on digit strings (no bcmath / gmp: shared hosts may lack both).
 * Mirrors packages/shared/src/number.ts, i.e. decimal.js cloned with precision 40 and ROUND_HALF_UP:
 *  - construction is exact;
 *  - add / sub / mul / div results are rounded to 40 significant digits, half away from zero;
 *  - toFixed(dp) rounds half away from zero; toFixed() prints the exact value without exponent;
 *  - a minus sign is printed only for a non-zero negative value (decimal.js: «-0.000» for -0.0004.toFixed(3)).
 * Money and weights must never touch a float: keep them as Decimal or canonical strings.
 */
final class Decimal implements \JsonSerializable, \Stringable
{
    public const PRECISION = 40;
    private const LIMB = 7;
    private const LIMB_BASE = 10_000_000;

    /** @param string $coef digits without leading zeros ("0" for zero) */
    private function __construct(private bool $neg, private string $coef, private int $scale)
    {
    }

    public static function of(string|int|float|Decimal $value): self
    {
        if ($value instanceof self) return $value;
        if (is_int($value)) return self::parse((string) $value);
        if (is_float($value)) {
            if (!is_finite($value)) throw new \InvalidArgumentException('Decimal: non-finite number');
            return self::parse((string) json_encode($value));
        }
        return self::parse($value);
    }

    public static function zero(): self
    {
        return new self(false, '0', 0);
    }

    /** True when the string is a number decimal.js would accept (no hex/binary forms). */
    public static function isValid(string $s): bool
    {
        return (bool) preg_match('/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/', $s);
    }

    private static function parse(string $s): self
    {
        $s = trim($s);
        if (!preg_match('/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/', $s, $m) || ($m[2] === '' && ($m[3] ?? '') === '')) {
            throw new \InvalidArgumentException("Decimal: invalid number «{$s}»");
        }
        $neg = $m[1] === '-';
        $int = $m[2];
        $frac = $m[3] ?? '';
        $exp = isset($m[4]) && $m[4] !== '' ? (int) $m[4] : 0;
        $coef = $int . $frac;
        $scale = strlen($frac) - $exp;
        if ($scale < 0) {
            $coef .= str_repeat('0', -$scale);
            $scale = 0;
        }
        return self::make($neg, $coef, $scale);
    }

    private static function make(bool $neg, string $coef, int $scale): self
    {
        $coef = ltrim($coef, '0');
        if ($coef === '') return new self(false, '0', 0);
        // drop trailing zeros of the fraction (decimal.js keeps no trailing zeros)
        while ($scale > 0 && $coef[-1] === '0') {
            $coef = substr($coef, 0, -1);
            $scale--;
        }
        return new self($neg, $coef, $scale);
    }

    // ---------------------------------------------------------------- arithmetic

    public function add(string|int|float|Decimal $other): self
    {
        $b = self::of($other);
        [$x, $y, $scale] = self::align($this, $b);
        if ($this->neg === $b->neg) {
            $r = self::make($this->neg, self::addMag($x, $y), $scale);
        } else {
            $c = self::cmpMag($x, $y);
            if ($c === 0) return self::zero();
            $r = $c > 0 ? self::make($this->neg, self::subMag($x, $y), $scale) : self::make($b->neg, self::subMag($y, $x), $scale);
        }
        return $r->roundSig(self::PRECISION);
    }

    public function sub(string|int|float|Decimal $other): self
    {
        return $this->add(self::of($other)->neg());
    }

    public function mul(string|int|float|Decimal $other): self
    {
        $b = self::of($other);
        if ($this->isZero() || $b->isZero()) return self::zero();
        return self::make($this->neg !== $b->neg, self::mulMag($this->coef, $b->coef), $this->scale + $b->scale)->roundSig(self::PRECISION);
    }

    /**
     * Division. Without $scale: decimal.js semantics (40 significant digits, half-up).
     * With $scale: the quotient rounded half-up to exactly that many decimal places.
     */
    public function div(string|int|float|Decimal $other, ?int $scale = null): self
    {
        $b = self::of($other);
        if ($b->isZero()) throw new \DivisionByZeroError('Decimal: division by zero');
        if ($this->isZero()) return self::zero();
        $neg = $this->neg !== $b->neg;
        if ($scale === null) {
            // enough digits for 40 significant ones plus a rounding digit
            $k = max(0, self::PRECISION + 2 + strlen($b->coef) - strlen($this->coef));
            [$q] = self::divMag($this->coef . str_repeat('0', $k), $b->coef);
            $resScale = $k + $this->scale - $b->scale;
            if ($resScale < 0) {
                $q .= str_repeat('0', -$resScale);
                $resScale = 0;
            }
            return self::make($neg, $q, $resScale)->roundSig(self::PRECISION);
        }
        // fixed scale: compute one extra digit, then round half-up
        $want = $scale + 1;
        $k = $want - $this->scale + $b->scale;
        $num = $this->coef;
        $den = $b->coef;
        if ($k >= 0) $num .= str_repeat('0', $k);
        else $den .= str_repeat('0', -$k);
        [$q] = self::divMag($num, $den);
        return self::make($neg, $q, $want)->toDecimalPlaces($scale);
    }

    public function neg(): self
    {
        return $this->isZero() ? $this : new self(!$this->neg, $this->coef, $this->scale);
    }

    public function abs(): self
    {
        return new self(false, $this->coef, $this->scale);
    }

    /** Round half away from zero to $dp decimal places (decimal.js toDecimalPlaces with ROUND_HALF_UP). */
    public function toDecimalPlaces(int $dp): self
    {
        if ($this->scale <= $dp) return $this;
        $drop = $this->scale - $dp;
        [$kept, $first] = self::splitForRound($this->coef, $drop);
        if ($first >= 5) $kept = self::addMag($kept, '1');
        return self::make($this->neg, $kept, $dp);
    }

    /** @return array{0:string,1:int} remaining digits and the first dropped digit */
    private static function splitForRound(string $coef, int $drop): array
    {
        if (strlen($coef) <= $drop) $coef = str_pad($coef, $drop + 1, '0', STR_PAD_LEFT);
        $kept = substr($coef, 0, strlen($coef) - $drop);
        $first = (int) $coef[strlen($coef) - $drop];
        return [$kept === '' ? '0' : $kept, $first];
    }

    private function roundSig(int $sig): self
    {
        $len = strlen($this->coef);
        if ($len <= $sig) return $this;
        $drop = $len - $sig;
        $kept = substr($this->coef, 0, $sig);
        if ((int) $this->coef[$sig] >= 5) $kept = self::addMag($kept, '1');
        $scale = $this->scale - $drop;
        if ($scale < 0) {
            $kept .= str_repeat('0', -$scale);
            $scale = 0;
        }
        return self::make($this->neg, $kept, $scale);
    }

    // ---------------------------------------------------------------- comparison

    public function cmp(string|int|float|Decimal $other): int
    {
        $b = self::of($other);
        if ($this->isZero() && $b->isZero()) return 0;
        if ($this->neg !== $b->neg) return $this->neg ? -1 : 1;
        [$x, $y] = self::align($this, $b);
        $c = self::cmpMag($x, $y);
        return $this->neg ? -$c : $c;
    }

    public function eq(string|int|float|Decimal $o): bool { return $this->cmp($o) === 0; }
    public function lt(string|int|float|Decimal $o): bool { return $this->cmp($o) < 0; }
    public function lte(string|int|float|Decimal $o): bool { return $this->cmp($o) <= 0; }
    public function gt(string|int|float|Decimal $o): bool { return $this->cmp($o) > 0; }
    public function gte(string|int|float|Decimal $o): bool { return $this->cmp($o) >= 0; }
    public function isZero(): bool { return $this->coef === '0'; }
    public function isNeg(): bool { return $this->neg && !$this->isZero(); }
    public function isPos(): bool { return !$this->neg && !$this->isZero(); }
    public function sign(): int { return $this->isZero() ? 0 : ($this->neg ? -1 : 1); }

    public static function max(string|int|Decimal ...$values): self
    {
        $best = null;
        foreach ($values as $v) {
            $d = self::of($v);
            if ($best === null || $d->gt($best)) $best = $d;
        }
        return $best ?? self::zero();
    }

    public static function min(string|int|Decimal ...$values): self
    {
        $best = null;
        foreach ($values as $v) {
            $d = self::of($v);
            if ($best === null || $d->lt($best)) $best = $d;
        }
        return $best ?? self::zero();
    }

    /** Sum of a list (empty list → 0). */
    public static function sum(iterable $values): self
    {
        $s = self::zero();
        foreach ($values as $v) if ($v !== null) $s = $s->add($v);
        return $s;
    }

    // ---------------------------------------------------------------- output

    /** decimal.js toFixed(): exact value without exponent; toFixed(dp): rounded half-up, padded to dp places. */
    public function toFixed(?int $dp = null): string
    {
        $v = $dp === null ? $this : $this->toDecimalPlaces($dp);
        $scale = $dp ?? $v->scale;
        $coef = $v->coef;
        if ($v->scale < $scale) $coef .= str_repeat('0', $scale - $v->scale);
        if ($scale > 0) {
            $coef = str_pad($coef, $scale + 1, '0', STR_PAD_LEFT);
            $str = substr($coef, 0, -$scale) . '.' . substr($coef, -$scale);
        } else {
            $str = $coef;
        }
        return ($this->neg && !$this->isZero() ? '-' : '') . $str;
    }

    public function __toString(): string
    {
        return $this->toFixed();
    }

    public function jsonSerialize(): string
    {
        return $this->toFixed();
    }

    /** Integer part as PHP int (truncated). Only for counts, never for money. */
    public function toInt(): int
    {
        $s = $this->toFixed();
        return (int) explode('.', $s)[0];
    }

    /** Float approximation — for comparisons with thresholds only, never stored. */
    public function toFloat(): float
    {
        return (float) $this->toFixed();
    }

    // ---------------------------------------------------------------- magnitude helpers (non-negative digit strings)

    /** @return array{0:string,1:string,2:int} */
    private static function align(self $a, self $b): array
    {
        $scale = max($a->scale, $b->scale);
        $x = $a->coef . str_repeat('0', $scale - $a->scale);
        $y = $b->coef . str_repeat('0', $scale - $b->scale);
        return [ltrim($x, '0') ?: '0', ltrim($y, '0') ?: '0', $scale];
    }

    private static function cmpMag(string $a, string $b): int
    {
        $a = ltrim($a, '0') ?: '0';
        $b = ltrim($b, '0') ?: '0';
        $la = strlen($a);
        $lb = strlen($b);
        if ($la !== $lb) return $la <=> $lb;
        return strcmp($a, $b) <=> 0;
    }

    private static function addMag(string $a, string $b): string
    {
        $len = max(strlen($a), strlen($b));
        $len = (int) (ceil($len / 9) * 9);
        $a = str_pad($a, $len, '0', STR_PAD_LEFT);
        $b = str_pad($b, $len, '0', STR_PAD_LEFT);
        $out = '';
        $carry = 0;
        for ($i = $len - 9; $i >= 0; $i -= 9) {
            $s = (int) substr($a, $i, 9) + (int) substr($b, $i, 9) + $carry;
            $carry = intdiv($s, 1_000_000_000);
            $out = str_pad((string) ($s % 1_000_000_000), 9, '0', STR_PAD_LEFT) . $out;
        }
        if ($carry) $out = $carry . $out;
        return ltrim($out, '0') ?: '0';
    }

    /** a - b with a >= b */
    private static function subMag(string $a, string $b): string
    {
        $len = (int) (ceil(max(strlen($a), strlen($b)) / 9) * 9);
        $a = str_pad($a, $len, '0', STR_PAD_LEFT);
        $b = str_pad($b, $len, '0', STR_PAD_LEFT);
        $out = '';
        $borrow = 0;
        for ($i = $len - 9; $i >= 0; $i -= 9) {
            $s = (int) substr($a, $i, 9) - (int) substr($b, $i, 9) - $borrow;
            if ($s < 0) {
                $s += 1_000_000_000;
                $borrow = 1;
            } else {
                $borrow = 0;
            }
            $out = str_pad((string) $s, 9, '0', STR_PAD_LEFT) . $out;
        }
        return ltrim($out, '0') ?: '0';
    }

    /** @return int[] little-endian limbs */
    private static function limbs(string $a): array
    {
        $out = [];
        for ($i = strlen($a); $i > 0; $i -= self::LIMB) {
            $start = max(0, $i - self::LIMB);
            $out[] = (int) substr($a, $start, $i - $start);
        }
        return $out;
    }

    private static function mulMag(string $a, string $b): string
    {
        $x = self::limbs($a);
        $y = self::limbs($b);
        $r = array_fill(0, count($x) + count($y) + 1, 0);
        foreach ($x as $i => $xi) {
            if ($xi === 0) continue;
            $carry = 0;
            foreach ($y as $j => $yj) {
                $t = $r[$i + $j] + $xi * $yj + $carry;
                $carry = intdiv($t, self::LIMB_BASE);
                $r[$i + $j] = $t % self::LIMB_BASE;
            }
            $k = $i + count($y);
            while ($carry) {
                $t = $r[$k] + $carry;
                $carry = intdiv($t, self::LIMB_BASE);
                $r[$k] = $t % self::LIMB_BASE;
                $k++;
            }
        }
        $out = '';
        for ($i = count($r) - 1; $i >= 0; $i--) $out .= str_pad((string) $r[$i], self::LIMB, '0', STR_PAD_LEFT);
        return ltrim($out, '0') ?: '0';
    }

    /** Schoolbook long division. @return array{0:string,1:string} quotient, remainder */
    private static function divMag(string $a, string $b): array
    {
        $b = ltrim($b, '0') ?: '0';
        $multiples = ['0'];
        for ($i = 1; $i <= 9; $i++) $multiples[$i] = self::addMag($multiples[$i - 1], $b);
        $q = '';
        $rem = '0';
        $len = strlen($a);
        for ($i = 0; $i < $len; $i++) {
            $rem = $rem === '0' ? $a[$i] : $rem . $a[$i];
            $rem = ltrim($rem, '0') ?: '0';
            $d = 0;
            if (self::cmpMag($rem, $b) >= 0) {
                for ($d = 9; $d > 0; $d--) {
                    if (self::cmpMag($multiples[$d], $rem) <= 0) break;
                }
                $rem = self::subMag($rem, $multiples[$d]);
            }
            $q .= $d;
        }
        return [ltrim($q, '0') ?: '0', $rem];
    }
}
