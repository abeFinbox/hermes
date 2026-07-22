import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Node backend (default) — bare paths
      '/api': 'http://localhost:4000',
      '/mock': 'http://localhost:4000',
      // Go backend — reached under the /_go prefix, which is stripped before
      // forwarding so the Go server sees the same /api and /mock paths. Keeps
      // everything same-origin so the shared session cookie is always sent.
      '/_go': {
        target: 'http://localhost:4001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/_go/, ''),
      },
    },
  },
});
