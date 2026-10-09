import { describe, expect, it } from 'vitest';
import { compareMeters, periodIsOff, seriesFromMeters, seriesFromStats, seriesSpan, type MeterSeries } from './compare';
import type { HourEnergy, ParsedMeter } from './meters';

const H = 3600_000;
// Local midnight, so days and months group the same in UTC and Europe/Amsterdam.
const t0 = new Date(2025, 10, 3).getTime();
const hoursOf = (n: number) => Array.from({ length: n }, (_, i) => t0 + i * H);

function meter(name: string, hourly: [number, HourEnergy][]): ParsedMeter {
  const map = new Map(hourly);
  const importTotal = hourly.reduce((a, [, h]) => a + h.imp, 0);
  const exportTotal = hourly.reduce((a, [, h]) => a + h.exp, 0);
  return {
    name, importColumns: [], exportColumns: [], ignoredColumns: [], cumulative: true, intervalMinutes: 15, rows: 0,
    hourly: map, hasRegisters: false, importTotal, exportTotal,
    firstHour: hourly[0][0], lastHour: hourly[hourly.length - 1][0],
    interpolated: 0, glitches: 0, evenFills: [], skippedRows: 0,
  };
}

const sunny = (t: number) => {
  const h = new Date(t).getHours();
  return h >= 10 && h < 15 ? 2 : 0;
};

describe('per-meter series', () => {
  it('reads CSV files by role: grid in both directions, solar from its dominant direction', () => {
    const grid = meter('p1.csv', hoursOf(3).map((t) => [t, { imp: 0.5, exp: 0.2 }]));
    const solar = meter('pv.csv', hoursOf(3).map((t) => [t, { imp: 0.001, exp: 1 }]));
    const s = seriesFromMeters([{ meter: grid, role: 'grid' }, { meter: solar, role: 'solar' }]);
    expect(s.gridIn?.get(t0)).toBe(0.5);
    expect(s.gridOut?.get(t0)).toBe(0.2);
    expect(s.solar?.get(t0)).toBeCloseTo(0.999, 6);
    expect(s.ev).toBeUndefined();
  });

  it('adds two files of one meter only for hours both have', () => {
    const a = meter('pv1.csv', hoursOf(3).map((t) => [t, { imp: 0, exp: 1 }]));
    const b = meter('pv2.csv', hoursOf(2).map((t) => [t, { imp: 0, exp: 2 }]));
    const s = seriesFromMeters([{ meter: a, role: 'solar' }, { meter: b, role: 'solar' }]);
    expect([...s.solar!.entries()]).toEqual([[t0, 3], [t0 + H, 3]]);
  });

  it('reads Home Assistant statistics by the sensors picked for each meter', () => {
    const stats = {
      'sensor.import': hoursOf(2).map((t) => ({ start: t / 1000, change: 0.4 })),
      'sensor.pv': hoursOf(2).map((t) => ({ start: new Date(t).toISOString(), change: 1.5 })),
      'sensor.car': [{ start: t0, change: -3 }], // a meter reset reads as 0, as when loading
    };
    const s = seriesFromStats(stats, { gridImport: ['sensor.import'], gridExport: [], solar: ['sensor.pv'], batteryOut: [], batteryIn: [], ev: 'sensor.car' });
    expect(s.gridIn?.get(t0 + H)).toBe(0.4);
    expect(s.solar?.get(t0)).toBe(1.5);
    expect(s.ev?.get(t0)).toBe(0);
    expect(s.gridOut).toBeUndefined();
    expect(s.wh).toBeUndefined();
    expect(seriesSpan(s)).toEqual({ first: t0, last: t0 + H });
  });
});

