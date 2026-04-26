import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  server: {
    proxy: {
      '/api': 'http://localhost:4080',
    },
  },
  build: {
    outDir: 'dist',
  },
});
