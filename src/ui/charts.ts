import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import type { Recommendation, SweepRow } from '../engine/sweep';
import type { DayTotals, HourProfile } from '../data/validate';
import type { HourSample } from '../engine/types';
import { fmtDayMonth, fmtMonth, fmtTime, fmtWeekdayDay, kwh, money, num1, pct } from './format';

Chart.register(BarController, BarElement, CategoryScale, Filler, LinearScale, LineController, LineElement, PointElement, Tooltip, Legend);

const charts = new Map<string, Chart>();

/** Reads the theme tokens from CSS so charts follow light/dark mode. */
function tokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    series1: v('--series-1'),
    series2: v('--series-2'),
    series3: v('--series-3'),
    series4: v('--series-4'),
    text: v('--text-secondary'),
    muted: v('--text-muted'),
    grid: v('--grid'),
    surface: v('--surface'),
  };
}

function baseOptions(yLabel: (v: number) => string) {
  const t = tokens();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { labels: { color: t.text, boxWidth: 12, boxHeight: 12, usePointStyle: true } },
      tooltip: { backgroundColor: t.surface, titleColor: t.text, bodyColor: t.text, borderColor: t.grid, borderWidth: 1 },
    },
    scales: {
      x: { ticks: { color: t.muted }, grid: { display: false }, border: { color: t.grid } },
      y: { ticks: { color: t.muted, callback: (v: number | string) => yLabel(Number(v)) }, grid: { color: t.grid }, border: { display: false } },
    },
  };
}

function render(id: string, config: ChartConfiguration) {
  const canvas = document.getElementById(id) as HTMLCanvasElement | null;
  if (!canvas) return;
  charts.get(id)?.destroy();
  charts.set(id, new Chart(canvas, config));
}

function line(label: string, data: number[], color: string, dashed = false) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    borderDash: dashed ? [6, 4] : [],
    pointRadius: 0,
    pointHoverRadius: 5,
    tension: 0.25,
  };
}

export function renderCharts(rec: Recommendation, highlight: SweepRow | null, currency: string) {
  const t = tokens();
  const sizes = rec.rows.map((r) => `${r.nominalKwh}`);

  const economics = baseOptions((v) => money(v, currency));
  render('chart-economics', {
    type: 'line',
    data: {
      labels: sizes,
      datasets: [
        line('Savings over the period', rec.rows.map((r) => r.lifetimeSavings), t.series1),
        // Purchase + replacements − value left at the end: what the battery really costs over the period.
        line('Battery cost incl. replacements', rec.rows.map((r) => r.investment + r.replacementCost - r.residualValue), t.series2, true),
      ],
    },
    options: {
      ...economics,
      plugins: {
        ...economics.plugins,
        tooltip: {
          ...economics.plugins.tooltip,
          callbacks: {
            title: (items) => `${items[0].label} kWh battery`,
            label: (item) => `${item.dataset.label}: ${money(item.parsed.y ?? 0, currency)}`,
          },
        },
      },
      scales: { ...economics.scales, x: { ...economics.scales.x, title: { display: true, text: 'Battery size (kWh)', color: t.muted } } },
    },
  });

  const ss = baseOptions((v) => pct(v));
  render('chart-selfsufficiency', {
    type: 'line',
    data: {
      labels: sizes,
      datasets: [line('Self-sufficiency', rec.rows.map((r) => r.annual.selfSufficiency), t.series1)],
    },
    options: {
      ...ss,
      plugins: {
        ...ss.plugins,
        legend: { display: false },
        tooltip: {
          ...ss.plugins.tooltip,
          callbacks: { title: (items) => `${items[0].label} kWh battery`, label: (item) => `Self-sufficiency: ${pct(item.parsed.y ?? 0)}` },
        },
      },
      scales: {
        x: { ...ss.scales.x, title: { display: true, text: 'Battery size (kWh)', color: t.muted } },
        y: { ...ss.scales.y, min: 0, max: 1 },
      },
    },
  });

  const months = [...rec.baseline.annual.monthlyImport.keys()];
  const monthly = baseOptions((v) => kwh(v));
  const sized = highlight ?? rec.knee;
  render('chart-monthly', {
    type: 'bar',
    data: {
      labels: months.map((m) => fmtMonth(m)),
      datasets: [
        {
          label: 'No battery',
          data: months.map((m) => (rec.baseline.annual.monthlyImport.get(m) ?? 0)),
          backgroundColor: t.series2,
          borderRadius: 4,
          borderSkipped: 'bottom',
          borderColor: t.surface,
          borderWidth: { left: 1, right: 1 },
        },
        ...(sized
          ? [
              {
                label: `${sized.nominalKwh} kWh battery`,
                data: months.map((m) => (sized.annual.monthlyImport.get(m) ?? 0)),
                backgroundColor: t.series1,
                borderRadius: 4,
                borderSkipped: 'bottom' as const,
                borderColor: t.surface,
                borderWidth: { left: 1, right: 1 },
              },
            ]
          : []),
      ],
    },
    options: {
      ...monthly,
      plugins: {
        ...monthly.plugins,
        tooltip: { ...monthly.plugins.tooltip, callbacks: { label: (item) => `${item.dataset.label}: ${kwh(item.parsed.y ?? 0)}` } },
      },
    },
  });
}

