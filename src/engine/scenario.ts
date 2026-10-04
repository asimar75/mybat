import type { HourSample } from './types';

/**
 * "What if" adjustments to the measured history. Each hour is scaled by the same factor, so the
 * daily and seasonal shape stays as measured: right for "use 10 % less" or "a second car with the
 * same habits", wrong for loads with their own timing (a heat pump is winter-heavy).
 */
export interface Scenario {
  /** Change to household use in percent (−100 … +∞). */
  householdPct: number;
  /** Change to EV charging in percent (−100 … +∞). */
  evPct: number;
}

export const NO_CHANGE: Scenario = { householdPct: 0, evPct: 0 };

const factor = (pct: number) => Math.max(0, 1 + (Number.isFinite(pct) ? pct : 0) / 100);

export function isNoChange(s: Scenario): boolean {
  return factor(s.householdPct) === 1 && factor(s.evPct) === 1;
}

export function applyScenario(samples: HourSample[], s: Scenario): HourSample[] {
  if (isNoChange(s)) return samples;
  const h = factor(s.householdPct);
  const e = factor(s.evPct);
  return samples.map((x) => ({ t: x.t, solar: x.solar, house: x.house * h, ev: x.ev * e }));
}

function signed(pct: number): string {
  const v = Math.max(-100, Math.round(pct));
  return v > 0 ? `+${v} %` : v < 0 ? `−${Math.abs(v)} %` : '±0 %';
}

export function describeScenario(s: Scenario): string {
  const parts: string[] = [];
  if (factor(s.householdPct) !== 1) parts.push(`household use ${signed(s.householdPct)}`);
  if (factor(s.evPct) !== 1) parts.push(`EV charging ${signed(s.evPct)}`);
  return parts.join(', ');
}
