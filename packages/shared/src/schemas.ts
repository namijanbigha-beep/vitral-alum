import { z } from 'zod';
import { PERMISSIONS, ROLES } from './permissions.js';
import { parseNumber } from './number.js';
import { toLatinDigits } from './number.js';

/** Mobile is the login id. Accepts any digit script; normalized to 09xxxxxxxxx. */
export const mobileSchema = z
  .string()
  .transform((v) => toLatinDigits(v).replace(/[\s-]/g, '').replace(/^\+98/, '0').replace(/^0098/, '0'))
  .refine((v) => /^09\d{9}$/.test(v), { message: 'شماره موبایل باید ۱۱ رقم و با ۰۹ شروع شود' });

export const passwordSchema = z.string().min(8, 'رمز باید حداقل ۸ نویسه باشد').max(200);

export const loginSchema = z.object({ mobile: mobileSchema, password: z.string().min(1).max(200) });

export const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: passwordSchema,
});

export const permissionSchema = z.enum(PERMISSIONS);
export const roleSchema = z.enum(ROLES);

export const userCreateSchema = z.object({
  mobile: mobileSchema,
  name: z.string().trim().min(1, 'نام لازم است').max(120),
  short_name: z.string().trim().max(40).nullable().optional(),
  password: passwordSchema,
  role: roleSchema,
  permissions: z.array(permissionSchema).default([]),
});

export const userUpdateSchema = z.object({
  version: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(120).optional(),
  short_name: z.string().trim().max(40).nullable().optional(),
  role: roleSchema.optional(),
  permissions: z.array(permissionSchema).optional(),
  active: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
});

export const userResetPasswordSchema = z.object({ version: z.number().int().nonnegative(), new_password: passwordSchema });

/** Decimal fields travel as strings; Persian/Arabic digits are accepted (R20). */
export const decimalString = z
  .string()
  .transform((v, ctx) => {
    const n = parseNumber(v);
    if (n === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'عدد نامعتبر است' });
      return z.NEVER;
    }
    return n;
  });

export const settingUpdateSchema = z.object({
  version: z.number().int().nonnegative(),
  value: z.unknown(),
  reason: z.string().trim().max(500).optional(),
});

export const DOCUMENT_KINDS_FOR_NUMBERING = [
  'proforma',
  'order',
  'invoice',
  'sales_return',
  'purchase',
  'toll_fee',
  'expense',
  'receipt',
  'payment',
  'barter',
  'opening_balance',
  'fx_difference',
  'production_run',
  'coating_run',
  'transfer',
  'die_order',
] as const;
export type NumberingKind = (typeof DOCUMENT_KINDS_FOR_NUMBERING)[number];

export const FILE_KINDS = [
  'product',
  'section',
  'color_sample',
  'drawing',
  'die',
  'bundle',
  'label',
  'load',
  'vehicle',
  'package',
  'waybill',
  'scale_ticket',
  'receipt',
  'delivery_receipt',
  'voice',
  'document_pdf',
  'other',
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const ALLOWED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
] as const;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const ERROR_CODES = [
  'validation',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'insufficient_stock',
  'over_allocation',
  'locked',
  'rate_limited',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiError {
  error: { code: ErrorCode; message: string; fields?: Record<string, string>; current?: unknown };
}
