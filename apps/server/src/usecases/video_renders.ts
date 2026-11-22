import { motionKind, timeline, RENDER_FPS, subtitleCues, MAX_VIDEO_SECONDS, type Actor, type SubtitleCue } from '@aw/domain';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { artifact, videoRender, workstation } from '../db/schema.js';
import { budgetBreach, describeBreach } from '../runtime/budget.js';
import { ffmpegAvailable, ffprobe, FFMPEG_MISSING } from '../runtime/media/ffmpeg.js';
import { chromiumAvailable } from '../runtime/video_frame.js';
import { abortVideoRender, enqueueVideoRender, type RenderSettings, type RenderShotSpec, type RenderStatus } from '../runtime/video_render.js';
import { logEvent } from './core.js';
import { postMessage, PLATFORM, wsThreadOf } from './threads.js';
import { bgmFileOf } from './video_style.js';
import { gateOf, getVideo, lookOf, shotHashesOf, videoRow, videoStyleOf, SUBTITLE_MODES, type SubtitleMode, type VideoData } from './videos.js';
import { assetMediaOf } from './video_assets.js';

const err = (error: string, status: 400 | 404 | 409 = 400) => ({ kind: 'error' as const, status, error });
const notFound = (error = '视频不存在') => ({ kind: 'not_found' as const, status: 404 as const, error });

export const CHROMIUM_MISSING = '本机没有可用的 Chromium，运行 pnpm exec playwright install chromium 后重试';
const PLACEHOLDER_RULES = new Set(['html_empty', 'prompt_empty', 'asset_empty']);
const ACTIVE: RenderStatus[] = ['queued', 'running'];
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface RenderInput {
  fps?: number | undefined;
  subtitles?: SubtitleMode | undefined;
  allowPlaceholders?: boolean | undefined;
  font?: string | null | undefined;
  // 人越过出片门禁时填的原因；Agent 不能越过
  override?: string | undefined;
}

// 出片前的检查：画面缺失算 error（allowPlaceholders 时降为 warn，用占位画面顶上），其余 error 必须先修
export async function planVideoRender(db: DB, wsId: string, videoId: string, input: RenderInput = {}) {
  const v = await getVideo(db, wsId, videoId);
  if (!v) return notFound();
  if (v.shots.length === 0) return err('还没有分镜，先拆分镜再出片');
  const fps = input.fps ?? v.fps;
  if (!(RENDER_FPS as readonly number[]).includes(fps)) return err(`出片帧率只能是 ${RENDER_FPS.join(' / ')}（当前 ${fps}）`);
  const subtitles = input.subtitles ?? v.subtitles;
  if (!SUBTITLE_MODES.includes(subtitles)) return err('字幕只能是 burn（烧进画面）、srt（外挂）或 off');
  const { width, height } = v.size;
  if (Math.max(width, height) > 1920 || Math.min(width, height) > 1080) return err('成片最高 1080p');
  const allowPlaceholders = input.allowPlaceholders === true;
  const errors = v.lint.filter((l) => l.level === 'error' && !(allowPlaceholders && PLACEHOLDER_RULES.has(l.rule)));
  const warnings = v.lint.filter((l) => !errors.includes(l)).map((l) => (l.level === 'error' ? `${l.message}（用占位画面出片）` : l.message));
  // 和预览同一条时间线（timeline），按出片帧率对齐
  const tl = timeline(v.shots.map((s) => ({ ...s, duration: s.durationSet })), fps);
  const hashes = await shotHashesOf(db, videoId);
  const specs = await Promise.all(tl.shots.map(async (s) => {
    const visual = s.visual ?? 'html';
    const asset = visual !== 'html' && s.asset ? await assetMediaOf(db, wsId, s.asset) : null;
    const usable = asset && (asset.kind === 'image' || asset.kind === 'video') ? asset : null;
    let keepAudio = false;
    if (usable?.kind === 'video' && s.keepAudio === true) {
      keepAudio = await probeHasAudio(usable.file);
    }
    return {
      usable,
      keepAudio,
      media: usable
        ? { assetId: usable.id, artifactId: usable.artifactId, file: usable.file, kind: usable.kind as 'image' | 'video', width: usable.width, height: usable.height, motion: motionKind(s.motion), keepAudio }
        : null,
      overlay: visual === 'html' ? '' : s.html ?? '',
    };
  }));
  const shots: RenderShotSpec[] = tl.shots.map((s, i) => {
    const nextOverlap = tl.shots[i + 1]?.overlap ?? 0;
    // 烧字幕按镜头切：最后一句收在下一个镜头的交叠开始前，转场里不会叠两行字
    const cut = s.duration - nextOverlap;
    const cues: SubtitleCue[] = subtitleCues(s.narration, s.duration)
      .map((c) => ({ ...c, end: round3(Math.min(c.end, cut)) }))
      .filter((c) => c.end > c.start);
    const fresh = v.voiceOn && s.audio?.state === 'fresh' ? s.audio : null;
    const parts = specs[i]!;
    return {
      id: s.id, version: s.version, order: s.order, title: s.title, narration: s.narration,
      duration: s.duration, frames: s.frames, transition: s.transition, overlap: s.overlap, renderStart: s.renderStart,
      placeholder: s.placeholder || (parts.usable === null && (s.visual ?? 'html') !== 'html'), audio: fresh ? { artifactId: fresh.artifactId, duration: fresh.duration } : null, cues,
      media: parts.media, overlay: parts.overlay, hash: hashes.get(s.id) ?? '',
    };
  });
  if (tl.total > MAX_VIDEO_SECONDS) return err(`成片约 ${Math.round(tl.total)} 秒，最长 ${MAX_VIDEO_SECONDS / 60} 分钟`);
  const font = input.font?.trim() || process.env.AW_SUBTITLE_FONT?.trim() || null;
  const style = await videoStyleOf(db, wsId);
  let bgm: RenderSettings['bgm'] = null;
  if (style.bgm) {
    const file = await bgmFileOf(db, wsId, style.bgm);
    if (file) bgm = { artifactId: style.bgm, volume: style.bgmVolume, ducking: style.ducking, duration: file.duration };
    else warnings.push('背景音乐文件找不到了，这次不铺背景音乐');
  }
  const unvoiced = v.voiceOn ? v.shots.filter((s) => s.narration.trim() && s.audio?.state !== 'fresh').map((s, i) => s.title || `镜头 ${s.order ?? i + 1}`) : [];
  const gate = gateOf({ review: v.review, contentHash: v.contentHash, lint: v.lint, openBlocks: v.openComments.filter((c) => c.severity === 'block').length, voiceOn: v.voiceOn, unvoiced }, allowPlaceholders);
  const settings: RenderSettings = {
    width, height, fps, subtitles, font, total: tl.total, allowPlaceholders, warnings, shots,
    contentHash: v.contentHash, look: lookOf(style), subtitleLook: style.subtitle, bgm, gate: { ok: gate.ok, checks: gate.checks }, override: null,
  };
  return { kind: 'ok' as const, video: v, settings, gate, errors: errors.map((l) => l.message) };
}

