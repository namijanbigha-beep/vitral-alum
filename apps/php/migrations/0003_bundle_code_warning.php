<?php
declare(strict_types=1);

use Vitral\Core\Db;
use Vitral\Core\Migrator as M;

/**
 * MySQL translation of 0003_bundle_code_warning.ts (T49 / module 4): a repeated bundle code at the same factory is
 * a warning that puts the bundle in «needs review»; it must not block recording. The emulated partial unique index
 * of 0002 (generated column `_g_factory_code`) becomes a plain lookup index.
 */
return function (Db $db, M $m): void {
    $m->exec('ALTER TABLE bundles DROP INDEX bundles_factory_code_key');
    $m->exec('ALTER TABLE bundles DROP COLUMN _g_factory_code');
    $m->exec('CREATE INDEX bundles_factory_code_idx ON bundles (factory_party_id, code)');
};
