import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works from any sub-path (GitHub Pages, a Capacitor shell, a local file server).
  base: './',
  // Fixed port, kept clear of Vite's default 5173. strictPort makes Vite stop with an error if 8050
  // is taken, instead of silently moving to another port. host: true listens on the local network
  // too, so the app can run on a Raspberry Pi and be opened from a laptop or phone. allowedHosts
  // accepts any hostname (e.g. raspberrypi.local); Vite otherwise rejects names other than localhost/IPs.
  server: { port: 8050, strictPort: true, host: true, allowedHosts: true },
  preview: { port: 8050, strictPort: true, host: true, allowedHosts: true },
});
