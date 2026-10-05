import type { HourSample } from '../engine/types';
import { HOUR_MS } from './derive';
import { fmtDate } from '../ui/format';

/**
 * Import of per-meter CSV exports from monitoring apps: one file per meter (grid connection,
 * solar inverter, EV charger, water heater…), each with a time column and one or more energy
 * columns.
 *
 * Handles what these exports typically look like:
 * - cumulative meter readings (running totals) or energy per interval — detected automatically
 * - several registers to add up (e.g. "Import T1 kWh" + "Import T2 kWh")
 * - non-energy columns to ignore (e.g. "L1 max W")
 * - 5/15/60-minute intervals, aggregated to hours
 * - local timestamps with daylight-saving changes (the repeated autumn hour is kept apart)
 * - missing readings (interpolated inside a gap, unknown at the ends) and small counter glitches
 */

export type MeterRole = 'grid' | 'consumption' | 'solar' | 'ev' | 'wh' | 'ignore';

export const ROLE_LABELS: Record<MeterRole, string> = {
  grid: 'Grid connection (import & export)',
  consumption: 'Total home consumption',
  solar: 'Solar production',
  ev: 'EV charger',
  wh: 'Water heater / heating',
  ignore: 'Ignore this file',
};

export interface HourEnergy {
  imp: number;
  exp: number;
  r1?: number;
  r2?: number;
}

/** Tariff register of an import column: "Import T1 kWh", "Tariff 2", OBIS "1.8.1"… */
function registerOf(header: string): 1 | 2 | 0 {
  if (/\bT1\b|tarif+ ?1\b|1\.8\.1/i.test(header)) return 1;
  if (/\bT2\b|tarif+ ?2\b|1\.8\.2/i.test(header)) return 2;
  return 0;
}

export interface ParsedMeter {
  name: string;
  importColumns: string[];
  exportColumns: string[];
  ignoredColumns: string[];
  /** True when the file holds running meter totals rather than energy per interval. */
  cumulative: boolean;
  intervalMinutes: number;
  rows: number;
  /** Energy per hour (kWh) for hours with data; r1/r2 split import by tariff register when the file has T1/T2. */
  hourly: Map<number, HourEnergy>;
  /** True when import comes in two tariff registers (T1/T2). */
  hasRegisters: boolean;
  importTotal: number;
  exportTotal: number;
  /** First and last hour with data. */
  firstHour: number;
  lastHour: number;
  /** Readings filled in by interpolation inside gaps. */
  interpolated: number;
  /** Backward steps in a cumulative counter, ignored. */
  glitches: number;
  skippedRows: number;
}

const ENERGY_HINT = /kwh|\bwh\b|mwh|energ|import|export|consum|produc|yield|deliver|levering|feed|inject/i;
const NOT_ENERGY = /\bmax\b|\bmin\b|\bw\b|watt(?!h)|power|volt|amp|\bva\b|temp|°|%|cost|price|€|\$/i;
const EXPORT_HINT = /export|feed|return|inject|teruglever|produc|generat|yield|out\b/i;
const TIME_HINT = /^(time|date|datetime|timestamp|start|period|fecha|hora|datum|tijd|zeit|heure)/i;

function unitFactor(header: string): number {
  if (/mwh/i.test(header)) return 1000;
  if (/kwh/i.test(header)) return 1;
  if (/\bwh\b/i.test(header)) return 0.001;
  return 1;
}

/**
 * Parses a local date-time string. ISO-like ("2025-10-01 00:15") and day-first European forms
 * ("01/10/2025 00:15", "1-10-2025 0:15") are accepted, as are epoch seconds/milliseconds.
 */
export function parseLocalTime(raw: string): number {
  const s = raw.trim().replace(/^"|"$/g, '');
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).getTime();
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).getTime();
  return Date.parse(s);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Cumulative when it almost never goes down and its level dwarfs its step size. */