/** Input-validation charts: same entity → same colour everywhere (house blue, EV orange, solar aqua, water heater yellow). */
export function renderDataCharts(
  daily: DayTotals[],
  profile: HourProfile,
  day: HourSample[],
  onPickDay: (day: string) => void,
) {
  const t = tokens();
  const withWh = day.some((s) => s.wh !== undefined) || profile.wh.some((v) => v > 0);
  const entities = (pick: (k: 'house' | 'ev' | 'solar' | 'wh') => number[]) => [
    { ...line('House', pick('house'), t.series1), tension: 0 },
    { ...line('EV charger', pick('ev'), t.series2), tension: 0 },
    { ...line('Solar', pick('solar'), t.series3), tension: 0 },
    ...(withWh ? [{ ...line('Water heater', pick('wh'), t.series4), tension: 0 }] : []),
  ];
  const kwhTooltip = (o: ReturnType<typeof baseOptions>, title: (label: string) => string) => ({
    ...o.plugins,
    tooltip: {
      ...o.plugins.tooltip,
      callbacks: {
        title: (items: { label: string }[]) => title(items[0].label),
        label: (item: { dataset: { label?: string }; parsed: { y: number | null } }) =>
          `${item.dataset.label}: ${num1(item.parsed.y ?? 0)} kWh`,
      },
    },
  });

  const dailyOpts = baseOptions((v) => `${v} kWh`);
  render('chart-daily', {
    type: 'line',
    data: { labels: daily.map((d) => d.day), datasets: entities((k) => daily.map((d) => d[k])) },
    options: {
      ...dailyOpts,
      plugins: kwhTooltip(dailyOpts, (label) => `${fmtWeekdayDay(label)}/${label.slice(0, 4)} · click to inspect`),
      scales: {
        ...dailyOpts.scales,
        x: {
          ...dailyOpts.scales.x,
          ticks: {
            color: t.muted,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12,
            callback(this: { getLabelForValue: (v: number) => string }, v: number | string) {
              const day = this.getLabelForValue(Number(v));
              // Short periods need the day in the label, or every tick in a month reads the same.
              return daily.length <= 120 ? fmtDayMonth(day) : fmtMonth(day);
            },
          },
        },
      },
      onClick: (event, _active, chart) => {
        if (!event.native) return;
        const hit = chart.getElementsAtEventForMode(event.native, 'index', { intersect: false }, false);
        if (hit.length > 0) onPickDay(daily[hit[0].index].day);
      },
    },
  });

  const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
  const profileOpts = baseOptions((v) => `${num1(v)} kWh`);
  render('chart-profile', {
    type: 'line',
    data: { labels: hours, datasets: entities((k) => profile[k]) },
    options: { ...profileOpts, plugins: kwhTooltip(profileOpts, (label) => `Average ${label}–${label.slice(0, 2)}:59`) },
  });

  const dayOpts = baseOptions((v) => `${num1(v)} kWh`);
  const dayLabels = day.map((s) => fmtTime(s.t));
  render('chart-day', {
    type: 'line',
    data: {
      labels: dayLabels,
      datasets: entities((k) => day.map((s) => s[k] ?? 0)).map((d) => ({ ...d, pointRadius: 2 })),
    },
    options: {
      ...dayOpts,
      plugins: kwhTooltip(dayOpts, (label) => label),
      scales: { ...dayOpts.scales, x: { ...dayOpts.scales.x, ticks: { color: t.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } } },
    },
  });
}

