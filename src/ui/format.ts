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

export function dateRange(first: number, last: number): string {
  const f = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return `${f.format(first)} – ${f.format(last)}`;
}
