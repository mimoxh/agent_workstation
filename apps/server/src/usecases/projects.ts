import type { Actor } from '@aw/domain';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { agent, artifact, pluginInstall, project, workstation } from '../db/schema.js';
import { captureScreenshot } from '../runtime/visual.js';
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

export async function createProject(actor: Actor, db: DB, input: { name: string; goal?: string | undefined; template?: DevTemplate | undefined }) {
  const id = uid();
  await db.insert(project).values({ id, workspaceId: 'default', name: input.name, goal: input.goal ?? null, status: 'active', createdAt: now() });
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

export async function updateProject(actor: Actor, db: DB, projectId: string, input: { budget?: { tokens?: number | undefined; costMicros?: number | undefined } | null | undefined }) {
  const p = (await db.select().from(project).where(eq(project.id, projectId)))[0];
  if (!p) return { kind: 'not_found' as const, status: 404 as const, error: '项目不存在' };
  if (input.budget !== undefined) await db.update(project).set({ budgetJson: input.budget ? JSON.stringify(input.budget) : null }).where(eq(project.id, projectId));
  await logEvent(db, actor, 'project_updated', 'project', projectId, {});
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
export async function takeScreenshot(db: DB, wsId: string, url: string) {
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
  return { kind: 'ok' as const, id };
}
