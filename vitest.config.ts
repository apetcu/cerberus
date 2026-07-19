import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx'],
    environmentMatchGlobs: [['packages/dashboard/test/**', 'jsdom']],
  },
});
