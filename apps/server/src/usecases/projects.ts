import type { Actor } from '@aw/domain';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import {
  accessGrant,
  agent,
  artifact,
  block,
  entity,
  entityVersion,
  inboxItem,
  knowledgeChunk,
  knowledgeSource,
  message,
  pluginInstall,
  project,
  proposal,
  qaCaseResult,
  qaRun,
  reviewComment,
  run,
  task,
  taskDependency,
  thread,
  threadMember,
  workstation,
} from '../db/schema.js';
import { checkFolder } from '../runtime/folder.js';
import { devSettings, removeTaskWorktree } from '../runtime/git.js';
import { cancelRun } from '../runtime/loop.js';
import { stopPreview } from '../runtime/preview.js';
import { hasPendingRuns } from '../runtime/scheduler.js';
import { captureScreenshot, diffRatio } from '../runtime/visual.js';
import { readRepoBlob } from './repo.js';
import { logEvent, manifestOf } from './core.js';
import { addAgentInstance, mountWorkstation } from './workstations.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

// 新项目自带一个 pm 根工作台，否则任务无处落地
export interface DevTemplate { repoPath: string; targetBranch?: string | undefined; baseBranch?: string | undefined; commands?: Record<string, string> | undefined }

// Q2：项目模板就是「工作台列表 + 配置」；开发项目 = pm 根台 + dev 台（两个前端实例）
async function applyDevTemplate(actor: Actor, db: DB, projectId: string, rootId: string, t: DevTemplate) {
  const dev = await mountWorkstation(actor, db, {
    projectId,
    parentId: rootId,
    pluginId: 'dev',
    name: '开发',
    settings: { repoPath: t.repoPath, targetBranch: t.targetBranch ?? 'develop', baseBranch: t.baseBranch ?? 'main', commands: t.commands ?? { build: 'pnpm build', test: 'pnpm test' } },
  });
  if (dev.kind === 'ok') await addAgentInstance(actor, db, dev.id, 'frontend-dev');
  return dev;
}

export async function createProject(actor: Actor, db: DB, input: { name: string; goal?: string | undefined; folder?: string | undefined; template?: DevTemplate | undefined }) {
  const folder = input.folder !== undefined ? checkFolder(input.folder) : null;
  if (folder && !folder.ok) return { kind: 'error' as const, status: 400 as const, error: folder.error };
  const id = uid();
  await db.insert(project).values({ id, workspaceId: 'default', name: input.name, goal: input.goal ?? null, status: 'active', ...(folder?.ok ? { folderPath: folder.root } : {}), createdAt: now() });
  const root = await mountWorkstation(actor, db, { projectId: id, parentId: null, pluginId: 'pm', name: '根' });
  if (root.kind !== 'ok') {
    await db.delete(project).where(eq(project.id, id));
    return { kind: 'error' as const, status: 400 as const, error: root.error };
  }
  if (input.template) await applyDevTemplate(actor, db, id, root.id, input.template);
  await logEvent(db, actor, 'project_created', 'project', id, {});
  return { kind: 'ok' as const, id, rootWorkstationId: root.id };
}

export async function mountChildWorkstation(
  actor: Actor,
  db: DB,
  projectId: string,
  input: { parentId?: string | undefined; pluginId: string; name: string; settings?: Record<string, unknown> | undefined },
) {
  const rows = await db.select().from(workstation).where(eq(workstation.projectId, projectId));
  if (rows.length === 0) return { kind: 'not_found' as const, status: 404 as const, error: '项目不存在' };
  const parent = input.parentId ? rows.find((w) => w.id === input.parentId) : rows.find((w) => w.parentId === null);
  if (!parent) return { kind: 'error' as const, status: 400 as const, error: '父工作台不属于该项目' };
  const r = await mountWorkstation(actor, db, {
    projectId,
    parentId: parent.id,
    pluginId: input.pluginId,
    name: input.name,
    ...(input.settings ? { settings: input.settings } : {}),
  });
  if (r.kind !== 'ok') return { kind: 'error' as const, status: 400 as const, error: r.error };
  return { kind: 'ok' as const, id: r.id };
}

