import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  publicDir: resolve(__dirname, 'src/web/public'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@web': resolve(__dirname, 'src/web'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3010',
      '/healthz': 'http://localhost:3010',
    },
  },
});
