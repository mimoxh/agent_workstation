import type { Actor } from '@aw/domain';
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { agent, block, eventLog, inboxItem, project, task, workstation } from '../db/schema.js';
import { buildPermCtx, manifestOf, visibleTaskFilter } from '../usecases/index.js';

// M0.1 不做权限过滤；M0.2 起读路径走 can()：
// human 全通过；agent 按 §4.2 过滤可见工作台。

async function visibleWsIds(actor: Actor, db: DB): Promise<string[] | null> {
  const ctx = await buildPermCtx(actor, db);
  return visibleTaskFilter(ctx, actor);
}

export async function listProjects(actor: Actor, db: DB) {
  void actor;
  return db.select().from(project);
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
  return { ...p, workstations };
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
    blocks,
    agents,
    manifest: manifest
      ? { id: manifest.id, name: manifest.name, panels: manifest.panels, stages: manifest.stages ?? [], tasks: manifest.tasks.map((t) => ({ id: t.id, name: t.name, inputSchema: t.inputSchema, stages: t.stages })) }
      : null,
  };
}

export async function listTasks(actor: Actor, db: DB, workstationId: string) {
  const visible = await visibleWsIds(actor, db);
  if (visible && !visible.includes(workstationId)) return [];
  return db.select().from(task).where(eq(task.workstationId, workstationId));
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
  return { task: t, parent, children, events: events.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
}

export async function listInbox(actor: Actor, db: DB, status = 'open') {
  void actor;
  return db.select().from(inboxItem).where(eq(inboxItem.status, status));
}

export { and, eq, inArray };
