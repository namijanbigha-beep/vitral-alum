<?php
declare(strict_types=1);

namespace Vitral\Lib;

/** Port of apps/server/src/lib/xlsx-read.ts: a minimal ZIP reader (stored or deflated entries) and the first sheet of an .xlsx. */
final class Zip
{
    /** Inflated entries larger than this are refused (zip bombs). */
    private const MAX_ENTRY_BYTES = 104857600;

    /** @return array<string,string> entry name → bytes. @throws \RuntimeException */
    public static function read(string $buf): array
    {
        $len = strlen($buf);
        $u32 = static function (int $o) use ($buf, $len): int {
            if ($o < 0 || $o + 4 > $len) throw new \RuntimeException('zip: offset out of range');
            return unpack('V', substr($buf, $o, 4))[1];
        };
        $u16 = static function (int $o) use ($buf, $len): int {
            if ($o < 0 || $o + 2 > $len) throw new \RuntimeException('zip: offset out of range');
            return unpack('v', substr($buf, $o, 2))[1];
        };
        $eocd = $len - 22;
        while ($eocd >= 0 && $u32($eocd) !== 0x06054b50) $eocd--;
        if ($eocd < 0) throw new \RuntimeException('not a zip file');
        $count = $u16($eocd + 10);
        $p = $u32($eocd + 16);
        $out = [];
        for ($i = 0; $i < $count; $i++) {
            if ($u32($p) !== 0x02014b50) break;
            $method = $u16($p + 10);
            $csize = $u32($p + 20);
            $nameLen = $u16($p + 28);
            $extraLen = $u16($p + 30);
            $commentLen = $u16($p + 32);
            $localOff = $u32($p + 42);
            $name = substr($buf, $p + 46, $nameLen);
            $lNameLen = $u16($localOff + 26);
            $lExtraLen = $u16($localOff + 28);
            $start = $localOff + 30 + $lNameLen + $lExtraLen;
            $data = (string) substr($buf, $start, $csize);
            if ($method === 8) {
                if (!function_exists('gzinflate')) throw new \RuntimeException('zlib is not available');
                $inflated = @gzinflate($data, self::MAX_ENTRY_BYTES);
                if ($inflated === false) throw new \RuntimeException('zip: invalid deflate data');
                $data = $inflated;
            }
            $out[$name] = $data;
            $p += 46 + $nameLen + $extraLen + $commentLen;
        }
        return $out;
    }

    /** lib/zip.ts crc32. */
    public static function crc32(string $data): int
    {
        return crc32($data) & 0xffffffff;
    }

    /**
     * lib/zip.ts buildZip: minimal ZIP writer (store method, UTF-8 names), byte-identical layout to the Node code.
     * @param list<array{name:string,data:string,mtime?:\DateTimeInterface|string|null}> $entries
     */
    public static function buildZip(array $entries): string
    {
        $parts = '';
        $central = '';
        $offset = 0;
        foreach ($entries as $e) {
            $name = $e['name'];
            $data = $e['data'];
            $crc = self::crc32($data);
            $m = $e['mtime'] ?? null;
            $d = $m instanceof \DateTimeInterface ? \DateTimeImmutable::createFromInterface($m) : new \DateTimeImmutable($m ?? 'now');
            $d = $d->setTimezone(new \DateTimeZone(date_default_timezone_get()));
            $time = ((int) $d->format('G') << 11) | ((int) $d->format('i') << 5) | ((int) $d->format('s') >> 1);
            $date = (((int) $d->format('Y') - 1980) << 9) | ((int) $d->format('n') << 5) | (int) $d->format('j');
            $len = strlen($data);
            $nlen = strlen($name);
            $local = pack('VvvvvvVVVvv', 0x04034b50, 20, 0x0800, 0, $time & 0xffff, $date & 0xffff, $crc, $len, $len, $nlen, 0);
            $parts .= $local . $name . $data;
            $central .= pack('VvvvvvvVVVvvvvvVV', 0x02014b50, 20, 20, 0x0800, 0, $time & 0xffff, $date & 0xffff, $crc, $len, $len, $nlen, 0, 0, 0, 0, 0, $offset) . $name;
            $offset += 30 + $nlen + $len;
        }
        $n = count($entries);
        $end = pack('VvvvvVVv', 0x06054b50, 0, 0, $n, $n, strlen($central), $offset, 0);
        return $parts . $central . $end;
    }

    private static function unesc(string $s): string
    {
        return str_replace(['&lt;', '&gt;', '&quot;', '&apos;', '&amp;'], ['<', '>', '"', "'", '&'], $s);
    }

    private static function colIndex(string $ref): int
    {
        $n = 0;
        foreach (str_split((string) preg_replace('/\d+/', '', $ref)) as $ch) $n = $n * 26 + (ord($ch) - 64);
        return $n - 1;
    }

    /** First worksheet of an .xlsx as rows of strings (shared strings, inline strings and numbers resolved). @return list<list<string>> */
    public static function xlsxRows(string $buf): array
    {
        $files = self::read($buf);
        $shared = [];
        if (isset($files['xl/sharedStrings.xml'])) {
            preg_match_all('/<si>([\s\S]*?)<\/si>/', $files['xl/sharedStrings.xml'], $si);
            foreach ($si[1] as $inner) {
                preg_match_all('/<t[^>]*>([\s\S]*?)<\/t>/', $inner, $t);
                $shared[] = self::unesc(implode('', $t[1]));
            }
        }
        $sheets = array_values(array_filter(array_keys($files), static fn ($k) => (bool) preg_match('/^xl\/worksheets\/sheet\d+\.xml$/', (string) $k)));
        sort($sheets, SORT_STRING);
        if (!$sheets) throw new \RuntimeException('no worksheet');
        $xml = $files[$sheets[0]];
        $rows = [];
        preg_match_all('/<row[^>]*>([\s\S]*?)<\/row>/', $xml, $rm);
        foreach ($rm[1] as $rowXml) {
            $cells = [];
            preg_match_all('/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/', $rowXml, $cm, PREG_SET_ORDER);
            foreach ($cm as $c) {
                $idx = self::colIndex($c[1]);
                $attrs = $c[2] ?? '';
                $inner = $c[3] ?? '';
                $t = preg_match('/t="(\w+)"/', $attrs, $tm) ? $tm[1] : null;
                if ($t === 's') {
                    $i = preg_match('/<v>([^<]*)<\/v>/', $inner, $vm) ? (int) $vm[1] : -1;
                    $v = $shared[$i] ?? '';
                } elseif ($t === 'inlineStr') {
                    preg_match_all('/<t[^>]*>([\s\S]*?)<\/t>/', $inner, $tt);
                    $v = self::unesc(implode('', $tt[1]));
                } else {
                    $v = self::unesc(preg_match('/<v>([^<]*)<\/v>/', $inner, $vm) ? $vm[1] : '');
                }
                $cells[$idx] = Num::jsTrim($v);
            }
            $row = [];
            $max = $cells ? max(array_keys($cells)) : -1;
            for ($i = 0; $i <= $max; $i++) $row[] = $cells[$i] ?? '';
            $rows[] = $row;
        }
        return $rows;
    }
}
