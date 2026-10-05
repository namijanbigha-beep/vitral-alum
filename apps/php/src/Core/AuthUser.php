<?php
declare(strict_types=1);

namespace Vitral\Core;

/** The signed-in identity (lib/auth.ts AuthUser). */
final class AuthUser
{
    /** @param list<string> $permissions effective permissions */
    public function __construct(
        public readonly string $id,
        public readonly string $sessionId,
        public readonly string $name,
        public readonly string $role,
        public readonly array $permissions,
    ) {
    }
}
