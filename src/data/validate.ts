import type { HourSample } from '../engine/types';
import { HOUR_MS } from './derive';

/**
 * Helpers for the "Check your data" step: aggregate the hourly samples into views a person can
 * compare against Home Assistant's Energy dashboard, and flag patterns that usually mean the
 * input is wrong (time-zone shift, wrong sensor, gaps, meter glitches).
 */

export interface Totals {
  house: number;
  ev: number;
  solar: number;
  /** Grid import with no battery (hourly netting of load against solar). */
  gridImport: number;
  /** Grid export with no battery. */
  gridExport: number;
  hours: number;
}

export interface DayTotals extends Totals {
  /** Local calendar date, "YYYY-MM-DD". */
  day: string;
}

export interface MonthTotals extends Totals {
  /** Local calendar month, "YYYY-MM". */
  month: string;
  /** Hours the month would have if no data were missing (partial first/last months count only their covered span). */
  expectedHours: number;
}

export interface HourProfile {
  /** Average kWh in each local hour of the day, index 0–23. */
  house: number[];
  ev: number[];
  solar: number[];
}

export interface Check {
  id: string;
  ok: boolean;
  title: string;
  detail: string;
  /** Up to five sample timestamps illustrating the problem. */
  examples: number[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const hours = (n: number) => `${n.toLocaleString()} hour${n === 1 ? '' : 's'}`;

export function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localMonth(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function emptyTotals(): Totals {
  return { house: 0, ev: 0, solar: 0, gridImport: 0, gridExport: 0, hours: 0 };
}

function add(totals: Totals, s: HourSample) {
  const load = s.house + s.ev;
  totals.house += s.house;
  totals.ev += s.ev;
  totals.solar += s.solar;
  totals.gridImport += Math.max(0, load - s.solar);
  totals.gridExport += Math.max(0, s.solar - load);
  totals.hours++;
}

export function dailyTotals(samples: HourSample[]): DayTotals[] {
  const out: DayTotals[] = [];
  for (const s of samples) {
    const day = localDay(s.t);
    let last = out[out.length - 1];
    if (!last || last.day !== day) {
      last = { day, ...emptyTotals() };
      out.push(last);
    }
    add(last, s);
  }
  return out;
}

export function monthlyTotals(samples: HourSample[]): MonthTotals[] {
  const out: MonthTotals[] = [];
  for (const s of samples) {
    const month = localMonth(s.t);
    let last = out[out.length - 1];
    if (!last || last.month !== month) {
      last = { month, expectedHours: 0, ...emptyTotals() };
      out.push(last);
    }
    add(last, s);
  }
  // Expected hours: the span covered within each month, so partial edge months aren't flagged.
  if (samples.length > 0) {
    const first = samples[0].t;
    const last = samples[samples.length - 1].t + HOUR_MS;
    for (const m of out) {
      const [y, mo] = m.month.split('-').map(Number);
      const start = Math.max(first, new Date(y, mo - 1, 1).getTime());
      const end = Math.min(last, new Date(y, mo, 1).getTime());
      m.expectedHours = Math.max(0, Math.round((end - start) / HOUR_MS));
    }
  }
  return out;
}

export function hourProfile(samples: HourSample[]): HourProfile {
  const sum = { house: new Array(24).fill(0), ev: new Array(24).fill(0), solar: new Array(24).fill(0) };
  const count = new Array(24).fill(0);
  for (const s of samples) {
    const h = new Date(s.t).getHours();
    sum.house[h] += s.house;
    sum.ev[h] += s.ev;
    sum.solar[h] += s.solar;
    count[h]++;
  }
  const avg = (arr: number[]) => arr.map((v, h) => (count[h] ? v / count[h] : 0));
  return { house: avg(sum.house), ev: avg(sum.ev), solar: avg(sum.solar) };
}

/** Thresholds for "this hour looks wrong". A home rarely averages 12 kW for a full hour; 22 kW is the largest AC home charger. */
export const LIMITS = { houseKwh: 12, evKwh: 22, nightSolarKwh: 0.05 };

export function runChecks(samples: HourSample[]): Check[] {
  const checks: Check[] = [];
  if (samples.length === 0) return checks;

  // 1. Gaps between consecutive hours.
  let missing = 0;
  const gapExamples: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const gap = Math.round((samples[i].t - samples[i - 1].t) / HOUR_MS) - 1;
    if (gap > 0) {
      missing += gap;
      if (gapExamples.length < 5) gapExamples.push(samples[i - 1].t + HOUR_MS);
    }
  }
  checks.push({
    id: 'gaps',
    ok: missing === 0,
    title: missing === 0 ? 'No missing hours' : `${hours(missing)} missing`,
    detail:
      missing === 0
        ? 'Every hour between the first and last sample has data.'
        : 'Usually Home Assistant was offline or the recorder was paused. Short gaps barely matter; long ones (weeks) skew the yearly totals.',
    examples: gapExamples,
  });

  // 2. Solar at night → time-zone shift or wrong sensor.
  const night = samples.filter((s) => {
    const h = new Date(s.t).getHours();
    return h >= 0 && h <= 3 && s.solar > LIMITS.nightSolarKwh;
  });
  checks.push({
    id: 'night-solar',
    ok: night.length === 0,
    title: night.length === 0 ? 'No solar production at night' : `Solar production at night in ${hours(night.length)}`,
    detail:
      night.length === 0
        ? 'Nothing produced between 00:00 and 04:00, as expected.'
        : 'Panels can’t produce between midnight and 4 am. Either the solar sensor is wrong, or this browser’s time zone differs from your home’s.',
    examples: night.slice(0, 5).map((s) => s.t),
  });

  // 3. Solar peak around midday → confirms the time zone.
  const profile = hourProfile(samples);
  const solarTotal = profile.solar.reduce((a, b) => a + b, 0);
  if (solarTotal > 0) {
    const peak = profile.solar.indexOf(Math.max(...profile.solar));
    const ok = peak >= 10 && peak <= 15;
    checks.push({
      id: 'solar-peak',
      ok,
      title: `Solar peaks at ${pad(peak)}:00`,
      detail: ok
        ? 'A midday peak means timestamps line up with your local time.'
        : 'Solar should peak between 10:00 and 15:00 (later in summer time). A peak this far off suggests a time-zone shift, which misplaces consumption against production.',
      examples: [],
    });
  } else {
    checks.push({
      id: 'solar-peak',
      ok: false,
      title: 'No solar production in the data',
      detail: 'Without solar, a battery can only save money by charging off-peak from the grid. If you do have panels, check the solar sensor.',
      examples: [],
    });
  }

  // 4. Implausible household spikes → meter reset or wrong unit (Wh read as kWh).
  const houseSpikes = samples.filter((s) => s.house > LIMITS.houseKwh);
  checks.push({
    id: 'house-spikes',
    ok: houseSpikes.length === 0,
    title: houseSpikes.length === 0 ? 'No implausible consumption spikes' : `${hours(houseSpikes.length)} above ${LIMITS.houseKwh} kWh household use`,
    detail:
      houseSpikes.length === 0
        ? `No hour exceeds ${LIMITS.houseKwh} kWh of household use.`
        : 'Averaging this much for a whole hour is rare for a home. Often a meter reset or a sensor reporting Wh as kWh. These hours inflate the battery size.',
    examples: houseSpikes.slice(0, 5).map((s) => s.t),
  });

  // 5. EV readings beyond any home charger.
  const evTotal = samples.reduce((a, s) => a + s.ev, 0);
  const evSpikes = samples.filter((s) => s.ev > LIMITS.evKwh);
  checks.push({
    id: 'ev',
    ok: evTotal > 0 && evSpikes.length === 0,
    title:
      evTotal === 0
        ? 'No EV charging in the data'
        : evSpikes.length === 0
          ? 'EV charging looks plausible'
          : `${hours(evSpikes.length)} of EV charging above ${LIMITS.evKwh} kWh`,
    detail:
      evTotal === 0
        ? 'If you have an EV charger, pick its energy sensor in step 1, otherwise its use is counted as household load.'
        : evSpikes.length === 0
          ? `No hour exceeds ${LIMITS.evKwh} kWh, the limit of a home charger.`
          : 'No home charger delivers this much in an hour. Check that the EV sensor is an energy (kWh) total, not a counter of something else.',
    examples: evSpikes.slice(0, 5).map((s) => s.t),
  });

  // 6. Hours with zero load → data missing rather than a real zero (a home always has base load).
  const zero = samples.filter((s) => s.house + s.ev < 0.01);
  const zeroShare = zero.length / samples.length;
  checks.push({
    id: 'zero-load',
    ok: zeroShare < 0.01,
    title: zero.length === 0 ? 'No zero-consumption hours' : `${hours(zero.length)} with zero consumption`,
    detail:
      zeroShare < 0.01
        ? 'A home always draws some standby power; zero-load hours are rare here.'
        : 'Fridges, routers and standby loads never stop, so zero usually means the grid or solar sensor didn’t report for that hour.',
    examples: zero.slice(0, 5).map((s) => s.t),
  });

  return checks;
}

function isoWithOffset(t: number): string {
  const d = new Date(t);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Hourly data in the same format the CSV import reads, so an export can be edited and re-imported. */
export function toCsv(samples: HourSample[]): string {
  const rows = samples.map(
    (s) => `${isoWithOffset(s.t)},${(s.house + s.ev).toFixed(3)},${s.solar.toFixed(3)},${s.ev.toFixed(3)}`,
  );
  return ['timestamp,consumption_kwh,solar_kwh,ev_kwh', ...rows].join('\n') + '\n';
}
