import { describe, expect, it } from 'vitest';
import { createTrace, prepare, simulate, isPeakHour } from './simulate';
import { lifetimeMultiplier, sizeRange, sweep } from './sweep';
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

describe('sweep', () => {
  const template = { usableFraction: 0.95, inverterKw: 5, cRate: 0.5, roundTripEfficiency: 0.9 };
  const econ = { costPerKwh: 400, fixedCost: 1500, lifetimeYears: 12, degradationPerYear: 0.02 };

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

  it('always includes a zero-size baseline', () => {
    const rec = sweep(prepare(hours([[1, 2]])), template, [5, 10], flat, opts, econ);
    expect(rec.rows[0].nominalKwh).toBe(0);
    expect(rec.baseline.annualSavings).toBe(0);
  });
});

describe('helpers', () => {
  it('lifetimeMultiplier sums degraded years', () => {
    expect(lifetimeMultiplier(3, 0)).toBe(3);
    expect(lifetimeMultiplier(2, 0.1)).toBeCloseTo(1.9);
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
