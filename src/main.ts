import './styles.css';
import { prepare, type PreparedData } from './engine/simulate';
import { sizeRange, sweep, type Recommendation, type SweepRow } from './engine/sweep';
import type { Economics, HourSample, SimOptions, Tariff } from './engine/types';
import { CSV_TEMPLATE, parseCsv } from './data/csv';
import { deriveSamples, type StatSelection } from './data/derive';
import { demoYear } from './data/demo';
import { HomeAssistantClient, looksLikeEv, parseEnergyPrefs } from './data/homeassistant';
import { dailyTotals, hourProfile, LIMITS, localDay, monthlyTotals, runChecks, toCsv, type DayTotals, type HourProfile } from './data/validate';
import { renderCharts, renderDataCharts } from './ui/charts';
import { dateRange, escapeHtml, kwh, money, num1, pct, years } from './ui/format';

// ---------- small helpers ----------

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* storage unavailable (private mode) — settings just won't persist */
    }
  },
};

function setStatus(msg: string, kind: 'info' | 'error' | 'ok' = 'info') {
  const el = $('#status');
  el.textContent = msg;
  el.dataset.kind = kind;
}

// ---------- state ----------

let data: PreparedData | null = null;
let dataNotes: string[] = [];
let lastRec: Recommendation | null = null;

// ---------- tabs ----------

document.querySelectorAll<HTMLButtonElement>('[role=tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll<HTMLButtonElement>('[role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    document.querySelectorAll<HTMLElement>('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
    storage.set('mybat.tab', tab.dataset.tab ?? 'ha');
  });
});
const savedTab = storage.get('mybat.tab');
if (savedTab) document.querySelector<HTMLButtonElement>(`[role=tab][data-tab="${savedTab}"]`)?.click();

// ---------- data loading ----------

function setData(samples: HourSample[], label: string, notes: string[] = []) {
  if (samples.length < 24) {
    setStatus('Not enough data: at least one full day of hourly values is needed.', 'error');
    return;
  }
  data = prepare(samples);
  dataNotes = notes;
  setStatus(`Loaded ${label}.`, 'ok');
  renderSummary();
  renderValidation();
  recompute();
}

$('#demo-load').addEventListener('click', () => setData(demoYear(), 'demo year'));

$('#csv-template').addEventListener('click', (e) => {
  e.preventDefault();
  downloadText(CSV_TEMPLATE, 'battery-sizer-template.csv');
});

$<HTMLInputElement>('#csv-file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const r = parseCsv(await file.text());
    const notes = r.skipped > 0 ? [`${r.skipped} rows had an unreadable timestamp and were skipped.`] : [];
    setData(r.samples, `${file.name} (${r.rows.toLocaleString()} rows)`, notes);
  } catch (err) {
    setStatus((err as Error).message, 'error');
  }
});

// Home Assistant
let ha: HomeAssistantClient | null = null;
const haUrl = $<HTMLInputElement>('#ha-url');
const haToken = $<HTMLInputElement>('#ha-token');
const haRemember = $<HTMLInputElement>('#ha-remember');
haUrl.value = storage.get('mybat.haUrl') ?? '';
haToken.value = storage.get('mybat.haToken') ?? '';
haRemember.checked = haToken.value !== '';

const mapFields = {
  gridImport: $<HTMLInputElement>('#map-gi'),
  gridExport: $<HTMLInputElement>('#map-ge'),
  solar: $<HTMLInputElement>('#map-solar'),
  ev: $<HTMLInputElement>('#map-ev'),
  batteryOut: $<HTMLInputElement>('#map-bo'),
  batteryIn: $<HTMLInputElement>('#map-bi'),
};
const splitIds = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
const haDays = $<HTMLInputElement>('#ha-days');
haDays.value = storage.get('mybat.haDays') ?? haDays.value;
haDays.addEventListener('change', () => storage.set('mybat.haDays', haDays.value));

// Sensor choices are remembered per Home Assistant address, so reconnecting restores your picks
// instead of re-running auto-detection. "Reset" goes back to what the Energy dashboard suggests.
type SensorValues = Record<keyof typeof mapFields, string>;
let detectedSensors: SensorValues | null = null;
const sensorKey = () => `mybat.sensors.${haUrl.value.trim().replace(/\/+$/, '').toLowerCase()}`;

function readSensorFields(): SensorValues {
  const out = {} as SensorValues;
  for (const [k, el] of Object.entries(mapFields)) out[k as keyof SensorValues] = el.value.trim();
  return out;
}

