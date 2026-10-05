<?php
declare(strict_types=1);

use Vitral\Core\Db;
use Vitral\Core\Migrator as M;

/**
 * MySQL translation of 0004_import_files.ts (spec §18): `/files` also stores xlsx / csv / json with kind `import`.
 * CHECK changes are best-effort: MySQL 5.7 neither stores nor drops CHECK constraints (the PHP code enforces
 * the same rules in Files::upload).
 */
return function (Db $db, M $m): void {
    $mimeBase = "'image/jpeg','image/png','image/webp','application/pdf','audio/ogg','audio/mp4','audio/mpeg'";
    $mimeImport = "'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv','application/json'";
    $kindBase = "'product','section','color_sample','drawing','die','bundle','label','load','vehicle','package','waybill','scale_ticket','receipt','delivery_receipt','voice','document_pdf','other'";
    $m->optional('ALTER TABLE files DROP CONSTRAINT files_mime_check', 'drop files_mime_check');
    $m->optional('ALTER TABLE files DROP CONSTRAINT files_kind_check', 'drop files_kind_check');
    $m->optional("ALTER TABLE files ADD CONSTRAINT files_mime_check CHECK (mime IN ({$mimeBase},{$mimeImport}))", 'files_mime_check with import types');
    $m->optional("ALTER TABLE files ADD CONSTRAINT files_kind_check CHECK (kind IN ({$kindBase},'import'))", "files_kind_check with 'import'");
    // Data files are import material only: never another kind, never public.
    $m->optional("ALTER TABLE files ADD CONSTRAINT files_import_mime_check CHECK (mime NOT IN ({$mimeImport}) OR (kind = 'import' AND `sensitive` = 1))", 'files_import_mime_check');
};
