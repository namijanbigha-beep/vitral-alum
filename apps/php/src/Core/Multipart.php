<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * multipart/form-data with the limits the Node app gives @fastify/multipart: one file, at most 10 fields,
 * a per-file size limit. Uses PHP's own parsing ($_FILES / $_POST); when the host turned
 * enable_post_data_reading off, parses php://input itself.
 *
 * Returns ['fields' => array<string,string>, 'file' => ?array{filename:string,data:string,truncated:bool}].
 * More than one file or more than 10 fields → HttpError(413), like @fastify/multipart's limit errors.
 */
final class Multipart
{
    public static function read(Request $req, int $maxFileBytes, int $maxFields = 10): array
    {
        if (!$req->isMultipart()) throw new HttpError(415);
        $declared = (int) ($req->header('content-length') ?? 0);
        $postMax = self::iniBytes((string) ini_get('post_max_size'));
        if ($req->internal) return self::parse($req->rawBody, (string) $req->header('content-type'), $maxFileBytes, $maxFields);
        $readByPhp = (bool) ini_get('enable_post_data_reading');

        if ($readByPhp) {
            // PHP drops the whole body above post_max_size: the file was too large.
            if ($postMax > 0 && $declared > $postMax && !$_FILES && !$_POST) {
                return ['fields' => [], 'file' => ['filename' => '', 'data' => '', 'truncated' => true]];
            }
            return self::fromGlobals($maxFileBytes, $maxFields);
        }
        $raw = (string) file_get_contents('php://input');
        return self::parse($raw, (string) $req->header('content-type'), $maxFileBytes, $maxFields);
    }

    private static function fromGlobals(int $maxFileBytes, int $maxFields): array
    {
        $fields = [];
        foreach ($_POST as $k => $v) {
            if (!is_string($v)) continue;
            $fields[(string) $k] = $v;
        }
        if (count($_POST) > $maxFields) throw new HttpError(413);
        $file = null;
        $files = 0;
        foreach ($_FILES as $f) {
            if (!is_array($f) || is_array($f['error'] ?? null)) throw new HttpError(413); // name[] arrays = several files
            if ((int) $f['error'] === UPLOAD_ERR_NO_FILE) continue;
            if (++$files > 1) throw new HttpError(413);
            $err = (int) $f['error'];
            if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE || $err === UPLOAD_ERR_PARTIAL) {
                $file = ['filename' => (string) $f['name'], 'data' => '', 'truncated' => true];
                continue;
            }
            if ($err !== UPLOAD_ERR_OK) throw new \RuntimeException('upload failed with PHP error ' . $err);
            if (!is_uploaded_file($f['tmp_name']) && PHP_SAPI !== 'cli') throw new \RuntimeException('not an uploaded file');
            $size = (int) filesize($f['tmp_name']);
            $data = $size > $maxFileBytes ? '' : (string) file_get_contents($f['tmp_name']);
            $file = ['filename' => (string) $f['name'], 'data' => $data, 'truncated' => $size > $maxFileBytes];
        }
        return ['fields' => $fields, 'file' => $file];
    }

    /** Parse a raw multipart body (used when PHP did not). */
    public static function parse(string $raw, string $contentType, int $maxFileBytes, int $maxFields = 10): array
    {
        if (!preg_match('/boundary=(?:"([^"]+)"|([^;\s]+))/i', $contentType, $m)) throw new HttpError(400);
        $boundary = '--' . ($m[1] !== '' ? $m[1] : $m[2]);
        $fields = [];
        $file = null;
        $files = 0;
        $nFields = 0;
        $pos = strpos($raw, $boundary);
        if ($pos === false) throw new HttpError(400);
        while (true) {
            $pos += strlen($boundary);
            if (substr($raw, $pos, 2) === '--') break;
            if (substr($raw, $pos, 2) !== "\r\n") throw new HttpError(400);
            $pos += 2;
            $headEnd = strpos($raw, "\r\n\r\n", $pos);
            if ($headEnd === false) throw new HttpError(400);
            $head = substr($raw, $pos, $headEnd - $pos);
            $next = strpos($raw, "\r\n" . $boundary, $headEnd + 4);
            if ($next === false) throw new HttpError(400);
            $body = substr($raw, $headEnd + 4, $next - $headEnd - 4);
            $pos = $next + 2;
            if (!preg_match('/content-disposition:\s*form-data(.*)$/im', $head, $cd)) continue;
            $name = preg_match('/\bname="([^"]*)"/i', $cd[1], $nm) ? $nm[1] : '';
            if (preg_match('/\bfilename="([^"]*)"/i', $cd[1], $fm)) {
                if (++$files > 1) throw new HttpError(413);
                $file = ['filename' => $fm[1], 'data' => strlen($body) > $maxFileBytes ? '' : $body, 'truncated' => strlen($body) > $maxFileBytes];
            } else {
                if (++$nFields > $maxFields) throw new HttpError(413);
                $fields[$name] = $body;
            }
        }
        return ['fields' => $fields, 'file' => $file];
    }

    public static function iniBytes(string $v): int
    {
        $v = trim($v);
        if ($v === '') return 0;
        $n = (int) $v;
        return match (strtolower(substr($v, -1))) { 'g' => $n << 30, 'm' => $n << 20, 'k' => $n << 10, default => $n };
    }
}
