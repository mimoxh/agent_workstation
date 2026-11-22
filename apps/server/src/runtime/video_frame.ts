import fs from 'node:fs';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { BROWSER_MISSING } from './design_render.js';

export { BROWSER_MISSING };

export function chromiumAvailable() {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

// 镜头画面是模型写的代码：与设计稿渲染同一套隔离（新进程、新上下文、路由层断网、兜底强杀），
// 时间不走真实时钟，每一帧都先调文档里的 __awSeek(t) 再截图，所以同一时刻的帧逐字节一致
const LOAD_TIMEOUT_MS = 15_000;
const SEEK_TIMEOUT_MS = 10_000;
const HARD_TIMEOUT_MS = 30_000;

export interface ShotRenderOpts {
  width: number;
  height: number;
  // 设备像素比：看关键帧时用 0.5 省 token，成片用 1
  scale?: number | undefined;
  hardTimeoutMs?: number | undefined;
  // 成片渲染共用一个浏览器，每个镜头一个独立上下文；不给时自己起一个浏览器
  browser?: Browser | undefined;
  // 素材镜头的叠加层：截成透明底的 PNG，再叠到原生图片 / 视频上
  alpha?: boolean | undefined;
}

export interface ShotSession {
  readonly width: number;
  readonly height: number;
  seek(t: number): Promise<void>;
  frame(t: number): Promise<Buffer>;
  // 成片逐帧：同步推进时钟（__awFrame）+ CDP 直接截 JPEG，省掉两次 rAF 等待和 PNG 编码
  fastFrame(t: number): Promise<Buffer>;
  // 叠加层：透明底 PNG（素材镜头用，叠到原生媒体上）
  alphaFrame(t: number): Promise<Buffer>;
  // 成片烧字幕：平台自己挂在 <html> 下的 shadow root 里，镜头样式碰不到；空串隐藏
  subtitle(text: string, css: string): Promise<void>;
  issues(): Promise<string[]>;
  close(): Promise<void>;
}

type ClockWindow = { __awSeek?: (t: number) => Promise<number>; __awFrame?: (t: number) => number; __awCheck?: () => string[]; __awIssues?: string[] };

export const launchShotBrowser = () => chromium.launch();

export const FAST_FRAME_QUALITY = 90;

const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}超时`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); });
  });

// 一次浏览器会话渲染一个镜头的多帧；成片渲染按帧率逐帧调 frame(t) 即可
export async function openShotSession(doc: string, opts: ShotRenderOpts): Promise<ShotSession> {
  const shared = opts.browser;
  const browser = shared ?? (await chromium.launch());
  let context: BrowserContext | null = null;
  const shutdown = () => (shared ? context?.close() : browser.close())?.catch(() => {});
  const killer = setTimeout(() => void shutdown(), opts.hardTimeoutMs ?? HARD_TIMEOUT_MS);
  killer.unref?.();
  const close = async () => {
    clearTimeout(killer);
    await shutdown();
  };
  let page: Page;
  let cdp: CDPSession | null = null;
  let cdp2: CDPSession | null = null;
  try {
    context = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: opts.scale ?? 1, acceptDownloads: false });
    await context.route('**/*', (route) => (/^(?:data|blob|about):/i.test(route.request().url()) ? route.continue() : route.abort()));
    page = await context.newPage();
    await page.setContent(doc, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
    if (opts.alpha) {
      // 页面默认背景是白的：让合成器用透明底，CDP 截出来的 PNG 才带 alpha
      const set = await page.context().newCDPSession(page);
      await set.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    }
    const ok = await page.evaluate(() => typeof (window as unknown as ClockWindow).__awSeek === 'function' && typeof (window as unknown as ClockWindow).__awFrame === 'function');
    if (!ok) throw new Error('镜头文档缺少虚拟时钟（要用 composeShotDoc 合成）');
  } catch (e) {
    await close();
    throw e;
  }
  const seek = async (t: number) => {
    await withTimeout(page.evaluate((s) => (window as unknown as ClockWindow).__awSeek!(s), Math.max(0, t)), SEEK_TIMEOUT_MS, `跳到 ${t}s `);
  };
  return {
    width: opts.width,
    height: opts.height,
    seek,
    frame: async (t) => {
      await seek(t);
      // animations 必须保持 allow：disabled 会把有限动画直接快进到终点
      return page.screenshot({ type: 'png', animations: 'allow', caret: 'hide' });
    },
    fastFrame: async (t) => {
      const capture = async (s: number) => {
        await withTimeout(page.evaluate((v) => (window as unknown as ClockWindow).__awFrame!(v), Math.max(0, s)), SEEK_TIMEOUT_MS, `跳到 ${s}s `);
        const shot = await withTimeout(cdp!.send('Page.captureScreenshot', { format: 'jpeg', quality: FAST_FRAME_QUALITY, optimizeForSpeed: true, captureBeyondViewport: false }), SEEK_TIMEOUT_MS, `截取 ${s}s `);
        return Buffer.from(shot.data, 'base64');
      };
      if (!cdp) {
        cdp = await page.context().newCDPSession(page);
        // 时钟没变时截图拿到的是合成器上一帧的不定状态；先推到别的时刻截一张丢掉，让首帧和后续帧一样是「刚推进过」的画面
        await seek(t);
        await capture(t + 0.01);
      }
      return capture(t);
    },
    alphaFrame: async (t) => {
      const capture = async (s: number) => {
        await withTimeout(page.evaluate((v) => (window as unknown as ClockWindow).__awFrame!(v), Math.max(0, s)), SEEK_TIMEOUT_MS, `跳到 ${s}s `);
        const shot = await withTimeout(cdp2!.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, optimizeForSpeed: true }), SEEK_TIMEOUT_MS, `截取 ${s}s `);
        return Buffer.from(shot.data, 'base64');
      };
      if (!cdp2) {
        cdp2 = await page.context().newCDPSession(page);
        await seek(t);
        await capture(t + 0.01);
      }
      return capture(t);
    },
    subtitle: async (text, css) => {
      await page.evaluate(([t, c]) => {
        let host = document.getElementById('__aw_subtitle');
        if (!host) {
          host = document.createElement('div');
          host.id = '__aw_subtitle';
          host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;display:block!important';
          const root = host.attachShadow({ mode: 'open' });
          const style = document.createElement('style');
          style.textContent = c;
          const p = document.createElement('p');
          p.appendChild(document.createElement('span'));
          root.append(style, p);
          document.documentElement.appendChild(host);
        }
        const p = host.shadowRoot!.querySelector('p')!;
        p.firstElementChild!.textContent = t;
        p.style.display = t ? 'block' : 'none';
      }, [text, css] as const);
    },
    issues: async () => page.evaluate(() => {
      const w = window as unknown as ClockWindow;
      return w.__awCheck ? w.__awCheck() : (w.__awIssues ?? []).slice();
    }),
    close,
  };
}

export async function renderShotFrames(doc: string, opts: ShotRenderOpts & { times: number[] }): Promise<{ frames: { t: number; png: Buffer }[]; issues: string[] }> {
  const session = await openShotSession(doc, opts);
  try {
    const frames: { t: number; png: Buffer }[] = [];
    const issues = new Set<string>();
    for (const t of opts.times) {
      frames.push({ t, png: await session.frame(t) });
      for (const i of await session.issues()) issues.add(i);
    }
    return { frames, issues: [...issues] };
  } finally {
    await session.close();
  }
}

// 镜头内第 i 帧的时间点：[0, duration) 按帧率等分
export function frameTimes(duration: number, fps: number): number[] {
  const n = Math.max(1, Math.round(duration * fps));
  return Array.from({ length: n }, (_, i) => i / fps);
}

// 逐帧产出 PNG，给成片编码器（ffmpeg stdin）边渲染边消费
export async function* streamShotFrames(doc: string, opts: ShotRenderOpts & { duration: number; fps: number }): AsyncGenerator<{ index: number; t: number; png: Buffer }> {
  const session = await openShotSession(doc, opts);
  try {
    const times = frameTimes(opts.duration, opts.fps);
    for (const [index, t] of times.entries()) yield { index, t, png: await session.frame(t) };
  } finally {
    await session.close();
  }
}
