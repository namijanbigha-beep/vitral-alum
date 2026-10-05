<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * Method + path router with `:param` segments and a trailing `*` wildcard (param `*`).
 * Like Fastify (find-my-way) a static segment wins over a parameter wherever they compete,
 * so registration order between modules does not matter. No trailing-slash folding, case-sensitive.
 * Modules register paths relative to /api/v1.
 */
final class Router
{
    public const PREFIX = '/api/v1';

    /** @var list<array{method:string,url:string,segs:list<string>,handler:callable,opts:array<string,mixed>}> */
    private array $routes = [];

    /** @param array{rateLimit?:array{max:int,window?:int}} $opts */
    public function get(string $path, callable $handler, array $opts = []): void { $this->add('GET', $path, $handler, $opts); }
    public function post(string $path, callable $handler, array $opts = []): void { $this->add('POST', $path, $handler, $opts); }
    public function put(string $path, callable $handler, array $opts = []): void { $this->add('PUT', $path, $handler, $opts); }
    public function patch(string $path, callable $handler, array $opts = []): void { $this->add('PATCH', $path, $handler, $opts); }
    public function delete(string $path, callable $handler, array $opts = []): void { $this->add('DELETE', $path, $handler, $opts); }

    public function add(string $method, string $path, callable $handler, array $opts = []): void
    {
        $url = self::PREFIX . $path;
        foreach ($this->routes as $r) {
            if ($r['method'] === $method && $r['url'] === $url) throw new \LogicException("route {$method} {$url} registered twice");
        }
        $this->routes[] = ['method' => $method, 'url' => $url, 'segs' => explode('/', $url), 'handler' => $handler, 'opts' => $opts];
    }

    /**
     * @return array{route:array{method:string,url:string,segs:list<string>,handler:callable,opts:array<string,mixed>},params:array<string,string>}|null
     */
    public function match(string $method, string $path): ?array
    {
        if ($method === 'HEAD') $method = 'GET';
        $segs = explode('/', $path);
        $best = null;
        $bestScore = null;
        foreach ($this->routes as $r) {
            if ($r['method'] !== $method) continue;
            $params = [];
            $score = [];
            $ok = true;
            $n = count($r['segs']);
            foreach ($r['segs'] as $i => $seg) {
                if ($seg === '*' && $i === $n - 1) {
                    $params['*'] = implode('/', array_slice($segs, $i));
                    $score[] = 0;
                    break;
                }
                if (!array_key_exists($i, $segs)) {
                    $ok = false;
                    break;
                }
                if ($seg !== '' && $seg[0] === ':') {
                    if ($segs[$i] === '') {
                        $ok = false;
                        break;
                    }
                    $params[substr($seg, 1)] = rawurldecode($segs[$i]);
                    $score[] = 1;
                } elseif ($seg === $segs[$i]) {
                    $score[] = 2;
                } else {
                    $ok = false;
                    break;
                }
            }
            if (!$ok) continue;
            if (end($r['segs']) !== '*' && count($segs) !== $n) continue;
            if ($bestScore === null || $score > $bestScore) {
                $best = ['route' => $r, 'params' => $params];
                $bestScore = $score;
            }
        }
        return $best;
    }

    /** @return list<array{method:string,url:string}> every registered route (the Node app's routeList) */
    public function routeList(): array
    {
        $out = [];
        foreach ($this->routes as $r) {
            $out[] = ['method' => $r['method'], 'url' => $r['url']];
            if ($r['method'] === 'GET') $out[] = ['method' => 'HEAD', 'url' => $r['url']];
        }
        return $out;
    }
}
