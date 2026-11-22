import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { videoSize, type VideoAspect, type VideoResolution } from '@aw/domain';
import { readModelConfig, type MediaProtocol, type MediaProviderConfig } from '../config.js';
import { isRetryable, registerSecret, sanitizeError } from '../models.js';
import { runFfmpeg } from './ffmpeg.js';

// 视频生成适配层：submit 提交一次生成拿 jobId，poll 查进度，fetchResult 把成片取回本地。
// 平台自己只认这套接口，具体厂商怎么调是每个 adapter 的事；现在只有 mock（本机 ffmpeg 合成），
// 接真实厂商的写法见 docs/PLUGINS/VIDEO.md
export type VideoJobState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface VideoGenRequest {
  prompt: string;
  negativePrompt?: string | undefined;
  duration: number;
  aspect: VideoAspect;
  resolution: VideoResolution;
  // 图生视频的首帧
  image?: { path: string } | undefined;
  seed?: number | undefined;
}

export interface GenCtx {
  provider: MediaProviderConfig;
  workstationId: string;
  signal?: AbortSignal | undefined;
}

export interface VideoJobStatus {
  state: VideoJobState;
  progress?: number | undefined;
  // adapter 自己的结果引用（mock 是本地文件，厂商是下载地址）
  result?: VideoResult | undefined;
  error?: string | undefined;
}

export interface VideoResult { url?: string | undefined; file?: string | undefined }