export async function updateWorkstation(
  actor: Actor,
  db: DB,
  wsId: string,
  input: { name?: string | undefined; settings?: Record<string, unknown> | undefined },
) {
  const ws = (await db.select().from(workstation).where(eq(workstation.id, wsId)))[0];
  if (!ws) return { kind: 'not_found' as const, status: 404 as const, error: '工作台不存在' };
  const merged = input.settings ? { ...(JSON.parse(ws.settingsJson ?? '{}') as Record<string, unknown>), ...input.settings } : undefined;
  await db
    .update(workstation)
    .set({ ...(input.name ? { name: input.name } : {}), ...(merged ? { settingsJson: JSON.stringify(merged) } : {}) })
    .where(eq(workstation.id, wsId));
  await logEvent(db, actor, 'workstation_updated', 'workstation', wsId, {});
  return { kind: 'ok' as const };
}

export async function updateAgent(
  actor: Actor,
  db: DB,
  agentId: string,
  input: {
    name?: string | undefined;
    status?: 'active' | 'paused' | undefined;
    model?: { provider: string; name: string } | null | undefined;
    prompt?: string | null | undefined;
    tools?: string[] | undefined;
  },
) {
  const a = (await db.select().from(agent).where(eq(agent.id, agentId)))[0];
  if (!a) return { kind: 'not_found' as const, status: 404 as const, error: 'Agent 不存在' };
  const ws = (await db.select().from(workstation).where(eq(workstation.id, a.workstationId)))[0];
  const tpl = ws ? manifestOf(ws)?.agents.find((t) => t.id === a.templateId) : undefined;

  // 工具只能在模板声明的范围内收窄，不能借编辑提权
  if (input.tools && tpl) {
    const extra = input.tools.filter((t) => !tpl.tools.includes(t));
    if (extra.length > 0) return { kind: 'error' as const, status: 400 as const, error: `模板未声明这些工具：${extra.join('、')}` };
  }
  const patch: Partial<typeof agent.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.status !== undefined) patch.status = input.status;
  if (input.model !== undefined) patch.modelJson = input.model ? JSON.stringify(input.model) : null;
  if (input.prompt !== undefined) patch.prompt = input.prompt?.trim() ? input.prompt : (tpl?.promptFile ?? null);
  if (input.tools !== undefined) patch.toolsJson = JSON.stringify(input.tools);
  if (Object.keys(patch).length > 0) await db.update(agent).set(patch).where(eq(agent.id, agentId));
  await logEvent(db, actor, 'agent_updated', 'workstation', a.workstationId, { agentId, fields: Object.keys(patch) });
  return { kind: 'ok' as const, agent: (await db.select().from(agent).where(eq(agent.id, agentId)))[0]! };
}

export async function updateProject(
  actor: Actor,
  db: DB,
  projectId: string,
  input: {
    name?: string | undefined;
    goal?: string | null | undefined;
    budget?: { tokens?: number | undefined; costMicros?: number | undefined } | null | undefined;
    folder?: string | null | undefined;
  },
) {
  const p = (await db.select().from(project).where(eq(project.id, projectId)))[0];
  if (!p) return { kind: 'not_found' as const, status: 404 as const, error: '项目不存在' };
  const patch: Partial<typeof project.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.goal !== undefined) patch.goal = input.goal?.trim() ? input.goal.trim() : null;
  if (input.budget !== undefined) patch.budgetJson = input.budget ? JSON.stringify(input.budget) : null;
  if (input.folder !== undefined) {
    if (input.folder === null) patch.folderPath = null;
    else {
      const f = checkFolder(input.folder);
      if (!f.ok) return { kind: 'error' as const, status: 400 as const, error: f.error };
      patch.folderPath = f.root;
    }
  }
  if (Object.keys(patch).length > 0) await db.update(project).set(patch).where(eq(project.id, projectId));
  await logEvent(db, actor, 'project_updated', 'project', projectId, { fields: Object.keys(patch) });
  return { kind: 'ok' as const };
}

async function projectScope(db: DB, projectId: string) {
  const wsIds = (await db.select({ id: workstation.id }).from(workstation).where(eq(workstation.projectId, projectId))).map((w) => w.id);
  const agentIds = wsIds.length ? (await db.select({ id: agent.id }).from(agent).where(inArray(agent.workstationId, wsIds))).map((a) => a.id) : [];
  return { wsIds, agentIds };
}

