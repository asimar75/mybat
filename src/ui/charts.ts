import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import type { Recommendation, SweepRow } from '../engine/sweep';
import { kwh, money, pct } from './format';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, LineController, LineElement, PointElement, Tooltip, Legend);

const charts = new Map<string, Chart>();

/** Reads the theme tokens from CSS so charts follow light/dark mode. */
function tokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    series1: v('--series-1'),
    series2: v('--series-2'),
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
        line('Lifetime savings', rec.rows.map((r) => r.lifetimeSavings), t.series1),
        line('Battery cost', rec.rows.map((r) => r.investment), t.series2, true),
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
      labels: months.map((m) => new Date(`${m}-01T00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })),
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
