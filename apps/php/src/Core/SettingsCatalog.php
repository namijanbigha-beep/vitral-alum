<?php
declare(strict_types=1);

namespace Vitral\Core;

use Vitral\Lib\Decimal;

/** Port of apps/server/src/modules/settings/catalog.ts: every editable setting with its label and schema. */
final class SettingsCatalog
{
    public const TRANSFER_KINDS = ['ingot_in', 'to_production', 'raw_delivery', 'to_coating', 'from_coating', 'between_locations', 'to_customer', 'customer_return', 'scrap_out', 'scrap_in', 'die_move', 'general'];
    public const TRANSFER_DOCUMENTS = ['load_photo', 'vehicle_photo', 'waybill', 'scale_ticket', 'delivery_receipt', 'packing_list'];

    /** @var array<string,array{label:string,schema:Schema,finance?:bool,readonly?:bool}>|null */
    private static ?array $catalog = null;

    /** @return array<string,array{label:string,schema:Schema,finance?:bool,readonly?:bool}> */
    public static function all(): array
    {
        return self::$catalog ??= self::build();
    }

    /** @return array{label:string,schema:Schema,finance?:bool,readonly?:bool}|null */
    public static function def(string $key): ?array
    {
        return self::all()[$key] ?? null;
    }

    private static function build(): array
    {
        $text = static fn (int $max = 500) => V::string()->trim()->max($max)->nullable();
        $percent = V::decimalString()->refine(
            static fn (string $v) => Decimal::of($v)->gte(0) && Decimal::of($v)->lte(100),
            'درصد باید بین ۰ و ۱۰۰ باشد',
        );
        $pattern = V::string()->trim()->min(1)->max(40)
            ->refine(static fn (string $v) => (bool) preg_match('/\{seq(:\d)?\}/', $v), 'الگو باید {seq} داشته باشد')
            ->refine(static fn (string $v) => (bool) preg_match('/^[A-Za-z0-9\-_\/{}:]+$/', $v), 'فقط حروف لاتین، عدد و - _ / مجاز است');
        $gainRange = V::object(['min' => V::decimalString(), 'max' => V::decimalString()])
            ->refine(static fn (array $r) => Decimal::of($r['min'])->lte($r['max']), 'کمینه باید از بیشینه کوچک‌تر باشد')
            ->nullable();
        $stringList = static fn (int $maxItems) => V::array(V::string()->trim()->min(1)->max(60))->max($maxItems);

        return [
            'seller_name_fa' => ['label' => 'نام فروشنده (فارسی)', 'schema' => $text(200)],
            'seller_name_ar' => ['label' => 'نام فروشنده (عربی)', 'schema' => $text(200)],
            'seller_name_en' => ['label' => 'نام فروشنده (انگلیسی)', 'schema' => $text(200)],
            'seller_address_fa' => ['label' => 'نشانی (فارسی)', 'schema' => $text()],
            'seller_address_ar' => ['label' => 'نشانی (عربی)', 'schema' => $text()],
            'seller_address_en' => ['label' => 'نشانی (انگلیسی)', 'schema' => $text()],
            'seller_phone' => ['label' => 'تلفن', 'schema' => $text(100)],
            'seller_logo_file_id' => ['label' => 'لوگو', 'schema' => V::string()->uuid()->nullable()],
            'default_paint_rate_per_kg' => [
                'label' => 'نرخ پیش‌فرض رنگ هر کیلو',
                'finance' => true,
                'schema' => V::object(['amount' => V::decimalString(), 'currency' => V::enum(\Vitral\Lib\Num::CURRENCIES)])->nullable(),
            ],
            'weight_per_meter_tolerance_percent' => ['label' => 'آستانه اختلاف وزن هر متر (٪)', 'schema' => $percent->nullable()],
            'bundle_weight_median_threshold_percent' => ['label' => 'آستانه وزن بندیل نسبت به میانه (٪)', 'schema' => $percent->nullable()],
            'production_balance_threshold_percent' => ['label' => 'آستانه تراز نوبت تولید (٪)', 'schema' => $percent->nullable()],
            'coating_gain_range_percent' => ['label' => 'بازه طبیعی افزایش وزن رنگ (٪)', 'schema' => $gainRange],
            'anodize_gain_range_percent' => ['label' => 'بازه طبیعی افزایش وزن آنادایز (٪)', 'schema' => $gainRange],
            'transfer_document_policy' => [
                'label' => 'سیاست مدارک هر نوع بار',
                'schema' => V::record(
                    V::enum(self::TRANSFER_KINDS),
                    V::array(V::enum(self::TRANSFER_DOCUMENTS))->max(count(self::TRANSFER_DOCUMENTS))
                        ->refine(static fn (array $a) => count(array_unique($a)) === count($a), 'مدرک تکراری است'),
                ),
            ],
            'default_prepay_percent' => ['label' => 'درصد پیش‌پرداخت پیش‌فرض', 'schema' => $percent->nullable()],
            'default_delivery_days' => ['label' => 'روزهای تحویل پیش‌فرض', 'schema' => V::int()->min(0)->max(365)->nullable()],
            'proforma_validity_text' => ['label' => 'متن اعتبار پیش‌فاکتور', 'schema' => $text(2000)],
            'sales_terms_fa' => ['label' => 'شرایط فروش (فارسی)', 'schema' => $text(5000)],
            'sales_terms_ar' => ['label' => 'شرایط فروش (عربی)', 'schema' => $text(5000)],
            'numbering_patterns' => ['label' => 'الگوی شماره هر نوع سند', 'schema' => V::record(V::string()->max(40), $pattern)],
            'default_numbering_pattern' => ['label' => 'الگوی پیش‌فرض شماره سند', 'schema' => $pattern],
            'time_zone' => [
                'label' => 'منطقه زمانی',
                'schema' => V::string()->refine(static function (string $tz) {
                    try {
                        new \DateTimeZone($tz);
                        return !preg_match('/^[+-]/', $tz);
                    } catch (\Throwable) {
                        return false;
                    }
                }, 'منطقه زمانی نامعتبر است'),
            ],
            'share_link_days' => ['label' => 'مدت اعتبار لینک اشتراک (روز)', 'schema' => V::int()->min(1)->max(365)],
            'error_contact_name' => ['label' => 'مسئول رسیدگی به خطا', 'schema' => $text(200)],
            'error_contact_channel' => ['label' => 'راه تماس مسئول خطا', 'schema' => $text(200)],
            'product_categories' => ['label' => 'دسته‌های محصول', 'schema' => $stringList(50)],
            'sample_colors' => ['label' => 'رنگ‌ها', 'schema' => $stringList(200)],
            'load_type_labels' => ['label' => 'انواع بار', 'schema' => $stringList(20)],
            'restore_test_log' => ['label' => 'سابقه آزمون بازیابی', 'schema' => V::array(V::unknown()), 'readonly' => true],
        ];
    }
}