function fillSensorFields(values: SensorValues) {
  for (const [k, el] of Object.entries(mapFields)) el.value = values[k as keyof SensorValues] ?? '';
}

function loadSavedSensors(): SensorValues | null {
  try {
    const raw = storage.get(sensorKey());
    return raw ? (JSON.parse(raw) as SensorValues) : null;
  } catch {
    return null;
  }
}

function saveSensors() {
  storage.set(sensorKey(), JSON.stringify(readSensorFields()));
  $('#sensors-saved').textContent = 'Sensor choices saved on this device.';
}

for (const el of Object.values(mapFields)) el.addEventListener('change', saveSensors);

$('#sensors-reset').addEventListener('click', () => {
  if (!detectedSensors) return;
  fillSensorFields(detectedSensors);
  storage.set(sensorKey(), null);
  $('#sensors-saved').textContent = 'Reset to what your Energy dashboard suggests.';
});

$('#ha-connect').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#ha-connect');
  button.disabled = true;
  setStatus('Connecting to Home Assistant…');
  try {
    ha?.close();
    ha = await HomeAssistantClient.connect(haUrl.value, haToken.value);
    storage.set('mybat.haUrl', haUrl.value.trim());
    storage.set('mybat.haToken', haRemember.checked ? haToken.value.trim() : null);

    const [prefs, stats] = await Promise.all([ha.energyPrefs().catch(() => null), ha.energyStatistics()]);
    const sel = parseEnergyPrefs(prefs);
    $('#ha-stats').innerHTML = stats
      .map((s) => `<option value="${escapeHtml(s.statistic_id)}">${escapeHtml(s.name ?? '')}</option>`)
      .join('');

    const evGuess =
      sel.devices.find((d) => looksLikeEv(`${d.id} ${d.name}`))?.id ??
      stats.find((s) => looksLikeEv(`${s.statistic_id} ${s.name ?? ''}`))?.statistic_id ??
      '';
    detectedSensors = {
      gridImport: sel.gridImport.join(', '),
      gridExport: sel.gridExport.join(', '),
      solar: sel.solar.join(', '),
      batteryOut: sel.batteryOut.join(', '),
      batteryIn: sel.batteryIn.join(', '),
      ev: evGuess,
    };
    const saved = loadSavedSensors();
    fillSensorFields(saved ?? detectedSensors);
    $('#sensors-saved').textContent = saved ? 'Using your saved sensor choices.' : '';
    $('#ha-mapping').hidden = false;

    if (saved) {
      setStatus('Connected. Your saved sensors are filled in — load history when ready.', 'ok');
    } else {
      const missing = [];
      if (sel.gridImport.length === 0) missing.push('grid import');
      if (sel.solar.length === 0) missing.push('solar');
      setStatus(
        missing.length
          ? `Connected. Your Energy dashboard has no ${missing.join(' or ')} configured — fill it in below.`
          : `Connected. Check the sensors below${evGuess ? '' : ' (no EV charger found — pick one if you have it)'}, then load history.`,
        missing.length ? 'error' : 'ok',
      );
    }
  } catch (err) {
    setStatus((err as Error).message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#ha-load').addEventListener('click', async () => {
  if (!ha) return;
  const button = $<HTMLButtonElement>('#ha-load');
  button.disabled = true;
  const sel: StatSelection = {
    gridImport: splitIds(mapFields.gridImport.value),
    gridExport: splitIds(mapFields.gridExport.value),
    solar: splitIds(mapFields.solar.value),
    batteryOut: splitIds(mapFields.batteryOut.value),
    batteryIn: splitIds(mapFields.batteryIn.value),
    ev: mapFields.ev.value.trim(),
  };
  const ids = [...new Set([...sel.gridImport, ...sel.gridExport, ...sel.solar, ...sel.batteryOut, ...sel.batteryIn, sel.ev].filter(Boolean))];
  saveSensors();
  const days = Math.max(7, Math.min(1825, Number(haDays.value) || 365));
  const end = new Date();
  end.setMinutes(0, 0, 0);
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  try {
    const stats = await ha.hourlyChanges(ids, start, end, (f) => setStatus(`Downloading history… ${Math.round(f * 100)} %`));
    const report = deriveSamples(stats, sel);
    const notes: string[] = [];
    if (report.missingHours > 0) notes.push(`${report.missingHours.toLocaleString()} hours had no data (Home Assistant offline?) and were skipped.`);
    if (report.evClampedHours > 0) notes.push(`In ${report.evClampedHours} hours the EV meter read more than total consumption — check that the EV sensor is in kWh and the grid sensors are complete.`);
    if (!sel.ev) notes.push('No EV charger selected: all consumption is treated as household load.');
    if (sel.solar.length === 0) notes.push('No solar sensor selected: the battery can only help through off-peak grid charging.');
    setData(report.samples, `${days} days from Home Assistant`, notes);
  } catch (err) {
    setStatus((err as Error).message, 'error');
  } finally {
    button.disabled = false;
  }
});

