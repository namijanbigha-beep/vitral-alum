import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_BASE=/app/ builds for a sub-folder (shared hosting: public_html/app/); default serves from the site root.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } } },
  build: { outDir: 'dist', sourcemap: false, target: 'es2020' },
});
