import { describe, expect, it } from 'vitest';
import { parseCsv, CSV_TEMPLATE } from './csv';
import { deriveSamples } from './derive';
import { looksLikeEv, parseEnergyPrefs, toWebSocketUrl } from './homeassistant';

describe('parseCsv', () => {
  it('parses the template', () => {
    const r = parseCsv(CSV_TEMPLATE);
    expect(r.samples).toHaveLength(4);
    const evening = r.samples[3];
    expect(evening.ev).toBeCloseTo(7.2);
    expect(evening.house).toBeCloseTo(1.2);
  });

  it('treats consumption as total including EV', () => {
    const r = parseCsv('timestamp,consumption_kwh,solar_kwh,ev_kwh\n2025-01-01T18:00,8,0,7');
    expect(r.samples[0].house).toBeCloseTo(1);
    expect(r.samples[0].ev).toBeCloseTo(7);
  });

  it('derives consumption from grid flows, sums 15-minute rows, handles ; and decimal commas', () => {
    const csv = [
      'Timestamp;grid_import_kwh;grid_export_kwh;solar_kwh',
      '2025-01-01 12:00;0,1;0,5;1,0',
      '2025-01-01 12:15;0,1;0,5;1,0',
      '2025-01-01 12:30;0,1;0,5;1,0',
      '2025-01-01 12:45;0,1;0,5;1,0',
    ].join('\n');
    const r = parseCsv(csv);
    expect(r.samples).toHaveLength(1);
    expect(r.samples[0].solar).toBeCloseTo(4);
    expect(r.samples[0].house).toBeCloseTo(0.4 - 2 + 4);
  });

  it('rejects files without the needed columns', () => {
    expect(() => parseCsv('timestamp,solar_kwh\n2025-01-01T00:00,1')).toThrow(/consumption/);
  });
});

describe('deriveSamples', () => {
  it('computes house load from grid, solar, battery and subtracts the EV', () => {
    const t = Date.UTC(2025, 0, 1, 10);
    const stats = {
      'sensor.import': [{ start: t, change: 2 }],
      'sensor.export': [{ start: t, change: 1 }],
      'sensor.solar': [{ start: t, change: 4 }],
      'sensor.bat_out': [{ start: t, change: 0.5 }],
      'sensor.bat_in': [{ start: t, change: 1.5 }],
      'sensor.ev': [{ start: t, change: 2.5 }],
    };
    const r = deriveSamples(stats, {
      gridImport: ['sensor.import'],
      gridExport: ['sensor.export'],
      solar: ['sensor.solar'],
      batteryOut: ['sensor.bat_out'],
      batteryIn: ['sensor.bat_in'],
      ev: 'sensor.ev',
    });
    // 2 − 1 + 4 + 0.5 − 1.5 = 4 total; minus 2.5 EV
    expect(r.samples[0]).toEqual({ t, solar: 4, ev: 2.5, house: 1.5 });
  });

  it('reports gaps and accepts ISO or seconds timestamps', () => {
    const t0 = Date.UTC(2025, 0, 1, 0);
    const stats = {
      g: [
        { start: new Date(t0).toISOString(), change: 1 },
        { start: (t0 + 3 * 3600_000) / 1000, change: 1 },
      ],
    };
    const r = deriveSamples(stats, { gridImport: ['g'], gridExport: [], solar: [], batteryOut: [], batteryIn: [], ev: '' });
    expect(r.samples).toHaveLength(2);
    expect(r.missingHours).toBe(2);
  });
});

describe('home assistant helpers', () => {
  it('builds websocket urls', () => {
    expect(toWebSocketUrl('http://homeassistant.local:8123/')).toBe('ws://homeassistant.local:8123/api/websocket');
    expect(toWebSocketUrl('https://abc.ui.nabu.casa')).toBe('wss://abc.ui.nabu.casa/api/websocket');
    expect(toWebSocketUrl('192.168.1.10:8123')).toBe('ws://192.168.1.10:8123/api/websocket');
  });

  it('parses energy prefs in old and new grid formats', () => {
    const sel = parseEnergyPrefs({
      energy_sources: [
        { type: 'grid', flow_from: [{ stat_energy_from: 'sensor.in1' }], flow_to: [{ stat_energy_to: 'sensor.out1' }] },
        { type: 'grid', stat_energy_from: 'sensor.in2', stat_energy_to: 'sensor.out2' },
        { type: 'solar', stat_energy_from: 'sensor.pv' },
        { type: 'battery', stat_energy_from: 'sensor.bo', stat_energy_to: 'sensor.bi' },
      ],
      device_consumption: [{ stat_consumption: 'sensor.wallbox_energy' }, { stat_consumption: 'sensor.fridge', name: 'Fridge' }],
    });
    expect(sel.gridImport).toEqual(['sensor.in1', 'sensor.in2']);
    expect(sel.gridExport).toEqual(['sensor.out1', 'sensor.out2']);
    expect(sel.solar).toEqual(['sensor.pv']);
    expect(sel.batteryOut).toEqual(['sensor.bo']);
    expect(sel.devices[1].name).toBe('Fridge');
  });

  it('recognises common EV charger names', () => {
    expect(looksLikeEv('sensor.wallbox_energy')).toBe(true);
    expect(looksLikeEv('sensor.zappi_charge_added_session')).toBe(true);
    expect(looksLikeEv('sensor.ev_charger_total')).toBe(true);
    expect(looksLikeEv('sensor.fridge_energy')).toBe(false);
  });
});
