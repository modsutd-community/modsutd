import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Separate config so the flow test can never be swept up by `npm test`: it
// writes to /data and restores with git, which must be a deliberate act.
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'node',
    include: ['flow/**/*.test.ts'],
    globals: true,
    // fold_slots.py is a subprocess, and the git restore has to finish.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
