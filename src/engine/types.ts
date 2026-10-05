/** One hour of energy flows, all values in kWh for that hour. */
export interface HourSample {
  /** Start of the hour, epoch milliseconds. */
  t: number;
  /** Household consumption excluding the EV charger and the water heater. */
  house: number;
  /** Solar production. */
  solar: number;
  /** EV charger consumption. */
  ev: number;
  /** Water heater consumption, when it has its own meter (otherwise it's inside `house`). */
  wh?: number;
  /** Tariff register (1 = T1, 2 = T2) the grid meter counted this hour's import on, when known. */
  rate?: 1 | 2;
  /**
   * Grid import/export as measured by the meter, when a grid meter was loaded. Can be higher
   * than the hourly-netted values the simulation works with: within an hour the meter counts
   * both directions, while netting per hour cancels them against each other.
   */
  gridIn?: number;
  gridOut?: number;
}

/**
 * How the EV charger is treated:
 * - `exclude`: the home battery never discharges into the car (recommended — a car battery
 *   is many times larger than a home battery and would drain it every charge).
 * - `include`: the car is treated as ordinary household load.
 */
export type EvMode = 'exclude' | 'include';

export interface BatterySpec {
  /** Nominal (sticker) capacity in kWh — what you pay for. */
  nominalKwh: number;
  /** Fraction of nominal capacity that is usable (depth of discharge). */
  usableFraction: number;
  /** Max charge/discharge power in kW (inverter limit). */
  inverterKw: number;
  /** Max power as a multiple of usable capacity (e.g. 0.5 = a 10 kWh battery does 5 kW). */
  cRate: number;
  /** Round-trip efficiency, 0–1. */
  roundTripEfficiency: number;
}

export interface Tariff {
  /** Price per kWh imported when not using time-of-use. */
  importFlat: number;
  useTimeOfUse: boolean;
  importPeak: number;
  importOffPeak: number;
  /** Peak window start hour (0–23, local time, inclusive). */
  peakStartHour: number;
  /** Peak window end hour (0–24, local time, exclusive). */
  peakEndHour: number;
  /** Price per kWh exported to the grid. */
  exportPrice: number;
  /** Decide peak hours from the meter's T1/T2 register per hour instead of the fixed window. */
  useMeterRegisters?: boolean;
  /** Which register is the peak (expensive) one. */
  peakRegister?: 1 | 2;
}

export interface SimOptions {
  evMode: EvMode;
  /** Charge the battery from the grid during off-peak hours (time-of-use only). */
  gridCharge: boolean;
  /** State of charge (0–1) to grid-charge up to during off-peak. */
  gridChargeTarget: number;
}

export interface Economics {
  /** Price per nominal kWh of battery. */
  costPerKwh: number;
  /** Fixed cost: hybrid inverter, installation, permits. Paid once for any non-zero size. */
  fixedCost: number;
  lifetimeYears: number;
  /** Yearly capacity loss, 0–1 (0.02 = 2 %/year). */
  degradationPerYear: number;
}

export interface SimResult {
  importKwh: number;
  exportKwh: number;
  importCost: number;
  exportRevenue: number;
  /** importCost − exportRevenue */
  netCost: number;
  /** Energy put into the battery from solar (before losses). */
  chargedFromSolarKwh: number;
  /** Energy put into the battery from the grid (before losses). */
  chargedFromGridKwh: number;
  /** Energy delivered by the battery to loads (after losses). */
  dischargedKwh: number;
  totalLoadKwh: number;
  solarKwh: number;
  /** Share of load not imported from the grid. */
  selfSufficiency: number;
  /** Share of solar used on site rather than exported. */
  selfConsumption: number;
  /** Full equivalent cycles over the simulated period. */
  cycles: number;
  /** Days on which the battery reached ≥ 98 % at some point. */
  daysFull: number;
  /** Days on which the battery hit empty at some point while load was unmet. */
  daysEmpty: number;
  days: number;
  /** Grid import per calendar month, keyed "YYYY-MM". */
  monthlyImport: Map<string, number>;
}
