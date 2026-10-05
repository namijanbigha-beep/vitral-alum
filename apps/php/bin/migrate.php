<?php
declare(strict_types=1);

/**
 * Apply pending migrations to the database of config.php (or the environment with VITRAL_CONFIG_FROM_ENV=1).
 *   php apps/php/bin/migrate.php            # migrate
 *   php apps/php/bin/migrate.php status     # list applied / pending
 */
if (PHP_SAPI !== 'cli') exit(1);
require dirname(__DIR__) . '/src/bootstrap.php';

use Vitral\Core\Config;
use Vitral\Core\Db;
use Vitral\Core\Migrator;

$root = dirname(__DIR__);
$config = Config::load($root);
$db = Db::fromConfig($config);
$m = new Migrator($db, $root . '/migrations');
if (($argv[1] ?? '') === 'status') {
    $applied = $m->applied();
    foreach ($m->available() as $name) echo (in_array($name, $applied, true) ? '[x] ' : '[ ] '), $name, "\n";
    exit(0);
}
$ran = $m->migrate(static fn (string $name) => print("applied {$name}\n"));
foreach ($m->warnings as $w) fwrite(STDERR, "warning: {$w}\n");
echo $ran ? count($ran) . " migration(s) applied\n" : "database is up to date\n";
