<?php
declare(strict_types=1);

namespace Vitral\Lib;

/**
 * GD port of normaliseImage / makeThumb (apps/server/src/modules/files/service.ts, which uses sharp):
 * the EXIF orientation is applied and the image re-encoded, so no metadata (EXIF, GPS, XMP) survives in
 * the stored copy or the thumbnail. Thumbnails: inside 320×320, never enlarged, WebP quality 70.
 * Every failure (missing GD, corrupt or truncated data, too large to decode) throws \RuntimeException.
 */
final class Image
{
    /** Decoding needs ~5 bytes per pixel in GD; refuse what cannot fit (sharp's own default limit is 268 MP). */
    private const MAX_PIXELS = 268402689;

    public static function available(): bool
    {
        return function_exists('imagecreatefromstring') && function_exists('imagejpeg');
    }

    public static function normalise(string $data, string $mime): string
    {
        $im = self::load($data);
        try {
            $im = self::orient($im, self::orientation($data, $mime));
            return self::encode($im, $mime, 90);
        } finally {
            imagedestroy($im);
        }
    }

    public static function thumb(string $data): ?string
    {
        if (!function_exists('imagewebp')) return null; // GD without WebP: no thumbnail (has_thumb=false)
        $im = self::load($data);
        try {
            $w = imagesx($im);
            $h = imagesy($im);
            $scale = min(1, 320 / $w, 320 / $h);
            $tw = max(1, (int) round($w * $scale));
            $th = max(1, (int) round($h * $scale));
            if ($tw !== $w || $th !== $h) {
                $t = imagecreatetruecolor($tw, $th);
                if ($t === false) throw new \RuntimeException('cannot allocate thumbnail');
                imagealphablending($t, false);
                imagesavealpha($t, true);
                imagecopyresampled($t, $im, 0, 0, 0, 0, $tw, $th, $w, $h);
                imagedestroy($im);
                $im = $t;
            }
            return self::encode($im, 'image/webp', 70);
        } finally {
            imagedestroy($im);
        }
    }

    private static function load(string $data): \GdImage
    {
        if (!self::available()) throw new \RuntimeException('GD is not available');
        $info = @getimagesizefromstring($data);
        if ($info === false || $info[0] < 1 || $info[1] < 1) throw new \RuntimeException('unreadable image');
        $pixels = $info[0] * $info[1];
        if ($pixels > self::MAX_PIXELS) throw new \RuntimeException('image too large');
        self::ensureMemory($pixels * 10 + strlen($data) * 2);
        // warnings («Premature end of JPEG file», «gd-png error») become exceptions through the error handler
        $im = imagecreatefromstring($data);
        if ($im === false) throw new \RuntimeException('unreadable image');
        if (!imageistruecolor($im)) imagepalettetotruecolor($im);
        imagealphablending($im, false);
        imagesavealpha($im, true);
        return $im;
    }

    private static function ensureMemory(int $needed): void
    {
        $limit = self::bytes((string) ini_get('memory_limit'));
        if ($limit < 0) return;
        $want = memory_get_usage() + $needed;
        if ($want > $limit) @ini_set('memory_limit', (string) (int) ceil($want / 1048576 + 64) . 'M');
    }

    private static function bytes(string $v): int
    {
        $v = trim($v);
        if ($v === '' || $v === '-1') return -1;
        $n = (int) $v;
        return match (strtolower(substr($v, -1))) { 'g' => $n << 30, 'm' => $n << 20, 'k' => $n << 10, default => $n };
    }

    private static function encode(\GdImage $im, string $mime, int $quality): string
    {
        ob_start();
        try {
            $ok = match ($mime) {
                'image/png' => imagepng($im, null, 6),
                'image/webp' => function_exists('imagewebp') && imagewebp($im, null, $quality),
                default => imagejpeg($im, null, $quality),
            };
            $out = (string) ob_get_contents();
        } finally {
            ob_end_clean();
        }
        if (!$ok || $out === '') throw new \RuntimeException('cannot encode image');
        return $out;
    }

