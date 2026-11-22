import type { Actor } from '@aw/domain';
import { estimateDuration } from '@aw/domain';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import type { DB } from '../db/client.js';
import { agent, entity, workstation } from '../db/schema.js';
import { firstBreach } from '@aw/domain';
import { budgetLevels, recordMediaUsage } from '../runtime/budget.js';
import { ffprobe } from '../runtime/media/ffmpeg.js';
import { mediaDir } from '../runtime/media/storage.js';
import { clipCostMicros, genErrorText, resolveVideoProvider } from '../runtime/media/video_gen.js';
import { sanitizeError } from '../runtime/models.js';
import { logEvent } from './core.js';
import { createEntity, updateEntity } from './entities.js';
import { closeInboxFor, pushInbox } from './inbox.js';
import { postMessage, PLATFORM, wsThreadOf } from './threads.js';
import { assetMediaOf, saveGeneratedAsset, CLIP_MAX_SECONDS, CLIP_MIN_SECONDS } from './video_assets.js';
import { clipRequestView, refreshVideoStatus, shotRow, videoRow, type ClipRequestView, type ClipStatus, type ShotData, type VideoData } from './videos.js';

const err = (error: string, status: 400 | 404 | 409 | 502 = 400) => ({ kind: 'error' as const, status, error });
const notFound = (error = '片段申请不存在') => ({ kind: 'not_found' as const, status: 404 as const, error });
const dataOf = <T,>(e: { dataJson: string | null }) => JSON.parse(e.dataJson ?? '{}') as T;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const ACTIVE: ClipStatus[] = ['approved', 'running'];

type ClipRequestData = Omit<ClipRequestView, 'id' | 'createdAt'>;

async function clipRow(db: DB, id: string) {
  const e = (await db.select().from(entity).where(eq(entity.id, id)))[0];
  return e?.entityType === 'ClipRequest' ? e : undefined;
}

// 花费记在谁名下：申请方是 Agent 就记它，人发起的记本台 steward
async function payerOf(db: DB, wsId: string, requestedBy: string) {
  const [type, id] = requestedBy.split(':');
  if (type === 'agent' && id) {
    const a = (await db.select({ id: agent.id }).from(agent).where(and(eq(agent.id, id), eq(agent.workstationId, wsId))))[0];
    if (a) return a.id;
  }
  const agents = await db.select({ id: agent.id, isSteward: agent.isSteward }).from(agent).where(eq(agent.workstationId, wsId));
  return (agents.find((a) => a.isSteward === 1) ?? agents[0])?.id ?? null;
}

// 提到申请方（Agent 的话要 @ 到名字，会话才会继续）
async function mentionOf(db: DB, requestedBy: string) {
  const [type, id] = requestedBy.split(':');
  if (type !== 'agent' || !id) return '平台';
  const a = (await db.select({ name: agent.name }).from(agent).where(eq(agent.id, id)))[0];
  return a ? `@${a.name}` : '平台';
}

async function notifyThread(db: DB, wsId: string, text: string, meta: Record<string, unknown>) {
  const th = await wsThreadOf(db, wsId);
  await postMessage(db, th.id, PLATFORM, text, 'status', meta);
}

async function fail(db: DB, wsId: string, rowId: string, requestedBy: string, message: string) {
  const row = await clipRow(db, rowId);
  if (!row) return;
  const d = dataOf<ClipRequestView>(row);
  await updateEntity({ type: 'agent', id: 'platform' }, db, rowId, { data: { ...d, status: 'failed', error: message.slice(0, 800) } as unknown as Record<string, unknown>, baseVersion: row.version, reason: '片段生成失败' });
  await logEvent(db, { type: 'agent', id: 'platform' }, 'video_clip_failed', 'entity', rowId, { error: message.slice(0, 200) });
  await notifyThread(db, wsId, `${await mentionOf(db, requestedBy)} 片段生成失败：${message.slice(0, 300)}`, { kind: 'clip_failed', requestId: rowId });
}

