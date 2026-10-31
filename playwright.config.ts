import { defineConfig } from '@playwright/test';
import { e2ePort } from './tests/e2e/harness-url';

// E2E_PORT (default 3999) sets the port this checkout is served on, so parallel checkouts can run
// the suite side by side. A server already listening there fails the run unless E2E_REUSE=1, which
// CI ignores. globalSetup then checks the served harness and dist build are this checkout's; that
// also catches `serve` moving to a random port when the requested one is taken as it starts.
const port = e2ePort();

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/browser',
  globalSetup: './tests/e2e/global-setup.ts',
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test-results/browser-report', open: 'never' }],
  ],
  use: {
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx serve . --listen tcp://127.0.0.1:${port} --no-clipboard`,
    port,
    reuseExistingServer: !process.env.CI && process.env.E2E_REUSE === '1',
  },
});
