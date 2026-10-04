import type { ErrorCode } from '@vitral/shared';

const STATUS: Record<ErrorCode, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  insufficient_stock: 409,
  over_allocation: 409,
  locked: 423,
  rate_limited: 429,
};

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  validation: 'اطلاعات واردشده درست نیست',
  unauthorized: 'لطفاً دوباره وارد شوید',
  forbidden: 'اجازه این کار را ندارید',
  not_found: 'پیدا نشد',
  conflict: 'این رکورد را شخص دیگری تغییر داده؛ بازخوانی کنید',
  insufficient_stock: 'موجودی کافی نیست',
  over_allocation: 'جمع تخصیص از مبلغ سند بیشتر است',
  locked: 'حساب موقتاً قفل است؛ بعداً تلاش کنید',
  rate_limited: 'درخواست‌ها زیاد است؛ کمی بعد تلاش کنید',
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly fields?: Record<string, string>,
    readonly current?: unknown,
  ) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.status = STATUS[code];
  }
}

export const notFound = (): AppError => new AppError('not_found');
export const forbidden = (): AppError => new AppError('forbidden');
