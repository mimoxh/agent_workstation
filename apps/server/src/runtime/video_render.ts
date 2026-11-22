import { buildSrt, cueAt, mediaFilter, subtitleOverlayCss, videoCues, type GateCheck, type ShotMotionKind, type SubtitleCue, type SubtitleLook, type VideoLook } from '@aw/domain';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright-core';
import { eq, inArray } from 'drizzle-orm';
import PQueue from 'p-queue';
import type { DB } from '../db/client.js';
import { artifact, videoRender } from '../db/schema.js';
import { events } from '../events.js';
import { logEvent } from '../usecases/core.js';
import { refreshVideoStatus, saveShotIssues, shotDocAt, videoRow, type VideoData } from '../usecases/videos.js';
import { bgmFileOf } from '../usecases/video_style.js';
import { startLive } from './live_output.js';
import { ffprobe, MediaEnvError, runFfmpeg, startFfmpeg } from './media/ffmpeg.js';
import { mediaDir, saveMediaArtifact } from './media/storage.js';
import { sanitizeError } from './models.js';
import { BROWSER_MISSING, launchShotBrowser, openShotSession } from './video_frame.js';

export type SubtitleMode = 'burn' | 'srt' | 'off';

export interface RenderShotSpec {
  id: string;
  version: number;
  order: number;
  title: string;
  narration: string;
  // 帧对齐后的时长与帧数；renderStart 是成片里的起点（已扣掉转场重叠）
  duration: number;
  frames: number;
  transition: string;
  overlap: number;
  renderStart: number;
  placeholder: boolean;
  audio: { artifactId: string; duration: number } | null;
  cues: SubtitleCue[];
  // 素材镜头：底图 / 片段的文件与规格（html 镜头为 null）
  media: { assetId: string; artifactId: string; file: string; kind: 'image' | 'video'; width: number; height: number; motion: ShotMotionKind; keepAudio: boolean } | null;
  // 素材镜头的叠加层原文（shot.html）
  overlay: string;
  // 逐镜头内容哈希
  hash: string;
}

export interface RenderSettings {
  width: number;
  height: number;
  fps: number;
  subtitles: SubtitleMode;
  font: string | null;
  total: number;
  allowPlaceholders: boolean;
  warnings: string[];
  shots: RenderShotSpec[];
  // 出片时的内容哈希：审片通过的哈希和它对得上，出片成功后视频才算 rendered
  contentHash?: string | undefined;
  // 风格快照：镜头 CSS 变量、字幕版式、背景音乐（出片中途改风格不影响这次）
  look?: VideoLook | null | undefined;
  subtitleLook?: SubtitleLook | null | undefined;
  bgm?: { artifactId: string; volume: number; ducking: boolean; duration: number } | null | undefined;
  gate?: { ok: boolean; checks: GateCheck[] } | undefined;
  override?: { reason: string; by: { type: string; id: string }; failed: string[]; at: string } | null | undefined;
  // 渲染时在画面里抽查到的问题（溢出 / 脚本报错 / 外部资源被拦）
  shotIssues?: { shotId: string; version: number; items: string[] }[] | undefined;
}

export type RenderStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

const now = () => new Date().toISOString();

// 编码参数进缓存键：改了参数（含截图格式），旧片段自然失效
const SEGMENT_FORMAT = 'h264-veryfast-crf20-yuv420p-jpeg90-v3';
const CRF = '20';
const PRESET = 'veryfast';

// 片段缓存键：合成后的镜头文档 + 尺寸 + 帧率 + 帧数 + 烧进去的字幕（文字、时间、版式）
// 素材镜头的缓存键还要带上素材产物 id 和文件大小 / 修改时间：换了素材或重新生成过，旧片段自然失效
export function segmentKey(input: { doc: string; width: number; height: number; fps: number; frames: number; subtitle: { cues: SubtitleCue[]; css: string } | null; media?: { artifactId: string; size: number; mtime: number; motion: string; keepAudio?: boolean | undefined } | null | undefined }) {
  return createHash('sha256').update(JSON.stringify([SEGMENT_FORMAT, input.width, input.height, input.fps, input.frames, input.subtitle, input.media ?? null, input.doc])).digest('hex');
}

