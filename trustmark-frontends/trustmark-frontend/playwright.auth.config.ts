import { defineConfig } from '@playwright/test'

// Form regressions use intercepted API responses and need no database fixtures.
export default defineConfig({
  testDir: './e2e',
  testMatch: ['auth-forms.spec.ts', 'email-verification.spec.ts'],
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