// ---------- settings ----------

const form = $<HTMLFormElement>('#settings');
const SETTINGS_KEY = 'mybat.settings';

function restoreSettings() {
  const raw = storage.get(SETTINGS_KEY);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw) as Record<string, string | boolean>;
    for (const [name, value] of Object.entries(saved)) {
      const el = form.elements.namedItem(name);
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(value);
      else if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = String(value);
    }
  } catch {
    /* ignore corrupt settings */
  }
}

function saveSettings() {
  const out: Record<string, string | boolean> = {};
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement) out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    else if (el instanceof HTMLSelectElement) out[el.name] = el.value;
  }
  storage.set(SETTINGS_KEY, JSON.stringify(out));
}

function readSettings() {
  const n = (name: string, fallback: number) => {
    const v = Number((form.elements.namedItem(name) as HTMLInputElement).value);
    return Number.isFinite(v) ? v : fallback;
  };
  const b = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).checked;
  const s = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value;

  const tariff: Tariff = {
    importFlat: n('importFlat', 0.3),
    useTimeOfUse: b('useTimeOfUse'),
    importPeak: n('importPeak', 0.36),
    importOffPeak: n('importOffPeak', 0.2),
    peakStartHour: n('peakStartHour', 7),
    peakEndHour: n('peakEndHour', 23),
    exportPrice: n('exportPrice', 0.08),
  };
  const options: SimOptions = {
    evMode: s('evMode') === 'include' ? 'include' : 'exclude',
    gridCharge: b('gridCharge'),
    gridChargeTarget: n('gridChargePct', 100) / 100,
  };
  const economics: Economics = {
    costPerKwh: n('costPerKwh', 450),
    fixedCost: n('fixedCost', 1500),
    lifetimeYears: Math.max(1, n('lifetimeYears', 12)),
    degradationPerYear: n('degradationPct', 2) / 100,
  };
  const template = {
    usableFraction: Math.min(1, Math.max(0.1, n('usablePct', 95) / 100)),
    roundTripEfficiency: Math.min(1, Math.max(0.1, n('efficiencyPct', 90) / 100)),
    inverterKw: Math.max(0.1, n('inverterKw', 5)),
    cRate: Math.max(0.05, n('cRate', 0.5)),
  };
  const sizes = sizeRange(Math.min(100, Math.max(1, n('maxKwh', 25))), n('stepKwh', 1));
  return { tariff, options, economics, template, sizes, currency: s('currency') || '€' };
}

function syncVisibility() {
  const tou = (form.elements.namedItem('useTimeOfUse') as HTMLInputElement).checked;
  const gridCharge = (form.elements.namedItem('gridCharge') as HTMLInputElement).checked;
  form.querySelectorAll<HTMLElement>('[data-tou]').forEach((el) => (el.hidden = !tou));
  form.querySelectorAll<HTMLElement>('[data-flat]').forEach((el) => (el.hidden = tou));
  form.querySelectorAll<HTMLElement>('[data-gridcharge]').forEach((el) => (el.hidden = !tou || !gridCharge));
}

restoreSettings();
syncVisibility();
form.addEventListener('input', () => {
  syncVisibility();
  saveSettings();
  recompute();
});

// ---------- rendering ----------

/** Energy the EV pulled from the grid with no battery: the part solar didn't cover. */
function evFromGrid(samples: HourSample[]): number {
  let total = 0;
  for (const s of samples) total += Math.max(0, s.ev - Math.max(0, s.solar - s.house));
  return total;
}

