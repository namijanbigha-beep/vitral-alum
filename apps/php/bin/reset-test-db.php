<?php
declare(strict_types=1);

/**
 * Drop every table of the TEST database and migrate it from scratch (conformance tests).
 * Connection: env DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASS, default vitral/vitral@127.0.0.1/vitral_php_test.
 * Refuses to touch a database whose name does not end in «_test» (or «_test_w<N>» for parallel test databases).
 */
if (PHP_SAPI !== 'cli') exit(1);
require dirname(__DIR__) . '/src/bootstrap.php';

use Vitral\Core\Db;
use Vitral\Core\Migrator;

$name = getenv('DB_NAME') ?: 'vitral_php_test';
if (!preg_match('/_test(_w\d+)?$/', $name)) {
    fwrite(STDERR, "refusing to reset «{$name}»: the name must end in _test\n");
    exit(1);
}
$db = new Db([
    'host' => getenv('DB_HOST') ?: '127.0.0.1',
    'port' => getenv('DB_PORT') ?: '3306',
    'name' => $name,
    'user' => getenv('DB_USER') ?: 'vitral',
    'pass' => getenv('DB_PASS') !== false ? (string) getenv('DB_PASS') : 'vitral',
    'socket' => getenv('DB_SOCKET') ?: '',
]);
Migrator::dropAll($db);
$m = new Migrator($db, dirname(__DIR__) . '/migrations');
$m->migrate();
foreach ($m->warnings as $w) fwrite(STDERR, "warning: {$w}\n");
echo "reset {$name}\n";
