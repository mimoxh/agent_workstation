import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, artifact, block, entity, entityVersion, eventLog, project, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { getProjectDetail } from '../src/repositories/index.js';
import { freezeDesignTokens, migrateDesignWorkstations, syncWorkstations } from '../src/usecases/index.js';

const HUMAN = { type: 'human', id: 'local' } as const;
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

let db: DB;
let devId: string;

// 造一台「还没迁移」的老设计台：设计台插件已经删了，只能直接插行
async function designWs(projectId: string) {
  const id = uid();
  await db.insert(workstation).values({ id, projectId, pluginId: 'design', pluginVersion: '1.2.0', name: '设计', status: 'active', settingsJson: '{}', createdAt: now() });
  for (const [i, tpl] of ['designer', 'design-critic'].entries()) {
    await db.insert(agent).values({ id: uid(), workstationId: id, templateId: tpl, name: tpl === 'designer' ? '设计师' : '设计评审', isSteward: i === 0 ? 1 : 0, status: 'active', createdAt: now() });
  }
  return id;
}

beforeEach(async () => {
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  migrateDb(r.sqlite);
  await seed(db);
  devId = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!.id;
});

describe('设计台并入开发台', () => {
  it('有开发台时合并：实体和产物挪过去，源台归档、成员暂停、项目详情里消失，重跑幂等', async () => {
    const ds = await designWs('proj-aw');
    await db.insert(entity).values({ id: 'd1', workstationId: ds, entityType: 'Design', dataJson: '{"title":"首页"}', version: 2, createdAt: now() });
    await db.insert(entity).values({ id: 'c1', workstationId: ds, entityType: 'DesignComment', dataJson: '{"body":"b"}', createdAt: now() });
    await db.insert(entity).values({ id: 's1', workstationId: ds, entityType: 'DesignSystem', dataJson: '{"name":"sys"}', createdAt: now() });
    await db.insert(entity).values({ id: 'o1', workstationId: ds, entityType: 'Other', dataJson: '{}', createdAt: now() });
    await db.insert(artifact).values({ id: 'a1', workstationId: ds, type: 'design_handoff', name: 'h', createdAt: now() });
    await db.insert(artifact).values({ id: 'a2', workstationId: ds, type: 'screenshot', name: 's', createdAt: now() });
    await db.insert(artifact).values({ id: 'a3', workstationId: ds, type: 'doc', name: 'd', createdAt: now() });

    await migrateDesignWorkstations(db);

    const moved = await db.select().from(entity).where(eq(entity.workstationId, devId));
    expect(moved.map((e) => e.id).sort()).toEqual(['c1', 'd1', 's1']);
    expect((await db.select().from(entity).where(eq(entity.id, 'o1')))[0]!.workstationId).toBe(ds);
    expect((await db.select().from(artifact).where(eq(artifact.workstationId, devId))).map((a) => a.id).sort()).toEqual(['a1', 'a2']);

    expect((await db.select().from(workstation).where(eq(workstation.id, ds)))[0]!.status).toBe('archived');
    const agents = await db.select().from(agent).where(eq(agent.workstationId, ds));
    expect(agents.length).toBe(2);
    expect(agents.every((a) => a.status === 'paused')).toBe(true);

    const detail = await getProjectDetail(HUMAN, db, 'proj-aw');
    expect(detail!.workstations.map((w) => w.id)).not.toContain(ds);
    const ev = await db.select().from(eventLog).where(eq(eventLog.action, 'workstation_merged'));
    expect(JSON.parse(ev[0]!.payloadJson ?? '{}')).toMatchObject({ into: devId });

    await migrateDesignWorkstations(db);
    expect((await db.select().from(entity).where(eq(entity.workstationId, devId))).length).toBe(3);
    expect((await db.select().from(workstation).where(eq(workstation.id, ds)))[0]!.status).toBe('archived');
  });

  it('开发台已有设计系统时保留开发台的，源台的留原处并在事件里标记', async () => {
    await db.insert(entity).values({ id: 'ds-dev', workstationId: devId, entityType: 'DesignSystem', dataJson: '{"name":"dev-sys"}', createdAt: now() });
    const ds = await designWs('proj-aw');
    await db.insert(entity).values({ id: 'ds-old', workstationId: ds, entityType: 'DesignSystem', dataJson: '{"name":"old-sys"}', createdAt: now() });

    await migrateDesignWorkstations(db);

    expect((await db.select().from(entity).where(eq(entity.id, 'ds-old')))[0]!.workstationId).toBe(ds);
    const ev = await db.select().from(eventLog).where(eq(eventLog.action, 'workstation_merged'));
    expect(JSON.parse(ev[0]!.payloadJson ?? '{}')).toMatchObject({ into: devId, keptExistingDesignSystem: true });
  });

  it('没有开发台时就地转换：成员补成开发台编制，architect 是负责人，同步后有设计板块', async () => {
    await db.insert(project).values({ id: 'proj-x', workspaceId: 'default', name: 'x', createdAt: now() });
    const ds = await designWs('proj-x');

    await migrateDesignWorkstations(db);
    const ws = (await db.select().from(workstation).where(eq(workstation.id, ds)))[0]!;
    expect(ws).toMatchObject({ pluginId: 'dev', pluginVersion: '0.0.0', status: 'active', name: '设计' });
    expect((await db.select().from(eventLog).where(eq(eventLog.action, 'workstation_converted')))[0]!.targetId).toBe(ds);

    await syncWorkstations(db);
    const agents = await db.select().from(agent).where(eq(agent.workstationId, ds));
    expect(agents.map((a) => a.templateId).sort()).toEqual(['architect', 'backend-dev', 'case-designer', 'design-critic', 'designer', 'failure-analyst', 'frontend-dev', 'qa-lead', 'reviewer', 'test-engineer'].sort());
    expect(agents.find((a) => a.templateId === 'architect')!.isSteward).toBe(1);
    expect(agents.find((a) => a.templateId === 'designer')!.isSteward).toBe(0);
    const panels = (await db.select().from(block).where(eq(block.workstationId, ds))).map((b) => b.panelId);
    expect(panels).toEqual(expect.arrayContaining(['board', 'canvas']));
    expect(panels).not.toContain('design-system');

    await migrateDesignWorkstations(db);
    await syncWorkstations(db);
    expect((await db.select().from(agent).where(eq(agent.workstationId, ds))).length).toBe(10);
  });

  it('已归档的设计台原样保留，不参与同步', async () => {
    const ds = await designWs('proj-aw');
    await db.update(workstation).set({ status: 'archived' }).where(eq(workstation.id, ds));
    await migrateDesignWorkstations(db);
    await syncWorkstations(db);
    const ws = (await db.select().from(workstation).where(eq(workstation.id, ds)))[0]!;
    expect(ws).toMatchObject({ pluginId: 'design', status: 'archived' });
    const agents = await db.select().from(agent).where(eq(agent.workstationId, ds));
    expect(agents.every((a) => a.status === 'active')).toBe(true);
  });
});

