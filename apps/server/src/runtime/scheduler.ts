import PQueue from 'p-queue';
import { and, eq, like } from 'drizzle-orm';
import type { Actor, PermCtx } from '@aw/domain';
import type { DB } from '../db/client.js';
import { agent, message, run, task, thread, workstation } from '../db/schema.js';
import { events } from '../events.js';
import { buildPermCtx, manifestOf } from '../usecases/index.js';
import { buildContext } from './context.js';
import { runAgent } from './loop.js';
import { loadModels, resolveModel } from './models.js';
import type { ToolCtx } from './tools/index.js';
import type { AgentRow, TaskRow } from './types.js';

const queue = new PQueue({ concurrency: Number(process.env.AW_RUN_CONCURRENCY ?? 2) });
const inFlight = new Set<string>();
const queued = new Set<string>();

// 触发一次 run：装配上下文 → 插入 run 行 → 入队执行 loop
export async function triggerRun(db: DB, agentId: string, taskId: string, trigger: string): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const a = (await db.select().from(agent).where(eq(agent.id, agentId)))[0];
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!a || !t) return { ok: false, error: 'agent 或 task 不存在' };
  const key = `${agentId}:${taskId}`;
  if (queued.has(key) || inFlight.has(key)) return { ok: false, error: '该 (agent, task) 已在队列中' };
  queued.add(key);

  const runId = crypto.randomUUID();
  void queue.add(async () => {
    inFlight.add(key);
    try {
      await executeRun(db, runId, a, t, trigger);
    } finally {
      inFlight.delete(key);
      queued.delete(key);
    }
  });
  return { ok: true, runId };
}

async function executeRun(db: DB, runId: string, a: AgentRow, t: TaskRow, trigger: string) {
  await loadModels();
  const ws = (await db.select().from(workstation).where(eq(workstation.id, a.workstationId)))[0];
  const manifest = ws ? manifestOf(ws) : null;
  const tpl = manifest?.agents.find((x) => x.id === a.templateId);
  const route = resolveModel(a.modelJson, tpl?.model);
  const providerName = route?.id.split(':')[0] ?? 'none';
  const modelName = route?.id.split(':').slice(1).join(':') ?? 'none';

  // agent 指派的任务：run 开始时平台代为 accept + start（状态机 + 条件更新）
  const { transition } = await import('@aw/domain');
  let fresh = t;
  if (trigger === 'task_assigned' && t.assigneeType === 'agent') {
    for (const ev of ['accept', 'start'] as const) {
      const cur = (await db.select().from(task).where(eq(task.id, t.id)))[0];
      if (!cur) break;
      const r = transition(cur.status as never, ev);
      if (!r.ok) break;
      const changed = await db.update(task).set({ status: r.to }).where(and(eq(task.id, t.id), eq(task.status, cur.status)));
      if (changed.changes === 0) break;
      fresh = (await db.select().from(task).where(eq(task.id, t.id)))[0] ?? cur;
      const { logEvent } = await import('../usecases/index.js');
      await logEvent(db, { type: 'agent', id: a.id }, 'task_status_changed', 'task', t.id, { to: r.to, auto: true });
    }
  }

  await db.insert(run).values({
    id: runId, agentId: a.id, taskId: t.id, status: 'running',
      provider: providerName, model: modelName, startedAt: new Date().toISOString(), trigger,
    tokensIn: 0, tokensOut: 0, traceJson: '[]',
  });
  const runRow = (await db.select().from(run).where(eq(run.id, runId)))[0]!;

  if (!route) {
    await db.update(run).set({ status: 'error', stopReason: 'error', endedAt: new Date().toISOString(), error: '没有可用的模型 provider' }).where(eq(run.id, runId));
    return;
  }

  const actor: Actor = { type: 'agent', id: a.id };
  const permCtx: PermCtx = await buildPermCtx(actor, db);
  const ctx: ToolCtx = { db, actor, permCtx, agent: a, task: fresh, run: runRow };

  const agents = await db.select().from(agent).where(eq(agent.workstationId, a.workstationId));
  const parent = t.parentId ? (await db.select().from(task).where(eq(task.id, t.parentId)))[0] : null;
  const siblings = t.parentId ? await db.select().from(task).where(and(eq(task.parentId, t.parentId), eq(task.workstationId, a.workstationId))) : [];
  const threadRow = (await db.select().from(thread).where(and(eq(thread.kind, 'task'), eq(thread.scopeId, t.id))))[0];
  const msgs = threadRow
    ? (await db.select().from(message).where(eq(message.threadId, threadRow.id))).slice(-20)
    : [];

  const { system, messages } = buildContext({
    pluginDescription: manifest?.description ?? '',
    agentName: a.name, agentRole: a.role, isSteward: a.isSteward === 1,
    stage: t.stage, templateId: a.templateId,
    agents: agents.map((x) => ({ id: x.id, name: x.name, templateId: x.templateId })),
    task: { title: t.title, intent: t.intent, inputJson: t.inputJson, acceptanceJson: t.acceptanceJson, typeId: t.typeId },
    parentTask: parent ? { title: parent.title, status: parent.status, intent: parent.intent } : null,
    siblingTasks: siblings.filter((s) => s.id !== t.id).map((s) => ({ title: s.title, status: s.status })),
    threadMessages: msgs.map((m) => ({ senderId: m.senderId, senderType: m.senderType, content: m.content, kind: m.kind })),
  });
  void trigger;

  await runAgent({
    db, ctx, route, system,
    messages: messages.map((m) => ({ role: 'user' as const, content: m.content })),
    agentRow: a, taskRow: fresh,
    pluginDefaultTokens: manifest?.defaults?.taskBudget?.tokens,
    pluginDefaultMinutes: manifest?.defaults?.taskBudget?.minutes,
  });
}

