import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { datasetStore, settingsStore } from './server/dataset-store.ts';

/**
 * Stores the loaded history and the settings on the machine running the app (e.g. the Raspberry Pi),
 * so all devices share them. Files go to MYBAT_DATA_DIR, or ./data next to the app (git-ignored).
 */
function datasetStorePlugin(): Plugin {
  const dir = process.env.MYBAT_DATA_DIR ?? join(process.cwd(), 'data');
  const handlers = [datasetStore(dir), settingsStore(dir)];
  return {
    name: 'mybat-dataset-store',
    configureServer: (server) => handlers.forEach((h) => server.middlewares.use(h)),
    configurePreviewServer: (server) => handlers.forEach((h) => server.middlewares.use(h)),
  };
}

export default defineConfig({
  // Relative base so the build works from any sub-path (GitHub Pages, a Capacitor shell, a local file server).
  base: './',
  plugins: [datasetStorePlugin()],
  // Fixed port, kept clear of Vite's default 5173. strictPort makes Vite stop with an error if 8050
  // is taken, instead of silently moving to another port. host: true listens on the local network
  // too, so the app can run on a Raspberry Pi and be opened from a laptop or phone. allowedHosts
  // accepts any hostname (e.g. raspberrypi.local); Vite otherwise rejects names other than localhost/IPs.
  server: { port: 8050, strictPort: true, host: true, allowedHosts: true },
  preview: { port: 8050, strictPort: true, host: true, allowedHosts: true },
});
