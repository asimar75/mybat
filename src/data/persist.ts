import type { HourSample } from '../engine/types';
import { HOUR_MS } from './derive';

/**
 * Keeps the last loaded dataset in the browser so a page refresh doesn't lose it.
 *
 * Stored compactly (hour offsets + values rounded to 1 Wh) so a year fits in ~150 KB and several
 * years stay well within localStorage's ~5 MB limit.
 */

export interface SavedDataset {
  samples: HourSample[];
  label: string;
  notes: string[];
  savedAt: number;
}

interface Encoded {
  v: 1;
  label: string;
  notes: string[];
  savedAt: number;
  /** First timestamp (epoch ms). */
  t0: number;
  /** Hours since t0 for each sample (gaps allowed). */
  h: number[];
  house: number[];
  ev: number[];
  solar: number[];
  /** Water heater, only when the dataset has one. */
  wh?: number[];
  /** Tariff register per hour (0 unknown, 1 = T1, 2 = T2), only when known. */
  r?: number[];
}

const KEY = 'mybat.dataset';
const round = (v: number) => Math.round(v * 1000) / 1000;

export function encodeDataset(d: SavedDataset): string {
  const t0 = d.samples[0]?.t ?? 0;
  const enc: Encoded = {
    v: 1,
    label: d.label,
    notes: d.notes,
    savedAt: d.savedAt,
    t0,
    h: d.samples.map((s) => Math.round((s.t - t0) / HOUR_MS)),
    house: d.samples.map((s) => round(s.house)),
    ev: d.samples.map((s) => round(s.ev)),
    solar: d.samples.map((s) => round(s.solar)),
    ...(d.samples.some((s) => s.wh !== undefined) ? { wh: d.samples.map((s) => round(s.wh ?? 0)) } : {}),
    ...(d.samples.some((s) => s.rate) ? { r: d.samples.map((s) => s.rate ?? 0) } : {}),
  };
  return JSON.stringify(enc);
}

export function decodeDataset(raw: string): SavedDataset | null {
  try {
    const e = JSON.parse(raw) as Encoded;
    if (e?.v !== 1 || !Array.isArray(e.h)) return null;
    const n = e.h.length;
    if (e.house.length !== n || e.ev.length !== n || e.solar.length !== n) return null;
    if (e.wh && e.wh.length !== n) return null;
    if (e.r && e.r.length !== n) return null;
    const samples = e.h.map((h, i) => ({
      t: e.t0 + h * HOUR_MS,
      house: e.house[i],
      ev: e.ev[i],
      solar: e.solar[i],
      ...(e.wh ? { wh: e.wh[i] } : {}),
      ...(e.r && (e.r[i] === 1 || e.r[i] === 2) ? { rate: e.r[i] as 1 | 2 } : {}),
    }));
    return { samples, label: e.label, notes: e.notes ?? [], savedAt: e.savedAt };
  } catch {
    return null;
  }
}

/** Returns false when the browser refused (private mode, quota exceeded). */
export function saveDataset(d: SavedDataset): boolean {
  try {
    localStorage.setItem(KEY, encodeDataset(d));
    return true;
  } catch {
    try {
      localStorage.removeItem(KEY); // don't leave an older dataset that no longer matches the page
    } catch {
      /* storage unavailable */
    }
    return false;
  }
}

export function loadDataset(): SavedDataset | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? decodeDataset(raw) : null;
  } catch {
    return null;
  }
}

export function clearDataset() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}
