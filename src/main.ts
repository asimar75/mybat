import './styles.css';
import { reimbursement, type ReimbursementPrices, type ReimbursementResult } from './engine/reimbursement';
import { applyScenario, describeScenario, isNoChange, shiftWaterHeater, type Scenario } from './engine/scenario';
import { createTrace, prepare, simulate, usableKwh, type PreparedData } from './engine/simulate';
import { sizeRange, sweep, type Recommendation, type SweepRow } from './engine/sweep';
import type { Economics, HourSample, SimOptions, Tariff } from './engine/types';
import { CSV_TEMPLATE, parseCsv } from './data/csv';
import { combineMeters, parseMeterCsv, ROLE_LABELS, suggestRole, type MeterRole, type ParsedMeter } from './data/meters';
import { deriveSamples, type StatSelection } from './data/derive';
import { demoYear } from './data/demo';
import { HomeAssistantClient, looksLikeEv, looksLikeWaterHeater, parseEnergyPrefs } from './data/homeassistant';
import { addDays, dailyTotals, hasMeterGrid, hasWaterHeater, lastTwelveMonths, spansMoreThanAYear, twelveMonthsFrom, yearStarts, hourProfile, LIMITS, localDay, monthlyTotals, runChecks, toCsv, type DayTotals, type HourProfile } from './data/validate';
import { clearDataset, loadDataset, saveDataset } from './data/persist';
import { renderBatteryCharts, renderCharts, renderDataCharts } from './ui/charts';
import { exportExcel } from './ui/excel';
import { dateRange, escapeHtml, fmtDate, fmtDateTime, fmtMonth, fmtTime, kwh, money, num1, pct, years } from './ui/format';

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
/** Data the result is computed from: the measured history, or a what-if version of it. */
let simData: PreparedData | null = null;
let simKey = '';
/** The same data with the water-heater option flipped, for the with/without comparison. */
let altData: PreparedData | null = null;
let altKey = '';
let dataLabel = '';
let lastCfg: ReturnType<typeof readSettings> | null = null;
let lastReimb: ReimbursementResult | null = null;

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

/** Everything loaded; `data` is the part in use (all of it, the last 12 months, or 12 calendar months). */
let allSamples: HourSample[] = [];
const PERIOD_KEY = 'mybat.period';

/** 'all', '12m' (last 12 months) or the 'YYYY-MM' a 12-month window starts in. Only longer sets get a choice. */
function periodChoice(): string {
  if (!spansMoreThanAYear(allSamples)) return 'all';
  const saved = storage.get(PERIOD_KEY);
  if (saved === 'all') return 'all';
  if (saved && yearStarts(allSamples).includes(saved)) return saved;
  return '12m';
}

function applyPeriod() {
  const choice = periodChoice();
  data = prepare(choice === 'all' ? allSamples : choice === '12m' ? lastTwelveMonths(allSamples) : twelveMonthsFrom(allSamples, choice));
  simData = null;
  altData = null;
  syncVisibility();
  renderMonthPrices();
}

function setData(samples: HourSample[], label: string, notes: string[] = [], restoredAt?: number) {
  if (samples.length < 24) {
    setStatus('Not enough data: at least one full day of hourly values is needed.', 'error');
    return;
  }
  allSamples = samples;
  applyPeriod();
  dataNotes = notes;
  dataLabel = label;
  // Keep the dataset in this browser so a refresh doesn't lose it; it's replaced by the next load.
  if (restoredAt !== undefined) {
    setStatus(`Restored ${label}, loaded ${fmtDateTime(restoredAt)}. Load new data to replace it.`, 'ok');
  } else if (saveDataset({ samples, label, notes, savedAt: Date.now() })) {
    setStatus(`Loaded ${label}. It stays here after a page refresh until you load new data.`, 'ok');
  } else {
    setStatus(`Loaded ${label}. Too large to keep in this browser, so a refresh will clear it.`, 'ok');
  }
  $('#data-forget').hidden = false;
  renderSummary();
  renderValidation();
  recompute();
}

$('#demo-load').addEventListener('click', () => setData(demoYear(), 'demo year'));

$('#csv-template').addEventListener('click', (e) => {
  e.preventDefault();
  downloadText(CSV_TEMPLATE, 'battery-sizer-template.csv');
});

// One file in the app's own format loads directly; anything else is treated as per-meter exports
// (HomeWizard and similar), shown in a table so each file's role can be confirmed first.
const isTemplateFormat = (text: string) => /consumption_kwh|grid_import_kwh/i.test(text.split(/\r?\n/, 1)[0]);
let meterFiles: { meter: ParsedMeter | null; name: string; error?: string; role: MeterRole }[] = [];
const ROLE_KEY = 'mybat.meterRoles';
const roleKey = (name: string) => name.toLowerCase().replace(/\.(csv|tsv|txt)$/, '');

function savedRoles(): Record<string, MeterRole> {
  try {
    return JSON.parse(storage.get(ROLE_KEY) ?? '{}') as Record<string, MeterRole>;
  } catch {
    return {};
  }
}

