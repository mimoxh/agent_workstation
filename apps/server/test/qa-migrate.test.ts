import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, artifact, block, entity, eventLog, project, qaCaseResult, qaRun, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { getProjectDetail } from '../src/repositories/index.js';
import { migrateQaWorkstations, syncWorkstations } from '../src/usecases/index.js';

const HUMAN = { type: 'human', id: 'local' } as const;
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

let db: DB;
let devId: string;

// 造一台「还没迁移」的老测试台：测试台插件已经删了，只能直接插行
async function qaWs(projectId: string, settings: Record<string, unknown> = {}) {
  const id = uid();
  await db.insert(workstation).values({ id, projectId, pluginId: 'qa', pluginVersion: '1.3.0', name: '测试', status: 'active', settingsJson: JSON.stringify(settings), createdAt: now() });
  for (const [i, [tpl, name]] of [['qa-lead', '测试负责人'], ['case-designer', '用例设计'], ['failure-analyst', '失败分析']].entries()) {
    await db.insert(agent).values({ id: uid(), workstationId: id, templateId: tpl!, name: name!, isSteward: i === 0 ? 1 : 0, status: 'active', createdAt: now() });
  }
  await db.insert(block).values({ id: uid(), workstationId: id, panelId: 'overview', panelType: 'quality', name: '质量总览', configJson: '{"view":"overview","home":true}', sort: 0, createdAt: now() });
  return id;
}

async function seedQaData(ws: string) {
  await db.insert(entity).values({ id: 'suite1', workstationId: ws, entityType: 'TestSuite', dataJson: '{"name":"单测"}', createdAt: now() });
  await db.insert(entity).values({ id: 'case1', workstationId: ws, entityType: 'TestCase', dataJson: '{"title":"登录"}', createdAt: now() });
  await db.insert(entity).values({ id: 'plan1', workstationId: ws, entityType: 'TestPlan', dataJson: '{"name":"回归"}', createdAt: now() });
  await db.insert(entity).values({ id: 'bug1', workstationId: ws, entityType: 'BugReport', dataJson: '{"title":"崩溃"}', createdAt: now() });
  await db.insert(entity).values({ id: 'q1', workstationId: ws, entityType: 'TestQuarantine', dataJson: '{"name":"w"}', createdAt: now() });
  await db.insert(entity).values({ id: 'o1', workstationId: ws, entityType: 'Other', dataJson: '{}', createdAt: now() });
  await db.insert(qaRun).values({ id: 'run1', workstationId: ws, suiteId: 'suite1', suiteName: '单测', configJson: '{}', ref: 'develop', commitSha: 'abc', status: 'passed', trigger: 'human', createdAt: now() });
  await db.insert(qaCaseResult).values({ id: 'cr1', runId: 'run1', workstationId: ws, suiteId: 'suite1', caseKey: 'k', classname: 'c', name: 'a', status: 'passed', commitSha: 'abc', createdAt: now() });
  await db.insert(artifact).values({ id: 'a1', workstationId: ws, type: 'qa_handoff', name: 'h', createdAt: now() });
  await db.insert(artifact).values({ id: 'a2', workstationId: ws, type: 'qa_report', name: 'r', createdAt: now() });
  await db.insert(artifact).values({ id: 'a3', workstationId: ws, type: 'doc', name: 'd', createdAt: now() });
}

beforeEach(async () => {
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  migrateDb(r.sqlite);
  await seed(db);
  devId = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!.id;
});

