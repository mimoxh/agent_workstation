import { MockLanguageModelV4 } from 'ai/test';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, block, entity, inboxItem, project, run, task, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { budgetLevels } from '../src/runtime/budget.js';
import { writeModelConfig } from '../src/runtime/config.js';
import { fallbackRoutes, isRetryable, loadModels, modelRegistry, reloadModels, resolveModel } from '../src/runtime/models.js';
import { replayMessages, scheduler } from '../src/runtime/scheduler.js';
import { executeTool, type RunCtx } from '../src/runtime/tools/index.js';
import { buildPermCtx, createTaskUc, pushRunFailure, syncWorkstations } from '../src/usecases/index.js';
import { chunkText, importSource, searchKnowledge } from '../src/usecases/knowledge.js';
import { createFixtureRepo } from './fixtures.js';

const HUMAN = { type: 'human', id: 'local' } as const;
const now = () => new Date().toISOString();

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let dev: typeof workstation.$inferSelect;
let root: typeof workstation.$inferSelect;

const post = (path: string, body?: unknown, method = 'POST') =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const agentOf = async (templateId: string) =>
  (await db.select().from(agent).where(and(eq(agent.workstationId, dev.id), eq(agent.templateId, templateId))))[0]!;

async function addTask(values: Partial<typeof task.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  await db.insert(task).values({ id, projectId: 'proj-aw', workstationId: dev.id, title: 'T', inputJson: '{}', status: 'in_progress', createdAt: now(), ...values });
  return (await db.select().from(task).where(eq(task.id, id)))[0]!;
}

const addRun = (agentId: string, taskId: string, tokens: number, cost = 0) =>
  db.insert(run).values({ id: crypto.randomUUID(), agentId, taskId, status: 'completed', tokensIn: tokens, tokensOut: 0, cost, startedAt: now(), endedAt: now() });

beforeEach(async () => {
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  migrateDb(r.sqlite);
  await seed(db);
  app = createApp(db).app;
  dev = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!;
  root = (await db.select().from(workstation).where(eq(workstation.pluginId, 'pm')))[0]!;
  await loadModels();
});

afterEach(async () => {
  writeModelConfig({ providers: [], chain: [], prices: {} });
  await reloadModels();
});

describe('三级预算', () => {
  it('用量按任务子树、工作台、项目分别统计', async () => {
    const fe = await agentOf('frontend-dev');
    const parent = await addTask({ budgetJson: JSON.stringify({ tokens: 100 }) });
    const child = await addTask({ parentId: parent.id });
    await addRun(fe.id, child.id, 60);
    const levels = await budgetLevels(db, { projectId: 'proj-aw', workstationId: dev.id, taskId: parent.id });
    expect(levels.find((l) => l.scope === 'task')?.usage.tokens).toBe(60);
    expect(levels.find((l) => l.scope === 'project')?.usage.tokens).toBe(60);
  });

  it('项目预算用完后不再启动新的 run', async () => {
    const fe = await agentOf('frontend-dev');
    const t = await addTask({ assigneeType: 'agent', assigneeId: fe.id });
    await addRun(fe.id, t.id, 500);
    expect((await post('/api/projects/proj-aw', { budget: { tokens: 400 } }, 'PATCH')).status).toBe(200);
    const r = await scheduler.trigger(db, fe.id, t.id, 'manual');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('项目预算');
  });

  it('运行中超限：熔断并进收件箱，严重度最高', async () => {
    const fe = await agentOf('frontend-dev');
    const t = await addTask({ assigneeType: 'agent', assigneeId: fe.id, budgetJson: JSON.stringify({ tokens: 100 }), codeRefJson: JSON.stringify({ worktree: 'C:/none', branch: 'b', base_sha: 'x' }) });
    const r = await scheduler.trigger(db, fe.id, t.id, 'manual');
    await scheduler.idle();
    const row = (await db.select().from(run).where(eq(run.id, r.runId!)))[0]!;
    expect(row.stopReason).toBe('budget');
    const items = await db.select().from(inboxItem).where(eq(inboxItem.kind, 'budget'));
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe('critical');
    expect(await db.select().from(inboxItem).where(eq(inboxItem.kind, 'run_failed'))).toHaveLength(0);
  });

  it('配置单价后成本写入 run 并进账本', async () => {
    writeModelConfig({ providers: [], chain: [], prices: { 'mock:scripted': { input: 3, output: 15 } } });
    const fe = await agentOf('frontend-dev');
    const t = await addTask({ assigneeType: 'agent', assigneeId: fe.id, codeRefJson: JSON.stringify({ worktree: 'C:/none', branch: 'b', base_sha: 'x' }) });
    await scheduler.trigger(db, fe.id, t.id, 'mentioned');
    await scheduler.idle();
    const ledger = (await (await app.request('/api/projects/proj-aw/ledger')).json()) as { total: { costMicros: number; tokens: number }; byAgent: { label: string }[] };
    expect(ledger.total.costMicros).toBe(100 * 3 + 50 * 15);
    expect(ledger.byAgent[0]!.label).toBe(fe.name);
  });
});

