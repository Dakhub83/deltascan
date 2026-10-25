import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const SERVER_PORT = Number(process.env.SERVER_PORT ?? 4000);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
      '/health': `http://localhost:${SERVER_PORT}`,
      '/api': `http://localhost:${SERVER_PORT}`,
    },
  },
});
