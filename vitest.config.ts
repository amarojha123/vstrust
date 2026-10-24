import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/tests/**/*.test.ts'],
    setupFiles: ['src/tests/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    isolate: false,
    maxWorkers: 1,
    fileParallelism: false,
    hookTimeout: 180000,
    testTimeout: 30000,
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/tests/**'] },
  },
});
