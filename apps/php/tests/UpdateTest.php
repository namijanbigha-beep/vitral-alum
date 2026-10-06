<?php
declare(strict_types=1);

use Vitral\Core\AppError;
use Vitral\Lib\Zip;
use Vitral\Modules\Update;

$zip = static fn (array $files): string => Zip::buildZip(array_map(static fn ($n, $d) => ['name' => $n, 'data' => $d], array_keys($files), $files));
$base = ['index.php' => '<?php // new', 'src/bootstrap.php' => '<?php // new', 'src/version.php' => "<?php return 'v2';"];
$tmpRoot = static function (): string {
    $d = sys_get_temp_dir() . '/vitral-update-' . bin2hex(random_bytes(4));
    mkdir($d . '/src/Modules', 0777, true);
    mkdir($d . '/assets', 0777, true);
    mkdir($d . '/data', 0777, true);
    file_put_contents($d . '/index.php', '<?php // old');
    file_put_contents($d . '/src/bootstrap.php', '<?php // old');
    file_put_contents($d . '/src/Modules/Gone.php', '<?php // removed in v2');
    file_put_contents($d . '/assets/index-old.js', 'old');
    file_put_contents($d . '/config.php', '<?php return ["secret" => 1];');
    file_put_contents($d . '/data/install.lock', 'x');
    file_put_contents($d . '/icon.svg', 'kept: outside owned folders');
    return $d;
};

return [
    'entries skips config, installer and data' => function () use ($zip, $base) {
        $e = Update::entries($zip($base + ['config.php' => 'evil', 'install.php' => 'reinstall', 'data/install.lock' => '', 'assets/a.js' => 'a', 'src/' => '']));
        T::eq(['index.php', 'src/bootstrap.php', 'src/version.php', 'assets/a.js'], array_keys($e));
    },
    'entries refuses paths that leave the folder' => function () use ($zip, $base) {
        foreach (['../x.php', 'src/../../x.php', '/etc/x', 'C:/x', 'a\\b.php'] as $bad) {
            $e = T::throws(fn () => Update::entries($zip($base + [$bad => 'x'])), AppError::class, $bad);
            T::true(str_contains($e->getMessage(), 'مسیر'), $bad);
        }
    },
    'entries needs a complete release' => function () use ($zip) {
        T::throws(fn () => Update::entries($zip(['index.php' => 'x'])), AppError::class);
        T::throws(fn () => Update::entries('not a zip'), AppError::class);
    },
    'install replaces code, drops stale modules and assets, keeps config and data' => function () use ($zip, $base, $tmpRoot) {
        $root = $tmpRoot();
        $removed = Update::install(Update::entries($zip($base + ['assets/index-new.js' => 'new', 'src/Modules/Kept.php' => '<?php'])), $root);
        T::eq(2, $removed);
        T::eq('<?php // new', file_get_contents($root . '/index.php'));
        T::eq("<?php return 'v2';", file_get_contents($root . '/src/version.php'));
        T::true(!is_file($root . '/src/Modules/Gone.php'), 'stale module removed');
        T::true(!is_file($root . '/assets/index-old.js'), 'stale asset removed');
        T::true(is_file($root . '/assets/index-new.js') && is_file($root . '/src/Modules/Kept.php'));
        T::eq('<?php return ["secret" => 1];', file_get_contents($root . '/config.php'));
        T::true(is_file($root . '/data/install.lock') && is_file($root . '/icon.svg'));
        T::eq([], glob($root . '/{,*/,*/*/}*.vitral-new', GLOB_BRACE) ?: []);
    },
];
