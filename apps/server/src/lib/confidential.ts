import { isConfidentialKey } from '@vitral/shared';

/** Paths of every confidential key anywhere in a JSON value. */
export function findConfidentialKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findConfidentialKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
      const p = path ? `${path}.${k}` : k;
      return isConfidentialKey(k) ? [p, ...findConfidentialKeys(v, p)] : findConfidentialKeys(v, p);
    });
  }
  return [];
}

/** Deep copy of a JSON value with every confidential key removed. */
export function stripConfidential(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripConfidential);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!isConfidentialKey(k)) out[k] = stripConfidential(v);
    }
    return out;
  }
  return value;
}
