import { createHash } from 'node:crypto';
import { applyTextEdits, composeShotDoc, deriveVideoStatus, evaluateRenderGate, lintShot, lintVideo, motionKind, overlayDoc, shotDuration, shotHashInput, shotSource, sortShots, styleKeyOf, timeline, videoHashInput, videoSize, DEFAULT_BGM_VOLUME, SHOT_MOTIONS, VIDEO_ASPECTS, VIDEO_RESOLUTIONS, MAX_SHOT_SECONDS, type ShotMotion, type ShotMotionKind, type ShotTransition, type ShotVisual, type SubtitleLook, type VideoAspect, type VideoFonts, type VideoLintIssue, type VideoLook, type VideoPalette, type VideoResolution, type VideoStatus } from '@aw/domain';
import { normalizeNarration, resolveVoice, voiceHash, type VoicePref } from '../runtime/media/tts.js';
import type { Actor } from '@aw/domain';
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { agent, entity, entityVersion } from '../db/schema.js';
import { logEvent } from './core.js';
import { createEntity, updateEntity } from './entities.js';
import { assetMediaOf, listAssets } from './video_assets.js';
import { postThreadMessage, wsThreadOf } from './threads.js';

// 审片结论钉在内容哈希上（见 videoContentHash）；by / byType 是谁下的结论
export interface VideoReview { contentHash: string; verdict: 'pass' | 'fail'; summary: string; by: string; byType: string; at: string }

export interface VideoData {
  title: string;
  brief?: string | undefined;
  audience?: string | undefined;
  aspect?: VideoAspect | undefined;
  resolution?: VideoResolution | undefined;
  fps?: number | undefined;
  script?: string | undefined;
  status?: VideoStatus | undefined;
  review?: VideoReview | null | undefined;
  // 请求审片时的内容哈希：内容没变才保持「审片中」
  reviewRequestHash?: string | null | undefined;
  render?: unknown;
  // 最近一次「审片通过后」出片时的内容哈希：对得上才算 rendered
  renderHash?: string | null | undefined;
  notes?: string | undefined;
  voice?: VoicePref | undefined;
  subtitles?: SubtitleMode | undefined;
}

export type SubtitleMode = 'burn' | 'srt' | 'off';
export const SUBTITLE_MODES: SubtitleMode[] = ['burn', 'srt', 'off'];

export type ShotStatus = 'draft' | 'ready';

// 配音落在镜头上：textHash 记下合成时的旁白 + provider + 音色 + 语速，对不上就算过期
export interface ShotAudio { artifactId: string; provider: string; voice: string; speed: number; textHash: string; duration: number; format: string }

// 画面问题（溢出、脚本报错、外部资源被拦）：按镜头版本记，版本变了旧问题不再显示
export interface ShotIssues { version: number; at: string; items: string[] }

export interface ShotData {
  video: string;
  order: number;
  title?: string | undefined;
  narration?: string | undefined;
  visual?: ShotVisual | undefined;
  html?: string | undefined;
  prompt?: string | undefined;
  asset?: string | undefined;
  duration?: number | null | undefined;
  transition?: ShotTransition | undefined;
  // 素材镜头的推拉摇移；老镜头没有这个字段，当静止
  motion?: ShotMotion | null | undefined;
  // 片段自带的音频要不要进成片（默认丢掉）
  keepAudio?: boolean | undefined;
  audio?: ShotAudio | null | undefined;
  status?: ShotStatus | undefined;
  issues?: ShotIssues | null | undefined;
}

export interface ShotCommentData {
  video: string;
  shot: string;
  version: number;
  // 镜头内的秒数
  time: number;
  selector?: string | undefined;
  anchor?: string | undefined;
  body: string;
  severity: 'block' | 'note';
  status: 'open' | 'resolved';
  note?: string | undefined;
}

export interface VideoStyleData {
  name?: string | undefined;
  palette?: VideoPalette | undefined;
  fonts?: VideoFonts | undefined;
  voice?: VoicePref | undefined;
  bgm?: string | null | undefined;
  bgmVolume?: number | undefined;
  ducking?: boolean | undefined;
  rules?: string | undefined;
  subtitle?: SubtitleLook | undefined;
}

export interface ShotInput {
  id?: string | undefined;
  title?: string | undefined;
  narration?: string | undefined;
  visual?: ShotVisual | undefined;
  html?: string | undefined;
  prompt?: string | undefined;
  asset?: string | undefined;
  duration?: number | null | undefined;
  transition?: ShotTransition | undefined;
  motion?: ShotMotionKind | null | undefined;
  keepAudio?: boolean | undefined;
  status?: ShotStatus | undefined;
}

export interface VideoPatch {
  title?: string | undefined;
  brief?: string | undefined;
  audience?: string | undefined;
  aspect?: VideoAspect | undefined;
  resolution?: VideoResolution | undefined;
  fps?: number | undefined;
  script?: string | undefined;
  notes?: string | undefined;
  voice?: VoicePref | undefined;
  subtitles?: SubtitleMode | undefined;
}

type EntityRow = typeof entity.$inferSelect;

const err = (error: string, status: 400 | 404 | 409 = 400) => ({ kind: 'error' as const, status, error });
const notFound = (what: '视频' | '镜头') => ({ kind: 'not_found' as const, status: 404 as const, error: `${what}不存在` });

