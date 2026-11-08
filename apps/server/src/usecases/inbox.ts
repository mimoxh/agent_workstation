import type { Actor } from '@aw/domain';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { inboxItem, project, run, task } from '../db/schema.js';
import { events } from '../events.js';
import { condTransition } from '../runtime/dev_workflow.js';
import { triggerRun } from '../runtime/scheduler.js';
import { logEvent } from './core.js';
import { confirmGates } from './gates.js';
import { setStage, transitionTaskUc } from './tasks.js';
import { postThreadMessage, taskThreadOf } from './threads.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

export interface InboxAction {
  resolution?: string | undefined;
  decision?: 'approve' | 'deny' | undefined;
  action?: 'retry' | 'unblock' | undefined;
  answer?: string | undefined;
}

// 收件箱排序：先看会让事情停住的，再看等决定的
const SEVERITY: Record<string, string> = {
  budget: 'critical',
  blocked: 'high',
  command_confirm: 'high',
  run_failed: 'high',
  task_rejected: 'high',
  task_countered: 'normal',
  human_request: 'normal',
  gate_confirm: 'normal',
  proposal_review: 'normal',
};
const REPEAT_FAILURES = 3;

export async function pushInbox(db: DB, projectId: string, item: { kind: string; refType: string; refId: string; payload?: Record<string, unknown> }) {
  const p = (await db.select().from(project).where(eq(project.id, projectId)))[0];
  const id = uid();
  await db.insert(inboxItem).values({
    id, workspaceId: p?.workspaceId ?? 'default', projectId, kind: item.kind, refType: item.refType, refId: item.refId, severity: SEVERITY[item.kind] ?? 'normal', status: 'open',
    payloadJson: item.payload ? JSON.stringify(item.payload) : null, createdAt: now(),
  });
  events.emit('inbox_created', { kind: item.kind, refId: item.refId });
  return id;
}

// 同一 Agent 在同一件事上反复失败只留一条，连续 3 次升为最高优先级（ARCHITECTURE §6.2）
export async function pushRunFailure(db: DB, projectId: string, runId: string, key: string, payload: Record<string, unknown> = {}) {
  const open = await db.select().from(inboxItem).where(and(eq(inboxItem.kind, 'run_failed'), eq(inboxItem.status, 'open'), eq(inboxItem.projectId, projectId)));
  const same = open.find((i) => (JSON.parse(i.payloadJson ?? '{}') as { key?: string }).key === key);
  if (!same) return pushInbox(db, projectId, { kind: 'run_failed', refType: 'run', refId: runId, payload: { ...payload, key, count: 1 } });
  const count = ((JSON.parse(same.payloadJson ?? '{}') as { count?: number }).count ?? 1) + 1;
  await db
    .update(inboxItem)
    .set({ refId: runId, payloadJson: JSON.stringify({ ...payload, key, count }), severity: count >= REPEAT_FAILURES ? 'critical' : 'high' })
    .where(eq(inboxItem.id, same.id));
  events.emit('inbox_created', { kind: 'run_failed', refId: runId });
  return same.id;
}

// 同一引用下的待处理项一并关闭（任务解除阻塞 / 取消后，留着只会误导）
export async function closeInboxFor(db: DB, refType: string, refId: string, resolution: Record<string, unknown>) {
  await db
    .update(inboxItem)
    .set({ status: 'resolved', resolutionJson: JSON.stringify(resolution) })
    .where(and(eq(inboxItem.refType, refType), eq(inboxItem.refId, refId), eq(inboxItem.status, 'open')));
}

export async function resolveInbox(actor: Actor, db: DB, id: string, resolution?: string) {
  const changed = await db
    .update(inboxItem)
    .set({ status: 'resolved', resolutionJson: resolution ?? null })
    .where(and(eq(inboxItem.id, id), eq(inboxItem.status, 'open')));
  if (changed.changes === 0) return { kind: 'not_found' as const, status: 404 as const };
  await logEvent(db, actor, 'inbox_resolved', 'inbox_item', id, { resolution: resolution ?? null });
  return { kind: 'ok' as const };
}

const payloadOf = (json: string | null) => JSON.parse(json ?? '{}') as { agentId?: string };