function looksCumulative(series: (number | null)[]): boolean {
  const steps: number[] = [];
  const levels: number[] = [];
  let prev: number | null = null;
  for (const v of series) {
    if (v === null) continue;
    levels.push(Math.abs(v));
    if (prev !== null) steps.push(v - prev);
    prev = v;
  }
  if (steps.length < 4) return false;
  const nonDecreasing = steps.filter((d) => d >= -1e-9).length / steps.length;
  const moving = steps.filter((d) => Math.abs(d) > 1e-9);
  const typicalStep = median(moving.map(Math.abs));
  if (moving.length === 0) return median(levels) > 0; // a flat counter (e.g. an export register never used)
  return nonDecreasing >= 0.98 && median(levels) > 20 * typicalStep;
}

/** Linear interpolation of missing readings inside gaps; leading/trailing gaps stay null. */
function fillInnerGaps(series: (number | null)[]): { filled: (number | null)[]; interpolated: number } {
  const filled = [...series];
  let interpolated = 0;
  let lastIdx = -1;
  for (let i = 0; i < filled.length; i++) {
    if (filled[i] === null) continue;
    if (lastIdx >= 0 && i - lastIdx > 1) {
      const a = filled[lastIdx]!;
      const b = filled[i]!;
      for (let k = lastIdx + 1; k < i; k++) {
        filled[k] = a + ((b - a) * (k - lastIdx)) / (i - lastIdx);
        interpolated++;
      }
    }
    lastIdx = i;
  }
  return { filled, interpolated };
}