function renderMeterFiles() {
  const fmt = fmtDate;
  $('#meter-rows').innerHTML = meterFiles
    .map((f, i) => {
      if (!f.meter) return `<tr><td>${escapeHtml(f.name)}</td><td colspan="4" class="flag">${escapeHtml(f.error ?? 'Unreadable')}</td></tr>`;
      const m = f.meter;
      const cols = [...m.importColumns, ...m.exportColumns].join(', ');
      const kind = `${m.cumulative ? 'meter readings' : 'energy per interval'}, every ${m.intervalMinutes} min${m.hasRegisters ? ', T1/T2' : ''}`;
      const options = (Object.keys(ROLE_LABELS) as MeterRole[])
        .map((r) => `<option value="${r}"${r === f.role ? ' selected' : ''}>${ROLE_LABELS[r]}</option>`)
        .join('');
      return `<tr>
        <td><b>${escapeHtml(f.name)}</b></td>
        <td>${escapeHtml(cols)}<br><small>${kind}</small></td>
        <td>${fmt(m.firstHour)} – ${fmt(m.lastHour)}</td>
        <td>${kwh(m.importTotal)} / ${kwh(m.exportTotal)}</td>
        <td><select data-meter="${i}">${options}</select></td></tr>`;
    })
    .join('');
  $('#meter-files').hidden = meterFiles.length === 0;
}

$<HTMLInputElement>('#csv-file').addEventListener('change', async (e) => {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  if (files.length === 0) return;
  try {
    const texts = await Promise.all(files.map((f) => f.text()));
    if (files.length === 1 && isTemplateFormat(texts[0])) {
      meterFiles = [];
      renderMeterFiles();
      const r = parseCsv(texts[0]);
      const notes = r.skipped > 0 ? [`${r.skipped} rows had an unreadable timestamp and were skipped.`] : [];
      setData(r.samples, `${files[0].name} (${r.rows.toLocaleString()} rows)`, notes);
      return;
    }
    const remembered = savedRoles();
    meterFiles = files.map((f, i) => {
      try {
        const meter = parseMeterCsv(f.name, texts[i]);
        return { meter, name: f.name, role: remembered[roleKey(f.name)] ?? suggestRole(meter) };
      } catch (err) {
        return { meter: null, name: f.name, error: (err as Error).message, role: 'ignore' as MeterRole };
      }
    });
    renderMeterFiles();
    setStatus('Check what each file is, then load them.', 'info');
  } catch (err) {
    setStatus((err as Error).message, 'error');
  }
});

$('#meter-rows').addEventListener('change', (e) => {
  const el = e.target as HTMLSelectElement;
  const f = meterFiles[Number(el.dataset.meter)];
  if (!f) return;
  f.role = el.value as MeterRole;
  storage.set(ROLE_KEY, JSON.stringify({ ...savedRoles(), [roleKey(f.name)]: f.role }));
});

