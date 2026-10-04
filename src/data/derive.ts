import type { HourSample } from '../engine/types';
import type { StatisticPoint } from './homeassistant';

export const HOUR_MS = 3600 * 1000;

export interface StatSelection {
  gridImport: string[];
  gridExport: string[];
  solar: string[];
  batteryOut: string[];
  batteryIn: string[];
  /** Statistic id of the EV charger, or empty for none. */
  ev: string;
  /** Statistic id of a separately metered water heater, or empty/absent for none. */
  wh?: string;
}

export interface DeriveReport {
  samples: HourSample[];
  /** Hours in the requested range with no grid or solar data at all (HA offline, etc.). */
  missingHours: number;
  /** Hours where the EV meter read higher than total consumption (meter mismatch). */
  evClampedHours: number;
  /** Hours where EV + water heater read higher than total consumption. */
  whClampedHours: number;
}

function toMs(start: number | string): number {
  return typeof start === 'number' ? (start < 1e12 ? start * 1000 : start) : Date.parse(start);
}

function indexByHour(points: StatisticPoint[] | undefined): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of points ?? []) {
    const t = Math.floor(toMs(p.start) / HOUR_MS) * HOUR_MS;
    const v = typeof p.change === 'number' && Number.isFinite(p.change) ? Math.max(0, p.change) : 0;
    m.set(t, (m.get(t) ?? 0) + v);
  }
  return m;
}

/**
 * Turns Home Assistant hourly statistics into household samples.
 *
 * Total consumption = grid import − grid export + solar + battery discharge − battery charge.
 * House consumption is that total minus the EV charger.
 */
export function deriveSamples(stats: Record<string, StatisticPoint[]>, sel: StatSelection): DeriveReport {
  const sumOf = (ids: string[]) => ids.map((id) => indexByHour(stats[id]));
  const gi = sumOf(sel.gridImport);
  const ge = sumOf(sel.gridExport);
  const so = sumOf(sel.solar);
  const bo = sumOf(sel.batteryOut);
  const bi = sumOf(sel.batteryIn);
  const ev = sel.ev ? indexByHour(stats[sel.ev]) : new Map<number, number>();
  const wh = sel.wh ? indexByHour(stats[sel.wh]) : null;

  const primary = [...gi, ...ge, ...so];
  const hours = new Set<number>();
  for (const m of primary) for (const t of m.keys()) hours.add(t);
  const sorted = [...hours].sort((a, b) => a - b);
  if (sorted.length === 0) return { samples: [], missingHours: 0, evClampedHours: 0, whClampedHours: 0 };

  const total = (maps: Map<number, number>[], t: number) => maps.reduce((acc, m) => acc + (m.get(t) ?? 0), 0);
  const span = (sorted[sorted.length - 1] - sorted[0]) / HOUR_MS + 1;

  let evClampedHours = 0;
  let whClampedHours = 0;
  const samples: HourSample[] = sorted.map((t) => {
    const solar = total(so, t);
    const consumption = Math.max(0, total(gi, t) - total(ge, t) + solar + total(bo, t) - total(bi, t));
    let evKwh = ev.get(t) ?? 0;
    if (evKwh > consumption + 0.05) evClampedHours++;
    evKwh = Math.min(evKwh, consumption);
    if (!wh) return { t, solar, ev: evKwh, house: consumption - evKwh };
    let whKwh = wh.get(t) ?? 0;
    if (whKwh > consumption - evKwh + 0.05) whClampedHours++;
    whKwh = Math.min(whKwh, consumption - evKwh);
    return { t, solar, ev: evKwh, wh: whKwh, house: consumption - evKwh - whKwh };
  });

  return { samples, missingHours: Math.max(0, span - sorted.length), evClampedHours, whClampedHours };
}
