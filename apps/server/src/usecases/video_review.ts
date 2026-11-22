import { isShotSelector, shotDuration, type Actor } from '@aw/domain';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { agent, entity } from '../db/schema.js';
import { logEvent } from './core.js';
import { createEntity, updateEntity } from './entities.js';
import { postThreadMessage, wsThreadOf } from './threads.js';
import { refreshVideoStatus, shotRow, shotRowsOf, videoContentHashOf, videoRow, videoStyleOf, voiceContext, type ShotCommentData, type ShotData, type VideoData, type VideoReview } from './videos.js';

const err = (error: string, status: 400 | 404 | 409 = 400) => ({ kind: 'error' as const, status, error });
const dataOf = <T,>(e: { dataJson: string | null }) => JSON.parse(e.dataJson ?? '{}') as T;

export interface ShotCommentInput { shot: string; time?: number | undefined; selector?: string | undefined; anchor?: string | undefined; body: string; severity?: 'block' | 'note' | undefined }

// 评论钉在镜头的某个版本和镜头内时间点上；selector 是人在画面里圈选的元素（只收平台生成的结构化选择器）
export async function addShotComment(actor: Actor, db: DB, wsId: string, input: ShotCommentInput) {
  const row = await shotRow(db, input.shot);
  if (!row || row.workstationId !== wsId) return { kind: 'not_found' as const, status: 404 as const, error: '镜头不存在' };
  const body = input.body.trim();
  if (!body) return err('评论内容不能为空');
  if (body.length > 4000) return err('评论最多 4000 字');
  if (input.selector && !isShotSelector(input.selector)) return err('元素选择器不合法');
  if (input.severity !== undefined && input.severity !== 'block' && input.severity !== 'note') return err('severity 只能是 block 或 note');
  const s = dataOf<ShotData>(row);
  const video = await videoRow(db, s.video);
  const duration = shotDuration(voiceContext(video ? dataOf<VideoData>(video) : {}, await videoStyleOf(db, wsId)).timing(s));
  const t = Number.isFinite(input.time) ? Math.min(Math.max(0, input.time!), duration) : 0;
  const data: ShotCommentData = {
    video: s.video, shot: row.id, version: row.version, time: Math.round(t * 100) / 100, body, severity: input.severity ?? 'note', status: 'open',
    ...(input.selector ? { selector: input.selector } : {}), ...(input.anchor?.trim() ? { anchor: input.anchor.trim().slice(0, 80) } : {}),
  };
  const r = await createEntity(actor, db, wsId, { entityType: 'ShotComment', data: data as unknown as Record<string, unknown>, reason: '镜头评论' });
  if (r.kind !== 'ok') return r;
  await logEvent(db, actor, 'video_comment', 'entity', r.id, { video: s.video, shot: row.id, severity: data.severity });
  return { kind: 'ok' as const, id: r.id, video: s.video, shot: row.id, version: row.version, time: data.time, severity: data.severity };
}

export async function resolveShotComments(actor: Actor, db: DB, wsId: string, ids: string[], note?: string) {
  let resolved = 0;
  const videos = new Set<string>();
  for (const id of ids) {
    const row = (await db.select().from(entity).where(eq(entity.id, id)))[0];
    if (row?.entityType !== 'ShotComment' || row.workstationId !== wsId) continue;
    const d = dataOf<ShotCommentData>(row);
    if (d.status === 'resolved') continue;
    const r = await updateEntity(actor, db, id, { data: { ...d, status: 'resolved', ...(note?.trim() ? { note: note.trim().slice(0, 2000) } : {}) } as unknown as Record<string, unknown>, baseVersion: row.version, reason: note || '解决评论' });
    if (r.kind === 'ok') {
      resolved += 1;
      videos.add(d.video);
    }
  }
  for (const v of videos) await logEvent(db, actor, 'video_comment', 'entity', v, { resolved });
  return resolved;
}

// 审片结论钉在 read_video 时的内容哈希上：中途有人改过（哈希对不上）就不收，让审片重读再审
export async function saveVideoReview(actor: Actor, db: DB, wsId: string, input: { id: string; contentHash: string; verdict: 'pass' | 'fail'; summary: string }) {
  const row = await videoRow(db, input.id);
  if (!row || row.workstationId !== wsId) return { kind: 'not_found' as const, status: 404 as const, error: '视频不存在' };
  if ((await shotRowsOf(db, wsId, row.id)).length === 0) return err('还没有分镜，没东西可审');
  const hash = await videoContentHashOf(db, row.id);
  if (input.contentHash !== hash) return { kind: 'conflict' as const, status: 409 as const, error: '视频在读取后改过（内容哈希对不上），请重新 read_video 再审' };
  const review: VideoReview = { contentHash: hash, verdict: input.verdict, summary: input.summary.trim().slice(0, 4000), by: actor.id, byType: actor.type, at: new Date().toISOString() };
  const st = await refreshVideoStatus(actor, db, row.id, { review, reviewRequestHash: null }, `审片：${input.verdict === 'pass' ? '通过' : '没通过'}`);
  if (!st) return err('保存审片结论失败', 409);
  await logEvent(db, actor, 'video_review', 'entity', row.id, { verdict: input.verdict, contentHash: hash });
  return { kind: 'ok' as const, verdict: input.verdict, status: st.status, contentHash: hash };
}

// 人点「请求审片」：记下当前内容哈希、状态拨到审片中，再以人的身份在大群 @ 审片
export async function requestVideoReview(actor: Actor, db: DB, videoId: string, note?: string) {
  const row = await videoRow(db, videoId);
  if (!row) return { kind: 'not_found' as const, status: 404 as const, error: '视频不存在' };
  const d = dataOf<VideoData>(row);
  const who = (await db.select({ name: agent.name }).from(agent).where(and(eq(agent.workstationId, row.workstationId), eq(agent.templateId, 'video-reviewer'), eq(agent.status, 'active'))))[0];
  if (!who) return err('本台没有审片');
  if ((await shotRowsOf(db, row.workstationId, row.id)).length === 0) return err('还没有分镜，先拆分镜再请求审片');
  const hash = (await videoContentHashOf(db, row.id))!;
  const st = await refreshVideoStatus(actor, db, row.id, { status: 'reviewing', reviewRequestHash: hash }, '请求审片');
  if (!st) return err('请求审片失败', 409);
  const extra = note?.trim() ? `\n补充：${note.trim()}` : '';
  const th = await wsThreadOf(db, row.workstationId);
  await postThreadMessage(actor, db, th.id, `@${who.name} 请审视频《${d.title}》（video: ${videoId}）。先 read_video 拿内容哈希，逐个镜头用 view_shot 看画面，问题用 comment_shot 钉在镜头和时间点上，最后 save_video_review 给结论。${extra}`);
  await logEvent(db, actor, 'video_review_requested', 'entity', videoId, { contentHash: hash });
  return { kind: 'ok' as const, threadId: th.id, status: st.status, contentHash: hash };
}
