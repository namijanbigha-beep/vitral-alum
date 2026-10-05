<?php
declare(strict_types=1);

namespace Vitral\Core;

/**
 * Port of apps/server/src/lib/errors.ts. Rendered as
 * {"error":{"code":…,"message":…,"fields"?:{…},"current"?:…}} with the status of the code.
 */
final class AppError extends \RuntimeException
{
    public const STATUS = [
        'validation' => 400,
        'unauthorized' => 401,
        'forbidden' => 403,
        'not_found' => 404,
        'conflict' => 409,
        'insufficient_stock' => 409,
        'over_allocation' => 409,
        'locked' => 423,
        'rate_limited' => 429,
    ];

    public const DEFAULT_MESSAGE = [
        'validation' => 'اطلاعات واردشده درست نیست',
        'unauthorized' => 'لطفاً دوباره وارد شوید',
        'forbidden' => 'اجازه این کار را ندارید',
        'not_found' => 'پیدا نشد',
        'conflict' => 'این رکورد را شخص دیگری تغییر داده؛ بازخوانی کنید',
        'insufficient_stock' => 'موجودی کافی نیست',
        'over_allocation' => 'جمع تخصیص از مبلغ سند بیشتر است',
        'locked' => 'حساب موقتاً قفل است؛ بعداً تلاش کنید',
        'rate_limited' => 'درخواست‌ها زیاد است؛ کمی بعد تلاش کنید',
    ];

    public readonly int $status;
    /** Distinguishes «no current record» from a current record that is null. */
    public readonly bool $hasCurrent;

    /**
     * @param array<string,string>|null $fields
     */
    public function __construct(
        public readonly string $errorCode,
        ?string $message = null,
        public readonly ?array $fields = null,
        public readonly mixed $current = null,
        bool $hasCurrent = false,
    ) {
        if (!isset(self::STATUS[$errorCode])) throw new \InvalidArgumentException("unknown error code {$errorCode}");
        parent::__construct($message ?? self::DEFAULT_MESSAGE[$errorCode]);
        $this->status = self::STATUS[$errorCode];
        $this->hasCurrent = $hasCurrent || $current !== null;
    }

    public static function notFound(): self { return new self('not_found'); }
    public static function forbidden(): self { return new self('forbidden'); }
    public static function unauthorized(): self { return new self('unauthorized'); }

    /** 409 carrying the fresh record (principle 5). */
    public static function conflict(mixed $current, ?string $message = null): self
    {
        return new self('conflict', $message, null, $current, true);
    }

    /** 400 with one field message. */
    public static function validation(string $message, ?array $fields = null): self
    {
        return new self('validation', $message, $fields);
    }

    /** @return array{error: array<string,mixed>} */
    public function body(): array
    {
        $e = ['code' => $this->errorCode, 'message' => $this->getMessage()];
        if ($this->fields) $e['fields'] = $this->fields;
        if ($this->hasCurrent) $e['current'] = $this->current;
        return ['error' => $e];
    }
}
