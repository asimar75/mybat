import { describe, expect, it } from 'vitest';
import { combineMeters, guessPeakRegister, parseLocalTime, parseMeterCsv, suggestRole, type MeterRole } from './meters';

const H = 3600_000;
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** HomeWizard-style export: cumulative 15-minute readings, one row per quarter hour. */
function meterFile(header: string, days: number, perQuarter: (d: Date) => number[], start = [0, 0, 0, 0], blankFrom?: number): string {
  const rows = [header];
  const totals = [...start];
  const t0 = new Date(2025, 10, 3, 0, 0).getTime(); // Monday 3 Nov 2025, no clock change
  for (let q = 0; q <= days * 96; q++) {
    const d = new Date(t0 + q * 15 * 60_000);
    const extra = header.split(',').length - 1 - totals.length;
    const blank = blankFrom !== undefined && q >= blankFrom;
    rows.push([stamp(d), ...totals.map((v) => (blank ? '' : v.toFixed(3))), ...new Array(extra).fill(blank ? '' : '640')].join(','));
    perQuarter(d).forEach((inc, i) => (totals[i] += inc));
  }
  return rows.join('\n') + '\n';
}

const day = (d: Date) => d.getHours() >= 7 && d.getHours() < 21 && d.getDay() >= 1 && d.getDay() <= 5;
const sunny = (d: Date) => d.getHours() >= 10 && d.getHours() < 15;

// Grid: import 0.2 kWh/quarter on T1 in the day, T2 otherwise; export 0.5/quarter when sunny.
const gridCsv = meterFile('time,Import T1 kWh,Import T2 kWh,Export T1 kWh,Export T2 kWh,L1 max W,L2 max W,L3 max W', 2, (d) =>
  sunny(d) ? [0, 0, day(d) ? 0.5 : 0, day(d) ? 0 : 0.5] : day(d) ? [0.2, 0, 0, 0] : [0, 0.2, 0, 0],
[8897, 19421, 18497, 6895]);
const solarCsv = meterFile('time,Import kWh,Export kWh,L1 max W,L2 max W,L3 max W', 2, (d) => [0.0005, sunny(d) ? 0.8 : 0], [1.6, 9714]);
const evCsv = meterFile('time,Import kWh,Export kWh,L1 max W,L2 max W,L3 max W', 2, (d) => [d.getHours() === 19 ? 1.5 : 0, 0], [4161, 0], 150);
const heatingCsv = meterFile('time,Import kWh,Export kWh', 2, (d) => [d.getHours() === 3 ? 0.25 : 0, 0], [322, 0.023]);

