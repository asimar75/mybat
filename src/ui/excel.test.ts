import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import writeXlsxFile from 'write-excel-file/node';
import { prepare } from '../engine/simulate';
import { sizeRange, sweep } from '../engine/sweep';
import type { Tariff } from '../engine/types';
import { demoYear } from '../data/demo';
import { buildSheets, type ExportInput } from './excel';

const tariff: Tariff = { importFlat: 0.3, useTimeOfUse: false, importPeak: 0, importOffPeak: 0, peakStartHour: 7, peakEndHour: 23, exportPrice: 0.08 };
const template = { usableFraction: 0.95, inverterKw: 5, cRate: 0.5, roundTripEfficiency: 0.9 };
const economics = { costPerKwh: 300, fixedCost: 1000, lifetimeYears: 12, degradationPerYear: 0.02 };
const options = { evMode: 'exclude' as const, gridCharge: false, gridChargeTarget: 1 };

function input(): ExportInput {
  const samples = demoYear(2025);
  const rec = sweep(prepare(samples), template, sizeRange(10, 5), tariff, options, economics);
  return {
    rec, samples, dataLabel: 'demo year', tariff, economics, template, options,
    scenario: { householdPct: 10, evPct: 0 }, waterHeater: { shift: false, maxKw: 1 }, reimbursement: null, currency: '€', failedChecks: [], generatedAt: new Date(2026, 0, 1),
  };
}

describe('Excel export', () => {
  it('builds four sheets with the expected rows', () => {
    const sheets = buildSheets(input());
    expect(sheets.map((s) => s.sheet)).toEqual(['Summary', 'All sizes', 'Monthly', 'Hourly data']);
    expect(sheets[1].data).toHaveLength(1 + 3); // header + sizes 0, 5, 10
    expect(sheets[2].data).toHaveLength(1 + 12);
    expect(sheets[3].data).toHaveLength(1 + 8760);
    const flat = JSON.stringify(sheets[0].data);
    expect(flat).toContain('household use +10 %');
    expect(flat).toContain('demo year');
    expect(JSON.stringify(sheets[3].data[0])).toContain('Water heater kWh'); // demo has a metered water heater
  });

  it('writes a valid .xlsx whose first hour shows local midnight', async () => {
    const buffer = await writeXlsxFile(buildSheets(input())).toBuffer();
    const files = unzipSync(new Uint8Array(buffer));
    const workbook = strFromU8(files['xl/workbook.xml']);
    for (const name of ['Summary', 'All sizes', 'Monthly', 'Hourly data']) expect(workbook).toContain(`name="${name}"`);
    // Excel serial for 2025-01-01 00:00 is 45658, whatever time zone the test runs in.
    const hourly = strFromU8(files['xl/worksheets/sheet4.xml']);
    const firstTime = hourly.match(/<c r="A2"[^>]*><v>([\d.]+)<\/v>/)?.[1];
    expect(Number(firstTime)).toBeCloseTo(45658, 6);
  });

  it('adds reimbursement rows and monthly columns when used', async () => {
    const { reimbursement } = await import('../engine/reimbursement');
    const base = input();
    const r = reimbursement(base.samples, { defaultPrice: 0.25, months: { '2025-07': 0.3 } });
    const sheets = buildSheets({ ...base, reimbursement: r });
    expect(JSON.stringify(sheets[0].data)).toContain('EV reimbursement per year');
    expect(JSON.stringify(sheets[2].data[0])).toContain('EV reimbursement price');
    const july = sheets[2].data.find((row) => JSON.stringify(row).includes('Jul/2025'))!;
    expect(JSON.stringify(july)).toContain('"value":0.3');
  });
});