export interface BatteryWindow {
  times: number[];
  usableKwh: number;
  soc: number[];
  chargeSolar: number[];
  chargeGrid: number[];
  toHouse: number[];
  toEv: number[];
  solar: number[];
  load: number[];
}

/**
 * Hourly battery behaviour for a chosen window: state of charge on top, energy flows below on the
 * same time axis (two charts rather than one dual-axis chart — kWh stored and kWh per hour are
 * different quantities). Flows: charging is positive, discharging negative.
 */
export function renderBatteryCharts(w: BatteryWindow) {
  const t = tokens();
  const multiDay = w.times.length > 24;
  const labels = w.times.map((ms) =>
    multiDay ? `${fmtWeekdayDay(ms)} ${fmtTime(ms)}` : fmtTime(ms),
  );
  const xTicks = { color: t.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: multiDay ? 10 : 12 };
  const kwhLabel = (item: { dataset: { label?: string }; parsed: { y: number | null } }) =>
    `${item.dataset.label}: ${Math.abs(item.parsed.y ?? 0).toFixed(2)} kWh`;

  const socOpts = baseOptions((v) => `${num1(v)} kWh`);
  render('chart-soc', {
    type: 'line',
    data: {
      labels,
      datasets: [{ ...line('Stored energy', w.soc, t.series1), tension: 0, fill: 'origin', backgroundColor: `${t.series1}33` }],
    },
    options: {
      ...socOpts,
      plugins: { ...socOpts.plugins, legend: { display: false }, tooltip: { ...socOpts.plugins.tooltip, callbacks: { label: kwhLabel } } },
      scales: { x: { ...socOpts.scales.x, ticks: xTicks }, y: { ...socOpts.scales.y, min: 0, max: Math.max(0.1, w.usableKwh) } },
    },
  });

  const bar = (label: string, data: number[], color: string) => ({
    type: 'bar' as const,
    label,
    data,
    backgroundColor: color,
    borderColor: t.surface,
    borderWidth: 1,
    stack: 'battery',
    order: 2,
  });
  const ctxLine = (label: string, data: number[], color: string, stack: string, dashed = false) => ({
    ...line(label, data, color, dashed),
    type: 'line' as const,
    tension: 0,
    stack,
    order: 1,
  });
  const flowOpts = baseOptions((v) => `${num1(v)} kWh`);
  render('chart-flows', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        bar('Charging from solar', w.chargeSolar, t.series3),
        bar('Charging from grid', w.chargeGrid, t.muted),
        bar('Discharging to house', w.toHouse.map((v) => -v), t.series1),
        bar('Discharging to EV', w.toEv.map((v) => -v), t.series2),
        ctxLine('Solar production', w.solar, t.series3, 'solar', true),
        ctxLine('Home use', w.load, t.text, 'load'),
      ],
    },
    options: {
      ...flowOpts,
      plugins: { ...flowOpts.plugins, tooltip: { ...flowOpts.plugins.tooltip, callbacks: { label: kwhLabel } } },
      scales: {
        x: { ...flowOpts.scales.x, stacked: true, ticks: xTicks },
        y: { ...flowOpts.scales.y, stacked: true },
      },
    },
  } as ChartConfiguration);
}