// 归档：从控制台列表和跨项目收件箱里隐去，Agent 不再起新的 run，正在跑的取消；数据原样保留，可恢复
export async function setProjectArchived(actor: Actor, db: DB, projectId: string, archived: boolean) {
  const p = (await db.select().from(project).where(eq(project.id, projectId)))[0];
  if (!p) return { kind: 'not_found' as const, status: 404 as const, error: '项目不存在' };
  await db.update(project).set({ status: archived ? 'archived' : 'active' }).where(eq(project.id, projectId));
  let cancelled = 0;
  if (archived) {
    const { agentIds } = await projectScope(db, projectId);
    const running = agentIds.length ? await db.select({ id: run.id }).from(run).where(and(inArray(run.agentId, agentIds), eq(run.status, 'running'))) : [];
    for (const r of running) if (cancelRun(r.id)) cancelled += 1;
  }
  await logEvent(db, actor, archived ? 'project_archived' : 'project_restored', 'project', projectId, archived ? { cancelledRuns: cancelled } : {});
  return { kind: 'ok' as const, cancelled };
}

// 永久删除：只允许已归档且没有 run / 质量运行在收尾的项目；任务 worktree 尽量回收，未合并的分支留在仓库里
export async function deleteProject(actor: Actor, db: DB, projectId: string) {
  const p = (await db.select().from(project).where(eq(project.id, projectId)))[0];
  if (!p) return { kind: 'not_found' as const, status: 404 as const, error: '项目不存在' };
  if (p.status !== 'archived') return { kind: 'error' as const, status: 409 as const, error: '先归档项目，再删除' };
  const { wsIds, agentIds } = await projectScope(db, projectId);
  if (hasPendingRuns(agentIds)) return { kind: 'error' as const, status: 409 as const, error: '还有 Agent 运行在收尾，稍后再删' };
  const busyQa = wsIds.length ? await db.select({ id: qaRun.id }).from(qaRun).where(and(inArray(qaRun.workstationId, wsIds), inArray(qaRun.status, ['queued', 'running']))).limit(1) : [];
  if (busyQa.length > 0) return { kind: 'error' as const, status: 409 as const, error: '还有质量运行没结束，稍后再删' };

  const stations = await db.select().from(workstation).where(eq(workstation.projectId, projectId));
  const tasks = await db.select({ id: task.id, workstationId: task.workstationId, codeRefJson: task.codeRefJson }).from(task).where(eq(task.projectId, projectId));
  for (const t of tasks.filter((x) => x.codeRefJson)) {
    stopPreview(t.id);
    const ws = stations.find((w) => w.id === t.workstationId);
    if (ws?.pluginId === 'dev' && ws.settingsJson) await removeTaskWorktree(devSettings(ws.settingsJson), ws.id, t.id).catch(() => undefined);
  }

  const taskIds = tasks.map((t) => t.id);
  const any = (ids: string[], cond: () => SQL | undefined) => (ids.length > 0 ? cond() : undefined);
  db.transaction((tx) => {
    const sources = tx
      .select({ id: knowledgeSource.id })
      .from(knowledgeSource)
      .where(or(and(eq(knowledgeSource.scopeType, 'project'), eq(knowledgeSource.scopeId, projectId)), any(wsIds, () => and(eq(knowledgeSource.scopeType, 'workstation'), inArray(knowledgeSource.scopeId, wsIds)))))
      .all()
      .map((s) => s.id);
    if (sources.length) {
      const chunks = tx.select({ id: knowledgeChunk.id }).from(knowledgeChunk).where(inArray(knowledgeChunk.sourceId, sources)).all();
      const fts = db.$client.prepare('DELETE FROM knowledge_fts WHERE chunk_id = ?');
      for (const c of chunks) fts.run(c.id);
      tx.delete(knowledgeChunk).where(inArray(knowledgeChunk.sourceId, sources)).run();
      tx.delete(knowledgeSource).where(inArray(knowledgeSource.id, sources)).run();
    }

    const byTaskOrWs = or(any(taskIds, () => inArray(proposal.taskId, taskIds)), any(wsIds, () => inArray(proposal.workstationId, wsIds)));
    const proposals = byTaskOrWs ? tx.select({ id: proposal.id }).from(proposal).where(byTaskOrWs).all().map((x) => x.id) : [];
    if (proposals.length) {
      tx.delete(reviewComment).where(inArray(reviewComment.proposalId, proposals)).run();
      tx.delete(proposal).where(inArray(proposal.id, proposals)).run();
    }

    const scopes = [...wsIds, ...taskIds, ...agentIds];
    const threads = scopes.length ? tx.select({ id: thread.id }).from(thread).where(inArray(thread.scopeId, scopes)).all().map((x) => x.id) : [];
    if (threads.length) {
      tx.delete(message).where(inArray(message.threadId, threads)).run();
      tx.delete(threadMember).where(inArray(threadMember.threadId, threads)).run();
      tx.delete(thread).where(inArray(thread.id, threads)).run();
    }

    const runs = or(any(agentIds, () => inArray(run.agentId, agentIds)), any(taskIds, () => inArray(run.taskId, taskIds)));
    if (runs) tx.delete(run).where(runs).run();

    if (wsIds.length) {
      tx.delete(qaCaseResult).where(inArray(qaCaseResult.workstationId, wsIds)).run();
      tx.delete(qaRun).where(inArray(qaRun.workstationId, wsIds)).run();
    }
    const artifacts = or(any(wsIds, () => inArray(artifact.workstationId, wsIds)), any(taskIds, () => inArray(artifact.taskId, taskIds)));
    if (artifacts) tx.delete(artifact).where(artifacts).run();

    if (wsIds.length) {
      const entities = tx.select({ id: entity.id }).from(entity).where(inArray(entity.workstationId, wsIds)).all().map((x) => x.id);
      if (entities.length) tx.delete(entityVersion).where(inArray(entityVersion.entityId, entities)).run();
      tx.delete(entity).where(inArray(entity.workstationId, wsIds)).run();
      tx.delete(block).where(inArray(block.workstationId, wsIds)).run();
      tx.delete(agent).where(inArray(agent.workstationId, wsIds)).run();
    }

    if (taskIds.length) tx.delete(taskDependency).where(or(inArray(taskDependency.taskId, taskIds), inArray(taskDependency.dependsOnId, taskIds))).run();
    tx.delete(task).where(eq(task.projectId, projectId)).run();
    tx.delete(inboxItem).where(eq(inboxItem.projectId, projectId)).run();
    tx.delete(accessGrant).where(inArray(accessGrant.scopeId, [projectId, ...wsIds])).run();
    tx.delete(workstation).where(eq(workstation.projectId, projectId)).run();
    tx.delete(project).where(eq(project.id, projectId)).run();
  });
  await logEvent(db, actor, 'project_deleted', 'project', projectId, { name: p.name });
  return { kind: 'ok' as const };
}

