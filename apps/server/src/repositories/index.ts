import type { Actor } from '@aw/domain';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { agent, artifact, block, entity, eventLog, inboxItem, message, pluginInstall, project, proposal, reviewComment, run, task, taskDependency, thread, workstation } from '../db/schema.js';
import { pluginRegistry } from '../plugins.js';
import { buildPermCtx, manifestOf, visibleTaskFilter } from '../usecases/core.js';
import { stewardOf, taskFlow } from '../usecases/flow.js';
import { stageGates } from '../usecases/gates.js';

// M0.1 不做权限过滤；M0.2 起读路径走 can()：
// human 全通过；agent 按 §4.2 过滤可见工作台。

async function visibleWsIds(actor: Actor, db: DB): Promise<string[] | null> {
  const ctx = await buildPermCtx(actor, db);
  return visibleTaskFilter(ctx, actor);
}

const ACTIVE = new Set(['dispatched', 'accepted', 'in_progress', 'submitted', 'reviewing']);
const STALLED = new Set(['blocked', 'escalated', 'rejected', 'countered']);

function countTasks(rows: { status: string }[]) {
  return {
    total: rows.length,
    draft: rows.filter((t) => t.status === 'draft').length,
    active: rows.filter((t) => ACTIVE.has(t.status)).length,
    blocked: rows.filter((t) => STALLED.has(t.status)).length,
    done: rows.filter((t) => t.status === 'done').length,
  };
}

export async function listProjects(actor: Actor, db: DB) {
  void actor;
  const projects = await db.select().from(project);
  const tasks = await db.select({ projectId: task.projectId, status: task.status }).from(task);
  const open = await db.select({ projectId: inboxItem.projectId }).from(inboxItem).where(eq(inboxItem.status, 'open'));
  const stations = await db.select({ projectId: workstation.projectId }).from(workstation);
  return projects.map((p) => ({
    ...p,
    tasks: countTasks(tasks.filter((t) => t.projectId === p.id)),
    inboxOpen: open.filter((i) => i.projectId === p.id).length,
    workstationCount: stations.filter((w) => w.projectId === p.id).length,
  }));
}

export async function getProjectDetail(actor: Actor, db: DB, projectId: string) {
  const visible = await visibleWsIds(actor, db);
  const rows = await db.select().from(project).where(eq(project.id, projectId));
  const p = rows[0];
  if (!p) return null;
  let workstations = await db
    .select()
    .from(workstation)
    .where(eq(workstation.projectId, projectId));
  if (visible) workstations = workstations.filter((w) => visible.includes(w.id));
  const ids = workstations.map((w) => w.id);
  const agents = ids.length
    ? await db
        .select({ id: agent.id, name: agent.name, role: agent.role, workstationId: agent.workstationId, templateId: agent.templateId, isSteward: agent.isSteward, status: agent.status })
        .from(agent)
        .where(inArray(agent.workstationId, ids))
    : [];
  return { ...p, workstations, agents };
}