describe('收件箱', () => {
  it('同一 Agent 同一任务反复失败只留一条，第 3 次升为最高优先级', async () => {
    for (const id of ['r1', 'r2', 'r3']) await pushRunFailure(db, 'proj-aw', id, 'a:t');
    const items = await db.select().from(inboxItem).where(eq(inboxItem.kind, 'run_failed'));
    expect(items).toHaveLength(1);
    expect(items[0]!.refId).toBe('r3');
    expect(items[0]!.severity).toBe('critical');
    expect(JSON.parse(items[0]!.payloadJson!).count).toBe(3);
  });

  it('列表按严重度排序', async () => {
    await db.insert(inboxItem).values([
      { id: 'n', workspaceId: 'default', projectId: 'proj-aw', kind: 'human_request', severity: 'normal', status: 'open', createdAt: '2026-01-02' },
      { id: 'c', workspaceId: 'default', projectId: 'proj-aw', kind: 'budget', severity: 'critical', status: 'open', createdAt: '2026-01-01' },
    ]);
    const rows = (await (await app.request('/api/inbox?projectId=proj-aw')).json()) as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(['c', 'n']);
  });
});

describe('模型路由', () => {
  const failing = (message: string) => new MockLanguageModelV4({ provider: 'x', modelId: 'x', doGenerate: async () => { throw new Error(message); } });

  it('Agent 指定的模型名不会被 provider 默认模型吞掉', () => {
    modelRegistry.set('p', { id: 'p:default', model: failing('x'), supportsParallelTools: true, withModel: (name) => ({ id: `p:${name}`, model: failing('x'), supportsParallelTools: true }) });
    expect(resolveModel(JSON.stringify({ provider: 'p', name: 'big' }), null)?.id).toBe('p:big');
    modelRegistry.delete('p');
  });

  it('只有限流、超时、服务不可用才降级', () => {
    expect(isRetryable({ statusCode: 429 })).toBe(true);
    expect(isRetryable({ statusCode: 503 })).toBe(true);
    expect(isRetryable({ statusCode: 400 })).toBe(false);
    expect(isRetryable(new Error('fetch failed'))).toBe(true);
    expect(isRetryable(new Error('invalid schema'))).toBe(false);
  });

  it('主模型限流时切到备用模型完成，并留下痕迹', async () => {
    const saved = modelRegistry.get('mock')!;
    modelRegistry.set('flaky', { id: 'flaky:m', model: failing('rate limit exceeded'), supportsParallelTools: true });
    writeModelConfig({ providers: [], chain: ['mock:scripted'], prices: {} });
    expect(fallbackRoutes(modelRegistry.get('flaky')!).map((r) => r.id)).toEqual(['mock:scripted']);
    const fe = await agentOf('frontend-dev');
    await db.update(agent).set({ modelJson: JSON.stringify({ provider: 'flaky', name: 'm' }) }).where(eq(agent.id, fe.id));
    const t = await addTask({ assigneeType: 'agent', assigneeId: fe.id, codeRefJson: JSON.stringify({ worktree: 'C:/none', branch: 'b', base_sha: 'x' }) });
    const r = await scheduler.trigger(db, fe.id, t.id, 'mentioned');
    await scheduler.idle();
    modelRegistry.delete('flaky');
    modelRegistry.set('mock', saved);
    const row = (await db.select().from(run).where(eq(run.id, r.runId!)))[0]!;
    expect(row.status).toBe('completed');
    expect(row.fallbackFrom).toBe('flaky:m');
    expect(`${row.provider}:${row.model}`).toBe('mock:scripted');
    expect(JSON.parse(row.traceJson!).some((s: { type: string }) => s.type === 'fallback')).toBe(true);
  });

  it('设置页保存的 provider 立即可用，读取时不回传密钥，留空沿用旧密钥', async () => {
    const body = { providers: [{ name: 'local', kind: 'ollama', model: 'qwen' }, { name: 'cloud', kind: 'openai-compatible', model: 'm', baseUrl: 'http://x', apiKey: 'sk-secret-value' }], chain: [], prices: {} };
    expect((await post('/api/settings/models', body, 'PUT')).status).toBe(200);
    const models = (await (await app.request('/api/models')).json()) as { models: { id: string; local: boolean }[] };
    expect(models.models).toEqual(expect.arrayContaining([{ id: 'local:qwen', local: true }, { id: 'cloud:m', local: false }]));
    const text = await (await app.request('/api/settings/models')).text();
    expect(text).not.toContain('sk-secret-value');
    expect(JSON.parse(text).providers[1].hasKey).toBe(true);

    await post('/api/settings/models', { ...body, providers: [{ name: 'cloud', kind: 'openai-compatible', model: 'm', baseUrl: 'http://x' }] }, 'PUT');
    expect(JSON.parse(await (await app.request('/api/settings/models')).text()).providers[0].hasKey).toBe(true);
  });
});