export function parseMeterCsv(name: string, text: string): ParsedMeter {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 3) throw new Error(`${name}: needs a header row and data rows.`);
  const delimiter = lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ',';
  const decimalComma = delimiter !== ',';
  const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ''));

  let timeCol = headers.findIndex((h) => TIME_HINT.test(h));
  if (timeCol < 0) timeCol = 0;
  const importColumns: string[] = [];
  const exportColumns: string[] = [];
  const ignoredColumns: string[] = [];
  const impIdx: number[] = [];
  const expIdx: number[] = [];
  headers.forEach((h, i) => {
    if (i === timeCol) return;
    if (NOT_ENERGY.test(h.replace(/kwh|wh/gi, '')) || !ENERGY_HINT.test(h)) {
      ignoredColumns.push(h);
    } else if (EXPORT_HINT.test(h)) {
      exportColumns.push(h);
      expIdx.push(i);
    } else {
      importColumns.push(h);
      impIdx.push(i);
    }
  });
  // A file with a single unnamed value column (e.g. "time,value") is treated as import energy.
  if (impIdx.length === 0 && expIdx.length === 0) {
    const fallback = headers.findIndex((_, i) => i !== timeCol);
    if (fallback < 0) throw new Error(`${name}: no energy column found.`);
    importColumns.push(headers[fallback]);
    impIdx.push(fallback);
    ignoredColumns.splice(ignoredColumns.indexOf(headers[fallback]), 1);
  }

  const num = (cell: string | undefined, factor: number): number | null => {
    let raw = (cell ?? '').trim().replace(/^"|"$/g, '');
    if (raw === '') return null;
    // "1.234,5" (decimal comma, dot thousands) → 1234.5; dot-decimal values are left alone.
    if (decimalComma && raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
    const v = Number(raw);
    return Number.isFinite(v) ? v * factor : null;
  };
  const sumCols = (cells: string[], idx: number[]): number | null => {
    let total = 0;
    let any = false;
    for (const i of idx) {
      const v = num(cells[i], unitFactor(headers[i]));
      if (v !== null) {
        total += v;
        any = true;
      }
    }
    return any ? total : null;
  };

  // Two import registers (T1 + T2) → keep them apart too, to know which tariff each hour used.
  const reg1 = impIdx.filter((i) => registerOf(headers[i]) === 1);
  const reg2 = impIdx.filter((i) => registerOf(headers[i]) === 2);
  const hasRegisters = reg1.length > 0 && reg2.length > 0;

  const times: number[] = [];
  const imp: (number | null)[] = [];
  const exp: (number | null)[] = [];
  const imp1: (number | null)[] = [];
  const imp2: (number | null)[] = [];
  let skippedRows = 0;
  let prev = -Infinity;
  for (const line of lines.slice(1)) {
    const cells = line.split(delimiter);
    let t = parseLocalTime(cells[timeCol] ?? '');
    if (!Number.isFinite(t)) {
      skippedRows++;
      continue;
    }
    // Autumn clock change: the repeated hour parses to the earlier (summer-time) instant. When a
    // timestamp steps back across a DST boundary, it belongs to the second, winter-time pass.
    if (t <= prev && new Date(t).getTimezoneOffset() !== new Date(t + HOUR_MS).getTimezoneOffset()) t += HOUR_MS;
    prev = t;
    times.push(t);
    imp.push(impIdx.length ? sumCols(cells, impIdx) : 0);
    exp.push(expIdx.length ? sumCols(cells, expIdx) : 0);
    if (hasRegisters) {
      imp1.push(sumCols(cells, reg1));
      imp2.push(sumCols(cells, reg2));
    }
  }
  if (times.length < 2) throw new Error(`${name}: no rows with a readable time.`);

  const intervalMinutes = Math.max(1, Math.round(median(times.slice(1).map((t, i) => t - times[i])) / 60000));
  const cumulative = looksCumulative(imp.some((v) => v !== null && v !== 0) ? imp : exp);

  const hourly = new Map<number, HourEnergy>();
  let glitches = 0;
  let interpolated = 0;
  const bucket = (t: number) => {
    const h = Math.floor(t / HOUR_MS) * HOUR_MS;
    let e = hourly.get(h);
    if (!e) {
      e = { imp: 0, exp: 0 };
      hourly.set(h, e);
    }
    return e;
  };

  if (cumulative) {
    const fi = fillInnerGaps(imp);
    const fe = fillInnerGaps(exp);
    const f1 = hasRegisters ? fillInnerGaps(imp1).filled : [];
    const f2 = hasRegisters ? fillInnerGaps(imp2).filled : [];
    interpolated = Math.max(fi.interpolated, fe.interpolated);
    for (let i = 0; i + 1 < times.length; i++) {
      const a = fi.filled[i];
      const b = fi.filled[i + 1];
      const c = fe.filled[i];
      const d = fe.filled[i + 1];
      if (a === null || b === null || c === null || d === null) continue;
      let di = b - a;
      let de = d - c;
      if (di < -1e-9 || de < -1e-9) glitches++;
      di = Math.max(0, di);
      de = Math.max(0, de);
      // A step spanning a missing stretch (e.g. a long logger outage) is spread over its hours.
      const span = times[i + 1] - times[i];
      const pieces = Math.max(1, Math.round(span / (intervalMinutes * 60000)));
      const d1 = hasRegisters && f1[i] !== null && f1[i + 1] !== null ? Math.max(0, f1[i + 1]! - f1[i]!) : 0;
      const d2 = hasRegisters && f2[i] !== null && f2[i + 1] !== null ? Math.max(0, f2[i + 1]! - f2[i]!) : 0;
      for (let k = 0; k < pieces; k++) {
        const e = bucket(times[i] + (k * span) / pieces);
        e.imp += di / pieces;
        e.exp += de / pieces;
        if (hasRegisters) {
          e.r1 = (e.r1 ?? 0) + d1 / pieces;
          e.r2 = (e.r2 ?? 0) + d2 / pieces;
        }
      }
    }
  } else {
    for (let i = 0; i < times.length; i++) {
      if (imp[i] === null && exp[i] === null) continue;
      const e = bucket(times[i]);
      e.imp += Math.max(0, imp[i] ?? 0);
      e.exp += Math.max(0, exp[i] ?? 0);
      if (hasRegisters) {
        e.r1 = (e.r1 ?? 0) + Math.max(0, imp1[i] ?? 0);
        e.r2 = (e.r2 ?? 0) + Math.max(0, imp2[i] ?? 0);
      }
    }
  }

  const hours = [...hourly.keys()].sort((a, b) => a - b);
  if (hours.length === 0) throw new Error(`${name}: no usable energy values.`);
  let importTotal = 0;
  let exportTotal = 0;
  for (const v of hourly.values()) {
    importTotal += v.imp;
    exportTotal += v.exp;
  }
  return {
    name,
    importColumns,
    exportColumns,
    ignoredColumns,
    cumulative,
    intervalMinutes,
    rows: times.length,
    hourly,
    hasRegisters,
    importTotal,
    exportTotal,
    firstHour: hours[0],
    lastHour: hours[hours.length - 1],
    interpolated,
    glitches,
    skippedRows,
  };
}

