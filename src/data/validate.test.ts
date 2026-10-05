import { describe, expect, it } from 'vitest';
import type { HourSample } from '../engine/types';
import { parseCsv } from './csv';
import { demoYear } from './demo';
import { addDays, dailyTotals, hourProfile, monthlyTotals, runChecks, toCsv } from './validate';

const H = 3600 * 1000;
const start = new Date(2025, 5, 1, 0).getTime();

function day(overrides: Partial<Record<number, Partial<HourSample>>> = {}, offsetDays = 0): HourSample[] {
  return Array.from({ length: 24 }, (_, h) => {
    const solar = h >= 8 && h < 18 ? Math.sin((Math.PI * (h - 8)) / 10) * 3 : 0;
    return { t: start + (offsetDays * 24 + h) * H, house: 0.4, ev: h === 19 ? 7 : 0, solar, ...overrides[h] };
  });
}

const byId = (samples: HourSample[], id: string) => runChecks(samples).find((c) => c.id === id)!;

describe('aggregations', () => {
  it('sums days and months, netting import/export per hour', () => {
    const samples = [...day(), ...day({}, 1)];
    const days = dailyTotals(samples);
    expect(days).toHaveLength(2);
    expect(days[0].day).toBe('2025-06-01');
    expect(days[0].house).toBeCloseTo(0.4 * 24);
    expect(days[0].ev).toBeCloseTo(7);
    const months = monthlyTotals(samples);
    expect(months).toHaveLength(1);
    expect(months[0].hours).toBe(48);
    expect(months[0].expectedHours).toBe(48);
    const load = months[0].house + months[0].ev;
    expect(load - months[0].solar).toBeCloseTo(months[0].gridImport - months[0].gridExport);
  });

  it('averages by hour of day', () => {
    const p = hourProfile([...day(), ...day({ 19: { ev: 3 } }, 1)]);
    expect(p.ev[19]).toBeCloseTo(5);
    expect(p.solar[0]).toBe(0);
    expect(p.solar[13]).toBeGreaterThan(p.solar[9]);
  });
});

describe('runChecks', () => {
  it('passes clean data', () => {
    const checks = runChecks([...day(), ...day({}, 1)]);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('passes the demo year', () => {
    expect(runChecks(demoYear(2024)).filter((c) => !c.ok)).toEqual([]);
  });

  it('flags gaps', () => {
    const samples = day();
    samples.splice(5, 3);
    const c = byId(samples, 'gaps');
    expect(c.ok).toBe(false);
    expect(c.title).toBe('3 hours missing');
    expect(c.examples[0]).toBe(start + 5 * H);
  });

  it('flags solar at night and an off-midday peak (time-zone shift)', () => {
    const shifted = day().map((s, i, arr) => ({ ...s, solar: arr[(i + 10) % 24].solar }));
    expect(byId(shifted, 'night-solar').ok).toBe(false);
    expect(byId(shifted, 'solar-peak').ok).toBe(false);
  });

  it('flags household and EV spikes', () => {
    const samples = day({ 3: { house: 80 }, 20: { ev: 40 } });
    expect(byId(samples, 'house-spikes').examples).toEqual([start + 3 * H]);
    expect(byId(samples, 'ev').ok).toBe(false);
  });

  it('flags missing EV and zero-load hours', () => {
    const samples = day().map((s) => ({ ...s, ev: 0, house: s.t < start + 6 * H ? 0 : 0.4 }));
    expect(byId(samples, 'ev').title).toMatch(/No EV/);
    expect(byId(samples, 'zero-load').ok).toBe(false);
  });
});

describe('addDays', () => {
  it('moves by calendar days across month ends and clock changes, with clamping', () => {
    expect(addDays('2025-10-30', 7)).toBe('2025-11-06');
    expect(addDays('2026-03-26', 7)).toBe('2026-04-02');
    expect(addDays('2025-01-03', -7)).toBe('2024-12-27');
    expect(addDays('2025-01-03', -7, '2025-01-01')).toBe('2025-01-01');
    expect(addDays('2025-12-28', 7, undefined, '2025-12-31')).toBe('2025-12-31');
  });
});

describe('water heater', () => {
  it('is counted in totals and profile, and spikes are flagged', () => {
    const samples = day({ 3: { wh: 1.2 } as Partial<HourSample>, 4: { wh: 9 } as Partial<HourSample> });
    const [d] = dailyTotals(samples);
    expect(d.wh).toBeCloseTo(10.2);
    expect(hourProfile(samples).wh[3]).toBeCloseTo(1.2);
    expect(byId(samples, 'water-heater').ok).toBe(false);
    expect(byId(day(), 'water-heater')).toBeUndefined(); // no separate meter → no check
  });

  it('round-trips through CSV', () => {
    const samples = day().map((s, i) => ({ ...s, wh: i === 2 ? 0.7 : 0 }));
    const back = parseCsv(toCsv(samples)).samples;
    expect(back[2].wh).toBeCloseTo(0.7, 3);
    expect(back[2].house).toBeCloseTo(samples[2].house, 3);
  });
});

describe('toCsv', () => {
  it('round-trips through the CSV importer', () => {
    const samples = [...day(), ...day({}, 1)];
    const back = parseCsv(toCsv(samples)).samples;
    expect(back).toHaveLength(samples.length);
    back.forEach((s, i) => {
      expect(s.t).toBe(samples[i].t);
      expect(s.house).toBeCloseTo(samples[i].house, 3);
      expect(s.ev).toBeCloseTo(samples[i].ev, 3);
      expect(s.solar).toBeCloseTo(samples[i].solar, 3);
    });
  });
});
