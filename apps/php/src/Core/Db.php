<?php
declare(strict_types=1);

namespace Vitral\Core;

use PDO;
use PDOStatement;
use Vitral\Lib\Decimal;

/**
 * PDO/MySQL access with PostgreSQL-compatible results, so ported modules return the same JSON as Node:
 *   DATETIME(3) → "2026-10-05T12:00:00.000Z"   (stored in UTC; the session time zone is +00:00)
 *   DATE        → "2026-10-05T00:00:00.000Z"   (pg `date` → JS Date at UTC midnight)
 *   TINYINT(1)  → bool                          DECIMAL → string with the column scale ("5.000")
 *   BIGINT / COUNT(*) → string (pg int8)        INT → int
 *   JSON columns (LONGTEXT, see JSON_COLUMNS) → decoded (empty object stays \stdClass)
 *   generated helper columns named `_g_*` (emulated partial unique indexes) are dropped from every row.
 * Only prepared statements; identifiers are checked against a strict pattern.
 */
final class Db
{
    /** Columns that hold JSON (jsonb or a PostgreSQL array in the Node schema). Keep in sync with migrations. */
    public const JSON_COLUMNS = [
        'users' => ['permissions'],
        'audit_log' => ['before', 'after'],
        'idempotency_keys' => ['response'],
        'settings' => ['value'],
        'parties' => ['phones', 'roles'],
        'products' => ['common_lengths', 'colors'],
        'die_orders' => ['steps'],
        'order_revisions' => ['snapshot'],
        'bundles' => ['warnings', 'origin_bundle_ids'],
        'transfers' => ['order_ids'],
        'scale_tickets' => ['approved_for'],
        'documents' => ['file_ids'],
        'document_lines' => ['meta'],
        'free_notes' => ['converted_document_ids'],
        'daily_reports' => ['snapshot'],
        'import_batches' => ['rows', 'errors', 'created_ids'],
    ];

    /**
     * Column defaults MySQL 5.7 cannot declare (no DEFAULT on TEXT/JSON columns, no CURRENT_DATE on DATE):
     * insert() fills them when the row leaves them out. '@today' = the current UTC date (pg CURRENT_DATE).
     */
    public const INSERT_DEFAULTS = [
        'users' => ['permissions' => '[]'],
        'parties' => ['phones' => '[]', 'roles' => '[]'],
        'products' => ['common_lengths' => '[]', 'colors' => '[]'],
        'die_orders' => ['steps' => '[]'],
        'orders' => ['order_date' => '@today'],
        'bundles' => ['warnings' => '[]', 'origin_bundle_ids' => '[]'],
        'transfers' => ['order_ids' => '[]'],
        'scale_tickets' => ['approved_for' => '[]'],
        'documents' => ['date' => '@today', 'file_ids' => '[]'],
        'free_notes' => ['converted_document_ids' => '[]'],
        'import_batches' => ['errors' => '[]', 'created_ids' => '{}'],
    ];

    private const SQL_MODE = 'STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_DATE,NO_ZERO_IN_DATE,NO_ENGINE_SUBSTITUTION';

    private ?PDO $pdo = null;
    private int $depth = 0;
    /** @var array<string,true>|null */
    private static ?array $jsonNames = null;

    /** @param array{host?:string,port?:string|int,name:string,user:string,pass?:string,socket?:string} $cfg */
    public function __construct(private array $cfg)
    {
    }

    public static function fromConfig(Config $c): self
    {
        return new self([
            'host' => $c->str('DB_HOST'),
            'port' => $c->str('DB_PORT'),
            'name' => $c->str('DB_NAME'),
            'user' => $c->str('DB_USER'),
            'pass' => $c->str('DB_PASS'),
            'socket' => $c->str('DB_SOCKET'),
        ]);
    }

