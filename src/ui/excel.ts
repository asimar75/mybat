import type { Sheet } from 'write-excel-file/browser';
import type { Scenario } from '../engine/scenario';
import { describeScenario, isNoChange } from '../engine/scenario';
import type { ReimbursementResult } from '../engine/reimbursement';
import type { Recommendation } from '../engine/sweep';
import type { BatterySpec, Economics, HourSample, SimOptions, Tariff } from '../engine/types';
import { hasMeterGrid, hasWaterHeater, monthlyTotals } from '../data/validate';
import { fmtDate, fmtDateTime, fmtMonth } from './format';

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
  waterHeater: { shift: boolean; maxKw: number };
  /** Employer EV reimbursement over the data period, or null when not used. */
  reimbursement: ReimbursementResult | null;
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
  const withWh = hasWaterHeater(input.samples);
  const withRate = input.samples.some((s) => s.rate);
  const withMeter = hasMeterGrid(input.samples);

  // ---- Summary ----
  const summary: Cell[][] = [
    [bold('Battery Sizer result'), text(fmtDateTime(input.generatedAt.getTime()))],
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
      [text(`Net benefit over ${economics.horizonYears} years${economics.discountRate ? ", today's money" : ''}`), num(focus.netBenefit, money)],
      [text('Cycles per year'), num(focus.annual.cycles, '0')],
      [text('Battery life until 70 % capacity (years)'), num(focus.lifeYears)],
      [text(`Replacements within ${economics.horizonYears} years`), num(focus.replacements, '0')],
      [text('Replacement cost'), num(focus.replacementCost, money)],
      [text('Value of life left at the end'), num(focus.residualValue, money)],
      [text('Self-sufficiency without → with battery'), text(`${Math.round(base.selfSufficiency * 100)} % → ${Math.round(focus.annual.selfSufficiency * 100)} %`)],
    );
  }
  summary.push(
    [],
    [bold('Data')],
    [text('Source'), text(input.dataLabel)],
    [text('Period'), text(`${fmtDate(first)} – ${fmtDate(last)}`)],
    [text('Hours of data'), num(input.samples.length, '#,##0')],
    ...(withMeter
      ? [
          [text('Grid import, meter (period)'), num(input.samples.reduce((a, s) => a + (s.gridIn ?? 0), 0), '#,##0')],
          [text('Grid export, meter (period)'), num(input.samples.reduce((a, s) => a + (s.gridOut ?? 0), 0), '#,##0')],
        ]
      : []),
    [text('Yearly consumption (kWh)'), num(base.totalLoadKwh, '#,##0')],
    [text('Yearly solar (kWh)'), num(base.solarKwh, '#,##0')],
    [text('Yearly bill without battery'), num(base.netCost, money)],
    [text('What-if scenario'), text(isNoChange(scenario) ? 'none (measured data)' : describeScenario(scenario))],
    ...(input.reimbursement
      ? [
          [text('EV reimbursement per year'), num(input.reimbursement.total * rec.annualFactor, money)],
          [text('Net cost after reimbursement, no battery'), num(base.netCost - input.reimbursement.total * rec.annualFactor, money)],
          ...(focus ? [[text(`Net cost after reimbursement, ${focus.nominalKwh} kWh battery`), num(focus.annual.netCost - input.reimbursement.total * rec.annualFactor, money)]] : []),
          [text('Note'), text('Reimbursement is paid on every EV kWh whatever its source, so it does not change battery savings or payback.')],
        ]
      : []),
    [text('Data checks'), text(input.failedChecks.length ? `Warnings: ${input.failedChecks.join('; ')}` : 'All passed')],
    [],
    [bold('Tariff')],
  );
  if (tariff.useTimeOfUse) {
    summary.push(
      [text('Peak price per kWh'), num(tariff.importPeak, '0.000')],
      [text('Off-peak price per kWh'), num(tariff.importOffPeak, '0.000')],
      [text('Peak hours'), text(tariff.useMeterRegisters && withRate ? `From the meter's registers (T${tariff.peakRegister ?? 1} = peak)` : `${tariff.peakStartHour}:00 – ${tariff.peakEndHour}:00`)],
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
    [text('Compared over (years)'), num(economics.horizonYears, '0')],
    [text('Rated cycles to 70 % capacity'), num(economics.cycleLife, '#,##0')],
    [text('Capacity loss per year from age'), num(economics.calendarLossPerYear, '0.00%')],
    [text("Replacement price, share of today's"), num(economics.replacementFraction, pct)],
    [text('Discount rate above inflation'), num(economics.discountRate, '0.0%')],
    [],
    [bold('Strategy')],
    [text('EV charger'), text(options.evMode === 'include' ? 'Battery may charge the car' : 'Battery never charges the car')],
    [text('Off-peak grid charging'), text(options.gridCharge && tariff.useTimeOfUse ? `Yes, up to ${Math.round(options.gridChargeTarget * 100)} %` : 'No')],
    [text('Water heater on solar surplus'), text(!withWh ? 'No separate water heater meter' : input.waterHeater.shift ? `Yes, up to ${input.waterHeater.maxKw} kW` : 'No (measured timing)')],
  );

  // ---- All sizes ----
  const sizes: Cell[][] = [
    header(['Size kWh', 'Usable kWh', 'Power kW', 'Cost', 'Saving / yr', 'Payback yrs', 'Net benefit', 'Self-sufficiency', 'Grid import kWh/yr', 'Grid export kWh/yr', 'Cycles / yr', 'Days full', 'Days empty', 'Lasts (years)', 'Replacements', 'Replacement cost', 'Value left at end']),
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
      ...(r.nominalKwh ? [num(r.lifeYears), num(r.replacements, '0'), num(r.replacementCost, money), num(r.residualValue, money)] : [text('—'), text('—'), text('—'), text('—')]),
    ]),
  ];

  // ---- Monthly ----
  const months = monthlyTotals(input.samples);
  const monthly: Cell[][] = [
    header([
      'Month', 'House kWh', 'EV kWh', ...(withWh ? ['Water heater kWh'] : []), 'Solar kWh',
      ...(withMeter ? ['Grid import, meter', 'Grid export, meter'] : []), 'Grid import, no battery (simulation)',
      ...(focus ? [`Grid import, ${focus.nominalKwh} kWh battery`] : []),
      ...(input.reimbursement ? ['EV reimbursement price', 'EV reimbursement'] : []),
      'Hours with data',
    ]),
    ...months.map((m) => [
      text(fmtMonth(m.month)),
      num(m.house),
      num(m.ev),
      ...(withWh ? [num(m.wh)] : []),
      num(m.solar),
      ...(withMeter ? [num(m.meterImport), num(m.meterExport)] : []),
      num(base.monthlyImport.get(m.month) ?? 0),
      ...(focus ? [num(focus.annual.monthlyImport.get(m.month) ?? 0)] : []),
      ...(input.reimbursement
        ? (() => {
            const r = input.reimbursement.byMonth.find((x) => x.month === m.month);
            return [num(r?.price ?? 0, '0.000'), num(r?.amount ?? 0, money)];
          })()
        : []),
      num(m.hours, '0'),
    ]),
  ];

  // ---- Hourly ----
  const hourly: Cell[][] = [
    header(['Time', 'House kWh', 'EV kWh', ...(withWh ? ['Water heater kWh'] : []), 'Solar kWh', ...(withRate ? ['Tariff register'] : [])]),
    ...input.samples.map((s) => [
      { value: localDate(s.t), type: Date, format: 'dd/mmm/yyyy hh:mm' } as Cell,
      num(s.house, '0.000'),
      num(s.ev, '0.000'),
      ...(withWh ? [num(s.wh ?? 0, '0.000')] : []),
      num(s.solar, '0.000'),
      ...(withRate ? [text(s.rate ? `T${s.rate}` : '')] : []),
    ]),
  ];

  return [
    { sheet: 'Summary', data: summary, columns: [{ width: 42 }, { width: 48 }] },
    { sheet: 'All sizes', data: sizes, columns: new Array(17).fill({ width: 15 }), stickyRowsCount: 1 },
    { sheet: 'Monthly', data: monthly, columns: [{ width: 10 }, ...new Array(11).fill({ width: 20 })], stickyRowsCount: 1 },
    { sheet: 'Hourly data', data: hourly, columns: [{ width: 18 }, ...new Array(4).fill({ width: 16 })], stickyRowsCount: 1 },
  ] as Sheet<Blob>[];
}

/** Builds the workbook and starts the download. The library is loaded only when this runs. */
export async function exportExcel(input: ExportInput, fileName: string): Promise<void> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  await writeXlsxFile(buildSheets(input)).toFile(fileName);
}
