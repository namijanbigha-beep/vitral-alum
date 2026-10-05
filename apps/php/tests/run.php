<?php
declare(strict_types=1);

/**
 * Minimal unit-test runner (no PHPUnit / Composer needed).
 *   php apps/php/tests/run.php            # every tests/*Test.php
 *   php apps/php/tests/run.php Decimal    # files whose name contains «Decimal»
 * A test file returns an array of name => callable; a callable fails by throwing.
 */
require dirname(__DIR__) . '/src/bootstrap.php';

final class T
{
    public static int $assertions = 0;

    public static function eq(mixed $expected, mixed $actual, string $msg = ''): void
    {
        self::$assertions++;
        if ($expected !== $actual) {
            throw new RuntimeException(($msg !== '' ? "$msg: " : '') . 'expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
        }
    }

    public static function true(bool $cond, string $msg = 'expected true'): void
    {
        self::$assertions++;
        if (!$cond) throw new RuntimeException($msg);
    }

    public static function throws(callable $fn, string $class = Throwable::class, string $msg = ''): Throwable
    {
        self::$assertions++;
        try {
            $fn();
        } catch (Throwable $e) {
            if ($e instanceof $class) return $e;
            throw new RuntimeException("$msg: expected $class, got " . get_class($e) . ': ' . $e->getMessage());
        }
        throw new RuntimeException("$msg: expected $class to be thrown");
    }

    /** @return array<string,mixed> */
    public static function fixtures(): array
    {
        static $f = null;
        return $f ??= json_decode((string) file_get_contents(__DIR__ . '/fixtures/shared.json'), true, 512, JSON_THROW_ON_ERROR);
    }
}

$filter = $argv[1] ?? '';
$files = glob(__DIR__ . '/*Test.php') ?: [];
sort($files);
$failed = 0;
$passed = 0;
foreach ($files as $file) {
    if ($filter !== '' && !str_contains(basename($file), $filter)) continue;
    $tests = require $file;
    foreach ($tests as $name => $fn) {
        try {
            $fn();
            $passed++;
            echo "  ok   ", basename($file, '.php'), " › $name\n";
        } catch (Throwable $e) {
            $failed++;
            echo "  FAIL ", basename($file, '.php'), " › $name\n       ", $e->getMessage(), "\n";
        }
    }
}
echo "\n$passed passed, $failed failed, " . T::$assertions . " assertions\n";
exit($failed ? 1 : 0);
