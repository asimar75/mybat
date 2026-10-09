import type { StatisticPoint } from './homeassistant';
import { HOUR_MS, indexByHour, type StatSelection } from './derive';
import { loadValue, solarValue, type MeterAssignment } from './meters';
import { localDay } from './validate';

/**
 * Compares Home Assistant's statistics with the meter CSV files, meter by meter, over the hours
 * both have. Raw meter values on both sides: nothing is netted or clamped, so a difference here
 * is a difference between the two recordings of the same meter.
 */

export type MeterKey = 'gridIn' | 'gridOut' | 'solar' | 'ev' | 'wh';

export const METER_KEYS: MeterKey[] = ['gridIn', 'gridOut', 'solar', 'ev', 'wh'];

export const METER_NAMES: Record<MeterKey, string> = {
  gridIn: 'Grid import',
  gridOut: 'Grid export',
  solar: 'Solar production',
  ev: 'EV charger',
  wh: 'Water heater',
};

/** kWh per hour start (epoch ms), per meter; an hour without a reading is absent, not 0. */
export type MeterSeries = Partial<Record<MeterKey, Map<number, number>>>;

/** Adds up several files or sensors of one meter; an hour counts only when every one of them has it. */
function sumWhereAll(parts: Map<number, number>[]): Map<number, number> {
  const out = new Map<number, number>();
  if (parts.length === 0) return out;
  for (const [t, v] of parts[0]) {
    let sum = v;
    let complete = true;
    for (const p of parts.slice(1)) {
      const w = p.get(t);
      if (w === undefined) {
        complete = false;
        break;
      }
      sum += w;
    }
    if (complete) out.set(t, sum);
  }
  return out;
}

function collect(parts: Record<MeterKey, Map<number, number>[]>): MeterSeries {
  const out: MeterSeries = {};
  for (const key of METER_KEYS) if (parts[key].length) out[key] = sumWhereAll(parts[key]);
  return out;
}

const emptyParts = (): Record<MeterKey, Map<number, number>[]> => ({ gridIn: [], gridOut: [], solar: [], ev: [], wh: [] });

/** Per-meter hours from the CSV files, by the role each file was given (same reading as when loading them). */
export function seriesFromMeters(assigned: MeterAssignment[]): MeterSeries {
  const parts = emptyParts();
  const of = (pick: (h: { imp: number; exp: number }) => number, m: MeterAssignment['meter']) =>
    new Map([...m.hourly].map(([t, h]) => [t, pick(h)]));
  for (const { meter, role } of assigned) {
    if (role === 'grid') {
      parts.gridIn.push(of((h) => h.imp, meter));
      parts.gridOut.push(of((h) => h.exp, meter));
    } else if (role === 'solar') parts.solar.push(of((h) => solarValue(meter, h), meter));
    else if (role === 'ev') parts.ev.push(of(loadValue, meter));
    else if (role === 'wh') parts.wh.push(of(loadValue, meter));
  }
  return collect(parts);
}

/** Per-meter hours from Home Assistant statistics, by the sensors picked for each. */
export function seriesFromStats(stats: Record<string, StatisticPoint[]>, sel: StatSelection): MeterSeries {
  const ids: Record<MeterKey, string[]> = {
    gridIn: sel.gridImport,
    gridOut: sel.gridExport,
    solar: sel.solar,
    ev: sel.ev ? [sel.ev] : [],
    wh: sel.wh ? [sel.wh] : [],
  };
  const parts = emptyParts();
  for (const key of METER_KEYS) parts[key] = ids[key].map((id) => indexByHour(stats[id]));
  return collect(parts);
}

/** First and last hour of a series, or null when it's empty. */
export function seriesSpan(series: MeterSeries): { first: number; last: number } | null {
  let first = Infinity;
  let last = -Infinity;
  for (const m of Object.values(series)) {
    for (const t of m.keys()) {
      if (t < first) first = t;
      if (t > last) last = t;
    }
  }
  return Number.isFinite(first) ? { first, last } : null;
}

/** One hour of the compared period; null where that source has no value. */
export interface HourPair {
  t: number;
  csv: number | null;
  ha: number | null;
}

export interface PeriodPair {
  /** "YYYY-MM-DD" for a day, "YYYY-MM" for a month (local time). */
  key: string;
  csv: number;
  ha: number;
  /** Hours both sources have. */
  hours: number;
}

