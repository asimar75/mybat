import type { HourSample } from '../engine/types';
import { HOUR_MS } from './derive';

/** Hours of overlap fetched before the end of the history, to check both sources agree. */
export const OVERLAP_HOURS = 7 * 24;

export interface MergeReport {
  samples: HourSample[];
  /** Hours taken from the new data (not already in the history). */
  added: number;
  firstAdded: number | null;
  lastAdded: number | null;
  /** Hours present in both; the history's values are kept for them. */
  overlap: number;
  /** New ÷ history over the overlap, for total use and solar; null when there's too little to compare. */
  useRatio: number | null;
  solarRatio: number | null;
  /** Empty hours between the end of the history and the first new hour. */
  gapHours: number;
  /** Added hours that took a T1/T2 register from the history's pattern. */
  registersFilled: number;
}

const use = (s: HourSample) => s.house + s.ev + (s.wh ?? 0);

/**
 * Appends new hours (e.g. from Home Assistant) to a history (e.g. HomeWizard CSV). Hours already in
 * the history keep their values; the overlap is only compared. When the history has T1/T2 registers
 * and the new data hasn't, each added hour takes the register most often used at that hour on the same
 * kind of day (weekday / weekend) in the last eight weeks of history.
 */
export function appendHistory(history: HourSample[], fresh: HourSample[]): MergeReport {
  const known = new Map(history.map((s) => [s.t, s]));
  const lastHistory = history.length ? history[history.length - 1].t : -Infinity;
  let overlapUse = [0, 0];
  let overlapSolar = [0, 0];
  let overlap = 0;
  const added: HourSample[] = [];
  for (const s of fresh) {
    const old = known.get(s.t);
    if (old) {
      overlap++;
      overlapUse = [overlapUse[0] + use(old), overlapUse[1] + use(s)];
      overlapSolar = [overlapSolar[0] + old.solar, overlapSolar[1] + s.solar];
    } else {
      added.push(s);
    }
  }

  const pattern = registerPattern(history);
  let registersFilled = 0;
  const filled = added.map((s) => {
    if (s.rate || !pattern) return s;
    const rate = pattern.get(slot(s.t));
    if (!rate) return s;
    registersFilled++;
    return { ...s, rate };
  });

  const samples = [...history, ...filled].sort((a, b) => a.t - b.t);
  const firstAfter = filled.find((s) => s.t > lastHistory);
  const ratio = ([a, b]: number[]) => (overlap >= 24 && a > 1 ? b / a : null);
  return {
    samples,
    added: filled.length,
    firstAdded: filled[0]?.t ?? null,
    lastAdded: filled[filled.length - 1]?.t ?? null,
    overlap,
    useRatio: ratio(overlapUse),
    solarRatio: ratio(overlapSolar),
    gapHours: firstAfter && Number.isFinite(lastHistory) ? Math.max(0, Math.round((firstAfter.t - lastHistory) / HOUR_MS) - 1) : 0,
    registersFilled,
  };
}

/** "weekday-14" / "weekend-14" for a timestamp, in local time. */
function slot(t: number): string {
  const d = new Date(t);
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  return `${weekend ? 'weekend' : 'weekday'}-${d.getHours()}`;
}

/** Most common register per slot over the history's last eight weeks, or null without registers. */
function registerPattern(history: HourSample[]): Map<string, 1 | 2> | null {
  if (!history.some((s) => s.rate)) return null;
  const since = history[history.length - 1].t - 8 * 7 * 24 * HOUR_MS;
  const counts = new Map<string, [number, number]>();
  for (const s of history) {
    if (s.t < since || !s.rate) continue;
    const c = counts.get(slot(s.t)) ?? [0, 0];
    c[s.rate - 1]++;
    counts.set(slot(s.t), c);
  }
  const out = new Map<string, 1 | 2>();
  for (const [k, [t1, t2]] of counts) out.set(k, t1 >= t2 ? 1 : 2);
  return out;
}
