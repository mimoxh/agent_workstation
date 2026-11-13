import type { Actor } from '@aw/domain';
import type { AgentTemplateDef, WorkbenchManifest } from '@aw/plugin-spec';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { agent, block, pluginInstall, workstation } from '../db/schema.js';
import { pluginRegistry } from '../plugins.js';
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
    settingsJson: JSON.stringify({ ...input.settings, knownTools: toolsOfManifest(manifest) }),
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

const toolsOfManifest = (m: WorkbenchManifest) => [...new Set(m.agents.flatMap((t) => t.tools))];

// 插件升级时补齐已挂载工作台：只追加新板块和这次新增的工具，人收窄过的工具不恢复
export async function syncWorkstations(db: DB) {
  const stations = await db.select().from(workstation);
  for (const ws of stations) {
    const manifest = manifestOf(ws);
    if (!manifest || ws.pluginVersion === manifest.version) continue;
    const blocks = await db.select().from(block).where(eq(block.workstationId, ws.id));
    for (const [i, p] of manifest.panels.entries()) {
      if (blocks.some((b) => b.panelId === p.id)) continue;
      await db.insert(block).values({ id: uid(), workstationId: ws.id, panelId: p.id, panelType: p.type, entityType: p.entity, name: p.title, configJson: p.config ? JSON.stringify(p.config) : null, sort: i, createdAt: now() });
    }
    const settings = JSON.parse(ws.settingsJson ?? '{}') as { knownTools?: string[] };
    const isNew = (t: string) => (settings.knownTools ? !settings.knownTools.includes(t) : ADDED_AFTER_1_0.includes(t));
    const agents = await db.select().from(agent).where(eq(agent.workstationId, ws.id));
    for (const a of agents) {
      const tpl = manifest.agents.find((t) => t.id === a.templateId);
      if (!tpl) continue;
      const tools = JSON.parse(a.toolsJson ?? '[]') as string[];
      const fresh = tpl.tools.filter((t) => isNew(t) && !tools.includes(t));
      if (fresh.length > 0) await db.update(agent).set({ toolsJson: JSON.stringify([...tools, ...fresh]) }).where(eq(agent.id, a.id));
    }
    await db.update(workstation).set({ pluginVersion: manifest.version, settingsJson: JSON.stringify({ ...settings, knownTools: toolsOfManifest(manifest) }) }).where(eq(workstation.id, ws.id));
  }
}
