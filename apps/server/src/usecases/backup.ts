import fs from 'node:fs';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { agent, entity, entityVersion, message, project, proposal, run, task, thread, workstation } from '../db/schema.js';
import { manifestOf } from './core.js';

const KEEP_SNAPSHOTS = 20;

// 合并前快照（附录 B）：内存库和测试没有文件，跳过
export async function snapshotDb(db: DB, label: string) {
  const file = db.$client.name;
  if (!file || file === ':memory:' || db.$client.memory) return null;
  const dir = path.join(path.dirname(file), 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${new Date().toISOString().replaceAll(':', '-')}-${label.slice(0, 8)}.db`);
  await db.$client.backup(target);
  const old = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort().slice(0, -KEEP_SNAPSHOTS);
  for (const f of old) fs.rmSync(path.join(dir, f));
  return target;
}

export async function exportProject(db: DB, projectId: string) {
  const p = (await db.select().from(project).where(eq(project.id, projectId)))[0];
  if (!p) return null;
  const stations = await db.select().from(workstation).where(eq(workstation.projectId, projectId));
  const wsIds = stations.map((w) => w.id);
  const tasks = await db.select().from(task).where(eq(task.projectId, projectId));
  const taskIds = tasks.map((t) => t.id);
  const agents = wsIds.length ? await db.select().from(agent).where(inArray(agent.workstationId, wsIds)) : [];
  const entities = wsIds.length ? await db.select().from(entity).where(inArray(entity.workstationId, wsIds)) : [];
  const versions = entities.length ? await db.select().from(entityVersion).where(inArray(entityVersion.entityId, entities.map((e) => e.id))) : [];
  const proposals = taskIds.length ? await db.select().from(proposal).where(inArray(proposal.taskId, taskIds)) : [];
  const runs = (agents.length ? await db.select().from(run).where(inArray(run.agentId, agents.map((a) => a.id))) : []).map((r) => ({ ...r, traceJson: null }));
  const threads = await db.select().from(thread).where(inArray(thread.scopeId, [...wsIds, ...taskIds, ...agents.map((a) => a.id)]));
  const messages = threads.length ? await db.select().from(message).where(inArray(message.threadId, threads.map((t) => t.id))) : [];
  return { exportedAt: new Date().toISOString(), project: p, workstations: stations, agents, tasks, entities, entityVersions: versions, proposals, runs, threads, messages };
}

type Export = NonNullable<Awaited<ReturnType<typeof exportProject>>>;

export function exportMarkdown(e: Export) {
  const lines = [`# ${e.project.name}`, '', e.project.goal ?? '', ''];
  for (const w of e.workstations) {
    const manifest = manifestOf(w);
    lines.push(`## ${w.name}`, '');
    for (const t of e.tasks.filter((x) => x.workstationId === w.id && !x.parentId)) {
      lines.push(`- [${t.status === 'done' ? 'x' : ' '}] ${t.title}（${t.status}）`);
      for (const c of e.tasks.filter((x) => x.parentId === t.id)) lines.push(`  - [${c.status === 'done' ? 'x' : ' '}] ${c.title}（${c.status}）`);
    }
    const own = e.entities.filter((x) => x.workstationId === w.id && x.entityType !== 'TestRun');
    for (const type of new Set(own.map((x) => x.entityType))) {
      const def = manifest?.entities[type];
      lines.push('', `### ${def?.label ?? type}`, '');
      for (const row of own.filter((x) => x.entityType === type)) {
        const data = JSON.parse(row.dataJson ?? '{}') as Record<string, unknown>;
        lines.push(`#### ${String(data[def?.titleField ?? ''] ?? row.id)}（v${row.version}）`, '');
        for (const [k, v] of Object.entries(data)) lines.push(`- ${def?.fields[k]?.label ?? k}：${typeof v === 'string' ? v : JSON.stringify(v)}`);
        lines.push('');
      }
    }
    lines.push('');
  }
  const decisions = e.messages.filter((m) => m.kind === 'decision');
  if (decisions.length > 0) {
    lines.push('## 结论', '');
    for (const d of decisions) lines.push(`- ${d.createdAt.slice(0, 10)}：${d.content ?? ''}`);
  }
  return lines.join('\n');
}
