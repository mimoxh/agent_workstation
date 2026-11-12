import type { Actor, TaskEvent } from '@aw/domain';
import { can, descendantIds, TERMINAL, transition, type TaskStatus } from '@aw/domain';
import { validateInput as validateSchema } from '@aw/plugin-spec';
import { parseScope } from '../runtime/scope.js';
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { agent, inboxItem, project, task, taskDependency, workstation } from '../db/schema.js';
import { lastAcceptancePassed, sendBack, submitChange } from '../runtime/dev_workflow.js';
import { cancelRunsOfTask } from '../runtime/loop.js';
import { modelGate } from '../runtime/models.js';
import { triggerRun } from '../runtime/scheduler.js';
import { buildPermCtx, logEvent, manifestOf, mergeAcceptance } from './core.js';
import { taskFlow } from './flow.js';
import { confirmGates, describeGates, gatesBetween } from './gates.js';
import { closeInboxFor, pushInbox } from './inbox.js';
import { unmetDependencies, unmetDepText, validatePlan } from './plan.js';
import { postHandoff, postStatus } from './threads.js';

// 声明了 module 的任务类型：范围必须解析得出来（路径、逗号分隔多个或 .），否则写工具会全部拒绝
function validateInput(schema: Parameters<typeof validateSchema>[0], input: unknown): string[] {
  const errs = validateSchema(schema, input);
  if (errs.length > 0) return errs;
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  if ('module' in props && parseScope(JSON.stringify(input ?? {})).invalid) return ['module 不能为空，也不能越出仓库：写一个或多个仓库内路径（逗号分隔），整个仓库写 .'];
  return [];
}

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

const nameOfWs = async (db: DB, id: string | null) => (id ? (await db.select().from(workstation).where(eq(workstation.id, id)))[0]?.name : undefined) ?? '工作台';
const nameOfAgent = async (db: DB, id: string | null) => (id ? (await db.select().from(agent).where(eq(agent.id, id)))[0]?.name : undefined) ?? 'Agent';

// 子任务开工三件套：task_assigned 事件（调度器据此起 run）、父任务自动 start、交接消息
export async function kickoffSubtask(
  actor: Actor,
  db: DB,
  t: { id: string; title: string; parentId: string | null },
  assignee: { id: string; name: string },
) {
  await logEvent(db, actor, 'task_assigned', 'task', t.id, {
    assigneeType: 'agent',
    assigneeId: assignee.id,
  });
  if (!t.parentId) return;
  const parent = (await db.select().from(task).where(eq(task.id, t.parentId)))[0];
  if (!parent) return;
  const pr = transition(parent.status as TaskStatus, 'start');
  if (pr.ok) {
    const changed = await db
      .update(task)
      .set({ status: pr.to })
      .where(and(eq(task.id, parent.id), eq(task.status, parent.status)));
    if (changed.changes > 0) {
      await logEvent(db, actor, 'task_status_changed', 'task', parent.id, { to: pr.to });
    }
  }
  const from = actor.id === 'platform' ? '平台' : actor.type === 'agent' ? await nameOfAgent(db, actor.id) : '本地用户';
  await postHandoff(db, parent.id, `${from} 把「${t.title}」交给 ${assignee.name}`, { from, to: assignee.name, next: '实现并提交改动', refs: { taskId: t.id } });
  await rollupStage(db, actor, parent.id);
}

