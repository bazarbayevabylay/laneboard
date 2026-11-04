// End-to-end tests of the web board (ADR-0001 §31): a real `laneboard board` from the sources on temp boards in a temp HOME,
// driven in Chromium. Needs the built UI (npm run build). LB_E2E_CHANNEL=chrome uses the installed Chrome instead of
// Playwright's cached Chromium; LB_SCREENSHOT_DIR also copies the light and dark screenshots there.
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/board/e2e',
  // Results outside the repository (nothing to ignore in git).
  outputDir: path.join(os.tmpdir(), 'laneboard-e2e-results'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    channel: process.env.LB_E2E_CHANNEL || undefined,
    viewport: { width: 1440, height: 900 },
    trace: 'off',
  },
});