/** Guesses a meter's role from its energy flows first, then its file name. */
export function suggestRole(m: ParsedMeter): MeterRole {
  const name = m.name.toLowerCase();
  const imp = m.importTotal;
  const exp = m.exportTotal;
  if (exp > 0 && imp > 0.05 * exp && exp > 0.05 * imp) return 'grid';
  if (exp > 20 * imp && exp > 0) return 'solar';
  if (/\b(ev|car|auto|coche|voiture|charger|charging|wallbox|laadpaal|cargador|borne|zappi|easee)\b|ev[_ -]/.test(name.replace(/[^a-z0-9]+/g, ' ') + ' ')) return 'ev';
  if (/heat|water|boiler|dhw|ecs|acs|termo|calef|chauffe|warmwater|calentador/.test(name)) return 'wh';
  if (/solar|pv|panel|inverter|omvormer|placas|fotovolt|zonne|wechselrichter/.test(name)) return 'solar';
  if (/grid|main|p1|contador|net\b|meter/.test(name)) return 'grid';
  if (/house|home|casa|maison|huis|haus|consum|verbruik/.test(name)) return 'consumption';
  return 'ignore';
}

export interface MeterAssignment {
  meter: ParsedMeter;
  role: MeterRole;
}

export interface CombineResult {
  samples: HourSample[];
  notes: string[];
  /** Register that looks like the peak one (most active on weekday daytime), when registers exist. */
  peakRegisterGuess?: 1 | 2;
}

/**
 * Builds hourly household samples from assigned meters.
 * Total use = grid import − grid export + solar (or a total-consumption meter directly);
 * house = total − EV − water heater.
 */
