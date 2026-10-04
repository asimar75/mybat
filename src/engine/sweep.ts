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
  /** Savings summed over the lifetime, with degradation applied. */
  lifetimeSavings: number;
  /** lifetimeSavings − investment */
  netBenefit: number;
  /** Simple payback in years; Infinity when savings ≤ 0. */
  paybackYears: number;
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

/** Sum of (1 − d)^y for y = 0 … years−1: how many "first-year savings" a lifetime is worth. */
export function lifetimeMultiplier(years: number, degradation: number): number {
  let total = 0;
  for (let y = 0; y < Math.floor(years); y++) total += Math.pow(1 - degradation, y);
  return total;
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
  const multiplier = lifetimeMultiplier(economics.lifetimeYears, economics.degradationPerYear);

  let baselineCost = 0;
  const rows: SweepRow[] = allSizes.map((nominalKwh) => {
    const spec: BatterySpec = { ...template, nominalKwh };
    const annual = scale(simulate(data, spec, tariff, options), f);
    if (nominalKwh === 0) baselineCost = annual.netCost;
    const annualSavings = nominalKwh === 0 ? 0 : baselineCost - annual.netCost;
    const investment = nominalKwh === 0 ? 0 : economics.fixedCost + economics.costPerKwh * nominalKwh;
    const lifetimeSavings = annualSavings * multiplier;
    return {
      nominalKwh,
      usableKwh: usableKwh(spec),
      powerKw: batteryPowerKw(spec),
      annual,
      annualSavings,
      investment,
      lifetimeSavings,
      netBenefit: lifetimeSavings - investment,
      paybackYears: annualSavings > 0 ? investment / annualSavings : Infinity,
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
