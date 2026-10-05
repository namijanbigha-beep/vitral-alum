<?php
declare(strict_types=1);

namespace Vitral\Lib\Telegram;

/** HTTP for the Telegram Bot API. A fake implementation drives the unit tests (no network). */
interface Transport
{
    /**
     * @param array<string,string> $headers
     * @return array{status:int,body:string}
     * @throws TelegramError (network = true) when the host cannot be reached
     */
    public function request(string $method, string $url, ?string $body, array $headers, int $timeoutSeconds): array;
}