const dataOf = <T,>(e: Pick<EntityRow, 'dataJson'>) => JSON.parse(e.dataJson ?? '{}') as T;
const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const VISUALS: ShotVisual[] = ['html', 'generated', 'asset'];
const TRANSITIONS: ShotTransition[] = ['cut', 'fade', 'slide'];

// 按 id 取任意实体（素材 / 片段申请这类没有专门仓储的实体用）
export const entityRowOf = async (db: DB, id: string) => (await db.select().from(entity).where(eq(entity.id, id)))[0];

export const videoRow = async (db: DB, id: string) => {
  const e = (await db.select().from(entity).where(eq(entity.id, id)))[0];
  return e?.entityType === 'Video' ? e : undefined;
};

export const shotRow = async (db: DB, id: string) => {
  const e = (await db.select().from(entity).where(eq(entity.id, id)))[0];
  return e?.entityType === 'Shot' ? e : undefined;
};

export type ClipStatus = 'pending' | 'approved' | 'rejected' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ClipRequestView {
  id: string;
  video: string;
  shot: string;
  prompt: string;
  negativePrompt: string;
  duration: number;
  imageAsset: string;
  provider: string;
  estimatedCostMicros: number;
  status: ClipStatus;
  jobId: string;
  error: string;
  asset: string;
  requestedBy: string;
  decidedBy: string;
  reason: string;
  createdAt?: string | undefined;
}

const CLIP_STATUSES: ClipStatus[] = ['pending', 'approved', 'rejected', 'running', 'succeeded', 'failed', 'cancelled'];

export function clipRequestView(row: EntityRow): ClipRequestView {
  const d = dataOf<Partial<ClipRequestView>>(row);
  return {
    id: row.id, video: d.video ?? '', shot: d.shot ?? '', prompt: d.prompt ?? '', negativePrompt: d.negativePrompt ?? '', duration: d.duration ?? 0,
    imageAsset: d.imageAsset ?? '', provider: d.provider ?? '', estimatedCostMicros: d.estimatedCostMicros ?? 0,
    status: CLIP_STATUSES.includes(d.status as ClipStatus) ? (d.status as ClipStatus) : 'pending',
    jobId: d.jobId ?? '', error: d.error ?? '', asset: d.asset ?? '', requestedBy: d.requestedBy ?? '', decidedBy: d.decidedBy ?? '', reason: d.reason ?? '',
    createdAt: row.createdAt,
  };
}

// 一支视频的片段申请，最新在前：镜头上的「等审批」提示和申请列表都用它
export async function clipRequestsOf(db: DB, wsId: string, videoId?: string | undefined) {
  const rows = await db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, 'ClipRequest')));
  return rows
    .map(clipRequestView)
    .filter((c) => !videoId || c.video === videoId)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

export const latestClipOf = (clips: ClipRequestView[], shotId: string) => clips.find((c) => c.shot === shotId) ?? null;

export async function shotRowsOf(db: DB, wsId: string, videoId: string) {
  const rows = await db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, 'Shot')));
  return sortShots(rows.map((r) => ({ row: r, data: dataOf<ShotData>(r) })).filter((x) => x.data.video === videoId).map((x) => ({ ...x, order: x.data.order })));
}

function videoFieldError(p: VideoPatch): string | null {
  if (p.title !== undefined && !p.title.trim()) return '标题不能为空';
  if (p.aspect !== undefined && !VIDEO_ASPECTS.includes(p.aspect)) return '画幅只能是 16:9、9:16 或 1:1';
  if (p.resolution !== undefined && !VIDEO_RESOLUTIONS.includes(p.resolution)) return '分辨率只能是 720p 或 1080p';
  if (p.fps !== undefined && (!Number.isInteger(p.fps) || p.fps < 12 || p.fps > 60)) return '帧率要是 12 到 60 之间的整数';
  if (p.subtitles !== undefined && !SUBTITLE_MODES.includes(p.subtitles)) return '字幕只能是 burn（烧进画面）、srt（外挂）或 off';
  if (p.voice?.speed !== undefined && !(p.voice.speed >= 0.25 && p.voice.speed <= 4)) return '语速要在 0.25 到 4 之间';
  return null;
}

// ---- 风格：每台一份，还没保存过时给默认值 ----

export async function videoStyleOf(db: DB, wsId: string) {
  const row = (await db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, 'VideoStyle'))))[0];
  const d = row ? dataOf<VideoStyleData>(row) : {};
  return {
    id: row?.id ?? null, version: row?.version ?? 0, name: d.name ?? '本台风格', palette: d.palette ?? {}, fonts: d.fonts ?? {}, voice: d.voice ?? null,
    bgm: d.bgm ?? null, bgmVolume: d.bgmVolume ?? DEFAULT_BGM_VOLUME, ducking: d.ducking !== false, rules: d.rules ?? '', subtitle: d.subtitle ?? {},
  };
}

export type VideoStyle = Awaited<ReturnType<typeof videoStyleOf>>;

// 没保存过风格的台不注入 CSS 变量，老镜头的画面保持原样
export const lookOf = (st: VideoStyle | null | undefined): VideoLook | null => (st?.id ? { palette: st.palette, fonts: st.fonts } : null);
export const styleKey = (st: VideoStyle | null | undefined) => styleKeyOf({ look: lookOf(st), subtitle: st?.subtitle, bgm: st?.bgm, bgmVolume: st?.bgmVolume, ducking: st?.ducking });

const hasPref = (p: VoicePref | null | undefined) => !!p && (p.off === true || !!p.provider || !!p.voice?.trim() || p.speed !== undefined);

