import { can, TERMINAL, wouldCreateCycle, type Actor, type TaskStatus } from '@aw/domain';
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { agent, entity, task, taskDependency, workstation } from '../db/schema.js';
import { buildPermCtx, logEvent } from './core.js';
import { kickoffSubtask } from './tasks.js';
import { PLATFORM, postMessage, wsThreadOf } from './threads.js';

const now = () => new Date().toISOString();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLATFORM_ACTOR: Actor = { type: 'agent', id: 'platform' };

export interface PlanInput {
  startAt?: string | null | undefined;
  dueAt?: string | null | undefined;
  milestoneId?: string | null | undefined;
  dependsOn?: string[] | undefined;
}

// 同一项目内任务的全部依赖边（taskId 端限在项目里，dependsOn 端由校验保证同项目）
export async function projectEdges(db: DB, projectId: string) {
  const ids = (await db.select({ id: task.id }).from(task).where(eq(task.projectId, projectId))).map((t) => t.id);
  if (ids.length === 0) return [];
  return db.select().from(taskDependency).where(inArray(taskDependency.taskId, ids));
}

// 排期输入校验：日期形状与先后、里程碑归属、前置任务集合与环路；返回错误文案或 null
export async function validatePlan(
  db: DB,
  projectId: string,
  taskId: string | null,
  input: PlanInput,
  base?: { startAt: string | null; dueAt: string | null },
) {
  const nextStart = input.startAt !== undefined ? input.startAt : (base?.startAt ?? null);
  const nextDue = input.dueAt !== undefined ? input.dueAt : (base?.dueAt ?? null);
  for (const [label, v] of [['开始日期', nextStart], ['截止日期', nextDue]] as const) {
    if (v !== null && !DATE_RE.test(v)) return `${label}格式应为 YYYY-MM-DD`;
  }
  if (nextStart && nextDue && nextStart > nextDue) return '开始日期不能晚于截止日期';
  if (input.milestoneId) {
    const e = (await db.select().from(entity).where(eq(entity.id, input.milestoneId)))[0];
    const ws = e ? (await db.select().from(workstation).where(eq(workstation.id, e.workstationId)))[0] : undefined;
    if (!e || e.entityType !== 'Milestone' || ws?.projectId !== projectId) return '里程碑不存在';
  }
  if (input.dependsOn !== undefined) {
    const deps = [...new Set(input.dependsOn)];
    if (taskId && deps.includes(taskId)) return '任务不能依赖自己';
    const rows = deps.length > 0 ? await db.select().from(task).where(inArray(task.id, deps)) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of deps) {
      const d = byId.get(id);
      if (!d || d.projectId !== projectId) return '前置任务不存在或不在本项目';
      if (d.status === 'cancelled') return `前置任务「${d.title}」已取消`;
    }
    const edges = await projectEdges(db, projectId);
    if (taskId && wouldCreateCycle(edges, taskId, deps)) return '依赖关系会形成循环';
  }
  return null;
}

// 还没完成的前置任务：派发 / 指派 / 放行都卡在这里
export async function unmetDependencies(db: DB, taskId: string) {
  const rows = await db
    .select({ id: task.id, title: task.title, status: task.status })
    .from(taskDependency)
    .innerJoin(task, eq(taskDependency.dependsOnId, task.id))
    .where(eq(taskDependency.taskId, taskId));
  return rows.filter((r) => r.status !== 'done');
}

export const unmetDepText = (unmet: { title: string }[]) => `前置任务未完成：${unmet.map((u) => `「${u.title}」`).join('、')}`;

// 给任务排期：日期、里程碑、前置依赖（dependsOn 整组替换）
export async function planTask(actor: Actor, db: DB, taskId: string, input: PlanInput) {
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  if (!t) return { kind: 'not_found' as const, status: 404 as const, error: '任务不存在' };
  if (t.status === 'done' || t.status === 'cancelled') {
    return { kind: 'invalid' as const, status: 409 as const, error: '已结束的任务不能再排期' };
  }
  if (actor.type === 'agent') {
    const ctx = await buildPermCtx(actor, db);
    if (!can(actor, 'invoke', { type: 'workstation', id: t.workstationId }, ctx)) {
      return { kind: 'error' as const, status: 403 as const, error: '无 invoke 权' };
    }
  }
  const bad = await validatePlan(db, t.projectId, taskId, input, t);
  if (bad) return { kind: 'error' as const, status: 400 as const, error: bad };

  await db
    .update(task)
    .set({
      ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
    })
    .where(eq(task.id, taskId));
  if (input.dependsOn !== undefined) {
    await db.delete(taskDependency).where(eq(taskDependency.taskId, taskId));
    for (const dep of [...new Set(input.dependsOn)]) {
      await db.insert(taskDependency).values({ taskId, dependsOnId: dep, createdAt: now() });
    }
  }
  await logEvent(db, actor, 'task_planned', 'task', taskId, {});
  return { kind: 'ok' as const, task: (await db.select().from(task).where(eq(task.id, taskId)))[0]! };
}

// 前置完成后的放行：有待指派的直接发出去开工，没有的在所属台大群提醒人来派
export async function releaseDependents(db: DB, taskId: string) {
  const links = await db.select({ taskId: taskDependency.taskId }).from(taskDependency).where(eq(taskDependency.dependsOnId, taskId));
  for (const { taskId: id } of links) {
    const t = (await db.select().from(task).where(eq(task.id, id)))[0];
    if (!t || t.status !== 'draft') continue;
    if ((await unmetDependencies(db, id)).length > 0) continue;
    if (t.pendingAssigneeId) {
      const a = (await db.select().from(agent).where(eq(agent.id, t.pendingAssigneeId)))[0];
      const changed = await db
        .update(task)
        .set({ status: 'dispatched', assigneeType: 'agent', assigneeId: t.pendingAssigneeId, pendingAssigneeId: null })
        .where(and(eq(task.id, id), eq(task.status, 'draft')));
      if (changed.changes > 0 && a) await kickoffSubtask(PLATFORM_ACTOR, db, t, a);
    } else {
      const th = await wsThreadOf(db, t.workstationId);
      if (th) await postMessage(db, th.id, PLATFORM, `前置任务都已完成，「${t.title}」可以派发了`, 'status');
    }
  }
}

// 前置被取消：不自动拆边，提醒各工作台去调整依赖
export async function notifyDependentsOfCancel(db: DB, taskId: string) {
  const me = (await db.select({ title: task.title }).from(task).where(eq(task.id, taskId)))[0];
  if (!me) return;
  const links = await db.select({ taskId: taskDependency.taskId }).from(taskDependency).where(eq(taskDependency.dependsOnId, taskId));
  for (const { taskId: id } of links) {
    const t = (await db.select().from(task).where(eq(task.id, id)))[0];
    if (!t || TERMINAL.includes(t.status as TaskStatus)) continue;
    const th = await wsThreadOf(db, t.workstationId);
    if (th) await postMessage(db, th.id, PLATFORM, `前置任务「${me.title}」已取消，「${t.title}」需要调整依赖后才能派发`, 'status');
  }
}
