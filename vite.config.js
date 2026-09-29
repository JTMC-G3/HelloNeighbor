import { defineConfig } from 'vite';

// Hostnames allowed to reach the dev/preview server besides localhost.
// A leading dot allows every subdomain, which covers the random names
// Cloudflare quick tunnels (`cloudflared tunnel --url ...`) hand out.
// Add more with ALLOWED_HOSTS=example.com,.ngrok-free.app npm run dev
const allowedHosts = ['.trycloudflare.com', ...(process.env.ALLOWED_HOSTS || '').split(',').filter(Boolean)];

// `base: './'` keeps the build working on GitHub Pages sub-paths.
// `host: true` exposes the dev server so Codespaces can forward the port.
export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts,
    // Codespaces serves forwarded ports over HTTPS on 443.
    hmr: process.env.CODESPACES ? { clientPort: 443 } : undefined,
  },
  build: {
    chunkSizeWarningLimit: 1000,
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts,
  },
});
