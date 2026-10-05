import { batteryPowerKw, simulate, usableKwh, type PreparedData } from './simulate';
import type { BatterySpec, Economics, SimOptions, SimResult, Tariff } from './types';

export interface SweepRow {
  nominalKwh: number;
  usableKwh: number;
  powerKw: number;
  /** Simulation result scaled to one year. */
  annual: SimResult;
  /** Yearly bill reduction versus no battery (first year). */
  annualSavings: number;
  investment: number;
  /** Capacity lost per year: ageing plus wear from this size's cycles. */
  fadePerYear: number;
  /** Years until the battery is down to END_OF_LIFE capacity and gets replaced. */
  lifeYears: number;
  /** Replacements within the horizon and what they cost (present value). */
  replacements: number;
  replacementCost: number;
  /** Straight-line value of the life left in the last battery when the horizon ends (present value). */
  residualValue: number;
  /** Savings summed over the horizon, as capacity fades and batteries are replaced (present value). */
  lifetimeSavings: number;
  /** lifetimeSavings − investment − replacementCost + residualValue */
  netBenefit: number;
  /** Simple payback in years; Infinity when savings ≤ 0. */
  paybackYears: number;
  /**
   * Years until discounted savings (fading with the battery) repay the purchase plus any replacement
   * bought before that; Infinity if never. Ignores the leftover value, unlike the net benefit.
   */
  discountedPaybackYears: number;
}

export interface Recommendation {
  /** Size with the highest lifetime net benefit, or null if no size pays for itself. */
  best: SweepRow | null;
  /** Smallest size capturing ≥ 90 % of the largest achievable yearly saving. */
  knee: SweepRow | null;
  baseline: SweepRow;
  rows: SweepRow[];
  /** Factor used to scale the dataset to one year. */
  annualFactor: number;
}

export function sizeRange(maxKwh: number, stepKwh: number): number[] {
  const step = Math.max(0.5, stepKwh);
  const sizes = [0];
  for (let s = step; s <= maxKwh + 1e-9; s += step) sizes.push(Math.round(s * 10) / 10);
  return sizes;
}

/** Converts a multi-hour dataset into "per year" numbers. */
export function annualFactorFor(data: PreparedData): number {
  return data.samples.length > 0 ? 8760 / data.samples.length : 1;
}

function scale(r: SimResult, f: number): SimResult {
  // monthlyImport stays unscaled: it reports actual calendar months.
  const monthlyImport = new Map(r.monthlyImport);
  return {
    ...r,
    importKwh: r.importKwh * f,
    exportKwh: r.exportKwh * f,
    importCost: r.importCost * f,
    exportRevenue: r.exportRevenue * f,
    netCost: r.netCost * f,
    chargedFromSolarKwh: r.chargedFromSolarKwh * f,
    chargedFromGridKwh: r.chargedFromGridKwh * f,
    dischargedKwh: r.dischargedKwh * f,
    totalLoadKwh: r.totalLoadKwh * f,
    solarKwh: r.solarKwh * f,
    cycles: r.cycles * f,
    monthlyImport,
  };
}

/** How far ahead discounted payback is searched before it counts as never. */
const PAYBACK_SEARCH_YEARS = 60;

/** Capacity left when a home battery counts as worn out (the usual warranty threshold). */
export const END_OF_LIFE = 0.7;

/**
 * Capacity lost per year: ageing plus cycling wear, where `cycleLife` full cycles use up the
 * whole 30 % down to END_OF_LIFE. A bigger battery cycles less, so it wears more slowly.
 */
export function fadePerYear(cyclesPerYear: number, economics: Economics): number {
  return economics.calendarLossPerYear + ((1 - END_OF_LIFE) * cyclesPerYear) / Math.max(1, economics.cycleLife);
}

/** First-year saving of a battery of any size, interpolated between the simulated sizes. */
function savingsAt(rows: { nominalKwh: number; annualSavings: number }[], kwh: number): number {
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (kwh <= b.nominalKwh) return a.annualSavings + ((b.annualSavings - a.annualSavings) * (kwh - a.nominalKwh)) / (b.nominalKwh - a.nominalKwh);
  }
  return rows[rows.length - 1]?.annualSavings ?? 0;
}

/**
 * Year by year over the horizon: capacity fades, so a battery saves what a smaller new one would
 * (an oversized battery barely notices); at END_OF_LIFE it is replaced, and whatever life the last
 * one has left at the end is credited at its straight-line value. All amounts are present values:
 * savings at the end of each year, replacements when they happen, leftover value at the horizon.
 */
