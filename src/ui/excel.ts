import type { Sheet } from 'write-excel-file/browser';
import type { Scenario } from '../engine/scenario';
import { describeScenario, isNoChange } from '../engine/scenario';
import type { Recommendation } from '../engine/sweep';
import type { BatterySpec, Economics, HourSample, SimOptions, Tariff } from '../engine/types';
import { monthlyTotals } from '../data/validate';

/** Everything the export needs; built by main.ts from the current page state. */
export interface ExportInput {
  rec: Recommendation;
  /** Samples the result was computed from (scenario already applied). */
  samples: HourSample[];
  dataLabel: string;
  tariff: Tariff;
  economics: Economics;
  template: Omit<BatterySpec, 'nominalKwh'>;
  options: SimOptions;
  scenario: Scenario;
  currency: string;
  failedChecks: string[];
  generatedAt: Date;
}

type Cell = { value?: string | number | boolean | Date; type?: NumberConstructor | StringConstructor | DateConstructor; format?: string; fontWeight?: 'bold' } | null;

const bold = (value: string): Cell => ({ value, fontWeight: 'bold' });
const text = (value: string): Cell => ({ value, type: String });
const num = (value: number, format = '#,##0.0'): Cell =>
  Number.isFinite(value) ? { value, type: Number, format } : { value: 'never', type: String };
const header = (labels: string[]): Cell[] => labels.map(bold);

/** Excel dates have no time zone; shift so the cell shows the wall-clock time the data was recorded in. */
function localDate(t: number): Date {
  return new Date(t - new Date(t).getTimezoneOffset() * 60_000);
}