// 测试和排查用：起了几个浏览器、渲染了几个镜头、复用了几个片段、同时在渲染的镜头数峰值
export const renderCounters = { browsers: 0, sessions: 0, reused: 0, peak: 0 };

// 一次出片内并行渲染的镜头数：默认 min(3, CPU 数 / 4)，AW_RENDER_CONCURRENCY 可改（1–8）
export function renderConcurrency() {
  const env = Number(process.env.AW_RENDER_CONCURRENCY);
  if (Number.isInteger(env) && env >= 1) return Math.min(8, env);
  return Math.max(1, Math.min(3, Math.floor(os.cpus().length / 4)));
}

const queue = new PQueue({ concurrency: 1 });
const controllers = new Map<string, AbortController>();

export const videoRenderIdle = () => queue.onIdle();

export function enqueueVideoRender(db: DB, id: string) {
  const controller = new AbortController();
  controllers.set(id, controller);
  void queue.add(async () => {
    try {
      await executeRender(db, id, controller.signal);
    } catch (e) {
      console.error('[video] 渲染异常', id, sanitizeError(String(e)));
    } finally {
      controllers.delete(id);
    }
  });
}

export function abortVideoRender(id: string) {
  const c = controllers.get(id);
  if (!c) return false;
  c.abort();
  return true;
}

class Cancelled extends Error {}

const errorText = (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof MediaEnvError) return msg;
  if (BROWSER_MISSING.test(msg)) return '本机没有可用的 Chromium，运行 pnpm exec playwright install chromium 后重试';
  return sanitizeError(msg.split('\n')[0]!).slice(0, 800);
};

async function writeFrames(stdin: NodeJS.WritableStream, img: Buffer, died: Promise<never>) {
  if (!stdin.write(img)) await Promise.race([once(stdin, 'drain'), died]);
}

// 抽查画面问题的帧：四分之一、一半和最后一帧（开头多半还在入场动画里）
export const sampleFrames = (frames: number) => [...new Set([Math.floor(frames * 0.25), Math.floor(frames * 0.5), frames - 1])].filter((i) => i >= 0);

let active = 0;

