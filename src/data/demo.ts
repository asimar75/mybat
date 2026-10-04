import type { HourSample } from '../engine/types';
import { HOUR_MS } from './derive';

/** Small deterministic PRNG so the demo looks the same on every load. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One synthetic year for a mid-latitude (~45°N) home: 6 kWp solar, ~5,100 kWh/year household
 * use, and an EV charged three evenings a week at 7.4 kW (~3,000 kWh/year).
 */
export function demoYear(year = new Date().getFullYear() - 1): HourSample[] {
  const rand = mulberry32(42);
  const start = new Date(year, 0, 1).getTime();
  const samples: HourSample[] = [];
  const kWp = 6;
  let cloud = 0.7;

  for (let day = 0; day < 365; day++) {
    const season = Math.cos(((day - 172) / 365) * 2 * Math.PI); // +1 at midsummer, −1 at midwinter
    const daylight = 12 + 3.5 * season;
    const sunrise = 12.5 - daylight / 2;
    const peakYield = kWp * (0.55 + 0.25 * season); // clear-sky kW at noon
    cloud = Math.min(1, Math.max(0.1, cloud * 0.6 + rand() * 0.55 + 0.05 * season));
    const weekday = new Date(start + day * 24 * HOUR_MS).getDay();
    const evToday = weekday === 1 || weekday === 3 || weekday === 5;
    const evNeed = evToday ? 16 + rand() * 10 : 0; // kWh per session
    const heating = Math.max(0, -season) * 0.25; // extra winter load, kW

    for (let h = 0; h < 24; h++) {
      const t = start + (day * 24 + h) * HOUR_MS;
      const x = (h + 0.5 - sunrise) / daylight;
      const solar = x > 0 && x < 1 ? peakYield * Math.sin(Math.PI * x) * cloud * (0.85 + rand() * 0.15) : 0;

      const morning = Math.exp(-((h - 7.5) ** 2) / 2) * 0.6;
      const evening = Math.exp(-((h - 19) ** 2) / 4) * 1.0;
      const house = 0.22 + heating + morning + evening + rand() * 0.15;

      let ev = 0;
      if (evNeed > 0 && h >= 18) {
        const delivered = (h - 18) * 7.4;
        ev = Math.max(0, Math.min(7.4, evNeed - delivered));
      }
      samples.push({ t, house, solar, ev });
    }
  }
  return samples;
}
