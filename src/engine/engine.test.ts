import { describe, expect, it } from 'vitest';
import { createTrace, prepare, simulate, isPeakHour } from './simulate';
import { END_OF_LIFE, fadePerYear, lifecycle, sizeRange, sweep } from './sweep';
import type { BatterySpec, HourSample, SimOptions, Tariff } from './types';
import { demoYear } from '../data/demo';

const H = 3600 * 1000;
const base = new Date(2025, 5, 1, 0).getTime();

function hours(rows: [house: number, solar: number, ev?: number][]): HourSample[] {
  return rows.map(([house, solar, ev = 0], i) => ({ t: base + i * H, house, solar, ev }));
}

const flat: Tariff = {
  importFlat: 0.3,
  useTimeOfUse: false,
  importPeak: 0.4,
  importOffPeak: 0.15,
  peakStartHour: 7,
  peakEndHour: 23,
  exportPrice: 0.05,
};
const opts: SimOptions = { evMode: 'exclude', gridCharge: false, gridChargeTarget: 1 };
const ideal: BatterySpec = { nominalKwh: 10, usableFraction: 1, inverterKw: 100, cRate: 100, roundTripEfficiency: 1 };

describe('simulate', () => {
  it('with no battery, imports deficits and exports surpluses', () => {
    const r = simulate(prepare(hours([[1, 3], [2, 0]])), { ...ideal, nominalKwh: 0 }, flat, opts);
    expect(r.exportKwh).toBeCloseTo(2);
    expect(r.importKwh).toBeCloseTo(2);
    expect(r.netCost).toBeCloseTo(2 * 0.3 - 2 * 0.05);
  });

  it('shifts surplus solar into the evening', () => {
    const r = simulate(prepare(hours([[1, 3], [2, 0]])), ideal, flat, opts);
    expect(r.exportKwh).toBeCloseTo(0);
    expect(r.importKwh).toBeCloseTo(0);
    expect(r.selfSufficiency).toBeCloseTo(1);
  });

  it('conserves energy: load = solar − export + import − losses', () => {
    const data = prepare(demoYear(2024));
    const spec = { ...ideal, roundTripEfficiency: 0.9, cRate: 0.5, inverterKw: 5 };
    const r = simulate(data, spec, flat, opts);
    const losses = r.chargedFromSolarKwh - r.dischargedKwh; // includes energy left in the battery at the end
    expect(r.totalLoadKwh).toBeCloseTo(r.solarKwh - r.exportKwh + r.importKwh - losses, 3);
  });

  it('respects capacity, power and efficiency limits', () => {
    const spec = { ...ideal, nominalKwh: 4, inverterKw: 2, roundTripEfficiency: 0.81 };
    const r = simulate(prepare(hours([[0, 10], [0, 10], [0, 10], [5, 0], [5, 0]])), spec, flat, opts);
    // Charges 2 kW/h (power limit) → 1.8 kWh stored per hour, full after ~2.2 h → 4 kWh stored.
    expect(r.chargedFromSolarKwh).toBeCloseTo(4 / 0.9);
    // Discharges at most 2 kWh/h, battery holds 4 kWh → 3.6 kWh delivered.
    expect(r.dischargedKwh).toBeCloseTo(3.6);
    expect(r.importKwh).toBeCloseTo(10 - 3.6);
  });

  it('does not discharge into the EV in exclude mode', () => {
    const data = prepare(hours([[0, 5], [0, 0, 7]]));
    const ex = simulate(data, ideal, flat, { ...opts, evMode: 'exclude' });
    const inc = simulate(data, ideal, flat, { ...opts, evMode: 'include' });
    expect(ex.dischargedKwh).toBe(0);
    expect(ex.importKwh).toBeCloseTo(7);
    expect(inc.dischargedKwh).toBeCloseTo(5);
    expect(inc.importKwh).toBeCloseTo(2);
  });

  it('gives solar to the EV before charging the battery', () => {
    const r = simulate(prepare(hours([[0, 5, 3]])), ideal, flat, opts);
    expect(r.chargedFromSolarKwh).toBeCloseTo(2);
  });

  it('grid-charges off-peak and holds the battery for peak hours', () => {
    const tou: Tariff = { ...flat, useTimeOfUse: true, peakStartHour: 2, peakEndHour: 4 };
    // hours 0–1 off-peak with load, 2–3 peak with load
    const data = prepare(hours([[1, 0], [1, 0], [3, 0], [3, 0]]));
    const r = simulate(data, { ...ideal, nominalKwh: 6 }, tou, { ...opts, gridCharge: true, gridChargeTarget: 1 });
    expect(r.chargedFromGridKwh).toBeCloseTo(6);
    expect(r.dischargedKwh).toBeCloseTo(6);
    // Off-peak load + grid charge imported at 0.15; nothing imported at peak.
    expect(r.importCost).toBeCloseTo((2 + 6) * 0.15);
  });

  it('counts full and empty days', () => {
    const day = Array.from({ length: 24 }, (_, h) => [h >= 18 ? 3 : 0, h >= 10 && h < 14 ? 5 : 0] as [number, number]);
    const r = simulate(prepare(hours([...day, ...day])), { ...ideal, nominalKwh: 5 }, flat, opts);
    expect(r.days).toBe(2);
    expect(r.daysFull).toBe(2);
    expect(r.daysEmpty).toBe(2);
  });
});

