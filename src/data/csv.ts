import type { HourSample } from '../engine/types';
import { HOUR_MS } from './derive';

/**
 * CSV import for when Home Assistant isn't reachable (or for data from an inverter portal).
 *
 * Required: a `timestamp` column plus either
 *   - `consumption_kwh` (total home use INCLUDING the EV), or
 *   - `grid_import_kwh` and `grid_export_kwh` (consumption is then derived using solar).
 * Optional: `solar_kwh`, `ev_kwh`, `water_heater_kwh` (a separately metered water heater; included in consumption).
 *
 * Rows may be any interval (15 min, 1 h…); values are energy per row and get summed into hours.
 * Semicolon-separated files with decimal commas (common in Europe) are handled.
 */

export const CSV_TEMPLATE = `timestamp,consumption_kwh,solar_kwh,ev_kwh,water_heater_kwh
2025-06-01T00:00,0.42,0,0,0
2025-06-01T01:00,1.05,0,0,0.70
2025-06-01T12:00,0.80,3.10,0,0
2025-06-01T19:00,8.40,0.15,7.20,0
`;

const ALIASES: Record<string, string[]> = {
  timestamp: ['timestamp', 'time', 'date', 'datetime', 'start', 'period'],
  consumption: ['consumption_kwh', 'consumption', 'load', 'load_kwh', 'total_consumption'],
  gridImport: ['grid_import_kwh', 'grid_import', 'import', 'import_kwh', 'from_grid'],
  gridExport: ['grid_export_kwh', 'grid_export', 'export', 'export_kwh', 'to_grid'],
  solar: ['solar_kwh', 'solar', 'pv', 'pv_kwh', 'production', 'production_kwh'],
  ev: ['ev_kwh', 'ev', 'car', 'ev_charger', 'charger_kwh'],
  wh: ['water_heater_kwh', 'water_heater', 'wh_kwh', 'dhw_kwh', 'hot_water_kwh', 'boiler_kwh'],
  rate: ['tariff_register', 'register', 'tariff'],
};

export interface CsvResult {
  samples: HourSample[];
  rows: number;
  skipped: number;
}

function findColumn(headers: string[], key: string): number {
  return headers.findIndex((h) => ALIASES[key].includes(h));
}

export function parseCsv(text: string): CsvResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('The CSV needs a header row and at least one data row.');

  const delimiter = lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ',';
  const decimalComma = delimiter !== ',';
  const headers = lines[0].split(delimiter).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));

  const col = {
    t: findColumn(headers, 'timestamp'),
    consumption: findColumn(headers, 'consumption'),
    gi: findColumn(headers, 'gridImport'),
    ge: findColumn(headers, 'gridExport'),
    solar: findColumn(headers, 'solar'),
    ev: findColumn(headers, 'ev'),
    wh: findColumn(headers, 'wh'),
    rate: findColumn(headers, 'rate'),
  };
  if (col.t < 0) throw new Error('No timestamp column found (expected a header named "timestamp").');
  if (col.consumption < 0 && col.gi < 0) {
    throw new Error('Need either a "consumption_kwh" column or "grid_import_kwh" + "grid_export_kwh" columns.');
  }

  const num = (cells: string[], i: number): number => {
    if (i < 0) return 0;
    let raw = (cells[i] ?? '').trim().replace(/^"|"$/g, '');
    if (decimalComma) raw = raw.replace(',', '.');
    const v = Number(raw);
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  };

  const hours = new Map<number, { consumption: number; solar: number; ev: number; wh: number; gi: number; ge: number; rate?: 1 | 2 }>();
  // With a consumption column, grid columns are kept as measured meter values.
  const measuredGrid = col.consumption >= 0 && col.gi >= 0 && col.ge >= 0;
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(delimiter);
    const ts = Date.parse((cells[col.t] ?? '').trim().replace(/^"|"$/g, '').replace(' ', 'T'));
    if (!Number.isFinite(ts)) {
      skipped++;
      continue;
    }
    const solar = num(cells, col.solar);
    const consumption =
      col.consumption >= 0 ? num(cells, col.consumption) : Math.max(0, num(cells, col.gi) - num(cells, col.ge) + solar);
    const hour = Math.floor(ts / HOUR_MS) * HOUR_MS;
    const h = hours.get(hour) ?? { consumption: 0, solar: 0, ev: 0, wh: 0, gi: 0, ge: 0 };
    h.consumption += consumption;
    h.solar += solar;
    h.ev += num(cells, col.ev);
    h.wh += num(cells, col.wh);
    if (measuredGrid) {
      h.gi += num(cells, col.gi);
      h.ge += num(cells, col.ge);
    }
    const reg = col.rate >= 0 ? Number((cells[col.rate] ?? '').trim()) : 0;
    if (reg === 1 || reg === 2) h.rate = reg;
    hours.set(hour, h);
  }

  const samples = [...hours.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, h]) => {
      const ev = Math.min(h.ev, h.consumption);
      const rate = { ...(h.rate ? { rate: h.rate } : {}), ...(measuredGrid ? { gridIn: h.gi, gridOut: h.ge } : {}) };
      if (col.wh < 0) return { t, solar: h.solar, ev, house: h.consumption - ev, ...rate };
      const wh = Math.min(h.wh, h.consumption - ev);
      return { t, solar: h.solar, ev, wh, house: h.consumption - ev - wh, ...rate };
    });
  if (samples.length === 0) throw new Error('No rows with a readable timestamp were found.');
  return { samples, rows: lines.length - 1, skipped };
}
