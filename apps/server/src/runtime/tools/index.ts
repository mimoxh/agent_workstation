import { can, type Actor, type PermCtx } from '@aw/domain';
import { and, eq, inArray, like, or } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { entity, project, proposal, task, taskDependency, workstation } from '../../db/schema.js';
import { getProjectStatus } from '../../repositories/plan.js';
import { logEvent, manifestOf } from '../../usecases/core.js';
import { createEntity } from '../../usecases/entities.js';
import { pushInbox } from '../../usecases/inbox.js';
import { searchKnowledge } from '../../usecases/knowledge.js';
import { planTask, unmetDependencies } from '../../usecases/plan.js';
import { createTaskUc, dispatchTask, respondTask, setStage, transitionTaskUc } from '../../usecases/tasks.js';
import { postHandoff, postMessage, taskThreadOf } from '../../usecases/threads.js';
import { escalateTask, reportBlocked } from '../coordination.js';
import type { AgentRow, RunRow, TaskRow, ThreadRow } from '../types.js';
import { designTools } from './design.js';
import { devTools } from './dev.js';
import { qaTools } from './qa.js';

// 讨论线程里的 run 没有任务；依赖任务的工具统一由 executeTool 拦下
export interface RunCtx {
  db: DB;
  actor: Actor;
  permCtx: PermCtx;
  agent: AgentRow;
  task: TaskRow | null;
  thread?: ThreadRow | null | undefined;
  run: RunRow;
}

export type ToolCtx = RunCtx & { task: TaskRow };

export type Right = 'observe' | 'propose' | 'speak' | 'invoke' | 'always' | 'steward';

interface ToolBase {
  description: string;
  right: Right;
  parameters: z.ZodType;
  resultLimit?: number;
  largeOutput?: boolean;
}

export type ToolDef =
  | (ToolBase & { taskless?: false; execute: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<unknown> })
  | (ToolBase & { taskless: true; execute: (ctx: RunCtx, args: Record<string, unknown>) => Promise<unknown> });

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function guard(ctx: RunCtx, right: Right): string | null {
  if (right === 'always') return null;
  if (right === 'steward') {
    return ctx.agent.isSteward === 1 ? null : '仅 steward 可用';
  }
  const ok = can(ctx.actor, right, { type: 'workstation', id: ctx.agent.workstationId }, ctx.permCtx);
  return ok ? null : `无 ${right} 权`;
}

const threadOf = async (ctx: RunCtx) => ctx.thread ?? (ctx.task ? await taskThreadOf(ctx.db, ctx.task.id) : null);

const speaker = (ctx: RunCtx) => ({ type: 'agent', id: ctx.agent.id });

