<?php
declare(strict_types=1);

namespace Vitral\Lib\Telegram;

/**
 * Real HTTP: cURL when the extension is loaded (optionally through TELEGRAM_PROXY, e.g. socks5h://host:port, for hosts
 * that cannot reach api.telegram.org directly), PHP streams otherwise. Short connect timeouts so an unreachable
 * Telegram never holds a PHP worker for long.
 */
final class HttpTransport implements Transport
{
    public function __construct(private readonly ?string $proxy = null, private readonly int $connectTimeout = 5)
    {
    }

    public function request(string $method, string $url, ?string $body, array $headers, int $timeoutSeconds): array
    {
        if (function_exists('curl_init')) return $this->curl($method, $url, $body, $headers, $timeoutSeconds);
        return $this->stream($method, $url, $body, $headers, $timeoutSeconds);
    }

    private function curl(string $method, string $url, ?string $body, array $headers, int $timeout): array
    {
        $ch = curl_init($url);
        if ($ch === false) throw new TelegramError('curl_init failed', true);
        $h = [];
        foreach ($headers as $k => $v) $h[] = "{$k}: {$v}";
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $h,
            CURLOPT_CONNECTTIMEOUT => $this->connectTimeout,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
        ]);
        if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        if ($this->proxy) curl_setopt($ch, CURLOPT_PROXY, $this->proxy);
        $out = curl_exec($ch);
        if ($out === false) {
            $err = curl_error($ch);
            curl_close($ch);
            throw new TelegramError('telegram unreachable: ' . $err, true);
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return ['status' => $status, 'body' => (string) $out];
    }

    private function stream(string $method, string $url, ?string $body, array $headers, int $timeout): array
    {
        $h = '';
        foreach ($headers as $k => $v) $h .= "{$k}: {$v}\r\n";
        $ctx = stream_context_create(['http' => ['method' => $method, 'header' => $h, 'content' => $body ?? '', 'timeout' => $timeout, 'ignore_errors' => true, 'follow_location' => 0]]);
        $out = @file_get_contents($url, false, $ctx);
        if ($out === false) throw new TelegramError('telegram unreachable', true);
        $status = 0;
        // $http_response_header is filled by file_get_contents in this scope
        foreach ($http_response_header ?? [] as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) $status = (int) $m[1];
        }
        return ['status' => $status, 'body' => $out];
    }
}