async function retryRun(db: DB, runId: string | null) {
  const r = runId ? (await db.select().from(run).where(eq(run.id, runId)))[0] : undefined;
  if (!r?.agentId || !r.taskId) return { kind: 'error' as const, status: 400 as const, error: '运行记录不完整，无法重试' };
  const t = (await db.select().from(task).where(eq(task.id, r.taskId)))[0];
  // 这里直接解除而不走 transitionTaskUc：下面已经显式触发 run，不需要再发恢复事件
  if (t?.status === 'blocked') await condTransition(db, { type: 'human', id: 'local' }, t.id, 'unblock', { blockedReason: null });
  const res = await triggerRun(db, r.agentId, r.taskId, 'retry');
  return res.ok ? { kind: 'ok' as const, runId: res.runId } : { kind: 'error' as const, status: 409 as const, error: res.error ?? '重试失败' };
}

async function answerRequest(actor: Actor, db: DB, taskId: string, answer: string, askedBy: string | undefined) {
  const th = await taskThreadOf(db, taskId);
  if (!th) return { kind: 'error' as const, status: 404 as const, error: '任务不存在' };
  await postThreadMessage(actor, db, th.id, answer);
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  const agentId = askedBy ?? (t?.assigneeType === 'agent' ? t.assigneeId : null);
  if (agentId) await triggerRun(db, agentId, taskId, 'human_reply');
  return { kind: 'ok' as const };
}

export async function actOnInbox(actor: Actor, db: DB, id: string, body: InboxAction) {
  const item = (await db.select().from(inboxItem).where(eq(inboxItem.id, id)))[0];
  if (!item || item.status !== 'open') return { kind: 'not_found' as const, status: 404 as const, error: '条目不存在或已处理' };

  if (body.action === 'retry') {
    const r = await retryRun(db, item.refType === 'run' ? item.refId : null);
    if (r.kind !== 'ok') return r;
  }
  if (body.action === 'unblock' && item.refId) {
    const t = (await db.select().from(task).where(eq(task.id, item.refId)))[0];
    if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
    // 人的决定要进任务会话，Agent 恢复后才知道该按什么继续
    if (body.answer?.trim()) {
      const th = await taskThreadOf(db, t.id);
      if (th) await postThreadMessage(actor, db, th.id, body.answer.trim());
    }
    const r = await transitionTaskUc(actor, db, t.id, t.status === 'escalated' ? 'resolve' : 'unblock');
    if (r.kind !== 'ok') return r;
  }
  // 阶段门禁的人工检查项：确认后按 Agent 当初要去的阶段推进；不同意就把意见留给任务会话
  if (item.kind === 'gate_confirm' && item.refId && body.decision) {
    const p = JSON.parse(item.payloadJson ?? '{}') as { target?: string; gates?: { stage: string; index: number }[] };
    if (body.decision === 'approve') {
      await confirmGates(actor, db, item.refId, p.gates ?? []);
      if (p.target) {
        const r = await setStage(actor, db, item.refId, p.target);
        if (r.kind !== 'ok') return r;
      }
    } else {
      const th = await taskThreadOf(db, item.refId);
      if (th) await postThreadMessage(actor, db, th.id, `阶段检查未通过，先不推进${body.answer?.trim() ? `：${body.answer.trim()}` : ''}`);
    }
  }
  if (body.action !== 'unblock' && body.answer?.trim() && item.refId && item.kind !== 'gate_confirm') {
    if (item.refType === 'task') {
      const r = await answerRequest(actor, db, item.refId, body.answer.trim(), payloadOf(item.payloadJson).agentId);
      if (r.kind !== 'ok') return r;
    } else if (item.refType === 'thread') {
      await postThreadMessage(actor, db, item.refId, body.answer.trim());
    }
  }

  const resolved = await resolveInbox(actor, db, id, JSON.stringify({ resolution: body.resolution, decision: body.decision, action: body.action, answer: body.answer }));
  // unblock 已经连带关闭了本条
  if (resolved.kind !== 'ok' && body.action !== 'unblock') return { kind: 'not_found' as const, status: 404 as const, error: '条目不存在或已处理' };
  return { kind: 'ok' as const };
}