export function lifecycle(
  row: { nominalKwh: number; investment: number; annual: SimResult },
  rows: { nominalKwh: number; annualSavings: number }[],
  economics: Economics,
): Pick<SweepRow, 'fadePerYear' | 'lifeYears' | 'replacements' | 'replacementCost' | 'residualValue' | 'lifetimeSavings' | 'discountedPaybackYears'> {
  const fade = fadePerYear(row.annual.cycles, economics);
  const lifeYears = fade > 0 ? (1 - END_OF_LIFE) / fade : Infinity;
  if (row.nominalKwh === 0) {
    return { fadePerYear: 0, lifeYears: Infinity, replacements: 0, replacementCost: 0, residualValue: 0, lifetimeSavings: 0, discountedPaybackYears: Infinity };
  }
  const horizon = Math.floor(economics.horizonYears);
  const presentValue = (amount: number, years: number) => amount * Math.pow(1 + economics.discountRate, -years);
  let age = 0;
  let lastPrice = row.investment;
  let replacements = 0;
  let replacementCost = 0;
  let lifetimeSavings = 0;
  let residualValue = 0;
  // Discounted payback keeps counting past the horizon (up to PAYBACK_SEARCH_YEARS), like simple payback.
  let stillOwed = row.investment;
  let discountedPaybackYears = Infinity;
  for (let y = 0; y < Math.max(horizon, PAYBACK_SEARCH_YEARS) && (y < horizon || discountedPaybackYears === Infinity); y++) {
    if (age >= lifeYears - 1e-9) {
      lastPrice = row.investment * economics.replacementFraction;
      const cost = presentValue(lastPrice, y);
      if (y < horizon) {
        replacements++;
        replacementCost += cost;
      }
      stillOwed += cost;
      age = 0;
    }
    const capacity = Math.max(END_OF_LIFE, 1 - fade * (age + 0.5));
    const saving = presentValue(savingsAt(rows, row.nominalKwh * capacity), y + 1);
    if (y < horizon) lifetimeSavings += saving;
    if (discountedPaybackYears === Infinity && saving > 0) {
      if (saving >= stillOwed) discountedPaybackYears = y + Math.max(0, stillOwed) / saving;
      stillOwed -= saving;
    }
    age++;
    if (y === horizon - 1) {
      const leftover = Number.isFinite(lifeYears) ? lastPrice * Math.max(0, 1 - age / lifeYears) : lastPrice;
      residualValue = presentValue(leftover, horizon);
    }
  }
  return { fadePerYear: fade, lifeYears, replacements, replacementCost, residualValue, lifetimeSavings, discountedPaybackYears };
}

export function sweep(
  data: PreparedData,
  template: Omit<BatterySpec, 'nominalKwh'>,
  sizes: number[],
  tariff: Tariff,
  options: SimOptions,
  economics: Economics,
): Recommendation {
  const f = annualFactorFor(data);
  // Size 0 must run first: it is the no-battery baseline every other size is compared to.
  const allSizes = [...new Set([0, ...sizes])].sort((a, b) => a - b);

  let baselineCost = 0;
  const simulated = allSizes.map((nominalKwh) => {
    const spec: BatterySpec = { ...template, nominalKwh };
    const annual = scale(simulate(data, spec, tariff, options), f);
    if (nominalKwh === 0) baselineCost = annual.netCost;
    const annualSavings = nominalKwh === 0 ? 0 : baselineCost - annual.netCost;
    const investment = nominalKwh === 0 ? 0 : economics.fixedCost + economics.costPerKwh * nominalKwh;
    return { nominalKwh, usableKwh: usableKwh(spec), powerKw: batteryPowerKw(spec), annual, annualSavings, investment };
  });
  // Lifecycle needs every size's saving: a worn battery saves what a smaller new one would.
  const rows: SweepRow[] = simulated.map((r) => {
    const life = lifecycle(r, simulated, economics);
    return {
      ...r,
      ...life,
      netBenefit: life.lifetimeSavings - r.investment - life.replacementCost + life.residualValue,
      paybackYears: r.annualSavings > 0 ? r.investment / r.annualSavings : Infinity,
    };
  });

  const baseline = rows[0];
  const candidates = rows.filter((r) => r.nominalKwh > 0);

  let best: SweepRow | null = null;
  for (const r of candidates) {
    if (r.netBenefit > 0 && (!best || r.netBenefit > best.netBenefit)) best = r;
  }

  const maxSavings = Math.max(0, ...candidates.map((r) => r.annualSavings));
  const knee = maxSavings > 0 ? candidates.find((r) => r.annualSavings >= 0.9 * maxSavings) ?? null : null;

  return { best, knee, baseline, rows, annualFactor: f };
}
