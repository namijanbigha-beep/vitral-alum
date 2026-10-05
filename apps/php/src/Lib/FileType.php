<?php
declare(strict_types=1);

namespace Vitral\Lib;

/**
 * Content sniffing of uploads (port of detectMime / detectImportMime in apps/server/src/modules/files/service.ts).
 * The type comes from the bytes, never from the name or the client's header. The allowed types follow the
 * decisions of the `file-type` package (v22) the Node app uses, including its refusals:
 * JPEG-LS, APNG, Ogg without a known audio codec (application/ogg), Theora/OGM video, AAC/ADTS, and every ftyp
 * brand other than M4A/M4B/F4A/F4B.
 */
final class FileType
{
    public const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'audio/ogg', 'audio/mp4', 'audio/mpeg'];
    public const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    public const IMPORT_MIME = [self::XLSX, 'text/csv', 'application/json'];

    private const MAX_REENTRY = 256;

    public static function detectMime(string $data): ?string
    {
        $mime = self::sniff($data, 0, 0);
        return $mime !== null && in_array($mime, self::ALLOWED_MIME, true) ? $mime : null;
    }

    /** Bare MIME as file-type would report it (aliases applied), limited to what matters here; null = unknown/other. */
    private static function sniff(string $d, int $pos, int $depth): ?string
    {
        $n = strlen($d) - $pos;
        if ($n < 2) return null;
        $at = static fn (int $o, string $s) => substr($d, $pos + $o, strlen($s)) === $s;
        $byte = static fn (int $o) => $pos + $o < strlen($d) ? ord($d[$pos + $o]) : -1;

        if ($at(0, "\xFF\xD8\xFF")) return $byte(3) === 0xF7 ? 'image/jls' : 'image/jpeg';

        if ($at(0, 'ID3')) {
            if ($n < 10) return null;
            // synchsafe 28-bit size at bytes 6..9
            $len = (($byte(6) & 0x7F) << 21) | (($byte(7) & 0x7F) << 14) | (($byte(8) & 0x7F) << 7) | ($byte(9) & 0x7F);
            $next = $pos + 10 + $len;
            if ($next > strlen($d)) return 'audio/mpeg';
            if ($depth >= self::MAX_REENTRY) return null;
            return self::sniff($d, $next, $depth + 1);
        }

        if ($at(0, 'OggS')) {
            $type = substr($d, $pos + 28, 8);
            if (str_starts_with($type, 'OpusHead')) return 'audio/ogg';
            if (str_starts_with($type, "\x80theora") || str_starts_with($type, "\x01video\x00")) return 'video/ogg';
            if (str_starts_with($type, "\x7FFLAC") || str_starts_with($type, 'Speex  ') || str_starts_with($type, "\x01vorbis")) return 'audio/ogg';
            return 'application/ogg';
        }

        if ($at(0, '%PDF')) return 'application/pdf';

        if ($at(0, "\x89PNG\r\n\x1A\n")) return self::png($d, $pos);

        if ($at(4, 'ftyp') && ($byte(8) & 0x60) !== 0) {
            $brand = trim(preg_replace('/\x00/', ' ', substr($d, $pos + 8, 4), 1));
            return match ($brand) {
                'M4A', 'M4B', 'F4A', 'F4B' => 'audio/mp4',
                default => 'video/mp4',
            };
        }

        if ($at(0, 'RIFF')) return $at(8, 'WEBP') ? 'image/webp' : null;

        // MPEG audio frame sync (mpegOffsetTolerance 0): needs the 4-byte frame header.
        if ($n >= 4 && ($byte(0) === 0xFF) && (($byte(1) & 0xE0) === 0xE0)) {
            if (($byte(1) & 0x16) === 0x10) return 'audio/aac';
            if ($byte(1) === 0xFE) return null;                 // collides with a UTF-16 LE BOM
            if (($byte(1) & 0x18) === 0x08) return null;        // reserved MPEG version
            if (($byte(2) & 0xF0) === 0xF0) return null;        // bad bitrate index
            if (($byte(2) & 0x0C) === 0x0C) return null;        // reserved sampling frequency
            if (in_array($byte(1) & 0x06, [0x02, 0x04, 0x06], true)) return 'audio/mpeg';
        }
        return null;
    }

    /** PNG vs APNG: an acTL chunk before the first IDAT means animated (refused). */
    private static function png(string $d, int $pos): ?string
    {
        $size = strlen($d);
        $p = $pos + 8;
        $seenHeader = false;
        $count = 0;
        do {
            if (++$count > 512) break;
            if ($p + 8 > $size) return 'image/png';
            $len = unpack('N', substr($d, $p, 4))[1];
            if ($len >= 0x80000000) return null; // INT32_BE negative
            $type = substr($d, $p + 4, 4);
            if ($type === 'IHDR') {
                if ($len !== 13) return null;
                $seenHeader = true;
            }
            if ($type === 'IDAT') return 'image/png';
            if ($type === 'acTL') return 'image/apng';
            if (!$seenHeader && $type !== 'CgBI') return null;
            $next = $p + 8 + $len + 4;
            if ($next > $size) return 'image/png';
            $p = $next;
        } while ($p + 8 < $size);
        return 'image/png';
    }

    /**
     * Import files (spec §18): xlsx = a ZIP whose entries form a workbook; JSON = valid UTF-8 that parses;
     * CSV = any other valid UTF-8 text without control bytes. Everything else (including other ZIPs) is refused.
     */
    public static function detectImportMime(string $data): ?string
    {
        if (strlen($data) >= 4 && substr($data, 0, 4) === "PK\x03\x04") {
            try {
                $entries = Zip::read($data);
            } catch (\Throwable) {
                return null;
            }
            return isset($entries['[Content_Types].xml'], $entries['xl/workbook.xml']) ? self::XLSX : null;
        }
        if (!mb_check_encoding($data, 'UTF-8')) return null;
        if (preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f]/', $data)) return null;
        $text = preg_replace('/^\x{FEFF}/u', '', $data);
        $trimmed = \Vitral\Lib\Num::jsTrim((string) $text);
        if ($trimmed === '') return null;
        if ($trimmed[0] === '{' || $trimmed[0] === '[') {
            try {
                json_decode($trimmed, false, 512, JSON_THROW_ON_ERROR);
                return 'application/json';
            } catch (\JsonException) {
                // a CSV may start with a bracket only in theory; treat as text below
            }
        }
        return 'text/csv';
    }

    public static function isImage(string $mime): bool
    {
        return $mime === 'image/jpeg' || $mime === 'image/png' || $mime === 'image/webp';
    }
}
