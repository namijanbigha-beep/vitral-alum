<?php
declare(strict_types=1);

namespace Vitral\Core;

/** A literal SQL fragment for insert()/update() values, e.g. Db::raw('version + 1'). */
final class Raw
{
    /** @param list<mixed> $params */
    public function __construct(public readonly string $sql, public readonly array $params = [])
    {
    }
}
