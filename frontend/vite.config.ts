/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { devApi } from './vite-dev-api';

/**
 * What vercel.json's first two rewrites do, for `vite preview`.
 *
 * A prerendered page lives at `dist/mods/50.040/index.html` and its canonical
 * url is `/mods/50.040` with no trailing slash. No static server resolves that
 * on its own: the last segment has a dot in it, so it is read as a filename
 * with an extension rather than a directory, and the request falls through to
 * the SPA - which is the exact bug this whole thing exists to fix, and it would
 * have passed every test written against a preview server that did not do this.
 *
 * Preview only. The dev server has no prerendered files to serve.
 */
function prerenderedPaths() {
  return {
    name: 'prerendered-paths',
    configurePreviewServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => void } }) {
      server.middlewares.use((req, _res, next) => {
        const m = /^\/(mods|venues)\/([^/?#]+)$/.exec(req.url ?? '');
        if (m) req.url = `/${m[1]}/${m[2]}/index.html`;
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devApi(), prerenderedPaths()],
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