describe('tariff windows', () => {
  it('handles windows that wrap midnight', () => {
    const t = { ...flat, peakStartHour: 22, peakEndHour: 6 };
    expect(isPeakHour(23, t)).toBe(true);
    expect(isPeakHour(3, t)).toBe(true);
    expect(isPeakHour(12, t)).toBe(false);
  });
});

const econ = { costPerKwh: 400, fixedCost: 1500, horizonYears: 12, calendarLossPerYear: 0.01, cycleLife: 6000, replacementFraction: 0.7, discountRate: 0 };

describe('sweep', () => {
  const template = { usableFraction: 0.95, inverterKw: 5, cRate: 0.5, roundTripEfficiency: 0.9 };

  it('has diminishing returns and picks a size inside the range', () => {
    const data = prepare(demoYear(2024));
    const rec = sweep(data, template, sizeRange(20, 1), { ...flat, exportPrice: 0.05 }, opts, econ);
    expect(rec.annualFactor).toBeCloseTo(8760 / (365 * 24));
    const savings = rec.rows.map((r) => r.annualSavings);
    for (let i = 1; i < savings.length; i++) expect(savings[i]).toBeGreaterThanOrEqual(savings[i - 1] - 1e-6);
    const marginalFirst = savings[2] - savings[1];
    const marginalLast = savings[savings.length - 1] - savings[savings.length - 2];
    expect(marginalLast).toBeLessThan(marginalFirst);
    expect(rec.knee).not.toBeNull();
    expect(rec.knee!.nominalKwh).toBeGreaterThan(0);
    expect(rec.knee!.nominalKwh).toBeLessThan(20);
  });

  it('returns no best size when the battery cannot pay for itself', () => {
    const data = prepare(demoYear(2024));
    const rec = sweep(data, template, sizeRange(10, 2), flat, opts, { ...econ, costPerKwh: 5000 });
    expect(rec.best).toBeNull();
  });

  it('lets a bigger battery cycle less and last longer', () => {
    const rec = sweep(prepare(demoYear(2024)), template, sizeRange(20, 2), { ...flat, exportPrice: 0.05 }, opts, econ);
    const sized = rec.rows.filter((r) => r.nominalKwh > 0);
    for (let i = 1; i < sized.length; i++) {
      expect(sized[i].annual.cycles).toBeLessThanOrEqual(sized[i - 1].annual.cycles + 1e-6);
      expect(sized[i].lifeYears).toBeGreaterThanOrEqual(sized[i - 1].lifeYears - 1e-6);
    }
    expect(sized[sized.length - 1].lifeYears).toBeLessThanOrEqual(30); // 1 %/year ageing caps it at 30 years
    for (const r of sized) expect(r.netBenefit).toBeCloseTo(r.lifetimeSavings - r.investment - r.replacementCost + r.residualValue, 6);
  });

  it('always includes a zero-size baseline', () => {
    const rec = sweep(prepare(hours([[1, 2]])), template, [5, 10], flat, opts, econ);
    expect(rec.rows[0].nominalKwh).toBe(0);
    expect(rec.baseline.annualSavings).toBe(0);
  });
});

