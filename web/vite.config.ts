import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = `http://127.0.0.1:${process.env.PORT ?? 47800}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': target, '/ws': { target, ws: true } },
  },
});
