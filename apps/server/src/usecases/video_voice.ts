import type { Actor } from '@aw/domain';
import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client.js';
import { agent, artifact, workstation } from '../db/schema.js';
import { budgetBreach, describeBreach, recordMediaUsage } from '../runtime/budget.js';
import { mediaDir, saveMediaArtifact } from '../runtime/media/storage.js';
import { normalizeNarration, synthesize } from '../runtime/media/tts.js';
import { sanitizeError } from '../runtime/models.js';
import { logEvent } from './core.js';
import { updateEntity } from './entities.js';
import { refreshVideoStatus, shotRow, shotRowsOf, videoRow, videoStyleOf, voiceContext, type ShotAudio, type ShotData, type VideoData } from './videos.js';

const err = (error: string, status: 400 | 404 | 409 | 502 = 400) => ({ kind: 'error' as const, status, error });
const dataOf = <T,>(e: { dataJson: string | null }) => JSON.parse(e.dataJson ?? '{}') as T;

export interface VoiceShotsOpts { shotIds?: string[] | undefined; force?: boolean | undefined }

// 花费记在谁名下：Agent 发起记它自己，人发起记本台 steward
async function payerOf(db: DB, actor: Actor, wsId: string) {
  if (actor.type === 'agent') {
    const a = (await db.select({ id: agent.id }).from(agent).where(and(eq(agent.id, actor.id), eq(agent.workstationId, wsId))))[0];
    if (a) return a.id;
  }
  const agents = await db.select({ id: agent.id, isSteward: agent.isSteward }).from(agent).where(eq(agent.workstationId, wsId));
  return (agents.find((a) => a.isSteward === 1) ?? agents[0])?.id ?? null;
}

const audioExists = async (db: DB, a: ShotAudio) => {
  const row = (await db.select({ ref: artifact.ref }).from(artifact).where(eq(artifact.id, a.artifactId)))[0];
  return !!row?.ref && fs.existsSync(row.ref);
};

// 给镜头配音：旁白 + 音色没变的跳过（force 时重配）；每合成一段先查预算、记一笔花费，
// 镜头没设定时长时，生效时长随之变成配音时长 + 气口
export async function voiceShots(actor: Actor, db: DB, wsId: string, videoId: string, opts: VoiceShotsOpts = {}) {
  const video = await videoRow(db, videoId);
  if (!video || video.workstationId !== wsId) return { kind: 'not_found' as const, status: 404 as const, error: '视频不存在' };
  const vc = voiceContext(dataOf<VideoData>(video), await videoStyleOf(db, wsId));
  if ('error' in vc.resolved) return err(vc.resolved.error, 409);
  const v = vc.resolved;
  const rows = await shotRowsOf(db, wsId, videoId);
  if (rows.length === 0) return err('还没有分镜');
  const unknown = (opts.shotIds ?? []).filter((id) => !rows.some((r) => r.row.id === id));
  if (unknown.length) return err(`镜头 ${unknown.join('、')} 不属于这支视频`);
  const picked = opts.shotIds?.length ? rows.filter((r) => opts.shotIds!.includes(r.row.id)) : rows;
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0]!;
  const payer = await payerOf(db, actor, wsId);

  const voiced: { shotId: string; duration: number; artifactId: string; costMicros: number }[] = [];
  const skipped: { shotId: string; reason: 'no_narration' | 'fresh' }[] = [];
  let costMicros = 0;
  const done = () => ({ voiced, skipped, costMicros, provider: v.provider.name, voice: v.voice, speed: v.speed });

  for (const { row, data } of picked) {
    const label = data.title || `镜头 ${data.order}`;
    const narration = normalizeNarration(data.narration);
    if (!narration) {
      skipped.push({ shotId: row.id, reason: 'no_narration' });
      continue;
    }
    const hash = vc.hashOf(data.narration)!;
    if (!opts.force && data.audio?.textHash === hash && (await audioExists(db, data.audio))) {
      skipped.push({ shotId: row.id, reason: 'fresh' });
      continue;
    }
    const breach = await budgetBreach(db, { projectId: ws.projectId, workstationId: wsId });
    if (breach && voiced.length) await refreshVideoStatus(actor, db, videoId);
    if (breach) return { ...err(`${describeBreach(breach)}，配音停在「${label}」`, 409), ...done() };
    const startedAt = new Date().toISOString();
    let syn: Awaited<ReturnType<typeof synthesize>>;
    try {
      syn = await synthesize(v, data.narration ?? '', path.join(mediaDir(db, 'audio'), `${row.id}-${hash.slice(0, 12)}`));
    } catch (e) {
      if (voiced.length) await refreshVideoStatus(actor, db, videoId);
      return { ...err(`配音失败（${label}）：${sanitizeError(e instanceof Error ? e.message : String(e))}`, 502), ...done() };
    }
    const artifactId = await saveMediaArtifact(db, {
      workstationId: wsId, type: 'audio', name: `${label} 配音`, file: syn.file,
      meta: { shotId: row.id, videoId, duration: syn.duration, format: syn.format, provider: v.provider.name, voice: v.voice, speed: v.speed, textHash: hash, chars: syn.chars },
    });
    await recordMediaUsage(db, { agentId: payer, provider: v.provider.name, model: v.provider.model || v.voice, costMicros: syn.costMicros, startedAt });
    costMicros += syn.costMicros;
    const audio: ShotAudio = { artifactId, provider: v.provider.name, voice: v.voice, speed: v.speed, textHash: hash, duration: syn.duration, format: syn.format };
    const latest = (await shotRow(db, row.id))!;
    const r = await updateEntity(actor, db, row.id, { data: { ...dataOf<ShotData>(latest), audio } as unknown as Record<string, unknown>, baseVersion: latest.version, reason: '生成配音' });
    if (r.kind !== 'ok') {
      await refreshVideoStatus(actor, db, videoId);
      return { ...err(r.error, 409), ...done() };
    }
    voiced.push({ shotId: row.id, duration: syn.duration, artifactId, costMicros: syn.costMicros });
  }
  if (voiced.length) await refreshVideoStatus(actor, db, videoId);
  await logEvent(db, actor, 'video_voiced', 'entity', videoId, { voiced: voiced.length, skipped: skipped.length, costMicros, provider: v.provider.name });
  return { kind: 'ok' as const, ...done() };
}
