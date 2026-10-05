<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Confidential;
use Vitral\Core\Db;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\V;
use Vitral\Lib\DailyReport;
use Vitral\Lib\Jalali;

/**
 * Port of apps/server/src/modules/daily/public.ts — guest links (spec module 10, T44): read-only, no session,
 * token hashed at rest, expiry and revocation enforced, no financial data (built without finance and stripped again).
 * The file endpoint serves only files inside the link's scope (otherwise 404, never «exists but forbidden»).
 */
final class PublicShare
{
    private static function link(Db $db, string $token): ?array
    {
        $link = $db->one('SELECT * FROM share_links WHERE token_hash = ?', [hash('sha256', $token)]);
        if (!$link || $link['revoked'] || strtotime((string) $link['expires_at']) * 1000 + (int) substr((string) $link['expires_at'], 20, 3) < (int) floor(microtime(true) * 1000)) return null;
        return $link;
    }

    /** Jalali date of a share link's scope_date (UTC noon of that Gregorian day). */
    private static function scopeJalali(string $scopeDate): array
    {
        [$y, $m, $d] = array_map('intval', explode('-', substr($scopeDate, 0, 10)));
        return Jalali::toJalali($y, $m, $d);
    }

    public static function register(Router $r, App $app): void
    {
        $r->get('/public/share/:token', static function (Request $req) use ($app) {
            ['token' => $token] = V::object(['token' => V::string()->min(20)->max(100)])->parse($req->params);
            $db = $app->db();
            $link = self::link($db, $token);
            if (!$link) throw new AppError('not_found', 'این لینک معتبر نیست یا منقضی شده است');
            $db->exec('UPDATE share_links SET open_count = ?, last_opened_at = NOW(3) WHERE id = ?', [$link['open_count'] + 1, $link['id']]);
            if ($link['scope_type'] === 'daily_report') {
                $rep = DailyReport::buildDailyReport($db, self::scopeJalali((string) $link['scope_date']), ['finance' => false]);
                $bundleIds = array_column($rep['production']['bundles'], 'id');
                $photos = array_values(array_filter(Daily::galleryItems($db, []), static fn ($p) => in_array($p['owner_id'], $bundleIds, true)));
                $out = ['scope' => 'daily_report'];
                foreach ($rep as $k => $v) {
                    if (in_array($k, ['money', 'free_notes', 'tasks'], true)) continue;
                    $out[$k] = $k === 'decisions' ? ['quarantine' => $v['quarantine'], 'weight_warnings' => $v['weight_warnings']] : $v;
                }
                $out['photos'] = array_slice($photos, 0, 60);
                $out['expires_at'] = $link['expires_at'];
                return Confidential::strip($out);
            }
            if ($link['scope_type'] === 'bundle_gallery') {
                $b = $db->one(
                    'SELECT bundles.id, bundles.code, bundles.weight_kg, bundles.form, bundles.color, bundles.status, bundles.reported_at, parties.name AS factory_name
                       FROM bundles LEFT JOIN parties ON parties.id = bundles.factory_party_id WHERE bundles.id = ?',
                    [$link['scope_id']],
                );
                if (!$b) throw new AppError('not_found');
                $lines = $db->all(
                    'SELECT products.name_fa AS product_name, products.code AS product_code, bundle_lines.length_m, bundle_lines.filler_mm, bundle_lines.bars, bundle_lines.weight_kg
                       FROM bundle_lines INNER JOIN products ON products.id = bundle_lines.product_id WHERE bundle_id = ?',
                    [$b['id']],
                );
                return Confidential::strip(['scope' => 'bundle_gallery', 'bundle' => $b + ['lines' => $lines], 'photos' => Daily::galleryItems($db, ['bundle_id' => $b['id']]), 'expires_at' => $link['expires_at']]);
            }
            $d = $db->one(
                'SELECT documents.id, documents.number, documents.kind, documents.`date`, documents.amount, documents.currency, documents.status, documents.description,
                        parties.name AS party_name, orders.number AS order_number
                   FROM documents LEFT JOIN parties ON parties.id = documents.party_id LEFT JOIN orders ON orders.id = documents.order_id WHERE documents.id = ?',
                [$link['scope_id']],
            );
            if (!$d || !in_array($d['kind'], ['invoice', 'sales_return'], true)) throw new AppError('not_found');
            $lines = $db->all('SELECT description, qty, unit, unit_price, amount, sort FROM document_lines WHERE document_id = ? ORDER BY sort', [$d['id']]);
            $file = $db->value(
                "SELECT files.id FROM file_links INNER JOIN files ON files.id = file_links.file_id
                  WHERE entity = 'documents' AND entity_id = ? AND files.mime = 'application/pdf' ORDER BY files.created_at DESC LIMIT 1",
                [$d['id']],
            );
            return Confidential::strip(['scope' => 'document', 'document' => $d + ['lines' => $lines], 'pdf_file_id' => $file, 'expires_at' => $link['expires_at']]);
        }, ['rateLimit' => ['max' => 60, 'window' => 60]]);

        // Public thumbnail/file for a share link's photos: the token proves access to that scope only.
        $r->get('/public/share/:token/files/:id', static function (Request $req) use ($app) {
            ['token' => $token, 'id' => $id] = V::object(['token' => V::string()->min(20)->max(100), 'id' => V::string()->uuid()])->parse($req->params);
            $db = $app->db();
            $link = self::link($db, $token);
            if (!$link) throw new AppError('not_found');
            $f = $db->one('SELECT * FROM files WHERE id = ? AND `sensitive` = 0', [$id]);
            if (!$f) throw new AppError('not_found');
            if ($link['scope_type'] === 'document') {
                $entity = 'documents';
                $ids = [$link['scope_id']];
            } elseif ($link['scope_type'] === 'bundle_gallery') {
                $entity = 'bundles';
                $ids = [$link['scope_id']];
            } else {
                // daily_report: exactly the bundles that report lists (that Jalali day's production bundles).
                $range = Jalali::dayRange(self::scopeJalali((string) $link['scope_date']));
                $entity = 'bundles';
                $ids = array_column(DailyReport::productionSection($db, $range['start'], $range['end'])['bundles'], 'id');
            }
            $ids = array_values(array_filter($ids, static fn ($x) => $x !== null));
            $allowed = count($ids) > 0 && (
                ($f['owner_entity'] === $entity && $f['owner_id'] !== null && in_array($f['owner_id'], $ids, true))
                || $db->value('SELECT id FROM file_links WHERE file_id = ? AND entity = ? AND entity_id IN (' . Db::placeholders($ids) . ') LIMIT 1', array_merge([$f['id'], $entity], $ids)) !== null
            );
            if (!$allowed) throw new AppError('not_found');
            $q = $req->query['thumb'] ?? null;
            $thumb = $q === '1' && $f['thumb_key'];
            return Response::file($app->storage()->pathFor($thumb ? $f['thumb_key'] : $f['storage_key']), $thumb ? 'image/webp' : $f['mime'])
                ->header('cache-control', 'private, max-age=3600')
                ->header('x-content-type-options', 'nosniff');
        }, ['rateLimit' => ['max' => 300, 'window' => 60]]);
    }
}