    /** Apply EXIF orientation 1..8 (sharp's .rotate() without arguments). */
    private static function orient(\GdImage $im, int $o): \GdImage
    {
        if ($o < 2 || $o > 8) return $im;
        $transparent = imagecolorallocatealpha($im, 0, 0, 0, 127);
        $rot = static function (\GdImage $src, int $angle) use ($transparent): \GdImage {
            $r = imagerotate($src, $angle, $transparent === false ? 0 : $transparent);
            if ($r === false) throw new \RuntimeException('cannot rotate image');
            imagedestroy($src);
            imagealphablending($r, false);
            imagesavealpha($r, true);
            return $r;
        };
        switch ($o) {
            case 2: imageflip($im, IMG_FLIP_HORIZONTAL); return $im;
            case 3: return $rot($im, 180);
            case 4: imageflip($im, IMG_FLIP_VERTICAL); return $im;
            case 5: $im = $rot($im, -90); imageflip($im, IMG_FLIP_HORIZONTAL); return $im; // transpose
            case 6: return $rot($im, -90);                                                   // 90° clockwise
            case 7: $im = $rot($im, 90); imageflip($im, IMG_FLIP_HORIZONTAL); return $im;  // transverse
            case 8: return $rot($im, 90);                                                    // 90° counter-clockwise
        }
        return $im;
    }

    /** EXIF orientation from JPEG APP1, PNG eXIf or WebP EXIF; 1 when absent. Reads the bytes itself (no exif extension needed). */
    public static function orientation(string $d, string $mime): int
    {
        $tiff = null;
        $len = strlen($d);
        if ($mime === 'image/jpeg') {
            $p = 2;
            while ($p + 4 <= $len && ord($d[$p]) === 0xFF) {
                $marker = ord($d[$p + 1]);
                if ($marker === 0xD9 || $marker === 0xDA) break;
                if ($marker === 0x01 || ($marker >= 0xD0 && $marker <= 0xD7)) { $p += 2; continue; }
                $segLen = unpack('n', substr($d, $p + 2, 2))[1];
                if ($marker === 0xE1 && substr($d, $p + 4, 6) === "Exif\0\0") {
                    $tiff = substr($d, $p + 10, $segLen - 8);
                    break;
                }
                $p += 2 + $segLen;
            }
        } elseif ($mime === 'image/png') {
            $p = 8;
            while ($p + 8 <= $len) {
                $cl = unpack('N', substr($d, $p, 4))[1];
                $type = substr($d, $p + 4, 4);
                if ($type === 'eXIf') { $tiff = substr($d, $p + 8, $cl); break; }
                if ($type === 'IDAT' || $type === 'IEND') break;
                $p += 12 + $cl;
            }
        } elseif ($mime === 'image/webp') {
            $p = 12;
            while ($p + 8 <= $len) {
                $type = substr($d, $p, 4);
                $cl = unpack('V', substr($d, $p + 4, 4))[1];
                if ($type === 'EXIF') {
                    $tiff = substr($d, $p + 8, $cl);
                    if (str_starts_with($tiff, "Exif\0\0")) $tiff = substr($tiff, 6);
                    break;
                }
                $p += 8 + $cl + ($cl & 1);
            }
        }
        return $tiff === null ? 1 : self::tiffOrientation($tiff);
    }

    private static function tiffOrientation(string $t): int
    {
        if (strlen($t) < 8) return 1;
        $le = substr($t, 0, 2) === 'II';
        if (!$le && substr($t, 0, 2) !== 'MM') return 1;
        $u16 = static fn (int $o) => $o + 2 <= strlen($t) ? unpack($le ? 'v' : 'n', substr($t, $o, 2))[1] : -1;
        $u32 = static fn (int $o) => $o + 4 <= strlen($t) ? unpack($le ? 'V' : 'N', substr($t, $o, 4))[1] : -1;
        $ifd = $u32(4);
        $count = $u16($ifd);
        for ($i = 0; $i < $count && $i < 1000; $i++) {
            $e = $ifd + 2 + $i * 12;
            if ($u16($e) === 0x0112) {
                $v = $u16($e + 8);
                return $v >= 1 && $v <= 8 ? $v : 1;
            }
        }
        return 1;
    }
}
