import { describe, expect, it } from 'vitest';
import type { HourSample } from '../engine/types';
import { appendHistory } from './merge';

const H = 3600_000;
const t0 = new Date(2026, 8, 1, 0).getTime(); // Tue 1 Sep 2026, local midnight
const hours = (from: number, count: number, make: (t: number) => Partial<HourSample> = () => ({})): HourSample[] =>
  Array.from({ length: count }, (_, i) => {
    const t = from + i * H;
    return { t, house: 1, ev: 0, solar: 0.5, ...make(t) };
  });

describe('appendHistory', () => {
  // History: 30 days with T1 on weekdays 07–21, T2 otherwise.
  const peak = (t: number) => {
    const d = new Date(t);
    return d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 7 && d.getHours() < 21 ? 1 : 2;
  };
  const history = hours(t0, 30 * 24, (t) => ({ rate: peak(t) as 1 | 2, gridIn: 1, gridOut: 0.5 }));
  const end = history[history.length - 1].t;

  it('keeps the history, adds only new hours and fills tariff registers from its pattern', () => {
    // Home Assistant: from 7 days before the end of the history until 5 days after it, slightly higher use.
    const fresh = hours(end - 7 * 24 * H + H, 12 * 24, () => ({ house: 1.1 }));
    const r = appendHistory(history, fresh);
    expect(r.overlap).toBe(7 * 24);
    expect(r.added).toBe(5 * 24);
    expect(r.samples).toHaveLength(35 * 24);
    expect(r.samples.slice(0, history.length)).toEqual(history); // history untouched
    expect(r.useRatio).toBeCloseTo(1.1);
    expect(r.solarRatio).toBeCloseTo(1);
    expect(r.gapHours).toBe(0);
    expect(r.registersFilled).toBe(5 * 24);
    for (const s of r.samples.slice(history.length)) expect(s.rate).toBe(peak(s.t));
  });

  it('reports a gap between the history and the new data', () => {
    const r = appendHistory(history, hours(end + 49 * H, 24));
    expect(r.gapHours).toBe(48);
    expect(r.overlap).toBe(0);
    expect(r.useRatio).toBeNull();
    expect(r.firstAdded).toBe(end + 49 * H);
  });

  it('works without a history and leaves registers alone when there are none', () => {
    const fresh = hours(t0, 48);
    const r = appendHistory([], fresh);
    expect(r.samples).toEqual(fresh);
    expect(r.registersFilled).toBe(0);
    expect(r.gapHours).toBe(0);
  });
});
