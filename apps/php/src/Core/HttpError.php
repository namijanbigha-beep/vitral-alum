<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * A framework-level HTTP error (malformed body, unsupported media type, payload too large),
 * rendered like Fastify errors pass through apps/server/src/app.ts setErrorHandler.
 */
final class HttpError extends \RuntimeException
{
    public function __construct(public readonly int $status)
    {
        parent::__construct("HTTP {$status}");
    }
}