export async function getProjectOverview(actor: Actor, db: DB, projectId: string) {
  const detail = await getProjectDetail(actor, db, projectId);
  if (!detail) return null;
  const tasks = await db
    .select({ id: task.id, status: task.status, workstationId: task.workstationId, assigneeType: task.assigneeType, assigneeId: task.assigneeId })
    .from(task)
    .where(eq(task.projectId, projectId));
  const runs = await db
    .select({ status: run.status, agentId: run.agentId, tokensIn: run.tokensIn, tokensOut: run.tokensOut, cost: run.cost })
    .from(run)
    .innerJoin(agent, eq(run.agentId, agent.id))
    .innerJoin(workstation, eq(agent.workstationId, workstation.id))
    .where(eq(workstation.projectId, projectId));
  const proposals = await db
    .select({ status: proposal.status, workstationId: task.workstationId })
    .from(proposal)
    .innerJoin(task, eq(proposal.taskId, task.id))
    .where(eq(task.projectId, projectId));
  const recent = await db
    .select({ id: eventLog.id, action: eventLog.action, actorType: eventLog.actorType, actorId: eventLog.actorId, targetId: eventLog.targetId, payloadJson: eventLog.payloadJson, createdAt: eventLog.createdAt, taskTitle: task.title })
    .from(eventLog)
    .innerJoin(task, eq(eventLog.targetId, task.id))
    .where(and(eq(task.projectId, projectId), eq(eventLog.targetType, 'task')))
    .orderBy(desc(eventLog.createdAt))
    .limit(30);
  const inbox = await listInbox(actor, db, 'open', projectId);
  // 已通过未合并的提案也还等着人（或合并队列）收口
  const pending = (p: { status: string }) => ['pending', 'changes_requested', 'approved'].includes(p.status);
  const stationOf = new Map(detail.agents.map((a) => [a.id, a.workstationId]));

  return {
    tasks: countTasks(tasks),
    runs: {
      total: runs.length,
      running: runs.filter((r) => r.status === 'running').length,
      failed: runs.filter((r) => r.status === 'error' || r.status === 'interrupted').length,
    },
    tokens: runs.reduce((n, r) => n + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0),
    costMicros: runs.reduce((n, r) => n + (r.cost ?? 0), 0),
    budget: detail.budgetJson ? (JSON.parse(detail.budgetJson) as { tokens?: number; costMicros?: number }) : null,
    pendingReviews: proposals.filter(pending).length,
    inboxOpen: inbox.length,
    stageNames: Object.fromEntries(detail.workstations.flatMap((w) => (manifestOf(w)?.stages ?? []).map((s) => [s.id, s.name]))),
    taskFlows: Object.fromEntries(detail.workstations.flatMap((w) => {
      const m = manifestOf(w);
      return (m?.tasks ?? []).map((t) => [t.id, (t.stages ?? []).flatMap((id) => (m?.stages ?? []).filter((s) => s.id === id).map((s) => ({ id: s.id, name: s.name })))]);
    })),
    workstations: detail.workstations.map((w) => {
      const own = tasks.filter((t) => t.workstationId === w.id || (t.assigneeType === 'workstation' && t.assigneeId === w.id));
      return {
        id: w.id,
        tasks: countTasks(own),
        running: runs.filter((r) => r.status === 'running' && stationOf.get(r.agentId ?? '') === w.id).length,
        pendingReviews: proposals.filter((p) => pending(p) && p.workstationId === w.id).length,
        agents: detail.agents.filter((a) => a.workstationId === w.id).length,
      };
    }),
    recent,
  };
}

export async function getWorkstationDetail(actor: Actor, db: DB, wsId: string) {
  const visible = await visibleWsIds(actor, db);
  if (visible && !visible.includes(wsId)) return null;
  const wsRows = await db.select().from(workstation).where(eq(workstation.id, wsId));
  const ws = wsRows[0];
  if (!ws) return null;
  const blocks = await db.select().from(block).where(eq(block.workstationId, wsId));
  const agents = await db.select().from(agent).where(eq(agent.workstationId, wsId));
  const manifest = manifestOf(ws);
  return {
    ...ws,
    blocks: blocks.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)),
    agents,
    manifest: manifest
      ? {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          panels: manifest.panels,
          stages: manifest.stages ?? [],
          entities: manifest.entities,
          agents: manifest.agents.map((a) => ({ id: a.id, name: a.name, role: a.role, tools: a.tools })),
          tasks: manifest.tasks.map((t) => ({ id: t.id, name: t.name, inputSchema: t.inputSchema, stages: t.stages, acceptance: t.acceptance ?? [] })),
          defaults: manifest.defaults ?? null,
        }
      : null,
  };
}

export async function listPlugins(actor: Actor, db: DB) {
  void actor;
  const installs = await db.select().from(pluginInstall);
  return [...pluginRegistry.values()].map((m) => ({
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    enabled: (installs.find((i) => i.pluginId === m.id)?.enabled ?? 1) === 1,
    agents: m.agents.map((a) => ({ id: a.id, name: a.name, role: a.role, tools: a.tools, triggers: a.triggers ?? [] })),
    panels: m.panels.map((p) => ({ id: p.id, type: p.type, title: p.title, entity: p.entity })),
    stages: (m.stages ?? []).map((s) => ({ id: s.id, name: s.name })),
    entities: Object.entries(m.entities).map(([id, e]) => ({ id, label: e.label, fields: Object.keys(e.fields) })),
    presets: (m.presets ?? []).map((p) => ({ id: p.id, name: p.name, description: p.description ?? '' })),
    steward: m.steward,
  }));
}

