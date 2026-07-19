import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // `pnpm --filter @cerberus/dashboard dev` talks to a locally running orchestrator.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
