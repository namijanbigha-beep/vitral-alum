<?php
declare(strict_types=1);

namespace Vitral\Modules;

use Vitral\Core\App;
use Vitral\Core\AppError;
use Vitral\Core\Audit;
use Vitral\Core\Db;
use Vitral\Core\Idempotency;
use Vitral\Core\Json;
use Vitral\Core\JsonList;
use Vitral\Core\Numbering;
use Vitral\Core\Request;
use Vitral\Core\Response;
use Vitral\Core\Router;
use Vitral\Core\Schema;
use Vitral\Core\Undef;
use Vitral\Core\V;
use Vitral\Lib\Decimal;
use Vitral\Lib\Jalali;
use Vitral\Lib\Num;
use Vitral\Lib\Stock;
use Vitral\Lib\Xlsx;
use Vitral\Lib\XlsxRead;
use Vitral\Rules\Weights;

/**
 * Port of apps/server/src/modules/import/routes.ts (spec §18): templates, field lists, preview (parse, map, validate;
 * nothing written but the batch), commit in one transaction, and revert of a trial import.
 * Text comparisons that the Node code does with `=` in PostgreSQL (case- and accent-sensitive) use utf8mb4_bin here.
 */
final class Import
{
    public const IMPORT_KINDS = ['products', 'dies', 'parties', 'contracts', 'opening_stock', 'open_orders', 'factor_app', 'chatgpt'];
    public const SHEET_KINDS = ['products', 'dies', 'parties', 'contracts', 'opening_stock', 'open_orders'];
    private const BIN = ' COLLATE utf8mb4_bin';

    /** Template columns (spec §18) with the Persian header → field mapping; the first alias is the template header. */
    public const FIELDS = [
        'products' => [
            ['field' => 'code', 'aliases' => ['کد', 'کد محصول', 'code'], 'required' => true, 'sample' => '7168'], ['field' => 'name_fa', 'aliases' => ['نام فارسی', 'نام', 'name_fa'], 'required' => true, 'sample' => 'مولیون'], ['field' => 'name_ar', 'aliases' => ['نام عربی', 'name_ar'], 'sample' => 'موليون'], ['field' => 'name_en', 'aliases' => ['نام انگلیسی', 'name_en'], 'sample' => 'Mullion'],
            ['field' => 'category', 'aliases' => ['دسته', 'category'], 'sample' => 'نما'], ['field' => 'alloy', 'aliases' => ['آلیاژ', 'alloy'], 'sample' => '6063'], ['field' => 'section_area_mm2', 'aliases' => ['سطح مقطع (mm²)', 'سطح مقطع', 'section_area_mm2'], 'sample' => '293'], ['field' => 'filler_mm', 'aliases' => ['فیلر (mm)', 'فیلر', 'filler_mm'], 'sample' => '1.2'],
            ['field' => 'weight_g_per_m', 'aliases' => ['وزن هر متر (گرم)', 'وزن هر متر', 'weight_g_per_m'], 'sample' => '791'], ['field' => 'weight_source', 'aliases' => ['منبع وزن', 'weight_source'], 'sample' => 'drawing'], ['field' => 'common_lengths', 'aliases' => ['طول‌های رایج', 'طول های رایج', 'common_lengths'], 'sample' => '6'], ['field' => 'colors', 'aliases' => ['رنگ‌ها', 'رنگ ها', 'colors'], 'sample' => 'سفید، مشکی مات'],
        ],
        'dies' => [
            ['field' => 'code', 'aliases' => ['کد قالب', 'کد', 'code'], 'required' => true, 'sample' => 'D-7168'], ['field' => 'product_code', 'aliases' => ['کد محصول', 'product_code'], 'sample' => '7168'], ['field' => 'owner', 'aliases' => ['مالک', 'owner'], 'sample' => 'ویترال'], ['field' => 'location', 'aliases' => ['محل فعلی', 'محل', 'location'], 'sample' => 'کارخانه نمونه'], ['field' => 'status', 'aliases' => ['وضعیت', 'status'], 'sample' => 'ready'], ['field' => 'compatible_press', 'aliases' => ['پرس سازگار', 'compatible_press'], 'sample' => '1800 تن'],
        ],
        'parties' => [
            ['field' => 'name', 'aliases' => ['نام', 'name'], 'required' => true, 'sample' => 'مشتری نمونه'], ['field' => 'roles', 'aliases' => ['نقش‌ها', 'نقش ها', 'نقش', 'roles'], 'required' => true, 'sample' => 'customer'], ['field' => 'phone', 'aliases' => ['تلفن', 'موبایل', 'phone'], 'sample' => '09120000000'], ['field' => 'country', 'aliases' => ['کشور', 'country'], 'sample' => 'ایران'], ['field' => 'city', 'aliases' => ['شهر', 'city'], 'sample' => 'تهران'], ['field' => 'address', 'aliases' => ['نشانی', 'address'], 'sample' => 'نشانی نمونه'],
            ['field' => 'default_currency', 'aliases' => ['ارز پیش‌فرض', 'ارز پیش فرض', 'default_currency'], 'sample' => 'TOMAN'], ['field' => 'opening_toman', 'aliases' => ['مانده افتتاحیه تومان', 'opening_toman'], 'sample' => '0'], ['field' => 'opening_usd', 'aliases' => ['دلار', 'مانده افتتاحیه دلار', 'opening_usd'], 'sample' => '0'], ['field' => 'opening_iqd', 'aliases' => ['دینار', 'مانده افتتاحیه دینار', 'opening_iqd'], 'sample' => '0'], ['field' => 'opening_date', 'aliases' => ['تاریخ مانده', 'opening_date'], 'sample' => '1405/01/01'],
        ],
        'contracts' => [
            ['field' => 'party', 'aliases' => ['طرف', 'party'], 'required' => true, 'sample' => 'کارخانه نمونه'], ['field' => 'service', 'aliases' => ['خدمت', 'service'], 'required' => true, 'sample' => 'extrusion'], ['field' => 'rate_per_kg', 'aliases' => ['نرخ هر کیلو', 'rate_per_kg'], 'sample' => '12000'], ['field' => 'currency', 'aliases' => ['ارز', 'currency'], 'sample' => 'TOMAN'], ['field' => 'weight_basis', 'aliases' => ['مبنای وزن', 'weight_basis'], 'sample' => 'input'],
            ['field' => 'fixed_fee', 'aliases' => ['هزینه ثابت', 'fixed_fee'], 'sample' => '0'], ['field' => 'scrap_owner', 'aliases' => ['مالک ضایعات', 'scrap_owner'], 'sample' => 'vitral'], ['field' => 'includes_material', 'aliases' => ['شمول ماده', 'includes_material'], 'sample' => 'بله'], ['field' => 'valid_from', 'aliases' => ['از تاریخ', 'valid_from'], 'required' => true, 'sample' => '1405/01/01'],
        ],
        'opening_stock' => [
            ['field' => 'type', 'aliases' => ['نوع', 'type'], 'required' => true, 'sample' => 'ingot'], ['field' => 'item', 'aliases' => ['محصول یا ماده', 'محصول', 'ماده', 'item'], 'sample' => 'شمش 6063'], ['field' => 'alloy', 'aliases' => ['آلیاژ', 'alloy'], 'sample' => '6063'], ['field' => 'filler_mm', 'aliases' => ['فیلر', 'filler_mm'], 'sample' => ''], ['field' => 'length_m', 'aliases' => ['طول', 'length_m'], 'sample' => ''], ['field' => 'color', 'aliases' => ['رنگ', 'color'], 'sample' => ''],
            ['field' => 'owner', 'aliases' => ['مالک', 'owner'], 'sample' => 'ویترال'], ['field' => 'location', 'aliases' => ['محل', 'location'], 'required' => true, 'sample' => 'انبار ویترال'], ['field' => 'kg', 'aliases' => ['کیلو', 'kg'], 'required' => true, 'sample' => '1000'], ['field' => 'bars', 'aliases' => ['تعداد شاخه', 'bars'], 'sample' => ''], ['field' => 'unit_cost', 'aliases' => ['ارزش هر کیلو', 'unit_cost'], 'sample' => '180000'], ['field' => 'date', 'aliases' => ['تاریخ', 'date'], 'required' => true, 'sample' => '1405/01/01'],
        ],
        'open_orders' => [
            ['field' => 'old_number', 'aliases' => ['شماره قدیم', 'old_number'], 'sample' => 'A-12'], ['field' => 'party', 'aliases' => ['مشتری', 'party'], 'required' => true, 'sample' => 'مشتری نمونه'], ['field' => 'date', 'aliases' => ['تاریخ', 'date'], 'required' => true, 'sample' => '1405/01/01'], ['field' => 'lines', 'aliases' => ['ردیف‌ها', 'ردیف ها', 'lines'], 'required' => true, 'sample' => '7168 × 500 کیلو'], ['field' => 'price', 'aliases' => ['قیمت', 'price'], 'sample' => '850000'], ['field' => 'currency', 'aliases' => ['ارز', 'currency'], 'sample' => 'TOMAN'], ['field' => 'received', 'aliases' => ['دریافتی تا امروز', 'received'], 'sample' => '0'],
        ],
    ];

