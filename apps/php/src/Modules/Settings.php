<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\AuthUser;
use Vitral\Core\Db;
use Vitral\Core\Json;
use Vitral\Core\Request;
use Vitral\Core\Router;
use Vitral\Core\SettingsCatalog;
use Vitral\Core\Undef;
use Vitral\Core\V;

/** Port of apps/server/src/modules/settings/routes.ts (catalog in Core/SettingsCatalog.php). */
final class Settings
{
    public static function present(array $row): array
    {
        $def = SettingsCatalog::def($row['key']);
        return [
            'key' => $row['key'],
            'label' => $def['label'] ?? $row['key'],
            'value' => $row['value'],
            'readonly' => $def['readonly'] ?? false,
            'updated_at' => $row['updated_at'],
            'version' => $row['version'],
        ];
    }

    private static function visible(Request $req, string $key): bool
    {
        $def = SettingsCatalog::def($key);
        if (!$def) return false;
        return empty($def['finance']) || $req->can('finance.view');
    }

    public static function register(Router $r, App $app): void
    {
        // Every signed-in user reads the settings the forms need; confidential ones only with finance.view.
        $r->get('/settings', static function (Request $req) use ($app) {
            $req->requireUser();
            $rows = $app->db()->all('SELECT * FROM settings ORDER BY `key`');
            $items = [];
            foreach ($rows as $row) {
                if (self::visible($req, $row['key'])) $items[] = self::present($row);
            }
            return ['items' => $items];
        });

        $r->put('/settings/:key', static function (Request $req) use ($app) {
            $me = $req->requirePermission('settings.manage');
            ['key' => $key] = V::object(['key' => V::string()->max(80)])->parse($req->params);
            $def = SettingsCatalog::def($key);
            if (!$def || !empty($def['readonly'])) throw new AppError('not_found');
            if (!empty($def['finance']) && !$req->can('finance.view')) throw new AppError('forbidden');
            $body = V::object([
                'version' => V::int()->nonnegative(),
                'value' => V::unknown(),
                'reason' => V::string()->trim()->max(500)->optional(),
            ])->parse($req->body());
            $parsed = $def['schema']->safeParse(array_key_exists('value', $body) ? $body['value'] : Undef::Value);
            if (!$parsed['success']) {
                $msg = $parsed['issues'][0]['message'] ?? null;
                throw new AppError('validation', $msg ?? 'مقدار نامعتبر است', ['value' => $msg ?? 'نامعتبر']);
            }
            return $app->db()->transaction(static function (Db $trx) use ($key, $body, $parsed, $me) {
                $before = $trx->one('SELECT * FROM settings WHERE `key` = ? FOR UPDATE', [$key]);
                if (!$before) throw new AppError('not_found');
                if ($before['version'] !== $body['version']) throw AppError::conflict(self::present($before));
                $trx->update('settings', ['value' => Json::encode($parsed['data'] ?? null)] + Db::bump(), '`key` = ?', [$key]);
                $after = $trx->one('SELECT * FROM settings WHERE `key` = ?', [$key]);
                Audit::log($trx, [
                    'userId' => $me->id,
                    'entity' => 'settings',
                    'entityId' => $after['id'],
                    'action' => 'update',
                    'before' => ['key' => $key, 'value' => $before['value']],
                    'after' => ['key' => $key, 'value' => $after['value']],
                    'reason' => $body['reason'] ?? null,
                ]);
                return self::present($after);
            });
        });
    }
}