export interface MeterComparison {
  meter: MeterKey;
  /** Every hour from the first to the last hour both have, that either has, oldest first. */
  hours: HourPair[];
  /** Hours both sources have. */
  compared: number;
  /**
   * Totals over that period, each source counting every hour it has: after being offline, Home
   * Assistant books the missed energy in its first hour back, so its total still matches then.
   */
  csvKwh: number;
  haKwh: number;
  /** Hours that differ by more than OFF_KWH and OFF_SHARE. */
  offHours: number;
  /** Hours in the period that only the other source has (offline, gap in the file). */
  missingInHa: number;
  missingInCsv: number;
  daily: PeriodPair[];
  monthly: PeriodPair[];
  /**
   * Hours Home Assistant's values sit later (+) or earlier (−) than the CSV's, when shifting them
   * lines the two up much better (a time-zone or hour-labelling mismatch); 0 when they already line up.
   */
  shift: number;
}

export const OFF_KWH = 0.1;
export const OFF_SHARE = 0.1;
/** Days and months add up many hours, so the same meter should agree more closely over them. */
export const PERIOD_OFF_SHARE = 0.03;

const isOff = (a: number, b: number, share = OFF_SHARE) => Math.abs(a - b) > OFF_KWH && Math.abs(a - b) > share * Math.max(a, b);

function group(hours: HourPair[], keyOf: (t: number) => string): PeriodPair[] {
  const out: PeriodPair[] = [];
  for (const h of hours) {
    const key = keyOf(h.t);
    let last = out[out.length - 1];
    if (!last || last.key !== key) {
      last = { key, csv: 0, ha: 0, hours: 0 };
      out.push(last);
    }
    last.csv += h.csv ?? 0;
    last.ha += h.ha ?? 0;
    if (h.csv !== null && h.ha !== null) last.hours++;
  }
  return out;
}

/** Mean hourly difference between csv(t) and ha(t + lag hours). */
function meanError(csv: Map<number, number>, ha: Map<number, number>, lag: number): number {
  let sum = 0;
  let n = 0;
  for (const [t, v] of csv) {
    const w = ha.get(t + lag * HOUR_MS);
    if (w === undefined) continue;
    sum += Math.abs(v - w);
    n++;
  }
  return n ? sum / n : Infinity;
}

function detectShift(csv: Map<number, number>, ha: Map<number, number>): number {
  const aligned = meanError(csv, ha, 0);
  if (!(aligned > 0.02)) return 0; // already close: nothing to explain
  let best = 0;
  let bestError = aligned;
  for (const lag of [-2, -1, 1, 2]) {
    const e = meanError(csv, ha, lag);
    if (e < bestError) {
      best = lag;
      bestError = e;
    }
  }
  // Only a clear improvement counts; meters with a flat profile line up about as well at any lag.
  return bestError < aligned * 0.5 ? best : 0;
}

/** One comparison per meter both sources have, over the period from the first to the last hour both have. */
export function compareMeters(csv: MeterSeries, ha: MeterSeries): MeterComparison[] {
  const out: MeterComparison[] = [];
  for (const meter of METER_KEYS) {
    const a = csv[meter];
    const b = ha[meter];
    if (!a || !b) continue;
    const common = [...a.keys()].filter((t) => b.has(t));
    if (common.length === 0) continue;
    // A loop, not Math.min(...common): years of hours can exceed a browser's argument limit.
    const first = common.reduce((x, t) => Math.min(x, t), Infinity);
    const last = common.reduce((x, t) => Math.max(x, t), -Infinity);
    const inPeriod = (t: number) => t >= first && t <= last;
    const times = [...new Set([...a.keys(), ...b.keys()])].filter(inPeriod).sort((x, y) => x - y);
    const hours: HourPair[] = times.map((t) => ({ t, csv: a.get(t) ?? null, ha: b.get(t) ?? null }));
    const both = hours.filter((h) => h.csv !== null && h.ha !== null);
    out.push({
      meter,
      hours,
      compared: both.length,
      csvKwh: hours.reduce((s, h) => s + (h.csv ?? 0), 0),
      haKwh: hours.reduce((s, h) => s + (h.ha ?? 0), 0),
      offHours: both.filter((h) => isOff(h.csv!, h.ha!)).length,
      missingInHa: hours.filter((h) => h.ha === null).length,
      missingInCsv: hours.filter((h) => h.csv === null).length,
      daily: group(hours, localDay),
      monthly: group(hours, (t) => localDay(t).slice(0, 7)),
      shift: detectShift(a, b),
    });
  }
  return out;
}

/** True for a day or month whose totals differ by more than OFF_KWH and PERIOD_OFF_SHARE. */
export const periodIsOff = (p: PeriodPair) => isOff(p.csv, p.ha, PERIOD_OFF_SHARE);