    private const PARTY_ROLES = ['customer', 'factory', 'painter', 'anodizer', 'ingot_supplier', 'scrap_trader', 'smelter', 'die_maker', 'carrier', 'tool_supplier', 'other'];

    // ---------------------------------------------------------------- cell parsers (throw \DomainException with the row message)

    private static function num(mixed $v): ?string
    {
        $s = Num::jsTrim(Schema::jsString($v ?? ''));
        if ($s === '') return null;
        $n = Num::parseNumber($s);
        if ($n === null) throw new \DomainException('عدد نامعتبر');
        return $n;
    }

    /** Jalali (any digits) or a Gregorian date → ISO instant (UTC midnight for Jalali), as JSON.stringify(Date) gives. */
    private static function date(mixed $v): ?string
    {
        $s = Num::toLatinDigits(Num::jsTrim(Schema::jsString($v ?? '')));
        if ($s === '') return null;
        $j = Jalali::parse($s);
        if ($j === null) {
            if (!preg_match('/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/', $s)) throw new \DomainException('تاریخ نامعتبر');
            try {
                $d = new \DateTimeImmutable(strlen($s) === 10 ? $s . 'T00:00:00Z' : $s);
            } catch (\Throwable) {
                throw new \DomainException('تاریخ نامعتبر');
            }
            return Json::iso($d);
        }
        $g = Jalali::toGregorian($j['jy'], $j['jm'], $j['jd']);
        return sprintf('%04d-%02d-%02dT00:00:00.000Z', $g['gy'], $g['gm'], $g['gd']);
    }

    /** @return list<string> */
    private static function list(mixed $v): array
    {
        $parts = preg_split('/[،,;\n]/u', Schema::jsString($v ?? '')) ?: [];
        return array_values(array_filter(array_map([Num::class, 'jsTrim'], $parts), static fn ($s) => $s !== ''));
    }

    private static function yes(mixed $v): ?bool
    {
        $s = mb_strtolower(Num::jsTrim(Schema::jsString($v ?? '')));
        if ($s === '') return null;
        return in_array($s, ['بله', 'yes', 'true', '1', 'دارد'], true);
    }

    /** `x || null` for a mapped cell. */
    private static function orNull(?string $v): ?string
    {
        return $v === null || $v === '' ? null : $v;
    }

    /** JS truthiness (the string '0' is truthy). */
    private static function t(mixed $v): bool
    {
        return Schema::jsTruthy($v);
    }

    private static function upper(string $s): string
    {
        return mb_strtoupper($s);
    }

    // ---------------------------------------------------------------- mapping and preparation

    /** @param list<list<string>> $raw @return list<array<string,string>> */
    private static function mapRows(string $kind, array $raw, ?array $mapping): array
    {
        $header = array_map(static fn ($h) => Num::jsTrim((string) $h), $raw[0] ?? []);
        $defs = self::FIELDS[$kind];
        $colFor = [];
        foreach ($defs as $d) {
            if ($mapping !== null && array_key_exists($d['field'], $mapping)) {
                $idx = array_search($mapping[$d['field']], $header, true);
                $idx = $idx === false ? -1 : $idx;
            } else {
                $idx = -1;
                foreach ($header as $i => $h) {
                    foreach ($d['aliases'] as $a) {
                        if (mb_strtolower($a) === mb_strtolower($h)) {
                            $idx = $i;
                            break 2;
                        }
                    }
                }
            }
            if ($idx >= 0) $colFor[$d['field']] = $idx;
        }
        $out = [];
        foreach (array_slice($raw, 1) as $r) {
            $any = false;
            foreach ($r as $c) if ($c !== null && $c !== '' && Num::jsTrim((string) $c) !== '') $any = true;
            if (!$any) continue;
            $row = [];
            foreach ($defs as $d) $row[$d['field']] = isset($colFor[$d['field']]) ? (string) ($r[$colFor[$d['field']]] ?? '') : '';
            $out[] = $row;
        }
        return $out;
    }

