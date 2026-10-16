import { defineConfig, devices } from '@playwright/test';
export default defineConfig({ testDir: './e2e', testMatch: 'google-calendar.spec.ts', timeout: 60_000, expect: { timeout: 10_000 }, workers: 1,
  use: { ...devices['Pixel 7'], viewport: { width: 360, height: 780 }, baseURL: 'http://127.0.0.1:4028', trace: 'retain-on-failure' }, reporter: 'list' });
