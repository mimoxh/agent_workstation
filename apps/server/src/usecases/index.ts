import type { Actor, PermCtx, TaskEvent } from '@aw/domain';
import { can, descendantIds, transition } from '@aw/domain';
import { validateInput, type AgentTemplateDef, type WorkbenchManifest } from '@aw/plugin-spec';
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { events } from '../events.js';
import { pluginRegistry } from '../plugins.js';
import {
  accessGrant,
  agent,
  block,
  eventLog,
  inboxItem,
  project,
  task,
  workstation,
} from '../db/schema.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

export async function logEvent(
  db: DB,
  actor: Actor,
  action: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown> = {},
) {
  await db.insert(eventLog).values({
    id: uid(),
    actorType: actor.type,
    actorId: actor.id,
    action,
    targetType,
    targetId,
    payloadJson: JSON.stringify(payload),
    createdAt: now(),
  });
  events.emit(action, { targetType, targetId, ...payload });
}

// 构建 can() 的 ctx（纯对象，无外部引用）
export async function buildPermCtx(actor: Actor, db: DB): Promise<PermCtx> {
  const workstations = await db
    .select({ id: workstation.id, parentId: workstation.parentId })
    .from(workstation);
  const grants = await db.select().from(accessGrant);
  let agentRow: PermCtx['agent'];
  if (actor.type === 'agent') {
    const rows = await db.select().from(agent).where(eq(agent.id, actor.id));
    const a = rows[0];
    if (a) {
      agentRow = { id: a.id, workstationId: a.workstationId, isSteward: a.isSteward === 1 };
    }
  }
  return {
    workstations,
    agent: agentRow,
    grants: grants.map((g) => ({
      subjectType: g.subjectType as 'human' | 'agent',
      subjectId: g.subjectId,
      scopeType: g.scopeType as 'workstation' | 'project',
      scopeId: g.scopeId,
      rights: JSON.parse(g.rightsJson ?? '[]') as string[],
    })),
  };
}

export function manifestOf(ws: { pluginId: string | null }): WorkbenchManifest | null {
  return ws.pluginId ? (pluginRegistry.get(ws.pluginId) ?? null) : null;
}

// 合并类型默认 acceptance（按 JSON 序列化去重）
export function mergeAcceptance(existing: unknown[] | string | null, defaults: unknown[]): unknown[] {
  const base = typeof existing === 'string' ? (JSON.parse(existing || '[]') as unknown[]) : (existing ?? []);
  const merged = [...base];
  for (const d of defaults) {
    if (!merged.some((x) => JSON.stringify(x) === JSON.stringify(d))) merged.push(d);
  }
  return merged;
}

export async function mountWorkstation(
  actor: Actor,
  db: DB,
  input: { projectId: string; parentId: string | null; pluginId: string; name: string; settings?: Record<string, unknown> },
) {
  const manifest = pluginRegistry.get(input.pluginId);
  if (!manifest) return { kind: 'error' as const, error: `插件 ${input.pluginId} 未装载` };
  const wsId = uid();
  await db.insert(workstation).values({
    id: wsId,
    projectId: input.projectId,
    parentId: input.parentId,
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    name: input.name,
    status: 'active',
    settingsJson: input.settings ? JSON.stringify(input.settings) : null,
    createdAt: now(),
  });
  for (const [i, p] of manifest.panels.entries()) {
    await db.insert(block).values({
      id: uid(),
      workstationId: wsId,
      panelId: p.id,
      panelType: p.type,
      entityType: p.entity,
      name: p.title,
      configJson: p.config ? JSON.stringify(p.config) : null,
      sort: i,
      createdAt: now(),
    });
  }
  for (const tpl of manifest.agents) {
    await insertAgent(db, wsId, tpl.id, tpl.name, tpl, manifest);
  }
  await logEvent(db, actor, 'workstation_mounted', 'workstation', wsId, { pluginId: manifest.id });
  return { kind: 'ok' as const, id: wsId };
}

