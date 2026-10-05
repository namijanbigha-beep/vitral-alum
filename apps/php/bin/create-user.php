<?php
declare(strict_types=1);

/**
 * Create a user, or reset the password of an existing one (lost manager password, no SSH: run it from a cPanel cron job once).
 *   php bin/create-user.php <mobile> <manager|staff> [name]      password from env VITRAL_PASSWORD, else asked on stdin
 * An existing mobile gets the new password, is unlocked and keeps everything else; its sessions end.
 */
if (PHP_SAPI !== 'cli') exit(1);
require dirname(__DIR__) . '/src/bootstrap.php';

use Vitral\Core\Audit;
use Vitral\Core\Auth;
use Vitral\Core\Config;
use Vitral\Core\Db;
use Vitral\Core\V;

[$mobileArg, $role, $name] = [$argv[1] ?? '', $argv[2] ?? '', $argv[3] ?? 'مدیر'];
if ($mobileArg === '' || !in_array($role, ['manager', 'staff'], true)) {
    fwrite(STDERR, "usage: php bin/create-user.php <mobile> <manager|staff> [name]\n");
    exit(2);
}
$mobile = V::mobile()->safeParse($mobileArg);
if (!$mobile['success']) {
    fwrite(STDERR, "invalid mobile number\n");
    exit(2);
}
$password = getenv('VITRAL_PASSWORD');
if ($password === false || $password === '') {
    fwrite(STDOUT, 'password: ');
    $password = rtrim((string) fgets(STDIN), "\r\n");
}
if (mb_strlen($password) < 8) {
    fwrite(STDERR, "the password must have at least 8 characters\n");
    exit(2);
}

$db = Db::fromConfig(Config::load(dirname(__DIR__)));
$hash = Auth::hashPassword($password);
$db->transaction(static function (Db $trx) use ($mobile, $role, $name, $hash) {
    $existing = $trx->one('SELECT id FROM users WHERE mobile = ? FOR UPDATE', [$mobile['data']]);
    if ($existing) {
        $trx->update('users', ['password_hash' => $hash, 'failed_logins' => 0, 'locked_until' => null, 'active' => true] + Db::bump(), 'id = ?', [$existing['id']]);
        $trx->exec('DELETE FROM sessions WHERE user_id = ?', [$existing['id']]);
        Audit::log($trx, ['userId' => null, 'entity' => 'users', 'entityId' => $existing['id'], 'action' => 'password_reset', 'reason' => 'bin/create-user.php']);
        echo "password reset for {$mobile['data']}\n";
        return;
    }
    $id = $trx->insertNoReturn('users', ['mobile' => $mobile['data'], 'name' => $name, 'password_hash' => $hash, 'role' => $role, 'permissions' => []]);
    Audit::log($trx, ['userId' => null, 'entity' => 'users', 'entityId' => $id, 'action' => 'create', 'reason' => 'bin/create-user.php']);
    echo "created {$role} {$mobile['data']} ({$id})\n";
});