describe('知识库', () => {
  it('优先按标题切分，每块带标题路径', () => {
    const chunks = chunkText('# 总则\n开头\n## 命名\n用驼峰\n## 提交\n写清楚');
    expect(chunks.map((c) => c.anchor.headingPath)).toEqual([['总则'], ['总则', '命名'], ['总则', '提交']]);
  });

  it('超长段落按长度切分并带重叠', () => {
    const chunks = chunkText('字'.repeat(2000));
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[1]!.anchor.offset).toBe(700);
  });

  it('中文短词和长词都能检索，结果带可追溯的引用', async () => {
    await importSource(HUMAN, db, { projectId: 'proj-aw', name: '规范.md', kind: 'md', content: '# 看板规范\n筛选状态必须放进 URL 参数\n## 配色\n琥珀色表示等人' });
    const long = await searchKnowledge(db, { projectId: 'proj-aw' }, 'URL 参数');
    expect(long[0]?.sourceName).toBe('规范.md');
    expect(long[0]?.citation).toMatch(/^\[\[kb:/);
    const short = await searchKnowledge(db, { projectId: 'proj-aw' }, '配色');
    expect(short).toHaveLength(0);
    const shortBody = await searchKnowledge(db, { projectId: 'proj-aw' }, '琥珀');
    expect(shortBody[0]?.anchor.headingPath).toEqual(['看板规范', '配色']);
  });

  it('工作台级来源对其他工作台不可见', async () => {
    await importSource(HUMAN, db, { projectId: 'proj-aw', workstationId: dev.id, name: '开发笔记', kind: 'note', content: '只给开发台看的内容' });
    expect(await searchKnowledge(db, { projectId: 'proj-aw', workstationId: root.id }, '开发台看')).toHaveLength(0);
    expect(await searchKnowledge(db, { projectId: 'proj-aw', workstationId: dev.id }, '开发台看')).toHaveLength(1);
  });

  it('Agent 通过工具检索，删除来源后不再命中', async () => {
    const r = await importSource(HUMAN, db, { projectId: 'proj-aw', name: 'a.md', kind: 'md', content: '接口统一返回错误字段' });
    const a = await agentOf('frontend-dev');
    const actor = { type: 'agent', id: a.id } as const;
    const ctx: RunCtx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: null, run: { id: 'r' } as never };
    const hits = (await executeTool(ctx, 'search_knowledge', { query: '错误字段' })) as { hits: { citation: string }[] };
    expect(hits.hits).toHaveLength(1);
    expect((await post(`/api/knowledge/${r.kind === 'ok' ? r.id : ''}`, undefined, 'DELETE')).status).toBe(200);
    expect(((await executeTool(ctx, 'search_knowledge', { query: '错误字段' })) as { hits: unknown[] }).hits).toHaveLength(0);
  });
});