async function insertAgent(db: DB, wsId: string, templateId: string, name: string, tpl: AgentTemplateDef, manifest?: WorkbenchManifest) {
  await db.insert(agent).values({
    id: uid(),
    workstationId: wsId,
    templateId,
    name,
    role: tpl.role,
    modelJson: tpl.model ? JSON.stringify(tpl.model) : null,
    prompt: tpl.promptFile ?? null,
    toolsJson: JSON.stringify(tpl.tools),
    budgetJson: tpl.budget ? JSON.stringify(tpl.budget) : null,
    isSteward: manifest?.steward === templateId ? 1 : 0,
    status: 'active',
    createdAt: now(),
  });
}

export async function addAgentInstance(actor: Actor, db: DB, wsId: string, templateId: string) {
  const wsRows = await db.select().from(workstation).where(eq(workstation.id, wsId));
  const ws = wsRows[0];
  if (!ws) return { kind: 'not_found' as const };
  const manifest = manifestOf(ws);
  const tpl = manifest?.agents.find((a) => a.id === templateId);
  if (!manifest || !tpl) return { kind: 'error' as const, error: `模板 ${templateId} 不存在` };
  const siblings = await db.select().from(agent).where(and(eq(agent.workstationId, wsId), eq(agent.templateId, templateId)));
  const name = siblings.length === 0 ? tpl.name : `${tpl.name} #${siblings.length + 1}`;
  await insertAgent(db, wsId, templateId, name, tpl, manifest);
  await logEvent(db, actor, 'agent_created', 'workstation', wsId, { templateId, name });
  return { kind: 'ok' as const };
}

