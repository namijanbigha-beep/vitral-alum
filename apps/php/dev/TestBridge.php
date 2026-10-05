<?php
declare(strict_types=1);

/**
 * Test-only bridge for the conformance harness (apps/server/test/helpers.ts with VITRAL_TARGET=php).
 * Reached only through public/router-dev.php under PHP's built-in server, only when the server was started with
 * VITRAL_TEST_BRIDGE_KEY and APP_ENV=test, and only with that key in the X-Test-Bridge-Key header.
 * Never part of the deployable zip (build.sh leaves dev/ out).
 *
 *   POST /__test/sql          {sql, params}  → {rows, numAffectedRows, insertId}   (t.db through Kysely)
 *   POST /__test/create-user  {mobile, password, role, permissions?, name?} → {id}
 *   GET  /__test/routes       → [{method, url}]                                 (app.routeList)
 *   GET  /__test/insert-defaults → Db::INSERT_DEFAULTS                          (Kysely insert plugin)
 */
if (PHP_SAPI !== 'cli-server') exit;
require_once dirname(__DIR__) . '/src/bootstrap.php';

use Vitral\Core\App;
use Vitral\Core\Auth;
use Vitral\Core\Db;
use Vitral\Core\Json;

$send = static function (int $status, mixed $body): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo Json::encode($body);
};

$key = (string) getenv('VITRAL_TEST_BRIDGE_KEY');
$given = (string) ($_SERVER['HTTP_X_TEST_BRIDGE_KEY'] ?? '');
$app = App::fromRoot(VITRAL_ROOT);
if ($key === '' || strlen($key) < 16 || !hash_equals($key, $given) || $app->config->str('APP_ENV') !== 'test') {
    $send(404, ['error' => 'not found']);
    return;
}

$path = (string) parse_url((string) $_SERVER['REQUEST_URI'], PHP_URL_PATH);
try {
    $in = ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' ? Json::toArray(Json::decode((string) file_get_contents('php://input'))) : [];
    switch ($path) {
        case '/__test/sql':
            $db = $app->db();
            $st = $db->query((string) $in['sql'], array_values((array) ($in['params'] ?? [])));
            $rows = $st->columnCount() > 0 ? Db::fetchAllCast($st) : [];
            $send(200, [
                'rows' => $rows,
                'numAffectedRows' => (string) $st->rowCount(),
                'insertId' => (string) $db->pdo()->lastInsertId(),
            ]);
            return;
        case '/__test/create-user':
            $id = $app->db()->insertNoReturn('users', [
                'mobile' => (string) $in['mobile'],
                'name' => (string) ($in['name'] ?? 'کاربر آزمایشی'),
                'password_hash' => Auth::hashPassword((string) $in['password']),
                'role' => (string) $in['role'],
                'permissions' => array_values((array) ($in['permissions'] ?? [])),
            ]);
            $send(200, ['id' => $id]);
            return;
        case '/__test/routes':
            $app->loadModules();
            $send(200, $app->router->routeList());
            return;
        case '/__test/insert-defaults':
            $send(200, (object) Db::INSERT_DEFAULTS);
            return;
    }
    $send(404, ['error' => 'not found']);
} catch (\PDOException $e) {
    $send(400, ['error' => $e->errorInfo[2] ?? $e->getMessage(), 'code' => $e->errorInfo[1] ?? null, 'sqlstate' => $e->getCode()]);
} catch (\Throwable $e) {
    $send(500, ['error' => $e->getMessage(), 'at' => $e->getFile() . ':' . $e->getLine()]);
}
