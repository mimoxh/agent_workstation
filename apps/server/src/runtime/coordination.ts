import type { Actor } from '@aw/domain';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { task } from '../db/schema.js';
import { events } from '../events.js';
import { executingWs, stewardOf } from '../usecases/flow.js';
import { pushInbox } from '../usecases/inbox.js';
import { postHandoff } from '../usecases/threads.js';
import { condTransition } from './dev_workflow.js';
import type { AgentRow, TaskRow } from './types.js';

export interface BlockInfo {
  reason: string;
  missing?: string | undefined;
  tried?: string | undefined;
  decider?: 'steward' | 'human' | undefined;
}

const describeBlock = (b: BlockInfo) =>
  [b.reason, b.missing && `缺：${b.missing}`, b.tried && `试过：${b.tried}`].filter(Boolean).join('\n');

// I5：阻塞先交本台 steward；steward 不在、是本人上报，或明确要人决策时才直接升级
export async function reportBlocked(db: DB, actor: Actor, a: AgentRow, t: TaskRow, info: BlockInfo): Promise<{ error: string } | { status: string }> {
  const blockedReason = describeBlock(info);
  const to = await condTransition(db, actor, t.id, 'block', { blockedReason });
  if (!to) return { error: '任务当前状态不能上报阻塞' };
  const steward = await stewardOf(db, executingWs(t));
  const triage = steward && steward.id !== a.id && info.decider !== 'human' && events.listenerCount('task_block_triage') > 0;
  if (!triage) return { status: await escalateTask(db, actor, t.id, info.reason, info) };
  await postHandoff(db, t.id, `${a.name} 上报阻塞：${blockedReason}`, { from: a.name, to: steward.name, next: '分诊：本台解除或上送' });
  events.emit('task_block_triage', { taskId: t.id, stewardId: steward.id });
  return { status: 'blocked' };
}

// 超出本台决策权：转 escalated 并进人的收件箱，payload 保留结构化阻塞信息
export async function escalateTask(db: DB, actor: Actor, taskId: string, reason: string, info?: BlockInfo) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return 'missing';
  const to = (await condTransition(db, actor, taskId, 'escalate')) ?? t.status;
  await pushInbox(db, t.projectId, { kind: 'blocked', refType: 'task', refId: taskId, payload: { reason: t.blockedReason ?? reason, ...(info?.missing ? { missing: info.missing } : {}), ...(info?.tried ? { tried: info.tried } : {}), agentId: actor.id } });
  await postHandoff(db, taskId, `阻塞上送给你：${reason}`, { from: 'steward', to: '本地用户', next: '决策后恢复' });
  return to;
}
