/**
 * Minimal Home Assistant WebSocket client.
 *
 * Uses three commands:
 * - `energy/get_prefs`               → which statistics the Energy dashboard uses (grid, solar, battery, devices)
 * - `recorder/list_statistic_ids`    → every long-term statistic, so you can pick an EV charger manually
 * - `recorder/statistics_during_period` → hourly energy deltas ("change") for the chosen statistics
 *
 * Long-term statistics are kept indefinitely by HA's recorder, so a full year of hourly data
 * is normally available even though raw state history is purged after ~10 days.
 */

export interface StatisticMeta {
  statistic_id: string;
  name: string | null;
  statistics_unit_of_measurement: string | null;
  has_sum: boolean;
}

export interface StatisticPoint {
  start: number | string;
  change?: number | null;
}

export interface EnergySelection {
  gridImport: string[];
  gridExport: string[];
  solar: string[];
  batteryOut: string[];
  batteryIn: string[];
  /** Candidate EV/device consumption statistics from the Energy dashboard. */
  devices: { id: string; name: string }[];
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export function toWebSocketUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = '/api/websocket';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export class HomeAssistantClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => this.onMessage(ev));
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Connection to Home Assistant closed'));
      this.pending.clear();
    });
  }

  static connect(baseUrl: string, token: string, timeoutMs = 15000): Promise<HomeAssistantClient> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(toWebSocketUrl(baseUrl));
      } catch (e) {
        reject(new Error(`Invalid Home Assistant URL: ${(e as Error).message}`));
        return;
      }
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Timed out connecting to Home Assistant'));
      }, timeoutMs);
      const fail = (msg: string) => {
        clearTimeout(timer);
        reject(new Error(msg));
      };
      ws.addEventListener('error', () =>
        fail(
          'Could not reach Home Assistant. Check the URL, and note that a page served over https ' +
            'cannot connect to an http:// Home Assistant (run this app locally with `npm run dev` instead).',
        ),
      );
      const onAuth = (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'auth_required') {
          ws.send(JSON.stringify({ type: 'auth', access_token: token.trim() }));
        } else if (msg.type === 'auth_ok') {
          clearTimeout(timer);
          ws.removeEventListener('message', onAuth);
          resolve(new HomeAssistantClient(ws));
        } else if (msg.type === 'auth_invalid') {
          ws.close();
          fail('Home Assistant rejected the access token');
        }
      };
      ws.addEventListener('message', onAuth);
    });
  }

  private onMessage(ev: MessageEvent) {
    const msg = JSON.parse(String(ev.data));
    if (msg.type !== 'result') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.success) p.resolve(msg.result);
    else p.reject(new Error(msg.error?.message ?? 'Home Assistant command failed'));
  }

  call<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, type, ...payload }));
    });
  }

  close() {
    this.ws.close();
  }

  async energyPrefs(): Promise<unknown> {
    return this.call('energy/get_prefs');
  }

  async energyStatistics(): Promise<StatisticMeta[]> {
    const all = await this.call<StatisticMeta[]>('recorder/list_statistic_ids', { statistic_type: 'sum' });
    return all.filter((s) => /^(w|kw|mw)h$/i.test(s.statistics_unit_of_measurement ?? ''));
  }

  /**
   * Hourly kWh deltas for each statistic between start and end. Requested in 31-day chunks
   * to keep individual WebSocket messages a reasonable size.
   */
  async hourlyChanges(
    ids: string[],
    start: Date,
    end: Date,
    onProgress?: (fraction: number) => void,
  ): Promise<Record<string, StatisticPoint[]>> {
    const out: Record<string, StatisticPoint[]> = {};
    for (const id of ids) out[id] = [];
    if (ids.length === 0) return out;
    const chunkMs = 31 * 24 * 3600 * 1000;
    const total = end.getTime() - start.getTime();
    for (let t = start.getTime(); t < end.getTime(); t += chunkMs) {
      const chunkEnd = Math.min(t + chunkMs, end.getTime());
      const result = await this.call<Record<string, StatisticPoint[]>>('recorder/statistics_during_period', {
        start_time: new Date(t).toISOString(),
        end_time: new Date(chunkEnd).toISOString(),
        statistic_ids: ids,
        period: 'hour',
        types: ['change'],
        units: { energy: 'kWh' },
      });
      for (const id of ids) out[id].push(...(result[id] ?? []));
      onProgress?.((chunkEnd - start.getTime()) / total);
    }
    return out;
  }
}

const EV_PATTERN = /\b(ev|car|charger|charging|wallbox|zappi|easee|tesla|wall[_ ]?connector|go[-_ ]?e|ohme|keba|pod[_ ]?point|alfen|myenergi)\b/i;

export function looksLikeEv(text: string): boolean {
  return EV_PATTERN.test(text.replace(/[._]/g, ' '));
}

// English plus common Spanish/French/German/Dutch/Italian names, and popular heat-pump water heater brands.
const WATER_HEATER_PATTERN =
  /\b(water[ _]?heater|hot[ _]?water|dhw|boiler|geyser|cylinder|ecs|acs|termo|termo ?acumulador|calentador|chauffe[ _]?eau|ballon|warmwasser|warmtepompboiler|scaldabagno|aquarea|ariston|nuos|thermor|ecodan|atlantic)\b/i;

export function looksLikeWaterHeater(text: string): boolean {
  return WATER_HEATER_PATTERN.test(text.replace(/[._]/g, ' '));
}

/**
 * Reads the Energy dashboard preferences into a flat selection. Defensive about shape because
 * the prefs format has changed between Home Assistant releases.
 */
export function parseEnergyPrefs(prefs: any): EnergySelection {
  const sel: EnergySelection = { gridImport: [], gridExport: [], solar: [], batteryOut: [], batteryIn: [], devices: [] };
  const push = (arr: string[], v: unknown) => {
    if (typeof v === 'string' && v && !arr.includes(v)) arr.push(v);
  };
  for (const src of prefs?.energy_sources ?? []) {
    switch (src?.type) {
      case 'grid':
        for (const f of src.flow_from ?? []) push(sel.gridImport, f?.stat_energy_from);
        for (const f of src.flow_to ?? []) push(sel.gridExport, f?.stat_energy_to);
        push(sel.gridImport, src.stat_energy_from);
        push(sel.gridExport, src.stat_energy_to);
        break;
      case 'solar':
        push(sel.solar, src.stat_energy_from);
        break;
      case 'battery':
        push(sel.batteryOut, src.stat_energy_from);
        push(sel.batteryIn, src.stat_energy_to);
        break;
    }
  }
  for (const d of prefs?.device_consumption ?? []) {
    if (typeof d?.stat_consumption === 'string') {
      sel.devices.push({ id: d.stat_consumption, name: d.name || d.stat_consumption });
    }
  }
  return sel;
}
