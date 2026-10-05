<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * Runs migrations/NNNN_name.php in order. Each file returns `function (Db $db, Migrator $m): void`.
 * MySQL DDL is not transactional, so statements run through $m->exec(), which tolerates «already exists»
 * errors: a migration interrupted halfway (shared-host timeout) can simply be run again.
 * $m->optional() runs defence-in-depth extras (triggers, CHECK changes) that some hosts refuse
 * (MySQL 5.7 has no DROP CHECK; binary logging without SUPER forbids triggers); failures become warnings.
 */
final class Migrator
{
    /** Column type of every id / foreign key (same definition everywhere, or InnoDB refuses the FK). VARCHAR, not CHAR: MariaDB refuses CHAR columns inside generated-column expressions (PAD_CHAR_TO_FULL_LENGTH). */
    public const UUID = 'VARCHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci';
    public const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

    /** MySQL error numbers meaning «this already exists / is already gone». */
    private const IDEMPOTENT_ERRORS = [1050, 1060, 1061, 1068, 1091, 1826, 1359, 1360, 1022, 3822, 4031];

    /** @var list<string> */
    public array $warnings = [];
    private string $current = '';

    public function __construct(private readonly Db $db, private readonly string $dir)
    {
    }

    /** `id`, `created_at`, `created_by` of every table (the BASE of 0002_domain.ts). */
    public static function base(string $table): string
    {
        return 'id ' . self::UUID . ' NOT NULL PRIMARY KEY,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by ' . self::UUID . " NULL,
  CONSTRAINT fk_{$table}_created_by FOREIGN KEY (created_by) REFERENCES users(id)";
    }

    /** BASE plus `updated_at` and `version` (EDITABLE). */
    public static function editable(string $table): string
    {
        return self::base($table) . ',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  version INT NOT NULL DEFAULT 1';
    }

    public static function fk(string $table, string $column, string $refTable, string $onDelete = ''): string
    {
        return "CONSTRAINT fk_{$table}_{$column} FOREIGN KEY ({$column}) REFERENCES {$refTable}(id)" . ($onDelete !== '' ? " ON DELETE {$onDelete}" : '');
    }

    public function exec(string $sql, array $params = []): void
    {
        try {
            $this->db->exec($sql, $params);
        } catch (\PDOException $e) {
            if (in_array((int) ($e->errorInfo[1] ?? 0), self::IDEMPOTENT_ERRORS, true)) return;
            throw new \RuntimeException("migration {$this->current} failed: " . $e->getMessage() . "\nSQL: " . trim(substr($sql, 0, 400)), 0, $e);
        }
    }

    public function optional(string $sql, string $what): void
    {
        try {
            $this->db->exec($sql);
        } catch (\PDOException $e) {
            if (in_array((int) ($e->errorInfo[1] ?? 0), self::IDEMPOTENT_ERRORS, true)) return;
            $this->warnings[] = "{$this->current}: {$what} skipped (" . ($e->errorInfo[2] ?? $e->getMessage()) . ')';
        }
    }

    public function table(string $name, string $body): void
    {
        $this->exec("CREATE TABLE IF NOT EXISTS {$name} (\n  {$body}\n) " . self::TABLE_OPTIONS);
    }

    /** Insert a settings row unless it exists (seed of 0001/0002). */
    public function seedSetting(string $key, mixed $value): void
    {
        $this->exec(
            'INSERT INTO settings (id, `key`, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `key` = `key`',
            [Db::uuid(), $key, Json::encode($value)],
        );
    }

    private function ensureLedger(): void
    {
        $this->db->exec('CREATE TABLE IF NOT EXISTS schema_migrations (
            name VARCHAR(191) NOT NULL PRIMARY KEY,
            applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            warnings TEXT NULL
        ) ' . self::TABLE_OPTIONS);
    }

    /** @return list<string> names already applied */
    public function applied(): array
    {
        $this->ensureLedger();
        return $this->db->column('SELECT name FROM schema_migrations ORDER BY name');
    }

    /** @return list<string> migration names on disk, in order */
    public function available(): array
    {
        $files = glob($this->dir . '/[0-9][0-9][0-9][0-9]_*.php') ?: [];
        sort($files);
        return array_map(static fn ($f) => basename($f, '.php'), $files);
    }

    /**
     * Apply every pending migration. @param callable(string):void|null $log
     * @return list<string> names applied now
     */
    public function migrate(?callable $log = null): array
    {
        $done = $this->applied();
        $ran = [];
        foreach ($this->available() as $name) {
            if (in_array($name, $done, true)) continue;
            $this->current = $name;
            $before = count($this->warnings);
            $fn = require $this->dir . '/' . $name . '.php';
            if (!is_callable($fn)) throw new \RuntimeException("migration {$name} does not return a function");
            $fn($this->db, $this);
            $w = array_slice($this->warnings, $before);
            $this->db->exec('INSERT INTO schema_migrations (name, warnings) VALUES (?, ?)', [$name, $w ? implode("\n", $w) : null]);
            $ran[] = $name;
            if ($log) $log($name . ($w ? ' (with ' . count($w) . ' warning(s))' : ''));
        }
        return $ran;
    }

    /** Drop every table of the current database (tests and reset only). */
    public static function dropAll(Db $db): void
    {
        $db->exec('SET FOREIGN_KEY_CHECKS = 0');
        foreach ($db->column("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()") as $t) {
            $db->exec('DROP TRIGGER IF EXISTS ' . Db::ident($t));
        }
        foreach ($db->column("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()") as $t) {
            $db->exec('DROP TABLE IF EXISTS ' . Db::ident($t));
        }
        $db->exec('SET FOREIGN_KEY_CHECKS = 1');
    }
}