function renderSummary() {
  if (!data) return;
  const s = data.samples;
  const f = 8760 / s.length;
  const sum = (k: 'house' | 'solar' | 'ev') => s.reduce((a, x) => a + x[k], 0) * f;
  const notes = [...dataNotes];
  if (data.days < 330) {
    notes.unshift(
      `Only ${data.days} days of data. Results are scaled to a year, but solar is seasonal — a summer-only sample will badly overstate what a battery achieves in winter. Use a full year if you can.`,
    );
  }
  $('#summary').innerHTML = `
    <dl class="stats">
      <div><dt>Period</dt><dd>${dateRange(s[0].t, s[s.length - 1].t)}<small>${data.days} days</small></dd></div>
      <div><dt>Household use / yr</dt><dd>${kwh(sum('house'))}</dd></div>
      <div><dt>EV charging / yr</dt><dd>${kwh(sum('ev'))}</dd></div>
      <div><dt>Solar / yr</dt><dd>${kwh(sum('solar'))}</dd></div>
    </dl>
    ${notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('')}`;
}

function recompute() {
  if (!data) return;
  const cfg = readSettings();
  const rec = sweep(data, cfg.template, cfg.sizes, cfg.tariff, cfg.options, cfg.economics);
  lastRec = rec;
  renderResults(rec, cfg.currency, cfg.options.evMode, cfg.economics.lifetimeYears);
}

function verdict(rec: Recommendation, currency: string, lifetime: number): string {
  const base = rec.baseline.annual;
  const { best, knee } = rec;
  if (best) {
    return `
      <div class="verdict good">
        <p class="eyebrow">Best value</p>
        <p class="hero">${best.nominalKwh} kWh</p>
        <p>${num1(best.usableKwh)} kWh usable, ${num1(best.powerKw)} kW. Costs ${money(best.investment, currency)},
        saves ${money(best.annualSavings, currency)} in year one, pays back in ${years(best.paybackYears)}, and leaves you
        <b>${money(best.netBenefit, currency)}</b> ahead over ${lifetime} years.</p>
        <p>Self-sufficiency goes from ${pct(base.selfSufficiency)} to ${pct(best.annual.selfSufficiency)}.</p>
      </div>`;
  }
  const fastest = rec.rows.filter((r) => r.nominalKwh > 0).sort((a, b) => a.paybackYears - b.paybackYears)[0];
  return `
    <div class="verdict bad">
      <p class="eyebrow">Doesn't pay back</p>
      <p class="hero">No size tested earns its cost back in ${lifetime} years</p>
      <p>The fastest payback is ${fastest ? `${fastest.nominalKwh} kWh at ${years(fastest.paybackYears)}` : 'never'}.
      The usual causes: a high battery price, a small gap between import and export prices, or too little surplus
      solar. Try a real quote, your actual tariff, or time-of-use with off-peak grid charging.</p>
      ${knee ? `<p>If you buy one anyway for backup or independence, ${knee.nominalKwh} kWh captures 90 % of what a battery can do for you — anything bigger mostly sits idle.</p>` : ''}
    </div>`;
}

