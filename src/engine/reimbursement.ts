import type { HourSample } from './types';

/**
 * Employer reimbursement for home EV charging, paid per kWh the charger delivers, at a price
 * that can change every month.
 *
 * It's paid on every EV kWh whatever its source (grid, solar or battery), so it lowers the
 * household's net energy cost but is identical for every battery size: it never changes a
 * battery's saving, payback or the best size.
 */
export interface ReimbursementPrices {
  /** Price per kWh used for months without their own entry. */
  defaultPrice: number;
  /** Price per kWh for specific local months, keyed "YYYY-MM". */
  months: Record<string, number>;
}

export interface ReimbursementMonth {
  month: string;
  evKwh: number;
  price: number;
  amount: number;
}

export interface ReimbursementResult {
  /** Total over the data period (not annualised). */
  total: number;
  evKwh: number;
  byMonth: ReimbursementMonth[];
}

export function monthKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function priceFor(month: string, prices: ReimbursementPrices): number {
  const p = prices.months[month];
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 ? p : Math.max(0, prices.defaultPrice || 0);
}

export function reimbursement(samples: HourSample[], prices: ReimbursementPrices): ReimbursementResult {
  const byMonth: ReimbursementMonth[] = [];
  for (const s of samples) {
    const month = monthKey(s.t);
    let last = byMonth[byMonth.length - 1];
    if (!last || last.month !== month) {
      last = { month, evKwh: 0, price: priceFor(month, prices), amount: 0 };
      byMonth.push(last);
    }
    const ev = Math.max(0, s.ev);
    last.evKwh += ev;
    last.amount += ev * last.price;
  }
  return {
    total: byMonth.reduce((a, m) => a + m.amount, 0),
    evKwh: byMonth.reduce((a, m) => a + m.evKwh, 0),
    byMonth,
  };
}
