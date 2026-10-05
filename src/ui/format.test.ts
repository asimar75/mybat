import { describe, expect, it } from 'vitest';
import { dateRange, fmtDate, fmtDateTime, fmtDayMonth, fmtMonth, fmtTime, fmtWeekdayDay } from './format';

describe('date formats (DD/MMM/YYYY, 24 h)', () => {
  const t = new Date(2026, 9, 5, 14, 7).getTime();
  it('formats timestamps and day/month strings', () => {
    expect(fmtDate(t)).toBe('05/Oct/2026');
    expect(fmtDate('2025-01-09')).toBe('09/Jan/2025');
    expect(fmtDayMonth('2025-12-31')).toBe('31/Dec');
    expect(fmtMonth('2025-07')).toBe('Jul/2025');
    expect(fmtTime(t)).toBe('14:07');
    expect(fmtDateTime(t)).toBe('05/Oct/2026 14:07');
    expect(fmtWeekdayDay('2026-10-05')).toBe('Mon 05/Oct');
    expect(dateRange(new Date(2025, 9, 1).getTime(), new Date(2026, 7, 20).getTime())).toBe('01/Oct/2025 – 20/Aug/2026');
  });
});
