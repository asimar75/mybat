import type { BatterySpec, HourSample, SimOptions, SimResult, Tariff } from './types';

/**
 * Calendar lookups computed once per dataset so the simulation loop (which runs once per
 * battery size in a sweep) never touches Date objects.
 */
export interface PreparedData {
  samples: HourSample[];
  hourOfDay: Uint8Array;
  /** Index of the local calendar day each sample falls on, 0-based from the first sample. */
  dayIndex: Uint32Array;
  monthKeys: string[];
  /** Month index per sample into `monthKeys`. */
  monthIndex: Uint16Array;
  days: number;
}

export function prepare(samples: HourSample[]): PreparedData {
  const n = samples.length;
  const hourOfDay = new Uint8Array(n);
  const dayIndex = new Uint32Array(n);
  const monthIndex = new Uint16Array(n);
  const monthKeys: string[] = [];
  const monthLookup = new Map<string, number>();
  let lastDay = '';
  let day = -1;
  for (let i = 0; i < n; i++) {
    const d = new Date(samples[i].t);
    hourOfDay[i] = d.getHours();
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (dayKey !== lastDay) {
      day++;
      lastDay = dayKey;
    }
    dayIndex[i] = day;
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    let m = monthLookup.get(monthKey);
    if (m === undefined) {
      m = monthKeys.length;
      monthKeys.push(monthKey);
      monthLookup.set(monthKey, m);
    }
    monthIndex[i] = m;
  }
  return { samples, hourOfDay, dayIndex, monthKeys, monthIndex, days: day + 1 };
}

export function isPeakHour(hour: number, tariff: Tariff): boolean {
  const { peakStartHour: s, peakEndHour: e } = tariff;
  if (s === e) return false;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

export function importPrice(hour: number, tariff: Tariff): number {
  if (!tariff.useTimeOfUse) return tariff.importFlat;
  return isPeakHour(hour, tariff) ? tariff.importPeak : tariff.importOffPeak;
}

export function usableKwh(spec: BatterySpec): number {
  return spec.nominalKwh * spec.usableFraction;
}

export function batteryPowerKw(spec: BatterySpec): number {
  return Math.min(spec.inverterKw, usableKwh(spec) * spec.cRate);
}

/**
 * Hour-by-hour battery simulation.
 *
 * Dispatch order within each hour: solar serves the house first, then the EV, then charges
 * the battery; whatever is left is exported. Shortfalls are covered by the battery (house
 * only, or house + EV in `include` mode) and then the grid.
 *
 * Hourly resolution slightly understates what a real battery captures (it can't see a kettle
 * spike inside a sunny hour), so treat results as a conservative estimate.
 */
export function simulate(
  data: PreparedData,
  spec: BatterySpec,
  tariff: Tariff,
  options: SimOptions,
): SimResult {
  const { samples, hourOfDay, dayIndex, monthIndex, monthKeys } = data;
  const capacity = usableKwh(spec);
  const power = batteryPowerKw(spec);
  // Split round-trip losses evenly between charging and discharging.
  const leg = Math.sqrt(Math.max(0, Math.min(1, spec.roundTripEfficiency)));
  const gridChargeOn = options.gridCharge && tariff.useTimeOfUse && capacity > 0;
  const gridTarget = capacity * Math.max(0, Math.min(1, options.gridChargeTarget));
  const fullThreshold = capacity * 0.98;
  const emptyThreshold = capacity * 0.001;

  let soc = 0;
  let importKwh = 0;
  let exportKwh = 0;
  let importCost = 0;
  let exportRevenue = 0;
  let chargedFromSolar = 0;
  let chargedFromGrid = 0;
  let discharged = 0;
  let totalLoad = 0;
  let solarTotal = 0;
  const monthly = new Float64Array(monthKeys.length);

  let daysFull = 0;
  let daysEmpty = 0;
  let currentDay = -1;
  let dayWasFull = false;
  let dayWasEmpty = false;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const hour = hourOfDay[i];
    if (dayIndex[i] !== currentDay) {
      if (dayWasFull) daysFull++;
      if (dayWasEmpty) daysEmpty++;
      currentDay = dayIndex[i];
      dayWasFull = false;
      dayWasEmpty = false;
    }

    const house = Math.max(0, s.house);
    const ev = Math.max(0, s.ev);
    const solar = Math.max(0, s.solar);
    totalLoad += house + ev;
    solarTotal += solar;

    // 1. Solar → house → EV.
    const solarToHouse = Math.min(solar, house);
    let solarLeft = solar - solarToHouse;
    const houseDeficit = house - solarToHouse;
    const solarToEv = Math.min(solarLeft, ev);
    solarLeft -= solarToEv;
    const evDeficit = ev - solarToEv;

    // 2. Remaining solar → battery → export.
    let powerLeft = power;
    let solarCharge = 0;
    if (capacity > 0 && solarLeft > 0) {
      solarCharge = Math.min(solarLeft, powerLeft, (capacity - soc) / leg);
      soc += solarCharge * leg;
      powerLeft -= solarCharge;
      chargedFromSolar += solarCharge;
    }
    const exported = solarLeft - solarCharge;

    // 3. Shortfall → battery → grid.
    const offPeakHold = gridChargeOn && !isPeakHour(hour, tariff);
    const batteryDemand = houseDeficit + (options.evMode === 'include' ? evDeficit : 0);
    let delivered = 0;
    if (capacity > 0 && batteryDemand > 0 && !offPeakHold) {
      delivered = Math.min(batteryDemand, powerLeft, soc * leg);
      soc -= delivered / leg;
      powerLeft -= delivered;
      discharged += delivered;
      if (soc <= emptyThreshold && delivered < batteryDemand) dayWasEmpty = true;
    }
    let imported = houseDeficit + evDeficit - delivered;

    // 4. Optional off-peak grid charging.
    if (offPeakHold && soc < gridTarget && powerLeft > 0) {
      const gridCharge = Math.min(powerLeft, (gridTarget - soc) / leg);
      soc += gridCharge * leg;
      chargedFromGrid += gridCharge;
      imported += gridCharge;
    }

    if (soc < 0) soc = 0;
    if (soc > capacity) soc = capacity;
    if (capacity > 0 && soc >= fullThreshold) dayWasFull = true;

    const price = importPrice(hour, tariff);
    importKwh += imported;
    exportKwh += exported;
    importCost += imported * price;
    exportRevenue += exported * tariff.exportPrice;
    monthly[monthIndex[i]] += imported;
  }
  if (dayWasFull) daysFull++;
  if (dayWasEmpty) daysEmpty++;

  const monthlyImport = new Map<string, number>();
  monthKeys.forEach((k, idx) => monthlyImport.set(k, monthly[idx]));

  return {
    importKwh,
    exportKwh,
    importCost,
    exportRevenue,
    netCost: importCost - exportRevenue,
    chargedFromSolarKwh: chargedFromSolar,
    chargedFromGridKwh: chargedFromGrid,
    dischargedKwh: discharged,
    totalLoadKwh: totalLoad,
    solarKwh: solarTotal,
    selfSufficiency: totalLoad > 0 ? 1 - importKwh / totalLoad : 0,
    selfConsumption: solarTotal > 0 ? 1 - exportKwh / solarTotal : 0,
    cycles: capacity > 0 ? discharged / capacity : 0,
    daysFull,
    daysEmpty,
    days: data.days,
    monthlyImport,
  };
}
