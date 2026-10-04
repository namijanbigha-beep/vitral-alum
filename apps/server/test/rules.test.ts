import { describe, expect, it } from 'vitest';
import { estimatedBarsForKg, estimatedLineKg, suggestedWeightPerMeter } from '../src/rules/index.js';

describe('T01 — R01 suggested weight per metre', () => {
  it('293 mm² → 791.1 g/m', () => {
    expect(suggestedWeightPerMeter('293')).toBe('791.1');
  });
  it('unknown area → null, never zero', () => {
    expect(suggestedWeightPerMeter(null)).toBeNull();
  });
});

describe('T02, T03 — R02 estimated line weight', () => {
  it('T02: 180 g × 6 m × 100 bars = 108.000 kg', () => {
    expect(estimatedLineKg('180', '6', '100')).toEqual({ kg: '108.000', estimate: true });
  });
  it('T03: 791 g × 6 m × 1 bar = 4.746 kg', () => {
    expect(estimatedLineKg('791', '6', '1')).toEqual({ kg: '4.746', estimate: true });
  });
  it('T03: 1,000 kg ≈ 210.7 bars, shown as 211', () => {
    expect(estimatedBarsForKg('1000', '791', '6')).toEqual({ exact: '210.7', display: '211', estimate: true });
  });
  it('unknown input → null', () => {
    expect(estimatedLineKg(null, '6', '100')).toBeNull();
    expect(estimatedBarsForKg('1000', '0', '6')).toBeNull();
  });
});