    /** @return array{rows:list<array<string,mixed>>,errors:list<array<string,mixed>>,duplicates:list<array<string,mixed>>,header:list<string>,unmapped:list<string>} */
    private static function prepare(Db $db, string $kind, mixed $raw, ?array $mapping): array
    {
        $errors = [];
        $duplicates = [];
        if ($kind === 'factor_app' || $kind === 'chatgpt') return self::prepareJson($db, $kind, $raw) + ['header' => [], 'unmapped' => []];
        $rows2d = is_array($raw) ? $raw : [];
        $mapped = self::mapRows($kind, $rows2d, $mapping);
        $header = $rows2d[0] ?? [];
        $defs = self::FIELDS[$kind];
        $unmapped = [];
        foreach ($defs as $d) {
            if (empty($d['required'])) continue;
            $found = false;
            foreach ($header as $h) {
                $h = (string) $h;
                $hit = $mapping !== null && array_key_exists($d['field'], $mapping) ? str_contains((string) $mapping[$d['field']], $h) : in_array($h, $d['aliases'], true);
                if ($hit) $found = true;
            }
            if (!$found) $unmapped[] = $d['aliases'][0];
        }
        $rows = [];
        $seen = [];
        $B = self::BIN;
        foreach ($mapped as $i => $r) {
            $n = $i + 2;
            $out = [];
            try {
                foreach ($defs as $d) {
                    if (!empty($d['required']) && Num::jsTrim($r[$d['field']] ?? '') === '') $errors[] = ['row' => $n, 'field' => $d['field'], 'message' => "«{$d['aliases'][0]}» لازم است"];
                }
                switch ($kind) {
                    case 'products':
                        $out['code'] = Num::jsTrim(Num::toLatinDigits($r['code']));
                        $out['name_fa'] = $r['name_fa'];
                        $out['name_ar'] = self::orNull($r['name_ar']);
                        $out['name_en'] = self::orNull($r['name_en']);
                        $cats = ['لاین نوری' => 'light_line', 'نما' => 'facade', 'درب و پنجره' => 'door_window', 'عمومی' => 'general', 'متفرقه' => 'misc'];
                        $out['category'] = $r['category'] !== '' ? ($cats[$r['category']] ?? $r['category']) : null;
                        $out['alloy'] = self::orNull($r['alloy']);
                        $out['section_area_mm2'] = self::num($r['section_area_mm2']);
                        $out['filler_mm'] = self::num($r['filler_mm']);
                        $out['weight_g_per_m'] = self::num($r['weight_g_per_m']) ?? (self::t($out['section_area_mm2']) ? Weights::suggestedWeightPerMeter($out['section_area_mm2']) : null);
                        $out['weight_source'] = $r['weight_source'] !== '' ? $r['weight_source'] : (self::t(self::num($r['weight_g_per_m'])) ? 'drawing' : 'formula');
                        $out['common_lengths'] = array_values(array_filter(array_map([Num::class, 'parseNumber'], self::list($r['common_lengths'])), [self::class, 't']));
                        $out['colors'] = self::list($r['colors']);
                        if ($out['code'] !== '' && $db->value("SELECT id FROM products WHERE code{$B} = ? LIMIT 1", [$out['code']]) !== null) $duplicates[] = ['row' => $n, 'field' => 'code', 'message' => "کد {$out['code']} قبلاً وجود دارد"];
                        if (isset($seen["c:{$out['code']}"])) $duplicates[] = ['row' => $n, 'field' => 'code', 'message' => "کد {$out['code']} در فایل تکراری است"];
                        $seen["c:{$out['code']}"] = true;
                        break;
                    case 'dies':
                        $out['code'] = Num::jsTrim(Num::toLatinDigits($r['code']));
                        $out['product_code'] = self::orNull(Num::jsTrim(Num::toLatinDigits($r['product_code'])));
                        $out['owner'] = self::orNull($r['owner']);
                        $out['location'] = self::orNull($r['location']);
                        $out['status'] = $r['status'] !== '' ? $r['status'] : 'ready';
                        $out['compatible_press'] = self::orNull($r['compatible_press']);
                        if (self::t($out['product_code']) && $db->value("SELECT id FROM products WHERE code{$B} = ? LIMIT 1", [$out['product_code']]) === null) $errors[] = ['row' => $n, 'field' => 'product_code', 'message' => "محصول {$out['product_code']} وجود ندارد"];
                        if ($db->value("SELECT id FROM dies WHERE code{$B} = ? LIMIT 1", [$out['code']]) !== null) $duplicates[] = ['row' => $n, 'field' => 'code', 'message' => "قالب {$out['code']} قبلاً وجود دارد"];
                        break;
                    case 'parties':
                        $out['name'] = Num::jsTrim($r['name']);
                        $roleMap = ['مشتری' => 'customer', 'کارخانه' => 'factory', 'رنگ‌کار' => 'painter', 'رنگکار' => 'painter', 'آنودایزر' => 'anodizer', 'تأمین‌کننده شمش' => 'ingot_supplier', 'ضایعات‌خر' => 'scrap_trader', 'ریخته‌گر' => 'smelter', 'قالب‌ساز' => 'die_maker', 'باربری' => 'carrier', 'ابزارفروش' => 'tool_supplier', 'سایر' => 'other'];
                        $out['roles'] = array_map(static fn ($x) => $roleMap[$x] ?? $x, self::list($r['roles']));
                        $out['phones'] = array_map([Num::class, 'toLatinDigits'], self::list($r['phone']));
                        $out['country'] = self::orNull($r['country']);
                        $out['city'] = self::orNull($r['city']);
                        $out['address'] = self::orNull($r['address']);
                        $out['default_currency'] = self::upper($r['default_currency'] !== '' ? $r['default_currency'] : 'TOMAN');
                        $out['opening'] = ['TOMAN' => self::num($r['opening_toman']), 'USD' => self::num($r['opening_usd']), 'IQD' => self::num($r['opening_iqd'])];
                        $out['opening_date'] = self::date($r['opening_date']);
                        if (!in_array($out['default_currency'], Num::CURRENCIES, true)) $errors[] = ['row' => $n, 'field' => 'default_currency', 'message' => 'ارز باید TOMAN، USD یا IQD باشد'];
                        if ($out['name'] !== '') {
                            $sql = "SELECT id, name FROM parties WHERE name{$B} = ?";
                            $params = [$out['name']];
                            foreach ($out['phones'] as $ph) {
                                $sql .= ' OR phones LIKE ?';
                                $params[] = '%' . substr(Json::encode($ph), 0, -1) . '"%';
                            }
                            $dup = $db->one($sql . ' LIMIT 1', $params);
                            if ($dup) $duplicates[] = ['row' => $n, 'field' => 'name', 'message' => "طرف «{$dup['name']}» با همین نام یا تلفن وجود دارد"];
                        }
                        break;
                    case 'contracts':
                        $out['party'] = Num::jsTrim($r['party']);
                        $svc = ['اکستروژن' => 'extrusion', 'تولید' => 'extrusion', 'رنگ' => 'paint', 'آنودایز' => 'anodize', 'ذوب' => 'smelting', 'قالب‌سازی' => 'die_making', 'حمل' => 'transport'];
                        $out['service'] = $svc[$r['service']] ?? $r['service'];
                        $out['rate_per_kg'] = self::num($r['rate_per_kg']);
                        $out['currency'] = self::upper($r['currency'] !== '' ? $r['currency'] : 'TOMAN');
                        $wb = ['ورودی' => 'input', 'خروجی سالم' => 'good_output'];
                        $out['weight_basis'] = $wb[$r['weight_basis']] ?? self::orNull($r['weight_basis']);
                        $out['fixed_fee'] = self::num($r['fixed_fee']);
                        $so = ['ویترال' => 'vitral', 'کارخانه' => 'factory'];
                        $out['scrap_owner'] = $so[$r['scrap_owner']] ?? self::orNull($r['scrap_owner']);
                        $out['includes_material'] = self::yes($r['includes_material']);
                        $out['valid_from'] = self::date($r['valid_from']);
                        $pid = $db->value("SELECT id FROM parties WHERE name{$B} = ? LIMIT 1", [$out['party']]);
                        if ($pid === null) $errors[] = ['row' => $n, 'field' => 'party', 'message' => "طرف «{$out['party']}» وجود ندارد"];
                        else $out['party_id'] = $pid;
                        break;
                    case 'opening_stock':
                        $types = ['شمش' => 'ingot', 'بیلت' => 'billet', 'ضایعات' => 'scrap', 'خام' => 'raw', 'رنگ‌شده' => 'painted', 'رنگ شده' => 'painted', 'آنودایز' => 'anodized'];
                        $out['type'] = $types[$r['type']] ?? $r['type'];
                        $out['item'] = self::orNull($r['item']);
                        $out['alloy'] = self::orNull($r['alloy']);
                        $out['filler_mm'] = self::num($r['filler_mm']);
                        $out['length_m'] = self::num($r['length_m']);
                        $out['color'] = self::orNull($r['color']);
                        $out['owner'] = self::orNull($r['owner']);
                        $out['location'] = $r['location'];
                        $out['kg'] = self::num($r['kg']);
                        $out['bars'] = self::num($r['bars']);
                        $out['unit_cost'] = self::num($r['unit_cost']);
                        $out['date'] = self::date($r['date']);
                        $loc = $db->value("SELECT id FROM locations WHERE name{$B} = ? LIMIT 1", [$out['location']]);
                        if ($loc === null) $errors[] = ['row' => $n, 'field' => 'location', 'message' => "محل «{$out['location']}» وجود ندارد"];
                        else $out['location_id'] = $loc;
                        if (in_array($out['type'], ['raw', 'painted', 'anodized'], true)) {
                            $pid = $db->value("SELECT id FROM products WHERE code{$B} = ? LIMIT 1", [Num::toLatinDigits((string) ($out['item'] ?? ''))]);
                            if ($pid === null) $errors[] = ['row' => $n, 'field' => 'item', 'message' => "محصول «{$out['item']}» وجود ندارد"];
                            else $out['product_id'] = $pid;
                        }
                        if (!$out['kg'] || Decimal::of($out['kg'])->lte(0)) $errors[] = ['row' => $n, 'field' => 'kg', 'message' => 'کیلو باید بزرگ‌تر از صفر باشد'];
                        break;
                    case 'open_orders':
                        $out['old_number'] = self::orNull($r['old_number']);
                        $out['party'] = Num::jsTrim($r['party']);
                        $out['date'] = self::date($r['date']);
                        $out['currency'] = self::upper($r['currency'] !== '' ? $r['currency'] : 'TOMAN');
                        $out['price'] = self::num($r['price']);
                        $out['received'] = self::num($r['received']);
                        $out['lines'] = array_map(static function ($l) {
                            if (preg_match('/^(\S+)\s*[×x\*]\s*([\d.,٠-٩۰-۹]+)/u', Num::jsTrim($l), $m)) return ['product_code' => Num::toLatinDigits($m[1]), 'qty_kg' => Num::parseNumber($m[2])];
                            return ['description' => $l];
                        }, self::list($r['lines']));
                        $pid = $db->value("SELECT id FROM parties WHERE name{$B} = ? LIMIT 1", [$out['party']]);
                        if ($pid === null) $errors[] = ['row' => $n, 'field' => 'party', 'message' => "مشتری «{$out['party']}» وجود ندارد"];
                        else $out['party_id'] = $pid;
                        foreach ($out['lines'] as $li => $l) {
                            if (empty($l['product_code'])) continue;
                            $prid = $db->value("SELECT id FROM products WHERE code{$B} = ? LIMIT 1", [$l['product_code']]);
                            if ($prid === null) $errors[] = ['row' => $n, 'field' => 'lines', 'message' => "محصول {$l['product_code']} وجود ندارد"];
                            else $out['lines'][$li]['product_id'] = $prid;
                        }
                        break;
                }
            } catch (\DomainException $e) {
                $errors[] = ['row' => $n, 'message' => $e->getMessage()];
            }
            $rows[] = ['_row' => $n] + $out;
        }
        return ['rows' => $rows, 'errors' => $errors, 'duplicates' => $duplicates, 'header' => $header, 'unmapped' => $unmapped];
    }

