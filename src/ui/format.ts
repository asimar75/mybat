const kwhFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function kwh(v: number): string {
  return `${kwhFmt.format(v)} kWh`;
}

export function num1(v: number): string {
  return oneDecimal.format(v);
}

export function pct(v: number): string {
  return `${Math.round(v * 100)} %`;
}

export function money(v: number, currency: string): string {
  const sign = v < 0 ? '−' : '';
  return `${sign}${currency}${kwhFmt.format(Math.abs(Math.round(v)))}`;
}

export function years(v: number): string {
  return Number.isFinite(v) ? `${oneDecimal.format(v)} yrs` : 'never';
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// One date style everywhere, independent of the browser's locale: DD/MMM/YYYY, 24-hour times.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n: number) => String(n).padStart(2, '0');
const at = (t: number | string) => (typeof t === 'string' ? new Date(`${t.length === 7 ? `${t}-01` : t}T12:00`) : new Date(t));

/** 05/Oct/2026. Accepts epoch ms, "YYYY-MM-DD" or "YYYY-MM". */
export function fmtDate(t: number | string): string {
  const d = at(t);
  return `${two(d.getDate())}/${MONTHS[d.getMonth()]}/${d.getFullYear()}`;
}

/** 05/Oct */
export function fmtDayMonth(t: number | string): string {
  const d = at(t);
  return `${two(d.getDate())}/${MONTHS[d.getMonth()]}`;
}

/** Oct/2026 */
export function fmtMonth(t: number | string): string {
  const d = at(t);
  return `${MONTHS[d.getMonth()]}/${d.getFullYear()}`;
}

/** 14:00 */
export function fmtTime(t: number): string {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 05/Oct/2026 14:00 */
export function fmtDateTime(t: number): string {
  return `${fmtDate(t)} ${fmtTime(t)}`;
}

/** Mon 05/Oct */
export function fmtWeekdayDay(t: number | string): string {
  return `${WEEKDAYS[at(t).getDay()]} ${fmtDayMonth(t)}`;
}

export function dateRange(first: number, last: number): string {
  return `${fmtDate(first)} – ${fmtDate(last)}`;
}