export async function createVideoRender(actor: Actor, db: DB, wsId: string, videoId: string, input: RenderInput = {}) {
  const plan = await planVideoRender(db, wsId, videoId, input);
  if (plan.kind !== 'ok') return plan;
  if (plan.errors.length) return { ...err(`先修好这些问题再出片：${plan.errors.join('；')}`), issues: plan.errors };
  const { gate } = plan;
  if (!gate.ok) {
    if (actor.type !== 'human') return { ...err(`出片门禁没通过：${gate.reasons.join('；')}。Agent 不能越过门禁：先处理这些问题，或请人决定`, 409), gate };
    const reason = input.override?.trim();
    if (!reason) return { ...err(`出片门禁没通过：${gate.reasons.join('；')}。要越过门禁出片，请填写原因`, 409), gate };
    plan.settings.override = { reason: reason.slice(0, 500), by: { type: actor.type, id: actor.id }, failed: gate.reasons, at: new Date().toISOString() };
  }
  if (!ffmpegAvailable()) return err(FFMPEG_MISSING, 409);
  if (!chromiumAvailable()) return err(CHROMIUM_MISSING, 409);
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  if (!ws) return notFound('工作台不存在');
  const breach = await budgetBreach(db, { projectId: ws.projectId, workstationId: wsId });
  if (breach) return err(`${describeBreach(breach)}，不能出片`, 409);
  const busy = (await db.select({ id: videoRender.id }).from(videoRender).where(and(eq(videoRender.videoId, videoId), inArray(videoRender.status, ACTIVE))))[0];
  if (busy) return { ...err('这支视频正在出片，等它结束或先取消', 409), renderId: busy.id };
  const id = crypto.randomUUID();
  await db.insert(videoRender).values({
    id, workstationId: wsId, videoId, videoVersion: plan.video.latestVersion, status: 'queued', progress: 0,
    settingsJson: JSON.stringify(plan.settings), createdByType: actor.type, createdById: actor.id, createdAt: new Date().toISOString(),
  });
  await logEvent(db, actor, 'video_render_queued', 'video_render', id, { videoId, fps: plan.settings.fps, total: plan.settings.total });
  const s = plan.settings;
  if (s.override) {
    await logEvent(db, actor, 'video_render_override', 'video_render', id, { videoId, reason: s.override.reason, failed: s.override.failed });
    const th = await wsThreadOf(db, wsId);
    await postMessage(db, th.id, PLATFORM, `人工越过出片门禁，出片《${plan.video.title}》。原因：${s.override.reason}。没通过的检查：${s.override.failed.join('；')}`, 'status', { kind: 'video_render_override', renderId: id, videoId });
  }
  enqueueVideoRender(db, id);
  return { kind: 'ok' as const, id, status: 'queued' as const, total: s.total, width: s.width, height: s.height, fps: s.fps, subtitles: s.subtitles, warnings: s.warnings, gate: s.gate, override: s.override, channel: `video:${id}` };
}