    /** Backups of the previous apps (§18): tolerant mapping of the parts we recognise; the rest is listed as skipped. */
    private static function prepareJson(Db $db, string $kind, mixed $raw): array
    {
        $errors = [];
        $duplicates = [];
        $rows = [];
        $root = is_array($raw) ? $raw : [];
        $data = $root;
        if ($kind === 'factor_app' && isset($root['factorApp']) && $root['factorApp'] !== null) $data = is_array($root['factorApp']) ? $root['factorApp'] : [];
        $arr = static function (array $keys) use ($data): array {
            foreach ($keys as $k) if (isset($data[$k]) && Json::isList($data[$k])) return $data[$k];
            return [];
        };
        $pick = static function (mixed $o, array $keys): mixed {
            if (!is_array($o)) return null;
            foreach ($keys as $k) if (array_key_exists($k, $o) && $o[$k] !== null && $o[$k] !== '') return $o[$k];
            return null;
        };
        $B = self::BIN;
        $n = 1;
        foreach ($arr(['customers', 'parties', 'clients']) as $c) {
            $nm = $pick($c, ['name', 'title', 'fullName']);
            $name = $nm === null ? '' : Schema::jsString($nm);
            if ($name === '') {
                $errors[] = ['row' => $n, 'message' => 'مشتری بدون نام'];
                $n++;
                continue;
            }
            $ph = $pick($c, ['phone', 'mobile', 'tel']);
            $phones = Schema::jsTruthy($ph) ? [Num::toLatinDigits(Schema::jsString($ph))] : [];
            if ($db->value("SELECT id FROM parties WHERE name{$B} = ? LIMIT 1", [$name]) !== null) $duplicates[] = ['row' => $n, 'field' => 'name', 'message' => "«{$name}» وجود دارد"];
            $bal = $pick($c, ['balance', 'openingBalance']);
            $rows[] = ['_row' => $n++, '_entity' => 'party', 'name' => $name, 'roles' => ['customer'], 'phones' => $phones, 'address' => $pick($c, ['address']), 'default_currency' => 'TOMAN', 'opening' => ['TOMAN' => $bal !== null ? Num::parseNumber(Schema::jsString($bal)) : null], 'opening_date' => Json::iso(new \DateTimeImmutable('now'))];
        }
        foreach ($arr(['products', 'profiles', 'items']) as $p) {
            $cv = $pick($p, ['code', 'id', 'sku']);
            $code = Num::toLatinDigits($cv === null ? '' : Schema::jsString($cv));
            $nv = $pick($p, ['name', 'title']);
            $name = $nv === null ? $code : Schema::jsString($nv);
            if ($code === '') {
                $errors[] = ['row' => $n, 'message' => 'محصول بدون کد'];
                $n++;
                continue;
            }
            $g = $pick($p, ['weightPerMeter', 'weight_g_per_m', 'gramPerMeter', 'weight']);
            if ($kind === 'chatgpt' && $g !== null && Schema::jsNumber($g) < 20) $g = Decimal::of(Schema::jsString($g))->mul(1000)->toFixed(); // ChatGPT app kept kg/m
            if ($db->value("SELECT id FROM products WHERE code{$B} = ? LIMIT 1", [$code]) !== null) $duplicates[] = ['row' => $n, 'field' => 'code', 'message' => "کد {$code} وجود دارد"];
            $rows[] = ['_row' => $n++, '_entity' => 'product', 'code' => $code, 'name_fa' => $name, 'weight_g_per_m' => $g !== null ? Num::parseNumber(Schema::jsString($g)) : null, 'weight_source' => 'agreed', 'common_lengths' => ['6'], 'colors' => []];
        }
        foreach ($arr(['invoices', 'sales']) as $inv) {
            $num = $pick($inv, ['number', 'id']);
            $rows[] = ['_row' => $n++, '_entity' => 'note', 'text' => 'فاکتور قدیمی ' . ($num === null ? '' : Schema::jsString($num)) . ': ' . Xlsx::jsSlice(Json::encode($inv), 0, 500), 'topic' => 'other'];
        }
        foreach (['payments', 'ingotMoves', 'productionOrders', 'factoryAccounts', 'bundles'] as $key) {
            if (isset($data[$key]) && Json::isList($data[$key])) {
                $cnt = count($data[$key]);
                $rows[] = ['_row' => $n++, '_entity' => 'skipped', 'key' => $key, 'count' => $cnt, 'message' => "«{$key}» با {$cnt} رکورد فقط به‌صورت یادداشت بایگانی می‌شود؛ مانده‌ها را با فایل افتتاحیه وارد کنید"];
            }
        }
        return ['rows' => $rows, 'errors' => $errors, 'duplicates' => $duplicates];
    }

