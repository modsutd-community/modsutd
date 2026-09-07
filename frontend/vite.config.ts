/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { devApi } from './vite-dev-api';

export default defineConfig({
  plugins: [react(), devApi()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@use "@/styles/variables.scss" as *;`,
        api: 'modern-compiler',
      },
    },
  },
  server: {
    port: 3000,
    open: true,
    fs: {
      // The Discuss panel imports the two issue templates from
      // .github/ISSUE_TEMPLATE with ?raw, so the dev server has to be allowed
      // to read above frontend/. Build does not need this - rollup resolves
      // the import - but `npm run dev` refuses to serve outside the root.
      allow: ['..'],
    },
  },
  // e2e runs against `vite preview`, on its OWN port so it can never collide
  // with a dev server on 3000 - and strict, because a silent port bump would
  // send Playwright at whatever else is listening.
  preview: {
    port: 3100,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', '../api/**/*.test.js'],
    globals: true,
  },
});
