import { describe, expect, it } from 'vitest';
import { priceFor, reimbursement } from './reimbursement';

const H = 3600_000;

describe('reimbursement', () => {
  it('applies each month its own price and falls back to the default', () => {
    const jan = new Date(2025, 0, 15, 20).getTime();
    const feb = new Date(2025, 1, 15, 20).getTime();
    const samples = [
      { t: jan, house: 1, solar: 0, ev: 7 },
      { t: jan + H, house: 1, solar: 0, ev: 3 },
      { t: feb, house: 1, solar: 0, ev: 5 },
    ];
    const r = reimbursement(samples, { defaultPrice: 0.2, months: { '2025-01': 0.3 } });
    expect(r.byMonth).toEqual([
      { month: '2025-01', evKwh: 10, price: 0.3, amount: 3 },
      { month: '2025-02', evKwh: 5, price: 0.2, amount: 1 },
    ]);
    expect(r.total).toBeCloseTo(4);
    expect(r.evKwh).toBe(15);
  });

  it('ignores invalid month prices', () => {
    expect(priceFor('2025-03', { defaultPrice: 0.25, months: { '2025-03': NaN } })).toBe(0.25);
    expect(priceFor('2025-03', { defaultPrice: 0.25, months: { '2025-03': -1 } })).toBe(0.25);
  });
});