    /** ISO instant (or null) → DATE literal / DateTime for inserts. */
    private static function day(?string $iso): string
    {
        return $iso ? gmdate('Y-m-d', (int) strtotime($iso)) : gmdate('Y-m-d');
    }

    private static function at(?string $iso): \DateTimeImmutable
    {
        return $iso ? new \DateTimeImmutable($iso) : new \DateTimeImmutable('now');
    }

    /** @return array<string,list<string>> table → created ids */
    private static function commit(Db $trx, string $kind, array $rows, string $userId): array
    {
        $created = [];
        $add = static function (string $t, string $id) use (&$created): void {
            $created[$t][] = $id;
        };
        $wh = Stock::OWN_WAREHOUSE($trx);
        $B = self::BIN;
        foreach ($rows as $r) {
            $entity = $r['_entity'] ?? $kind;
            if ($entity === 'skipped') continue;
            if ($entity === 'note') {
                $add('free_notes', $trx->insertNoReturn('free_notes', ['text' => Schema::jsString($r['text']), 'topic' => 'other', 'status' => 'reviewed', 'created_by' => $userId]));
                continue;
            }
            if ($kind === 'products' || $entity === 'product') {
                $pid = $trx->insertNoReturn('products', [
                    'code' => Schema::jsString($r['code']), 'name_fa' => Schema::jsString($r['name_fa']), 'name_ar' => $r['name_ar'] ?? null, 'name_en' => $r['name_en'] ?? null,
                    'category' => $r['category'] ?? null, 'alloy' => $r['alloy'] ?? null, 'section_area_mm2' => $r['section_area_mm2'] ?? null, 'weight_g_per_m_no_filler' => null,
                    'common_lengths' => $r['common_lengths'] ?? [], 'colors' => $r['colors'] ?? [], 'created_by' => $userId,
                ]);
                $add('products', $pid);
                if (self::t($r['weight_g_per_m'] ?? null)) {
                    $src = in_array(Schema::jsString($r['weight_source'] ?? null), ['drawing', 'sample', 'formula', 'agreed'], true) ? Schema::jsString($r['weight_source']) : 'agreed';
                    $add('product_fillers', $trx->insertNoReturn('product_fillers', [
                        'product_id' => $pid, 'filler_mm' => $r['filler_mm'] ?? null, 'weight_g_per_m' => Schema::jsString($r['weight_g_per_m']), 'source' => $src,
                        'status' => 'approved', 'approved_by' => $userId, 'approved_at' => Db::raw('NOW(3)'), 'created_by' => $userId,
                    ]));
                }
            } elseif ($kind === 'dies') {
                $prod = self::t($r['product_code'] ?? null) ? $trx->value("SELECT id FROM products WHERE code{$B} = ? LIMIT 1", [Schema::jsString($r['product_code'])]) : null;
                $loc = self::t($r['location'] ?? null) ? $trx->value("SELECT id FROM locations WHERE name{$B} = ? LIMIT 1", [Schema::jsString($r['location'])]) : null;
                $owner = self::t($r['owner'] ?? null) && Schema::jsString($r['owner']) !== 'ویترال' ? $trx->value("SELECT id FROM parties WHERE name{$B} = ? LIMIT 1", [Schema::jsString($r['owner'])]) : null;
                $status = Schema::jsString($r['status'] ?? null);
                $add('dies', $trx->insertNoReturn('dies', [
                    'code' => Schema::jsString($r['code']), 'product_id' => $prod, 'location_id' => $loc, 'owner_party_id' => $owner,
                    'status' => in_array($status, ['design', 'making', 'ready', 'needs_repair', 'retired'], true) ? $status : 'ready', 'compatible_press' => $r['compatible_press'] ?? null, 'created_by' => $userId,
                ]));
            } elseif ($kind === 'parties' || $entity === 'party') {
                $roles = is_array($r['roles'] ?? null) ? $r['roles'] : [];
                $pid = $trx->insertNoReturn('parties', [
                    'name' => Schema::jsString($r['name']), 'roles' => array_values(array_filter($roles, static fn ($x) => in_array($x, self::PARTY_ROLES, true))),
                    'phones' => $r['phones'] ?? [], 'country' => $r['country'] ?? null, 'city' => $r['city'] ?? null, 'address' => $r['address'] ?? null,
                    'default_currency' => Schema::jsString($r['default_currency'] ?? 'TOMAN'), 'created_by' => $userId,
                ]);
                $add('parties', $pid);
                foreach ($roles as $role) {
                    $kindL = $role === 'factory' || $role === 'smelter' ? 'factory' : ($role === 'painter' || $role === 'anodizer' ? 'painter' : null);
                    if ($kindL && $trx->value('SELECT id FROM locations WHERE party_id = ? AND kind = ? LIMIT 1', [$pid, $kindL]) === null) {
                        $add('locations', $trx->insertNoReturn('locations', ['name' => Schema::jsString($r['name']), 'kind' => $kindL, 'party_id' => $pid, 'created_by' => $userId]));
                    }
                }
                $opening = is_array($r['opening'] ?? null) ? $r['opening'] : [];
                foreach (Num::CURRENCIES as $cur) {
                    $v = $opening[$cur] ?? null;
                    if (self::t($v) && !Decimal::of($v)->isZero()) {
                        $add('documents', $trx->insertNoReturn('documents', [
                            'number' => Numbering::next($trx, 'opening_balance'), 'kind' => 'opening_balance', 'party_id' => $pid, 'amount' => Decimal::of($v)->abs()->toFixed(2),
                            'barter_sign' => Decimal::of($v)->gt(0) ? 1 : -1, 'currency' => $cur, 'status' => 'posted', 'locked' => true, 'posted_by' => $userId, 'posted_at' => Db::raw('NOW(3)'),
                            'date' => self::day($r['opening_date'] ?? null), 'description' => 'مانده افتتاحیه (ورود گروهی)', 'created_by' => $userId,
                        ]));
                    }
                }
            } elseif ($kind === 'contracts') {
                $add('contracts', $trx->insertNoReturn('contracts', [
                    'party_id' => Schema::jsString($r['party_id'] ?? null), 'service' => Schema::jsString($r['service']), 'rate_per_kg' => $r['rate_per_kg'] ?? null, 'currency' => Schema::jsString($r['currency'] ?? 'TOMAN'),
                    'weight_basis' => $r['weight_basis'] ?? null, 'fixed_fee' => $r['fixed_fee'] ?? null, 'scrap_owner' => $r['scrap_owner'] ?? null, 'includes_material' => $r['includes_material'] ?? null,
                    'valid_from' => ($r['valid_from'] ?? null) !== null ? self::day($r['valid_from']) : null, 'created_by' => $userId,
                ]));
            } elseif ($kind === 'opening_stock') {
                $at = self::at($r['date'] ?? null);
                $locId = Schema::jsString($r['location_id'] ?? $wh);
                $owner = self::t($r['owner'] ?? null) && Schema::jsString($r['owner']) !== 'ویترال' ? $trx->value("SELECT id FROM parties WHERE name{$B} = ? LIMIT 1", [Schema::jsString($r['owner'])]) : null;
                $kg = Schema::jsString($r['kg']);
                $unitCost = $r['unit_cost'] ?? null;
                $type = Schema::jsString($r['type']);
                if (in_array($type, ['ingot', 'billet', 'scrap'], true)) {
                    $lot = $trx->insertNoReturn('material_lots', ['kind' => $type, 'alloy' => $r['alloy'] ?? null, 'owner_party_id' => $owner, 'description' => $r['item'] ?? null, 'created_by' => $userId]);
                    $add('material_lots', $lot);
                    $ow = $trx->insertNoReturn('opening_weights', ['item_type' => 'material_lot', 'item_id' => $lot, 'location_id' => $locId, 'kg' => $kg, 'unit_cost' => $unitCost, 'currency' => self::t($unitCost) ? 'TOMAN' : null, 'as_of' => $at->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d'), 'reason' => 'ورود گروهی', 'created_by' => $userId]);
                    $add('opening_weights', $ow);
                    Stock::move($trx, ['at' => $at, 'item_type' => 'material_lot', 'item_id' => $lot, 'from_location_id' => null, 'to_location_id' => $locId, 'kg' => $kg, 'state_to' => $type === 'scrap' ? 'scrap' : 'ingot', 'ref_type' => 'opening', 'ref_id' => $ow, 'unit_cost' => $unitCost, 'currency' => self::t($unitCost) ? 'TOMAN' : null, 'owner_party_id' => $owner, 'userId' => $userId]);
                } else {
                    $form = $type === 'raw' ? 'raw' : $type;
                    $b = $trx->insertNoReturn('bundles', ['code' => 'OPN-' . Schema::jsString($r['_row']), 'code_is_temp' => true, 'location_id' => $locId, 'weight_kg' => $kg, 'form' => $form, 'color' => $r['color'] ?? null, 'source' => 'opening', 'reported_at' => $at, 'warnings' => '[]', 'created_by' => $userId]);
                    $add('bundles', $b);
                    $trx->insertNoReturn('bundle_lines', ['bundle_id' => $b, 'product_id' => Schema::jsString($r['product_id'] ?? null), 'filler_mm' => $r['filler_mm'] ?? null, 'length_m' => $r['length_m'] ?? null, 'bars' => self::t($r['bars'] ?? null) ? (int) Schema::jsNumber($r['bars']) : null, 'weight_kg' => $kg, 'created_by' => $userId]);
                    $ow = $trx->insertNoReturn('opening_weights', ['item_type' => 'bundle', 'item_id' => $b, 'location_id' => $locId, 'kg' => $kg, 'unit_cost' => $unitCost, 'currency' => self::t($unitCost) ? 'TOMAN' : null, 'as_of' => $at->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d'), 'reason' => 'ورود گروهی', 'created_by' => $userId]);
                    $add('opening_weights', $ow);
                    Stock::move($trx, ['at' => $at, 'item_type' => 'bundle', 'item_id' => $b, 'from_location_id' => null, 'to_location_id' => $locId, 'kg' => $kg, 'state_to' => $form === 'raw' ? 'raw' : 'coated', 'ref_type' => 'opening', 'ref_id' => $ow, 'unit_cost' => $unitCost, 'currency' => self::t($unitCost) ? 'TOMAN' : null, 'userId' => $userId]);
                }
            } elseif ($kind === 'open_orders') {
                $at = self::at($r['date'] ?? null);
                $cur = Schema::jsString($r['currency'] ?? 'TOMAN');
                $o = $trx->insertNoReturn('orders', [
                    'number' => Numbering::next($trx, 'order', $at), 'party_id' => Schema::jsString($r['party_id'] ?? null), 'currency' => $cur, 'order_date' => $at->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d'),
                    'title' => self::t($r['old_number'] ?? null) ? 'شماره قدیم ' . Schema::jsString($r['old_number']) : null, 'status_sales' => 'approved', 'approved_by' => $userId, 'approved_at' => Db::raw('NOW(3)'), 'created_by' => $userId,
                ]);
                $add('orders', $o);
                $sort = 0;
                foreach (is_array($r['lines'] ?? null) ? $r['lines'] : [] as $l) {
                    $trx->insertNoReturn('order_lines', [
                        'order_id' => $o, 'kind' => self::t($l['product_id'] ?? null) ? 'profile' : 'service', 'product_id' => $l['product_id'] ?? null, 'description' => $l['description'] ?? null,
                        'qty_kg' => $l['qty_kg'] ?? null, 'calc_mode' => 'manual', 'price_basis' => 'per_kg', 'unit_price' => $r['price'] ?? null, 'currency' => $cur, 'sort' => $sort++, 'created_by' => $userId,
                    ]);
                }
                if (self::t($r['received'] ?? null) && !Decimal::of($r['received'])->isZero()) {
                    $d = $trx->insertNoReturn('documents', [
                        'number' => Numbering::next($trx, 'receipt'), 'kind' => 'receipt', 'party_id' => Schema::jsString($r['party_id'] ?? null), 'order_id' => $o, 'amount' => Schema::jsString($r['received']),
                        'currency' => $cur, 'method' => 'other', 'status' => 'posted', 'locked' => true, 'posted_by' => $userId, 'posted_at' => Db::raw('NOW(3)'),
                        'date' => gmdate('Y-m-d'), 'description' => 'دریافتی تا امروز (ورود گروهی)', 'created_by' => $userId,
                    ]);
                    $add('documents', $d);
                    $trx->insertNoReturn('allocations', ['from_document_id' => $d, 'order_id' => $o, 'amount' => Schema::jsString($r['received']), 'currency' => $cur, 'created_by' => $userId]);
                }
            }
        }
        return $created;
    }

    /** A JSON file for a spreadsheet kind: rows as arrays (first row = header) or as objects (keys = header). @return list<list<string>> */
    private static function jsonTable(mixed $v): array
    {
        if ($v instanceof JsonList) $v = [];
        if (!Json::isList($v)) throw new \DomainException('table expected');
        $cell = static fn ($c) => $c === null ? '' : (is_array($c) || $c instanceof \stdClass ? Json::encode($c) : Schema::jsString($c));
        $allLists = true;
        foreach ($v as $r) if (!Json::isList($r)) $allLists = false;
        if ($allLists) return array_map(static fn ($r) => array_map($cell, $r), $v);
        foreach ($v as $r) if (!(is_array($r) || $r instanceof \stdClass)) throw new \DomainException('table expected');
        $header = [];
        foreach ($v as $r) foreach (array_keys(Json::toArray($r)) as $k) $header[(string) $k] = true;
        $header = array_keys($header);
        $out = [array_map('strval', $header)];
        foreach ($v as $r) {
            $a = Json::toArray($r);
            $out[] = array_map(static fn ($h) => $cell($a[$h] ?? null), $header);
        }
        return $out;
    }

    private static function counts(array $created): array|\stdClass
    {
        $out = [];
        foreach ($created as $k => $v) $out[$k] = count($v);
        return $out ?: new \stdClass();
    }

    public static function register(Router $r, App $app): void
    {
        $sheetKind = static fn () => V::object(['kind' => V::enum(self::SHEET_KINDS)]);

        $r->get('/import/templates/:file', static function (Request $req) use ($sheetKind) {
            $file = $req->params['file'] ?? '';
            if (!str_ends_with($file, '.xlsx') || strlen($file) <= 5) throw new AppError('not_found');
            $req->requirePermission('settings.manage');
            ['kind' => $kind] = $sheetKind()->parse(['kind' => substr($file, 0, -5)]);
            $defs = self::FIELDS[$kind];
            $xlsx = Xlsx::buildXlsx([['name' => $kind, 'header' => array_map(static fn ($d) => $d['aliases'][0], $defs), 'rows' => [array_map(static fn ($d) => $d['sample'], $defs)]]]);
            return Response::raw($xlsx, Xlsx::MIME)->header('content-disposition', Xlsx::attachment("{$kind}.xlsx"));
        });
        $r->get('/import/fields/:kind', static function (Request $req) use ($sheetKind) {
            $req->requirePermission('settings.manage');
            ['kind' => $kind] = $sheetKind()->parse($req->params);
            return ['fields' => array_map(static fn ($d) => ['field' => $d['field'], 'label' => $d['aliases'][0], 'required' => !empty($d['required'])], self::FIELDS[$kind])];
        });

        // Preview (T54): parse, map, validate every row; nothing is written but the batch.
        $r->post('/import/preview', static function (Request $req) use ($app) {
            $me = $req->requirePermission('settings.manage');
            $body = V::object([
                'kind' => V::enum(self::IMPORT_KINDS),
                'file_id' => V::uuid()->optional(),
                'rows' => V::array(V::array(V::string()))->optional(),
                'json' => V::unknown()->optional(),
                'mapping' => V::record(V::string())->optional(),
                'note' => V::string()->max(500)->optional(),
            ])->parse($req->body());
            $kind = $body['kind'];
            $isJson = $kind === 'factor_app' || $kind === 'chatgpt';
            $raw = array_key_exists('rows', $body) && $body['rows'] !== null ? $body['rows'] : ($body['json'] ?? null);
            if ($raw instanceof Undef) $raw = null;
            $db = $app->db();
            if (!empty($body['file_id'])) {
                $f = $db->find('files', $body['file_id']);
                if (!$f) throw new AppError('not_found', 'فایل یافت نشد');
                // Only files uploaded as import material (POST /files, kind=import) are read here — never a photo or a document PDF.
                if ($f['kind'] !== 'import') throw new AppError('validation', 'این فایل برای ورود گروهی بارگذاری نشده است', ['file_id' => 'فایل ورود گروهی نیست']);
                $buf = $app->storage()->read($f['storage_key']);
                try {
                    $text = static fn () => (string) preg_replace('/^\x{FEFF}/u', '', $buf);
                    if ($f['mime'] === 'application/json') {
                        $parsed = Json::decode($text());
                        $raw = $isJson ? $parsed : self::jsonTable($parsed);
                    } elseif ($isJson) {
                        throw new \DomainException('json expected');
                    } elseif ($f['mime'] === 'text/csv') {
                        $raw = XlsxRead::readCsvRows($text());
                    } else {
                        $raw = XlsxRead::readXlsxRows($buf);
                    }
                } catch (\Throwable) {
                    throw new AppError('validation', $isJson ? 'فایل پشتیبان باید JSON معتبر باشد' : 'فایل خوانده نشد؛ XLSX یا CSV معتبر بفرستید', ['file_id' => 'فایل خوانده نشد']);
                }
            }
            if ($raw instanceof JsonList) $raw = [];
            if (!Schema::jsTruthy($raw)) throw new AppError('validation', 'فایل یا ردیف‌ها لازم است', ['file_id' => 'لازم است']);
            $prep = self::prepare($db, $kind, $raw, isset($body['mapping']) ? Json::toArray($body['mapping']) : null);
            $allErrors = $prep['errors'];
            foreach ($prep['duplicates'] as $d) $allErrors[] = $d + ['duplicate' => true];
            $id = $db->insertNoReturn('import_batches', [
                'kind' => $kind, 'file_id' => $body['file_id'] ?? null, 'status' => 'preview', 'rows' => Json::encode($prep['rows']), 'errors' => Json::encode($allErrors),
                'note' => $body['note'] ?? null, 'created_by' => $me->id,
            ]);
            return Response::json([
                'id' => $id, 'kind' => $kind, 'header' => $prep['header'], 'unmapped_required' => $prep['unmapped'], 'row_count' => count($prep['rows']),
                'rows' => array_slice($prep['rows'], 0, 500), 'errors' => $prep['errors'], 'duplicates' => $prep['duplicates'],
                'can_commit' => count($prep['errors']) === 0 && count($prep['unmapped']) === 0,
            ], 201);
        });

        // Commit in one transaction; rows with errors block the whole batch; duplicates are skipped unless skip_duplicates is false.
        $r->post('/import/:id/commit', static function (Request $req) use ($app) {
            $me = $req->requirePermission('settings.manage');
            ['id' => $id] = V::idParam()->parse($req->params);
            $key = Idempotency::requireKey($req);
            $body = V::object(['trial' => V::boolean()->default(false), 'skip_duplicates' => V::boolean()->default(true)])->parse(Daily::bodyOrEmpty($req));
            $res = Idempotency::run($app->db(), $key, $me->id, 'POST /import/commit', static function (Db $trx) use ($id, $body, $me) {
                $b = $trx->find('import_batches', $id, true);
                if (!$b) throw new AppError('not_found');
                if ($b['status'] !== 'preview') throw new AppError('validation', 'این دسته قبلاً وارد شده است');
                $errs = Json::isList($b['errors']) ? $b['errors'] : [];
                $bad = array_values(array_filter($errs, static fn ($e) => empty($e['duplicate'])));
                if ($bad) throw new AppError('validation', 'ردیف‌های خطادار را اصلاح کنید؛ هیچ ردیفی وارد نشد', ['errors' => (string) count($bad)]);
                $dupRows = [];
                foreach ($errs as $e) if (!empty($e['duplicate'])) $dupRows[Schema::jsString($e['row'])] = true;
                $rows = array_values(array_filter(Json::isList($b['rows']) ? $b['rows'] : [], static fn ($r) => !$body['skip_duplicates'] || !isset($dupRows[Schema::jsString($r['_row'] ?? null)])));
                $created = self::commit($trx, (string) $b['kind'], $rows, $me->id);
                $trx->update('import_batches', ['status' => 'committed', 'trial' => $body['trial'], 'created_ids' => Json::encode($created ?: new \stdClass())] + Db::bump(), 'id = ?', [$id]);
                $counts = self::counts($created);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'import_batches', 'entityId' => $id, 'action' => 'commit', 'after' => ['kind' => $b['kind'], 'created' => $counts, 'trial' => $body['trial']]]);
                return ['status' => 200, 'body' => ['id' => $id, 'created' => $counts, 'skipped_duplicates' => count($dupRows), 'trial' => $body['trial']]];
            });
            return $res['body'];
        });

        // Revert a trial import: delete what it created (fails cleanly if anything was used since).
        $r->post('/import/:id/revert', static function (Request $req) use ($app) {
            $me = $req->requirePermission('settings.manage');
            ['id' => $id] = V::idParam()->parse($req->params);
            return $app->db()->transaction(static function (Db $trx) use ($id, $me) {
                $b = $trx->find('import_batches', $id, true);
                if (!$b) throw new AppError('not_found');
                if ($b['status'] !== 'committed' || !$b['trial']) throw new AppError('validation', 'فقط ورود آزمایشی برگشت‌پذیر است');
                $created = Json::toArray($b['created_ids']);
                $order = ['allocations', 'documents', 'order_lines', 'orders', 'opening_weights', 'bundle_lines', 'bundles', 'material_lots', 'contracts', 'locations', 'parties', 'dies', 'product_fillers', 'products', 'free_notes'];
                $in = static fn (array $ids) => '(' . Db::placeholders($ids) . ')';
                try {
                    $t = $trx;
                    foreach ($order as $tb) {
                        $ids = is_array($created[$tb] ?? null) ? array_values($created[$tb]) : [];
                        if (!$ids) continue;
                        if ($tb === 'order_lines') {
                            $o = array_values($created['orders'] ?? []);
                            if ($o) $t->exec('DELETE FROM order_lines WHERE order_id IN ' . $in($o), $o);
                        } elseif ($tb === 'bundle_lines') {
                            $bs = array_values($created['bundles'] ?? []);
                            if ($bs) $t->exec('DELETE FROM bundle_lines WHERE bundle_id IN ' . $in($bs), $bs);
                        } elseif ($tb === 'allocations') {
                            $ds = array_values($created['documents'] ?? []);
                            if ($ds) $t->exec('DELETE FROM allocations WHERE from_document_id IN ' . $in($ds), $ds);
                        } elseif ($tb === 'bundles' || $tb === 'material_lots') {
                            // stock_moves is append-only: in PostgreSQL the failed DELETE aborts the transaction, so the revert fails.
                            if ($t->value("SELECT id FROM stock_moves WHERE item_id IN {$in($ids)} AND ref_type = 'opening' LIMIT 1", $ids) !== null) {
                                throw new \RuntimeException('current transaction is aborted, commands ignored until end of transaction block');
                            }
                            $t->exec("DELETE FROM {$tb} WHERE id IN " . $in($ids), $ids);
                        } else {
                            $t->exec('DELETE FROM ' . Db::ident($tb) . ' WHERE id IN ' . $in($ids), $ids);
                        }
                    }
                } catch (\Throwable $e) {
                    throw new AppError('validation', 'برگشت ممکن نیست؛ از رکوردهای واردشده استفاده شده است: ' . Xlsx::jsSlice($e->getMessage(), 0, 120));
                }
                $trx->update('import_batches', ['status' => 'reverted'] + Db::bump(), 'id = ?', [$id]);
                Audit::log($trx, ['userId' => $me->id, 'entity' => 'import_batches', 'entityId' => $id, 'action' => 'revert']);
                return ['ok' => true];
            });
        });

        $r->get('/import', static function (Request $req) use ($app) {
            $req->requirePermission('settings.manage');
            $rows = $app->db()->all(
                'SELECT import_batches.id, import_batches.kind, import_batches.status, import_batches.trial, import_batches.note, import_batches.created_at, users.short_name AS user_name,
                        JSON_LENGTH(import_batches.`rows`) AS row_count, JSON_LENGTH(import_batches.errors) AS error_count
                   FROM import_batches LEFT JOIN users ON users.id = import_batches.created_by ORDER BY import_batches.created_at DESC LIMIT 100',
            );
            foreach ($rows as &$x) {
                $x['row_count'] = $x['row_count'] === null ? null : (int) $x['row_count'];
                $x['error_count'] = $x['error_count'] === null ? null : (int) $x['error_count'];
            }
            unset($x);
            return ['items' => $rows];
        });
        $r->get('/import/:id', static function (Request $req) use ($app) {
            $req->requirePermission('settings.manage');
            ['id' => $id] = V::idParam()->parse($req->params);
            $b = $app->db()->find('import_batches', $id);
            if (!$b) throw new AppError('not_found');
            return $b;
        });
    }
}