const depsOf = async (db: DB, ids: string[]) =>
  (ids.length > 0 ? await db.select().from(taskDependency).where(inArray(taskDependency.taskId, ids)) : []).reduce(
    (map, d) => map.set(d.taskId, [...(map.get(d.taskId) ?? []), d.dependsOnId]),
    new Map<string, string[]>(),
  );

// 派发到本台的上级任务也要在本台看板可见，否则 steward 之外没人看得到待接单
export async function listTasks(actor: Actor, db: DB, workstationId: string) {
  const visible = await visibleWsIds(actor, db);
  if (visible && !visible.includes(workstationId)) return [];
  const rows = await db
    .select()
    .from(task)
    .where(or(eq(task.workstationId, workstationId), and(eq(task.assigneeType, 'workstation'), eq(task.assigneeId, workstationId))))
    .orderBy(task.createdAt);
  const deps = await depsOf(db, rows.map((t) => t.id));
  return rows.map((t) => ({ ...t, dependsOn: deps.get(t.id) ?? [] }));
}

export async function listProjectTasks(actor: Actor, db: DB, projectId: string) {
  const visible = await visibleWsIds(actor, db);
  const rows = await db
    .select({ id: task.id, title: task.title, status: task.status, stage: task.stage, workstationId: task.workstationId, parentId: task.parentId, typeId: task.typeId, assigneeType: task.assigneeType, assigneeId: task.assigneeId, startAt: task.startAt, dueAt: task.dueAt, milestoneId: task.milestoneId, blockedReason: task.blockedReason, createdAt: task.createdAt })
    .from(task)
    .where(eq(task.projectId, projectId))
    .orderBy(desc(task.createdAt));
  const deps = await depsOf(db, rows.map((t) => t.id));
  const out = rows.map((t) => ({ ...t, dependsOn: deps.get(t.id) ?? [] }));
  return visible ? out.filter((t) => visible.includes(t.workstationId)) : out;
}

export async function getTaskDetail(actor: Actor, db: DB, taskId: string) {
  const visible = await visibleWsIds(actor, db);
  const rows = await db.select().from(task).where(eq(task.id, taskId));
  const t = rows[0];
  if (!t || (visible && !visible.includes(t.workstationId))) return null;
  const parent = t.parentId
    ? (await db.select().from(task).where(eq(task.id, t.parentId)))[0] ?? null
    : null;
  const children = await db.select().from(task).where(eq(task.parentId, taskId));
  const events = await db.select().from(eventLog).where(eq(eventLog.targetId, taskId));
  const depRows = await db
    .select({ id: task.id, title: task.title, status: task.status })
    .from(taskDependency)
    .innerJoin(task, eq(taskDependency.dependsOnId, task.id))
    .where(eq(taskDependency.taskId, taskId));
  const dependentRows = await db
    .select({ id: task.id, title: task.title, status: task.status })
    .from(taskDependency)
    .innerJoin(task, eq(taskDependency.taskId, task.id))
    .where(eq(taskDependency.dependsOnId, taskId));
  const ms = t.milestoneId ? (await db.select().from(entity).where(eq(entity.id, t.milestoneId)))[0] : undefined;
  const milestone =
    ms?.entityType === 'Milestone'
      ? { id: ms.id, ...(JSON.parse(ms.dataJson ?? '{}') as { name?: string; due?: string }) }
      : null;
  const flow = await taskFlow(db, t);
  return {
    task: { ...t, dependsOn: depRows.map((d) => d.id) },
    parent,
    children,
    dependsOn: depRows,
    dependents: dependentRows,
    milestone: milestone ? { id: milestone.id, name: milestone.name ?? '', due: milestone.due ?? null } : null,
    events: events.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    flow: {
      workstationId: flow.workstationId,
      stages: flow.stages.map((st) => ({ id: st.id, name: st.name, activeAgents: st.activeAgents ?? [], activePanels: st.activePanels ?? [] })),
      budget: flow.type?.defaultBudget ?? flow.manifest?.defaults?.taskBudget ?? null,
      stewardId: (await stewardOf(db, flow.workstationId))?.id ?? null,
      // 离开当前阶段前要满足的门禁
      gates: await stageGates(db, t),
    },
  };
}