    public function pdo(): PDO
    {
        if ($this->pdo) return $this->pdo;
        $c = $this->cfg;
        $dsn = !empty($c['socket'])
            ? "mysql:unix_socket={$c['socket']};dbname={$c['name']};charset=utf8mb4"
            : 'mysql:host=' . ($c['host'] ?? 'localhost') . ';port=' . ($c['port'] ?? 3306) . ";dbname={$c['name']};charset=utf8mb4";
        $pdo = new PDO($dsn, $c['user'], $c['pass'] ?? '', [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_STRINGIFY_FETCHES => false,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $pdo->exec("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
        $pdo->exec("SET time_zone = '+00:00'");
        $pdo->exec("SET SESSION sql_mode = '" . self::SQL_MODE . "'");
        // PostgreSQL's default isolation; keeps lock/visibility behaviour of the Node code.
        $pdo->exec('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
        return $this->pdo = $pdo;
    }

    // ---------------------------------------------------------------- queries

    /** @param array<int|string,mixed> $params */
    public function query(string $sql, array $params = []): PDOStatement
    {
        $st = $this->pdo()->prepare($sql);
        $i = 0;
        foreach ($params as $k => $v) {
            $name = is_int($k) ? ++$i : (str_starts_with($k, ':') ? $k : ':' . $k);
            $v = self::toParam($v);
            $type = is_int($v) ? PDO::PARAM_INT : ($v === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
            $st->bindValue($name, $v, $type);
        }
        $st->execute();
        return $st;
    }

    /** @return list<array<string,mixed>> */
    public function all(string $sql, array $params = []): array
    {
        $st = $this->query($sql, $params);
        return self::fetchAllCast($st);
    }

    /** @return array<string,mixed>|null */
    public function one(string $sql, array $params = []): ?array
    {
        $rows = $this->all($sql, $params);
        return $rows[0] ?? null;
    }

    /** First column of the first row (cast), or null. */
    public function value(string $sql, array $params = []): mixed
    {
        $row = $this->one($sql, $params);
        return $row === null ? null : (array_values($row)[0] ?? null);
    }

    /** @return list<mixed> first column of every row */
    public function column(string $sql, array $params = []): array
    {
        return array_map(static fn ($r) => array_values($r)[0] ?? null, $this->all($sql, $params));
    }

    /** Statement without a result set; returns the affected row count. */
    public function exec(string $sql, array $params = []): int
    {
        return $this->query($sql, $params)->rowCount();
    }

    /** One SELECT … WHERE id = ? (optionally FOR UPDATE). */
    public function find(string $table, string $id, bool $forUpdate = false): ?array
    {
        return $this->one('SELECT * FROM ' . self::ident($table) . ' WHERE id = ?' . ($forUpdate ? ' FOR UPDATE' : ''), [$id]);
    }

    /**
     * INSERT one row and return it as stored (the RETURNING * of the Node code).
     * Adds a UUID `id` when missing and the INSERT_DEFAULTS.
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    public function insert(string $table, array $row): array
    {
        $id = $this->insertNoReturn($table, $row);
        $out = $this->find($table, $id);
        if ($out === null) throw new \RuntimeException("insert into {$table} returned no row");
        return $out;
    }

    /** INSERT without reading the row back; returns the id. */
    public function insertNoReturn(string $table, array $row): string
    {
        if (!array_key_exists('id', $row) || $row['id'] === null) $row = ['id' => self::uuid()] + $row;
        foreach (self::INSERT_DEFAULTS[$table] ?? [] as $col => $default) {
            if (!array_key_exists($col, $row)) $row[$col] = $default === '@today' ? gmdate('Y-m-d') : $default;
        }
        $cols = [];
        $vals = [];
        $params = [];
        foreach ($row as $col => $v) {
            $cols[] = self::ident($col);
            if ($v instanceof Raw) {
                $vals[] = $v->sql;
                array_push($params, ...$v->params);
            } else {
                $vals[] = '?';
                $params[] = $v;
            }
        }
        $this->exec('INSERT INTO ' . self::ident($table) . ' (' . implode(', ', $cols) . ') VALUES (' . implode(', ', $vals) . ')', $params);
        return (string) $row['id'];
    }

    /**
     * UPDATE with a WHERE clause. Values may be Raw (e.g. Db::raw('version + 1')).
     * @param array<string,mixed> $set
     */
    public function update(string $table, array $set, string $where, array $params = []): int
    {
        if (!$set) return 0;
        $parts = [];
        $values = [];
        foreach ($set as $col => $v) {
            if ($v instanceof Raw) {
                $parts[] = self::ident($col) . ' = ' . $v->sql;
                array_push($values, ...$v->params);
            } else {
                $parts[] = self::ident($col) . ' = ?';
                $values[] = $v;
            }
        }
        return $this->exec('UPDATE ' . self::ident($table) . ' SET ' . implode(', ', $parts) . ' WHERE ' . $where, array_merge($values, $params));
    }

    /** UPDATE … WHERE id = ? and return the row (the RETURNING * of the Node code). */
    public function updateById(string $table, string $id, array $set): array
    {
        $this->update($table, $set, 'id = ?', [$id]);
        $row = $this->find($table, $id);
        if ($row === null) throw AppError::notFound();
        return $row;
    }

    /** The `{ version: version + 1, updated_at: now() }` of lib/versioning.ts. */
    public static function bump(): array
    {
        return ['version' => new Raw('version + 1'), 'updated_at' => new Raw('NOW(3)')];
    }

    /**
     * Run $fn inside a transaction (nested calls use savepoints). Commits on return, rolls back on throw.
     * @template T
     * @param callable(Db):T $fn
     * @return T
     */
    public function transaction(callable $fn): mixed
    {
        $pdo = $this->pdo();
        if ($this->depth === 0) {
            $pdo->beginTransaction();
        } else {
            $pdo->exec('SAVEPOINT sp' . $this->depth);
        }
        $this->depth++;
        try {
            $result = $fn($this);
            $this->depth--;
            if ($this->depth === 0) $pdo->commit();
            else $pdo->exec('RELEASE SAVEPOINT sp' . $this->depth);
            return $result;
        } catch (\Throwable $e) {
            $this->depth--;
            if ($this->depth === 0) {
                if ($pdo->inTransaction()) $pdo->rollBack();
            } else {
                try {
                    $pdo->exec('ROLLBACK TO SAVEPOINT sp' . $this->depth);
                } catch (\Throwable) {
                }
            }
            throw $e;
        }
    }

    public function inTransaction(): bool
    {
        return $this->depth > 0;
    }

    // ---------------------------------------------------------------- helpers

    public static function raw(string $sql, array $params = []): Raw
    {
        return new Raw($sql, $params);
    }

    /** "?, ?, ?" for an IN list (an empty list yields "NULL", which matches nothing). */
    public static function placeholders(array $values): string
    {
        return $values ? implode(', ', array_fill(0, count($values), '?')) : 'NULL';
    }

    /** Quote a table/column identifier; only [a-z0-9_] names (optionally table.column) are accepted. */
    public static function ident(string $name): string
    {
        if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/', $name)) throw new \InvalidArgumentException("bad identifier {$name}");
        return '`' . str_replace('.', '`.`', $name) . '`';
    }

    /** %…% pattern with LIKE wildcards escaped (crud.ts `like`). */
    public static function like(string $s): string
    {
        return '%' . preg_replace('/[%_\\\\]/', '\\\\$0', $s) . '%';
    }

    public static function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        $h = bin2hex($b);
        return substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-' . substr($h, 12, 4) . '-' . substr($h, 16, 4) . '-' . substr($h, 20, 12);
    }

    /** Current instant as a MySQL DATETIME(3) literal in UTC. */
    public static function now(): string
    {
        return self::dt(new \DateTimeImmutable('now'));
    }

    /** ISO string or DateTime → MySQL DATETIME(3) literal in UTC ("2026-10-05 12:00:00.000"). */
    public static function dt(\DateTimeInterface|string|null $at): ?string
    {
        if ($at === null) return null;
        $d = $at instanceof \DateTimeInterface ? \DateTimeImmutable::createFromInterface($at) : new \DateTimeImmutable($at);
        return $d->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s.v');
    }

    /** MySQL DATETIME literal / ISO string → ISO "…Z" with milliseconds. */
    public static function iso(?string $mysql): ?string
    {
        if ($mysql === null) return null;
        if (strlen($mysql) === 10) return $mysql . 'T00:00:00.000Z';
        $s = str_replace(' ', 'T', $mysql);
        if (!str_contains($s, '.')) $s .= '.000';
        $s = preg_replace('/(\.\d{3})\d*/', '$1', $s);
        return rtrim($s, 'Z') . 'Z';
    }

    public static function isDuplicateKey(\Throwable $e): bool
    {
        return $e instanceof \PDOException && (($e->errorInfo[1] ?? null) === 1062 || $e->getCode() === '23000' && str_contains($e->getMessage(), '1062'));
    }

    private static function toParam(mixed $v): mixed
    {
        if ($v === null || is_int($v) || is_string($v)) return $v;
        if (is_bool($v)) return $v ? 1 : 0;
        if (is_float($v)) return json_encode($v);
        if ($v instanceof \DateTimeInterface) return self::dt($v);
        if ($v instanceof Decimal) return $v->toFixed();
        if (is_array($v) || $v instanceof \stdClass || $v instanceof \JsonSerializable) return Json::encode($v);
        if ($v instanceof \Stringable) return (string) $v;
        throw new \InvalidArgumentException('unsupported SQL parameter type ' . get_debug_type($v));
    }

    // ---------------------------------------------------------------- result casting

    /** @return list<array<string,mixed>> */
    public static function fetchAllCast(PDOStatement $st): array
    {
        $n = $st->columnCount();
        if ($n === 0) return [];
        $casts = [];
        for ($i = 0; $i < $n; $i++) {
            $m = $st->getColumnMeta($i) ?: [];
            $casts[$i] = [$m['name'] ?? (string) $i, self::castKind($m)];
        }
        $out = [];
        while (($row = $st->fetch(PDO::FETCH_NUM)) !== false) {
            $r = [];
            foreach ($row as $i => $v) {
                [$name, $kind] = $casts[$i];
                if ($kind === 'skip') continue;
                $r[$name] = $v === null ? null : self::cast($v, $kind);
            }
            $out[] = $r;
        }
        return $out;
    }

    /** @param array<string,mixed> $m */
    private static function castKind(array $m): string
    {
        $name = (string) ($m['name'] ?? '');
        if (str_starts_with($name, '_g_')) return 'skip';
        $type = strtoupper((string) ($m['native_type'] ?? ''));
        $table = (string) ($m['table'] ?? '');
        if ($table !== '' && self::isJsonColumn($table, $name)) return 'json';
        return match ($type) {
            'TINY' => ((int) ($m['len'] ?? 0)) === 1 ? 'bool' : 'int',
            'LONGLONG' => 'bigint',
            'DATETIME', 'TIMESTAMP' => 'datetime',
            'DATE' => 'date',
            'NEWDECIMAL', 'DECIMAL' => 'string',
            'DOUBLE', 'FLOAT' => 'float',
            'LONG', 'SHORT', 'INT24', 'YEAR' => 'int',
            default => 'raw',
        };
    }

    private static function isJsonColumn(string $table, string $name): bool
    {
        if (isset(self::JSON_COLUMNS[$table])) return in_array($name, self::JSON_COLUMNS[$table], true);
        if (self::$jsonNames === null) {
            self::$jsonNames = [];
            foreach (self::JSON_COLUMNS as $cols) foreach ($cols as $c) self::$jsonNames[$c] = true;
        }
        // an aliased table (FROM users u): decide by the column name alone
        return isset(self::$jsonNames[$name]);
    }

    private static function cast(mixed $v, string $kind): mixed
    {
        return match ($kind) {
            'bool' => (bool) $v,
            'int' => (int) $v,
            'bigint' => (string) $v,
            'datetime', 'date' => self::iso((string) $v),
            'float' => (float) $v,
            'json' => is_string($v) ? Json::decode($v) : $v,
            default => $v,
        };
    }

    /** Decode JSON columns of a row by name, for computed selects the caster cannot attribute to a table. */
    public static function decodeJson(array $row, array $columns): array
    {
        foreach ($columns as $c) {
            if (isset($row[$c]) && is_string($row[$c])) $row[$c] = Json::decode($row[$c]);
        }
        return $row;
    }
}
