import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const VIEWPORT = { width: 1280, height: 800 };
const SETTLE_MS = 300;

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

export interface VisualResult { status: 'passed' | 'failed' | 'error'; ratio: number | null; output: string; shot: string | null }

export async function runVisualCheck(worktree: string, check: { url: string; baseline: string; maxDiff: number }): Promise<VisualResult> {
  const baseline = path.resolve(worktree, check.baseline);
  if (path.relative(worktree, baseline).startsWith('..')) return { status: 'error', ratio: null, output: 'baseline 越出仓库', shot: null };
  if (!fs.existsSync(baseline)) return { status: 'error', ratio: null, output: `baseline 不存在：${check.baseline}`, shot: null };
  const shot = `${baseline}.actual.png`;
  try {
    await captureScreenshot(check.url, shot);
    const ratio = diffRatio(fs.readFileSync(baseline), fs.readFileSync(shot));
    return { status: ratio <= check.maxDiff ? 'passed' : 'failed', ratio, output: `差异 ${(ratio * 100).toFixed(2)}%，上限 ${(check.maxDiff * 100).toFixed(2)}%`, shot };
  } catch (e) {
    return { status: 'error', ratio: null, output: e instanceof Error ? e.message : String(e), shot: null };
  }
}