export interface VideoGenAdapter {
  protocol: MediaProtocol;
  submit(req: VideoGenRequest, ctx: GenCtx): Promise<{ jobId: string }>;
  poll(jobId: string, ctx: GenCtx): Promise<VideoJobStatus>;
  fetchResult(result: VideoResult, destPath: string, ctx: GenCtx): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 120_000;
const RETRIES = 2;

class GenError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

// 每次请求都带超时，中止信号一路透传；网络抖动 / 5xx 重试两次，其余直接失败
async function attempt<T>(run: (signal: AbortSignal) => Promise<T>, outer: AbortSignal | undefined, ms: number, what: string): Promise<T> {
  for (let i = 0; ; i++) {
    const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
    try {
      return await run(signal);
    } catch (e) {
      if (outer?.aborted) throw new GenError('已取消');
      const timeout = e instanceof Error && e.name === 'TimeoutError';
      if (i >= RETRIES || !(timeout || (e instanceof GenError && e.retryable) || isRetryable(e))) {
        throw new GenError(timeout ? `${what}超时（${Math.round(ms / 1000)} 秒）` : sanitizeError(e instanceof Error ? e.message : String(e)).slice(0, 400));
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

const mockMs = () => {
  const env = Number(process.env.AW_MOCK_CLIP_MS);
  return Number.isFinite(env) && env >= 0 ? { queue: 0, run: env } : { queue: 250, run: 1500 };
};

const genDir = () => {
  const dir = path.join(os.tmpdir(), 'aw-video-gen');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  '/System/Library/Fonts/PingFang.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
];

let fontCache: string | null | undefined;
function cjkFont(): string | null {
  if (fontCache === undefined) fontCache = FONT_CANDIDATES.find((f) => fs.existsSync(f)) ?? null;
  return fontCache;
}

// 滤镜参数里的路径：反斜杠换成正斜杠，盘符的冒号要转义（C\:/...），不然 drawtext 解析不了
const filterPath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:');

const filters = (s: string) => s.replace(/[\\'"%:,;\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

export interface MockJob { file: string; createdAt: number; request: VideoGenRequest; error?: string | undefined }

const mockJobs = new Map<string, MockJob>();

// mock 适配器：用 ffmpeg 的 testsrc2 合成一段确定性的片子（渐变底 + 移动方块 + 提示词摘要），
// 尺寸和时长与请求完全一致，所以成片链路、时长对齐和缓存都能按真实厂商的方式验证
export const mockAdapter: VideoGenAdapter = {
  protocol: 'mock',
  async submit(req, ctx) {
    const jobId = crypto.randomUUID();
    const { width, height } = videoSize(req.aspect, req.resolution);
    const fps = 30;
    const frames = Math.max(1, Math.round(req.duration * fps));
    const file = path.join(genDir(), `${jobId}.mp4`);
    const excerpt = filters(req.prompt);
    const font = cjkFont();
    const box = 160;
    const chain = [
      `drawbox=x='mod(t*${Math.round(width / 6)},iw-${box})':y='${Math.round(height / 2 - box / 2)}':w=${box}:h=${box}:color=0xf2a541@0.85:t=fill`,
      ...(font && excerpt ? [`drawtext=fontfile='${filterPath(font)}':text='${excerpt}':fontcolor=white:fontsize=${Math.round(height * 0.045)}:x=(w-tw)/2:y=h*0.82`] : []),
    ];
    const args = ['-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`, '-frames:v', String(frames), '-vf', chain.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-r', String(fps), '-an', file];
    await attempt((signal) => runFfmpeg(args, { signal }), ctx.signal, REQUEST_TIMEOUT_MS, '合成 mock 片段');
    if (!fs.existsSync(file)) throw new GenError('mock 片段没有产出');
    mockJobs.set(jobId, { file, createdAt: Date.now(), request: req });
    return { jobId };
  },
  async poll(jobId, ctx) {
    const job = mockJobs.get(jobId);
    if (!job) return { state: 'failed', error: '生成任务不存在（服务重启后的 mock 任务会丢，需要重新提交）' };
    if (ctx.signal?.aborted) return { state: 'failed', error: '已取消' };
    const { queue, run } = mockMs();
    const elapsed = Date.now() - job.createdAt;
    if (elapsed < queue) return { state: 'queued', progress: 0.02 };
    if (elapsed < queue + run) return { state: 'running', progress: Math.min(0.95, 0.1 + 0.85 * ((elapsed - queue) / Math.max(1, run))) };
    return { state: 'succeeded', progress: 1, result: { file: job.file, url: `file://${job.file}` } };
  },
  async fetchResult(result, destPath) {
    if (!result.file || !fs.existsSync(result.file)) throw new GenError('生成的片段文件不见了');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(result.file, destPath);
  },
};

export const VIDEO_ADAPTERS: VideoGenAdapter[] = [mockAdapter];

export const adapterFor = (protocol: MediaProtocol): VideoGenAdapter | undefined => VIDEO_ADAPTERS.find((a) => a.protocol === protocol);

// mock 只在测试 / AW_ENABLE_MOCK=1 时补上，和配音一个约定
const mockEnabled = () => process.env.NODE_ENV === 'test' || process.env.AW_ENABLE_MOCK === '1';

export const MOCK_VIDEO: MediaProviderConfig = { name: 'mock', kind: 'video', protocol: 'mock', model: 'mock', price: { perSecond: 0 } };

export function videoProviders(): MediaProviderConfig[] {
  const list = readModelConfig().media.filter((p) => p.kind === 'video');
  for (const p of list) registerSecret(p.apiKey);
  if (mockEnabled() && !list.some((p) => p.name === MOCK_VIDEO.name)) list.push(MOCK_VIDEO);
  return list;
}

export interface ResolvedVideo { provider: MediaProviderConfig; adapter: VideoGenAdapter }

// 选 provider：申请里指定的 → 设置里的默认 → 第一个有 adapter 的
export function resolveVideoProvider(pref?: { provider?: string | undefined } | null): ResolvedVideo | { error: string } {
  const list = videoProviders();
  let provider: MediaProviderConfig | undefined;
  if (pref?.provider) {
    provider = list.find((p) => p.name === pref.provider);
    if (!provider) return { error: `视频生成服务 ${pref.provider} 不存在或没配置` };
  }
  const def = readModelConfig().defaultVideo;
  provider ??= (def ? list.find((p) => p.name === def) : undefined) ?? list.find((p) => adapterFor(p.protocol)) ?? list[0];
  if (!provider) return { error: '还没有视频生成服务：先在「模型与设置 → 媒体」里加一个视频 provider' };
  const adapter = adapterFor(provider.protocol);
  if (!adapter) return { error: `视频生成协议 ${provider.protocol} 还没有实现` };
  return { provider, adapter };
}

// 按秒计价（美元 / 秒 → 微美元）
export const clipCostMicros = (p: MediaProviderConfig, seconds: number) => Math.round(Math.max(0, seconds) * (p.price?.perSecond ?? 0) * 1e6);

export const genErrorText = (e: unknown) => sanitizeError(e instanceof Error ? e.message : String(e)).slice(0, 400);
