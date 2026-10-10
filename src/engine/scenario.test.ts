import { describe, expect, it } from 'vitest';
import { applyScenario, describeScenario, isNoChange, NO_CHANGE, shiftEvToSolar, shiftWaterHeater, type EvSolarOptions } from './scenario';
import type { HourSample } from './types';
import { prepare, simulate } from './simulate';
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
    expect(out[1]).toEqual({ t: 3600_000, house: 3, solar: 0, ev: 0, wh: 0 });
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
        { costPerKwh: 400, fixedCost: 1500, horizonYears: 12, calendarLossPerYear: 0.01, cycleLife: 6000, replacementFraction: 0.7, discountRate: 0 },
      );
      return rec.rows.find((r) => r.nominalKwh === 10)!.annualSavings;
    };
    expect(run(50)).toBeGreaterThan(run(0));
    expect(run(0)).toBeGreaterThan(run(-50));
  });
});

describe('shiftWaterHeater', () => {
  const H = 3600_000;
  const base = new Date(2025, 5, 1, 0).getTime();
  const day = (solarAt: Record<number, number>, whAt: Record<number, number>) =>
    Array.from({ length: 24 }, (_, h) => ({ t: base + h * H, house: 0.3, ev: 0, solar: solarAt[h] ?? 0, wh: whAt[h] ?? 0 }));

  it('moves night heating into surplus hours, respecting power, keeping daily energy', () => {
    const out = shiftWaterHeater(day({ 11: 2.3, 12: 2.3, 13: 0.8 }, { 2: 1.5, 3: 1.5 }), 1);
    expect(out[11].wh).toBeCloseTo(1); // capped at 1 kW
    expect(out[12].wh).toBeCloseTo(1);
    expect(out[13].wh).toBeCloseTo(0.5); // surplus 0.8 − 0.3 house
    expect(out[2].wh! + out[3].wh!).toBeCloseTo(0.5); // remainder keeps original timing
    expect(out[2].wh).toBeCloseTo(out[3].wh!);
    expect(out.reduce((a, s) => a + s.wh!, 0)).toBeCloseTo(3);
  });

  it('leaves data without a water heater untouched', () => {
    const s = day({ 12: 3 }, {});
    expect(shiftWaterHeater(s, 2)).toBe(s);
  });

  it('applyScenario scales the water heater with household use', () => {
    expect(applyScenario([{ t: 0, house: 1, ev: 0, solar: 0, wh: 2 }], { householdPct: 50, evPct: 0 })[0].wh).toBe(3);
  });
});

describe('water heater shifting on the demo year', () => {
  it('lowers the no-battery bill and never increases grid import', () => {
    const tariff = { importFlat: 0.3, useTimeOfUse: false, importPeak: 0, importOffPeak: 0, peakStartHour: 7, peakEndHour: 23, exportPrice: 0.08 };
    const spec = { nominalKwh: 0, usableFraction: 1, inverterKw: 5, cRate: 0.5, roundTripEfficiency: 0.9 };
    const opts = { evMode: 'exclude' as const, gridCharge: false, gridChargeTarget: 1 };
    const measured = demoYear(2024);
    const before = simulate(prepare(measured), spec, tariff, opts);
    const after = simulate(prepare(shiftWaterHeater(measured, 1)), spec, tariff, opts);
    expect(after.totalLoadKwh).toBeCloseTo(before.totalLoadKwh, 6);
    expect(after.importKwh).toBeLessThan(before.importKwh);
    expect(after.netCost).toBeLessThan(before.netCost);
  });
});

describe('shiftEvToSolar', () => {
  // Two days from Monday 1 Sep 2025, local time: 4 kW surplus 10:00–15:00, 7 kWh charged at 20:00 each day.
  const t0 = new Date(2025, 8, 1, 0).getTime();
  const days = (n: number, solarKw = 4.5): HourSample[] =>
    Array.from({ length: n * 24 }, (_, i) => {
      const h = i % 24;
      return { t: t0 + i * 3600_000, house: 0.5, ev: h === 20 ? 7 : 0, solar: h >= 10 && h < 15 ? solarKw : 0 };
    });
  const opts: EvSolarOptions = { minKw: 1.4, maxKw: 11, bufferKwh: 20, awayDays: [], awayFrom: 9, awayTo: 17 };
  const at = (xs: HourSample[], day: number, hour: number) => xs[day * 24 + hour];
  const total = (xs: HourSample[]) => xs.reduce((a, s) => a + s.ev, 0);

  it('charges from midday surplus and no longer from the grid in the evening', () => {
    const out = shiftEvToSolar(days(2), opts);
    expect(at(out, 0, 10).ev).toBeCloseTo(4); // surplus 4.5 − 0.5 house
    expect(at(out, 0, 20).ev).toBeCloseTo(0); // covered by what solar put in the car
    expect(at(out, 1, 20).ev).toBeCloseTo(0);
    // Never more than the room in the car ahead of need; total energy only grows by what's left banked.
    const banked = total(out) - total(days(2));
    expect(banked).toBeGreaterThanOrEqual(0);
    expect(banked).toBeLessThanOrEqual(20 + 1e-9);
  });

  it('waits for the charger minimum and for the car to be home', () => {
    const small = days(1, 3.5); // 3 kW surplus
    expect(at(shiftEvToSolar(small, { ...opts, minKw: 4.1 }), 0, 20).ev).toBeCloseTo(7); // three-phase only: no solar charging
    expect(at(shiftEvToSolar(small, opts), 0, 20).ev).toBeCloseTo(0); // one phase: 5 × 3 kW banked
    const away = shiftEvToSolar(days(1), { ...opts, awayDays: [1] }); // Monday, 9–17
    expect(at(away, 0, 12).ev).toBe(0);
    expect(at(away, 0, 20).ev).toBeCloseTo(7);
  });

  it('leaves data without EV charging alone', () => {
    const none = days(1).map((s) => ({ ...s, ev: 0 }));
    expect(shiftEvToSolar(none, opts)).toBe(none);
  });
});
