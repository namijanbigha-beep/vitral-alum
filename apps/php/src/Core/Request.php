<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * One HTTP request, decoded the way Fastify does it:
 *  - headers with lower-case names; cookies and query string parsed without PHP's name mangling
 *    (repeated query keys become lists, like fast-querystring);
 *  - JSON body decoded with Json::decode (an empty object stays \stdClass); text/plain stays a string;
 *    no body at all → body() returns V::undef() so validation reports «Required» like zod.
 */
final class Request
{
    /** @var array<string,string> route parameters (URL-decoded) */
    public array $params = [];
    public ?AuthUser $user = null;
    public readonly string $id;
    private mixed $parsedBody = null;
    private bool $hasBody = false;

    /**
     * @param array<string,string> $headers lower-case names
     * @param array<string,string|list<string>> $query
     * @param array<string,string> $cookies
     */
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $query,
        public readonly array $headers,
        public readonly array $cookies,
        public readonly string $rawBody,
        public readonly string $ip,
        public readonly App $app,
    ) {
        $this->id = Db::uuid();
    }

    public static function fromGlobals(App $app, string $path): self
    {
        $headers = [];
        $src = function_exists('getallheaders') ? (getallheaders() ?: []) : [];
        foreach ($src as $k => $v) $headers[strtolower((string) $k)] = (string) $v;
        foreach ($_SERVER as $k => $v) {
            if (str_starts_with($k, 'HTTP_')) {
                $name = strtolower(str_replace('_', '-', substr($k, 5)));
                $headers[$name] ??= (string) $v;
            }
        }
        if (isset($_SERVER['CONTENT_TYPE'])) $headers['content-type'] ??= (string) $_SERVER['CONTENT_TYPE'];
        if (isset($_SERVER['CONTENT_LENGTH'])) $headers['content-length'] ??= (string) $_SERVER['CONTENT_LENGTH'];
        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
        $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
        if ($app->config->bool('TRUST_PROXY') && !empty($headers['x-forwarded-for'])) {
            $ip = trim(explode(',', $headers['x-forwarded-for'])[0]);
        }
        $raw = '';
        $ctype = strtolower($headers['content-type'] ?? '');
        if (!str_starts_with($ctype, 'multipart/form-data') && in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], true)) {
            $raw = (string) file_get_contents('php://input');
        }
        return new self(
            $method,
            $path,
            self::parseQuery((string) ($_SERVER['QUERY_STRING'] ?? '')),
            $headers,
            self::parseCookies($headers['cookie'] ?? ''),
            $raw,
            $ip,
            $app,
        );
    }

    /** @return array<string,string|list<string>> */
    public static function parseQuery(string $qs): array
    {
        $out = [];
        if ($qs === '') return $out;
        foreach (explode('&', $qs) as $pair) {
            if ($pair === '') continue;
            $eq = strpos($pair, '=');
            $k = urldecode($eq === false ? $pair : substr($pair, 0, $eq));
            $v = $eq === false ? '' : urldecode(substr($pair, $eq + 1));
            if (array_key_exists($k, $out)) {
                $out[$k] = is_array($out[$k]) ? [...$out[$k], $v] : [$out[$k], $v];
            } else {
                $out[$k] = $v;
            }
        }
        return $out;
    }

    /** @return array<string,string> */
    public static function parseCookies(string $header): array
    {
        $out = [];
        foreach (explode(';', $header) as $part) {
            $eq = strpos($part, '=');
            if ($eq === false) continue;
            $k = trim(substr($part, 0, $eq));
            $v = trim(substr($part, $eq + 1));
            if (strlen($v) >= 2 && $v[0] === '"' && $v[-1] === '"') $v = substr($v, 1, -1);
            if ($k !== '' && !array_key_exists($k, $out)) $out[$k] = rawurldecode($v);
        }
        return $out;
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    public function contentType(): string
    {
        return strtolower(trim(explode(';', $this->headers['content-type'] ?? '')[0]));
    }

    public function isMultipart(): bool
    {
        return $this->contentType() === 'multipart/form-data';
    }

    /**
     * Parse the body as Fastify would before the handler runs.
     * @throws AppError 400 for broken JSON, 415 (as Fastify) for an unsupported content type
     */
    public function parseBody(): void
    {
        if (!in_array($this->method, ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], true)) return;
        $ct = $this->contentType();
        if ($ct === 'multipart/form-data') return;
        $hasHeader = isset($this->headers['content-type']);
        if (!$hasHeader && $this->rawBody === '') return;
        if ($ct === 'application/json' || str_ends_with($ct, '+json')) {
            if (trim($this->rawBody) === '') throw new HttpError(400);
            try {
                $decoded = Json::decode($this->rawBody);
                $this->parsedBody = $decoded === [] ? new JsonList() : $decoded;
            } catch (\JsonException) {
                throw new HttpError(400);
            }
            $this->hasBody = true;
            return;
        }
        if ($ct === 'text/plain') {
            $this->parsedBody = $this->rawBody;
            $this->hasBody = true;
            return;
        }
        if ($this->rawBody === '' && !$hasHeader) return;
        throw new HttpError(415);
    }

    /** Decoded body, or V::undef() when the request had none. */
    public function body(): mixed
    {
        return $this->hasBody ? $this->parsedBody : V::undef();
    }

    /** Route params, for validation with V::object([...]). */
    public function params(): array
    {
        return $this->params;
    }

    // ---------------------------------------------------------------- authorization (lib/auth.ts)

    public function can(string $permission): bool
    {
        return Auth::can($this->user, $permission);
    }

    /** requireUser(req): 401 without a session. */
    public function requireUser(): AuthUser
    {
        if (!$this->user) throw new AppError('unauthorized');
        return $this->user;
    }

    /** requirePermission(req, p): 401 without a session, 403 without the permission. */
    public function requirePermission(string $permission): AuthUser
    {
        $u = $this->requireUser();
        if (!Auth::can($u, $permission)) throw new AppError('forbidden');
        return $u;
    }

    /** Idempotency-Key header (lib/idempotency.ts requireIdempotencyKey). */
    public function idempotencyKey(): string
    {
        return Idempotency::requireKey($this);
    }
}