const audioCache = new Map<string, boolean>();

// 片段里到底有没有声音：决定 keepAudio 能不能真的把原声铺进成片
async function probeHasAudio(file: string) {
  const hit = audioCache.get(file);
  if (hit !== undefined) return hit;
  try {
    const ok = (await ffprobe(file)).streams.some((s) => s.codec_type === 'audio');
    audioCache.set(file, ok);
    return ok;
  } catch {
    return false;
  }
}

type RenderRow = typeof videoRender.$inferSelect;

function renderView(r: RenderRow, files: Map<string, { name: string; meta: Record<string, unknown> }>) {
  const s = JSON.parse(r.settingsJson) as RenderSettings;
  const file = (aid: string | null) => {
    if (!aid) return null;
    const a = files.get(aid);
    return { artifactId: aid, name: a?.name ?? '', size: Number(a?.meta.size ?? 0), duration: typeof a?.meta.duration === 'number' ? a.meta.duration : null };
  };
  return {
    id: r.id, videoId: r.videoId, videoVersion: r.videoVersion, status: r.status as RenderStatus, progress: r.progress, error: r.error,
    createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt, createdBy: { type: r.createdByType ?? 'human', id: r.createdById ?? 'local' },
    width: s.width, height: s.height, fps: s.fps, subtitles: s.subtitles, total: s.total, shots: s.shots.length,
    voiced: s.shots.filter((x) => x.audio).length, placeholders: s.shots.filter((x) => x.placeholder).length, warnings: s.warnings,
    shotIssues: s.shotIssues ?? [], contentHash: s.contentHash ?? null, gate: s.gate ?? null, override: s.override ?? null,
    bgm: s.bgm ? { artifactId: s.bgm.artifactId, volume: s.bgm.volume, ducking: s.bgm.ducking } : null,
    channel: `video:${r.id}`, output: file(r.outputArtifactId), srt: file(r.srtArtifactId),
  };
}

async function filesOf(db: DB, rows: RenderRow[]) {
  const ids = rows.flatMap((r) => [r.outputArtifactId, r.srtArtifactId]).filter((x): x is string => !!x);
  if (ids.length === 0) return new Map<string, { name: string; meta: Record<string, unknown> }>();
  const list = await db.select({ id: artifact.id, name: artifact.name, metaJson: artifact.metaJson }).from(artifact).where(inArray(artifact.id, ids));
  return new Map(list.map((a) => [a.id, { name: a.name ?? '', meta: JSON.parse(a.metaJson ?? '{}') as Record<string, unknown> }]));
}

export async function listVideoRenders(db: DB, wsId: string, videoId?: string | undefined) {
  const where = videoId ? and(eq(videoRender.workstationId, wsId), eq(videoRender.videoId, videoId)) : eq(videoRender.workstationId, wsId);
  const rows = await db.select().from(videoRender).where(where).orderBy(desc(videoRender.createdAt)).limit(100);
  const files = await filesOf(db, rows);
  const titles = new Map<string, string>();
  for (const id of new Set(rows.map((r) => r.videoId))) {
    const v = await videoRow(db, id);
    titles.set(id, v ? (JSON.parse(v.dataJson ?? '{}') as VideoData).title : '（已删除）');
  }
  return rows.map((r) => ({ ...renderView(r, files), title: titles.get(r.videoId) ?? '' }));
}
export async function getVideoRender(db: DB, id: string) {
  const r = (await db.select().from(videoRender).where(eq(videoRender.id, id)))[0];
  if (!r) return null;
  const video = await videoRow(db, r.videoId);
  const title = video ? (JSON.parse(video.dataJson ?? '{}') as VideoData).title : '';
  return { ...renderView(r, await filesOf(db, [r])), workstationId: r.workstationId, title };
}


export interface CompareShot {
  id: string;
  order: number;
  title: string;
  status: 'same' | 'changed' | 'added' | 'removed';
  hashA: string | null;
  hashB: string | null;
  durationA: number | null;
  durationB: number | null;
  timeA: number | null;
  timeB: number | null;
}

export interface RenderCompare {
  videoId: string;
  a: { id: string; createdAt: string | null; total: number; contentHash: string | null; output: string | null };
  b: { id: string; createdAt: string | null; total: number; contentHash: string | null; output: string | null };
  settings: { field: string; label: string; a: string; b: string }[];
  shots: CompareShot[];
  changed: number;
}