// Agent 和人都只写申请：创建一条待审批记录 + 一条收件箱条目，绝不在这里调用生成服务
export async function requestClip(actor: Actor, db: DB, wsId: string, input: { shotId: string; prompt: string; negativePrompt?: string | undefined; duration?: number | undefined; image?: string | undefined }) {
  const shot = await shotRow(db, input.shotId);
  if (!shot || shot.workstationId !== wsId) return { kind: 'not_found' as const, status: 404 as const, error: '镜头不存在' };
  const s = dataOf<ShotData>(shot);
  const video = await videoRow(db, s.video);
  if (!video) return { kind: 'not_found' as const, status: 404 as const, error: '镜头不属于任何视频' };
  const prompt = input.prompt.trim();
  if (!prompt) return err('提示词不能为空');
  if (prompt.length > 4000) return err('提示词最多 4000 字');
  const wanted = input.duration ?? (s.duration ?? estimateDuration(s.narration));
  if (!Number.isFinite(wanted) || wanted <= 0) return err('时长要是正数');
  const duration = round3(Math.min(CLIP_MAX_SECONDS, Math.max(CLIP_MIN_SECONDS, wanted)));
  let imageAsset = '';
  if (input.image) {
    const media = await assetMediaOf(db, wsId, input.image);
    if (!media || media.kind !== 'image') return err('首帧素材不存在或不是图片');
    imageAsset = media.id;
  }
  const resolved = resolveVideoProvider();
  if ('error' in resolved) return err(resolved.error, 409);
  const estimatedCostMicros = clipCostMicros(resolved.provider, duration);
  const requestedBy = `${actor.type}:${actor.id}`;
  const data: ClipRequestData = {
    video: video.id, shot: shot.id, prompt, negativePrompt: input.negativePrompt?.trim() ?? '', duration, imageAsset,
    provider: resolved.provider.name, estimatedCostMicros, status: 'pending', jobId: '', error: '', asset: '', requestedBy, decidedBy: '', reason: '',
  };
  const r = await createEntity(actor, db, wsId, { entityType: 'ClipRequest', data: data as unknown as Record<string, unknown>, reason: '申请生成片段' });
  if (r.kind !== 'ok') return r;
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  await pushInbox(db, ws?.projectId ?? '', {
    kind: 'clip_request', refType: 'clip_request', refId: r.id,
    payload: { wsId, videoId: video.id, videoTitle: dataOf<VideoData>(video).title ?? '', shotId: shot.id, shotTitle: s.title ?? '', prompt, duration, estimatedCostMicros, provider: resolved.provider.name, requestedBy },
  });
  await logEvent(db, actor, 'video_clip_requested', 'entity', r.id, { videoId: video.id, shotId: shot.id, duration, estimatedCostMicros });
  return { kind: 'ok' as const, id: r.id, status: 'pending' as const, estimatedCostMicros, duration, provider: resolved.provider.name };
}

export async function readClipRequest(db: DB, wsId: string, id: string) {
  const row = await clipRow(db, id);
  if (!row || row.workstationId !== wsId) return null;
  return clipRequestView(row);
}

