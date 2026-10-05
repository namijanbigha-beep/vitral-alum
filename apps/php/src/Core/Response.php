<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * What a handler returns when it needs more than «200 + JSON»: a status, headers, cookies,
 * a JSON payload (still passed through the confidential-key filter), raw bytes, or a file streamed from disk.
 * Handlers may also return a plain array / scalar, which becomes 200 JSON.
 */
final class Response
{
    public int $status = 200;
    /** @var array<string,string> lower-case header name → value */
    public array $headers = [];
    /** @var list<string> complete Set-Cookie values */
    public array $cookies = [];
    public mixed $data = null;
    public bool $isJson = false;
    public ?string $raw = null;
    public ?string $file = null;

    public static function json(mixed $data, int $status = 200): self
    {
        $r = new self();
        $r->status = $status;
        $r->data = $data;
        $r->isJson = true;
        return $r;
    }

    public static function raw(string $bytes, string $contentType, int $status = 200): self
    {
        $r = new self();
        $r->status = $status;
        $r->raw = $bytes;
        $r->headers['content-type'] = $contentType;
        return $r;
    }

    /** Stream a file from disk (never loaded into memory). */
    public static function file(string $path, string $contentType, int $status = 200): self
    {
        $r = new self();
        $r->status = $status;
        $r->file = $path;
        $r->headers['content-type'] = $contentType;
        return $r;
    }

    public function status(int $status): self
    {
        $this->status = $status;
        return $this;
    }

    public function header(string $name, string $value): self
    {
        $this->headers[strtolower($name)] = $value;
        return $this;
    }

    /** Raw Set-Cookie value, e.g. from Auth::sessionCookie(). */
    public function cookie(string $setCookie): self
    {
        $this->cookies[] = $setCookie;
        return $this;
    }

    /** Body bytes for JSON / raw responses (files are streamed by send()). */
    public function body(): string
    {
        if ($this->isJson) return Json::encode($this->data);
        return $this->raw ?? '';
    }

    public function send(bool $headOnly = false): void
    {
        http_response_code($this->status);
        if (!headers_sent()) header_remove('X-Powered-By');
        if ($this->isJson) $this->headers['content-type'] ??= 'application/json; charset=utf-8';
        $body = $this->file === null ? $this->body() : null;
        $length = $this->file !== null ? (int) @filesize($this->file) : strlen((string) $body);
        if (!isset($this->headers['content-length'])) $this->headers['content-length'] = (string) $length;
        foreach ($this->headers as $k => $v) header(self::headerName($k) . ': ' . $v, true);
        foreach ($this->cookies as $c) header('Set-Cookie: ' . $c, false);
        if ($headOnly) return;
        if ($this->file !== null) {
            $fh = fopen($this->file, 'rb');
            if ($fh === false) return;
            while (!feof($fh)) {
                echo fread($fh, 65536);
                if (connection_aborted()) break;
            }
            fclose($fh);
            return;
        }
        echo $body;
    }

    private static function headerName(string $lower): string
    {
        return implode('-', array_map('ucfirst', explode('-', $lower)));
    }
}
