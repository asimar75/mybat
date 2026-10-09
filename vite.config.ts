import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { datasetStore } from './server/dataset-store';

/**
 * Stores the loaded history on the machine running the app (e.g. the Raspberry Pi), so all devices
 * share it. Files go to MYBAT_DATA_DIR, or ./data next to the app (git-ignored).
 */
function datasetStorePlugin(): Plugin {
  const handler = datasetStore(process.env.MYBAT_DATA_DIR ?? join(process.cwd(), 'data'));
  return {
    name: 'mybat-dataset-store',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
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