export async function createTaskUc(
  actor: Actor,
  db: DB,
  wsId: string,
  input: { title: string; intent?: string | undefined; typeId?: string | undefined; input?: Record<string, unknown> | undefined; acceptance?: unknown[] | undefined; parentId?: string | undefined; assigneeAgentId?: string | undefined; stage?: string | undefined },
) {
  const wsRows = await db.select().from(workstation).where(eq(workstation.id, wsId));
  const ws = wsRows[0];
  if (!ws) return { kind: 'not_found' as const, status: 404 as const, error: '工作台不存在' };

  const manifest = manifestOf(ws);
  const taskTypes = manifest?.tasks ?? [];
  // typeId 推断：插件无任务类型 → null；缺省且只有一个 → 用它；多个 → 必须显式给
  let taskType = undefined as (typeof taskTypes)[number] | undefined;
  let typeId: string | null = null;
  if (taskTypes.length > 0) {
    if (input.typeId === undefined) {
      if (taskTypes.length === 1) {
        taskType = taskTypes[0];
      } else {
        return { kind: 'error' as const, status: 400 as const, error: '插件声明了多个任务类型，必须显式指定 typeId' };
      }
    } else {
      taskType = taskTypes.find((x) => x.id === input.typeId);
      if (!taskType) {
        return { kind: 'error' as const, status: 400 as const, error: `任务类型 ${input.typeId} 不属于该插件` };
      }
    }
    typeId = taskType!.id;
  }

  // 有类型时 title 并入 input 并按 inputSchema 校验；合并类型默认 acceptance
  let taskInput = input.input ?? null;
  let acceptance = (input.acceptance ?? null) as unknown[] | null;
  if (taskType) {
    const merged = { title: input.title, ...(taskInput ?? {}) };
    const errs = validateInput(taskType.inputSchema, merged);
    if (errs.length > 0) return { kind: 'error' as const, status: 400 as const, error: errs.join('；') };
    taskInput = merged;
    acceptance = mergeAcceptance(acceptance, taskType.acceptance ?? []);
  }

  // 子任务语义：assigneeAgentId 时平台代派发 draft→dispatched
  let status = 'draft';
  if (input.assigneeAgentId) {
    const agents = await db.select().from(agent).where(eq(agent.id, input.assigneeAgentId));
    const a = agents[0];
    if (!a || a.workstationId !== wsId) {
      return { kind: 'error' as const, status: 400 as const, error: 'assignee Agent 不属于此工作台' };
    }
    const ctx = await buildPermCtx(actor, db);
    if (actor.type === 'agent' && !can(actor, 'invoke', { type: 'workstation', id: wsId }, ctx)) {
      return { kind: 'error' as const, status: 403 as const, error: '无 invoke 权' };
    }
    const r = transition('draft', 'dispatch');
    if (!r.ok) return { kind: 'error' as const, status: 500 as const, error: r.error };
    status = r.to;
  }
  if (input.parentId) {
    const parents = await db.select().from(task).where(eq(task.id, input.parentId));
    const p = parents[0];
    if (!p) return { kind: 'error' as const, status: 400 as const, error: '父任务不存在' };
    const inThisWs = p.workstationId === wsId;
    const assignedHere = p.assigneeType === 'workstation' && p.assigneeId === wsId;
    if (!inThisWs && !assignedHere) {
      return { kind: 'error' as const, status: 400 as const, error: '父任务须位于本台或已派发到本台' };
    }
  }

  // stage：显式给出须属于该任务类型 stages；缺省取第一个 stage
  let stage: string | null = null;
  const stageIds = taskType?.stages ?? manifest?.stages?.map((s) => s.id) ?? [];
  if (input.stage !== undefined) {
    if (!stageIds.includes(input.stage)) return { kind: 'error' as const, status: 400 as const, error: `stage ${input.stage} 不属于该任务类型` };
    stage = input.stage;
  } else if (stageIds.length > 0) {
    stage = stageIds[0]!;
  }

  const id = uid();
  await db.insert(task).values({
    id,
    projectId: ws.projectId,
    workstationId: wsId,
    parentId: input.parentId ?? null,
    typeId,
    title: input.title,
    intent: input.intent ?? null,
    inputJson: taskInput ? JSON.stringify(taskInput) : null,
    acceptanceJson: acceptance ? JSON.stringify(acceptance) : null,
    status,
    stage,
    assigneeType: input.assigneeAgentId ? 'agent' : null,
    assigneeId: input.assigneeAgentId ?? null,
    createdAt: now(),
  });
  await logEvent(db, actor, 'task_created', 'task', id, { workstationId: wsId });
  if (input.assigneeAgentId) {
    await logEvent(db, actor, 'task_assigned', 'task', id, {
      assigneeType: 'agent',
      assigneeId: input.assigneeAgentId,
    });
    // 父任务在首个子任务创建时自动 start（走状态机 + 条件更新）
    if (input.parentId) {
      const parents = await db.select().from(task).where(eq(task.id, input.parentId));
      const parent = parents[0];
      if (parent) {
        const pr = transition(parent.status as never, 'start');
        if (pr.ok) {
          const changed = await db
            .update(task)
            .set({ status: pr.to })
            .where(and(eq(task.id, parent.id), eq(task.status, parent.status)));
          if (changed.changes > 0) {
            await logEvent(db, actor, 'task_status_changed', 'task', parent.id, { to: pr.to });
          }
        }
      }
    }
  }
  const rows = await db.select().from(task).where(eq(task.id, id));
  return { kind: 'ok' as const, task: rows[0] };
}

