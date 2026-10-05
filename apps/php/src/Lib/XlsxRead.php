<?php
declare(strict_types=1);

namespace Vitral\Lib;

/** Port of apps/server/src/lib/xlsx-read.ts: ZIP reader, first worksheet of an .xlsx, CSV rows. */
final class XlsxRead
{
    /** @return array<string,string> entry name → bytes. @throws \RuntimeException */
    public static function readZip(string $buf): array
    {
        return Zip::read($buf);
    }

    /** First worksheet as rows of strings. @return list<list<string>> @throws \RuntimeException */
    public static function readXlsxRows(string $buf): array
    {
        return Zip::xlsxRows($buf);
    }

    /** CSV (comma or semicolon, quoted fields) as rows of strings; empty rows dropped. @return list<list<string>> */
    public static function readCsvRows(string $text): array
    {
        $rows = [];
        $row = [];
        $cell = '';
        $q = false;
        $src = (string) preg_replace('/^\x{FEFF}/u', '', $text);
        $first = explode("\n", $src)[0];
        $sep = str_contains($first, ';') && !str_contains($first, ',') ? ';' : ',';
        $chars = mb_str_split($src, 1, 'UTF-8');
        $n = count($chars);
        for ($i = 0; $i < $n; $i++) {
            $ch = $chars[$i];
            if ($q) {
                if ($ch === '"') {
                    if (($chars[$i + 1] ?? null) === '"') {
                        $cell .= '"';
                        $i++;
                    } else {
                        $q = false;
                    }
                } else {
                    $cell .= $ch;
                }
                continue;
            }
            if ($ch === '"') {
                $q = true;
            } elseif ($ch === $sep) {
                $row[] = Num::jsTrim($cell);
                $cell = '';
            } elseif ($ch === "\n") {
                $row[] = Num::jsTrim($cell);
                $rows[] = $row;
                $row = [];
                $cell = '';
            } elseif ($ch !== "\r") {
                $cell .= $ch;
            }
        }
        if ($cell !== '' || $row) {
            $row[] = Num::jsTrim($cell);
            $rows[] = $row;
        }
        return array_values(array_filter($rows, static function (array $r): bool {
            foreach ($r as $c) if ($c !== '') return true;
            return false;
        }));
    }
}