const tools: Record<string, ToolDef> = {
  read_entity: {
    taskless: true,
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
    taskless: true,
    description: '列出可见工作台的实体',
    right: 'observe',
    parameters: z.object({ entityType: z.string(), limit: z.number().optional() }),
    execute: async (ctx, a) => {
      const rows = await ctx.db.select().from(entity).where(eq(entity.entityType, String(a.entityType))).limit(Number(a.limit ?? 50));
      return rows.filter((e) => can(ctx.actor, 'observe', { type: 'workstation', id: e.workstationId }, ctx.permCtx));
    },
  },
  propose_entity: {
    taskless: true,
    description: '提交实体变更提案；插件把实体设为 direct 时直接写入并留版本',
    right: 'propose',
    parameters: z.object({ entityType: z.string(), entityId: z.string().optional(), data: z.record(z.string(), z.unknown()), reason: z.string().optional() }),
    execute: async (ctx, a) => {
      const wsId = ctx.agent.workstationId;
      const ws = (await ctx.db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
      const manifest = ws ? manifestOf(ws) : null;
      const def = manifest?.entities[String(a.entityType)];
      if (!def || !ws) return { error: `实体类型 ${String(a.entityType)} 不存在` };
      const data = a.data as Record<string, unknown>;
      for (const [fid, f] of Object.entries(def.fields)) {
        if (f.required && data[fid] === undefined) return { error: `缺少必填字段 ${fid}` };
      }
      const reason = a.reason as string | undefined;
      if (!a.entityId && (def.writeMode ?? manifest?.defaults?.writeMode) === 'direct') {
        const r = await createEntity(ctx.actor, ctx.db, wsId, { entityType: String(a.entityType), data, reason });
        return r.kind === 'ok' ? { entityId: r.id } : { error: r.error };
      }
      let baseVersion = 0;
      if (a.entityId) {
        const e = (await ctx.db.select().from(entity).where(eq(entity.id, String(a.entityId))))[0];
        if (!e) return { error: '目标实体不存在' };
        baseVersion = e.version;
      }
      const id = uid();
      await ctx.db.insert(proposal).values({
        id, taskId: ctx.task?.id ?? null, workstationId: wsId, targetType: String(a.entityType),
        entityId: (a.entityId as string | undefined) ?? null,
        baseVersion, patchJson: JSON.stringify(data), reason: reason ?? null,
        authorType: 'agent', authorId: ctx.agent.id, status: 'pending', createdAt: now(),
      });
      await logEvent(ctx.db, ctx.actor, 'proposal_created', 'proposal', id, { entityType: a.entityType });
      await pushInbox(ctx.db, ws.projectId, { kind: 'proposal_review', refType: 'proposal', refId: id });
      const th = await threadOf(ctx);
      if (th) await postMessage(ctx.db, th.id, speaker(ctx), `提交${def.label}提案${reason ? `：${reason}` : ''}`, 'proposal_notice', { proposalId: id });
      return { proposalId: id };
    },
  },
  search_workstation: {
    taskless: true,
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
    taskless: true,
    description: '在本台建任务：指派给 Agent 时作为子任务开工；不指派时留作草稿等人派发',
    right: 'invoke',
    parameters: z.object({ title: z.string(), intent: z.string().optional(), input: z.record(z.string(), z.unknown()).optional(), acceptance: z.array(z.unknown()).optional(), assigneeAgentId: z.string().optional(), typeId: z.string().optional(), stage: z.string().optional(), dependsOn: z.array(z.string()).optional(), dueAt: z.string().optional() }),
    execute: async (ctx, a) => {
      const r = await createTaskUc(ctx.actor, ctx.db, ctx.agent.workstationId, {
        title: String(a.title), intent: a.intent as string | undefined, input: a.input as Record<string, unknown> | undefined,
        acceptance: a.acceptance as unknown[] | undefined, typeId: a.typeId as string | undefined,
        parentId: ctx.task?.id, assigneeAgentId: a.assigneeAgentId as string | undefined, stage: a.stage as string | undefined,
        dependsOn: a.dependsOn as string[] | undefined, dueAt: a.dueAt as string | undefined,
      });
      if (r.kind !== 'ok') return { error: (r as { error?: string }).error };
      if (r.task!.pendingAssigneeId) {
        const unmet = await unmetDependencies(ctx.db, r.task!.id);
        return { taskId: r.task!.id, status: r.task!.status, waitingOn: unmet.map((u) => u.title) };
      }
      if (!a.assigneeAgentId) {
        const th = await threadOf(ctx);
        if (th) await postMessage(ctx.db, th.id, speaker(ctx), `起草了任务「${String(a.title)}」，等你确认派发`, 'status', { draftTaskId: r.task!.id });
      }
      return { taskId: r.task!.id, status: r.task!.status };
    },
  },
  list_tasks: {
    taskless: true,
    description: '列出本项目各工作台的任务，可按状态过滤',
    right: 'observe',
    parameters: z.object({ status: z.array(z.string()).optional(), limit: z.number().optional() }),
    execute: async (ctx, a) => {
      const ws = (await ctx.db.select().from(workstation).where(eq(workstation.id, ctx.agent.workstationId)))[0];
      if (!ws) return { error: '工作台不存在' };
      const rows = await ctx.db.select().from(task).where(eq(task.projectId, ws.projectId)).limit(Number(a.limit ?? 100));
      const filter = a.status as string[] | undefined;
      const wsName = new Map((await ctx.db.select().from(workstation).where(eq(workstation.projectId, ws.projectId))).map((w) => [w.id, w.name]));
      const depRows = rows.length > 0 ? await ctx.db.select().from(taskDependency).where(inArray(taskDependency.taskId, rows.map((t) => t.id))) : [];
      const depMap = depRows.reduce((m, d) => m.set(d.taskId, [...(m.get(d.taskId) ?? []), d.dependsOnId]), new Map<string, string[]>());
      return rows
        .filter((t) => !filter || filter.includes(t.status))
        .map((t) => ({ id: t.id, title: t.title, status: t.status, stage: t.stage, workstation: wsName.get(t.workstationId) ?? null, dueAt: t.dueAt, milestoneId: t.milestoneId, dependsOn: depMap.get(t.id) ?? [], blockedReason: t.blockedReason }));
    },
  },
  plan_task: {
    taskless: true,
    description: '给任务排期：开始/截止日期、里程碑、前置依赖（dependsOn 为整组替换）',
    right: 'invoke',
    parameters: z.object({ taskId: z.string(), startAt: z.string().optional(), dueAt: z.string().optional(), milestoneId: z.string().optional(), dependsOn: z.array(z.string()).optional() }),
    execute: async (ctx, a) => {
      const r = await planTask(ctx.actor, ctx.db, String(a.taskId), {
        startAt: a.startAt as string | undefined,
        dueAt: a.dueAt as string | undefined,
        milestoneId: a.milestoneId as string | undefined,
        dependsOn: a.dependsOn as string[] | undefined,
      });
      return r.kind === 'ok' ? { status: r.task!.status, startAt: r.task!.startAt, dueAt: r.task!.dueAt, milestoneId: r.task!.milestoneId } : { error: r.error };
    },
  },
  project_status: {
    taskless: true,
    description: '项目进展总览：任务统计、逾期、阻塞、依赖等待、里程碑、风险、各工作台状态',
    right: 'observe',
    parameters: z.object({}),
    execute: async (ctx) => {
      const ws = (await ctx.db.select().from(workstation).where(eq(workstation.id, ctx.agent.workstationId)))[0];
      if (!ws) return { error: '工作台不存在' };
      return (await getProjectStatus(ctx.actor, ctx.db, ws.projectId)) ?? { error: '项目不存在' };
    },
  },
  dispatch_task: {
    taskless: true,
    description: '把本台任务派发给子孙工作台（只在人明确要求派发时调用）',
    right: 'invoke',
    parameters: z.object({ taskId: z.string().optional(), targetWorkstationId: z.string(), typeId: z.string(), input: z.record(z.string(), z.unknown()), acceptance: z.array(z.record(z.string(), z.unknown())).optional(), reason: z.string().optional() }),
    execute: async (ctx, a) => {
      const taskId = (a.taskId as string | undefined) ?? ctx.task?.id;
      if (!taskId) return { error: '缺少 taskId' };
      const r = await dispatchTask(ctx.actor, ctx.db, taskId, {
        targetWorkstationId: String(a.targetWorkstationId), typeId: String(a.typeId), input: a.input as Record<string, unknown>,
        acceptance: a.acceptance as unknown[] | undefined, reason: a.reason as string | undefined,
      });
      return r.kind === 'ok' ? { status: r.task!.status } : { error: r.error };
    },
  },
  send_message: {
    taskless: true,
    description: '在当前会话发消息；需要别人回应时在内容里 @ 对方名字',
    right: 'speak',
    parameters: z.object({ content: z.string(), kind: z.enum(['chat', 'status']).optional() }),
    execute: async (ctx, a) => {
      const th = await threadOf(ctx);
      if (!th) return { error: '当前没有会话' };
      const m = await postMessage(ctx.db, th.id, speaker(ctx), String(a.content), (a.kind as string | undefined) ?? 'chat');
      return { messageId: m.id };
    },
  },
  record_decision: {
    taskless: true,
    description: '把讨论压缩成一张结论卡：结论、依据、遗留问题',
    right: 'speak',
    parameters: z.object({ summary: z.string(), openQuestions: z.string().optional() }),
    execute: async (ctx, a) => {
      const th = await threadOf(ctx);
      if (!th) return { error: '当前没有会话' };
      const m = await postMessage(ctx.db, th.id, speaker(ctx), String(a.summary), 'decision', { openQuestions: (a.openQuestions as string | undefined) ?? null });
      return { messageId: m.id };
    },
  },
  report_blocked: {
    description: '上报阻塞：说清缺什么、试过什么、需要谁决策，不要用猜测填充',
    right: 'always',
    parameters: z.object({ reason: z.string(), missing: z.string().optional(), tried: z.string().optional(), decider: z.enum(['steward', 'human']).optional() }),
    execute: async (ctx, a) =>
      reportBlocked(ctx.db, ctx.actor, ctx.agent, ctx.task, {
        reason: String(a.reason), missing: a.missing as string | undefined, tried: a.tried as string | undefined, decider: a.decider as 'steward' | 'human' | undefined,
      }),
  },
  resolve_block: {
    description: 'steward 在本台解除子任务阻塞，并告诉执行者怎么继续',
    right: 'steward',
    parameters: z.object({ note: z.string() }),
    execute: async (ctx, a) => {
      await postHandoff(ctx.db, ctx.task.id, `${ctx.agent.name} 解除阻塞：${String(a.note)}`, { from: ctx.agent.name, to: '执行者', next: '继续实现' });
      const r = await transitionTaskUc(ctx.actor, ctx.db, ctx.task.id, 'unblock');
      return r.kind === 'ok' ? { status: r.task?.status } : { error: r.error };
    },
  },
  escalate_block: {
    description: 'steward 把超出本台决策权的阻塞上送给人',
    right: 'steward',
    parameters: z.object({ reason: z.string() }),
    execute: async (ctx, a) => ({ status: await escalateTask(ctx.db, ctx.actor, ctx.task.id, String(a.reason)) }),
  },
  advance_stage: {
    description: 'steward 推进任务到下一阶段',
    right: 'steward',
    parameters: z.object({ stage: z.string() }),
    execute: async (ctx, a) => {
      const r = await setStage(ctx.actor, ctx.db, ctx.task.id, String(a.stage));
      return r.kind === 'ok' ? { stage: r.task?.stage } : { error: r.error };
    },
  },
  search_knowledge: {
    taskless: true,
    description: '检索知识库。结论用到检索结果时必须带上返回的 citation',
    right: 'observe',
    parameters: z.object({ query: z.string(), topK: z.number().optional() }),
    execute: async (ctx, a) => {
      const ws = (await ctx.db.select().from(workstation).where(eq(workstation.id, ctx.agent.workstationId)))[0];
      if (!ws) return { error: '工作台不存在' };
      const hits = await searchKnowledge(ctx.db, { projectId: ws.projectId, workstationId: ws.id }, String(a.query), Number(a.topK ?? 5));
      return { hits: hits.map((h) => ({ citation: h.citation, source: h.sourceName, anchor: h.anchor, text: h.text })) };
    },
  },
  request_human: {
    taskless: true,
    description: '请求人工决策',
    right: 'always',
    parameters: z.object({ question: z.string() }),
    execute: async (ctx, a) => {
      const th = await threadOf(ctx);
      const ws = (await ctx.db.select().from(workstation).where(eq(workstation.id, ctx.agent.workstationId)))[0];
      const projectId = ctx.task?.projectId ?? ws?.projectId;
      if (!projectId) return { error: '项目不存在' };
      const proj = (await ctx.db.select().from(project).where(eq(project.id, projectId)))[0];
      const ref = ctx.task ? { refType: 'task', refId: ctx.task.id } : { refType: 'thread', refId: th?.id ?? '' };
      const inboxId = await pushInbox(ctx.db, proj?.id ?? projectId, { kind: 'human_request', ...ref, payload: { question: String(a.question), agentId: ctx.agent.id } });
      if (th) await postMessage(ctx.db, th.id, speaker(ctx), `🙋 ${String(a.question)}`, 'status');
      return { inboxId };
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
  return { ...tools, ...devTools, ...designTools, ...qaTools };
}

export function toolSchemasFor(agentTools: string[]): { name: string; description: string; parameters: z.ZodType; largeOutput: boolean }[] {
  return agentTools.filter((n) => allTools()[n]).map((n) => ({ name: n, description: allTools()[n]!.description, parameters: allTools()[n]!.parameters, largeOutput: allTools()[n]!.largeOutput ?? false }));
}

export async function executeTool(ctx: RunCtx, name: string, args: Record<string, unknown>): Promise<unknown> {
  const def = allTools()[name];
  if (!def) return { error: `工具 ${name} 未实现` };
  const denied = guard(ctx, def.right);
  if (denied) return { error: denied };
  try {
    if (def.taskless) return await def.execute(ctx, args);
    if (!ctx.task) return { error: `工具 ${name} 只能在任务上下文里使用` };
    return await def.execute(ctx as ToolCtx, args);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
