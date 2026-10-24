import { defineConfig } from '@playwright/test'

// Dashboard regressions intercept API responses and need no database fixtures.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'dashboard-live.spec.ts',
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
  },
})
