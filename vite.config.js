import { defineConfig } from 'vite';
import { attachRelay } from './server/relay.js';

// Hostnames allowed to reach the dev/preview server besides localhost.
// A leading dot allows every subdomain, which covers the random names
// Cloudflare quick tunnels (`cloudflared tunnel --url ...`) hand out.
// Add more with ALLOWED_HOSTS=example.com,.ngrok-free.app npm run dev
const allowedHosts = ['.trycloudflare.com', ...(process.env.ALLOWED_HOSTS || '').split(',').filter(Boolean)];

// Multiplayer: the dev and preview servers also relay game messages on /mp
// (same port, so Codespaces port forwarding and Cloudflare tunnels just work).
const multiplayer = () => ({
  name: 'multiplayer-relay',
  configureServer(server) {
    if (server.httpServer) attachRelay(server.httpServer);
  },
  configurePreviewServer(server) {
    if (server.httpServer) attachRelay(server.httpServer);
  },
});

// `base: './'` keeps the build working on GitHub Pages sub-paths.
// `host: true` exposes the dev server so Codespaces can forward the port.
export default defineConfig({
  base: './',
  plugins: [multiplayer()],
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
