import { Dec, round, type DecimalInput } from '@vitral/shared';

/** Default aluminium density, g/cm³. */
export const DEFAULT_DENSITY = '2.7';

/**
 * R01 — suggested weight per metre (g/m) = section area (mm²) × density (g/cm³).
 * (mm² × 1 m = 1000 mm³ per mm² = 1 cm³ per mm² … ×1000/1000, so the numbers multiply directly.)
 * A suggestion only; the reference is the approved filler value. Unknown area → null.
 */
export function suggestedWeightPerMeter(
  sectionAreaMm2: DecimalInput | null,
  density: DecimalInput = DEFAULT_DENSITY,
): string | null {
  if (sectionAreaMm2 === null) return null;
  return round(new Dec(sectionAreaMm2).mul(density), 'g_per_m');
}

/** R02 — estimated line weight (kg) = g/m × length (m) × bars ÷ 1000. Always labelled «تخمینی». */
export function estimatedLineKg(
  gramsPerMeter: DecimalInput | null,
  lengthM: DecimalInput | null,
  bars: DecimalInput | null,
): { kg: string; estimate: true } | null {
  if (gramsPerMeter === null || lengthM === null || bars === null) return null;
  const kg = new Dec(gramsPerMeter).mul(lengthM).mul(bars).div(1000);
  return { kg: round(kg, 'weight'), estimate: true };
}

/**
 * R02 inverse — bars needed for a weight. `exact` to one place, `display` rounded half-up to a whole bar,
 * both approximate. Zero or unknown weight per bar → null.
 */
export function estimatedBarsForKg(
  kg: DecimalInput | null,
  gramsPerMeter: DecimalInput | null,
  lengthM: DecimalInput | null,
): { exact: string; display: string; estimate: true } | null {
  if (kg === null || gramsPerMeter === null || lengthM === null) return null;
  const perBarKg = new Dec(gramsPerMeter).mul(lengthM).div(1000);
  if (perBarKg.isZero()) return null;
  const bars = new Dec(kg).div(perBarKg);
  return {
    exact: bars.toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1),
    display: bars.toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0),
    estimate: true,
  };
}
