import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// e2e 用独立临时数据库与独立端口（server 8877 / web 5273），
// 与本地 dev（8787 / 5173）互不干扰
const e2eDbPath = path.join(os.tmpdir(), `aw-e2e-${process.pid}.db`);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5273',
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @aw/server exec tsx src/index.ts',
      cwd: '../..',
      url: 'http://127.0.0.1:8877/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        AW_PORT: '8877',
        AW_DB_PATH: e2eDbPath,
      },
    },
    {
      command: 'pnpm --filter @aw/web exec vite --port 5273 --strictPort',
      cwd: '../..',
      url: 'http://localhost:5273',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        AW_API_PORT: '8877',
      },
    },
  ],
});
