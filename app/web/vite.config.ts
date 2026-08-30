import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // The supervisor's server owns /api and the websockets; Vite only serves the UI.
  server: { proxy: { '/api': 'http://127.0.0.1:8787', '/ws': { target: 'ws://127.0.0.1:8787', ws: true } } },
  build: { outDir: 'dist', emptyOutDir: true },
});
