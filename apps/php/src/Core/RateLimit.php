<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * Fixed-window rate limit per route and client IP, like @fastify/rate-limit (shared hosts have no Redis/APCu,
 * so the counters live in the `rate_limits` table). Adds the x-ratelimit-* headers; 429 when exceeded.
 */
final class RateLimit
{
    /** @return array{limit:int,remaining:int,reset:int} */
    public static function hit(Db $db, string $bucket, int $max, int $windowSeconds = 60): array
    {
        $key = hash('sha256', $bucket);
        $db->exec(
            'INSERT INTO rate_limits (bucket, window_start, hits) VALUES (?, NOW(3), 1)
             ON DUPLICATE KEY UPDATE
               hits = IF(window_start <= NOW(3) - INTERVAL ? SECOND, 1, hits + 1),
               window_start = IF(window_start <= NOW(3) - INTERVAL ? SECOND, NOW(3), window_start)',
            [$key, $windowSeconds, $windowSeconds],
        );
        $row = $db->one('SELECT hits, TIMESTAMPDIFF(SECOND, NOW(3), window_start + INTERVAL ? SECOND) AS ttl FROM rate_limits WHERE bucket = ?', [$windowSeconds, $key]);
        $hits = (int) ($row['hits'] ?? 1);
        if (random_int(1, 200) === 1) $db->exec('DELETE FROM rate_limits WHERE window_start < NOW(3) - INTERVAL 1 DAY');
        return ['limit' => $max, 'remaining' => max(0, $max - $hits), 'reset' => max(0, (int) ($row['ttl'] ?? $windowSeconds)), 'exceeded' => $hits > $max];
    }
}