export function combineMeters(assigned: MeterAssignment[], commonPeriodOnly: boolean): CombineResult {
  const by = (role: MeterRole) => assigned.filter((a) => a.role === role).map((a) => a.meter);
  const grid = by('grid');
  const consumption = by('consumption');
  const solar = by('solar');
  const ev = by('ev');
  const wh = by('wh');
  if (grid.length === 0 && consumption.length === 0) {
    throw new Error('Assign at least one file as "Grid connection" or "Total home consumption".');
  }
  const primary = [...grid, ...consumption, ...solar];
  const used = [...primary, ...ev, ...wh];
  const notes: string[] = [];

  let start = Math.min(...primary.map((m) => m.firstHour));
  let end = Math.max(...primary.map((m) => m.lastHour));
  if (commonPeriodOnly) {
    const s = Math.max(...used.map((m) => m.firstHour));
    const e = Math.min(...used.map((m) => m.lastHour));
    if (e <= s) throw new Error('The files do not overlap in time.');
    if (s > start || e < end) {
      const short = used.filter((m) => m.lastHour < end || m.firstHour > start).map((m) => m.name);
      notes.push(
        `Using ${fmtDate(s)} – ${fmtDate(e)}, the period every file covers (${short.join(', ')} ${short.length === 1 ? 'is' : 'are'} shorter).`,
      );
    }
    start = s;
    end = e;
  }

  // Solar meters count production in whichever direction dominates (usually "export").
  const solarValue = (m: ParsedMeter, h: HourEnergy) =>
    m.exportTotal >= m.importTotal ? Math.max(0, h.exp - h.imp) : Math.max(0, h.imp - h.exp);
  const loadValue = (h: HourEnergy) => Math.max(0, h.imp - h.exp);
  const registerMeter = grid.find((m) => m.hasRegisters);

  const samples: HourSample[] = [];
  let missing = 0;
  let filledZero = 0;
  let clamped = 0;
  for (let t = start; t <= end; t += HOUR_MS) {
    const p = primary.map((m) => m.hourly.get(t));
    if (p.some((v) => v === undefined)) {
      missing++;
      continue;
    }
    const gridIn = grid.reduce((a, m) => a + m.hourly.get(t)!.imp, 0);
    const gridOut = grid.reduce((a, m) => a + m.hourly.get(t)!.exp, 0);
    const pv = solar.reduce((a, m) => a + solarValue(m, m.hourly.get(t)!), 0);
    const total = grid.length
      ? Math.max(0, gridIn - gridOut + pv)
      : consumption.reduce((a, m) => a + loadValue(m.hourly.get(t)!), 0);
    const sub = (meters: ParsedMeter[]) =>
      meters.reduce((a, m) => {
        const h = m.hourly.get(t);
        if (!h) {
          filledZero++;
          return a;
        }
        return a + loadValue(h);
      }, 0);
    let evKwh = sub(ev);
    let whKwh = sub(wh);
    if (evKwh + whKwh > total + 0.05) clamped++;
    evKwh = Math.min(evKwh, total);
    whKwh = Math.min(whKwh, total - evKwh);
    const sample: HourSample = { t, solar: pv, ev: evKwh, house: total - evKwh - whKwh };
    if (grid.length) {
      sample.gridIn = gridIn;
      sample.gridOut = gridOut;
    }
    if (wh.length) sample.wh = whKwh;
    samples.push(sample);
  }
  let peakRegisterGuess: 1 | 2 | undefined;
  if (registerMeter) {
    const known = fillRegisters(samples, registerMeter);
    peakRegisterGuess = guessPeakRegister(samples);
    notes.push(
      `${registerMeter.name}: tariff registers T1/T2 found; each hour is priced as peak or off-peak from the register it was counted on` +
        (known < samples.length ? ` (${(samples.length - known).toLocaleString()} hours without grid import take the register of the same hour on nearby days).` : '.'),
    );
  }

  for (const m of used) {
    const parts = [
      m.cumulative ? 'meter readings (running totals)' : 'energy per interval',
      `every ${m.intervalMinutes} min`,
      `${[...m.importColumns, ...m.exportColumns].join(' + ')}`,
    ];
    notes.push(`${m.name}: ${parts.join(', ')}.`);
    if (m.glitches) notes.push(`${m.name}: ${m.glitches} backward counter step${m.glitches === 1 ? '' : 's'} ignored.`);
    if (m.interpolated) notes.push(`${m.name}: ${m.interpolated} missing readings filled in by interpolation.`);
  }
  if (grid.length) {
    const measuredIn = samples.reduce((a, s) => a + (s.gridIn ?? 0), 0);
    const measuredOut = samples.reduce((a, s) => a + (s.gridOut ?? 0), 0);
    const nettedIn = samples.reduce((a, s) => a + Math.max(0, s.house + s.ev + (s.wh ?? 0) - s.solar), 0);
    const lost = measuredIn - nettedIn;
    if (solar.length === 0 && measuredOut > 0.05 * measuredIn) {
      notes.unshift(
        `${grid.map((m) => m.name).join(', ')} exported ${Math.round(measuredOut).toLocaleString()} kWh, but no solar file is assigned. ` +
          'Consumption = import − export + solar, so without the solar file it comes out far too low. Add the solar meter file.',
      );
    }
    if (lost > 1) {
      notes.push(
        `Grid meter: ${Math.round(measuredIn).toLocaleString()} kWh imported and ${Math.round(measuredOut).toLocaleString()} kWh exported. ` +
          `The simulation works hour by hour, where ${Math.round(lost).toLocaleString()} kWh of import and export in the same hour ` +
          `(${((lost / Math.max(1, measuredIn)) * 100).toFixed(1)} % of import) cancel out; the meter and HomeWizard count both. ` +
          'Battery savings are therefore slightly conservative.',
      );
    }
  }
  if (missing) notes.push(`${missing.toLocaleString()} hours skipped because a grid, consumption or solar file had no data.`);
  if (filledZero) notes.push(`${filledZero.toLocaleString()} hours had no EV or water-heater data; counted as 0, so that use stays in household load.`);
  if (clamped) {
    // A handful of hours is normal: separate meters don't tick at exactly the same moment.
    notes.push(
      clamped <= samples.length * 0.005
        ? `In ${clamped} hours EV + water heater read slightly more than total use (meters not ticking in sync); capped at total use.`
        : `In ${clamped} hours EV + water heater read more than total consumption — check the file roles.`,
    );
  }
  if (samples.length === 0) throw new Error('No hours where all the needed files have data.');
  return { samples, notes, peakRegisterGuess };
}

