import { describe, expect, it } from 'vitest';
import { applyScenario, describeScenario, isNoChange, NO_CHANGE } from './scenario';
import { prepare } from './simulate';
import { sizeRange, sweep } from './sweep';
import { demoYear } from '../data/demo';

const samples = [
  { t: 0, house: 1, solar: 3, ev: 0 },
  { t: 3600_000, house: 2, solar: 0, ev: 7 },
];

describe('applyScenario', () => {
  it('returns the original array when nothing changes', () => {
    expect(applyScenario(samples, NO_CHANGE)).toBe(samples);
    expect(isNoChange({ householdPct: 0, evPct: 0 })).toBe(true);
  });

  it('scales household and EV independently and leaves solar alone', () => {
    const out = applyScenario(samples, { householdPct: 50, evPct: -100 });
    expect(out[1]).toEqual({ t: 3600_000, house: 3, solar: 0, ev: 0 });
    expect(out[0].solar).toBe(3);
    expect(samples[1].house).toBe(2); // input untouched
  });

  it('never goes negative', () => {
    expect(applyScenario(samples, { householdPct: -150, evPct: 0 })[0].house).toBe(0);
  });

  it('describes the change', () => {
    expect(describeScenario({ householdPct: 20, evPct: -50 })).toBe('household use +20 %, EV charging −50 %');
    expect(describeScenario({ householdPct: 0, evPct: 100 })).toBe('EV charging +100 %');
  });

  it('more household use means more value from a battery', () => {
    const run = (pct: number) => {
      const data = prepare(applyScenario(demoYear(2024), { householdPct: pct, evPct: 0 }));
      const rec = sweep(
        data,
        { usableFraction: 0.95, inverterKw: 5, cRate: 0.5, roundTripEfficiency: 0.9 },
        sizeRange(10, 5),
        { importFlat: 0.3, useTimeOfUse: false, importPeak: 0, importOffPeak: 0, peakStartHour: 7, peakEndHour: 23, exportPrice: 0.08 },
        { evMode: 'exclude', gridCharge: false, gridChargeTarget: 1 },
        { costPerKwh: 400, fixedCost: 1500, lifetimeYears: 12, degradationPerYear: 0.02 },
      );
      return rec.rows.find((r) => r.nominalKwh === 10)!.annualSavings;
    };
    expect(run(50)).toBeGreaterThan(run(0));
    expect(run(0)).toBeGreaterThan(run(-50));
  });
});