describe('数据可带走', () => {
  it('实体回滚是一次新版本，旧版本都还在', async () => {
    const id = crypto.randomUUID();
    const res = await post(`/api/workstations/${dev.id}/entities`, { entityType: 'ADR', data: { title: '一' } });
    const created = (await res.json()) as { id: string };
    void id;
    await post(`/api/entities/${created.id}`, { data: { title: '二' }, baseVersion: 1 }, 'PATCH');
    const r = await post(`/api/entities/${created.id}/rollback`, { version: 1 });
    expect(await r.json()).toEqual({ version: 3 });
    const row = (await db.select().from(entity).where(eq(entity.id, created.id)))[0]!;
    expect(JSON.parse(row.dataJson!).title).toBe('一');
    expect(((await (await app.request(`/api/entities/${created.id}/versions`)).json()) as unknown[])).toHaveLength(3);
  });

  it('导出全量 JSON 与 Markdown，不包含运行轨迹', async () => {
    await createTaskUc(HUMAN, db, root.id, { title: '导出任务' });
    await db.insert(run).values({ id: 'rx', agentId: (await agentOf('architect')).id, status: 'completed', traceJson: '["secret-trace"]', startedAt: now() });
    const json = await (await app.request('/api/projects/proj-aw/export')).text();
    expect(json).toContain('导出任务');
    expect(json).not.toContain('secret-trace');
    expect(await (await app.request('/api/projects/proj-aw/export?format=md')).text()).toContain('- [ ] 导出任务');
  });
});

describe('新建项目', () => {
  it('开发项目模板一次挂好 pm + dev 和两个前端实例', async () => {
    const res = await post('/api/projects', { name: '模板项目', template: { repoPath: createFixtureRepo(), commands: { build: 'node check.js' } } });
    const { id } = (await res.json()) as { id: string };
    const stations = await db.select().from(workstation).where(eq(workstation.projectId, id));
    expect(stations.map((w) => w.pluginId).sort()).toEqual(['dev', 'pm']);
    const devWs = stations.find((w) => w.pluginId === 'dev')!;
    const fes = await db.select().from(agent).where(and(eq(agent.workstationId, devWs.id), eq(agent.templateId, 'frontend-dev')));
    expect(fes).toHaveLength(2);
    expect(JSON.parse(devWs.settingsJson!).commands).toEqual({ build: 'node check.js' });
  });

  it('停用的插件不能再挂载', async () => {
    expect((await post('/api/plugins/dev', { enabled: false }, 'PATCH')).status).toBe(200);
    const list = (await (await app.request('/api/plugins')).json()) as { id: string; enabled: boolean }[];
    expect(list.find((p) => p.id === 'dev')?.enabled).toBe(false);
    expect((await post('/api/projects/proj-aw/workstations', { pluginId: 'dev', name: '第二台' })).status).toBe(400);
  });
});

describe('插件升级', () => {
  it('补齐新板块和新工具，不恢复人收窄掉的旧工具', async () => {
    const architect = await agentOf('architect');
    await db.delete(block).where(and(eq(block.workstationId, dev.id), eq(block.panelId, 'knowledge')));
    await db.update(workstation).set({ pluginVersion: '1.0.0', settingsJson: JSON.stringify({ repoPath: '.' }) }).where(eq(workstation.id, dev.id));
    await db.update(agent).set({ toolsJson: JSON.stringify(['read_entity', 'send_message']) }).where(eq(agent.id, architect.id));

    await syncWorkstations(db);

    const tools = JSON.parse((await db.select().from(agent).where(eq(agent.id, architect.id)))[0]!.toolsJson!) as string[];
    expect(tools).toContain('resolve_block');
    expect(tools).toContain('search_knowledge');
    expect(tools).not.toContain('git_diff');
    expect((await db.select().from(block).where(and(eq(block.workstationId, dev.id), eq(block.panelId, 'knowledge'))))).toHaveLength(1);
    expect((await db.select().from(workstation).where(eq(workstation.id, dev.id)))[0]!.pluginVersion).toBe('1.2.0');
  });
});

