import { defineConfig } from 'vite';

// `base: './'` keeps the build working on GitHub Pages sub-paths.
// `host: true` exposes the dev server so Codespaces can forward the port.
export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // Codespaces serves forwarded ports over HTTPS on 443.
    hmr: process.env.CODESPACES ? { clientPort: 443 } : undefined,
  },
  build: {
    chunkSizeWarningLimit: 1000,
  },
  preview: {
    host: true,
    port: 4173,
  },
});
