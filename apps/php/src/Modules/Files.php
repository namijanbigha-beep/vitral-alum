<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\AuthUser;
use Vitral\Core\Db;
use Vitral\Core\Idempotency;
use Vitral\Core\Multipart;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\V;
use Vitral\Lib\FileType;
use Vitral\Lib\Image;

/** Port of apps/server/src/modules/files (routes.ts + service.ts). */
final class Files
{
    public const MAX_FILE_BYTES = 20971520;
    public const KINDS = ['product', 'section', 'color_sample', 'drawing', 'die', 'bundle', 'label', 'load', 'vehicle', 'package', 'waybill', 'scale_ticket', 'receipt', 'delivery_receipt', 'voice', 'document_pdf', 'import', 'other'];

    public static function present(array $f): array
    {
        return [
            'id' => $f['id'],
            'original_name' => $f['original_name'],
            'mime' => $f['mime'],
            'size' => (string) $f['size'],
            'sha256' => $f['sha256'],
            'kind' => $f['kind'],
            'caption' => $f['caption'],
            'sensitive' => $f['sensitive'],
            'owner_entity' => $f['owner_entity'],
            'owner_id' => $f['owner_id'],
            'sort_order' => $f['sort_order'],
            'has_thumb' => $f['thumb_key'] !== null,
            'created_at' => $f['created_at'],
            'created_by' => $f['created_by'],
            'version' => $f['version'],
        ];
    }

    /** Principle 6 and section 6: sensitive files open only with finance.view, or for the person who uploaded them. */
    public static function canOpen(AuthUser $user, array $file): bool
    {
        if (!$file['sensitive']) return true;
        return \Vitral\Core\Auth::can($user, 'finance.view') || $file['created_by'] === $user->id;
    }

    private static function safeName(string $name): string
    {
        $cleaned = mb_substr(\Vitral\Lib\Num::jsTrim((string) preg_replace('/[\\\\\/\0\r\n"]/', '_', $name)), 0, 200);
        return $cleaned !== '' ? $cleaned : 'file';
    }

    /** encodeURIComponent of JavaScript. */
    public static function encodeURIComponent(string $s): string
    {
        return strtr(rawurlencode($s), ['%21' => '!', '%2A' => '*', '%27' => "'", '%28' => '(', '%29' => ')']);
    }

    public static function register(Router $r, App $app): void
    {
        $r->post('/files', static fn (Request $req) => self::upload($req, $app), ['rateLimit' => ['max' => 120, 'window' => 60]]);

        $load = static function (Request $req) use ($app): array {
            ['id' => $id] = V::idParam()->parse($req->params);
            $row = $app->db()->find('files', $id);
            if (!$row) throw new AppError('not_found');
            return $row;
        };

        $r->get('/files/:id', static function (Request $req) use ($load) {
            $me = $req->requireUser();
            $row = $load($req);
            if (!self::canOpen($me, $row)) throw new AppError('forbidden');
            return self::present($row);
        });

        $r->get('/files/:id/download', static function (Request $req) use ($app, $load) {
            $me = $req->requireUser();
            $row = $load($req);
            if (!self::canOpen($me, $row)) throw new AppError('forbidden');
            if ($row['sensitive']) {
                Audit::log($app->db(), ['userId' => $me->id, 'entity' => 'files', 'entityId' => $row['id'], 'action' => 'open_sensitive']);
            }
            $inline = ($req->query['inline'] ?? null) === '1';
            return Response::file($app->storage()->pathFor($row['storage_key']), $row['mime'])
                ->header('content-length', (string) $row['size'])
                ->header('cache-control', 'private, max-age=3600')
                ->header('x-content-type-options', 'nosniff')
                ->header('content-disposition', ($inline ? 'inline' : 'attachment') . "; filename=\"file\"; filename*=UTF-8''" . self::encodeURIComponent($row['original_name']));
        });

        $r->get('/files/:id/thumb', static function (Request $req) use ($app, $load) {
            $me = $req->requireUser();
            $row = $load($req);
            if (!self::canOpen($me, $row)) throw new AppError('forbidden');
            if ($row['thumb_key'] === null) throw new AppError('not_found');
            return Response::file($app->storage()->pathFor($row['thumb_key']), 'image/webp')
                ->header('cache-control', 'private, max-age=86400');
        });
    }