$('#meter-load').addEventListener('click', () => {
  try {
    const assigned = meterFiles.filter((f) => f.meter && f.role !== 'ignore').map((f) => ({ meter: f.meter!, role: f.role }));
    const r = combineMeters(assigned, $<HTMLInputElement>('#meter-common').checked);
    if (r.peakRegisterGuess) {
      (form.elements.namedItem('peakRegister') as HTMLSelectElement).value = String(r.peakRegisterGuess);
      saveSettings();
      r.notes.unshift(
        `T${r.peakRegisterGuess} counts weekday daytime, so it's set as the peak register` +
          ((form.elements.namedItem('useTimeOfUse') as HTMLInputElement).checked
            ? '.'
            : '. Turn on time-of-use pricing under Assumptions → Tariff and enter your peak and off-peak prices to use it.'),
      );
    }
    setData(r.samples, `${assigned.length} meter files`, r.notes);
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
  wh: $<HTMLInputElement>('#map-wh'),
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
    const whGuess =
      sel.devices.find((d) => looksLikeWaterHeater(`${d.id} ${d.name}`))?.id ??
      stats.find((s) => looksLikeWaterHeater(`${s.statistic_id} ${s.name ?? ''}`))?.statistic_id ??
      '';
    detectedSensors = {
      gridImport: sel.gridImport.join(', '),
      gridExport: sel.gridExport.join(', '),
      solar: sel.solar.join(', '),
      batteryOut: sel.batteryOut.join(', '),
      batteryIn: sel.batteryIn.join(', '),
      ev: evGuess,
      wh: whGuess,
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
    wh: mapFields.wh.value.trim(),
  };
  const ids = [...new Set([...sel.gridImport, ...sel.gridExport, ...sel.solar, ...sel.batteryOut, ...sel.batteryIn, sel.ev, sel.wh ?? ''].filter(Boolean))];
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
    if (report.whClampedHours > 0) notes.push(`In ${report.whClampedHours} hours the water heater meter read more than the remaining consumption — check that its sensor is an energy (kWh) total.`);
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
    if (!(el as HTMLInputElement).name) continue; // monthly reimbursement prices are stored separately
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

  const hasRegisters = data !== null && data.samples.some((x) => x.rate);
  const tariff: Tariff = {
    importFlat: n('importFlat', 0.3),
    useTimeOfUse: b('useTimeOfUse'),
    importPeak: n('importPeak', 0.36),
    importOffPeak: n('importOffPeak', 0.2),
    peakStartHour: n('peakStartHour', 7),
    peakEndHour: n('peakEndHour', 23),
    exportPrice: n('exportPrice', 0.08),
    useMeterRegisters: hasRegisters && b('useMeterRegisters'),
    peakRegister: s('peakRegister') === '2' ? 2 : 1,
  };
  const options: SimOptions = {
    evMode: s('evMode') === 'include' ? 'include' : 'exclude',
    gridCharge: b('gridCharge'),
    gridChargeTarget: n('gridChargePct', 100) / 100,
  };
  const economics: Economics = {
    costPerKwh: n('costPerKwh', 450),
    fixedCost: n('fixedCost', 1500),
    horizonYears: Math.max(1, n('horizonYears', 20)),
    calendarLossPerYear: Math.max(0, n('calendarLossPct', 1)) / 100,
    cycleLife: Math.max(100, n('cycleLife', 6000)),
    replacementFraction: Math.max(0, n('replacementPct', 70)) / 100,
  };
  const template = {
    usableFraction: Math.min(1, Math.max(0.1, n('usablePct', 95) / 100)),
    roundTripEfficiency: Math.min(1, Math.max(0.1, n('efficiencyPct', 90) / 100)),
    inverterKw: Math.max(0.1, n('inverterKw', 5)),
    cRate: Math.max(0.05, n('cRate', 0.5)),
  };
  const sizes = sizeRange(Math.min(100, Math.max(1, n('maxKwh', 25))), n('stepKwh', 1));
  const scenario: Scenario = {
    householdPct: Math.max(-100, n('householdPct', 0)),
    evPct: Math.max(-100, n('evPct', 0)),
  };
  const waterHeater = { shift: b('whShift'), maxKw: Math.max(0.1, n('whMaxKw', 1)) };
  const reimb = { on: b('reimbOn'), prices: { defaultPrice: Math.max(0, n('reimbDefault', 0)), months: loadMonthPrices() } as ReimbursementPrices };
  return { tariff, options, economics, template, sizes, scenario, waterHeater, reimb, currency: s('currency') || '€' };
}

function syncVisibility() {
  const tou = (form.elements.namedItem('useTimeOfUse') as HTMLInputElement).checked;
  const gridCharge = (form.elements.namedItem('gridCharge') as HTMLInputElement).checked;
  form.querySelectorAll<HTMLElement>('[data-tou]').forEach((el) => (el.hidden = !tou));
  form.querySelectorAll<HTMLElement>('[data-flat]').forEach((el) => (el.hidden = tou));
  form.querySelectorAll<HTMLElement>('[data-gridcharge]').forEach((el) => (el.hidden = !tou || !gridCharge));
  // T1/T2 option only when the data has registers; the fixed window hides while it's in use.
  const registers = data !== null && data.samples.some((x) => x.rate);
  const useRegisters = registers && (form.elements.namedItem('useMeterRegisters') as HTMLInputElement).checked;
  form.querySelectorAll<HTMLElement>('[data-registers]').forEach((el) => (el.hidden = !tou || !registers));
  form.querySelectorAll<HTMLElement>('[data-window]').forEach((el) => (el.hidden = !tou || useRegisters));
  // Water-heater options only make sense when the data has a separately metered water heater.
  const wh = data !== null && hasWaterHeater(data.samples);
  const whShift = (form.elements.namedItem('whShift') as HTMLInputElement).checked;
  form.querySelectorAll<HTMLElement>('[data-wh]').forEach((el) => (el.hidden = !wh));
  form.querySelectorAll<HTMLElement>('[data-whshift]').forEach((el) => (el.hidden = !wh || !whShift));
  const reimbOn = (form.elements.namedItem('reimbOn') as HTMLInputElement).checked;
  form.querySelectorAll<HTMLElement>('[data-reimb]').forEach((el) => (el.hidden = !reimbOn));
}

// ---------- EV reimbursement prices per month ----------

const REIMB_KEY = 'mybat.reimbMonths';

function loadMonthPrices(): Record<string, number> {
  try {
    const raw = storage.get(REIMB_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
  } catch {
    return {};
  }
}

/** One input per month in the loaded data; empty means "use the default price". */
function renderMonthPrices() {
  if (!data) return;
  const saved = loadMonthPrices();
  $('#reimb-months').innerHTML = data.monthKeys
    .map((m) => {
      const label = fmtMonth(m);
      const value = saved[m] !== undefined ? String(saved[m]) : '';
      return `<label>${label}<input type="number" step="0.001" min="0" data-month="${m}" value="${value}" placeholder="default" /></label>`;
    })
    .join('');
}

$('#reimb-months').addEventListener('input', () => {
  const months = loadMonthPrices();
  document.querySelectorAll<HTMLInputElement>('#reimb-months input[data-month]').forEach((el) => {
    const v = el.value.trim() === '' ? NaN : Number(el.value);
    if (Number.isFinite(v) && v >= 0) months[el.dataset.month!] = v;
    else delete months[el.dataset.month!];
  });
  storage.set(REIMB_KEY, JSON.stringify(months));
});

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

/** 'YYYY-MM' of the 12th month of a window starting at `month`. */
function lastMonthOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m + 10, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function renderSummary() {
  if (!data) return;
  const s = data.samples;
  const f = 8760 / s.length;
  const total = (pick: (x: HourSample) => number) => s.reduce((a, x) => a + pick(x), 0);
  // Real totals for the period shown first (comparable with the monitoring app), per-year estimate below.
  const tile = (label: string, value: number) =>
    `<div><dt>${label}</dt><dd>${kwh(value)}<small>${Math.abs(f - 1) < 0.02 ? 'in this year' : `≈ ${kwh(value * f)} per year`}</small></dd></div>`;
  const notes = [...dataNotes];
  if (data.days < 330) {
    notes.unshift(
      `Only ${data.days} days of data. Results are scaled to a year, but solar is seasonal — a summer-only sample will badly overstate what a battery achieves in winter. Use a full year if you can.`,
    );
  }
  const longer = spansMoreThanAYear(allSamples);
  const choice = periodChoice();
  const option = (value: string, label: string) => `<option value="${value}"${choice === value ? ' selected' : ''}>${label}</option>`;
  const periodSelect = longer
    ? `<label class="period-choice">Period used
        <select id="period-select">
          ${option('12m', 'Last 12 months (each season once)')}
          <optgroup label="12 calendar months, to compare with a monitoring app's year">
            ${yearStarts(allSamples)
              .map((m) => option(m, `${fmtMonth(m)} – ${fmtMonth(lastMonthOf(m))}${m.endsWith('-08') ? ' (HomeWizard year view)' : ''}`))
              .join('')}
          </optgroup>
          ${option('all', `All ${dateRange(allSamples[0].t, allSamples[allSamples.length - 1].t)}`)}
        </select>
      </label>`
    : '';
  if (choice === 'all' && longer) {
    notes.unshift('Using more than a year: some seasons count twice when results are scaled to one year (e.g. two summers and one winter overstate solar).');
  }
  $('#summary').innerHTML = `
    ${periodSelect}
    <dl class="stats">
      <div><dt>Period</dt><dd>${dateRange(s[0].t, s[s.length - 1].t)}<small>${data.days} days</small></dd></div>
      ${tile('Total use', total((x) => x.house + x.ev + (x.wh ?? 0)))}
      ${tile('Household (excl. EV' + (hasWaterHeater(s) ? ', water heater)' : ')'), total((x) => x.house))}
      ${tile('EV charging', total((x) => x.ev))}
      ${hasWaterHeater(s) ? tile('Water heater', total((x) => x.wh ?? 0)) : ''}
      ${tile('Solar', total((x) => x.solar))}
      ${hasMeterGrid(s) ? tile('Grid import (meter)', total((x) => x.gridIn ?? 0)) + tile('Grid export (meter)', total((x) => x.gridOut ?? 0)) : ''}
    </dl>
    ${notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('')}`;
}

$('#summary').addEventListener('change', (e) => {
  const el = e.target as HTMLSelectElement;
  if (el.id !== 'period-select') return;
  storage.set(PERIOD_KEY, el.value);
  applyPeriod();
  renderSummary();
  renderValidation();
  recompute();
});

function recompute() {
  if (!data) return;
  const cfg = readSettings();
  const measured = data;
  const withWh = hasWaterHeater(measured.samples);
  const shiftOn = withWh && cfg.waterHeater.shift;
  const build = (shift: boolean) => {
    if (!shift && isNoChange(cfg.scenario)) return measured;
    const scaled = applyScenario(measured.samples, cfg.scenario);
    return prepare(shift ? shiftWaterHeater(scaled, cfg.waterHeater.maxKw) : scaled);
  };
  // Re-prepare only when the data-shaping inputs change; tariff or battery edits reuse it.
  const keyFor = (shift: boolean) => `${cfg.scenario.householdPct}|${cfg.scenario.evPct}|${shift}|${cfg.waterHeater.maxKw}`;
  if (!simData || keyFor(shiftOn) !== simKey) {
    simData = build(shiftOn);
    simKey = keyFor(shiftOn);
  }
  const rec = sweep(simData, cfg.template, cfg.sizes, cfg.tariff, cfg.options, cfg.economics);
  let whItem = '';
  if (withWh) {
    if (!altData || keyFor(!shiftOn) !== altKey) {
      altData = build(!shiftOn);
      altKey = keyFor(!shiftOn);
    }
    const alt = sweep(altData, cfg.template, cfg.sizes, cfg.tariff, cfg.options, cfg.economics);
    whItem = waterHeaterInsight(shiftOn ? rec : alt, shiftOn ? alt : rec, shiftOn, cfg.currency);
  }
  lastRec = rec;
  lastCfg = cfg;
  lastReimb = cfg.reimb.on ? reimbursement(simData.samples, cfg.reimb.prices) : null;
  const extra = [whItem, lastReimb ? reimbursementInsight(rec, lastReimb, cfg.currency) : ''].filter(Boolean);
  renderResults(rec, cfg.currency, cfg.options.evMode, cfg.economics.horizonYears, scenarioNote(rec, cfg), extra);
}

/**
 * Net electricity cost after the employer's EV reimbursement. Deliberately kept out of the battery
 * maths: it's paid on every EV kWh whatever its source, so it's the same for every battery size.
 */
function reimbursementInsight(rec: Recommendation, r: ReimbursementResult, currency: string): string {
  const f = rec.annualFactor;
  const paid = r.total * f;
  const focus = rec.best ?? rec.knee;
  const net = (cost: number) => (cost - paid >= 0 ? money(cost - paid, currency) : `${money(paid - cost, currency)} earned`);
  const withBattery = focus ? `, ${net(focus.annual.netCost)} with the ${focus.nominalKwh} kWh battery` : '';
  return (
    `<b>Employer EV reimbursement:</b> ${money(paid, currency)} a year for ${kwh(r.evKwh * f)} charged. ` +
    `Net electricity cost after it: ${net(rec.baseline.annual.netCost)} without a battery${withBattery}. ` +
    `The battery's saving and payback are unchanged — you're paid for every kWh the car takes, whether it came from the grid, solar or the battery.`
  );
}

/** Compares the result with the water heater on solar surplus vs. at its measured times. */
function waterHeaterInsight(shifted: Recommendation, measuredTiming: Recommendation, shiftOn: boolean, currency: string): string {
  const save = measuredTiming.baseline.annual.netCost - shifted.baseline.annual.netCost;
  const best = (r: Recommendation) => (r.best ? `${r.best.nominalKwh} kWh (${money(r.best.netBenefit, currency)} net)` : 'no size pays back');
  if (Math.abs(save) < 5) {
    return `<b>Water heater:</b> moving it to solar hours changes little (${money(save, currency)} a year) — it already runs when solar is available, or there's little surplus to use.`;
  }
  const neither = !shifted.best && !measuredTiming.best;
  const batteryPart = neither
    ? 'At these prices no battery pays back with either timing.'
    : shiftOn
      ? `Best battery: ${best(measuredTiming)} with the measured timing, ${best(shifted)} with it shifted (shown here).`
      : shifted.best && measuredTiming.best && shifted.best.nominalKwh === measuredTiming.best.nominalKwh
        ? `The best battery stays ${shifted.best.nominalKwh} kWh; its net benefit becomes ${money(shifted.best.netBenefit, currency)} instead of ${money(measuredTiming.best.netBenefit, currency)}${shifted.best.netBenefit < measuredTiming.best.netBenefit ? ', since the heater then uses solar the battery would have stored' : ''}.`
        : `The best battery would be ${best(shifted)} instead of ${best(measuredTiming)}.`;
  return shiftOn
    ? `<b>Water heater on solar surplus</b> saves ${money(save, currency)} a year before any battery, compared with its measured timing. ${batteryPart}`
    : `<b>Try “Run water heater on solar surplus”</b> in Strategy: it would save ${money(save, currency)} a year with no battery at all. ${batteryPart} A timer or solar diverter on the heater does this.`;
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
        <p>${lifespan(best, currency, lifetime)}</p>
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

const lasts = (r: SweepRow) => (Number.isFinite(r.lifeYears) ? years(r.lifeYears) : 'indefinitely');

/** How long a size lasts and what wear costs over the comparison period. */
function lifespan(r: SweepRow, currency: string, horizon: number): string {
  const life = Number.isFinite(r.lifeYears) ? `about ${years(r.lifeYears)}` : lasts(r);
  const replaced = r.replacements
    ? `replaced ${r.replacements === 1 ? 'once' : `${r.replacements} times`} within ${horizon} years (${money(r.replacementCost, currency)})`
    : `not replaced within ${horizon} years`;
  return `At ${Math.round(r.annual.cycles)} cycles a year it lasts ${life} before dropping to 70 % capacity, so it's ${replaced}; ` +
    `the life left at the end is worth ${money(r.residualValue, currency)}, counted in the net benefit.`;
}

function insights(rec: Recommendation, focus: SweepRow | null, currency: string, evMode: string, extra: string[] = []): string {
  if (!data) return '';
  const items: string[] = [...extra];
  const base = rec.baseline.annual;
  if (rec.knee) {
    items.push(
      `<b>${rec.knee.nominalKwh} kWh</b> already captures 90 % of the maximum possible saving. Beyond that, each extra kWh adds little.`,
    );
  }
  const sized = rec.rows.filter((r) => r.nominalKwh > 0);
  if (sized.length > 1) {
    const small = sized[0];
    const large = sized[sized.length - 1];
    items.push(
      `<b>Bigger batteries cycle less and last longer:</b> ${small.nominalKwh} kWh does ${Math.round(small.annual.cycles)} cycles a year and lasts ${lasts(small)}; ` +
        `${large.nominalKwh} kWh does ${Math.round(large.annual.cycles)} and lasts ${lasts(large)}. ` +
        (large.lifeYears > small.lifeYears * 1.3
          ? 'Replacements and leftover value are in the net benefit of each size.'
          : 'Age, not cycling, sets the life here, so size barely changes it.'),
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
  const evGrid = evFromGrid((simData ?? data).samples) * rec.annualFactor;
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
        <td>${num1(r.annual.cycles)}</td>
        <td>${r.nominalKwh ? lasts(r) : '–'}</td><td>${r.nominalKwh ? r.replacements : '–'}</td>
        <td>${r.nominalKwh ? money(r.residualValue, currency) : '–'}</td></tr>`;
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
            <th>Lasts</th><th>Replacements</th><th>Value left</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
}

/** Banner shown while a what-if is active, comparing it with the measured history. */
function scenarioNote(rec: Recommendation, cfg: ReturnType<typeof readSettings>): string {
  if (!data || isNoChange(cfg.scenario)) return '';
  const measured = simulate(data, { ...cfg.template, nominalKwh: 0 }, cfg.tariff, cfg.options);
  const f = rec.annualFactor;
  const now = rec.baseline.annual;
  return `<p class="note"><b>What-if: ${escapeHtml(describeScenario(cfg.scenario))}.</b>
    Yearly use ${kwh(measured.totalLoadKwh * f)} → ${kwh(now.totalLoadKwh)}; bill without a battery
    ${money(measured.netCost * f, cfg.currency)} → ${money(now.netCost, cfg.currency)}.
    The result below compares batteries under this scenario. Set both changes to 0 to go back to your measured data.</p>`;
}

function renderResults(rec: Recommendation, currency: string, evMode: string, lifetime: number, scenarioHtml = '', extra: string[] = []) {
  const focus = rec.best ?? rec.knee;
  const dataWarning = failedChecks.length
    ? `<p class="note"><b>Check your data first.</b> Step 2 flagged: ${escapeHtml(failedChecks.join('; '))}.
       This result is computed from that data as-is.</p>`
    : '';
  $('#results-body').innerHTML = `
    ${dataWarning}
    ${scenarioHtml}
    ${verdict(rec, currency, lifetime)}
    ${insights(rec, focus, currency, evMode, extra)}
    <div class="charts">
      <figure>
        <figcaption>Savings vs. battery cost over the period<small>Cost = purchase + replacements − value left at the end. Savings above the cost line means the battery pays for itself</small></figcaption>
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
    <h3>Hour by hour with a battery</h3>
    <p class="hint">What the simulated battery does each hour. Opens on a recent sunny spell; pick a winter week to see where batteries struggle.</p>
    <div class="sim-controls">
      <label>Battery size
        <select id="sim-size">${rec.rows
          .filter((r) => r.nominalKwh > 0)
          .map((r) => `<option value="${r.nominalKwh}">${r.nominalKwh} kWh${r === rec.best ? ' (best value)' : r === rec.knee ? ' (90 % of max saving)' : ''}</option>`)
          .join('')}</select>
      </label>
      <label>From
        <span class="date-step">
          <button class="link-btn" type="button" data-sim-shift="-7" aria-label="Previous week">◀ Week</button>
          <span class="date-field">
            <input id="sim-start" type="date" class="date-native" tabindex="-1" aria-hidden="true" />
            <button type="button" class="date-display" data-for="sim-start" aria-label="Choose the start date"></button>
          </span>
          <button class="link-btn" type="button" data-sim-shift="7" aria-label="Next week">Week ▶</button>
        </span>
      </label>
      <label>Show
        <select id="sim-days"><option value="1">1 day</option><option value="3">3 days</option><option value="7">7 days</option><option value="14">14 days</option></select>
      </label>
      <label>EV charger
        <select id="sim-ev"><option value="exclude">Battery never charges the car</option><option value="include">Battery may charge the car</option></select>
      </label>
    </div>
    <div class="charts">
      <figure class="wide">
        <figcaption>Energy stored in the battery<small>Usable capacity at the top of the scale</small></figcaption>
        <div class="chart-box short"><canvas id="chart-soc" role="img" aria-label="Battery state of charge per hour"></canvas></div>
      </figure>
      <figure class="wide">
        <figcaption>Battery charge and discharge per hour<small>Above zero: charging. Below zero: discharging. Lines show solar and total home use for context.</small></figcaption>
        <div class="chart-box tall"><canvas id="chart-flows" role="img" aria-label="Battery charging and discharging per hour"></canvas></div>
      </figure>
    </div>
    <p id="sim-summary" class="hint"></p>
    ${table(rec, currency, focus)}
    <div class="actions inline">
      <button id="xlsx-export" class="primary" type="button">Download results (Excel)</button>
      <span class="hint" style="margin:0">Summary, all sizes, monthly totals and the hourly data, in one .xlsx file.</span>
    </div>`;
  renderCharts(rec, focus, currency);
  renderBatterySim(rec);
  renderLive(rec, currency, lifetime);
}

// ---------- assumptions panel: live result + mobile drawer ----------

/** Compact result in the panel header, so the effect of each change is visible without scrolling. */
function renderLive(rec: Recommendation, currency: string, lifetime: number) {
  const flags: string[] = [];
  if (lastCfg && !isNoChange(lastCfg.scenario)) flags.push(`what-if: ${describeScenario(lastCfg.scenario)}`);
  if (failedChecks.length) flags.push(`${failedChecks.length} data warning${failedChecks.length === 1 ? '' : 's'}`);
  const tail = flags.length ? `<br><span class="live-sub">⚠ ${escapeHtml(flags.join(' · '))}</span>` : '';
  const best = rec.best;
  if (best) {
    $('#live').innerHTML =
      `<span class="live-main live-good">Best value: ${best.nominalKwh} kWh</span><br>` +
      `<span class="live-sub">Payback ${years(best.paybackYears)} · saves ${money(best.annualSavings, currency)}/yr · ` +
      `${money(best.netBenefit, currency)} net over ${lifetime} yrs</span>${tail}`;
    return;
  }
  const fastest = rec.rows.filter((r) => r.nominalKwh > 0).sort((x, y) => x.paybackYears - y.paybackYears)[0];
  $('#live').innerHTML =
    `<span class="live-main live-bad">No size pays back in ${lifetime} yrs</span><br>` +
    `<span class="live-sub">Fastest: ${fastest ? `${fastest.nominalKwh} kWh at ${years(fastest.paybackYears)}` : '—'}</span>${tail}`;
}

$('#panel-toggle').addEventListener('click', () => {
  const open = $('#panel').classList.toggle('open');
  $('#panel-toggle').setAttribute('aria-expanded', String(open));
});

// ---------- hour-by-hour battery view ----------

let simSizeChoice: number | null = null;
let simStart = '';
let simDays = 3;

/**
 * Default window: the most recent day with solar in the top quarter of all days, so the view
 * opens on a period where the battery actually cycles (winter days often show it idle).
 */
function sunnySpellStart(days: number): string {
  const sorted = daily.map((d) => d.solar).sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.75)] ?? 0;
  const sunny = [...daily].reverse().find((d) => d.solar >= threshold && d.solar > 0) ?? daily[daily.length - 1];
  const start = new Date(`${sunny.day}T12:00`);
  start.setDate(start.getDate() - Math.floor((days - 1) / 2));
  return localDay(Math.max(start.getTime(), new Date(`${daily[0].day}T12:00`).getTime()));
}

function renderBatterySim(rec: Recommendation) {
  if (!simData || !lastCfg) return;
  const sizes = rec.rows.filter((r) => r.nominalKwh > 0).map((r) => r.nominalKwh);
  if (sizes.length === 0) return;
  const fallback = rec.best?.nominalKwh ?? rec.knee?.nominalKwh ?? sizes[Math.min(4, sizes.length - 1)];
  const size = simSizeChoice !== null && sizes.includes(simSizeChoice) ? simSizeChoice : fallback;
  const samples = simData.samples;
  const first = localDay(samples[0].t);
  const last = localDay(samples[samples.length - 1].t);
  if (!simStart || simStart < first || simStart > last) simStart = sunnySpellStart(simDays);

  const sizeSel = $<HTMLSelectElement>('#sim-size');
  const startIn = $<HTMLInputElement>('#sim-start');
  sizeSel.value = String(size);
  startIn.min = first;
  startIn.max = last;
  setDateField(startIn, simStart);
  $<HTMLButtonElement>('[data-sim-shift="-7"]').disabled = simStart <= first;
  $<HTMLButtonElement>('[data-sim-shift="7"]').disabled = simStart >= last;
  $<HTMLSelectElement>('#sim-days').value = String(simDays);
  $<HTMLSelectElement>('#sim-ev').value = lastCfg.options.evMode;

  const spec = { ...lastCfg.template, nominalKwh: size };
  const trace = createTrace(samples.length);
  simulate(simData, spec, lastCfg.tariff, lastCfg.options, trace);

  const startMs = new Date(`${simStart}T00:00`).getTime();
  const endDate = new Date(`${simStart}T00:00`);
  endDate.setDate(endDate.getDate() + simDays);
  const idx: number[] = [];
  samples.forEach((s, i) => {
    if (s.t >= startMs && s.t < endDate.getTime()) idx.push(i);
  });
  const pick = (arr: Float32Array) => idx.map((i) => arr[i]);
  const usable = usableKwh(spec);
  renderBatteryCharts({
    times: idx.map((i) => samples[i].t),
    usableKwh: usable,
    soc: pick(trace.soc),
    chargeSolar: pick(trace.chargeSolar),
    chargeGrid: pick(trace.chargeGrid),
    toHouse: pick(trace.toHouse),
    toEv: pick(trace.toEv),
    solar: idx.map((i) => samples[i].solar),
    load: idx.map((i) => samples[i].house + samples[i].ev + (samples[i].wh ?? 0)),
  });

  const sum = (arr: Float32Array) => idx.reduce((a, i) => a + arr[i], 0);
  const withoutBattery = idx.reduce((a, i) => {
    const s = samples[i];
    return a + Math.max(0, s.house + s.ev + (s.wh ?? 0) - s.solar);
  }, 0);
  const fullHours = idx.filter((i) => trace.soc[i] >= usable * 0.98).length;
  const emptyHours = idx.filter((i) => trace.soc[i] <= usable * 0.02).length;
  const toEv = sum(trace.toEv);
  $('#sim-summary').innerHTML = idx.length
    ? `In this period the ${size} kWh battery took in <b>${kwh(sum(trace.chargeSolar))}</b> from solar` +
      `${sum(trace.chargeGrid) > 0.05 ? ` and ${kwh(sum(trace.chargeGrid))} from the grid` : ''}, delivered <b>${kwh(sum(trace.toHouse))}</b> to the house` +
      `${lastCfg.options.evMode === 'include' ? ` and <b>${kwh(toEv)}</b> to the EV` : ''}. ` +
      `It was full for ${fullHours} h and empty for ${emptyHours} h. Grid import: ${kwh(sum(trace.gridImport))} with the battery vs ${kwh(withoutBattery)} without.`
    : 'No data in this period.';
}

// Week buttons keep the chosen span and move the window by 7 days, within the data.
$('#results-body').addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-sim-shift]');
  if (!button || !lastRec || !simData) return;
  const samples = simData.samples;
  simStart = addDays(simStart, Number(button.dataset.simShift), localDay(samples[0].t), localDay(samples[samples.length - 1].t));
  renderBatterySim(lastRec);
});

$('#results-body').addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  if (!lastRec) return;
  if (el.id === 'sim-size') simSizeChoice = Number(el.value);
  else if (el.id === 'sim-start' && el.value) simStart = el.value;
  else if (el.id === 'sim-days') simDays = Number(el.value);
  else if (el.id === 'sim-ev') {
    // Same setting as Strategy → EV charger, so the whole result follows the choice.
    (form.elements.namedItem('evMode') as HTMLSelectElement).value = el.value;
    saveSettings();
    recompute();
    return;
  } else return;
  renderBatterySim(lastRec);
});

// Re-draw charts when the OS theme flips so their colours follow.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (data) showDay(selectedDay);
  if (lastRec) recompute();
});

// ---------- step 2: check your data ----------

let daily: DayTotals[] = [];
let profile: HourProfile = { house: [], ev: [], wh: [], solar: [] };
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
  return fmtDateTime(t);
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
  const withWh = hasWaterHeater(data.samples);
  const fmt = (v: number) => num1(v);
  const meter = hasMeterGrid(data.samples);
  const keys = ['house', 'ev', 'wh', 'solar', 'gridImport', 'gridExport', 'meterImport', 'meterExport', 'hours', 'expectedHours'] as const;
  const total = Object.fromEntries(keys.map((k) => [k, months.reduce((a, m) => a + m[k], 0)])) as Record<(typeof keys)[number], number>;
  // With a grid meter, its own import/export sit next to the hourly-netted values the simulation uses.
  const gridCells = (m: typeof total) =>
    meter
      ? `<td>${fmt(m.meterImport)}</td><td>${fmt(m.gridImport)}</td><td>${fmt(m.meterExport)}</td><td>${fmt(m.gridExport)}</td>`
      : `<td>${fmt(m.gridImport)}</td><td>${fmt(m.gridExport)}</td>`;
  const row = (label: string, m: typeof total, cls = '') => {
    const coverage = m.expectedHours ? m.hours / m.expectedHours : 1;
    return `<tr${cls || coverage < 0.98 ? ` class="${cls || 'short'}"` : ''}>
      <td>${label}</td><td>${fmt(m.house)}</td><td>${fmt(m.ev)}</td>${withWh ? `<td>${fmt(m.wh)}</td>` : ''}
      <td>${fmt(m.house + m.ev + m.wh)}</td><td>${fmt(m.solar)}</td>${gridCells(m)}
      <td>${pct(coverage)}</td></tr>`;
  };
  const gridHead = meter
    ? '<th>Grid import (meter)</th><th>Import in simulation*</th><th>Grid export (meter)</th><th>Export in simulation*</th>'
    : '<th>Grid import* kWh</th><th>Grid export* kWh</th>';
  $('#month-table').innerHTML = `
    <table>
      <thead><tr>
        <th>Month</th><th>House kWh</th><th>EV kWh</th>${withWh ? '<th>Water heater kWh</th>' : ''}<th>Total use kWh</th><th>Solar kWh</th>
        ${gridHead}<th>Hours with data</th>
      </tr></thead>
      <tbody>
        ${months
          .map((m) => row(fmtMonth(m.month), m))
          .join('')}
        ${row('Total', total, 'hl')}
      </tbody>
    </table>
    <p class="hint">${
      meter
        ? '* The simulation works per hour: import and export within the same hour cancel out, so its values are lower than the meter\'s by the same amount. The meter columns, total use and solar should match your monitoring app (e.g. HomeWizard).'
        : '* Without a battery, netted per hour. Monitoring apps measure import and export continuously, so both of their figures can be slightly higher; total use and solar should match closely.'
    }</p>`;
}

function renderDayTable(samples: HourSample[]) {
  const withWh = samples.some((s) => s.wh !== undefined);
  const cell = (v: number, bad: boolean) => `<td${bad ? ' class="flag"' : ''}>${v.toFixed(2)}</td>`;
  $('#day-table').innerHTML = samples.length
    ? `<table>
        <thead><tr><th>Hour</th><th>House kWh</th><th>EV kWh</th>${withWh ? '<th>Water heater kWh</th>' : ''}<th>Solar kWh</th>
          <th>Grid import* kWh</th><th>Grid export* kWh</th></tr></thead>
        <tbody>${samples
          .map((s) => {
            const h = new Date(s.t).getHours();
            const wh = s.wh ?? 0;
            const load = s.house + s.ev + wh;
            return `<tr><td>${fmtTime(s.t)}</td>
              ${cell(s.house, s.house > LIMITS.houseKwh || load < 0.01)}${cell(s.ev, s.ev > LIMITS.evKwh)}
              ${withWh ? cell(wh, wh > LIMITS.whKwh) : ''}
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
  setDateField(dayPick, day);
  $<HTMLButtonElement>('#day-prev').disabled = day <= dayPick.min;
  $<HTMLButtonElement>('#day-next').disabled = day >= dayPick.max;
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

for (const [id, n] of [['#day-prev', -1], ['#day-next', 1]] as const) {
  $(id).addEventListener('click', () => {
    if (selectedDay) showDay(addDays(selectedDay, n, dayPick.min, dayPick.max));
  });
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

// ---------- Excel export ----------

$('#results-body').addEventListener('click', async (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('#xlsx-export');
  if (!button || !lastRec || !lastCfg || !simData) return;
  button.disabled = true;
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    await exportExcel(
      {
        rec: lastRec,
        samples: simData.samples,
        dataLabel,
        tariff: lastCfg.tariff,
        economics: lastCfg.economics,
        template: lastCfg.template,
        options: lastCfg.options,
        scenario: lastCfg.scenario,
        waterHeater: lastCfg.waterHeater,
        reimbursement: lastReimb,
        currency: lastCfg.currency,
        failedChecks,
        generatedAt: new Date(),
      },
      `battery-sizer-${stamp}.xlsx`,
    );
  } catch (err) {
    setStatus(`Excel export failed: ${(err as Error).message}`, 'error');
  } finally {
    button.disabled = false;
  }
});

// ---------- restore the last loaded data ----------

$('#data-forget').addEventListener('click', () => {
  clearDataset();
  $('#data-forget').hidden = true;
  setStatus('Saved data removed from this browser. It stays on screen until you refresh.', 'info');
});

const saved = loadDataset();
if (saved) setData(saved.samples, saved.label, saved.notes, saved.savedAt);

// ---------- date fields shown as DD/MMM/YYYY ----------
// A native date input always displays in the browser's regional format, so it stays hidden and a
// button shows the date in the app's format and opens the native calendar.

function setDateField(input: HTMLInputElement, day: string) {
  input.value = day;
  const display = document.querySelector<HTMLButtonElement>(`.date-display[data-for="${input.id}"]`);
  if (display) display.textContent = day ? `${fmtDate(day)} ▾` : 'Pick a date ▾';
}

document.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('.date-display');
  if (!button) return;
  const input = document.getElementById(button.dataset.for ?? '') as HTMLInputElement | null;
  if (!input) return;
  try {
    input.showPicker();
  } catch {
    input.focus();
    input.click();
  }
});

// A date picked in the calendar updates the button text too.
document.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.classList?.contains('date-native') && input.value) setDateField(input, input.value);
});