export async function createTaskUc(
  actor: Actor,
  db: DB,
  wsId: string,
  input: { title: string; intent?: string | undefined; typeId?: string | undefined; input?: Record<string, unknown> | undefined; acceptance?: unknown[] | undefined; parentId?: string | undefined; assigneeAgentId?: string | undefined; stage?: string | undefined; startAt?: string | null | undefined; dueAt?: string | null | undefined; milestoneId?: string | null | undefined; dependsOn?: string[] | undefined },
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

  const badPlan = await validatePlan(db, ws.projectId, null, input);
  if (badPlan) return { kind: 'error' as const, status: 400 as const, error: badPlan };

  // 子任务语义：assigneeAgentId 时平台代派发 draft→dispatched；前置未完成则留下待指派，放行时补发
  const deps = [...new Set(input.dependsOn ?? [])];
  const unmetDeps = deps.length > 0
    ? (await db.select({ id: task.id, status: task.status }).from(task).where(inArray(task.id, deps))).filter((d) => d.status !== 'done')
    : [];
  let status = 'draft';
  let assignee: typeof agent.$inferSelect | undefined;
  let pendingAssigneeId: string | null = null;
  if (input.assigneeAgentId) {
    assignee = (await db.select().from(agent).where(eq(agent.id, input.assigneeAgentId)))[0];
    if (!assignee || assignee.workstationId !== wsId) {
      return { kind: 'error' as const, status: 400 as const, error: 'assignee Agent 不属于此工作台' };
    }
    const ctx = await buildPermCtx(actor, db);
    if (actor.type === 'agent' && !can(actor, 'invoke', { type: 'workstation', id: wsId }, ctx)) {
      return { kind: 'error' as const, status: 403 as const, error: '无 invoke 权' };
    }
    if (unmetDeps.length > 0) {
      pendingAssigneeId = input.assigneeAgentId;
    } else {
      const r = transition('draft', 'dispatch');
      if (!r.ok) return { kind: 'error' as const, status: 500 as const, error: r.error };
      status = r.to;
    }
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
    assigneeType: input.assigneeAgentId && !pendingAssigneeId ? 'agent' : null,
    assigneeId: input.assigneeAgentId && !pendingAssigneeId ? input.assigneeAgentId : null,
    startAt: input.startAt ?? null,
    dueAt: input.dueAt ?? null,
    milestoneId: input.milestoneId ?? null,
    pendingAssigneeId,
    createdAt: now(),
  });
  for (const dep of deps) {
    await db.insert(taskDependency).values({ taskId: id, dependsOnId: dep, createdAt: now() });
  }
  await logEvent(db, actor, 'task_created', 'task', id, { workstationId: wsId });
  if (input.assigneeAgentId && !pendingAssigneeId) {
    await kickoffSubtask(actor, db, { id, title: input.title, parentId: input.parentId ?? null }, assignee!);
  }
  const rows = await db.select().from(task).where(eq(task.id, id));
  return { kind: 'ok' as const, task: rows[0] };
}

