import { and, eq } from 'drizzle-orm';
import type { Actor } from '@aw/domain';
import type { DB } from '../db/client.js';
import { entity, entityVersion, proposal } from '../db/schema.js';
import { logEvent } from './index.js';

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
    return { kind: 'ok' as const };
  }

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
    const t = p.taskId ? (await db.select().from((await import('../db/schema.js')).task).where(eq((await import('../db/schema.js')).task.id, p.taskId)))[0] : null;
    await db.insert(entity).values({
      id: entityId, workstationId: t?.workstationId ?? '', entityType: p.targetType ?? '',
      dataJson: p.patchJson, version: 1, createdByType: 'agent', createdById: p.authorId, createdAt: now(), updatedAt: now(),
    });
  }
  await db.insert(entityVersion).values({
    id: uid(), entityId, version: newVersion, dataJson: p.patchJson,
    authorType: p.authorType, authorId: p.authorId, reason: p.reason, createdAt: now(),
  });
  await db.update(proposal).set({ status: 'approved', decidedByType: 'human', decidedById: actor.id, decidedAt: now() }).where(eq(proposal.id, proposalId));
  await logEvent(db, actor, 'proposal_approved', 'proposal', proposalId, { entityId, version: newVersion });
  return { kind: 'ok' as const };
}

export { and };