describe('helpers', () => {
  it('wears a battery by age plus cycles', () => {
    // 1 %/year ageing + 300 cycles of a 6,000-cycle (to 70 %) rating = 2.5 %/year → 12 years to 70 %.
    expect(fadePerYear(300, econ)).toBeCloseTo(0.025);
    expect(END_OF_LIFE).toBe(0.7);
  });

  it('replaces worn batteries within the horizon and credits the life left', () => {
    const rows = [
      { nominalKwh: 0, annualSavings: 0 },
      { nominalKwh: 5, annualSavings: 500 },
      { nominalKwh: 10, annualSavings: 700 },
    ];
    const row = { nominalKwh: 10, investment: 5500, annual: { cycles: 300 } as never };
    const over30 = lifecycle(row, rows, { ...econ, horizonYears: 30 });
    expect(over30.lifeYears).toBeCloseTo(12);
    expect(over30.replacements).toBe(2); // in years 12 and 24
    expect(over30.replacementCost).toBeCloseTo(2 * 0.7 * 5500);
    expect(over30.residualValue).toBeCloseTo(0.7 * 5500 * 0.5); // 6 of 12 years left
    // A worn 10 kWh battery saves what a smaller new one would: between the 5 and 10 kWh savings.
    expect(over30.lifetimeSavings).toBeLessThan(30 * 700);
    expect(over30.lifetimeSavings).toBeGreaterThan(30 * 600);
    // Discounting: later savings, replacements and the leftover value all count for less today.
    const discounted = lifecycle(row, rows, { ...econ, horizonYears: 30, discountRate: 0.03 });
    expect(discounted.lifetimeSavings).toBeLessThan(over30.lifetimeSavings * 0.7);
    expect(discounted.replacementCost).toBeCloseTo(0.7 * 5500 * (1.03 ** -12 + 1.03 ** -24));
    expect(discounted.residualValue).toBeCloseTo(0.7 * 5500 * 0.5 * 1.03 ** -30);
    const oneYear = lifecycle({ ...row, annual: { cycles: 0 } as never }, rows, { ...econ, calendarLossPerYear: 0, horizonYears: 1, discountRate: 0.05 });
    expect(oneYear.lifetimeSavings).toBeCloseTo(700 / 1.05); // a full year's saving, received at the year's end
    // Discounted payback: 5,500 against ~690/yr fading savings, slower once discounted, and it may
    // run past the horizon (simple payback isn't capped by it either).
    expect(over30.discountedPaybackYears).toBeGreaterThan(5500 / 700);
    expect(discounted.discountedPaybackYears).toBeGreaterThan(over30.discountedPaybackYears);
    expect(lifecycle(row, rows, { ...econ, horizonYears: 5 }).discountedPaybackYears).toBeCloseTo(over30.discountedPaybackYears, 6);
    const flat = lifecycle({ ...row, annual: { cycles: 0 } as never }, rows, { ...econ, calendarLossPerYear: 0, horizonYears: 20 });
    expect(flat.discountedPaybackYears).toBeCloseTo(5500 / 700); // no fading, no discount = simple payback
    expect(lifecycle(row, [{ nominalKwh: 0, annualSavings: 0 }, { nominalKwh: 10, annualSavings: 10 }], econ).discountedPaybackYears).toBe(Infinity);
    const over10 = lifecycle(row, rows, { ...econ, horizonYears: 10 });
    expect(over10.replacements).toBe(0);
    expect(over10.residualValue).toBeCloseTo(5500 * (1 - 10 / 12));
  });
  it('sizeRange starts at zero', () => {
    expect(sizeRange(3, 1)).toEqual([0, 1, 2, 3]);
  });
});

describe('simulate trace', () => {
  it('records hourly charge, discharge to house and EV, and state of charge', () => {
    const data = prepare(hours([[0, 6], [1, 0, 7]]));
    const trace = createTrace(2);
    simulate(data, { ...ideal, nominalKwh: 5 }, flat, { ...opts, evMode: 'include' }, trace);
    expect(trace.chargeSolar[0]).toBeCloseTo(5);
    expect(trace.gridExport[0]).toBeCloseTo(1);
    expect(trace.soc[0]).toBeCloseTo(5);
    expect(trace.toHouse[1]).toBeCloseTo(1);
    expect(trace.toEv[1]).toBeCloseTo(4);
    expect(trace.gridImport[1]).toBeCloseTo(3);
    expect(trace.soc[1]).toBeCloseTo(0);
  });

  it('never sends battery energy to the EV in exclude mode', () => {
    const trace = createTrace(2);
    simulate(prepare(hours([[0, 6], [1, 0, 7]])), { ...ideal, nominalKwh: 5 }, flat, opts, trace);
    expect(trace.toEv[1]).toBe(0);
    expect(trace.toHouse[1]).toBeCloseTo(1);
  });
});

describe('tariff from meter registers', () => {
  it('prices each hour by its register when enabled, falling back to the window otherwise', () => {
    const tou: Tariff = { ...flat, useTimeOfUse: true, importPeak: 0.4, importOffPeak: 0.1, peakStartHour: 0, peakEndHour: 24 };
    // hour 0 counted on T2 (off-peak), hour 1 unknown → window says peak
    const data = prepare([
      { t: base, house: 1, solar: 0, ev: 0, rate: 2 },
      { t: base + H, house: 1, solar: 0, ev: 0 },
    ]);
    const spec = { ...ideal, nominalKwh: 0 };
    expect(simulate(data, spec, { ...tou, useMeterRegisters: true, peakRegister: 1 }, opts).importCost).toBeCloseTo(0.1 + 0.4);
    expect(simulate(data, spec, { ...tou, useMeterRegisters: true, peakRegister: 2 }, opts).importCost).toBeCloseTo(0.4 + 0.4);
    expect(simulate(data, spec, { ...tou, useMeterRegisters: false }, opts).importCost).toBeCloseTo(0.8);
  });
});