describe('compareMeters', () => {
  const series = (hours: number[], value: (t: number) => number) => new Map(hours.map((t) => [t, value(t)]));

  it('compares only the hours both sources have', () => {
    const csv: MeterSeries = { solar: series(hoursOf(72), sunny) };
    const ha: MeterSeries = { solar: series(hoursOf(96).slice(24), sunny), ev: series(hoursOf(96), () => 1) };
    const [c, ...rest] = compareMeters(csv, ha);
    expect(rest).toEqual([]); // the CSV has no EV file, so there's nothing to compare it with
    expect(c.meter).toBe('solar');
    expect(c.compared).toBe(48);
    expect(c.hours[0].t).toBe(t0 + 24 * H);
    expect(c.csvKwh).toBe(20);
    expect(c.haKwh).toBe(20);
    expect(c.offHours).toBe(0);
    expect(c.missingInHa).toBe(0);
    expect(c.shift).toBe(0);
    expect(c.daily.map((d) => [d.key, d.csv, d.ha, d.hours])).toEqual([['2025-11-04', 10, 10, 24], ['2025-11-05', 10, 10, 24]]);
    expect(c.monthly).toEqual([{ key: '2025-11', csv: 20, ha: 20, hours: 48 }]);
  });

  it('counts the hours inside the compared period that only one source has', () => {
    const hours = hoursOf(48);
    const offline = hours.filter((t) => t < t0 + 10 * H || t > t0 + 15 * H); // HA down for 6 hours
    const [c] = compareMeters({ gridIn: series(hours.slice(0, 40), () => 1) }, { gridIn: series(offline, () => 1) });
    expect(c.compared).toBe(34);
    expect(c.missingInHa).toBe(6);
    expect(c.missingInCsv).toBe(0); // HA's hours after the CSV ends are outside the compared period
    expect(c.hours.length).toBe(40);
    expect(c.hours[10]).toEqual({ t: t0 + 10 * H, csv: 1, ha: null });
    expect([c.csvKwh, c.haKwh]).toEqual([40, 34]); // data Home Assistant lost shows as a lower total
  });

  it("totals still match when Home Assistant books an outage's energy in its first hour back", () => {
    const hours = hoursOf(24);
    const ha = new Map(hours.filter((t) => t < t0 + 5 * H || t > t0 + 7 * H).map((t) => [t, t === t0 + 8 * H ? 4 : 1]));
    const [c] = compareMeters({ gridIn: series(hours, () => 1) }, { gridIn: ha });
    expect(c.missingInHa).toBe(3);
    expect(c.offHours).toBe(1);
    expect([c.csvKwh, c.haKwh]).toEqual([24, 24]);
    expect(c.daily.map(periodIsOff)).toEqual([false]);
    expect(c.daily[0].hours).toBe(21);
  });

  it('counts hours that differ and flags the day they fall on', () => {
    const ha = series(hoursOf(48), (t) => (t === t0 + 30 * H ? 1.5 : 0.5));
    const [c] = compareMeters({ gridIn: series(hoursOf(48), () => 0.5) }, { gridIn: ha });
    expect(c.offHours).toBe(1);
    expect(c.haKwh - c.csvKwh).toBeCloseTo(1, 9);
    expect(c.daily.map(periodIsOff)).toEqual([false, true]);
  });

  it('a small difference is not counted as off', () => {
    const [c] = compareMeters({ gridIn: series(hoursOf(24), () => 0.5) }, { gridIn: series(hoursOf(24), () => 0.51) });
    expect(c.offHours).toBe(0);
    expect(c.daily.map(periodIsOff)).toEqual([false]);
  });

  it('spots Home Assistant hours sitting an hour later than the CSV', () => {
    const later = series(hoursOf(96), (t) => sunny(t - H));
    const [c] = compareMeters({ solar: series(hoursOf(96), sunny) }, { solar: later });
    expect(c.shift).toBe(1);
    expect(c.offHours).toBeGreaterThan(0);
  });

  it('works across the autumn clock change', () => {
    // 26 Oct 2025 has 25 hours in Amsterdam; grouping by local day keeps them together.
    const start = new Date(2025, 9, 26).getTime();
    const hours = Array.from({ length: 48 }, (_, i) => start + i * H);
    const [c] = compareMeters({ ev: series(hours, () => 1) }, { ev: series(hours, () => 1) });
    expect(c.daily[0].key).toBe('2025-10-26');
    expect(c.daily[0].hours).toBe(Math.round((new Date(2025, 9, 27).getTime() - start) / H));
    expect(c.daily.reduce((a, d) => a + d.hours, 0)).toBe(48);
  });
});