describe('parseMeterCsv on HomeWizard-style exports', () => {
  const grid = parseMeterCsv('House.csv', gridCsv);

  it('detects cumulative readings, interval, registers and ignores power columns', () => {
    expect(grid.cumulative).toBe(true);
    expect(grid.intervalMinutes).toBe(15);
    expect(grid.hasRegisters).toBe(true);
    expect(grid.importColumns).toEqual(['Import T1 kWh', 'Import T2 kWh']);
    expect(grid.exportColumns).toEqual(['Export T1 kWh', 'Export T2 kWh']);
    expect(grid.ignoredColumns).toEqual(['L1 max W', 'L2 max W', 'L3 max W']);
    expect(grid.hourly.size).toBe(48);
    expect(grid.importTotal).toBeCloseTo(0.2 * 4 * 19 * 2, 6);
    expect(grid.exportTotal).toBeCloseTo(0.5 * 4 * 5 * 2, 6);
  });

  it('suggests roles from energy flows, then file names', () => {
    const role = (name: string, csv: string) => suggestRole(parseMeterCsv(name, csv));
    expect(role('House.csv', gridCsv)).toBe<MeterRole>('grid'); // named "House" but it imports and exports
    expect(role('Panels.csv', solarCsv)).toBe<MeterRole>('solar');
    expect(role('EV.csv', evCsv)).toBe<MeterRole>('ev');
    expect(role('Heating.csv', heatingCsv)).toBe<MeterRole>('wh');
    expect(role('Something.csv', heatingCsv)).toBe<MeterRole>('ignore');
  });

  it('reads per-interval values, semicolons, decimal commas and day-first dates', () => {
    const csv = ['Datum;Verbruik kWh', '03/11/2025 00:00;0,25', '03/11/2025 00:15;0,25', '03/11/2025 00:30;0,30', '03/11/2025 00:45;0,20', '03/11/2025 01:00;1,25'].join('\n');
    const m = parseMeterCsv('verbruik.csv', csv);
    expect(m.cumulative).toBe(false);
    expect(m.hourly.get(new Date(2025, 10, 3, 0).getTime())!.imp).toBeCloseTo(1.0);
    expect(m.hourly.get(new Date(2025, 10, 3, 1).getTime())!.imp).toBeCloseTo(1.25);
  });

  it('interpolates inner gaps, ignores counter glitches, leaves trailing blanks unknown', () => {
    const lines = gridCsv.trim().split('\n');
    lines.splice(10, 8); // remove two hours of readings in the middle
    const m = parseMeterCsv('grid.csv', lines.join('\n'));
    expect(m.importTotal).toBeCloseTo(grid.importTotal, 6); // the jump across missing rows is spread over them
    expect(m.hourly.size).toBe(48);

    const blanks = ['time,Import kWh', '2025-11-03 00:00,10.0', '2025-11-03 00:15,', '2025-11-03 00:30,', '2025-11-03 00:45,10.3',
      '2025-11-03 01:00,10.4', '2025-11-03 01:15,10.5', '2025-11-03 01:30,10.6', '2025-11-03 01:45,10.7', '2025-11-03 02:00,10.8'];
    const bm = parseMeterCsv('blanks.csv', blanks.join('\n'));
    expect(bm.interpolated).toBe(2);
    expect(bm.hourly.get(new Date(2025, 10, 3, 0).getTime())!.imp).toBeCloseTo(0.4, 6); // 00:00 → 01:00 readings

    // A day of readings rising 0.1 per quarter, with one reading 0.001 too low.
    const glitchy = ['time,Import kWh'];
    for (let q = 0; q <= 96; q++) {
      const d = new Date(2025, 10, 3, 0, q * 15);
      glitchy.push(`${stamp(d)},${(10 + q * 0.1 - (q === 40 ? 0.101 : 0)).toFixed(3)}`);
    }
    const gm = parseMeterCsv('glitch.csv', glitchy.join('\n'));
    expect(gm.glitches).toBe(1);
    expect(gm.importTotal).toBeCloseTo(9.6 + 0.001, 6); // the backward step counts as 0, the next step catches up

    const ev = parseMeterCsv('EV.csv', evCsv);
    expect(ev.lastHour).toBeLessThan(grid.lastHour);
  });

  it('spots outages the export spread evenly over the gap (flat solar at night)', () => {
    // Solar with a natural wobble; on day 1, 19:00 → day 2, 12:30 the meter was offline and the catch-up
    // came back as 0.148 kWh every quarter, like HomeWizard's export of a Panels meter.
    let seed = 1;
    const wobble = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 0.05;
    const gapFrom = new Date(2025, 10, 4, 19).getTime();
    const gapTo = new Date(2025, 10, 5, 12, 30).getTime();
    const csv = meterFile('time,Import kWh,Export kWh', 3, (d) => {
      if (d.getTime() >= gapFrom && d.getTime() <= gapTo) return [0, 0.148];
      return [0, d.getHours() >= 9 && d.getHours() < 17 ? 0.6 + wobble() : 0];
    }, [0, 100]);
    const m = parseMeterCsv('Panels.csv', csv);
    expect(m.evenFills).toEqual([{ from: gapFrom, to: gapTo }]);
    const flat = combineMeters([{ meter: m, role: 'solar' }, { meter: grid, role: 'grid' }], true);
    expect(flat.notes.join(' ')).toContain('Panels.csv: the meter was probably offline 04/Nov/2025 19:00 – 05/Nov/2025 12:45');
    // A steady load that wobbles by more than a few watts is real, not a filled gap; nor is a steady standby.
    expect(parseMeterCsv('Solar.csv', meterFile('time,Import kWh,Export kWh', 1, () => [0, 0.6 + wobble()], [0, 100])).evenFills).toEqual([]);
    const standby = meterFile('time,Import kWh,Export kWh', 1, (d) => [d.getMinutes() === 15 ? 0.013 : 0.012, 0], [100, 0]);
    expect(parseMeterCsv('Heating.csv', standby).evenFills).toEqual([]);
  });

  it('parses local date formats', () => {
    expect(parseLocalTime('2025-11-03 07:15')).toBe(new Date(2025, 10, 3, 7, 15).getTime());
    expect(parseLocalTime('3-11-2025 7:15')).toBe(new Date(2025, 10, 3, 7, 15).getTime());
    expect(parseLocalTime('1762150500')).toBe(1762150500000);
  });
});

