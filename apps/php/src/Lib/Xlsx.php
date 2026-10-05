<?php
declare(strict_types=1);

namespace Vitral\Lib;

/**
 * Port of apps/server/src/lib/xlsx.ts: minimal .xlsx writer (one or more sheets, inline strings, numbers as numbers,
 * RTL view) with no external dependency. Cells: string | int | float | bool | null | DateTimeInterface.
 * An ISO timestamp string as returned by Db ("…T…\.000Z") is written like the Node code writes a JS Date
 * (pg returns Date objects where PHP rows carry ISO strings).
 */
final class Xlsx
{
    public const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    private static function esc(string $s): string
    {
        return str_replace(['&', '<', '>', '"'], ['&amp;', '&lt;', '&gt;', '&quot;'], $s);
    }

    public static function col(int $i): string
    {
        $s = '';
        $n = $i;
        do {
            $s = chr(65 + ($n % 26)) . $s;
            $n = intdiv($n, 26) - 1;
        } while ($n >= 0);
        return $s;
    }

    /** String.prototype.slice of JavaScript (UTF-16 code units). */
    public static function jsSlice(string $s, int $start, ?int $end = null): string
    {
        $u = mb_convert_encoding($s, 'UTF-16LE', 'UTF-8');
        $n = intdiv(strlen($u), 2);
        $a = $start < 0 ? max(0, $n + $start) : min($start, $n);
        $b = $end === null ? $n : ($end < 0 ? max(0, $n + $end) : min($end, $n));
        if ($b <= $a) return '';
        return (string) mb_convert_encoding(substr($u, $a * 2, ($b - $a) * 2), 'UTF-8', 'UTF-16LE');
    }

    /** String(n) of JavaScript for a finite number. */
    private static function jsNumber(int|float $n): string
    {
        if (is_int($n)) return (string) $n;
        if (floor($n) === $n && abs($n) < 1e21) return number_format($n, 0, '.', '');
        return (string) json_encode($n);
    }

    /** @param list<string> $header @param list<list<mixed>> $rows */
    private static function sheetXml(array $header, array $rows): string
    {
        $all = array_merge([$header], $rows);
        $body = '';
        foreach ($all as $ri => $r) {
            $cells = '';
            foreach (array_values($r) as $ci => $c) {
                $ref = self::col($ci) . ($ri + 1);
                if ($c === null || $c === '') continue;
                if (is_int($c) || is_float($c)) {
                    $cells .= "<c r=\"{$ref}\"><v>" . self::jsNumber($c) . '</v></c>';
                    continue;
                }
                if (is_bool($c)) {
                    $cells .= "<c r=\"{$ref}\" t=\"b\"><v>" . ($c ? 1 : 0) . '</v></c>';
                    continue;
                }
                if ($c instanceof \DateTimeInterface) {
                    $cells .= "<c r=\"{$ref}\" t=\"inlineStr\"><is><t>" . self::esc(\Vitral\Core\Json::iso($c)) . '</t></is></c>';
                    continue;
                }
                $s = (string) $c;
                if (preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $s)) {
                    $cells .= "<c r=\"{$ref}\" t=\"inlineStr\"><is><t>" . self::esc($s) . '</t></is></c>';
                    continue;
                }
                if (preg_match('/^-?\d+(\.\d+)?$/', $s) && strlen($s) < 16 && $ri > 0) {
                    $cells .= "<c r=\"{$ref}\"><v>{$s}</v></c>";
                    continue;
                }
                $cells .= "<c r=\"{$ref}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">" . self::esc($s) . '</t></is></c>';
            }
            $body .= '<row r="' . ($ri + 1) . '">' . $cells . '</row>';
        }
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews><sheetData>' . $body . '</sheetData></worksheet>';
    }

    /**
     * buildXlsx(sheets)
     * @param list<array{name:string,header:list<string>,rows:list<list<mixed>>}> $sheets
     */
    public static function buildXlsx(array $sheets): string
    {
        $files = [];
        foreach ($sheets as $i => $s) $files[] = ['name' => 'xl/worksheets/sheet' . ($i + 1) . '.xml', 'data' => self::sheetXml($s['header'], $s['rows'])];
        $overrides = '';
        $sheetTags = '';
        $rels = '';
        foreach ($sheets as $i => $s) {
            $n = $i + 1;
            $overrides .= "<Override PartName=\"/xl/worksheets/sheet{$n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>";
            $sheetTags .= '<sheet name="' . self::esc(self::jsSlice($s['name'], 0, 31)) . "\" sheetId=\"{$n}\" r:id=\"rId{$n}\"/>";
            $rels .= "<Relationship Id=\"rId{$n}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{$n}.xml\"/>";
        }
        $files[] = ['name' => '[Content_Types].xml', 'data' => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' . $overrides . '</Types>'];
        $files[] = ['name' => '_rels/.rels', 'data' => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'];
        $files[] = ['name' => 'xl/workbook.xml', 'data' => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' . $sheetTags . '</sheets></workbook>'];
        $files[] = ['name' => 'xl/_rels/workbook.xml.rels', 'data' => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' . $rels . '</Relationships>'];
        return Zip::buildZip($files);
    }

    /**
     * `Content-Disposition: attachment` for a download name (lib/xlsx.ts attachment): a plain ASCII name keeps the simple
     * form; any other name gets an ASCII fallback plus the RFC 5987 `filename*`.
     */
    public static function attachment(string $filename): string
    {
        if (preg_match('/^[\x20-\x7e]*$/', $filename) && !preg_match('/["\\\\]/', $filename)) return "attachment; filename=\"{$filename}\"";
        $fallback = (string) preg_replace('/[^\x20-\x7e]+|["\\\\]/', '_', $filename);
        return "attachment; filename=\"{$fallback}\"; filename*=UTF-8''" . rawurlencode($filename);
    }
}
