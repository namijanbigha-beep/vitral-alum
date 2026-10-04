import { formatJalali, jalaliOf, toPersianDigits, zonedParts } from '@vitral/shared';

export const fa = (s: string | number): string => toPersianDigits(String(s));

export function faDateTime(iso: string | null | undefined): string {
  if (!iso) return 'نامشخص';
  const d = new Date(iso);
  const p = zonedParts(d);
  return fa(`${formatJalali(jalaliOf(d))} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`);
}

export function faDate(iso: string | null | undefined): string {
  if (!iso) return 'نامشخص';
  return fa(formatJalali(jalaliOf(new Date(iso))));
}