describe('测试台并入开发台', () => {
  it('有开发台时合并：质量实体、运行、逐用例结果和产物挪过去，源台归档、成员暂停，重跑幂等', async () => {
    const qs = await qaWs('proj-aw', { sourceWorkstationId: devId });
    await seedQaData(qs);

    await migrateQaWorkstations(db);

    const moved = (await db.select().from(entity).where(eq(entity.workstationId, devId))).map((e) => e.id);
    expect(moved).toEqual(expect.arrayContaining(['suite1', 'case1', 'plan1', 'bug1', 'q1']));
    expect((await db.select().from(entity).where(eq(entity.id, 'o1')))[0]!.workstationId).toBe(qs);
    expect((await db.select().from(qaRun).where(eq(qaRun.id, 'run1')))[0]!.workstationId).toBe(devId);
    expect((await db.select().from(qaCaseResult).where(eq(qaCaseResult.id, 'cr1')))[0]!.workstationId).toBe(devId);
    expect((await db.select().from(artifact).where(eq(artifact.workstationId, devId))).map((a) => a.id).sort()).toEqual(['a1', 'a2']);

    expect((await db.select().from(workstation).where(eq(workstation.id, qs)))[0]!.status).toBe('archived');
    const agents = await db.select().from(agent).where(eq(agent.workstationId, qs));
    expect(agents.every((a) => a.status === 'paused')).toBe(true);
    const detail = await getProjectDetail(HUMAN, db, 'proj-aw');
    expect(detail!.workstations.map((w) => w.id)).not.toContain(qs);
    const ev = await db.select().from(eventLog).where(eq(eventLog.action, 'workstation_merged'));
    expect(JSON.parse(ev[0]!.payloadJson ?? '{}')).toMatchObject({ into: devId });

    await migrateQaWorkstations(db);
    expect(await db.select().from(eventLog).where(eq(eventLog.action, 'workstation_merged'))).toHaveLength(1);
  });

  it('绑定的开发台还在就并进它，不在就并进最早的开发台', async () => {
    await new Promise((r) => setTimeout(r, 5));
    const later = uid();
    await db.insert(workstation).values({ id: later, projectId: 'proj-aw', pluginId: 'dev', pluginVersion: '1.9.0', name: '开发二', status: 'active', settingsJson: '{}', createdAt: now() });
    const bound = await qaWs('proj-aw', { sourceWorkstationId: later });
    await db.insert(entity).values({ id: 's-bound', workstationId: bound, entityType: 'TestSuite', dataJson: '{}', createdAt: now() });
    const stale = await qaWs('proj-aw', { sourceWorkstationId: 'gone' });
    await db.insert(entity).values({ id: 's-stale', workstationId: stale, entityType: 'TestSuite', dataJson: '{}', createdAt: now() });

    await migrateQaWorkstations(db);

    expect((await db.select().from(entity).where(eq(entity.id, 's-bound')))[0]!.workstationId).toBe(later);
    expect((await db.select().from(entity).where(eq(entity.id, 's-stale')))[0]!.workstationId).toBe(devId);
  });

  it('没有开发台时就地转换：去掉来源设置，板块按开发台重建，成员补齐且 architect 是负责人', async () => {
    await db.insert(project).values({ id: 'proj-x', workspaceId: 'default', name: 'x', createdAt: now() });
    const qs = await qaWs('proj-x', { sourceWorkstationId: 'gone', keep: 1 });
    await db.insert(entity).values({ id: 'sx', workstationId: qs, entityType: 'TestSuite', dataJson: '{}', createdAt: now() });

    await migrateQaWorkstations(db);
    const ws = (await db.select().from(workstation).where(eq(workstation.id, qs)))[0]!;
    expect(ws).toMatchObject({ pluginId: 'dev', pluginVersion: '0.0.0', status: 'active', name: '测试' });
    expect(JSON.parse(ws.settingsJson!)).toEqual({ keep: 1 });
    expect((await db.select().from(eventLog).where(eq(eventLog.action, 'workstation_converted')))[0]!.targetId).toBe(qs);
    expect((await db.select().from(entity).where(eq(entity.id, 'sx')))[0]!.workstationId).toBe(qs);

    await syncWorkstations(db);
    const agents = await db.select().from(agent).where(eq(agent.workstationId, qs));
    const templates = agents.map((a) => a.templateId);
    expect(templates).toEqual(expect.arrayContaining(['architect', 'test-engineer', 'qa-lead', 'case-designer', 'failure-analyst', 'designer']));
    expect(new Set(templates).size).toBe(templates.length);
    expect(agents.filter((a) => a.isSteward === 1).map((a) => a.templateId)).toEqual(['architect']);
    const blocks = await db.select().from(block).where(eq(block.workstationId, qs));
    expect(blocks.map((b) => b.panelId)).toEqual(expect.arrayContaining(['board', 'runs', 'overview', 'bugs']));
    expect(blocks.some((b) => (b.configJson ?? '').includes('"home"'))).toBe(false);

    const count = agents.length;
    await migrateQaWorkstations(db);
    await syncWorkstations(db);
    expect(await db.select().from(agent).where(eq(agent.workstationId, qs))).toHaveLength(count);
  });

  it('已归档的测试台原样保留', async () => {
    const qs = await qaWs('proj-aw');
    await db.update(workstation).set({ status: 'archived' }).where(eq(workstation.id, qs));
    await migrateQaWorkstations(db);
    await syncWorkstations(db);
    expect((await db.select().from(workstation).where(eq(workstation.id, qs)))[0]).toMatchObject({ pluginId: 'qa', status: 'archived' });
    expect((await db.select().from(agent).where(and(eq(agent.workstationId, qs), eq(agent.status, 'active'))))).toHaveLength(3);
  });
});

describe('既有开发台补质量成员与板块', () => {
  it('1.8.x 的台同步后有三个质量成员、质量板块，旧的测试结果板块撤掉，分组改为「测试」', async () => {
    await db.update(workstation).set({ pluginVersion: '1.8.0', settingsJson: '{"repoPath":"."}' }).where(eq(workstation.id, devId));
    await db.delete(agent).where(eq(agent.workstationId, devId));
    await db.insert(agent).values({ id: uid(), workstationId: devId, templateId: 'architect', name: '架构师', isSteward: 1, status: 'active', createdAt: now() });
    await db.delete(block).where(eq(block.workstationId, devId));
    await db.insert(block).values({ id: 'b-tests', workstationId: devId, panelId: 'tests', panelType: 'table', entityType: 'TestRun', name: '测试结果', sort: 2, createdAt: now() });
    await db.insert(block).values({ id: 'b-bugs', workstationId: devId, panelId: 'bugs', panelType: 'quality', entityType: 'BugReport', name: '缺陷', configJson: '{"view":"bugs","group":"质量"}', sort: 3, createdAt: now() });

    await syncWorkstations(db);

    const templates = (await db.select().from(agent).where(eq(agent.workstationId, devId))).map((a) => a.templateId);
    expect(templates).toEqual(expect.arrayContaining(['qa-lead', 'case-designer', 'failure-analyst']));
    const blocks = await db.select().from(block).where(eq(block.workstationId, devId));
    expect(blocks.map((b) => b.panelId)).not.toContain('tests');
    const runs = blocks.find((b) => b.panelId === 'runs')!;
    expect(JSON.parse(runs.configJson!)).toMatchObject({ view: 'runs', group: '测试' });
    // 已有板块的旧分组名跟着 manifest 改
    expect(JSON.parse(blocks.find((b) => b.id === 'b-bugs')!.configJson!)).toMatchObject({ view: 'bugs', group: '测试' });
  });
});
