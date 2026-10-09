/// <reference types="node" />
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

/**
 * Keeps the loaded history on the machine that serves the app (e.g. the Raspberry Pi), so every
 * device on the network sees the same data. One file, `dataset.json`, in the same compact format the
 * browser uses; the version before each save or delete is kept as `dataset.prev.json`.
 *
 * GET returns it (204 when there is none), PUT replaces it, DELETE removes it. A PUT that carries
 * `X-Base-Saved-At` (the version the browser last saw, or "none") is refused with 409 when the stored
 * version differs, so one device can't silently overwrite what another just added.
 */
export const API_PATH = '/api/dataset';
const MAX_BYTES = 50 * 1024 * 1024;

type Next = (err?: unknown) => void;

export function datasetStore(dir: string) {
  const file = join(dir, 'dataset.json');
  const prev = join(dir, 'dataset.prev.json');
  const read = async () => {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return null;
    }
  };
  const keepPrevious = async (current: string | null) => {
    if (current !== null) await writeFile(prev, current);
  };

  return async function handle(req: IncomingMessage, res: ServerResponse, next: Next) {
    if ((req.url ?? '').split('?')[0] !== API_PATH) return next();
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method === 'GET') {
        const text = await read();
        if (text === null) return send(res, 204);
        res.setHeader('Content-Type', 'application/json');
        return send(res, 200, text);
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 413, 'Too large');
        const savedAt = savedAtOf(body);
        if (savedAt === null) return send(res, 400, 'Not a dataset');
        const current = await read();
        const base = req.headers['x-base-saved-at'];
        if (typeof base === 'string') {
          const stored = current === null ? 'none' : String(savedAtOf(current));
          if (stored !== base) {
            res.setHeader('Content-Type', 'application/json');
            return send(res, 409, JSON.stringify({ savedAt: current === null ? null : savedAtOf(current) }));
          }
        }
        await mkdir(dir, { recursive: true });
        await keepPrevious(current);
        await writeFile(`${file}.tmp`, body);
        await rename(`${file}.tmp`, file); // atomic: a crash never leaves half a file
        return send(res, 204);
      }
      if (req.method === 'DELETE') {
        const current = await read();
        await keepPrevious(current);
        await rm(file, { force: true });
        return send(res, 204);
      }
      res.setHeader('Allow', 'GET, PUT, DELETE');
      return send(res, 405);
    } catch (err) {
      return send(res, 500, (err as Error).message);
    }
  };
}

function send(res: ServerResponse, status: number, body?: string) {
  res.statusCode = status;
  res.end(body);
}

/** The dataset's savedAt, or null when the text isn't one (checked lightly: format v1 with hours). */
function savedAtOf(text: string): number | null {
  try {
    const d = JSON.parse(text);
    return d?.v === 1 && Array.isArray(d.h) && typeof d.savedAt === 'number' ? d.savedAt : null;
  } catch {
    return null;
  }
}

/** The request body as text, or null when it's over MAX_BYTES. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BYTES) tooLarge = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
