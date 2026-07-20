import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const apiTarget = process.env.SIDEQUEST_API_URL ?? 'http://127.0.0.1:3210';

export default defineConfig({
  root: 'app',
  base: '/',
  plugins: [svelte()],
  build: {
    outDir: '../dist',
    emptyOutDir: true
  },
  server: {
    proxy: {
      '/api': apiTarget
    }
  },
  test: {
    environment: 'node',
    include: ['../test/**/*.test.ts']
  }
});