export function buildSheets(input: ExportInput): Sheet<Blob>[] {
  const { rec, tariff, economics, template, options, scenario, currency } = input;
  const money = `"${currency.replace(/"/g, '')}"#,##0`;
  const pct = '0%';
  const focus = rec.best ?? rec.knee;
  const base = rec.baseline.annual;
  const first = input.samples[0]?.t ?? 0;
  const last = input.samples[input.samples.length - 1]?.t ?? 0;

  // ---- Summary ----
  const summary: Cell[][] = [
    [bold('Battery Sizer result'), text(input.generatedAt.toLocaleString())],
    [],
    [bold('Recommendation')],
    [text('Verdict'), text(rec.best ? 'Best value' : 'No size pays back within the lifetime')],
    [text('Recommended size (kWh)'), rec.best ? num(rec.best.nominalKwh) : text('—')],
    [text('90 % of max saving at (kWh)'), rec.knee ? num(rec.knee.nominalKwh) : text('—')],
  ];
  if (focus) {
    summary.push(
      [text(`Investment (${focus.nominalKwh} kWh)`), num(focus.investment, money)],
      [text('Saving in year one'), num(focus.annualSavings, money)],
      [text('Simple payback (years)'), num(focus.paybackYears)],
      [text(`Net benefit over ${economics.lifetimeYears} years`), num(focus.netBenefit, money)],
      [text('Self-sufficiency without → with battery'), text(`${Math.round(base.selfSufficiency * 100)} % → ${Math.round(focus.annual.selfSufficiency * 100)} %`)],
    );
  }
  summary.push(
    [],
    [bold('Data')],
    [text('Source'), text(input.dataLabel)],
    [text('Period'), text(`${new Date(first).toLocaleDateString()} – ${new Date(last).toLocaleDateString()}`)],
    [text('Hours of data'), num(input.samples.length, '#,##0')],
    [text('Yearly consumption (kWh)'), num(base.totalLoadKwh, '#,##0')],
    [text('Yearly solar (kWh)'), num(base.solarKwh, '#,##0')],
    [text('Yearly bill without battery'), num(base.netCost, money)],
    [text('What-if scenario'), text(isNoChange(scenario) ? 'none (measured data)' : describeScenario(scenario))],
    [text('Data checks'), text(input.failedChecks.length ? `Warnings: ${input.failedChecks.join('; ')}` : 'All passed')],
    [],
    [bold('Tariff')],
  );
  if (tariff.useTimeOfUse) {
    summary.push(
      [text('Peak price per kWh'), num(tariff.importPeak, '0.000')],
      [text('Off-peak price per kWh'), num(tariff.importOffPeak, '0.000')],
      [text('Peak hours'), text(`${tariff.peakStartHour}:00 – ${tariff.peakEndHour}:00`)],
    );
  } else {
    summary.push([text('Import price per kWh'), num(tariff.importFlat, '0.000')]);
  }
  summary.push(
    [text('Export price per kWh'), num(tariff.exportPrice, '0.000')],
    [],
    [bold('Battery & cost')],
    [text('Price per kWh of battery'), num(economics.costPerKwh, money)],
    [text('Fixed cost'), num(economics.fixedCost, money)],
    [text('Usable capacity'), num(template.usableFraction, pct)],
    [text('Round-trip efficiency'), num(template.roundTripEfficiency, pct)],
    [text('Inverter max power (kW)'), num(template.inverterKw)],
    [text('C-rate'), num(template.cRate, '0.00')],
    [text('Lifetime (years)'), num(economics.lifetimeYears, '0')],
    [text('Capacity loss per year'), num(economics.degradationPerYear, '0.0%')],
    [],
    [bold('Strategy')],
    [text('EV charger'), text(options.evMode === 'include' ? 'Battery may charge the car' : 'Battery never charges the car')],
    [text('Off-peak grid charging'), text(options.gridCharge && tariff.useTimeOfUse ? `Yes, up to ${Math.round(options.gridChargeTarget * 100)} %` : 'No')],
  );

  // ---- All sizes ----
  const sizes: Cell[][] = [
    header(['Size kWh', 'Usable kWh', 'Power kW', 'Cost', 'Saving / yr', 'Payback yrs', 'Net benefit', 'Self-sufficiency', 'Grid import kWh/yr', 'Grid export kWh/yr', 'Cycles / yr', 'Days full', 'Days empty']),
    ...rec.rows.map((r) => [
      num(r.nominalKwh),
      num(r.usableKwh),
      num(r.powerKw),
      num(r.investment, money),
      num(r.annualSavings, money),
      r.nominalKwh ? num(r.paybackYears) : text('—'),
      r.nominalKwh ? num(r.netBenefit, money) : text('—'),
      num(r.annual.selfSufficiency, pct),
      num(r.annual.importKwh, '#,##0'),
      num(r.annual.exportKwh, '#,##0'),
      num(r.annual.cycles, '0'),
      num(r.annual.days ? r.annual.daysFull / r.annual.days : 0, pct),
      num(r.annual.days ? r.annual.daysEmpty / r.annual.days : 0, pct),
    ]),
  ];

  // ---- Monthly ----
  const months = monthlyTotals(input.samples);
  const monthly: Cell[][] = [
    header([
      'Month', 'House kWh', 'EV kWh', 'Solar kWh', 'Grid import, no battery',
      ...(focus ? [`Grid import, ${focus.nominalKwh} kWh battery`] : []), 'Hours with data',
    ]),
    ...months.map((m) => [
      text(m.month),
      num(m.house),
      num(m.ev),
      num(m.solar),
      num(base.monthlyImport.get(m.month) ?? 0),
      ...(focus ? [num(focus.annual.monthlyImport.get(m.month) ?? 0)] : []),
      num(m.hours, '0'),
    ]),
  ];

  // ---- Hourly ----
  const hourly: Cell[][] = [
    header(['Time', 'House kWh', 'EV kWh', 'Solar kWh']),
    ...input.samples.map((s) => [
      { value: localDate(s.t), type: Date, format: 'yyyy-mm-dd hh:mm' } as Cell,
      num(s.house, '0.000'),
      num(s.ev, '0.000'),
      num(s.solar, '0.000'),
    ]),
  ];

  return [
    { sheet: 'Summary', data: summary, columns: [{ width: 42 }, { width: 48 }] },
    { sheet: 'All sizes', data: sizes, columns: new Array(13).fill({ width: 15 }), stickyRowsCount: 1 },
    { sheet: 'Monthly', data: monthly, columns: [{ width: 10 }, ...new Array(6).fill({ width: 20 })], stickyRowsCount: 1 },
    { sheet: 'Hourly data', data: hourly, columns: [{ width: 18 }, { width: 12 }, { width: 12 }, { width: 12 }], stickyRowsCount: 1 },
  ] as Sheet<Blob>[];
}

/** Builds the workbook and starts the download. The library is loaded only when this runs. */
export async function exportExcel(input: ExportInput, fileName: string): Promise<void> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  await writeXlsxFile(buildSheets(input)).toFile(fileName);
}
