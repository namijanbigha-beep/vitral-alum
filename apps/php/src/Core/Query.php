<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * A deliberately small SELECT builder for list endpoints (filters added by optional callbacks).
 * Everything is a SQL fragment plus positional parameters — values never enter the SQL text.
 *
 *   $rows = Query::from('parties')->where('active = ?', [true])->where('name LIKE ?', [Db::like($q)])
 *       ->orderBy('created_at')->orderBy('id')->limit(51)->all($db);
 */
final class Query
{
    private string $select = '*';
    /** @var list<string> */
    private array $joins = [];
    /** @var list<string> */
    private array $wheres = [];
    /** @var list<mixed> */
    private array $joinParams = [];
    /** @var list<mixed> */
    private array $whereParams = [];
    /** @var list<string> */
    private array $orders = [];
    private ?int $limit = null;
    private ?int $offset = null;
    private bool $forUpdate = false;
    private string $groupBy = '';

    private function __construct(public readonly string $table)
    {
    }

    public static function from(string $table, ?string $alias = null): self
    {
        $q = new self($table);
        $q->select = Db::ident($alias ?? $table) . '.*';
        $q->fromSql = Db::ident($table) . ($alias ? ' ' . Db::ident($alias) : '');
        return $q;
    }

    private string $fromSql = '';

    public function select(string $sql): self { $this->select = $sql; return $this; }
    public function join(string $sql, array $params = []): self { $this->joins[] = $sql; array_push($this->joinParams, ...$params); return $this; }

    /** AND-ed condition: a SQL fragment with `?` placeholders. */
    public function where(string $sql, array $params = []): self
    {
        $this->wheres[] = '(' . $sql . ')';
        array_push($this->whereParams, ...$params);
        return $this;
    }

    /** @param list<mixed> $values an empty list matches nothing */
    public function whereIn(string $column, array $values): self
    {
        return $this->where(Db::ident($column) . ' IN (' . Db::placeholders($values) . ')', array_values($values));
    }

    public function orderBy(string $column, string $dir = 'asc'): self
    {
        $this->orders[] = Db::ident($column) . (strtolower($dir) === 'desc' ? ' DESC' : ' ASC');
        return $this;
    }

    public function orderByRaw(string $sql): self { $this->orders[] = $sql; return $this; }
    public function groupBy(string $sql): self { $this->groupBy = $sql; return $this; }
    public function limit(int $n): self { $this->limit = $n; return $this; }
    public function offset(int $n): self { $this->offset = $n; return $this; }
    public function forUpdate(): self { $this->forUpdate = true; return $this; }

    /** @return array{0:string,1:list<mixed>} */
    public function toSql(): array
    {
        $sql = 'SELECT ' . $this->select . ' FROM ' . $this->fromSql;
        if ($this->joins) $sql .= ' ' . implode(' ', $this->joins);
        if ($this->wheres) $sql .= ' WHERE ' . implode(' AND ', $this->wheres);
        if ($this->groupBy !== '') $sql .= ' GROUP BY ' . $this->groupBy;
        if ($this->orders) $sql .= ' ORDER BY ' . implode(', ', $this->orders);
        $params = [...$this->joinParams, ...$this->whereParams];
        if ($this->limit !== null) {
            $sql .= ' LIMIT ?';
            $params[] = $this->limit;
        }
        if ($this->offset !== null) {
            $sql .= ' OFFSET ?';
            $params[] = $this->offset;
        }
        if ($this->forUpdate) $sql .= ' FOR UPDATE';
        return [$sql, $params];
    }

    /** @return list<array<string,mixed>> */
    public function all(Db $db): array
    {
        [$sql, $params] = $this->toSql();
        return $db->all($sql, $params);
    }

    public function first(Db $db): ?array
    {
        $this->limit ??= 1;
        return $this->all($db)[0] ?? null;
    }
}
