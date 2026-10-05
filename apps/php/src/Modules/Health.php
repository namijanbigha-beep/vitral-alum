<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\Response;
use Vitral\Core\Router;

/** Port of apps/server/src/modules/health/routes.ts: database reachability and disk use; no data, no versions. */
final class Health
{
    public static function register(Router $r, App $app): void
    {
        $r->get('/health', static function () use ($app) {
            try {
                $app->db()->value('SELECT 1');
                $dbOk = true;
            } catch (\Throwable) {
                $dbOk = false;
            }
            $disk = self::diskUsagePercent($app->config->str('FILE_STORAGE_DIR'));
            $diskOk = $disk !== null && $disk < 95;
            return Response::json([
                'status' => $dbOk && $diskOk ? 'ok' : 'degraded',
                'db' => $dbOk ? 'ok' : 'down',
                'disk_used_percent' => $disk === null ? null : self::jsNumberString($disk),
                'disk_warning' => $disk !== null && $disk > 80,
            ], $dbOk ? 200 : 503);
        });
    }

    /** Used share of the file store's disk, one decimal; null when the host hides it (disabled functions). */
    public static function diskUsagePercent(string $dir): ?float
    {
        if (!function_exists('disk_total_space') || !function_exists('disk_free_space')) return null;
        $probe = is_dir($dir) ? $dir : dirname($dir);
        if (!is_dir($probe)) return null;
        $total = @disk_total_space($probe);
        $free = @disk_free_space($probe);
        if (!$total || $free === false) return null;
        return round((($total - $free) / $total) * 1000) / 10;
    }

    /** String(n) of JavaScript for a one-decimal number («88.6», «90»). */
    private static function jsNumberString(float $n): string
    {
        return floor($n) === $n ? (string) (int) $n : (string) json_encode($n);
    }
}
