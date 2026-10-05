import { describe, expect, it } from 'vitest';
import { decodeDataset, encodeDataset } from './persist';
import { demoYear } from './demo';

describe('dataset persistence encoding', () => {
  it('round-trips a year with gaps to within 1 Wh and stays compact', () => {
    const samples = demoYear(2024).filter((_, i) => i % 1000 !== 5); // introduce gaps
    const raw = encodeDataset({ samples, label: 'demo', notes: ['n1'], savedAt: 123 });
    expect(raw.length).toBeLessThan(400_000);
    const back = decodeDataset(raw)!;
    expect(back.label).toBe('demo');
    expect(back.notes).toEqual(['n1']);
    expect(back.savedAt).toBe(123);
    expect(back.samples).toHaveLength(samples.length);
    back.samples.forEach((s, i) => {
      expect(s.t).toBe(samples[i].t);
      expect(Math.abs(s.house - samples[i].house)).toBeLessThanOrEqual(0.0005);
      expect(Math.abs(s.solar - samples[i].solar)).toBeLessThanOrEqual(0.0005);
      expect(Math.abs(s.ev - samples[i].ev)).toBeLessThanOrEqual(0.0005);
      expect(Math.abs((s.wh ?? -1) - (samples[i].wh ?? 0))).toBeLessThanOrEqual(0.0005);
    });
  });

  it('keeps measured grid flows', () => {
    const samples = demoYear(2024).slice(0, 48).map((s) => ({ ...s, gridIn: 0.5, gridOut: 0.25 }));
    const back = decodeDataset(encodeDataset({ samples, label: 'g', notes: [], savedAt: 1 }))!;
    expect(back.samples[10].gridIn).toBeCloseTo(0.5, 3);
    expect(back.samples[10].gridOut).toBeCloseTo(0.25, 3);
  });

  it('rejects corrupt or foreign data', () => {
    expect(decodeDataset('not json')).toBeNull();
    expect(decodeDataset('{"v":2}')).toBeNull();
    expect(decodeDataset('{"v":1,"h":[0,1],"house":[1],"ev":[0,0],"solar":[0,0],"t0":0}')).toBeNull();
  });
});
