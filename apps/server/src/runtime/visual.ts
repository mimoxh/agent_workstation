import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { startBackground } from './exec.js';
import type { SandboxConfig } from './sandbox.js';

const VIEWPORT = { width: 1280, height: 800 };
const SETTLE_MS = 300;
const SERVE_WAIT_MS = Number(process.env.AW_SERVE_WAIT_MS ?? 90_000);

export async function captureScreenshot(url: string, target: string) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(SETTLE_MS);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await page.screenshot({ path: target });
  } finally {
    await browser.close();
  }
}

// 尺寸不同视为完全不同；返回差异像素占比
export function diffRatio(a: Buffer, b: Buffer): number {
  const x = PNG.sync.read(a);
  const y = PNG.sync.read(b);
  if (x.width !== y.width || x.height !== y.height) return 1;
  return pixelmatch(x.data, y.data, undefined, x.width, x.height, { threshold: 0.1 }) / (x.width * x.height);
}

// env：页面打不开 / 浏览器没装，是环境问题不是改动的问题
export interface VisualResult { status: 'passed' | 'failed' | 'error'; ratio: number | null; output: string; shot: string | null; env?: boolean }

const ENV_PATTERN = /ERR_CONNECTION_REFUSED|ECONNREFUSED|Executable doesn't exist|browserType\.launch|ERR_NAME_NOT_RESOLVED/;

export async function runVisualCheck(worktree: string, check: { url: string; baseline: string; maxDiff: number }): Promise<VisualResult> {
  const baseline = path.resolve(worktree, check.baseline);
  if (path.relative(worktree, baseline).startsWith('..')) return { status: 'error', ratio: null, output: 'baseline 越出仓库', shot: null };
  if (!fs.existsSync(baseline)) return { status: 'error', ratio: null, output: `baseline 不存在：${check.baseline}`, shot: null };
  // 实际截图不能落在 worktree 里：integration 变脏后下一次合并会被中止，任务 worktree 变脏则提交不了
  const shot = path.join(os.tmpdir(), 'aw-visual', `${crypto.randomUUID()}.png`);
  try {
    await captureScreenshot(check.url, shot);
    const ratio = diffRatio(fs.readFileSync(baseline), fs.readFileSync(shot));
    return { status: ratio <= check.maxDiff ? 'passed' : 'failed', ratio, output: `差异 ${(ratio * 100).toFixed(2)}%，上限 ${(check.maxDiff * 100).toFixed(2)}%`, shot };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 'error', ratio: null, output: msg, shot: null, env: ENV_PATTERN.test(msg) };
  }
}

// visual 验收的 url 可写 {port}：换成这个 worktree 分到的 web 端口
export const resolveUrl = (url: string, env: Record<string, string>) => url.replace(/\{port\}/g, env.AW_E2E_WEB_PORT ?? '').replace(/\{apiPort\}/g, env.AW_E2E_API_PORT ?? '');

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

// 平台在 worktree 里起 serve 命令，等页面能访问后再截图；没配 serve 就假设页面已经在跑
export async function withServer<T>(opts: { cwd: string; command?: string | undefined; env: Record<string, string>; probeUrl: string; sandbox?: SandboxConfig | undefined }, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  if (!opts.command) return { ok: true, value: await fn() };
  const proc = startBackground({ cwd: opts.cwd, command: opts.command, env: { ...opts.env, PORT: opts.env.AW_E2E_WEB_PORT ?? '' }, sandbox: opts.sandbox, publish: opts.env.AW_E2E_WEB_PORT ? [opts.env.AW_E2E_WEB_PORT] : [] });
  if (!proc.ok) return { ok: false, error: `serve 命令无法启动：${proc.error}` };
  try {
    const deadline = Date.now() + SERVE_WAIT_MS;
    while (!(await reachable(opts.probeUrl))) {
      if (proc.exited() !== null) return { ok: false, error: `serve 进程提前退出（${proc.exited()}）：\n${proc.tail().slice(-1000)}` };
      if (Date.now() > deadline) return { ok: false, error: `等待 ${opts.probeUrl} 超时（${SERVE_WAIT_MS / 1000}s）：\n${proc.tail().slice(-1000)}` };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: true, value: await fn() };
  } finally {
    proc.stop();
  }
}
