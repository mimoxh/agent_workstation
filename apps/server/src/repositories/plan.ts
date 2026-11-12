import { isOverdue, localDate, TERMINAL, type Actor, type TaskStatus } from '@aw/domain';
import { eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { entity, task, taskDependency } from '../db/schema.js';
import { getProjectDetail, getProjectOverview } from './index.js';
import { qaContextOf } from './qa.js';

const dayMs = 24 * 60 * 60 * 1000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);

interface MilestoneData { name?: string; due?: string; status?: string }
interface RiskData { title?: string; level?: string; status?: string; owner?: string }
interface SignedPlanData { name?: string; milestone?: string | null; status?: string; signoff?: { at: string; level: string; artifactId: string; override: boolean } }

// 项目经理的项目进展总览：任务、逾期、阻塞、依赖等待、里程碑、风险、各工作台状态
export async function getProjectStatus(actor: Actor, db: DB, projectId: string) {
  const detail = await getProjectDetail(actor, db, projectId);
  if (!detail) return null;
  const overview = await getProjectOverview(actor, db, projectId);
  if (!overview) return null;

  const today = localDate();
  const tasks = await db
    .select({ id: task.id, title: task.title, status: task.status, workstationId: task.workstationId, startAt: task.startAt, dueAt: task.dueAt, milestoneId: task.milestoneId, blockedReason: task.blockedReason })
    .from(task)
    .where(eq(task.projectId, projectId));
  const wsIds = detail.workstations.map((w) => w.id);
  const wsName = new Map(detail.workstations.map((w) => [w.id, w.name]));
  const deps = tasks.length > 0 ? await db.select().from(taskDependency).where(inArray(taskDependency.taskId, tasks.map((t) => t.id))) : [];
  const entities = wsIds.length > 0 ? await db.select().from(entity).where(inArray(entity.workstationId, wsIds)) : [];
  const dataOf = <T,>(e: (typeof entities)[number]) => JSON.parse(e.dataJson ?? '{}') as T;
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const byStatus: Record<string, number> = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

  const waitingOnDeps = tasks
    .filter((t) => !TERMINAL.includes(t.status as TaskStatus))
    .flatMap((t) => {
      const waitingOn = deps
        .filter((d) => d.taskId === t.id)
        .flatMap((d) => {
          const p = taskById.get(d.dependsOnId);
          return p && p.status !== 'done' ? [p.title] : [];
        });
      return waitingOn.length > 0 ? [{ id: t.id, title: t.title, waitingOn }] : [];
    });

  const signedPlans = entities
    .filter((e) => e.entityType === 'TestPlan')
    .map((e) => ({ id: e.id, d: dataOf<SignedPlanData>(e) }))
    .filter((p) => p.d.status === 'signed' && p.d.signoff && p.d.milestone)
    .sort((a, b) => b.d.signoff!.at.localeCompare(a.d.signoff!.at));

  const milestones = entities
    .filter((e) => e.entityType === 'Milestone')
    .map((e) => {
      const d = dataOf<MilestoneData>(e);
      const linked = tasks.filter((t) => t.milestoneId === e.id && t.status !== 'cancelled');
      const total = linked.length;
      const done = linked.filter((t) => t.status === 'done').length;
      const overdue = !!d.due && d.due < today && done < total;
      const dueSoon = !!d.due && d.due >= today && d.due <= addDays(today, 3);
      const openLate = linked.some((t) => t.status !== 'done' && !!t.dueAt && !!d.due && t.dueAt > d.due);
      const signed = signedPlans.find((p) => p.d.milestone === e.id);
      const qa = signed?.d.signoff ? { planId: signed.id, planName: signed.d.name ?? '', level: signed.d.signoff.level, signedAt: signed.d.signoff.at, override: signed.d.signoff.override } : null;
      const qaRisk = qa !== null && (qa.level === 'blocked' || qa.override);
      return { id: e.id, name: d.name ?? '', due: d.due ?? null, status: d.status ?? null, total, done, overdue, atRisk: !overdue && done < total && (dueSoon || openLate || qaRisk), qa };
    });

  const risks = entities
    .filter((e) => e.entityType === 'Risk')
    .map((e) => ({ id: e.id, ...dataOf<RiskData>(e) }))
    .filter((r) => r.status !== '已关闭')
    .map((r) => ({ id: r.id, title: r.title ?? '', level: r.level ?? null, status: r.status ?? null, owner: r.owner ?? null }));

  const workstations = await Promise.all(
    detail.workstations.map(async (w) => {
      const o = overview.workstations.find((x) => x.id === w.id);
      const designs = w.pluginId === 'design'
        ? (() => {
            const rows = entities.filter((e) => e.workstationId === w.id && e.entityType === 'Design').map((e) => dataOf<{ status?: string }>(e).status ?? 'draft');
            return { draft: rows.filter((s) => s === 'draft').length, approved: rows.filter((s) => s === 'approved').length, handed_off: rows.filter((s) => s === 'handed_off').length };
          })()
        : undefined;
      return {
        id: w.id,
        name: w.name,
        pluginId: w.pluginId,
        active: o?.tasks.active ?? 0,
        blocked: o?.tasks.blocked ?? 0,
        pendingReviews: o?.pendingReviews ?? 0,
        ...(w.pluginId === 'qa' ? { quality: await qaContextOf(db, w.id) } : {}),
        ...(designs ? { designs } : {}),
      };
    }),
  );

  return {
    generatedAt: new Date().toISOString(),
    today,
    tasks: { total: tasks.length, byStatus },
    overdue: tasks.filter((t) => isOverdue(t.dueAt, t.status, today)).map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt, status: t.status, workstation: wsName.get(t.workstationId) ?? null })),
    blocked: tasks.filter((t) => t.status === 'blocked' || t.status === 'escalated').map((t) => ({ id: t.id, title: t.title, reason: t.blockedReason, workstation: wsName.get(t.workstationId) ?? null })),
    waitingOnDeps,
    milestones,
    risks,
    workstations,
    inboxOpen: overview.inboxOpen,
    tokens: overview.tokens,
  };
}