    private static function upload(Request $req, App $app): Response
    {
        $me = $req->requireUser();
        $key = Idempotency::requireKey($req);
        if (!$req->isMultipart()) throw new AppError('validation', 'فایل ارسال نشده است');

        $parts = Multipart::read($req, self::MAX_FILE_BYTES);
        $upload = $parts['file'];
        if ($upload !== null && $upload['truncated']) {
            throw new AppError('validation', 'حجم فایل بیش از ۲۰ مگابایت است', ['file' => 'حداکثر ۲۰ مگابایت']);
        }
        if ($upload === null || $upload['data'] === '') throw new AppError('validation', 'فایل خالی است', ['file' => 'لازم است']);
        $meta = V::object([
            'kind' => V::enum(self::KINDS)->default('other'),
            'caption' => V::string()->trim()->max(200)->optional(),
            'sensitive' => V::enum(['true', 'false'])->default('false'),
            'owner_entity' => V::string()->regex('/^[a-z_]{1,40}$/')->optional(),
            'owner_id' => V::string()->uuid()->optional(),
            'sort_order' => V::coerceNumber()->int()->min(0)->max(10000)->default(0),
        ])->parse($parts['fields']);

        // Spec §18: import files (xlsx / csv / json) only as kind `import`, only for settings.manage, always sensitive, never thumbnailed.
        $isImport = $meta['kind'] === 'import';
        if ($isImport && !$req->can('settings.manage')) throw new AppError('forbidden', 'بارگذاری فایل ورود گروهی فقط با مجوز تنظیمات است');
        $mime = $isImport ? FileType::detectImportMime($upload['data']) : FileType::detectMime($upload['data']);
        if ($mime === null) {
            throw new AppError(
                'validation',
                $isImport ? 'نوع فایل مجاز نیست؛ برای ورود گروهی فقط XLSX، CSV یا JSON' : 'نوع فایل مجاز نیست؛ فقط JPEG، PNG، WebP، PDF، OGG، M4A و MP3',
                ['file' => 'نوع فایل مجاز نیست'],
            );
        }

        $stored = $upload['data'];
        $thumb = null;
        if (!$isImport && FileType::isImage($mime)) {
            try {
                $stored = Image::normalise($upload['data'], $mime);
                $thumb = Image::thumb($stored);
            } catch (\Throwable) {
                throw new AppError('validation', 'تصویر خراب است یا خوانده نمی‌شود', ['file' => 'تصویر خراب است']);
            }
        }

        $storage = $app->storage();
        $storageKey = $storage->put($stored);
        $thumbKey = $thumb !== null ? $storage->put($thumb) : null;
        $originalName = self::safeName($upload['filename']);
        try {
            $result = Idempotency::run($app->db(), $key, $me->id, 'POST /files', static function (Db $trx) use ($storageKey, $thumbKey, $originalName, $mime, $stored, $meta, $isImport, $me) {
                $row = $trx->insert('files', [
                    'storage_key' => $storageKey,
                    'thumb_key' => $thumbKey,
                    'original_name' => $originalName,
                    'mime' => $mime,
                    'size' => strlen($stored),
                    'sha256' => hash('sha256', $stored),
                    'kind' => $meta['kind'],
                    'caption' => $meta['caption'] ?? null,
                    'sensitive' => $isImport || $meta['sensitive'] === 'true',
                    'owner_entity' => $meta['owner_entity'] ?? null,
                    'owner_id' => $meta['owner_id'] ?? null,
                    'sort_order' => $meta['sort_order'],
                    'created_by' => $me->id,
                ]);
                if ($row['owner_entity'] !== null && $row['owner_entity'] !== '' && $row['owner_id'] !== null) {
                    $trx->insertNoReturn('file_links', ['file_id' => $row['id'], 'entity' => $row['owner_entity'], 'entity_id' => $row['owner_id'], 'created_by' => $me->id]);
                }
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'files', 'entityId' => $row['id'], 'action' => 'create', 'after' => self::present($row)]);
                return ['status' => 201, 'body' => self::present($row)];
            });
        } catch (\Throwable $e) {
            $storage->remove($storageKey);
            if ($thumbKey !== null) $storage->remove($thumbKey);
            throw $e;
        }
        if ($result['replayed']) {
            $storage->remove($storageKey);
            if ($thumbKey !== null) $storage->remove($thumbKey);
        }
        return Response::json($result['body'], $result['status']);
    }
}
