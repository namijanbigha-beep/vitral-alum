<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * Port of apps/server/src/lib/storage.ts: private files under FILE_STORAGE_DIR with random names
 * ("ab/<uuid>"). The directory is outside the web root when the installer could arrange it, and is
 * always denied by .htaccess otherwise. Files are created exclusively, mode 0600.
 */
final class Storage
{
    public function __construct(private readonly string $root)
    {
    }

    public function root(): string
    {
        return $this->root;
    }

    public function pathFor(string $key): string
    {
        if (!preg_match('/^[0-9a-f]{2}\/[0-9a-f-]{36}$/', $key)) throw new \InvalidArgumentException('invalid storage key');
        return $this->root . '/' . $key;
    }

    public function put(string $data): string
    {
        $id = Db::uuid();
        $key = substr($id, 0, 2) . '/' . $id;
        $path = $this->pathFor($key);
        $dir = dirname($path);
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new \RuntimeException('cannot create storage directory');
        $fh = fopen($path, 'xb');
        if ($fh === false) throw new \RuntimeException('cannot create stored file');
        try {
            if (fwrite($fh, $data) !== strlen($data)) throw new \RuntimeException('short write to storage');
        } finally {
            fclose($fh);
        }
        @chmod($path, 0600);
        return $key;
    }

    public function read(string $key): string
    {
        $data = file_get_contents($this->pathFor($key));
        if ($data === false) throw new \RuntimeException('stored file missing');
        return $data;
    }

    public function remove(string $key): void
    {
        $p = $this->pathFor($key);
        if (is_file($p)) @unlink($p);
    }
}
