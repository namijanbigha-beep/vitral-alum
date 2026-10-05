<?php
declare(strict_types=1);

namespace Vitral\Core;

/** Port of apps/server/src/lib/versioning.ts (principle 5: optimistic concurrency per record). */
final class Versioning
{
    /**
     * Lock the row (SELECT … FOR UPDATE), compare `version`, and throw 409 with the current record
     * (through $present) when the client's copy is stale.
     * @param callable(array):mixed $present
     * @return array<string,mixed>
     */
    public static function lockForUpdate(Db $trx, string $table, string $id, int $expectedVersion, callable $present): array
    {
        $row = $trx->find($table, $id, true);
        if (!$row) throw new AppError('not_found');
        if ($row['version'] !== $expectedVersion) throw AppError::conflict($present($row));
        return $row;
    }
}