export async function listClipRequests(db: DB, wsId: string, filter: { videoId?: string | undefined; shotId?: string | undefined; status?: string | undefined } = {}) {
  const rows = await db.select().from(entity).where(and(eq(entity.workstationId, wsId), eq(entity.entityType, 'ClipRequest')));
  return rows
    .map(clipRequestView)
    .filter((c) => (!filter.videoId || c.video === filter.videoId) && (!filter.shotId || c.shot === filter.shotId) && (!filter.status || c.status === filter.status))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

async function patchRequest(db: DB, id: string, patch: Partial<ClipRequestView>, reason: string) {
  const row = await clipRow(db, id);
  if (!row) return null;
  const d = dataOf<ClipRequestView>(row);
  const r = await updateEntity({ type: 'agent', id: 'platform' }, db, id, { data: { ...d, ...patch } as unknown as Record<string, unknown>, baseVersion: row.version, reason });
  return r.kind === 'ok' ? r.version : null;
}

// 提交生成：预算在审批时已经看过，这里只管把任务发出去
async function submitClip(db: DB, wsId: string, id: string, d: ClipRequestView) {
  const resolved = resolveVideoProvider({ provider: d.provider || undefined });
  if ('error' in resolved) {
    await fail(db, wsId, id, d.requestedBy, resolved.error);
    return;
  }
  const video = await videoRow(db, d.video);
  const v = video ? dataOf<VideoData>(video) : ({} as VideoData);
  const image = d.imageAsset ? await assetMediaOf(db, wsId, d.imageAsset) : null;
  const ctx = { provider: resolved.provider, workstationId: wsId };
  try {
    const { jobId } = await resolved.adapter.submit({
      prompt: d.prompt, negativePrompt: d.negativePrompt || undefined, duration: d.duration, aspect: v.aspect ?? '16:9', resolution: v.resolution ?? '1080p',
      ...(image ? { image: { path: image.file } } : {}),
    }, ctx);
    await patchRequest(db, id, { status: 'running', jobId }, '提交片段生成');
    await logEvent(db, { type: 'agent', id: 'platform' }, 'video_clip_submitted', 'entity', id, { provider: resolved.provider.name, jobId, shotId: d.shot });
  } catch (e) {
    await fail(db, wsId, id, d.requestedBy, genErrorText(e));
  }
}

// 拿到结果：下载到媒体目录、登记素材、把素材接到镜头上、按实际时长记花费、在会话里 @ 申请方
type Resolved = Exclude<ReturnType<typeof resolveVideoProvider>, { error: string }>;

async function finishClip(db: DB, wsId: string, id: string, d: ClipRequestView, resolved: Resolved, result: { file?: string | undefined; url?: string | undefined }, startedAt: string) {
  const file = path.join(mediaDir(db, 'assets'), `${id}.mp4`);
  await resolved.adapter.fetchResult(result, file, { provider: resolved.provider, workstationId: wsId });
  const probe = await ffprobe(file);
  const stream = probe.streams.find((x) => x.codec_type === 'video');
  const duration = round3(Number(probe.format.duration ?? d.duration) || d.duration);
  const shot = await shotRow(db, d.shot);
  const s = shot ? dataOf<ShotData>(shot) : null;
  const base = s?.title?.trim() || '镜头';
  const name = base.endsWith('片段') ? base : `${base} 片段`;
  const saved = await saveGeneratedAsset({ type: 'agent', id: 'platform' }, db, wsId, { name, file, prompt: d.prompt, provider: d.provider, duration, width: stream?.width ?? 0, height: stream?.height ?? 0 });
  if (saved.kind !== 'ok') {
    await fail(db, wsId, id, d.requestedBy, saved.error);
    return;
  }
  const costMicros = Math.round(duration * (resolved.provider.price?.perSecond ?? 0) * 1e6);
  await recordMediaUsage(db, { agentId: await payerOf(db, wsId, d.requestedBy), provider: resolved.provider.name, model: 'clip', costMicros, startedAt });
  await patchRequest(db, id, { status: 'succeeded', asset: saved.id, error: '' }, '片段生成完成');
  if (shot) {
    const latest = await shotRow(db, d.shot);
    if (latest) {
      const cur = dataOf<ShotData>(latest);
      await updateEntity({ type: 'agent', id: 'platform' }, db, d.shot, { data: { ...cur, visual: 'generated', asset: saved.id, prompt: d.prompt } as unknown as Record<string, unknown>, baseVersion: latest.version, reason: '接入生成的片段' });
    }
    await refreshVideoStatus({ type: 'agent', id: 'platform' }, db, d.video);
  }
  await logEvent(db, { type: 'agent', id: 'platform' }, 'video_clip_succeeded', 'entity', id, { assetId: saved.id, duration, costMicros });
  await notifyThread(db, wsId, `${await mentionOf(db, d.requestedBy)} 片段生成好了（${duration}s，约 $${(costMicros / 1e6).toFixed(3)}），已经接到「${s?.title || '镜头'}」上。要看画面用 view_shot`, { kind: 'clip_succeeded', requestId: id, assetId: saved.id, shotId: d.shot });
}

async function pollClip(db: DB, wsId: string, id: string, d: ClipRequestView) {
  const resolved = resolveVideoProvider({ provider: d.provider || undefined });
  if ('error' in resolved) return fail(db, wsId, id, d.requestedBy, resolved.error);
  try {
    const status = await resolved.adapter.poll(d.jobId, { provider: resolved.provider, workstationId: wsId });
    if (status.state === 'queued' || status.state === 'running') return;
    if (status.state === 'failed') return fail(db, wsId, id, d.requestedBy, status.error ?? '生成失败');
    if (!status.result) return fail(db, wsId, id, d.requestedBy, '生成成功但没有结果');
    const startedAt = new Date().toISOString();
    await finishClip(db, wsId, id, d, resolved, status.result, startedAt);
  } catch (e) {
    await fail(db, wsId, id, d.requestedBy, genErrorText(e));
  }
}

// 人批 / 拒：批准前先算上这笔预估花费查三级预算，超了就挡住
export async function decideClipRequest(actor: Actor, db: DB, wsId: string, id: string, input: { decision: 'approve' | 'reject'; reason?: string | undefined }) {
  if (actor.type !== 'human') return err('片段申请要人来批', 409);
  const row = await clipRow(db, id);
  if (!row || row.workstationId !== wsId) return notFound();
  const d = clipRequestView(row);
  if (d.status !== 'pending') return err(`这条申请已经是「${d.status}」了`, 409);
  const reason = input.reason?.trim().slice(0, 500) ?? '';
  if (input.decision === 'reject') {
    await patchRequest(db, id, { status: 'rejected', decidedBy: `${actor.type}:${actor.id}`, reason }, '拒绝片段申请');
    await closeInboxFor(db, 'clip_request', id, { decision: 'reject' });
    await logEvent(db, actor, 'video_clip_rejected', 'entity', id, { reason });
    await notifyThread(db, wsId, `${await mentionOf(db, d.requestedBy)} 片段申请被拒了${reason ? `：${reason}` : ''}。提示词：${d.prompt.slice(0, 200)}`, { kind: 'clip_rejected', requestId: id });
    return { kind: 'ok' as const, status: 'rejected' as const };
  }
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  const levels = await budgetLevels(db, { projectId: ws?.projectId ?? '', workstationId: wsId });
  const breach = firstBreach(levels.map((l) => ({ ...l, usage: { ...l.usage, costMicros: l.usage.costMicros + d.estimatedCostMicros } })));
  if (breach) return err(`批准这段片段会超预算（预估 $${(d.estimatedCostMicros / 1e6).toFixed(3)}，${breach.scope} 已用 $${(breach.used / 1e6).toFixed(2)} / $${(breach.limit / 1e6).toFixed(2)}）`, 409);
  await patchRequest(db, id, { status: 'approved', decidedBy: `${actor.type}:${actor.id}`, reason }, '批准片段申请');
  await closeInboxFor(db, 'clip_request', id, { decision: 'approve' });
  await logEvent(db, actor, 'video_clip_approved', 'entity', id, { estimatedCostMicros: d.estimatedCostMicros });
  await notifyThread(db, wsId, `片段申请已批（预估 $${(d.estimatedCostMicros / 1e6).toFixed(3)}），开始生成。提示词：${d.prompt.slice(0, 200)}`, { kind: 'clip_approved', requestId: id });
  await submitClip(db, wsId, id, { ...d, status: 'approved' });
  const after = await clipRow(db, id);
  return { kind: 'ok' as const, status: after ? clipRequestView(after).status : ('approved' as ClipStatus) };
}

const inFlight = new Set<string>();
let pumping = false;

// 后台轮询：approved 的提交、running 的查结果；同一进程内一次只跑一遍，同一条申请不并发处理
export async function pumpClips(db: DB) {
  if (pumping) return 0;
  pumping = true;
  let handled = 0;
  try {
    const rows = await db.select().from(entity).where(and(eq(entity.entityType, 'ClipRequest')));
    for (const row of rows) {
      const d = clipRequestView(row);
      if (!ACTIVE.includes(d.status)) continue;
      if (inFlight.has(row.id)) continue;
      inFlight.add(row.id);
      handled++;
      try {
        if (d.status === 'approved') await submitClip(db, row.workstationId, row.id, d);
        else if (d.status === 'running') await pollClip(db, row.workstationId, row.id, d);
      } finally {
        inFlight.delete(row.id);
      }
    }
  } finally {
    pumping = false;
  }
  return handled;
}

let timer: NodeJS.Timeout | null = null;

export function startClipPoller(db: DB) {
  if (timer) return;
  timer = setInterval(() => {
    void pumpClips(db).catch((e) => console.error('[video] 片段轮询异常', sanitizeError(e instanceof Error ? e.message : String(e))));
  }, 1500);
  timer.unref?.();
}

export function stopClipPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}

// 进程重启：mock 的生成任务在内存里，丢了就重提（确定性、不花钱）；接了真实厂商的先标失败，人决定要不要重新申请
export async function recoverClipRequests(db: DB) {
  const all = await db.select().from(entity).where(eq(entity.entityType, 'ClipRequest'));
  let n = 0;
  for (const row of all) {
    const d = clipRequestView(row);
    if (d.status !== 'running') continue;
    const resolved = resolveVideoProvider({ provider: d.provider || undefined });
    const protocol = 'error' in resolved ? null : resolved.provider.protocol;
    if (protocol === 'mock') {
      await patchRequest(db, row.id, { status: 'approved', jobId: '' }, '服务重启，重新提交');
    } else {
      await patchRequest(db, row.id, { status: 'failed', error: '服务重启，生成中断' }, '服务重启，标记失败');
    }
    n++;
  }
  return n;
}
