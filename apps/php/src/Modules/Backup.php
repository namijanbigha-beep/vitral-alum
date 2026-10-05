<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\Db;
use Vitral\Core\Json;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\V;

/**
 * Port of apps/server/src/modules/backup/routes.ts. On shared hosting backups come from cPanel
 * (or a cron job writing vitral-*.tar|enc|age|gpg into BACKUP_DIR); the app lists what exists and keeps the
 * monthly restore-test log (section 17), exactly like the Node app.
 */
final class Backup
{
    public static function register(Router $r, App $app): void
    {
        $r->get('/backup', static function (Request $req) use ($app) {
            $req->requirePermission('settings.manage');
            $dir = $app->config->str('BACKUP_DIR');
            $entries = [];
            foreach (is_dir($dir) ? (scandir($dir) ?: []) : [] as $name) {
                if (!preg_match('/^vitral-.*\.(tar|enc|age|gpg)$/', $name)) continue;
                $st = @stat($dir . '/' . $name);
                if ($st === false) continue;
                $entries[] = ['name' => $name, 'size' => (string) $st['size'], 'modified_at' => gmdate('Y-m-d\TH:i:s.000\Z', $st['mtime'])];
            }
            usort($entries, static fn ($a, $b) => $a['modified_at'] < $b['modified_at'] ? 1 : -1);
            $log = $app->db()->one('SELECT value, version FROM settings WHERE `key` = ?', ['restore_test_log']);
            return [
                'backups' => $entries,
                'backup_dir_available' => $entries !== [] || file_exists($dir),
                'restore_tests' => $log['value'] ?? [],
                'encryption_configured' => (bool) $app->config->get('BACKUP_ENCRYPTION_KEY'),
            ];
        });

        $r->post('/backup/restore-test', static function (Request $req) use ($app) {
            $me = $req->requirePermission('settings.manage');
            $body = V::object([
                'tested_at' => V::string()->datetime(),
                'duration_minutes' => V::int()->min(0)->max(100000),
                'result' => V::enum(['ok', 'failed']),
                'note' => V::string()->trim()->max(1000)->optional(),
            ])->parse($req->body());
            $entry = $body + ['by' => $me->id, 'recorded_at' => Json::iso(new \DateTimeImmutable())];
            $app->db()->transaction(static function (Db $trx) use ($entry, $me) {
                $row = $trx->one('SELECT * FROM settings WHERE `key` = ? FOR UPDATE', ['restore_test_log']);
                if (!$row) throw new AppError('not_found');
                $list = is_array($row['value']) && array_is_list($row['value']) ? $row['value'] : [];
                $trx->update('settings', ['value' => Json::encode(array_slice([$entry, ...$list], 0, 60))] + Db::bump(), '`key` = ?', ['restore_test_log']);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'settings', 'entityId' => $row['id'], 'action' => 'restore_test_logged', 'after' => $entry]);
            });
            return Response::json($entry, 201);
        });

    }
}