describe('既有开发台补设计成员', () => {
  it('1.6.0 的台补设计师和评审各一次；人删过的不再恢复', async () => {
    await db.update(workstation).set({ pluginVersion: '1.6.0', settingsJson: '{"repoPath":"."}' }).where(eq(workstation.id, devId));
    await db.delete(agent).where(and(eq(agent.workstationId, devId), inArray(agent.templateId, ['designer', 'design-critic'])));

    await syncWorkstations(db);

    let agents = await db.select().from(agent).where(eq(agent.workstationId, devId));
    expect(agents.filter((a) => a.templateId === 'designer').length).toBe(1);
    expect(agents.filter((a) => a.templateId === 'design-critic').length).toBe(1);
    expect(agents.find((a) => a.templateId === 'designer')!.isSteward).toBe(0);
    const panels = (await db.select().from(block).where(eq(block.workstationId, devId))).map((b) => b.panelId);
    expect(panels).toContain('canvas');
    expect(panels).not.toContain('design-system');

    await db.delete(agent).where(and(eq(agent.workstationId, devId), eq(agent.templateId, 'designer')));
    await db.update(workstation).set({ pluginVersion: '1.6.9' }).where(eq(workstation.id, devId));
    await syncWorkstations(db);

    agents = await db.select().from(agent).where(eq(agent.workstationId, devId));
    expect(agents.some((a) => a.templateId === 'designer')).toBe(false);
    expect(agents.filter((a) => a.templateId === 'design-critic').length).toBe(1);
  });
});