describe('从某一步重试', () => {
  const trace = [
    { type: 'model', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a' } }] },
    { type: 'tool', name: 'read_file', result: { content: 'x' } },
    { type: 'model', toolCalls: [{ id: 'c2', name: 'apply_patch', args: {} }] },
    { type: 'tool', name: 'apply_patch', result: { error: '失败' } },
  ];

  it('回放到该步之前的完整轮次', () => {
    const m = replayMessages(trace, 2);
    expect(m.map((x) => x.role)).toEqual(['assistant', 'tool']);
    expect(JSON.stringify(m)).toContain('read_file');
    expect(JSON.stringify(m)).not.toContain('apply_patch');
  });

  it('停在一轮中间时丢掉这一轮，不留下没有结果的工具调用', () => {
    expect(replayMessages(trace, 3).map((x) => x.role)).toEqual(['assistant', 'tool']);
    expect(replayMessages(trace, 1)).toEqual([]);
  });

  it('讨论里的运行不能这样重试', async () => {
    await db.insert(run).values({ id: 'rt', agentId: (await agentOf('architect')).id, status: 'completed', startedAt: now() });
    expect((await post('/api/runs/rt/retry', { step: 0 })).status).toBe(400);
  });
});

describe('项目数据', () => {
  it('预算写入项目并出现在概览', async () => {
    await post('/api/projects/proj-aw', { budget: { tokens: 1000 } }, 'PATCH');
    expect((await db.select().from(project).where(eq(project.id, 'proj-aw')))[0]!.budgetJson).toContain('1000');
    const o = (await (await app.request('/api/projects/proj-aw/overview')).json()) as { budget: { tokens: number } };
    expect(o.budget.tokens).toBe(1000);
  });
});

describe('可执行验收', () => {
  const page = (text: string) => `data:text/html,<body style="margin:0;background:white"><h1>${text}</h1></body>`;

  it('visual：与基线一致通过，差异超限失败，缺基线报错', async () => {
    const { captureScreenshot, runVisualCheck } = await import('../src/runtime/visual.js');
    const repo = createFixtureRepo();
    await captureScreenshot(page('same'), `${repo}/shots/home.png`);

    const same = await runVisualCheck(repo, { url: page('same'), baseline: 'shots/home.png', maxDiff: 0.001 });
    expect([same.status, same.ratio]).toEqual(['passed', 0]);

    const changed = await runVisualCheck(repo, { url: page('a much longer heading that changes pixels'), baseline: 'shots/home.png', maxDiff: 0 });
    expect(changed.status).toBe('failed');
    expect(changed.ratio).toBeGreaterThan(0);

    expect((await runVisualCheck(repo, { url: page('x'), baseline: 'shots/none.png', maxDiff: 0 })).status).toBe('error');
    expect((await runVisualCheck(repo, { url: page('x'), baseline: '../outside.png', maxDiff: 0 })).status).toBe('error');
  }, 60000);

  it('run_tests 跑任务验收并留下 TestRun 证据', async () => {
    const repo = createFixtureRepo();
    const engineer = await agentOf('test-engineer');
    const t = await addTask({ acceptanceJson: JSON.stringify([{ kind: 'command', run: 'node check.js' }]), codeRefJson: JSON.stringify({ worktree: repo, branch: 'b', base_sha: 'x' }) });
    const actor = { type: 'agent', id: engineer.id } as const;
    const ctx: RunCtx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: engineer, task: t, run: { id: 'r' } as never };
    const r = (await executeTool(ctx, 'run_tests', {})) as { allPassed: boolean };
    expect(r.allPassed).toBe(true);
    expect(await db.select().from(entity).where(eq(entity.entityType, 'TestRun'))).toHaveLength(1);
  });

  it('capture_screenshot 只能截本地页面', async () => {
    const repo = createFixtureRepo();
    const engineer = await agentOf('test-engineer');
    const t = await addTask({ codeRefJson: JSON.stringify({ worktree: repo, branch: 'b', base_sha: 'x' }) });
    const actor = { type: 'agent', id: engineer.id } as const;
    const ctx: RunCtx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: engineer, task: t, run: { id: 'r' } as never };
    const r = (await executeTool(ctx, 'capture_screenshot', { url: 'https://example.com/', path: 'a.png' })) as { error?: string };
    expect(r.error).toContain('本地');
  });
});
