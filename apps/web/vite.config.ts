import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const SERVER_PORT = Number(process.env.SERVER_PORT ?? 4000);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Two pages: the landing page at / and the dashboard at /app/.
  build: {
    rollupOptions: {
      input: { landing: resolve(__dirname, 'index.html'), app: resolve(__dirname, 'app/index.html') },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
      '/health': `http://localhost:${SERVER_PORT}`,
      '/api': `http://localhost:${SERVER_PORT}`,
    },
  },
});