export async function dispatchTask(
  actor: Actor,
  db: DB,
  taskId: string,
  body: { targetWorkstationId: string; typeId: string; input: Record<string, unknown>; reason?: string | undefined },
) {
  const rows = await db.select().from(task).where(eq(task.id, taskId));
  const t = rows[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  const ctx = await buildPermCtx(actor, db);
  const descendants = descendantIds(ctx, t.workstationId);
  if (!descendants.includes(body.targetWorkstationId)) {
    return { kind: 'error' as const, status: 400 as const, error: '目标工作台必须是任务所在台的子孙' };
  }
  if (
    actor.type === 'agent' &&
    !can(actor, 'invoke', { type: 'workstation', id: body.targetWorkstationId }, ctx)
  ) {
    return { kind: 'error' as const, status: 403 as const, error: '无 invoke 权' };
  }
  const wsRows = await db.select().from(workstation).where(eq(workstation.id, body.targetWorkstationId));
  const target = wsRows[0];
  const manifest = target ? manifestOf(target) : null;
  const taskType = manifest?.tasks.find((x) => x.id === body.typeId);
  if (!manifest || !taskType) {
    return { kind: 'error' as const, status: 400 as const, error: `任务类型 ${body.typeId} 不存在于目标插件` };
  }
  const errs = validateInput(taskType.inputSchema, body.input);
  if (errs.length > 0) return { kind: 'error' as const, status: 400 as const, error: errs.join('；') };

  const merged = mergeAcceptance(t.acceptanceJson, taskType.acceptance ?? []);

  const r = transition(t.status as never, 'dispatch');
  if (!r.ok) return { kind: 'invalid' as const, status: 409 as const, error: r.error };
  const changed = await db
    .update(task)
    .set({
      status: 'dispatched',
      typeId: body.typeId,
      inputJson: JSON.stringify(body.input),
      acceptanceJson: JSON.stringify(merged),
      assigneeType: 'workstation',
      assigneeId: body.targetWorkstationId,
      dispatchReason: body.reason ?? null,
    })
    .where(and(eq(task.id, taskId), eq(task.status, t.status)));
  if (changed.changes === 0) {
    return { kind: 'conflict' as const, status: 409 as const, error: '任务状态已变化，请刷新后重试' };
  }
  await logEvent(db, actor, 'task_status_changed', 'task', taskId, { to: 'dispatched' });
  await logEvent(db, actor, 'task_assigned', 'task', taskId, {
    assigneeType: 'workstation',
    assigneeId: body.targetWorkstationId,
    typeId: body.typeId,
  });
  const updated = await db.select().from(task).where(eq(task.id, taskId));
  return { kind: 'ok' as const, task: updated[0] };
}

export async function respondTask(
  actor: Actor,
  db: DB,
  taskId: string,
  body: { action: 'accept' | 'reject' | 'counter'; reason?: string | undefined; counter?: { input?: Record<string, unknown> | undefined; acceptance?: unknown[] | undefined } | undefined },
) {
  const rows = await db.select().from(task).where(eq(task.id, taskId));
  const t = rows[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  // 只有派发给工作台的单子才可响应
  if (t.assigneeType !== 'workstation' || !t.assigneeId) {
    return { kind: 'error' as const, status: 400 as const, error: '该任务不是派发到工作台的单子' };
  }
  if (actor.type === 'agent') {
    const steward = await db
      .select()
      .from(agent)
      .where(and(eq(agent.id, actor.id), eq(agent.workstationId, t.assigneeId), eq(agent.isSteward, 1)));
    if (steward.length === 0) {
      return { kind: 'error' as const, status: 403 as const, error: '只有目标台的 steward 可以响应' };
    }
  }
  const event: TaskEvent = body.action === 'accept' ? 'accept' : body.action === 'reject' ? 'reject' : 'counter';
  const r = transition(t.status as never, event);
  if (!r.ok) return { kind: 'invalid' as const, status: 409 as const, error: r.error };
  const patch: Record<string, unknown> = { status: r.to };
  if (body.action !== 'accept' || body.reason) {
    patch.resultJson = JSON.stringify({
      reason: body.reason ?? null,
      ...(body.action === 'counter' ? { counter: body.counter ?? {} } : {}),
    });
  }
  const changed = await db.update(task).set(patch).where(and(eq(task.id, taskId), eq(task.status, t.status)));
  if (changed.changes === 0) {
    return { kind: 'conflict' as const, status: 409 as const, error: '任务状态已变化，请刷新后重试' };
  }
  await logEvent(db, actor, 'task_status_changed', 'task', taskId, { to: r.to });
  if (body.action !== 'accept') {
    const p = await db.select().from(project).where(eq(project.id, t.projectId));
    const kind = body.action === 'reject' ? 'task_rejected' : 'task_countered';
    const iid = uid();
    await db.insert(inboxItem).values({
      id: iid,
      workspaceId: p[0]?.workspaceId ?? 'default',
      projectId: t.projectId,
      kind,
      refType: 'task',
      refId: taskId,
      status: 'open',
      createdAt: now(),
    });
    await logEvent(db, actor, 'inbox_created', 'inbox_item', iid, { kind });
  }
  const updated = await db.select().from(task).where(eq(task.id, taskId));
  return { kind: 'ok' as const, task: updated[0] };
}

export async function setStage(actor: Actor, db: DB, taskId: string, stage: string) {
  const rows = await db.select().from(task).where(eq(task.id, taskId));
  const t = rows[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  if (t.status !== 'in_progress' && t.status !== 'reviewing') {
    return { kind: 'invalid' as const, status: 409 as const, error: '仅在 in_progress / reviewing 期间可推进 stage' };
  }
  const wsRows = await db.select().from(workstation).where(eq(workstation.id, t.workstationId));
  const manifest = wsRows[0] ? manifestOf(wsRows[0]) : null;
  const taskType = manifest?.tasks.find((x) => x.id === t.typeId);
  const allowed = taskType?.stages ?? manifest?.stages?.map((s) => s.id) ?? [];
  if (!allowed.includes(stage)) {
    return { kind: 'invalid' as const, status: 400 as const, error: `stage ${stage} 不属于该任务类型` };
  }
  await db.update(task).set({ stage }).where(eq(task.id, taskId));
  await logEvent(db, actor, 'task_stage_changed', 'task', taskId, { stage });
  const updated = await db.select().from(task).where(eq(task.id, taskId));
  return { kind: 'ok' as const, task: updated[0] };
}

export async function transitionTaskUc(actor: Actor, db: DB, taskId: string, event: TaskEvent) {
  const rows = await db.select().from(task).where(eq(task.id, taskId));
  const t = rows[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  const hasAcceptance = !!t.acceptanceJson && t.acceptanceJson !== '[]';
  const r = transition(t.status as never, event, { hasAcceptance, acceptancePassed: false });
  if (!r.ok) return { kind: 'invalid' as const, status: 409 as const, error: r.error };
  const changed = await db
    .update(task)
    .set({ status: r.to })
    .where(and(eq(task.id, taskId), eq(task.status, t.status)));
  if (changed.changes === 0) return { kind: 'conflict' as const, status: 409 as const };
  await logEvent(db, actor, 'task_status_changed', 'task', taskId, { to: r.to });
  const updated = await db.select().from(task).where(eq(task.id, taskId));
  return { kind: 'ok' as const, task: updated[0] };
}

export async function resolveInbox(actor: Actor, db: DB, id: string, resolution?: string) {
  const changed = await db
    .update(inboxItem)
    .set({ status: 'resolved' })
    .where(and(eq(inboxItem.id, id), eq(inboxItem.status, 'open')));
  if (changed.changes === 0) return { kind: 'not_found' as const, status: 404 as const };
  await logEvent(db, actor, 'inbox_resolved', 'inbox_item', id, { resolution: resolution ?? null });
  return { kind: 'ok' as const };
}

export function visibleTaskFilter(ctx: PermCtx, actor: Actor): string[] | null {
  if (actor.type === 'human') return null;
  return ctx.workstations
    .filter((w) => can(actor, 'observe', { type: 'workstation', id: w.id }, ctx))
    .map((w) => w.id);
}

export { inArray };
