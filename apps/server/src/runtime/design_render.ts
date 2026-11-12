import { chromium } from 'playwright-core';

// 设计稿是模型写的代码：新进程、新上下文，路由层掐掉一切非 data/blob/about 的请求
export const VIEWPORTS = { desktop: 1440, tablet: 834, mobile: 390 } as const;
export type ViewportName = keyof typeof VIEWPORTS;

const SETTLE_MS = 300;
const LOAD_TIMEOUT_MS = 15_000;
const HARD_TIMEOUT_MS = 30_000;
const MAX_SHOT_HEIGHT = 6000;

// 浏览器没装时的报错特征，和 visual.ts 的视觉验收用同一类判断
export const BROWSER_MISSING = /Executable doesn't exist|browserType\.launch|Please run.*playwright install/i;

export interface RenderOpts { width: number; height?: number; fullPage?: boolean; format: 'png' | 'pdf' }

export async function renderDesign(html: string, opts: RenderOpts): Promise<Buffer> {
  const browser = await chromium.launch();
  // 兜底超时：页面里的脚本死循环也能收掉浏览器
  const killer = setTimeout(() => void browser.close().catch(() => {}), HARD_TIMEOUT_MS);
  killer.unref?.();
  try {
    const context = await browser.newContext({ viewport: { width: opts.width, height: opts.height ?? 900 }, acceptDownloads: false });
    await context.route('**/*', (route) => (/^(?:data|blob|about):/i.test(route.request().url()) ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    if (opts.format === 'pdf') return await page.pdf({ width: `${opts.width}px`, printBackground: true });
    const fullPage = opts.fullPage ?? true;
    if (fullPage) {
      // 超长页面先封顶再整页截图（clip 和 fullPage 不能同用）
      const height = await page.evaluate(() => Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0));
      if (height > MAX_SHOT_HEIGHT) await page.addStyleTag({ content: `html, body { max-height: ${MAX_SHOT_HEIGHT}px !important; overflow: hidden !important; }` });
    }
    return await page.screenshot({ fullPage });
  } finally {
    clearTimeout(killer);
    await browser.close().catch(() => {});
  }
}
