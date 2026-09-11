import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: {
      '/nbk-rates': {
        target: 'https://nationalbank.kz',
        changeOrigin: true,
        rewrite: () => '/rss/rates_all.xml'
      }
    }
  }
});