// 订阅事件总线；AW_AUTORUN=0 时不订阅
export function startScheduler(db: DB) {
  if (process.env.AW_AUTORUN === '0') return;

  events.on('task_assigned', async (p) => {
    const taskId = p.targetId as string;
    if (p.assigneeType === 'agent' && typeof p.assigneeId === 'string') {
      await triggerRun(db, p.assigneeId, taskId, 'task_assigned');
      return;
    }
    if (p.assigneeType === 'workstation' && typeof p.assigneeId === 'string') {
      const ws = (await db.select().from(workstation).where(eq(workstation.id, p.assigneeId)))[0];
      const manifest = ws ? manifestOf(ws) : null;
      const stewardTpl = manifest?.steward;
      const tpl = manifest?.agents.find((x) => x.id === stewardTpl);
      if (!tpl?.triggers?.includes('task_assigned')) return;
      const steward = (await db.select().from(agent).where(and(eq(agent.workstationId, p.assigneeId), eq(agent.isSteward, 1))))[0];
      if (steward) await triggerRun(db, steward.id, taskId, 'task_assigned');
    }
  });

  // @提及：人发的线程消息含 @Agent名 → 触发
  events.on('message_created', async (p) => {
    if (p.senderType !== 'human') return;
    const content = String(p.content ?? '');
    const th = (await db.select().from(thread).where(eq(thread.id, String(p.threadId))))[0];
    if (!th) return;
    const taskId = th.scopeType === 'task' ? th.scopeId : null;
    if (!taskId) return;
    const agents = await db.select().from(agent);
    for (const a of agents) {
      if (!content.includes(`@${a.name}`)) continue;
      const ws = (await db.select().from(workstation).where(eq(workstation.id, a.workstationId)))[0];
      const tpl = ws ? manifestOf(ws)?.agents.find((x) => x.id === a.templateId) : null;
      if (tpl?.triggers?.includes('mentioned')) await triggerRun(db, a.id, taskId, 'mentioned');
    }
  });
}

export const scheduler = {
  idle: () => queue.onIdle(),
  trigger: (db: DB, agentId: string, taskId: string, trigger: string) => triggerRun(db, agentId, taskId, trigger),
};

export { like };