// 视频自己设了配音就用视频的，否则用本台风格里的
export const effectiveVoice = (d: Pick<VideoData, 'voice'>, style?: Pick<VideoStyle, 'voice'> | null) => (hasPref(d.voice) ? d.voice : style?.voice ?? d.voice);

// 一支视频的配音口径：解析出 provider / 音色 / 语速后，逐个镜头判断配音新不新鲜
export function voiceContext(d: Pick<VideoData, 'voice'>, style?: Pick<VideoStyle, 'voice'> | null) {
  const pref = effectiveVoice(d, style);
  const voiceOn = pref?.off !== true;
  const resolved = voiceOn ? resolveVoice(pref) : { error: '这支视频不配音' };
  const ok = 'error' in resolved ? null : resolved;
  const hashOf = (narration: string | null | undefined) => (ok ? voiceHash(narration, { provider: ok.provider.name, voice: ok.voice, speed: ok.speed }) : null);
  const stateOf = (s: Pick<ShotData, 'narration' | 'audio'>): 'fresh' | 'stale' | 'none' => {
    if (!s.audio || !voiceOn) return 'none';
    return s.audio.textHash === hashOf(s.narration) && !!normalizeNarration(s.narration) ? 'fresh' : 'stale';
  };
  const timing = <T extends Pick<ShotData, 'narration' | 'audio'>>(s: T) => {
    const audioState = stateOf(s);
    return { ...s, audioState, audioDuration: audioState === 'fresh' ? s.audio!.duration : null };
  };
  return { resolved, hashOf, stateOf, timing, voiceOn, pref };
}

async function voiceOfVideo(db: DB, videoId: string) {
  const v = await videoRow(db, videoId);
  return voiceContext(v ? dataOf<VideoData>(v) : {}, v ? await videoStyleOf(db, v.workstationId) : null);
}

type TimedShotData = ShotData & { id: string; audioState: 'fresh' | 'stale' | 'none'; audioDuration: number | null };

// 内容哈希：成片会是什么样（镜头顺序、旁白、画面、生效时长、转场、新鲜配音、尺寸 / 帧率 / 字幕 / 风格）。
// 讲解稿、标题、备注、审片 / 状态字段都不进哈希
// 单个镜头的哈希输入：html 镜头比画面原文，素材镜头比素材 id、运动、叠加层和是否保留原声
export function hashShotOf(id: string, s: ShotData & { audioState?: 'fresh' | 'stale' | 'none' | undefined }, voiceOn: boolean) {
  const visual = s.visual ?? 'html';
  const source = visual === 'html' ? shotSource(s).html : s.asset ?? '';
  return {
    id, narration: s.narration, visual, source, duration: shotDuration(s), transition: s.transition,
    voice: voiceOn && s.audioState === 'fresh' ? s.audio!.textHash : null,
    motion: visual === 'html' ? 'none' : motionKind(s.motion), overlay: visual === 'html' ? '' : s.html ?? '', keepAudio: visual !== 'html' && s.keepAudio === true,
  };
}

export function videoContentHash(d: VideoData, shots: TimedShotData[], style: VideoStyle | null, voiceOn: boolean) {
  const size = videoSize(d.aspect, d.resolution);
  const hashShots = sortShots(shots).map((s) => hashShotOf(s.id, s, voiceOn));
  return sha256(videoHashInput({ width: size.width, height: size.height, fps: d.fps ?? 30, subtitles: d.subtitles ?? 'burn', voiceOn }, hashShots, styleKey(style)));
}

// 出片快照里的逐镜头哈希：两次出片比对时按镜头看变了没有
export const shotHash = (hashShot: ReturnType<typeof hashShotOf>) => sha256(shotHashInput(hashShot as unknown as Parameters<typeof shotHashInput>[0]));

async function videoStateOf(db: DB, row: EntityRow) {
  const d = dataOf<VideoData>(row);
  const style = await videoStyleOf(db, row.workstationId);
  const vc = voiceContext(d, style);
  const rows = await shotRowsOf(db, row.workstationId, row.id);
  const timed = rows.map(({ row: r, data }) => ({ id: r.id, ...vc.timing(data) }));
  return { d, style, vc, rows, timed, contentHash: videoContentHash(d, timed, style, vc.voiceOn) };
}

// 出片快照里的逐镜头哈希：两次出片比对时按镜头看变了没有
export async function shotHashesOf(db: DB, videoId: string) {
  const row = await videoRow(db, videoId);
  if (!row) return new Map<string, string>();
  const st = await videoStateOf(db, row);
  return new Map(st.timed.map((s) => [s.id, shotHash(hashShotOf(s.id, s, st.vc.voiceOn))]));
}

export async function videoContentHashOf(db: DB, videoId: string) {
  const row = await videoRow(db, videoId);
  return row ? (await videoStateOf(db, row)).contentHash : null;
}

const STATUS_REASON: Record<VideoStatus, string> = { draft: '分镜已清空', storyboarded: '内容有变', reviewing: '请求审片', approved: '审片通过', rendered: '已出片' };

