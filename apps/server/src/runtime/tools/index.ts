import { can, type Actor, type PermCtx } from '@aw/domain';
import { and, eq, like, or } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { entity, inboxItem, project, task, thread, threadMember, message } from '../../db/schema.js';
import { devTools } from './dev.js';
import { createTaskUc, logEvent, respondTask } from '../../usecases/index.js';
import { manifestOf } from '../../usecases/index.js';
import type { AgentRow, TaskRow, RunRow } from '../types.js';

export interface ToolCtx {
  db: DB;
  actor: Actor;
  permCtx: PermCtx;
  agent: AgentRow;
  task: TaskRow;
  run: RunRow;
}

export type Right = 'observe' | 'propose' | 'speak' | 'invoke' | 'always' | 'steward';

export interface ToolDef {
  description: string;
  right: Right;
  parameters: z.ZodType;
  execute: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<unknown>;
}

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function guard(ctx: ToolCtx, right: Right): string | null {
  if (right === 'always') return null;
  if (right === 'steward') {
    return ctx.agent.isSteward === 1 ? null : '仅 steward 可用';
  }
  const ok = can(ctx.actor, right, { type: 'workstation', id: ctx.agent.workstationId }, ctx.permCtx);
  return ok ? null : `无 ${right} 权`;
}

// 任务线程懒创建
export async function taskThread(db: DB, t: TaskRow) {
  const rows = await db.select().from(thread).where(and(eq(thread.kind, 'task'), eq(thread.scopeId, t.id)));
  if (rows[0]) return rows[0];
  const id = uid();
  await db.insert(thread).values({ id, scopeType: 'task', scopeId: t.id, kind: 'task', mode: 'relay', title: t.title, createdAt: now() });
  await db.insert(threadMember).values([
    { threadId: id, participantType: 'human', participantId: 'local' },
    ...(t.assigneeId ? [{ threadId: id, participantType: t.assigneeType ?? 'agent', participantId: t.assigneeId }] : []),
  ]);
  const r = await db.select().from(thread).where(eq(thread.id, id));
  return r[0]!;
}

async function postMessage(db: DB, threadId: string, sender: { type: string; id: string }, content: string, kind = 'chat') {
  const m = { id: uid(), threadId, senderType: sender.type, senderId: sender.id, kind, content, createdAt: now() };
  await db.insert(message).values(m);
  const { events } = await import('../../events.js');
  events.emit('message_created', m as unknown as Record<string, unknown>);
  return m;
}

