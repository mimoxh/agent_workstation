import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// e2e 用独立临时数据库与独立端口（server 8877 / web 5273），
// 与本地 dev（8787 / 5173）互不干扰
const e2eDbPath = path.join(os.tmpdir(), `aw-e2e-${process.pid}.db`);

// e2e 专属 fixture 仓库（绝不用本仓库）+ 独立 worktree 根
const e2eDir = path.join(os.tmpdir(), `aw-e2e-repo-${process.pid}`);
const e2eRepo = path.join(e2eDir, 'repo');
{
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  mkdirSync(path.join(e2eRepo, 'src', 'board'), { recursive: true });
  writeFileSync(path.join(e2eRepo, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { build: 'node check.js' } }));
  writeFileSync(path.join(e2eRepo, 'check.js'), 'process.exit(0);\n');
  writeFileSync(path.join(e2eRepo, 'src', 'board', 'index.txt'), 'board\n');
  writeFileSync(path.join(e2eRepo, 'qa-run.js'), `require('fs').writeFileSync('junit.xml', '<testsuites><testsuite name="login"><testcase classname="login" name="accepts valid password" time="0.1"/><testcase classname="login" name="rejects empty password" time="0.2"><failure message="expected 200 to be 400">at login.test.js:12</failure></testcase></testsuite></testsuites>'); process.exit(1);\n`);
  writeFileSync(path.join(e2eRepo, '.gitignore'), 'data/\n');
  const g = (args: string[]) => execFileSync('git', args, { cwd: e2eRepo, stdio: 'pipe' });
  g(['init', '-b', 'main']);
  g(['add', '-A']);
  g(['-c', 'user.name=f', '-c', 'user.email=f@f.local', 'commit', '-m', 'init']);
}

export default defineConfig({
  testDir: './e2e',
  timeout: 300_000,
  expect: { timeout: 10_000 },
  use: {
    actionTimeout: 15_000,
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
        AW_ENABLE_MOCK: '1', AW_DEFAULT_MODEL: 'mock:scripted', AW_PORT: '8877',
        AW_DB_PATH: e2eDbPath,
        AW_SEED_REPO_PATH: e2eRepo,
        AW_WORKTREE_ROOT: path.join(e2eDir, 'worktrees'),
      },
    },
    {
      command: 'pnpm --filter @aw/web exec vite --port 5273 --strictPort',
      cwd: '../..',
      url: 'http://localhost:5273',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        AW_API_PORT: process.env.AW_E2E_API_PORT ?? '8877',
      },
    },
  ],
});