// 一个镜头 → 一个无声 H.264 片段：共用浏览器里开一个上下文，逐帧同步推进时钟 + CDP 截 JPEG，直接灌进 ffmpeg stdin；
// 抽查帧上顺带收集画面问题（只读排版，不影响画面）
async function renderSegment(browser: Browser, doc: string, spec: { width: number; height: number; fps: number; frames: number; duration: number; subtitle: { cues: SubtitleCue[]; css: string } | null }, file: string, signal: AbortSignal, onFrame: () => void) {
  renderCounters.sessions++;
  renderCounters.peak = Math.max(renderCounters.peak, ++active);
  let session: Awaited<ReturnType<typeof openShotSession>>;
  try {
    session = await openShotSession(doc, { width: spec.width, height: spec.height, scale: 1, browser, hardTimeoutMs: 60_000 + spec.frames * 2_000 });
  } catch (e) {
    active--;
    throw e;
  }
  const samples = new Set(sampleFrames(spec.frames));
  const issues = new Set<string>();
  const tmp = `${file}.${process.pid}-${crypto.randomUUID().slice(0, 8)}.tmp`;
  const enc = startFfmpeg(['-y', '-f', 'image2pipe', '-framerate', String(spec.fps), '-c:v', 'mjpeg', '-i', 'pipe:0', '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF, '-pix_fmt', 'yuv420p', '-r', String(spec.fps), '-an', '-f', 'mp4', tmp], { signal });
  const died = enc.done.then(() => { throw new Error('ffmpeg 提前退出'); });
  died.catch(() => {});
  const onAbort = () => void session.close();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    let shown: string | null = null;
    for (let i = 0; i < spec.frames; i++) {
      if (signal.aborted) throw new Cancelled('已取消');
      const t = i / spec.fps;
      if (spec.subtitle) {
        const text = cueAt(spec.subtitle.cues, t, spec.duration)?.text ?? '';
        if (text !== shown) {
          await session.subtitle(text, spec.subtitle.css);
          shown = text;
        }
      }
      await writeFrames(enc.child.stdin, await session.fastFrame(t), died);
      if (samples.has(i)) for (const x of await session.issues()) issues.add(x);
      onFrame();
    }
    enc.child.stdin.end();
    await enc.done;
    fs.renameSync(tmp, file);
    return [...issues];
  } catch (e) {
    enc.kill();
    await enc.done.catch(() => {});
    fs.rmSync(tmp, { force: true });
    throw signal.aborted ? new Cancelled('已取消') : e;
  } finally {
    active--;
    signal.removeEventListener('abort', onAbort);
    await session.close();
  }
}

// 素材镜头 → 一个无声（或保留原声）的 H.264 片段：图片用 zoompan 做 Ken Burns，视频等比留黑边并按镜头时长裁 / 冻；
// 叠加层（shot.html）和烧进去的字幕走同一个透明 Chromium 会话，逐帧 PNG 叠到底图上
export interface MediaSegmentInput {
  media: { file: string; kind: 'image' | 'video'; motion: ShotMotionKind; keepAudio: boolean };
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration: number;
  // 叠加层文档（透明底、带虚拟时钟）；不需要叠加时为 null
  overlayDoc: string | null;
  subtitle: { cues: SubtitleCue[]; css: string } | null;
  browser: Browser;
  file: string;
  signal: AbortSignal;
  onFrame: () => void;
}

// 静止的图片只有一帧：不循环的话 fps / -frames:v 拿不到后面的帧；zoompan 自己按 d 生成帧，不用循环
const stillInput = (media: { kind: 'image' | 'video'; motion: ShotMotionKind }, fps: number) => (media.kind === 'image' && media.motion === 'none' ? ['-loop', '1', '-framerate', String(fps)] : []);

export async function renderMediaSegment(input: MediaSegmentInput) {
  renderCounters.sessions++;
  renderCounters.peak = Math.max(renderCounters.peak, ++active);
  const { media, width, height, fps, frames, duration } = input;
  let session: Awaited<ReturnType<typeof openShotSession>> | null = null;
  try {
    if (input.overlayDoc) session = await openShotSession(input.overlayDoc, { width, height, scale: 1, browser: input.browser, alpha: true, hardTimeoutMs: 60_000 + frames * 2_000 });
  } catch (e) {
    active--;
    throw e;
  }
  const samples = new Set(sampleFrames(frames));
  const issues = new Set<string>();
  const tmp = `${input.file}.${process.pid}-${crypto.randomUUID().slice(0, 8)}.tmp`;
  const withAudio = media.kind === 'video' && media.keepAudio;
  const args = ['-y', ...stillInput(media, fps), '-i', media.file];
  if (session) args.push('-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', 'pipe:0');
  const base = `[0:v]${mediaFilter({ kind: media.kind, motion: media.motion, width, height, frames, fps, duration })},format=yuv420p`;
  const filters = session ? [`${base}[base]`, '[1:v]format=rgba[ov]', '[base][ov]overlay=0:0:format=auto[vout]'] : [`${base}[vout]`];
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
  if (withAudio) args.push('-map', '0:a?', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000');
  args.push('-c:v', 'libx264', '-preset', PRESET, '-crf', CRF, '-pix_fmt', 'yuv420p', '-r', String(fps), '-frames:v', String(frames), '-f', 'mp4', tmp);
  const enc = startFfmpeg(args, { signal: input.signal });
  const died = enc.done.then(() => { throw new Error('ffmpeg 提前退出'); });
  died.catch(() => {});
  const onAbort = () => void session?.close();
  input.signal.addEventListener('abort', onAbort, { once: true });
  try {
    let shown: string | null = null;
    for (let i = 0; i < frames; i++) {
      if (input.signal.aborted) throw new Cancelled('已取消');
      const t = i / fps;
      if (session) {
        if (input.subtitle) {
          const text = cueAt(input.subtitle.cues, t, duration)?.text ?? '';
          if (text !== shown) {
            await session.subtitle(text, input.subtitle.css);
            shown = text;
          }
        }
        await writeFrames(enc.child.stdin, await session.alphaFrame(t), died);
      }
      if (samples.has(i) && session) for (const x of await session.issues()) issues.add(x);
      input.onFrame();
    }
    enc.child.stdin.end();
    await enc.done;
    fs.renameSync(tmp, input.file);
    return [...issues];
  } catch (e) {
    enc.kill();
    await enc.done.catch(() => {});
    fs.rmSync(tmp, { force: true });
    throw input.signal.aborted ? new Cancelled('已取消') : e;
  } finally {
    active--;
    input.signal.removeEventListener('abort', onAbort);
    await session?.close();
  }
}

// 素材镜头的关键帧：底图 / 片段抽一帧（图片按运动推进到那一刻），有叠加层就再截一张透明 PNG 叠上去
export async function renderMediaFrames(input: {
  media: { file: string; kind: 'image' | 'video'; motion: ShotMotionKind };
  width: number; height: number; fps: number; duration: number;
  overlayDoc: string | null;
  times: number[];
  scale?: number | undefined;
}): Promise<{ frames: { t: number; png: Buffer }[]; issues: string[] }> {
  const { media, width, height, fps, duration } = input;
  const scale = input.scale ?? 1;
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const dir = path.join(os.tmpdir(), 'aw-video-media-frames');
  fs.mkdirSync(dir, { recursive: true });
  const session = input.overlayDoc ? await openShotSession(input.overlayDoc, { width, height, scale: 1, alpha: true }) : null;
  const issues = new Set<string>();
  const frames: { t: number; png: Buffer }[] = [];
  try {
    for (const t of input.times) {
      const idx = Math.min(totalFrames - 1, Math.max(0, Math.round(t * fps)));
      const id = crypto.randomUUID();
      const baseFile = path.join(dir, `${id}-base.png`);
      const chain = `${mediaFilter({ kind: media.kind, motion: media.motion, width, height, frames: totalFrames, fps, duration })},select='eq(n,${idx})'`;
      const args = ['-y', ...stillInput(media, fps), '-i', media.file];
      await runFfmpeg([...args, '-filter_complex', `[0:v]${chain}`, '-frames:v', '1', baseFile]);
      let pngFile = baseFile;
      if (session) {
        const overlayFile = path.join(dir, `${id}-overlay.png`);
        fs.writeFileSync(overlayFile, await session.alphaFrame(t));
        const out = path.join(dir, `${id}.png`);
        await runFfmpeg(['-y', '-i', baseFile, '-i', overlayFile, '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto,format=rgba', '-frames:v', '1', out]);
        pngFile = out;
        for (const x of await session.issues()) issues.add(x);
      }
      if (scale < 1) {
        const scaled = path.join(dir, `${id}-s.png`);
        await runFfmpeg(['-y', '-i', pngFile, '-vf', `scale=${Math.max(2, Math.round(width * scale))}:${Math.max(2, Math.round(height * scale))}:flags=lanczos`, '-frames:v', '1', scaled]);
        pngFile = scaled;
      }
      frames.push({ t, png: fs.readFileSync(pngFile) });
      for (const x of [baseFile, `${id}-overlay.png`, `${id}.png`, `${id}-s.png`]) fs.rmSync(path.isAbsolute(x) ? x : path.join(dir, x), { force: true });
    }
    return { frames, issues: [...issues] };
  } finally {
    await session?.close();
  }
}

// 有界并发：任一镜头失败就叫停其余的，抛出第一个错误
async function runPool<T>(items: T[], limit: number, stop: AbortController, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  let failure: { e: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try {
        await fn(items[i]!, i);
      } catch (e) {
        failure ??= { e };
        stop.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw (failure as { e: unknown }).e;
}

const f3 = (n: number) => n.toFixed(3);

export interface BgmMix { file: string; volume: number; ducking: boolean }

// 背景音乐：循环铺满全片、按音量缩放、首尾各 1 秒淡入淡出；ducking 时用旁白做侧链压缩，说话时音乐自动压低
export const DUCK_FILTER = 'sidechaincompress=threshold=0.01:ratio=10:attack=20:release=400';

// 片段按时间线拼起来：硬切用 concat，淡入 / 滑入用 xfade 交叠；配音按各镜头成片起点铺在一条静音底轨上，再和背景音乐混音
export function assembleArgs(input: { segments: string[]; shots: Pick<RenderShotSpec, 'duration' | 'overlap' | 'transition' | 'renderStart' | 'media'>[]; audio: { file: string; start: number; duration: number }[]; bgm?: BgmMix | null | undefined; fps: number; total: number; srt: string | null; out: string }) {
  const { segments, shots, fps, total } = input;
  const args = ['-y'];
  for (const s of segments) args.push('-i', s);
  for (const a of input.audio) args.push('-i', a.file);
  const silent = segments.length + input.audio.length;
  args.push('-f', 'lavfi', '-t', f3(total), '-i', 'anullsrc=r=48000:cl=stereo');
  let next = silent + 1;
  const bgmIdx = input.bgm ? next++ : -1;
  if (input.bgm) args.push('-stream_loop', '-1', '-i', input.bgm.file);
  const srtIdx = input.srt ? next : -1;
  if (input.srt) args.push('-i', input.srt);
  const filters = segments.map((_, i) => `[${i}:v]fps=${fps},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${i}]`);
  let cur = 'v0';
  let length = shots[0]?.duration ?? 0;
  for (let i = 1; i < segments.length; i++) {
    const s = shots[i]!;
    const nextV = `x${i}`;
    if (s.overlap > 0) {
      const kind = s.transition === 'slide' ? 'slideleft' : 'fade';
      filters.push(`[${cur}][v${i}]xfade=transition=${kind}:duration=${f3(s.overlap)}:offset=${f3(length - s.overlap)}[${nextV}]`);
      length += s.duration - s.overlap;
    } else {
      filters.push(`[${cur}][v${i}]concat=n=2:v=1:a=0[${nextV}]`);
      length += s.duration;
    }
    cur = nextV;
  }
  filters.push(`[${cur}]null[vout]`);
  input.audio.forEach((a, k) => {
    const ms = Math.max(0, Math.round(a.start * 1000));
    filters.push(`[${segments.length + k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${f3(a.duration)},asetpts=PTS-STARTPTS,adelay=${ms}:all=1[a${k}]`);
  });
  // 素材片段自带的声音（Shot.keepAudio）直接从那个片段输入的音轨拿，按成片起点铺开
  const clipAudio = input.shots.flatMap((s, i) => (s.media?.keepAudio ? [{ index: i, start: s.renderStart, duration: s.duration }] : []));
  for (const c of clipAudio) {
    const ms = Math.max(0, Math.round(c.start * 1000));
    filters.push(`[${c.index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${f3(c.duration)},asetpts=PTS-STARTPTS,adelay=${ms}:all=1[clip${c.index}]`);
  }
  const voices = [...input.audio.map((_, k) => `[a${k}]`), ...clipAudio.map((c) => `[clip${c.index}]`)];
  filters.push(voices.length ? `[${silent}:a]${voices.join('')}amix=inputs=${voices.length + 1}:duration=first:normalize=0[narr]` : `[${silent}:a]anull[narr]`);
  if (input.bgm) {
    const fade = Math.min(1, total / 2);
    const vol = Math.min(1, Math.max(0, input.bgm.volume));
    filters.push(`[${bgmIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${f3(total)},asetpts=PTS-STARTPTS,volume=${f3(vol)},afade=t=in:st=0:d=${f3(fade)},afade=t=out:st=${f3(Math.max(0, total - fade))}:d=${f3(fade)}[bgm]`);
    if (input.bgm.ducking && input.audio.length) filters.push('[narr]asplit=2[narr1][sc]', `[bgm][sc]${DUCK_FILTER}[bgmd]`, '[narr1][bgmd]amix=inputs=2:duration=first:normalize=0[aout]');
    else filters.push('[narr][bgm]amix=inputs=2:duration=first:normalize=0[aout]');
  } else filters.push('[narr]anull[aout]');
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]');
  if (input.srt) args.push('-map', `${srtIdx}:s`, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=chi');
  args.push('-c:v', 'libx264', '-preset', PRESET, '-crf', CRF, '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-t', f3(total), '-progress', 'pipe:1', input.out);
  return args;
}

async function finish(db: DB, id: string, status: RenderStatus, patch: Partial<typeof videoRender.$inferInsert> = {}) {
  const row = (await db.select().from(videoRender).where(eq(videoRender.id, id)))[0];
  await db.update(videoRender).set({ status, finishedAt: now(), ...patch }).where(eq(videoRender.id, id));
  await logEvent(db, { type: (row?.createdByType as 'human' | 'agent' | undefined) ?? 'human', id: row?.createdById ?? 'local' }, 'video_render_finished', 'video_render', id, { status, videoId: row?.videoId ?? null });
}

const readIssues = (file: string): string[] => {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { issues?: unknown };
    return Array.isArray(j.issues) ? j.issues.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export async function executeRender(db: DB, id: string, signal: AbortSignal) {
  const row = (await db.select().from(videoRender).where(eq(videoRender.id, id)))[0];
  if (!row || row.status !== 'queued') return;
  if (signal.aborted) return finish(db, id, 'cancelled', { error: '已取消' });
  const settings = JSON.parse(row.settingsJson) as RenderSettings;
  const actor = { type: (row.createdByType as 'human' | 'agent' | null) ?? 'human', id: row.createdById ?? 'local' };
  const video = await videoRow(db, row.videoId);
  const title = video ? (JSON.parse(video.dataJson ?? '{}') as VideoData).title : '视频';
  await db.update(videoRender).set({ status: 'running', startedAt: now(), progress: 0 }).where(eq(videoRender.id, id));
  await logEvent(db, actor, 'video_render_started', 'video_render', id, { videoId: row.videoId });
  const live = startLive(`video:${id}`, `出片《${title}》${settings.width}×${settings.height} ${settings.fps}fps`);
  const log = (line: string) => live.write(`${line}\n`);

  const totalFrames = Math.max(1, settings.shots.reduce((n, s) => n + s.frames, 0));
  let doneFrames = 0;
  let lastWrite = 0;
  let progress = 0;
  const report = async (p: number, force = false) => {
    progress = Math.min(1, Math.max(progress, p));
    if (!force && Date.now() - lastWrite < 500) return;
    lastWrite = Date.now();
    await db.update(videoRender).set({ progress: Math.round(progress * 1000) / 1000 }).where(eq(videoRender.id, id));
    events.emit('video_render_progress', { targetId: id, videoId: row.videoId, progress });
  };
  const SEGMENT_SHARE = 0.85;
  const stop = new AbortController();
  const onCancel = () => stop.abort();
  signal.addEventListener('abort', onCancel, { once: true });
  let browserP: Promise<Browser> | null = null;
  const browser = () => {
    if (!browserP) {
      renderCounters.browsers++;
      browserP = launchShotBrowser();
    }
    return browserP;
  };

  try {
    const css = subtitleOverlayCss(settings.width, settings.height, settings.font ?? undefined, settings.subtitleLook ?? undefined);
    const cache = mediaDir(db, 'cache');
    const segments: string[] = [];
    const issuesBy: string[][] = [];
    const limit = renderConcurrency();
    const started = Date.now();
    if (settings.shots.length > 1) log(`并行渲染：最多 ${limit} 个镜头同时进行`);
    try {
      await runPool(settings.shots, limit, stop, async (shot, i) => {
        if (stop.signal.aborted) throw new Cancelled('已取消');
        const label = `镜头 ${i + 1}「${shot.title || '未命名'}」`;
        const built = await shotDocAt(db, shot.id, shot.version, settings, shot.duration, settings.look ?? null);
        if (!built) throw new Error(`${label}的 v${shot.version} 已不存在（镜头被删了），请重新出片`);
        const subtitle = settings.subtitles === 'burn' && shot.cues.length ? { cues: shot.cues, css } : null;
        // 素材镜头只在真的叠东西（叠加层 / 烧字幕）时才需要 Chromium
        const layered = !!shot.overlay.trim() || !!subtitle;
        const key = segmentKey({
          doc: built.media && !layered ? '' : built.doc, width: settings.width, height: settings.height, fps: settings.fps, frames: shot.frames, subtitle,
          media: built.media ? { artifactId: built.media.artifactId, size: built.media.size, mtime: built.media.mtime, motion: built.media.motion, keepAudio: shot.media?.keepAudio === true } : null,
        });
        const file = path.join(cache, `${key}.mp4`);
        const side = path.join(cache, `${key}.json`);
        if (fs.existsSync(file)) {
          renderCounters.reused++;
          doneFrames += shot.frames;
          issuesBy[i] = readIssues(side);
          log(`${label}：画面没变，复用缓存片段`);
        } else {
          log(`${label}：渲染 ${shot.frames} 帧（${shot.duration}s）${built.placeholder ? ' · 占位画面' : ''}`);
          let n = 0;
          const onFrame = () => {
            doneFrames++;
            if (++n % Math.max(1, settings.fps * 2) === 0) log(`  ${label} ${n}/${shot.frames} 帧`);
            void report((doneFrames / totalFrames) * SEGMENT_SHARE);
          };
          if (built.media) {
            log(`  ${label} 素材：${built.media.kind === 'image' ? '图片' : '片段'}${built.media.motion === 'none' ? '' : ` · ${built.media.motion}`}${layered ? ' · 叠加层' : ''}`);
            issuesBy[i] = await renderMediaSegment({
              media: { file: built.media.file, kind: built.media.kind, motion: built.media.motion, keepAudio: built.media.keepAudio },
              width: settings.width, height: settings.height, fps: settings.fps, frames: shot.frames, duration: shot.duration,
              overlayDoc: layered ? built.doc : null, subtitle, browser: await browser(), file, signal: stop.signal, onFrame,
            });
          } else {
            issuesBy[i] = await renderSegment(await browser(), built.doc, { width: settings.width, height: settings.height, fps: settings.fps, frames: shot.frames, duration: shot.duration, subtitle }, file, stop.signal, onFrame);
          }
          fs.writeFileSync(side, JSON.stringify({ issues: issuesBy[i] }), 'utf8');
        }
        segments[i] = file;
        await report((doneFrames / totalFrames) * SEGMENT_SHARE);
      });
    } finally {
      if (browserP) await (browserP as Promise<Browser>).then((b) => b.close()).catch(() => {});
    }
    log(`镜头画面完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

    const shotIssues = settings.shots.map((s, i) => ({ shotId: s.id, version: s.version, items: issuesBy[i] ?? [] })).filter((x) => x.items.length);
    if (shotIssues.length) {
      for (const x of shotIssues) await saveShotIssues(db, x.shotId, x.version, x.items);
      const frameWarnings = settings.shots.flatMap((s, i) => (issuesBy[i] ?? []).map((m) => `镜头 ${i + 1}「${s.title || '未命名'}」：${m}`));
      settings.warnings = [...settings.warnings, ...frameWarnings];
      settings.shotIssues = shotIssues;
      await db.update(videoRender).set({ settingsJson: JSON.stringify(settings) }).where(eq(videoRender.id, id));
      for (const w of frameWarnings) log(`画面问题：${w}`);
    }

    const out = mediaDir(db, 'renders');
    const cues = videoCues(settings.shots);
    const srtFile = path.join(out, `${id}.srt`);
    fs.writeFileSync(srtFile, buildSrt(cues), 'utf8');
    const audio: { file: string; start: number; duration: number }[] = [];
    for (const s of settings.shots) {
      if (!s.audio) continue;
      const a = (await db.select().from(artifact).where(eq(artifact.id, s.audio.artifactId)))[0];
      if (!a?.ref || !fs.existsSync(a.ref)) {
        log(`「${s.title || '未命名'}」的配音文件找不到了，这段没有声音`);
        continue;
      }
      audio.push({ file: a.ref, start: s.renderStart, duration: Math.min(s.audio.duration, s.duration) });
    }
    let bgm: BgmMix | null = null;
    if (settings.bgm) {
      const file = await bgmFileOf(db, row.workstationId, settings.bgm.artifactId);
      if (file) bgm = { file: file.file, volume: settings.bgm.volume, ducking: settings.bgm.ducking };
      else log('背景音乐文件找不到了，这次不铺背景音乐');
    }
    const mp4 = path.join(out, `${id}.mp4`);
    log(`拼接 ${segments.length} 个片段 · ${audio.length} 段配音${bgm ? ` · 背景音乐 ${Math.round(bgm.volume * 100)}%${bgm.ducking ? '（说话时压低）' : ''}` : ''} · 字幕 ${settings.subtitles} · 全片 ${settings.total}s`);
    if (signal.aborted) throw new Cancelled('已取消');
    const args = assembleArgs({ segments, shots: settings.shots, audio, bgm, fps: settings.fps, total: settings.total, srt: settings.subtitles === 'srt' && cues.length ? srtFile : null, out: mp4 });
    let buf = '';
    const asm = startFfmpeg(args, {
      signal,
      onStdout: (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) {
          const m = /^out_time_us=(\d+)/.exec(l.trim());
          if (m) void report(SEGMENT_SHARE + (1 - SEGMENT_SHARE) * Math.min(1, Number(m[1]) / 1e6 / Math.max(0.001, settings.total)));
        }
      },
    });
    asm.child.stdin.end();
    try {
      await asm.done;
    } catch (e) {
      fs.rmSync(mp4, { force: true });
      throw signal.aborted ? new Cancelled('已取消') : e;
    }
    const probe = await ffprobe(mp4);
    const duration = Number(probe.format.duration ?? settings.total);
    const name = title || '视频';
    const outputArtifactId = await saveMediaArtifact(db, { workstationId: row.workstationId, type: 'video_render', name, file: mp4, meta: { renderId: id, videoId: row.videoId, duration, width: settings.width, height: settings.height, fps: settings.fps, downloadName: `${name}.mp4` } });
    const srtArtifactId = cues.length ? await saveMediaArtifact(db, { workstationId: row.workstationId, type: 'subtitle', name: `${name} 字幕`, file: srtFile, meta: { renderId: id, videoId: row.videoId, cues: cues.length, downloadName: `${name}.srt` } }) : null;
    if (!srtArtifactId) fs.rmSync(srtFile, { force: true });
    log(`完成：${duration.toFixed(2)}s`);
    live.finish(0);
    await db.update(videoRender).set({ progress: 1, outputArtifactId, srtArtifactId }).where(eq(videoRender.id, id));
    const v = await videoRow(db, row.videoId);
    if (v) {
      const d = JSON.parse(v.dataJson ?? '{}') as VideoData;
      const approved = !!settings.contentHash && d.review?.verdict === 'pass' && d.review.contentHash === settings.contentHash;
      const render = { renderId: id, artifactId: outputArtifactId, srtArtifactId, duration, contentHash: settings.contentHash ?? null, override: !!settings.override, at: now() };
      await refreshVideoStatus(actor, db, v.id, { render, ...(approved ? { renderHash: settings.contentHash } : {}) }, '出片');
    }
    await finish(db, id, 'succeeded');
  } catch (e) {
    const cancelled = signal.aborted || e instanceof Cancelled;
    const message = cancelled ? '已取消' : errorText(e);
    log(cancelled ? '已取消' : `失败：${message}`);
    live.finish(cancelled ? null : 1);
    await finish(db, id, cancelled ? 'cancelled' : 'failed', { error: message });
  } finally {
    signal.removeEventListener('abort', onCancel);
  }
}
// 进程没了，队列和 ffmpeg 也没了：排队中和渲染中的一律标失败，人重新出片即可
export async function recoverVideoRenders(db: DB) {
  const stale = await db.select({ id: videoRender.id }).from(videoRender).where(inArray(videoRender.status, ['queued', 'running']));
  if (stale.length === 0) return 0;
  await db.update(videoRender).set({ status: 'failed', error: '服务重启，渲染中断', finishedAt: now() }).where(inArray(videoRender.id, stale.map((s) => s.id)));
  return stale.length;
}
