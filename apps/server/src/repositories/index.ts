import type { Actor, TaskEvent } from '@aw/domain';
import { transition } from '@aw/domain';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { project, task, workstation } from '../db/schema.js';

// M0.1 不做权限过滤；M0.2 在这里接 packages/domain 的 can()，
// 所有查询都必须带 actor 参数（类型层面强制），不得缺省。

export async function listProjects(actor: Actor, db: DB) {
  void actor;
  return db.select().from(project);
}

export async function getProjectDetail(actor: Actor, db: DB, projectId: string) {
  void actor;
  const rows = await db.select().from(project).where(eq(project.id, projectId));
  const p = rows[0];
  if (!p) return null;
  const workstations = await db
    .select()
    .from(workstation)
    .where(eq(workstation.projectId, projectId));
  return { ...p, workstations };
}

export async function listTasks(actor: Actor, db: DB, workstationId: string) {
  void actor;
  return db.select().from(task).where(eq(task.workstationId, workstationId));
}

export async function createTask(
  actor: Actor,
  db: DB,
  workstationId: string,
  input: { title: string; intent?: string | undefined; module?: string | undefined },
) {
  void actor;
  const wsRows = await db.select().from(workstation).where(eq(workstation.id, workstationId));
  const ws = wsRows[0];
  if (!ws) return null;
  const id = crypto.randomUUID();
  const inputJson = input.module ? JSON.stringify({ module: input.module }) : null;
  await db.insert(task).values({
    id,
    projectId: ws.projectId,
    workstationId,
    typeId: 'dev.issue',
    title: input.title,
    intent: input.intent ?? null,
    inputJson,
    status: 'draft',
    createdAt: new Date().toISOString(),
  });
  const rows = await db.select().from(task).where(eq(task.id, id));
  return rows[0];
}

export async function transitionTask(actor: Actor, db: DB, taskId: string, event: TaskEvent) {
  void actor;
  const rows = await db.select().from(task).where(eq(task.id, taskId));
  const t = rows[0];
  if (!t) return { kind: 'not_found' as const };
  const result = transition(t.status as Parameters<typeof transition>[0], event);
  if (!result.ok) return { kind: 'invalid' as const, error: result.error };
  // 乐观并发：WHERE 条件带上读到的旧状态，0 行受影响 = 被别人抢先改了
  const changed = await db
    .update(task)
    .set({ status: result.to })
    .where(and(eq(task.id, taskId), eq(task.status, t.status)));
  if (changed.changes === 0) return { kind: 'conflict' as const };
  const updated = await db.select().from(task).where(eq(task.id, taskId));
  return { kind: 'ok' as const, task: updated[0] };
}
