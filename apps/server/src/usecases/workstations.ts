import path from 'node:path';
import type { Actor } from '@aw/domain';
import type { AgentTemplateDef, WorkbenchManifest } from '@aw/plugin-spec';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { agent, artifact, block, entity, pluginInstall, qaCaseResult, qaRun, workstation } from '../db/schema.js';
import { pluginRegistry } from '../plugins.js';
import { devSettings, git, wtRoot } from '../runtime/git.js';
import { logEvent, manifestOf } from './core.js';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

export async function mountWorkstation(
  actor: Actor,
  db: DB,
  input: { projectId: string; parentId: string | null; pluginId: string; name: string; settings?: Record<string, unknown> },
) {
  const manifest = pluginRegistry.get(input.pluginId);
  if (!manifest) return { kind: 'error' as const, error: `插件 ${input.pluginId} 未装载` };
  const install = (await db.select().from(pluginInstall).where(eq(pluginInstall.pluginId, input.pluginId)))[0];
  if (install?.enabled === 0) return { kind: 'error' as const, error: `插件 ${manifest.name} 已停用` };
  if (manifest.singleton) {
    const existing = (await db.select({ id: workstation.id }).from(workstation).where(and(eq(workstation.projectId, input.projectId), eq(workstation.pluginId, input.pluginId))))[0];
    if (existing) return { kind: 'error' as const, error: `一个项目只能有一个「${manifest.name}」` };
  }
  const wsId = uid();
  await db.insert(workstation).values({
    id: wsId,
    projectId: input.projectId,
    parentId: input.parentId,
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    name: input.name,
    status: 'active',
    settingsJson: JSON.stringify({ ...input.settings, knownTools: toolsOfManifest(manifest), knownAgents: manifest.agents.map((t) => t.id) }),
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

// 1.1.0 之前没有记录已知工具：这些是 1.0.0 之后才加入的，其余工具不在列表里说明是人收窄掉的
const ADDED_AFTER_1_0 = ['dispatch_task', 'record_decision', 'resolve_block', 'escalate_block', 'advance_stage', 'search_knowledge', 'search_workstation', 'read_entity', 'list_entities'];

// 1.7.0 之前没有记录已知 Agent 模板：这些是各插件后来才加入的，其余模板不在列表里说明是人删掉的
const ADDED_AGENTS: Record<string, string[]> = { dev: ['designer', 'design-critic', 'qa-lead', 'case-designer', 'failure-analyst'] };

const toolsOfManifest = (m: WorkbenchManifest) => [...new Set(m.agents.flatMap((t) => t.tools))];

// 插件升级时同步已挂载工作台：补新板块、新 Agent 模板和新增工具；manifest 撤掉的板块和工具也跟着撤，人收窄过的不恢复
// block 行只由挂载和同步按 manifest 生成，没有用户自建的，可以按 panelId 直接清
const REMOVED_TOOLS = ['read_design_system', 'update_design_system'];

export async function syncWorkstations(db: DB) {
  const stations = await db.select().from(workstation);
  for (const ws of stations) {
    const manifest = manifestOf(ws);
    if (!manifest || ws.status === 'archived' || ws.pluginVersion === manifest.version) continue;
    const blocks = await db.select().from(block).where(eq(block.workstationId, ws.id));
    const panelIds = new Set(manifest.panels.map((p) => p.id));
    for (const b of blocks) {
      if (b.panelId && !panelIds.has(b.panelId)) await db.delete(block).where(eq(block.id, b.id));
    }
    for (const [i, p] of manifest.panels.entries()) {
      const configJson = p.config ? JSON.stringify(p.config) : null;
      const existing = blocks.find((b) => b.panelId === p.id);
      // 板块配置（如侧栏分组）以 manifest 为准，升级时跟着改
      if (existing) {
        if (existing.configJson !== configJson) await db.update(block).set({ configJson }).where(eq(block.id, existing.id));
        continue;
      }
      await db.insert(block).values({ id: uid(), workstationId: ws.id, panelId: p.id, panelType: p.type, entityType: p.entity, name: p.title, configJson, sort: i, createdAt: now() });
    }
    const settings = JSON.parse(ws.settingsJson ?? '{}') as { knownTools?: string[]; knownAgents?: string[] };
    const isNew = (t: string) => (settings.knownTools ? !settings.knownTools.includes(t) : ADDED_AFTER_1_0.includes(t));
    const agents = await db.select().from(agent).where(eq(agent.workstationId, ws.id));
    for (const a of agents) {
      const tpl = manifest.agents.find((t) => t.id === a.templateId);
      if (!tpl) continue;
      const tools = (JSON.parse(a.toolsJson ?? '[]') as string[]).filter((t) => !REMOVED_TOOLS.includes(t));
      const fresh = tpl.tools.filter((t) => isNew(t) && !tools.includes(t));
      const next = [...tools, ...fresh];
      if (next.length !== (JSON.parse(a.toolsJson ?? '[]') as string[]).length || fresh.length > 0) await db.update(agent).set({ toolsJson: JSON.stringify(next) }).where(eq(agent.id, a.id));
    }
    const freshAgents = manifest.agents.filter((t) => (settings.knownAgents ? !settings.knownAgents.includes(t.id) : (ADDED_AGENTS[ws.pluginId ?? ''] ?? []).includes(t.id)) && !agents.some((a) => a.templateId === t.id));
    for (const tpl of freshAgents) await insertAgent(db, ws.id, tpl.id, tpl.name, tpl, manifest);
    await db.update(workstation).set({ pluginVersion: manifest.version, settingsJson: JSON.stringify({ ...settings, knownTools: toolsOfManifest(manifest), knownAgents: manifest.agents.map((t) => t.id) }) }).where(eq(workstation.id, ws.id));
  }
}

const PLATFORM: Actor = { type: 'agent', id: 'platform' };

// D29 设计台并入开发台：未归档的设计台把数据并进同项目最早的开发台后归档；项目里没有开发台时就地转成开发台，由 syncWorkstations 补板块
export async function migrateDesignWorkstations(db: DB) {
  const stations = await db.select().from(workstation).where(and(eq(workstation.pluginId, 'design'), ne(workstation.status, 'archived')));
  for (const ws of stations) {
    const dev = (await db.select().from(workstation).where(and(eq(workstation.projectId, ws.projectId), eq(workstation.pluginId, 'dev'), ne(workstation.status, 'archived')))).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (dev) {
      await db.update(entity).set({ workstationId: dev.id }).where(and(eq(entity.workstationId, ws.id), inArray(entity.entityType, ['Design', 'DesignComment'])));
      const devSystem = (await db.select({ id: entity.id }).from(entity).where(and(eq(entity.workstationId, dev.id), eq(entity.entityType, 'DesignSystem'))))[0];
      if (!devSystem) await db.update(entity).set({ workstationId: dev.id }).where(and(eq(entity.workstationId, ws.id), eq(entity.entityType, 'DesignSystem')));
      await db.update(artifact).set({ workstationId: dev.id }).where(and(eq(artifact.workstationId, ws.id), inArray(artifact.type, ['design_handoff', 'screenshot'])));
      await db.update(agent).set({ status: 'paused' }).where(eq(agent.workstationId, ws.id));
      await db.update(workstation).set({ status: 'archived' }).where(eq(workstation.id, ws.id));
      await logEvent(db, PLATFORM, 'workstation_merged', 'workstation', ws.id, { into: dev.id, ...(devSystem ? { keptExistingDesignSystem: true } : {}) });
      continue;
    }
    const manifest = pluginRegistry.get('dev');
    if (!manifest) continue;
    await db.update(workstation).set({ pluginId: 'dev', pluginVersion: '0.0.0' }).where(eq(workstation.id, ws.id));
    const existing = await db.select().from(agent).where(eq(agent.workstationId, ws.id));
    for (const a of existing) {
      if (a.isSteward === 1) await db.update(agent).set({ isSteward: 0 }).where(eq(agent.id, a.id));
    }
    for (const tpl of manifest.agents) {
      if (existing.some((a) => a.templateId === tpl.id)) continue;
      await insertAgent(db, ws.id, tpl.id, tpl.name, tpl, manifest);
    }
    await logEvent(db, PLATFORM, 'workstation_converted', 'workstation', ws.id, {});
  }
}

const QA_ENTITIES = ['TestSuite', 'TestCase', 'TestPlan', 'BugReport', 'TestQuarantine'];
const QA_ARTIFACTS = ['qa_handoff', 'qa_report'];

// D32 测试台并入开发台：未归档的测试台把质量数据并进它绑定的开发台（绑定失效时取同项目最早的开发台）后归档；
// 项目里没有开发台时就地转成开发台，板块按开发台 manifest 重建、由 syncWorkstations 补齐
export async function migrateQaWorkstations(db: DB) {
  const stations = await db.select().from(workstation).where(and(eq(workstation.pluginId, 'qa'), ne(workstation.status, 'archived')));
  for (const ws of stations) {
    const settings = JSON.parse(ws.settingsJson ?? '{}') as { sourceWorkstationId?: string } & Record<string, unknown>;
    const devs = (await db.select().from(workstation).where(and(eq(workstation.projectId, ws.projectId), eq(workstation.pluginId, 'dev'), ne(workstation.status, 'archived')))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const dev = devs.find((d) => d.id === settings.sourceWorkstationId) ?? devs[0];
    if (dev) {
      await db.update(entity).set({ workstationId: dev.id }).where(and(eq(entity.workstationId, ws.id), inArray(entity.entityType, QA_ENTITIES)));
      await db.update(qaRun).set({ workstationId: dev.id }).where(eq(qaRun.workstationId, ws.id));
      await db.update(qaCaseResult).set({ workstationId: dev.id }).where(eq(qaCaseResult.workstationId, ws.id));
      await db.update(artifact).set({ workstationId: dev.id }).where(and(eq(artifact.workstationId, ws.id), inArray(artifact.type, QA_ARTIFACTS)));
      await db.update(agent).set({ status: 'paused' }).where(eq(agent.workstationId, ws.id));
      await db.update(workstation).set({ status: 'archived' }).where(eq(workstation.id, ws.id));
      await logEvent(db, PLATFORM, 'workstation_merged', 'workstation', ws.id, { into: dev.id });
      // 测试台常驻的分离头 worktree 换到开发台目录下重建，旧的顺手清掉
      const s = devSettings(dev.settingsJson);
      if (s.repoPath && s.repoPath !== '.') await git(s.repoPath, ['worktree', 'remove', '--force', path.join(wtRoot(s.repoPath, ws.id), '_qa')]).catch(() => undefined);
      continue;
    }
    const manifest = pluginRegistry.get('dev');
    if (!manifest) continue;
    const rest = { ...settings };
    delete rest.sourceWorkstationId;
    await db.update(workstation).set({ pluginId: 'dev', pluginVersion: '0.0.0', settingsJson: JSON.stringify(rest) }).where(eq(workstation.id, ws.id));
    // 测试台的质量总览带 home，开发台默认仍是看板：旧 block 全清，sync 按开发台 manifest 重建
    await db.delete(block).where(eq(block.workstationId, ws.id));
    const existing = await db.select().from(agent).where(eq(agent.workstationId, ws.id));
    for (const a of existing) {
      if (a.isSteward === 1) await db.update(agent).set({ isSteward: 0 }).where(eq(agent.id, a.id));
    }
    for (const tpl of manifest.agents) {
      if (existing.some((a) => a.templateId === tpl.id)) continue;
      await insertAgent(db, ws.id, tpl.id, tpl.name, tpl, manifest);
    }
    await logEvent(db, PLATFORM, 'workstation_converted', 'workstation', ws.id, { from: 'qa' });
  }
}