const show = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// 两次出片的对比：整体设置逐项比，镜头按 id 对齐比哈希
export async function compareVideoRenders(db: DB, wsId: string, idA: string, idB: string) {
  const rows = await db.select().from(videoRender).where(inArray(videoRender.id, [idA, idB]));
  const ra = rows.find((r) => r.id === idA);
  const rb = rows.find((r) => r.id === idB);
  if (!ra || !rb) return notFound('出片记录不存在');
  if (ra.workstationId !== wsId || rb.workstationId !== wsId) return notFound('出片记录不存在');
  if (ra.videoId !== rb.videoId) return err('两次出片不是同一支视频，不能比', 409);
  if (ra.status !== 'succeeded' || rb.status !== 'succeeded') return err('只有成功出片的两次才能对比', 409);
  const sa = JSON.parse(ra.settingsJson) as RenderSettings;
  const sb = JSON.parse(rb.settingsJson) as RenderSettings;
  const settings: RenderCompare['settings'] = [];
  const put = (field: string, label: string, a: unknown, b: unknown) => {
    const x = show(a);
    const y = show(b);
    if (x !== y) settings.push({ field, label, a: x, b: y });
  };
  put('size', '尺寸', `${sa.width}×${sa.height}`, `${sb.width}×${sb.height}`);
  put('fps', '帧率', sa.fps, sb.fps);
  put('subtitles', '字幕', sa.subtitles, sb.subtitles);
  put('total', '总时长', sa.total, sb.total);
  put('look', '风格', sa.look ?? {}, sb.look ?? {});
  put('subtitleLook', '字幕样式', sa.subtitleLook ?? {}, sb.subtitleLook ?? {});
  put('bgm', '背景音乐', sa.bgm ? { volume: sa.bgm.volume, ducking: sa.bgm.ducking } : null, sb.bgm ? { volume: sb.bgm.volume, ducking: sb.bgm.ducking } : null);
  put('allowPlaceholders', '允许占位画面', sa.allowPlaceholders, sb.allowPlaceholders);
  put('gate', '出片门禁', sa.gate?.ok, sb.gate?.ok);
  put('override', '越过门禁', sa.override?.reason ?? null, sb.override?.reason ?? null);
  const byA = new Map(sa.shots.map((s) => [s.id, s]));
  const byB = new Map(sb.shots.map((s) => [s.id, s]));
  const ids = [...new Set([...sa.shots.map((s) => s.id), ...sb.shots.map((s) => s.id)])];
  const order = (id: string) => byB.get(id)?.order ?? byA.get(id)?.order ?? 0;
  const shots: CompareShot[] = ids
    .sort((x, y) => order(x) - order(y))
    .map((id) => {
      const a = byA.get(id);
      const b = byB.get(id);
      const status: CompareShot['status'] = !a ? 'added' : !b ? 'removed' : a.hash !== b.hash ? 'changed' : 'same';
      return {
        id, order: order(id), title: b?.title || a?.title || '', status,
        hashA: a?.hash ?? null, hashB: b?.hash ?? null,
        durationA: a?.duration ?? null, durationB: b?.duration ?? null,
        timeA: a?.renderStart ?? null, timeB: b?.renderStart ?? null,
      };
    });
  return {
    kind: 'ok' as const,
    compare: {
      videoId: ra.videoId,
      a: { id: ra.id, createdAt: ra.finishedAt ?? ra.createdAt, total: sa.total, contentHash: sa.contentHash ?? null, output: ra.outputArtifactId },
      b: { id: rb.id, createdAt: rb.finishedAt ?? rb.createdAt, total: sb.total, contentHash: sb.contentHash ?? null, output: rb.outputArtifactId },
      settings, shots, changed: shots.filter((s) => s.status !== 'same').length,
    } satisfies RenderCompare,
  };
}

export async function cancelVideoRender(actor: Actor, db: DB, id: string) {
  const r = (await db.select().from(videoRender).where(eq(videoRender.id, id)))[0];
  if (!r) return notFound('出片记录不存在');
  if (!ACTIVE.includes(r.status as RenderStatus)) return err('这次出片已经结束了', 409);
  if (abortVideoRender(id)) {
    await logEvent(db, actor, 'video_render_cancel', 'video_render', id, { videoId: r.videoId });
    return { kind: 'ok' as const, status: 'cancelling' as const };
  }
  // 队列里已经没有它（比如进程重启过）：直接收口
  await db.update(videoRender).set({ status: 'cancelled', error: '已取消', finishedAt: new Date().toISOString() }).where(eq(videoRender.id, id));
  await logEvent(db, actor, 'video_render_finished', 'video_render', id, { status: 'cancelled', videoId: r.videoId });
  return { kind: 'ok' as const, status: 'cancelled' as const };
}