/**
 * Sets each sample's tariff register from the grid meter: the register that counted its import.
 * Hours without import (solar covered everything) take the register of the same local hour on
 * the nearest day that had one, which follows schedule changes during the year.
 * Returns how many hours had a directly measured register.
 */
function fillRegisters(samples: HourSample[], meter: ParsedMeter): number {
  const byTime = new Map<number, HourSample>();
  let known = 0;
  for (const s of samples) {
    byTime.set(s.t, s);
    const h = meter.hourly.get(s.t);
    const r1 = h?.r1 ?? 0;
    const r2 = h?.r2 ?? 0;
    if (r1 > r2 + 1e-6) s.rate = 1;
    else if (r2 > r1 + 1e-6) s.rate = 2;
    if (s.rate) known++;
  }
  // Measured registers only, so fills never chain off other fills.
  const measured = new Map<number, 1 | 2>();
  for (const s of samples) if (s.rate) measured.set(s.t, s.rate);
  const weekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
  const lookup = (t: number, sameDayType: boolean): 1 | 2 | undefined => {
    const isWeekend = weekend(new Date(t));
    for (let d = 1; d <= 21; d++) {
      for (const sign of [-1, 1]) {
        const other = new Date(t);
        other.setDate(other.getDate() + sign * d);
        if (sameDayType && weekend(other) !== isWeekend) continue;
        const r = measured.get(other.getTime());
        if (r) return r;
      }
    }
    return undefined;
  };
  // Prefer the same kind of day (schedules often differ at weekends), else any nearby day.
  for (const s of samples) if (!s.rate) s.rate = lookup(s.t, true) ?? lookup(s.t, false);
  return known;
}

/**
 * Peak is the register counting weekday daytime (08:00–20:00). Conventions differ by country
 * (in the Netherlands T1 is usually the cheap register, elsewhere often the expensive one), so
 * the data decides rather than the label.
 */
export function guessPeakRegister(samples: HourSample[]): 1 | 2 | undefined {
  let t1 = 0;
  let t2 = 0;
  for (const s of samples) {
    const d = new Date(s.t);
    const h = d.getHours();
    if (d.getDay() === 0 || d.getDay() === 6 || h < 8 || h >= 20) continue;
    if (s.rate === 1) t1++;
    else if (s.rate === 2) t2++;
  }
  if (t1 === 0 && t2 === 0) return undefined;
  return t1 >= t2 ? 1 : 2;
}