export async function setPluginEnabled(actor: Actor, db: DB, pluginId: string, enabled: boolean) {
  const r = await db.update(pluginInstall).set({ enabled: enabled ? 1 : 0 }).where(eq(pluginInstall.pluginId, pluginId));
  if (r.changes === 0) return { kind: 'not_found' as const, status: 404 as const, error: '插件不存在' };
  await logEvent(db, actor, 'project_plugin_toggled', 'plugin', pluginId, { enabled });
  return { kind: 'ok' as const };
}

const SHOT_DIR = 'screenshots';

// 预览板块：给本地页面截一张图，存成产物
export async function takeScreenshot(db: DB, wsId: string, url: string, opts: { baseline?: string | undefined; branch?: string | undefined } = {}) {
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return { kind: 'error' as const, status: 400 as const, error: '只能预览本地页面' };
  const id = uid();
  const target = path.join(path.dirname(db.$client.name || '.'), SHOT_DIR, `${id}.png`);
  try {
    await captureScreenshot(parsed.href, target);
  } catch (e) {
    return { kind: 'error' as const, status: 502 as const, error: `截图失败：${e instanceof Error ? e.message.split('\n')[0] : String(e)}` };
  }
  await db.insert(artifact).values({ id, workstationId: wsId, type: 'screenshot', name: parsed.pathname, ref: target, metaJson: JSON.stringify({ url }), createdAt: now() });
  if (!opts.baseline) return { kind: 'ok' as const, id };
  // 基线从仓库（目标分支或任务分支）读出来，和这张截图做像素对比
  const blob = await readRepoBlob(db, wsId, opts.baseline, opts.branch);
  if (!blob.ok) return { kind: 'ok' as const, id, compare: { error: blob.error } };
  const baseId = uid();
  const baseTarget = path.join(path.dirname(target), `${baseId}.png`);
  fs.writeFileSync(baseTarget, blob.data);
  await db.insert(artifact).values({ id: baseId, workstationId: wsId, type: 'screenshot', name: opts.baseline, ref: baseTarget, metaJson: JSON.stringify({ baseline: opts.baseline, ref: blob.ref }), createdAt: now() });
  try {
    const ratio = diffRatio(blob.data, fs.readFileSync(target));
    return { kind: 'ok' as const, id, compare: { baselineId: baseId, ratio, ref: blob.ref } };
  } catch (e) {
    return { kind: 'ok' as const, id, compare: { baselineId: baseId, error: `对比失败：${e instanceof Error ? e.message : String(e)}` } };
  }
}
