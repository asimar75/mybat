import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works from any sub-path (GitHub Pages, a Capacitor shell, a local file server).
  base: './',
});