export async function dispatchTask(
  actor: Actor,
  db: DB,
  taskId: string,
  body: { targetWorkstationId: string; typeId: string; input: Record<string, unknown>; acceptance?: unknown[] | undefined; reason?: string | undefined; budget?: { tokens?: number | undefined } | undefined },
) {
  const rows = await db.select().from(task).where(eq(task.id, taskId));
  const t = rows[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  const unmet = await unmetDependencies(db, taskId);
  if (unmet.length > 0) return { kind: 'invalid' as const, status: 409 as const, error: unmetDepText(unmet) };
  const noModel = await modelGate();
  if (noModel) return { kind: 'error' as const, status: 409 as const, error: noModel };
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

  const merged = mergeAcceptance(body.acceptance ?? t.acceptanceJson, taskType.acceptance ?? []);

  const r = transition(t.status as TaskStatus, 'dispatch');
  if (!r.ok) return { kind: 'invalid' as const, status: 409 as const, error: r.error };
  const firstStage = taskType.stages?.[0] ?? manifest.stages?.[0]?.id ?? null;
  const changed = await db
    .update(task)
    .set({
      status: 'dispatched',
      typeId: body.typeId,
      stage: firstStage,
      inputJson: JSON.stringify(body.input),
      acceptanceJson: JSON.stringify(merged),
      assigneeType: 'workstation',
      assigneeId: body.targetWorkstationId,
      dispatchReason: body.reason ?? null,
      ...(body.budget ? { budgetJson: JSON.stringify(body.budget) } : {}),
    })
    .where(and(eq(task.id, taskId), eq(task.status, t.status)));
  if (changed.changes === 0) {
    return { kind: 'conflict' as const, status: 409 as const, error: '任务状态已变化，请刷新后重试' };
  }
  await logEvent(db, actor, 'task_status_changed', 'task', taskId, { to: 'dispatched' });
  const from = await nameOfWs(db, t.workstationId);
  await postHandoff(db, taskId, `${from} 把任务派发给 ${target!.name}${body.reason ? `：${body.reason}` : ''}`, { from, to: target!.name, next: '等待 steward 接单' });
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
  const r = transition(t.status as TaskStatus, event);
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
  const by = await nameOfWs(db, t.assigneeId);
  const verb = body.action === 'accept' ? '接单' : body.action === 'reject' ? '拒绝了任务' : '提出反提案';
  await postHandoff(db, taskId, `${by} ${verb}${body.reason ? `：${body.reason}` : ''}`, { from: by, to: await nameOfWs(db, t.workstationId), next: body.action === 'accept' ? '拆分并推进' : '等你决定' });
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

export const GATE_ERROR = '未满足阶段门禁';

export async function setStage(actor: Actor, db: DB, taskId: string, stage: string, opts: { force?: boolean | undefined } = {}) {
  const rows = await db.select().from(task).where(eq(task.id, taskId));
  const t = rows[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  if (t.status !== 'in_progress' && t.status !== 'reviewing') {
    return { kind: 'invalid' as const, status: 409 as const, error: '仅在 in_progress / reviewing 期间可推进 stage' };
  }
  const { stages } = await taskFlow(db, t);
  if (!stages.some((s) => s.id === stage)) {
    return { kind: 'invalid' as const, status: 400 as const, error: `stage ${stage} 不属于该任务类型` };
  }
  let unmet = (await gatesBetween(db, t, stage)).filter((g) => !g.met);
  if (actor.type === 'human') {
    // 人亲手推进即视为确认了人工检查项
    const manual = unmet.filter((g) => g.kind === 'manual');
    if (manual.length > 0) await confirmGates(actor, db, taskId, manual);
    unmet = unmet.filter((g) => g.kind !== 'manual');
    if (unmet.length > 0 && opts.force) {
      await logEvent(db, actor, 'task_gate_overridden', 'task', taskId, { stage, gates: unmet.map((g) => g.text) });
      unmet = [];
    }
  } else if (unmet.some((g) => g.kind === 'manual')) {
    const open = await db.select().from(inboxItem).where(and(eq(inboxItem.kind, 'gate_confirm'), eq(inboxItem.refId, taskId), eq(inboxItem.status, 'open')));
    if (open.length === 0) {
      const manual = unmet.filter((g) => g.kind === 'manual');
      await pushInbox(db, t.projectId, { kind: 'gate_confirm', refType: 'task', refId: taskId, payload: { target: stage, gates: manual.map((g) => ({ stage: g.stage, index: g.index, text: g.text })) } });
    }
  }
  if (unmet.length > 0) {
    const wait = actor.type === 'human' ? '' : unmet.some((g) => g.kind === 'manual') ? '；人工检查项已发到收件箱等人确认，确认后平台会推进' : '';
    return { kind: 'invalid' as const, status: 409 as const, error: `${GATE_ERROR}：${describeGates(unmet)}${wait}` };
  }
  await db.update(task).set({ stage }).where(eq(task.id, taskId));
  await logEvent(db, actor, 'task_stage_changed', 'task', taskId, { stage });
  if (t.parentId) await rollupStage(db, actor, t.parentId);
  const updated = await db.select().from(task).where(eq(task.id, taskId));
  return { kind: 'ok' as const, task: updated[0] };
}

// 父任务的 stage 由子任务汇总：取最落后的未完成阶段，全部收口时停在最后一阶段
export async function rollupStage(db: DB, actor: Actor, parentId: string) {
  const parent = (await db.select().from(task).where(eq(task.id, parentId)))[0];
  if (!parent || TERMINAL.includes(parent.status as TaskStatus)) return;
  const { stages } = await taskFlow(db, parent);
  if (stages.length === 0) return;
  const children = (await db.select().from(task).where(eq(task.parentId, parentId))).filter((c) => c.status !== 'cancelled');
  if (children.length === 0) return;
  const order = stages.map((s) => s.id);
  const open = children.filter((c) => c.status !== 'done').map((c) => order.indexOf(c.stage ?? '')).filter((i) => i >= 0);
  const stage = order[open.length > 0 ? Math.min(...open) : order.length - 1]!;
  if (stage === parent.stage) return;
  await db.update(task).set({ stage }).where(eq(task.id, parentId));
  await logEvent(db, actor, 'task_stage_changed', 'task', parentId, { stage, rollup: true });
  if (parent.parentId) await rollupStage(db, actor, parent.parentId);
}

// 重新派发时把反提案里的改动落到任务上
function applyCounter(t: { inputJson: string | null; acceptanceJson: string | null; resultJson: string | null }) {
  const counter = (JSON.parse(t.resultJson ?? '{}') as { counter?: { input?: Record<string, unknown>; acceptance?: unknown[] } }).counter;
  if (!counter) return {};
  return {
    ...(counter.input ? { inputJson: JSON.stringify({ ...(JSON.parse(t.inputJson ?? '{}') as Record<string, unknown>), ...counter.input }) } : {}),
    ...(counter.acceptance ? { acceptanceJson: JSON.stringify(counter.acceptance) } : {}),
  };
}

export async function updateTask(
  actor: Actor,
  db: DB,
  taskId: string,
  input: { title?: string | undefined; intent?: string | null | undefined; input?: Record<string, unknown> | undefined; acceptance?: unknown[] | undefined },
) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  if (t.status !== 'draft') return { kind: 'invalid' as const, status: 409 as const, error: '只有草稿可以编辑' };
  const ws = (await db.select().from(workstation).where(eq(workstation.id, t.workstationId)))[0];
  const taskType = ws ? manifestOf(ws)?.tasks.find((x) => x.id === t.typeId) : undefined;
  const title = input.title ?? t.title;
  let nextInput = input.input ?? (JSON.parse(t.inputJson ?? 'null') as Record<string, unknown> | null);
  if (taskType) {
    nextInput = { ...(nextInput ?? {}), title };
    const errs = validateInput(taskType.inputSchema, nextInput);
    if (errs.length > 0) return { kind: 'error' as const, status: 400 as const, error: errs.join('；') };
  }
  await db
    .update(task)
    .set({
      title,
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      inputJson: nextInput ? JSON.stringify(nextInput) : null,
      ...(input.acceptance ? { acceptanceJson: JSON.stringify(input.acceptance) } : {}),
    })
    .where(and(eq(task.id, taskId), eq(task.status, 'draft')));
  await logEvent(db, actor, 'task_updated', 'task', taskId, {});
  return { kind: 'ok' as const, task: (await db.select().from(task).where(eq(task.id, taskId)))[0]! };
}

// 草稿直接指派给本台 Agent（没有子孙台可派发时的出路）
export async function assignTask(actor: Actor, db: DB, taskId: string, body: { agentId: string; reason?: string | undefined }) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  const unmet = await unmetDependencies(db, taskId);
  if (unmet.length > 0) return { kind: 'invalid' as const, status: 409 as const, error: unmetDepText(unmet) };
  const a = (await db.select().from(agent).where(eq(agent.id, body.agentId)))[0];
  if (!a || a.workstationId !== t.workstationId) return { kind: 'error' as const, status: 400 as const, error: 'Agent 不属于任务所在工作台' };
  const noModel = await modelGate();
  if (noModel) return { kind: 'error' as const, status: 409 as const, error: noModel };
  const r = transition(t.status as TaskStatus, 'dispatch');
  if (!r.ok) return { kind: 'invalid' as const, status: 409 as const, error: r.error };
  const changed = await db
    .update(task)
    .set({ status: r.to, assigneeType: 'agent', assigneeId: a.id, dispatchReason: body.reason ?? null })
    .where(and(eq(task.id, taskId), eq(task.status, t.status)));
  if (changed.changes === 0) return { kind: 'conflict' as const, status: 409 as const, error: '任务状态已变化，请刷新后重试' };
  await logEvent(db, actor, 'task_status_changed', 'task', taskId, { to: r.to });
  await postHandoff(db, taskId, `任务交给 ${a.name}${body.reason ? `：${body.reason}` : ''}`, { from: '本地用户', to: a.name });
  await logEvent(db, actor, 'task_assigned', 'task', taskId, { assigneeType: 'agent', assigneeId: a.id });
  return { kind: 'ok' as const, task: (await db.select().from(task).where(eq(task.id, taskId)))[0]! };
}

export async function transitionTaskUc(actor: Actor, db: DB, taskId: string, event: TaskEvent): Promise<
  | { kind: 'ok'; status?: undefined; task: typeof task.$inferSelect | undefined }
  | { kind: 'not_found' | 'invalid' | 'conflict'; status: 404 | 409; error: string }
> {
  const rows = await db.select().from(task).where(eq(task.id, taskId));
  const t = rows[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  // 代码任务的通过 = 提案合并；绕过提案会留下未合并的分支却标记完成
  if (event === 'approve' && t.codeRefJson) {
    return { kind: 'invalid' as const, status: 409 as const, error: '代码任务须在改动审阅里通过并合并' };
  }
  const hasAcceptance = !!t.acceptanceJson && t.acceptanceJson !== '[]';
  const acceptancePassed = hasAcceptance ? ((await lastAcceptancePassed(db, t.workstationId, t.id)) ?? false) : false;
  const r = transition(t.status as TaskStatus, event, { hasAcceptance, acceptancePassed });
  if (!r.ok) return { kind: 'invalid' as const, status: 409 as const, error: r.error };
  // 退回走完整流程：计数、回到实现阶段、通知 assignee
  if (event === 'send_back' && t.codeRefJson) {
    await sendBack(db, { actor }, taskId, '人工退回，回到实现阶段');
    return { kind: 'ok' as const, task: (await db.select().from(task).where(eq(task.id, taskId)))[0] };
  }
  const resumed = event === 'unblock' || event === 'resolve';
  const changed = await db
    .update(task)
    .set({
      status: r.to,
      ...(resumed ? { blockedReason: null } : {}),
      ...(event === 'revise' ? { assigneeType: null, assigneeId: null } : {}),
      ...(event === 'redispatch' ? applyCounter(t) : {}),
    })
    .where(and(eq(task.id, taskId), eq(task.status, t.status)));
  if (changed.changes === 0) return { kind: 'conflict' as const, status: 409 as const, error: '任务状态已变化，请刷新后重试' };
  await logEvent(db, actor, 'task_status_changed', 'task', taskId, { to: r.to });
  if (event === 'redispatch' && t.assigneeId) {
    await logEvent(db, actor, 'task_assigned', 'task', taskId, { assigneeType: t.assigneeType, assigneeId: t.assigneeId, typeId: t.typeId });
  }
  if (resumed) {
    await closeInboxFor(db, 'task', taskId, { action: event });
    await logEvent(db, actor, 'task_resumed', 'task', taskId, {});
  }
  if (event === 'cancel') await cancelDescendants(actor, db, taskId);
  const updated = await db.select().from(task).where(eq(task.id, taskId));
  return { kind: 'ok' as const, task: updated[0] };
}

// 取消是级联的：停掉在跑的 run、关闭待处理项、取消未结束的子任务
async function cancelDescendants(actor: Actor, db: DB, taskId: string) {
  cancelRunsOfTask(taskId);
  await closeInboxFor(db, 'task', taskId, { action: 'cancel' });
  const children = await db.select().from(task).where(eq(task.parentId, taskId));
  for (const c of children) {
    if (c.status !== 'done' && c.status !== 'cancelled') await transitionTaskUc(actor, db, c.id, 'cancel');
  }
}

// 打断：停下在跑的 run，任务保持原状，人说话后由 assignee 接着干
export async function interruptTask(actor: Actor, db: DB, taskId: string) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  const stopped = cancelRunsOfTask(taskId);
  if (stopped === 0) return { kind: 'invalid' as const, status: 409 as const, error: '这个任务没有在跑的运行' };
  await logEvent(db, actor, 'task_interrupted', 'task', taskId, { stopped });
  await postStatus(db, taskId, '本地用户打断了运行，等你发话后继续。');
  return { kind: 'ok' as const, stopped };
}

const TAKEOVER_FROM: readonly string[] = ['in_progress', 'blocked', 'escalated'];

// 接管：任务转给人（D5），阻塞中的任务一并恢复为进行中
export async function takeoverTask(actor: Actor, db: DB, taskId: string) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  if (t.assigneeType !== 'agent' || !TAKEOVER_FROM.includes(t.status)) {
    return { kind: 'invalid' as const, status: 409 as const, error: '只有 Agent 正在执行或阻塞中的任务可以接管' };
  }
  cancelRunsOfTask(taskId);
  const changed = await db
    .update(task)
    .set({ status: 'in_progress', blockedReason: null, assigneeType: 'human', assigneeId: actor.id, takeoverFrom: t.assigneeId })
    .where(and(eq(task.id, taskId), eq(task.status, t.status)));
  if (changed.changes === 0) return { kind: 'conflict' as const, status: 409 as const, error: '任务状态已变化，请刷新后重试' };
  await closeInboxFor(db, 'task', taskId, { action: 'takeover' });
  await logEvent(db, actor, 'task_taken_over', 'task', taskId, { from: t.assigneeId });
  await postHandoff(db, taskId, `本地用户接管了任务，${await nameOfAgent(db, t.assigneeId)} 暂停`, { from: await nameOfAgent(db, t.assigneeId), to: '本地用户', next: '人工处理后交还或提交改动' });
  return { kind: 'ok' as const, task: (await db.select().from(task).where(eq(task.id, taskId)))[0]! };
}