function insights(rec: Recommendation, focus: SweepRow | null, currency: string, evMode: string): string {
  if (!data) return '';
  const items: string[] = [];
  const base = rec.baseline.annual;
  if (rec.knee) {
    items.push(
      `<b>${rec.knee.nominalKwh} kWh</b> already captures 90 % of the maximum possible saving. Beyond that, each extra kWh adds little.`,
    );
  }
  if (focus) {
    const full = focus.annual.daysFull / focus.annual.days;
    const empty = focus.annual.daysEmpty / focus.annual.days;
    items.push(
      `At ${focus.nominalKwh} kWh the battery fills up on ${pct(full)} of days and runs empty on ${pct(empty)}. ` +
        (empty > 0.6 && full < 0.4
          ? 'It often runs empty but rarely fills: the limit is surplus solar, not capacity.'
          : full > 0.6 && empty < 0.3
            ? 'It fills most days and rarely empties: your evenings use less than it stores.'
            : 'A balanced use of capacity.'),
    );
  }
  const evGrid = evFromGrid(data.samples) * rec.annualFactor;
  if (evGrid > 50 && base.importKwh > 0) {
    const share = evGrid / base.importKwh;
    items.push(
      `The EV takes ${kwh(evGrid)} a year from the grid, ${pct(share)} of all your imports. ` +
        (evMode === 'exclude'
          ? 'Moving that charging to sunny hours (a solar-aware charger) is free and may be worth more than a bigger battery.'
          : 'You let the battery charge the car. Expect it to be drained by every charge session, which pushes the "best" size up and the payback out.'),
    );
  }
  if (base.exportKwh > 0) {
    items.push(
      `Without a battery you export ${kwh(base.exportKwh)} a year for ${money(base.exportRevenue, currency)}. Every kWh a battery shifts is worth the difference between your import and export price — that gap is what pays for the battery.`,
    );
  }
  return `<ul class="insights">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
}

function table(rec: Recommendation, currency: string, highlight: SweepRow | null): string {
  const rows = rec.rows
    .map((r) => {
      const cls = r === highlight ? ' class="hl"' : r.netBenefit > 0 ? ' class="pos"' : '';
      return `<tr${cls}>
        <td>${r.nominalKwh}</td><td>${num1(r.usableKwh)}</td><td>${num1(r.powerKw)}</td>
        <td>${money(r.investment, currency)}</td><td>${money(r.annualSavings, currency)}</td>
        <td>${r.nominalKwh ? years(r.paybackYears) : '–'}</td><td>${r.nominalKwh ? money(r.netBenefit, currency) : '–'}</td>
        <td>${pct(r.annual.selfSufficiency)}</td><td>${kwh(r.annual.importKwh)}</td>
        <td>${num1(r.annual.cycles)}</td></tr>`;
    })
    .join('');
  return `
    <details class="table-wrap">
      <summary>All sizes (table)</summary>
      <div class="scroll">
        <table>
          <thead><tr>
            <th>Size kWh</th><th>Usable</th><th>Power kW</th><th>Cost</th><th>Saving / yr</th>
            <th>Payback</th><th>Net benefit</th><th>Self-suff.</th><th>Grid import / yr</th><th>Cycles / yr</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
}

function renderResults(rec: Recommendation, currency: string, evMode: string, lifetime: number) {
  const focus = rec.best ?? rec.knee;
  const dataWarning = failedChecks.length
    ? `<p class="note"><b>Check your data first.</b> Step 2 flagged: ${escapeHtml(failedChecks.join('; '))}.
       This result is computed from that data as-is.</p>`
    : '';
  $('#results-body').innerHTML = `
    ${dataWarning}
    ${verdict(rec, currency, lifetime)}
    ${insights(rec, focus, currency, evMode)}
    <div class="charts">
      <figure>
        <figcaption>Lifetime savings vs. battery cost<small>Savings above the cost line means the battery pays for itself</small></figcaption>
        <div class="chart-box"><canvas id="chart-economics" role="img" aria-label="Lifetime savings and battery cost by size"></canvas></div>
      </figure>
      <figure>
        <figcaption>Self-sufficiency<small>Share of your consumption not bought from the grid</small></figcaption>
        <div class="chart-box"><canvas id="chart-selfsufficiency" role="img" aria-label="Self-sufficiency by battery size"></canvas></div>
      </figure>
      <figure class="wide">
        <figcaption>Grid import per month<small>Winter is where batteries struggle: there's little surplus solar to store</small></figcaption>
        <div class="chart-box"><canvas id="chart-monthly" role="img" aria-label="Monthly grid import with and without battery"></canvas></div>
      </figure>
    </div>
    ${table(rec, currency, focus)}`;
  renderCharts(rec, focus, currency);
}

// Re-draw charts when the OS theme flips so their colours follow.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (data) showDay(selectedDay);
  if (lastRec) recompute();
});

// ---------- step 2: check your data ----------

let daily: DayTotals[] = [];
let profile: HourProfile = { house: [], ev: [], solar: [] };
let selectedDay = '';
const dayPick = $<HTMLInputElement>('#day-pick');

