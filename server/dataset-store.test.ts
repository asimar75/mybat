/// <reference types="node" />
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PATH, datasetStore } from './dataset-store';

const dataset = (savedAt: number) => JSON.stringify({ v: 1, label: 'x', notes: [], savedAt, t0: 0, h: [0], house: [1], ev: [0], solar: [0] });

describe('dataset store', () => {
  let dir: string;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mybat-'));
    const handle = datasetStore(join(dir, 'data'));
    server = createServer((req, res) => void handle(req, res, () => ((res.statusCode = 404), res.end('next'))));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${API_PATH}`;
  });
  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const put = (body: string, base?: string) =>
    fetch(url, { method: 'PUT', body, headers: base ? { 'X-Base-Saved-At': base } : {} });

  it('stores, returns, refuses stale writes, keeps the previous version and deletes', async () => {
    expect((await fetch(url)).status).toBe(204); // nothing stored yet

    expect((await put(dataset(100), 'none')).status).toBe(204);
    const got = await fetch(url);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(await got.text()).savedAt).toBe(100);

    // A device that last saw "none" or an older version can't overwrite version 100…
    expect((await put(dataset(200), 'none')).status).toBe(409);
    const stale = await put(dataset(200), '50');
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ savedAt: 100 });
    // …one that saw 100 can, and 100 is kept as the previous version.
    expect((await put(dataset(200), '100')).status).toBe(204);
    expect(JSON.parse(await readFile(join(dir, 'data', 'dataset.prev.json'), 'utf8')).savedAt).toBe(100);

    expect((await put('not json')).status).toBe(400);
    expect((await fetch(url, { method: 'POST' })).status).toBe(405);

    expect((await fetch(url, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(url)).status).toBe(204);
    expect(JSON.parse(await readFile(join(dir, 'data', 'dataset.prev.json'), 'utf8')).savedAt).toBe(200);
  });

  it('leaves other paths to the next handler', async () => {
    const other = await fetch(url.replace(API_PATH, '/index.html'));
    expect(await other.text()).toBe('next');
  });
});