async function enrichProposals(db: DB, rows: (typeof proposal.$inferSelect)[]) {
  const ids = rows.map((p) => p.id);
  const comments = ids.length ? await db.select().from(reviewComment).where(inArray(reviewComment.proposalId, ids)) : [];
  const taskIds = [...new Set(rows.flatMap((p) => (p.taskId ? [p.taskId] : [])))];
  const tasks = taskIds.length
    ? await db.select({ id: task.id, title: task.title, status: task.status, stage: task.stage }).from(task).where(inArray(task.id, taskIds))
    : [];
  const authorIds = [...new Set(rows.flatMap((p) => (p.authorId ? [p.authorId] : [])))];
  const authors = authorIds.length ? await db.select({ id: agent.id, name: agent.name }).from(agent).where(inArray(agent.id, authorIds)) : [];
  return rows
    .map((p) => ({
      ...p,
      task: tasks.find((t) => t.id === p.taskId) ?? null,
      authorName: authors.find((a) => a.id === p.authorId)?.name ?? null,
      comments: comments.filter((c) => c.proposalId === p.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// 提案归属：任务所在台、任务被派发到的台，或目标实体所在台
export async function listProposals(actor: Actor, db: DB, wsId: string) {
  const visible = await visibleWsIds(actor, db);
  if (visible && !visible.includes(wsId)) return [];
  const rows = await db
    .select({ proposal })
    .from(proposal)
    .leftJoin(task, eq(proposal.taskId, task.id))
    .leftJoin(entity, eq(proposal.entityId, entity.id))
    .where(
      or(
        eq(task.workstationId, wsId),
        and(eq(task.assigneeType, 'workstation'), eq(task.assigneeId, wsId)),
        eq(entity.workstationId, wsId),
        eq(proposal.workstationId, wsId),
      ),
    );
  return enrichProposals(db, rows.map((r) => r.proposal));
}

// 主任务的改动都在子任务上，看主任务时要一起看到
export async function listTaskProposals(actor: Actor, db: DB, taskId: string) {
  void actor;
  const ids = (await subtreeOf(db, taskId)).map((t) => t.id);
  return enrichProposals(db, ids.length ? await db.select().from(proposal).where(inArray(proposal.taskId, ids)) : []);
}

const runFields = {
  id: run.id,
  agentId: run.agentId,
  taskId: run.taskId,
  status: run.status,
  trigger: run.trigger,
  provider: run.provider,
  model: run.model,
  fallbackFrom: run.fallbackFrom,
  threadId: run.threadId,
  cost: run.cost,
  stopReason: run.stopReason,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
  tokensIn: run.tokensIn,
  tokensOut: run.tokensOut,
  error: run.error,
  agentName: agent.name,
  taskTitle: task.title,
  projectId: workstation.projectId,
};

export async function listRuns(actor: Actor, db: DB, filter: { projectId?: string; taskId?: string; agentId?: string }) {
  void actor;
  const conds = [
    ...(filter.projectId ? [eq(workstation.projectId, filter.projectId)] : []),
    ...(filter.taskId ? [inArray(run.taskId, (await subtreeOf(db, filter.taskId)).map((t) => t.id))] : []),
    ...(filter.agentId ? [eq(run.agentId, filter.agentId)] : []),
  ];
  return db
    .select(runFields)
    .from(run)
    .leftJoin(agent, eq(run.agentId, agent.id))
    .leftJoin(workstation, eq(agent.workstationId, workstation.id))
    .leftJoin(task, eq(run.taskId, task.id))
    .where(and(...conds))
    .orderBy(desc(run.startedAt))
    .limit(300);
}

export async function getRun(actor: Actor, db: DB, runId: string) {
  void actor;
  const rows = await db
    .select({ ...runFields, traceJson: run.traceJson })
    .from(run)
    .leftJoin(agent, eq(run.agentId, agent.id))
    .leftJoin(workstation, eq(agent.workstationId, workstation.id))
    .leftJoin(task, eq(run.taskId, task.id))
    .where(eq(run.id, runId));
  return rows[0] ?? null;
}

export async function agentStatus(actor: Actor, db: DB, wsId: string) {
  void actor;
  const rows = await db
    .select({ agentId: run.agentId, status: run.status, tokensIn: run.tokensIn, tokensOut: run.tokensOut })
    .from(run)
    .innerJoin(agent, eq(run.agentId, agent.id))
    .where(eq(agent.workstationId, wsId));
  const stats: Record<string, { runs: number; tokens: number }> = {};
  for (const r of rows) {
    const s = (stats[r.agentId ?? ''] ??= { runs: 0, tokens: 0 });
    s.runs += 1;
    s.tokens += (r.tokensIn ?? 0) + (r.tokensOut ?? 0);
  }
  return { running: rows.filter((r) => r.status === 'running').map((r) => r.agentId), stats };
}

interface TestRunData { command?: string; status?: string; duration?: number; output_ref?: string; commit_sha?: string; batch_id?: string; task_id?: string | null }

export async function listTestRuns(actor: Actor, db: DB, filter: { workstationId?: string; taskId?: string }) {
  void actor;
  const rows = await db
    .select()
    .from(entity)
    .where(and(eq(entity.entityType, 'TestRun'), ...(filter.workstationId ? [eq(entity.workstationId, filter.workstationId)] : [])))
    .orderBy(desc(entity.createdAt));
  const parsed = rows.map((r) => ({ id: r.id, createdAt: r.createdAt, ...(JSON.parse(r.dataJson ?? '{}') as TestRunData) }));
  const refs = parsed.flatMap((r) => (r.output_ref ? [r.output_ref] : []));
  // 旧记录没有 task_id，从输出产物反查
  const outputs = refs.length ? await db.select({ id: artifact.id, taskId: artifact.taskId }).from(artifact).where(inArray(artifact.id, refs)) : [];
  const withTask = parsed.map((r) => ({ ...r, taskId: r.task_id ?? outputs.find((o) => o.id === r.output_ref)?.taskId ?? null }));
  const ids = [...new Set(withTask.flatMap((r) => (r.taskId ? [r.taskId] : [])))];
  const titles = ids.length ? await db.select({ id: task.id, title: task.title }).from(task).where(inArray(task.id, ids)) : [];
  const scope = filter.taskId ? (await subtreeOf(db, filter.taskId)).map((t) => t.id) : null;
  return withTask
    .filter((r) => !scope || (r.taskId !== null && scope.includes(r.taskId)))
    .map((r) => ({ ...r, taskTitle: titles.find((t) => t.id === r.taskId)?.title ?? null }));
}

export async function getArtifact(actor: Actor, db: DB, id: string) {
  void actor;
  return (await db.select().from(artifact).where(eq(artifact.id, id)))[0] ?? null;
}

export async function listEntities(actor: Actor, db: DB, wsId: string) {
  void actor;
  return db.select().from(entity).where(eq(entity.workstationId, wsId)).orderBy(desc(entity.updatedAt));
}

interface InboxPayload { reason?: string; question?: string; command?: string; cwd?: string; agentId?: string; count?: number }

const SEVERITY_RANK: Record<string, number> = { critical: 3, high: 2, normal: 1 };

// 收件箱条目自带上下文：人不用跳走就能判断要不要处理
async function describeInbox(db: DB, item: typeof inboxItem.$inferSelect) {
  const payload = JSON.parse(item.payloadJson ?? '{}') as InboxPayload;
  let taskRow: typeof task.$inferSelect | undefined;
  let runId: string | null = null;
  let proposalId: string | null = null;
  let proposalTarget: string | null = null;
  const gates = (payload as { gates?: { text: string }[] }).gates;
  let detail: string | null = payload.reason ?? payload.question ?? (gates ? `进入下一阶段前需要你确认：${gates.map((g) => g.text).join('；')}` : null);

  if (item.refType === 'task' && item.refId) {
    taskRow = (await db.select().from(task).where(eq(task.id, item.refId)))[0];
  } else if (item.refType === 'run' && item.refId) {
    runId = item.refId;
    const r = (await db.select().from(run).where(eq(run.id, item.refId)))[0];
    if (r?.taskId) taskRow = (await db.select().from(task).where(eq(task.id, r.taskId)))[0];
    detail ??= r?.error ?? (r?.stopReason ? `停止原因：${r.stopReason}` : null);
  } else if (item.refType === 'proposal' && item.refId) {
    proposalId = item.refId;
    const p = (await db.select().from(proposal).where(eq(proposal.id, item.refId)))[0];
    proposalTarget = p?.targetType ?? null;
    if (p?.taskId) taskRow = (await db.select().from(task).where(eq(task.id, p.taskId)))[0];
    detail ??= p?.reason ?? null;
  }
  if (item.kind === 'blocked') detail ??= taskRow?.blockedReason ?? null;
  if (item.kind === 'task_rejected' || item.kind === 'task_countered') {
    detail ??= (JSON.parse(taskRow?.resultJson ?? '{}') as { reason?: string }).reason ?? null;
  }
  return {
    id: item.id,
    kind: item.kind,
    severity: item.severity,
    count: payload.count ?? 1,
    status: item.status,
    refType: item.refType,
    refId: item.refId,
    payloadJson: item.payloadJson,
    resolutionJson: item.resolutionJson,
    createdAt: item.createdAt,
    projectId: item.projectId ?? taskRow?.projectId ?? null,
    taskId: taskRow?.id ?? null,
    taskTitle: taskRow?.title ?? null,
    taskStatus: taskRow?.status ?? null,
    runId,
    proposalId,
    proposalTarget,
    detail,
    command: payload.command ?? null,
    cwd: payload.cwd ?? null,
  };
}

export async function listInbox(actor: Actor, db: DB, status = 'open', projectId?: string) {
  void actor;
  const rows = await db.select().from(inboxItem).where(eq(inboxItem.status, status)).orderBy(desc(inboxItem.createdAt));
  const items = await Promise.all(rows.map((r) => describeInbox(db, r)));
  const sorted = items.sort((a, b) => (SEVERITY_RANK[b.severity ?? ''] ?? 0) - (SEVERITY_RANK[a.severity ?? ''] ?? 0));
  return projectId ? sorted.filter((i) => i.projectId === projectId) : sorted;
}

async function subtreeOf(db: DB, rootId: string) {
  const root = (await db.select().from(task).where(eq(task.id, rootId)))[0];
  if (!root) return [];
  const rows = await db.select({ id: task.id, parentId: task.parentId, title: task.title }).from(task).where(eq(task.projectId, root.projectId));
  const found = rows.filter((r) => r.id === rootId);
  for (let i = 0; i < found.length; i++) found.push(...rows.filter((r) => r.parentId === found[i]!.id));
  return found;
}

const TIMELINE_EVENTS = new Set(['task_stage_changed', 'task_status_changed', 'task_interrupted']);
// 派发、提交这些节点已有交接消息；时间线只留事件里独有的信息
const TIMELINE_STATUSES = new Set(['blocked', 'escalated', 'cancelled', 'done']);
const TIMELINE_LIMIT = 600;

interface TimelineBase { id: string; at: string; taskId: string; lane: string | null }
export type TimelineItem = TimelineBase & (
  | { type: 'message'; kind: string; senderType: string | null; senderId: string | null; senderName: string | null; content: string; metaJson: string | null }
  | { type: 'stage'; stage: string }
  | { type: 'status'; to: string }
  | { type: 'interrupt' }
  | { type: 'run'; runId: string; agentName: string | null; status: string | null; trigger: string | null; tokens: number; stopReason: string | null }
  | { type: 'proposal'; proposalId: string; status: string; reason: string | null; authorName: string | null; targetType: string | null }
  | { type: 'test'; batchId: string; passed: number; total: number; failed: string[] }
);

// 协作时间线：把消息、状态、运行、提案、验收合成一条流，并汇总子任务
export async function getTaskTimeline(actor: Actor, db: DB, taskId: string): Promise<TimelineItem[] | null> {
  const visible = await visibleWsIds(actor, db);
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t || (visible && !visible.includes(t.workstationId))) return null;
  const tree = await subtreeOf(db, taskId);
  const ids = tree.map((x) => x.id);
  const laneOf = (id: string | null) => (id === taskId ? null : (tree.find((x) => x.id === id)?.title ?? null));
  const agents = await db.select({ id: agent.id, name: agent.name }).from(agent);
  const nameOf = (id: string | null) => agents.find((a) => a.id === id)?.name ?? null;
  const items: TimelineItem[] = [];

  const threads = await db.select({ id: thread.id, scopeId: thread.scopeId }).from(thread).where(and(eq(thread.kind, 'task'), inArray(thread.scopeId, ids)));
  if (threads.length > 0) {
    const msgs = await db.select().from(message).where(inArray(message.threadId, threads.map((x) => x.id)));
    for (const m of msgs) {
      const owner = threads.find((x) => x.id === m.threadId)?.scopeId ?? taskId;
      items.push({ type: 'message', id: m.id, at: m.createdAt, taskId: owner, lane: laneOf(owner), kind: m.kind ?? 'chat', senderType: m.senderType, senderId: m.senderId, senderName: nameOf(m.senderId), content: m.content ?? '', metaJson: m.metaJson });
    }
  }

  const logs = await db.select().from(eventLog).where(and(eq(eventLog.targetType, 'task'), inArray(eventLog.targetId, ids)));
  for (const e of logs) {
    if (!TIMELINE_EVENTS.has(e.action) || !e.targetId) continue;
    const p = JSON.parse(e.payloadJson ?? '{}') as { stage?: string; to?: string; rollup?: boolean };
    const base = { id: e.id, at: e.createdAt, taskId: e.targetId, lane: laneOf(e.targetId) };
    if (e.action === 'task_interrupted') items.push({ ...base, type: 'interrupt' });
    if (e.action === 'task_stage_changed' && p.stage && !p.rollup) items.push({ ...base, type: 'stage', stage: p.stage });
    if (e.action === 'task_status_changed' && p.to && TIMELINE_STATUSES.has(p.to)) items.push({ ...base, type: 'status', to: p.to });
  }

  const runs = await db.select().from(run).where(inArray(run.taskId, ids));
  for (const r of runs) {
    if (!r.taskId) continue;
    items.push({ type: 'run', id: r.id, runId: r.id, at: r.startedAt ?? '', taskId: r.taskId, lane: laneOf(r.taskId), agentName: nameOf(r.agentId), status: r.status, trigger: r.trigger, tokens: (r.tokensIn ?? 0) + (r.tokensOut ?? 0), stopReason: r.stopReason });
  }

  const proposals = await db.select().from(proposal).where(inArray(proposal.taskId, ids));
  for (const p of proposals) {
    if (!p.taskId) continue;
    items.push({ type: 'proposal', id: p.id, proposalId: p.id, at: p.createdAt, taskId: p.taskId, lane: laneOf(p.taskId), status: p.status, reason: p.reason, authorName: nameOf(p.authorId) ?? (p.authorType === 'human' ? '本地用户' : null), targetType: p.targetType });
  }

  const tests = (await listTestRuns(actor, db, {})).filter((x) => x.taskId && ids.includes(x.taskId));
  for (const batchId of new Set(tests.map((x) => x.batch_id ?? x.id))) {
    const batch = tests.filter((x) => (x.batch_id ?? x.id) === batchId);
    const first = batch[0]!;
    items.push({ type: 'test', id: batchId, batchId, at: first.createdAt, taskId: first.taskId!, lane: laneOf(first.taskId), passed: batch.filter((x) => x.status === 'passed').length, total: batch.length, failed: batch.filter((x) => x.status !== 'passed').map((x) => x.command ?? '') });
  }

  return items.sort((a, b) => a.at.localeCompare(b.at)).slice(-TIMELINE_LIMIT);
}

interface TraceTail { type?: string; name?: string; toolCalls?: { name: string }[] }

// 团队脉搏：每个成员此刻在哪件事上、做到哪一步
export async function getTeamPulse(actor: Actor, db: DB, projectId: string) {
  const detail = await getProjectDetail(actor, db, projectId);
  if (!detail) return null;
  const ids = detail.agents.map((a) => a.id);
  const active = ids.length
    ? await db
        .select({ id: run.id, agentId: run.agentId, taskId: run.taskId, threadId: run.threadId, trigger: run.trigger, startedAt: run.startedAt, traceJson: run.traceJson, taskTitle: task.title })
        .from(run)
        .leftJoin(task, eq(run.taskId, task.id))
        .where(and(eq(run.status, 'running'), inArray(run.agentId, ids)))
    : [];
  return detail.agents.map((a) => {
    const r = active.find((x) => x.agentId === a.id);
    const last = r ? (JSON.parse(r.traceJson ?? '[]') as TraceTail[]).at(-1) : undefined;
    return {
      ...a,
      run: r ? { id: r.id, taskId: r.taskId, threadId: r.threadId, taskTitle: r.taskTitle, trigger: r.trigger, startedAt: r.startedAt, activity: last?.type === 'tool' ? (last.name ?? null) : (last?.toolCalls?.[0]?.name ?? null) } : null,
    };
  });
}

// 项目账本：钱和 token 花在了哪里
export async function getLedger(actor: Actor, db: DB, projectId: string) {
  const detail = await getProjectDetail(actor, db, projectId);
  if (!detail) return null;
  const rows = await db
    .select({ agentId: run.agentId, taskId: run.taskId, tokensIn: run.tokensIn, tokensOut: run.tokensOut, cost: run.cost, startedAt: run.startedAt, endedAt: run.endedAt, taskTitle: task.title, workstationId: agent.workstationId, agentName: agent.name })
    .from(run)
    .innerJoin(agent, eq(run.agentId, agent.id))
    .leftJoin(task, eq(run.taskId, task.id))
    .where(inArray(agent.workstationId, detail.workstations.map((w) => w.id)));
  const add = (map: Map<string, { key: string; label: string; tokens: number; costMicros: number; runs: number; ms: number }>, key: string, label: string, r: (typeof rows)[number]) => {
    const e = map.get(key) ?? { key, label, tokens: 0, costMicros: 0, runs: 0, ms: 0 };
    e.tokens += (r.tokensIn ?? 0) + (r.tokensOut ?? 0);
    e.costMicros += r.cost ?? 0;
    e.runs += 1;
    if (r.startedAt && r.endedAt) e.ms += new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime();
    map.set(key, e);
  };
  const byWs = new Map();
  const byAgent = new Map();
  const byTask = new Map();
  const total = new Map();
  for (const r of rows) {
    add(total, 'all', '合计', r);
    add(byWs, r.workstationId, detail.workstations.find((w) => w.id === r.workstationId)?.name ?? '', r);
    add(byAgent, r.agentId ?? '', r.agentName, r);
    add(byTask, r.taskId ?? 'discussion', r.taskTitle ?? '讨论', r);
  }
  const sorted = (m: Map<string, { tokens: number }>) => [...m.values()].sort((a, b) => b.tokens - a.tokens) as { key: string; label: string; tokens: number; costMicros: number; runs: number; ms: number }[];
  return {
    total: sorted(total)[0] ?? { key: 'all', label: '合计', tokens: 0, costMicros: 0, runs: 0, ms: 0 },
    byWorkstation: sorted(byWs),
    byAgent: sorted(byAgent),
    byTask: sorted(byTask),
    budget: detail.budgetJson ? (JSON.parse(detail.budgetJson) as { tokens?: number; costMicros?: number }) : null,
  };
}

export { and, eq, inArray };