describe('令牌冻结', () => {
  const put = (id: string, html: string, ws = devId) => {
    const data = JSON.stringify({ title: id, html });
    return db.insert(entity).values({ id, workstationId: ws, entityType: 'Design', dataJson: data, version: 2, createdAt: now() });
  };

  it('用到 var(-- 的旧稿冻结本台设计系统的令牌，实体和历史版本一起写；没用的记 []；幂等', async () => {
    await db.insert(entity).values({ id: 'sys', workstationId: devId, entityType: 'DesignSystem', dataJson: JSON.stringify({ tokens: [{ name: '--brand', value: '#123456' }] }), version: 1, createdAt: now() });
    await put('d-var', '<style>a{color:var(--brand)}</style>');
    await put('d-plain', '<style>a{color:red}</style>');
    await db.insert(entityVersion).values({ id: 'v1', entityId: 'd-var', version: 1, dataJson: '{"title":"d-var","html":"old var(--brand)"}', createdAt: now() });

    await freezeDesignTokens(db);

    const cur = JSON.parse((await db.select().from(entity).where(eq(entity.id, 'd-var')))[0]!.dataJson!) as { legacyTokens: { name: string }[] };
    expect(cur.legacyTokens).toEqual([{ name: '--brand', value: '#123456' }]);
    const v = JSON.parse((await db.select().from(entityVersion).where(eq(entityVersion.entityId, 'd-var')))[0]!.dataJson!) as { legacyTokens: { name: string }[] };
    expect(v.legacyTokens).toEqual(cur.legacyTokens);
    const plain = JSON.parse((await db.select().from(entity).where(eq(entity.id, 'd-plain')))[0]!.dataJson!) as { legacyTokens: unknown[] };
    expect(plain.legacyTokens).toEqual([]);
    const ev = await db.select().from(eventLog).where(and(eq(eventLog.action, 'design_tokens_frozen'), eq(eventLog.targetType, 'workstation')));
    expect(ev.length).toBe(1);
    expect(JSON.parse(ev[0]!.payloadJson ?? '{}')).toMatchObject({ count: 2 });

    await freezeDesignTokens(db);
    const ev2 = await db.select().from(eventLog).where(eq(eventLog.action, 'design_tokens_frozen'));
    expect(ev2.length).toBe(ev.length + 1);
  });

  it('没保存过设计系统的台用内置默认令牌；迁移后新写的稿子永远没有 legacyTokens', async () => {
    await put('d-old', '<style>a{color:var(--x)}</style>');
    await freezeDesignTokens(db);
    const cur = JSON.parse((await db.select().from(entity).where(eq(entity.id, 'd-old')))[0]!.dataJson!) as { legacyTokens: { name: string }[] };
    expect(cur.legacyTokens.length).toBeGreaterThan(10);
    expect(cur.legacyTokens.some((t) => t.name === '--color-text')).toBe(true);
    // 迁移只跑一次：之后写进来的新稿子（自己的 :root 变量也含 var(--）不会被误注入
    await put('d-new', '<style>:root{--y:#000}</style><style>a{color:var(--y)}</style>');
    await freezeDesignTokens(db);
    const fresh = JSON.parse((await db.select().from(entity).where(eq(entity.id, 'd-new')))[0]!.dataJson!) as Record<string, unknown>;
    expect(fresh.legacyTokens).toBeUndefined();
  });

  it('渲染注入冻结令牌：旧稿带 :root 变量，新稿不注入', async () => {
    const { composeDesignDoc } = await import('@aw/domain');
    await db.insert(entity).values({ id: 'sys2', workstationId: devId, entityType: 'DesignSystem', dataJson: JSON.stringify({ tokens: [{ name: '--brand', value: '#123456' }] }), version: 1, createdAt: now() });
    await put('d-legacy', '<style>a{color:var(--brand)}</style>');
    await put('d-fresh', '<style>a{color:red}</style>');
    await freezeDesignTokens(db);
    const legacy = JSON.parse((await db.select().from(entity).where(eq(entity.id, 'd-legacy')))[0]!.dataJson!) as { html: string; legacyTokens: { name: string; value: string }[] };
    const fresh = JSON.parse((await db.select().from(entity).where(eq(entity.id, 'd-fresh')))[0]!.dataJson!) as { html: string; legacyTokens: unknown[] };
    expect(composeDesignDoc(legacy.html, { tokens: legacy.legacyTokens, tweaks: [] })).toContain('--brand:#123456');
    expect(composeDesignDoc(fresh.html, { tokens: (fresh.legacyTokens ?? []) as never, tweaks: [] })).not.toContain('--brand:');
  });
});

describe('同步清理下线的设计系统', () => {
  it('manifest 里没有的板块删 block 行，下线的工具从 Agent toolsJson 里剥掉', async () => {
    await db.insert(block).values({ id: 'b-old', workstationId: devId, panelId: 'design-system', panelType: 'tokens', name: '设计系统', sort: 9, createdAt: now() });
    const designer = (await db.select().from(agent).where(and(eq(agent.workstationId, devId), eq(agent.templateId, 'designer'))))[0]!;
    await db.update(agent).set({ toolsJson: JSON.stringify(['read_design_system', 'update_design_system', 'write_design']) }).where(eq(agent.id, designer.id));
    // sync 只处理 pluginVersion 落后于 manifest 的台
    await db.update(workstation).set({ pluginVersion: '1.7.0' }).where(eq(workstation.id, devId));

    await syncWorkstations(db);

    const panels = (await db.select().from(block).where(eq(block.workstationId, devId))).map((b) => b.panelId);
    expect(panels).not.toContain('design-system');
    const after = (await db.select().from(agent).where(eq(agent.id, designer.id)))[0]!;
    expect(JSON.parse(after.toolsJson ?? '[]')).not.toContain('read_design_system');
    expect(JSON.parse(after.toolsJson ?? '[]')).not.toContain('update_design_system');
    expect(JSON.parse(after.toolsJson ?? '[]')).toContain('write_design');
  });
});
