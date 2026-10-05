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
  return samples.map((x) => ({ ...x, house: x.house * h, ev: x.ev * e, wh: (x.wh ?? 0) * h }));
}

/**
 * Moves each day's water-heater energy into hours with surplus solar (after house and EV),
 * at most `maxKw` per hour, earliest sunny hours first. Whatever doesn't fit keeps its original
 * timing, scaled down. Daily energy is unchanged; tank heat-loss differences are ignored.
 */
export function shiftWaterHeater(samples: HourSample[], maxKw: number): HourSample[] {
  if (!samples.some((s) => (s.wh ?? 0) > 0)) return samples;
  const out = samples.map((s) => ({ ...s, wh: s.wh ?? 0 }));
  const limit = Math.max(0, maxKw);
  let i = 0;
  while (i < out.length) {
    const day = new Date(out[i].t).toDateString();
    let j = i;
    while (j < out.length && new Date(out[j].t).toDateString() === day) j++;
    const hours = out.slice(i, j);
    const energy = hours.reduce((a, s) => a + s.wh, 0);
    if (energy > 0) {
      const shifted = new Array(hours.length).fill(0);
      let left = energy;
      hours.forEach((s, k) => {
        const surplus = s.solar - s.house - s.ev;
        if (left > 0 && surplus > 0) {
          shifted[k] = Math.min(surplus, limit, left);
          left -= shifted[k];
        }
      });
      const rest = left / energy; // share that keeps its original timing
      hours.forEach((s, k) => (s.wh = shifted[k] + s.wh * rest));
    }
    i = j;
  }
  return out;
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
