<?php
declare(strict_types=1);

namespace Vitral\Lib\Telegram;

/**
 * A failed Bot API call. `network` = api.telegram.org was not reachable (DNS, connect, TLS, timeout): common on hosts
 * in Iran. Callers back off instead of hammering. Any other failure is an API refusal (blocked chat, bad token, …).
 */
final class TelegramError extends \RuntimeException
{
    public function __construct(string $message, public readonly bool $network = false, public readonly ?int $errorCode = null)
    {
        parent::__construct($message);
    }
}