const tools: Record<string, ToolDef> = {
  read_entity: {
    description: '读取可见工作台的实体',
    right: 'observe',
    parameters: z.object({ id: z.string() }),
    execute: async (ctx, a) => {
      const rows = await ctx.db.select().from(entity).where(eq(entity.id, String(a.id)));
      const e = rows[0];
      if (!e) return { error: '实体不存在' };
      const ok = can(ctx.actor, 'observe', { type: 'workstation', id: e.workstationId }, ctx.permCtx);
      return ok ? e : { error: '无 observe 权' };
    },
  },
  list_entities: {
    description: '列出可见工作台的实体',
    right: 'observe',
    parameters: z.object({ entityType: z.string(), limit: z.number().optional() }),
    execute: async (ctx, a) => {
      const rows = await ctx.db.select().from(entity).where(eq(entity.entityType, String(a.entityType))).limit(Number(a.limit ?? 50));
      return rows.filter((e) => can(ctx.actor, 'observe', { type: 'workstation', id: e.workstationId }, ctx.permCtx));
    },
  },
  propose_entity: {
    description: '提交实体变更提案',
    right: 'propose',
    parameters: z.object({ entityType: z.string(), entityId: z.string().optional(), data: z.record(z.string(), z.unknown()), reason: z.string().optional() }),
    execute: async (ctx, a) => {
      const ws = (await ctx.db.select().from((await import('../../db/schema.js')).workstation).where(eq((await import('../../db/schema.js')).workstation.id, ctx.agent.workstationId)))[0];
      const manifest = ws ? manifestOf(ws) : null;
      const def = manifest?.entities[String(a.entityType)];
      if (!def) return { error: `实体类型 ${String(a.entityType)} 不存在` };
      for (const [fid, f] of Object.entries(def.fields)) {
        const d = a.data as Record<string, unknown>;
        if (f.required && d[fid] === undefined) return { error: `缺少必填字段 ${fid}` };
      }
      let baseVersion = 0;
      if (a.entityId) {
        const e = (await ctx.db.select().from(entity).where(eq(entity.id, String(a.entityId))))[0];
        if (!e) return { error: '目标实体不存在' };
        baseVersion = e.version;
      }
      const { proposal } = await import('../../db/schema.js');
      const id = uid();
      await ctx.db.insert(proposal).values({
        id, taskId: ctx.task.id, targetType: 'entity',
        entityId: (a.entityId as string | undefined) ?? null,
        baseVersion, patchJson: JSON.stringify(a.data), reason: (a.reason as string | undefined) ?? null,
        authorType: 'agent', authorId: ctx.agent.id, status: 'pending', createdAt: now(),
      });
      await logEvent(ctx.db, ctx.actor, 'proposal_created', 'proposal', id, { entityType: a.entityType });
      return { proposalId: id };
    },
  },
  search_workstation: {
    description: '在本台任务与实体中搜索',
    right: 'observe',
    parameters: z.object({ query: z.string() }),
    execute: async (ctx, a) => {
      const q = `%${String(a.query)}%`;
      const tasks = await ctx.db.select().from(task).where(and(eq(task.workstationId, ctx.agent.workstationId), or(like(task.title, q), like(task.intent, q)))).limit(10);
      const entities = await ctx.db.select().from(entity).where(and(eq(entity.workstationId, ctx.agent.workstationId), like(entity.dataJson, q))).limit(10);
      return { tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })), entities: entities.map((e) => ({ id: e.id, type: e.entityType })) };
    },
  },
  create_task: {
    description: '在本台建子任务并指派给 Agent',
    right: 'invoke',
    parameters: z.object({ title: z.string(), intent: z.string().optional(), input: z.record(z.string(), z.unknown()).optional(), acceptance: z.array(z.unknown()).optional(), assigneeAgentId: z.string(), typeId: z.string().optional(), stage: z.string().optional() }),
    execute: async (ctx, a) => {
      const r = await createTaskUc(ctx.actor, ctx.db, ctx.agent.workstationId, {
        title: String(a.title), intent: a.intent as string | undefined, input: a.input as Record<string, unknown> | undefined,
        acceptance: a.acceptance as unknown[] | undefined, typeId: a.typeId as string | undefined,
        parentId: ctx.task.id, assigneeAgentId: String(a.assigneeAgentId), stage: a.stage as string | undefined,
      });
      return r.kind === 'ok' ? { taskId: r.task!.id, status: r.task!.status } : { error: (r as { error?: string }).error };
    },
  },
  send_message: {
    description: '在当前任务线程发消息',
    right: 'speak',
    parameters: z.object({ content: z.string(), kind: z.string().optional() }),
    execute: async (ctx, a) => {
      const th = await taskThread(ctx.db, ctx.task);
      const m = await postMessage(ctx.db, th.id, { type: 'agent', id: ctx.agent.id }, String(a.content), (a.kind as string | undefined) ?? 'chat');
      return { messageId: m.id };
    },
  },
  report_blocked: {
    description: '上报阻塞',
    right: 'always',
    parameters: z.object({ reason: z.string() }),
    execute: async (ctx, a) => {
      const { transition } = await import('@aw/domain');
      const r = transition(ctx.task.status as never, 'block');
      if (!r.ok) return { error: r.error };
      const changed = await ctx.db.update(task).set({ status: r.to, blockedReason: String(a.reason) }).where(and(eq(task.id, ctx.task.id), eq(task.status, ctx.task.status)));
      if (changed.changes === 0) return { error: '任务状态已变化' };
      await ctx.db.insert(inboxItem).values({ id: uid(), workspaceId: 'default', projectId: ctx.task.projectId, kind: 'blocked', refType: 'task', refId: ctx.task.id, status: 'open', createdAt: now() });
      await logEvent(ctx.db, ctx.actor, 'task_status_changed', 'task', ctx.task.id, { to: r.to });
      return { ok: true };
    },
  },
  request_human: {
    description: '请求人工决策',
    right: 'always',
    parameters: z.object({ question: z.string() }),
    execute: async (ctx, a) => {
      const p = await ctx.db.select().from(project).where(eq(project.id, ctx.task.projectId));
      const iid = uid();
      await ctx.db.insert(inboxItem).values({ id: iid, workspaceId: p[0]?.workspaceId ?? 'default', projectId: ctx.task.projectId, kind: 'human_request', refType: 'task', refId: ctx.task.id, status: 'open', createdAt: now() });
      const th = await taskThread(ctx.db, ctx.task);
      await postMessage(ctx.db, th.id, { type: 'agent', id: ctx.agent.id }, `🙋 ${String(a.question)}`, 'status');
      return { inboxId: iid };
    },
  },
  respond_task: {
    description: 'steward 对派发到本台的任务接单/拒绝/反提案',
    right: 'steward',
    parameters: z.object({ action: z.enum(['accept', 'reject', 'counter']), reason: z.string().optional(), counter: z.record(z.string(), z.unknown()).optional() }),
    execute: async (ctx, a) => {
      const r = await respondTask(ctx.actor, ctx.db, ctx.task.id, {
        action: a.action as 'accept' | 'reject' | 'counter',
        reason: a.reason as string | undefined,
        counter: a.counter as { input?: Record<string, unknown> | undefined; acceptance?: unknown[] | undefined } | undefined,
      });
      return r.kind === 'ok' ? { status: r.task!.status } : { error: (r as { error?: string }).error };
    },
  },
};

export function allTools(): Record<string, ToolDef> {
  return { ...tools, ...devTools };
}

export function toolSchemasFor(agentTools: string[]): { name: string; description: string; parameters: z.ZodType }[] {
  return agentTools.filter((n) => allTools()[n]).map((n) => ({ name: n, description: allTools()[n]!.description, parameters: allTools()[n]!.parameters }));
}

export async function executeTool(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<unknown> {
  const def = allTools()[name];
  if (!def) return { error: `工具 ${name} 未实现` };
  const denied = guard(ctx, def.right);
  if (denied) return { error: denied };
  try {
    return await def.execute(ctx, args);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
