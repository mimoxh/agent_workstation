import { eq } from 'drizzle-orm';
import type { Actor } from '@aw/domain';
import type { DB } from '../db/client.js';
import { entity, entityVersion, proposal, reviewComment, task } from '../db/schema.js';
import { snapshotDb } from './backup.js';
import { closeInboxFor } from './inbox.js';
import { enqueueMerge, afterReview } from '../runtime/dev_workflow.js';
import { logEvent } from './core.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

export async function decideProposal(actor: Actor, db: DB, proposalId: string, action: 'approve' | 'reject', reason?: string) {
  if (actor.type !== 'human') return { kind: 'error' as const, status: 403 as const, error: '仅限人决定提案' };
  const rows = await db.select().from(proposal).where(eq(proposal.id, proposalId));
  const p = rows[0];
  if (!p) return { kind: 'not_found' as const, status: 404 as const, error: '提案不存在' };
  if (p.status !== 'pending') return { kind: 'invalid' as const, status: 409 as const, error: `提案已是 ${p.status}` };

  if (action === 'reject') {
    await db.update(proposal).set({ status: 'rejected', decidedByType: 'human', decidedById: actor.id, decidedAt: now() }).where(eq(proposal.id, proposalId));
    await logEvent(db, actor, 'proposal_rejected', 'proposal', proposalId, { reason: reason ?? null });
    await closeInboxFor(db, 'proposal', proposalId, { action: 'reject' });
    return { kind: 'ok' as const };
  }

  await snapshotDb(db, proposalId);
  // approve：base_version 必须匹配
  let entityId = p.entityId;
  let newVersion = 1;
  if (entityId) {
    const e = (await db.select().from(entity).where(eq(entity.id, entityId)))[0];
    if (!e) return { kind: 'invalid' as const, status: 409 as const, error: '目标实体已删除' };
    if (e.version !== p.baseVersion) {
      await db.update(proposal).set({ status: 'superseded', decidedByType: 'human', decidedById: actor.id, decidedAt: now() }).where(eq(proposal.id, proposalId));
      await logEvent(db, actor, 'proposal_superseded', 'proposal', proposalId);
      return { kind: 'conflict' as const, status: 409 as const, error: 'base_version 不匹配，提案已标为 superseded' };
    }
    newVersion = e.version + 1;
    await db.update(entity).set({ dataJson: p.patchJson, version: newVersion, updatedAt: now() }).where(eq(entity.id, entityId));
  } else {
    entityId = uid();
    const t = p.taskId ? (await db.select().from(task).where(eq(task.id, p.taskId)))[0] : null;
    await db.insert(entity).values({
      id: entityId, workstationId: p.workstationId ?? t?.workstationId ?? '', entityType: p.targetType ?? '',
      dataJson: p.patchJson, version: 1, createdByType: 'agent', createdById: p.authorId, createdAt: now(), updatedAt: now(),
    });
  }
  await db.insert(entityVersion).values({
    id: uid(), entityId, version: newVersion, dataJson: p.patchJson,
    authorType: p.authorType, authorId: p.authorId, reason: p.reason, createdAt: now(),
  });
  await db.update(proposal).set({ status: 'approved', decidedByType: 'human', decidedById: actor.id, decidedAt: now() }).where(eq(proposal.id, proposalId));
  await logEvent(db, actor, 'proposal_approved', 'proposal', proposalId, { entityId, version: newVersion });
  await closeInboxFor(db, 'proposal', proposalId, { action: 'approve' });
  return { kind: 'ok' as const };
}

interface ReviewBody {
  decision: 'approve' | 'request_changes';
  summary: string;
  comments?: { path: string; line?: number | undefined; body: string }[] | undefined;
}

// 人工审阅入口：实体提案走版本合并，代码提案走评审流转
export async function reviewProposal(actor: Actor, db: DB, proposalId: string, body: ReviewBody) {
  const p = (await db.select().from(proposal).where(eq(proposal.id, proposalId)))[0];
  if (!p) return { kind: 'not_found' as const, status: 404 as const, error: '提案不存在' };
  if (p.status !== 'pending' && p.status !== 'changes_requested') {
    return { kind: 'invalid' as const, status: 409 as const, error: `提案已是 ${p.status}，不能再审阅` };
  }
  if (p.targetType !== 'code') return decideProposal(actor, db, proposalId, body.decision === 'approve' ? 'approve' : 'reject', body.summary);

  const t = p.taskId ? (await db.select().from(task).where(eq(task.id, p.taskId)))[0] : undefined;
  if (!t) return { kind: 'invalid' as const, status: 409 as const, error: '提案没有关联任务' };
  // 验收跑完才进 reviewing；提前通过会让合并后的任务无法转 done
  if (t.status !== 'reviewing') return { kind: 'invalid' as const, status: 409 as const, error: '任务尚未进入评审，等验收跑完再审阅' };

  for (const c of body.comments ?? []) {
    await db.insert(reviewComment).values({ id: uid(), proposalId, authorType: actor.type, authorId: actor.id, path: c.path, line: c.line ?? null, body: c.body, resolved: 0, createdAt: now() });
  }
  const approved = body.decision === 'approve';
  await db
    .update(proposal)
    .set({ status: approved ? 'approved' : 'changes_requested', decidedByType: actor.type, decidedById: actor.id, decidedAt: now() })
    .where(eq(proposal.id, proposalId));
  await logEvent(db, actor, approved ? 'proposal_approved' : 'proposal_changes_requested', 'proposal', proposalId, { summary: body.summary });
  await afterReview({ db, actor, task: t, agent: { workstationId: t.workstationId } }, proposalId, body.decision);
  return { kind: 'ok' as const };
}

export async function mergeProposal(actor: Actor, db: DB, proposalId: string) {
  const p = (await db.select().from(proposal).where(eq(proposal.id, proposalId)))[0];
  if (!p) return { kind: 'not_found' as const, status: 404 as const, error: '提案不存在' };
  if (p.targetType !== 'code' || !p.taskId) return { kind: 'invalid' as const, status: 400 as const, error: '只有代码提案可以合并' };
  if (p.status !== 'approved') return { kind: 'invalid' as const, status: 409 as const, error: '提案通过后才能合并' };
  await closeInboxFor(db, 'proposal', proposalId, { action: 'merge' });
  await logEvent(db, actor, 'proposal_merge_queued', 'proposal', proposalId, {});
  enqueueMerge(db, actor, p.taskId);
  return { kind: 'ok' as const };
}