function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function shortDateTime(t: number): string {
  return new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

let failedChecks: string[] = [];

function renderChecks() {
  if (!data) return;
  const checks = runChecks(data.samples);
  failedChecks = checks.filter((c) => !c.ok).map((c) => c.title);
  $('#checks').innerHTML = checks
    .map(
      (c) => `
      <li class="${c.ok ? 'ok' : 'warn'}">
        <span class="icon" aria-label="${c.ok ? 'OK' : 'Warning'}">${c.ok ? '✓' : '!'}</span>
        <b>${escapeHtml(c.title)}</b>
        <p>${escapeHtml(c.detail)}</p>
        ${
          c.examples.length
            ? `<div class="examples">${c.examples
                .map((t) => `<button type="button" class="link-btn" data-day="${localDay(t)}">${shortDateTime(t)}</button>`)
                .join('')}</div>`
            : ''
        }
      </li>`,
    )
    .join('');
}

function renderMonthTable() {
  if (!data) return;
  const months = monthlyTotals(data.samples);
  const fmt = (v: number) => num1(v);
  const total = months.reduce(
    (a, m) => ({
      house: a.house + m.house,
      ev: a.ev + m.ev,
      solar: a.solar + m.solar,
      gridImport: a.gridImport + m.gridImport,
      gridExport: a.gridExport + m.gridExport,
      hours: a.hours + m.hours,
      expectedHours: a.expectedHours + m.expectedHours,
    }),
    { house: 0, ev: 0, solar: 0, gridImport: 0, gridExport: 0, hours: 0, expectedHours: 0 },
  );
  const row = (label: string, m: typeof total, cls = '') => {
    const coverage = m.expectedHours ? m.hours / m.expectedHours : 1;
    return `<tr${cls || coverage < 0.98 ? ` class="${cls || 'short'}"` : ''}>
      <td>${label}</td><td>${fmt(m.house)}</td><td>${fmt(m.ev)}</td><td>${fmt(m.house + m.ev)}</td>
      <td>${fmt(m.solar)}</td><td>${fmt(m.gridImport)}</td><td>${fmt(m.gridExport)}</td><td>${pct(coverage)}</td></tr>`;
  };
  $('#month-table').innerHTML = `
    <table>
      <thead><tr>
        <th>Month</th><th>House kWh</th><th>EV kWh</th><th>Total use kWh</th><th>Solar kWh</th>
        <th>Grid import* kWh</th><th>Grid export* kWh</th><th>Hours with data</th>
      </tr></thead>
      <tbody>
        ${months
          .map((m) => row(new Date(`${m.month}-01T12:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), m))
          .join('')}
        ${row('Total', total, 'hl')}
      </tbody>
    </table>
    <p class="hint">* Without a battery, netted per hour. Home Assistant measures import and export continuously,
    so both of its figures can be slightly higher; total use and solar should match closely.</p>`;
}

function renderDayTable(samples: HourSample[]) {
  const cell = (v: number, bad: boolean) => `<td${bad ? ' class="flag"' : ''}>${v.toFixed(2)}</td>`;
  $('#day-table').innerHTML = samples.length
    ? `<table>
        <thead><tr><th>Hour</th><th>House kWh</th><th>EV kWh</th><th>Solar kWh</th><th>Grid import* kWh</th><th>Grid export* kWh</th></tr></thead>
        <tbody>${samples
          .map((s) => {
            const h = new Date(s.t).getHours();
            const load = s.house + s.ev;
            return `<tr><td>${new Date(s.t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</td>
              ${cell(s.house, s.house > LIMITS.houseKwh || load < 0.01)}${cell(s.ev, s.ev > LIMITS.evKwh)}
              ${cell(s.solar, h <= 3 && s.solar > LIMITS.nightSolarKwh)}
              ${cell(Math.max(0, load - s.solar), false)}${cell(Math.max(0, s.solar - load), false)}</tr>`;
          })
          .join('')}</tbody>
      </table>`
    : '<p class="hint">No data for this day.</p>';
}

function showDay(day: string) {
  if (!data) return;
  selectedDay = day;
  dayPick.value = day;
  const samples = data.samples.filter((s) => localDay(s.t) === day);
  renderDataCharts(daily, profile, samples, (d) => showDay(d));
  renderDayTable(samples);
}

function renderValidation() {
  if (!data) return;
  $('#validate').hidden = false;
  daily = dailyTotals(data.samples);
  profile = hourProfile(data.samples);
  dayPick.min = daily[0].day;
  dayPick.max = daily[daily.length - 1].day;
  // Default to the most recent complete day (23–25 hours allows for daylight-saving changes).
  const lastFull = [...daily].reverse().find((d) => d.hours >= 23) ?? daily[daily.length - 1];
  renderChecks();
  renderMonthTable();
  showDay(lastFull.day);
}

dayPick.addEventListener('change', () => {
  if (dayPick.value) showDay(dayPick.value);
});

$('#checks').addEventListener('click', (e) => {
  const day = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-day]')?.dataset.day;
  if (!day) return;
  showDay(day);
  document.getElementById('chart-day')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

$('#csv-export').addEventListener('click', () => {
  if (data) downloadText(toCsv(data.samples), 'battery-sizer-hourly.csv');
});