// 交还：回到接管前的 Agent，并让它读会话里的最新进展继续
export async function releaseTask(actor: Actor, db: DB, taskId: string, note?: string) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  if (t.assigneeType !== 'human' || !t.takeoverFrom) return { kind: 'invalid' as const, status: 409 as const, error: '这个任务不在人工接管中' };
  await db.update(task).set({ assigneeType: 'agent', assigneeId: t.takeoverFrom, takeoverFrom: null }).where(eq(task.id, taskId));
  await logEvent(db, actor, 'task_released', 'task', taskId, { to: t.takeoverFrom });
  const to = await nameOfAgent(db, t.takeoverFrom);
  await postHandoff(db, taskId, `本地用户把任务交还给 ${to}${note ? `：${note}` : ''}`, { from: '本地用户', to, next: '继续实现' });
  if (t.status === 'in_progress') await triggerRun(db, t.takeoverFrom, taskId, 'feedback');
  return { kind: 'ok' as const, task: (await db.select().from(task).where(eq(task.id, taskId)))[0]! };
}

// 人接管后在 worktree 里改完，由这里进入和 Agent 一样的测试 → 评审 → 合并流程
export async function submitHumanChange(actor: Actor, db: DB, taskId: string, summary: string) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  if (t.assigneeType !== 'human') return { kind: 'invalid' as const, status: 409 as const, error: '只有人工接管中的任务可以这样提交' };
  const r = await submitChange({ db, actor, task: t }, summary);
  return 'error' in r ? { kind: 'invalid' as const, status: 409 as const, error: r.error } : { kind: 'ok' as const, proposalId: r.proposalId };
}