describe('combineMeters', () => {
  const meters = [
    parseMeterCsv('House.csv', gridCsv),
    parseMeterCsv('Panels.csv', solarCsv),
    parseMeterCsv('EV.csv', evCsv),
    parseMeterCsv('Heating.csv', heatingCsv),
  ];
  const assigned = meters.map((m) => ({ meter: m, role: suggestRole(m) }));

  it('derives house load and per-hour tariff registers', () => {
    const r = combineMeters(assigned, false);
    expect(r.samples).toHaveLength(48);
    for (const s of r.samples) {
      const g = meters[0].hourly.get(s.t)!;
      const total = g.imp - g.exp + s.solar;
      expect(s.house + s.ev + s.wh!).toBeCloseTo(total, 6);
    }
    const noon = r.samples.find((s) => new Date(s.t).getHours() === 12)!;
    expect(noon.solar).toBeCloseTo(3.2 - 0.002, 6); // production minus the inverter's standby import
    const monday9 = r.samples.find((s) => new Date(s.t).getHours() === 9)!;
    expect(monday9.rate).toBe(1);
    const night = r.samples.find((s) => new Date(s.t).getHours() === 2)!;
    expect(night.rate).toBe(2);
    // Hours without any import take the register of the same hour on another day; here every day
    // was sunny at noon, so those stay unknown and the engine falls back to the fixed window.
    const unknown = r.samples.filter((s) => !s.rate);
    expect(unknown.every((s) => sunny(new Date(s.t)))).toBe(true);
    expect(unknown.length).toBe(10);
    expect(r.peakRegisterGuess).toBe(1);
  });

  it('trims to the common period, or zero-fills a short EV file with a note', () => {
    const common = combineMeters(assigned, true);
    expect(common.samples.length).toBeLessThan(48);
    expect(common.notes.join(' ')).toMatch(/EV\.csv has no readings after .*untick “Only use the period every file covers”/);
    const all = combineMeters(assigned, false);
    expect(all.notes.join(' ')).toMatch(/no EV or water-heater data/);
  });

  it('keeps measured grid flows and reports what hourly netting cancels', () => {
    const r = combineMeters(assigned, false);
    const measuredIn = r.samples.reduce((a, s) => a + s.gridIn!, 0);
    expect(measuredIn).toBeCloseTo(meters[0].importTotal, 6);
    expect(r.samples.reduce((a, s) => a + s.gridOut!, 0)).toBeCloseTo(meters[0].exportTotal, 6);
    // This test data never imports and exports in the same hour, so nothing cancels.
    expect(r.notes.join(' ')).not.toMatch(/cancel out/);

    // Same hour with import and export (15-min readings): the meter counts both, the hourly net cancels them.
    const mixed = ['time,Import kWh,Export kWh'];
    let imp = 100;
    let exp = 50;
    for (let q = 0; q <= 96; q++) {
      const d = new Date(2025, 10, 3, 0, q * 15);
      mixed.push(`${stamp(d)},${imp.toFixed(3)},${exp.toFixed(3)}`);
      if (q % 2 === 0) imp += 0.3;
      else exp += 0.2;
    }
    const grid = parseMeterCsv('grid.csv', mixed.join('\n'));
    const sun = parseMeterCsv('Panels.csv', solarCsv);
    const r2 = combineMeters([{ meter: grid, role: 'grid' }, { meter: sun, role: 'solar' }], true);
    expect(r2.notes.join(' ')).toMatch(/cancel out/);
  });

  it('warns when a grid meter exports but no solar file is assigned', () => {
    const r = combineMeters([{ meter: meters[0], role: 'grid' }], false);
    expect(r.notes[0]).toMatch(/no solar file is assigned/);
  });

  it('requires a grid or consumption meter', () => {
    expect(() => combineMeters([{ meter: meters[1], role: 'solar' }], false)).toThrow(/Grid connection/);
  });

  it('guesses the peak register from weekday daytime', () => {
    const t = new Date(2025, 10, 3, 9).getTime();
    expect(guessPeakRegister([{ t, house: 1, ev: 0, solar: 0, rate: 2 }])).toBe(2);
    expect(guessPeakRegister([{ t, house: 1, ev: 0, solar: 0 }])).toBeUndefined();
  });
});

describe('daylight-saving change in local timestamps', () => {
  // Only meaningful where 26 Oct 2025 has a clock change (CI runs this file with TZ=Europe/Amsterdam).
  const t = new Date(2025, 9, 26, 2, 0).getTime();
  const hasDst = new Date(t).getTimezoneOffset() !== new Date(t + H).getTimezoneOffset();

  it.runIf(hasDst)('keeps the repeated autumn hour as a separate hour', () => {
    const rows = ['time,Import kWh'];
    let total = 100;
    const local = ['00', '01', '02', '02', '03', '04'];
    for (const h of local) for (const m of ['00', '15', '30', '45']) {
      rows.push(`2025-10-26 ${h}:${m},${total.toFixed(3)}`);
      total += 0.25;
    }
    rows.push(`2025-10-26 05:00,${total.toFixed(3)}`);
    const meter = parseMeterCsv('dst.csv', rows.join('\n'));
    expect(meter.hourly.size).toBe(6); // 00, 01, 02 (summer), 02 (winter), 03, 04
    for (const v of meter.hourly.values()) expect(v.imp).toBeCloseTo(1, 6);
  });
});
