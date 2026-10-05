<?php
declare(strict_types=1);

namespace Vitral\Lib\Telegram;

/** apps/bot/src/api.ts ApiError: a non-2xx answer of the Vitral API. */
final class ApiError extends \RuntimeException
{
    public function __construct(public readonly int $status, public readonly string $errorCode, string $message, public readonly mixed $details = null)
    {
        parent::__construct($message);
    }
}