// 状态只由平台按内容哈希推出来（deriveVideoStatus）；extra 是同一次写入要一起落的审片 / 出片字段
export async function refreshVideoStatus(actor: Actor, db: DB, videoId: string, extra?: Partial<VideoData>, reason?: string) {
  const row = await videoRow(db, videoId);
  if (!row) return null;
  const st = await videoStateOf(db, row);
  const d = { ...st.d, ...extra };
  const status = deriveVideoStatus({ status: d.status, contentHash: st.contentHash, shots: st.rows.length, review: d.review, reviewRequestHash: d.reviewRequestHash, renderHash: d.renderHash });
  if (status === (st.d.status ?? 'draft') && !extra) return { status, contentHash: st.contentHash, version: row.version };
  const r = await updateEntity(actor, db, row.id, { data: { ...d, status } as unknown as Record<string, unknown>, baseVersion: row.version, reason: reason ?? STATUS_REASON[status] });
  if (r.kind !== 'ok') return null;
  if (status !== (st.d.status ?? 'draft')) await logEvent(db, actor, 'video_status', 'entity', row.id, { from: st.d.status ?? 'draft', status });
  return { status, contentHash: st.contentHash, version: r.version };
}

export async function refreshWorkstationVideos(actor: Actor, db: DB, wsId: string) {
  const rows = await db.select({ id: entity.id }).from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, 'Video')));
  for (const r of rows) await refreshVideoStatus(actor, db, r.id);
}

// ---- 评论 ----

export async function listShotComments(db: DB, wsId: string, videoId?: string) {
  const rows = await db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, 'ShotComment')));
  return rows
    .map((e) => ({ id: e.id, ...dataOf<ShotCommentData>(e), createdAt: e.createdAt, updatedAt: e.updatedAt, by: { type: e.createdByType ?? 'human', id: e.createdById ?? 'local' } }))
    .filter((c) => !videoId || c.video === videoId)
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

// 出片门禁：allowPlaceholders 时缺画面不算错误（用占位画面出片）
const PLACEHOLDER_RULES = new Set(['html_empty', 'prompt_empty', 'asset_empty']);

export function gateOf(i: { review: VideoReview | null | undefined; contentHash: string; lint: VideoLintIssue[]; openBlocks: number; voiceOn: boolean; unvoiced: string[] }, allowPlaceholders = false) {
  const lintErrors = i.lint.filter((l) => l.level === 'error' && !(allowPlaceholders && PLACEHOLDER_RULES.has(l.rule))).map((l) => l.message);
  return evaluateRenderGate({ review: i.review, contentHash: i.contentHash, lintErrors, openBlocks: i.openBlocks, voiceOn: i.voiceOn, unvoiced: i.unvoiced });
}

const shotLabel = (s: { title?: string | undefined; order?: number | undefined }, i: number) => s.title || `镜头 ${s.order ?? i + 1}`;
function shotFieldError(s: ShotInput, label: string): string | null {
  if (s.visual !== undefined && !VISUALS.includes(s.visual)) return `${label}：画面类型只能是 html、generated 或 asset`;
  if (s.transition !== undefined && !TRANSITIONS.includes(s.transition)) return `${label}：转场只能是 cut、fade 或 slide`;
  if (s.motion !== undefined && s.motion !== null && !(SHOT_MOTIONS as readonly string[]).includes(s.motion)) return `${label}：画面运动只能是 none、zoom-in、zoom-out、pan-left 或 pan-right`;
  if (s.status !== undefined && s.status !== 'draft' && s.status !== 'ready') return `${label}：状态只能是 draft 或 ready`;
  if (s.duration !== undefined && s.duration !== null && (!Number.isFinite(s.duration) || s.duration <= 0 || s.duration > MAX_SHOT_SECONDS)) return `${label}：时长要在 0 到 ${MAX_SHOT_SECONDS} 秒之间`;
  return null;
}

// motion 在实体里是 json（{ kind }），接口上收一个字符串，省得模型去拼对象
const shotFields = (s: ShotInput): Partial<ShotData> => {
  const rest = defined({ ...s, id: undefined, motion: undefined }) as Partial<ShotData>;
  return s.motion === undefined ? rest : { ...rest, motion: s.motion ? { kind: s.motion } : null };
};

export async function listVideos(db: DB, wsId: string) {
  const rows = await db.select().from(entity).where(and(eq(entity.workstationId, wsId), inArray(entity.entityType, ['Video', 'Shot', 'ShotComment'])));
  const style = await videoStyleOf(db, wsId);
  const shots = rows.filter((r) => r.entityType === 'Shot').map((r) => ({ id: r.id, ...dataOf<ShotData>(r) }));
  const comments = rows.filter((r) => r.entityType === 'ShotComment').map((r) => dataOf<ShotCommentData>(r)).filter((c) => c.status !== 'resolved');
  return rows
    .filter((r) => r.entityType === 'Video')
    .map((r) => {
      const d = dataOf<VideoData>(r);
      const vc = voiceContext(d, style);
      const mine = shots.filter((s) => s.video === r.id).map(vc.timing);
      const tl = timeline(mine);
      return {
        id: r.id, title: d.title, version: r.version, status: d.status ?? 'draft', aspect: d.aspect ?? '16:9', resolution: d.resolution ?? '1080p',
        shots: mine.length, duration: tl.total, missing: mine.filter((s) => shotSource(s).placeholder).length,
        voiced: mine.filter((s) => s.audioState === 'fresh').length, openComments: comments.filter((c) => c.video === r.id).length,
        review: d.review ? { verdict: d.review.verdict, at: d.review.at } : null, updatedAt: r.updatedAt,
      };
    })
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export interface ReadVideoOpts { version?: number | undefined; includeHtml?: boolean | undefined; shotIds?: string[] | undefined }

// 视频 + 按顺序排好的镜头 + 时间线 + 检查结果 + 内容哈希与出片门禁；version 只作用于视频本身（讲解稿等），镜头总是最新
export async function getVideo(db: DB, wsId: string, id: string, opts: ReadVideoOpts = {}) {
  const row = await videoRow(db, id);
  if (!row || row.workstationId !== wsId) return null;
  let dataJson = row.dataJson;
  if (opts.version !== undefined && opts.version !== row.version) {
    const old = (await db.select().from(entityVersion).where(and(eq(entityVersion.entityId, row.id), eq(entityVersion.version, opts.version))))[0];
    if (!old) return null;
    dataJson = old.dataJson;
  }
  const d = dataOf<VideoData>({ dataJson });
  const style = await videoStyleOf(db, wsId);
  const vc = voiceContext(d, style);
  const rows = await shotRowsOf(db, wsId, row.id);
  const clips = await clipRequestsOf(db, wsId, row.id);
  const assets = new Map((await listAssets(db, wsId)).map((a) => [a.id, a]));
  const assetInfo = (id: string) => {
    const a = assets.get(id);
    return a ? { id: a.id, name: a.name, kind: a.kind, artifactId: a.artifactId, poster: a.poster, width: a.width, height: a.height, duration: a.duration } : null;
  };
  const comments = (await listShotComments(db, wsId, row.id)).filter((c) => rows.some((r) => r.row.id === c.shot));
  const open = comments.filter((c) => c.status !== 'resolved');
  const withHtml = (sid: string) => opts.includeHtml !== false && (opts.shotIds === undefined || opts.shotIds.includes(sid));
  const timedRows = rows.map(({ row: r, data }) => ({ r, s: vc.timing(data) }));
  const shots = timedRows.map(({ r, s }) => ({
    id: r.id, version: r.version, order: s.order, title: s.title ?? '', narration: s.narration ?? '', visual: s.visual ?? 'html',
    ...(withHtml(r.id) ? { html: s.html ?? '' } : {}), htmlSize: (s.html ?? '').length,
    prompt: s.prompt ?? '', asset: s.asset ?? '', assetInfo: s.asset ? assetInfo(s.asset) : null, duration: s.duration ?? null, durationSet: s.duration ?? null,
    transition: s.transition ?? 'cut', status: s.status ?? 'draft', placeholder: shotSource(s).placeholder, updatedAt: r.updatedAt,
    motion: motionKind(s.motion), keepAudio: s.keepAudio === true, clip: latestClipOf(clips, r.id),
    audio: s.audio ? { artifactId: s.audio.artifactId, duration: s.audio.duration, format: s.audio.format, provider: s.audio.provider, voice: s.audio.voice, state: s.audioState } : null,
    audioDuration: s.audioDuration,
    issues: s.issues && s.issues.version === r.version ? s.issues.items : [],
    comments: { open: open.filter((c) => c.shot === r.id).length, block: open.filter((c) => c.shot === r.id && c.severity === 'block').length },
  }));
  const tl = timeline(shots, d.fps ?? 30);
  const lint = lintVideo(d, timedRows.map(({ r, s }) => ({ id: r.id, ...s, clipRequest: latestClipOf(clips, r.id)?.status ?? null })));
  const contentHash = videoContentHash(d, timedRows.map(({ r, s }) => ({ id: r.id, ...s })), style, vc.voiceOn);
  const unvoiced = vc.voiceOn ? shots.filter((s) => s.narration.trim() && s.audio?.state !== 'fresh').map(shotLabel) : [];
  const gate = gateOf({ review: d.review, contentHash, lint, openBlocks: open.filter((c) => c.severity === 'block').length, voiceOn: vc.voiceOn, unvoiced });
  const voice = 'error' in vc.resolved ? { error: vc.resolved.error } : { provider: vc.resolved.provider.name, voice: vc.resolved.voice, speed: vc.resolved.speed };
  return {
    id: row.id, version: opts.version ?? row.version, latestVersion: row.version,
    title: d.title, brief: d.brief ?? '', audience: d.audience ?? '', aspect: d.aspect ?? '16:9', resolution: d.resolution ?? '1080p', fps: d.fps ?? 30,
    script: d.script ?? '', status: d.status ?? 'draft', notes: d.notes ?? '', review: d.review ?? null, render: d.render ?? null,
    contentHash, reviewFresh: !!d.review && d.review.contentHash === contentHash, gate, voiceOn: vc.voiceOn,
    openComments: open.map((c) => ({ id: c.id, shot: c.shot, time: c.time, body: c.body, severity: c.severity, anchor: c.anchor ?? '', by: c.by })),
    voicePref: d.voice ?? null, voice, subtitles: d.subtitles ?? 'burn',
    look: lookOf(style), subtitleLook: style.subtitle, bgm: style.bgm ? { artifactId: style.bgm, volume: style.bgmVolume, ducking: style.ducking } : null,
    size: videoSize(d.aspect, d.resolution), shots: tl.shots, total: tl.total, lint, updatedAt: row.updatedAt, clipRequests: clips,
  };
}

// 拼给 Agent 的上下文：只有清单，内容要用时再 read_video
export async function videoContextOf(db: DB, wsId: string) {
  const list = await listVideos(db, wsId);
  if (list.length === 0) return '本台还没有视频';
  return list.map((v) => `- 《${v.title}》（video: ${v.id}）v${v.version} · ${v.aspect} ${v.resolution} · ${v.shots} 个镜头 · 约 ${Math.round(v.duration)} 秒${v.missing ? ` · ${v.missing} 个镜头缺画面` : ''}${v.openComments ? ` · ${v.openComments} 条未解决评论` : ''} · ${v.status}`).join('\n');
}

export async function createVideo(actor: Actor, db: DB, wsId: string, input: VideoPatch & { title: string; reason?: string | undefined }) {
  const { reason, ...patch } = input;
  const bad = videoFieldError(patch);
  if (bad) return err(bad);
  const data: VideoData = { aspect: '16:9', resolution: '1080p', fps: 30, script: '', ...defined(patch), title: input.title.trim(), status: 'draft' };
  const r = await createEntity(actor, db, wsId, { entityType: 'Video', data: data as unknown as Record<string, unknown>, reason: reason ?? '新建视频' });
  if (r.kind !== 'ok') return r;
  await logEvent(db, actor, 'video_created', 'entity', r.id, { title: data.title });
  return { kind: 'ok' as const, id: r.id, version: 1 };
}

// 状态由平台拨：人和 Agent 只能改内容字段
export async function updateVideo(actor: Actor, db: DB, wsId: string, id: string, input: VideoPatch & { baseVersion?: number | undefined; reason?: string | undefined }) {
  const row = await videoRow(db, id);
  if (!row || row.workstationId !== wsId) return notFound('视频');
  const { baseVersion, reason, ...patch } = input;
  const bad = videoFieldError(patch);
  if (bad) return err(bad);
  const prev = dataOf<VideoData>(row);
  const data = { ...prev, ...defined(patch), title: patch.title?.trim() ?? prev.title } as VideoData;
  const r = await updateEntity(actor, db, id, { data: data as unknown as Record<string, unknown>, baseVersion: baseVersion ?? row.version, reason });
  if (r.kind !== 'ok') return r;
  await logEvent(db, actor, patch.script !== undefined && Object.keys(defined(patch)).length === 1 ? 'video_script' : 'video_updated', 'entity', id, { version: r.version });
  const st = await refreshVideoStatus(actor, db, id);
  return { kind: 'ok' as const, id, version: st?.version ?? r.version };
}

export async function saveScript(actor: Actor, db: DB, wsId: string, id: string, input: { script: string; baseVersion?: number | undefined; reason?: string | undefined }) {
  const r = await updateVideo(actor, db, wsId, id, { script: input.script, baseVersion: input.baseVersion, reason: input.reason ?? '改讲解稿' });
  if (r.kind !== 'ok') return r;
  const v = await getVideo(db, wsId, id, { includeHtml: false });
  return { ...r, lint: (v?.lint ?? []).filter((l) => !l.shotId) };
}

async function deleteEntities(db: DB, ids: string[]) {
  if (ids.length === 0) return;
  await db.delete(entityVersion).where(inArray(entityVersion.entityId, ids));
  await db.delete(entity).where(inArray(entity.id, ids));
}

export async function deleteVideo(actor: Actor, db: DB, id: string) {
  const row = await videoRow(db, id);
  if (!row) return notFound('视频');
  const shots = await shotRowsOf(db, row.workstationId, id);
  const comments = await listShotComments(db, row.workstationId, id);
  const clips = await clipRequestsOf(db, row.workstationId, id);
  await deleteEntities(db, [id, ...shots.map((s) => s.row.id), ...comments.map((c) => c.id), ...clips.map((c) => c.id)]);
  await logEvent(db, actor, 'video_deleted', 'entity', id, { title: dataOf<VideoData>(row).title, shots: shots.length });
  await logEvent(db, actor, 'entity_deleted', 'entity', id, { entityType: 'Video' });
  return { kind: 'ok' as const };
}

// 整组替换分镜：带 id 的更新（没给的字段保留），不带 id 的新建，没列出的删除（连同钉在上面的评论）；顺序按数组重排成 1..n。
// 先整体校验再落库，避免写到一半失败
export async function replaceStoryboard(actor: Actor, db: DB, wsId: string, videoId: string, input: { shots: ShotInput[]; reason?: string | undefined }) {
  const video = await videoRow(db, videoId);
  if (!video || video.workstationId !== wsId) return notFound('视频');
  if (input.shots.length > 200) return err('一支视频最多 200 个镜头');
  const existing = new Map((await shotRowsOf(db, wsId, videoId)).map((s) => [s.row.id, s]));
  const seen = new Set<string>();
  for (const [i, s] of input.shots.entries()) {
    const label = `第 ${i + 1} 个镜头`;
    if (s.id !== undefined) {
      if (!existing.has(s.id)) return err(`${label}：镜头 ${s.id} 不属于这支视频`);
      if (seen.has(s.id)) return err(`${label}：镜头 ${s.id} 重复`);
      seen.add(s.id);
    }
    const bad = shotFieldError(s, label);
    if (bad) return err(bad);
  }
  const reason = input.reason ?? '更新分镜';
  const out: { id: string; order: number; title: string }[] = [];
  for (const [i, s] of input.shots.entries()) {
    const order = i + 1;
    const prev = s.id ? existing.get(s.id) : undefined;
    if (prev) {
      const data: ShotData = { ...prev.data, ...shotFields(s), video: videoId, order };
      if (JSON.stringify(data) !== JSON.stringify(prev.data)) {
        const r = await updateEntity(actor, db, prev.row.id, { data: data as unknown as Record<string, unknown>, baseVersion: prev.row.version, reason });
        if (r.kind !== 'ok') return r;
      }
      out.push({ id: prev.row.id, order, title: data.title ?? '' });
      continue;
    }
    const data: ShotData = { visual: 'html', html: '', transition: 'cut', status: 'draft', ...shotFields(s), video: videoId, order };
    const r = await createEntity(actor, db, wsId, { entityType: 'Shot', data: data as unknown as Record<string, unknown>, reason });
    if (r.kind !== 'ok') return r;
    out.push({ id: r.id, order, title: data.title ?? '' });
  }
  const removed = [...existing.keys()].filter((id) => !seen.has(id));
  const orphan = removed.length ? (await listShotComments(db, wsId, videoId)).filter((c) => removed.includes(c.shot)).map((c) => c.id) : [];
  await deleteEntities(db, [...removed, ...orphan]);
  await refreshVideoStatus(actor, db, videoId);
  await logEvent(db, actor, 'video_storyboard', 'entity', videoId, { shots: out.length, removed: removed.length });
  const v = await getVideo(db, wsId, videoId, { includeHtml: false });
  return { kind: 'ok' as const, shots: out, removed: removed.length, total: v?.total ?? 0, lint: v?.lint ?? [] };
}

export async function updateShot(actor: Actor, db: DB, wsId: string, shotId: string, input: Omit<ShotInput, 'id'> & { baseVersion?: number | undefined; reason?: string | undefined }) {
  const row = await shotRow(db, shotId);
  if (!row || row.workstationId !== wsId) return notFound('镜头');
  const { baseVersion, reason, ...patch } = input;
  const bad = shotFieldError(patch, '镜头');
  if (bad) return err(bad);
  const prev = dataOf<ShotData>(row);
  const data: ShotData = { ...prev, ...shotFields(patch), video: prev.video, order: prev.order };
  const r = await updateEntity(actor, db, shotId, { data: data as unknown as Record<string, unknown>, baseVersion: baseVersion ?? row.version, reason });
  if (r.kind !== 'ok') return r;
  await logEvent(db, actor, 'video_shot', 'entity', shotId, { video: prev.video, version: r.version });
  await refreshVideoStatus(actor, db, prev.video);
  const timed = (await voiceOfVideo(db, prev.video)).timing(data);
  return { kind: 'ok' as const, id: shotId, version: r.version, duration: shotDuration(timed), lint: lintShot({ id: shotId, ...timed }) };
}

export async function saveShotHtml(actor: Actor, db: DB, wsId: string, shotId: string, input: { html: string; baseVersion?: number | undefined; reason?: string | undefined }) {
  return updateShot(actor, db, wsId, shotId, { html: input.html, visual: 'html', baseVersion: input.baseVersion, reason: input.reason ?? '更新画面' });
}

export async function editShotHtml(actor: Actor, db: DB, wsId: string, shotId: string, input: { edits: { oldText: string; newText: string }[]; reason?: string | undefined }) {
  const row = await shotRow(db, shotId);
  if (!row || row.workstationId !== wsId) return notFound('镜头');
  const r = applyTextEdits(dataOf<ShotData>(row).html ?? '', input.edits);
  if (!r.ok) return err(r.error);
  return saveShotHtml(actor, db, wsId, shotId, { html: r.html, baseVersion: row.version, reason: input.reason });
}

export async function reorderShots(actor: Actor, db: DB, wsId: string, videoId: string, ids: string[]) {
  const video = await videoRow(db, videoId);
  if (!video || video.workstationId !== wsId) return notFound('视频');
  const rows = await shotRowsOf(db, wsId, videoId);
  const have = new Set(rows.map((s) => s.row.id));
  if (ids.length !== have.size || new Set(ids).size !== ids.length || ids.some((id) => !have.has(id))) return err('顺序要列出这支视频的全部镜头，各一次');
  for (const [i, id] of ids.entries()) {
    const s = rows.find((x) => x.row.id === id)!;
    if (s.data.order === i + 1) continue;
    const r = await updateEntity(actor, db, id, { data: { ...s.data, order: i + 1 } as unknown as Record<string, unknown>, baseVersion: s.row.version, reason: '调整顺序' });
    if (r.kind !== 'ok') return r;
  }
  await refreshVideoStatus(actor, db, videoId);
  await logEvent(db, actor, 'video_storyboard', 'entity', videoId, { reordered: ids.length });
  return { kind: 'ok' as const };
}

const MAX_ISSUES = 20;

// 画面问题不升镜头版本（不算内容修改，也不该和人正在编辑的版本冲突）：同一版本取并集，新版本覆盖旧版本
export async function saveShotIssues(db: DB, shotId: string, version: number, items: string[]) {
  const row = await shotRow(db, shotId);
  if (!row) return false;
  const d = dataOf<ShotData>(row);
  const prev = d.issues;
  if (prev && prev.version > version) return false;
  const clean = items.map((s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean);
  const merged = [...new Set([...(prev && prev.version === version ? prev.items : []), ...clean])].slice(0, MAX_ISSUES);
  if (prev && prev.version === version && merged.length === prev.items.length) return false;
  if (!prev && merged.length === 0) return false;
  const issues: ShotIssues = { version, at: new Date().toISOString(), items: merged };
  await db.update(entity).set({ dataJson: JSON.stringify({ ...d, issues }) }).where(eq(entity.id, shotId));
  await logEvent(db, { type: 'agent', id: 'platform' }, 'video_shot_issues', 'entity', shotId, { video: d.video, version, count: merged.length });
  return true;
}

// 播放 / 渲染用的成品文档：合成方式与前端播放器完全一致；version 指定时读镜头的历史版本
export async function renderableShot(db: DB, shotId: string, version?: number) {
  const row = await shotRow(db, shotId);
  if (!row) return null;
  let dataJson = row.dataJson;
  if (version !== undefined && version !== row.version) {
    const old = (await db.select().from(entityVersion).where(and(eq(entityVersion.entityId, row.id), eq(entityVersion.version, version))))[0];
    if (!old) return null;
    dataJson = old.dataJson;
  }
  const s = dataOf<ShotData>({ dataJson });
  const video = await videoRow(db, s.video);
  const v = video ? dataOf<VideoData>(video) : null;
  const style = await videoStyleOf(db, row.workstationId);
  const size = videoSize(v?.aspect, v?.resolution);
  const duration = shotDuration(voiceContext(v ?? {}, style).timing(s));
  const parts = await shotDocParts(db, row.workstationId, s, size, duration, lookOf(style));
  return {
    workstationId: row.workstationId, videoId: s.video, shotId: row.id, version: version ?? row.version, title: s.title ?? '',
    width: size.width, height: size.height, fps: v?.fps ?? 30, duration, ...parts,
  };
}

// 镜头画面的两种来源：html 镜头是一份完整文档；素材 / 生成镜头是「原生媒体铺底 + 可选的透明叠加层」
// （shot.html 在素材镜头上就是叠加层，没有底图时用占位画面）
async function shotDocParts(db: DB, wsId: string, s: ShotData, size: { width: number; height: number }, duration: number, look: VideoLook | null) {
  const visual = s.visual ?? 'html';
  const opts = { width: size.width, height: size.height, duration, style: look };
  if (visual === 'html') {
    const src = shotSource(s);
    return { visual, media: null, placeholder: src.placeholder, hasOverlay: false, doc: composeShotDoc(src.html, opts) };
  }
  const media = await assetMediaOf(db, wsId, s.asset ?? '');
  if (!media || media.kind === 'audio') return { visual, media: null, placeholder: true, hasOverlay: false, doc: composeShotDoc(shotSource(s).html, opts) };
  return {
    visual,
    media: { assetId: media.id, artifactId: media.artifactId, file: media.file, kind: media.kind, width: media.width, height: media.height, duration: media.duration, size: media.size, mtime: media.mtime, motion: motionKind(s.motion), keepAudio: s.keepAudio === true },
    placeholder: false,
    hasOverlay: !!(s.html ?? '').trim(),
    doc: overlayDoc(s.html ?? '', opts),
  };
}

// 以人的身份在大群 @ 对应 Agent，会话路由才会唤醒它
export async function askVideoAgent(actor: Actor, db: DB, videoId: string, input: { who: 'director' | 'motion'; shotIds?: string[] | undefined; note?: string | undefined }) {
  const row = await videoRow(db, videoId);
  if (!row) return notFound('视频');
  const d = dataOf<VideoData>(row);
  const templateId = input.who === 'director' ? 'video-director' : 'motion-designer';
  const who = (await db.select({ name: agent.name }).from(agent).where(and(eq(agent.workstationId, row.workstationId), eq(agent.templateId, templateId), eq(agent.status, 'active'))))[0];
  if (!who) return err(`本台没有${input.who === 'director' ? '编导' : '动画师'}`);
  const note = input.note?.trim() ? `\n补充：${input.note.trim()}` : '';
  let text: string;
  if (input.who === 'director') {
    text = d.script?.trim()
      ? `@${who.name} 请把视频《${d.title}》（video: ${videoId}）的讲解稿拆成分镜，用 write_storyboard 整组写入。${note}`
      : `@${who.name} 请先给视频《${d.title}》（video: ${videoId}）写讲解稿，再拆成分镜。${note}`;
  } else {
    const shots = await shotRowsOf(db, row.workstationId, videoId);
    if (shots.length === 0) return err('还没有分镜，先让编导拆分镜');
    const picked = input.shotIds?.length ? shots.filter((s) => input.shotIds!.includes(s.row.id)) : shots.filter((s) => shotSource(s.data).placeholder);
    const list = (picked.length ? picked : shots).map((s) => `shot: ${s.row.id}（${s.data.title || `镜头 ${s.data.order}`}）`).join('、');
    text = `@${who.name} 请给视频《${d.title}》（video: ${videoId}）的这些镜头做画面：${list}。做完用 view_shot 看一眼关键帧。${note}`;
  }
  const th = await wsThreadOf(db, row.workstationId);
  await postThreadMessage(actor, db, th.id, text);
  return { kind: 'ok' as const, threadId: th.id };
}

// 成片渲染读镜头的某个版本：时长和风格由出片快照给定，合成方式与播放器一致
export async function shotDocAt(db: DB, shotId: string, version: number, size: { width: number; height: number }, duration: number, look: VideoLook | null) {
  const row = await shotRow(db, shotId);
  if (!row) return null;
  let dataJson = row.dataJson;
  if (version !== row.version) {
    const old = (await db.select().from(entityVersion).where(and(eq(entityVersion.entityId, row.id), eq(entityVersion.version, version))))[0];
    if (!old) return null;
    dataJson = old.dataJson;
  }
  const s = dataOf<ShotData>({ dataJson });
  const parts = await shotDocParts(db, row.workstationId, s, size, duration, look);
  return { placeholder: parts.placeholder, doc: parts.doc, visual: parts.visual, media: parts.media };
}
