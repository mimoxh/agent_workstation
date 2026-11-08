import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, entity, entityVersion, message, task, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { conversationIdle } from '../src/runtime/conversation.js';
import { loadModels } from '../src/runtime/models.js';
import { scheduler, startScheduler } from '../src/runtime/scheduler.js';
import { executeTool, type RunCtx } from '../src/runtime/tools/index.js';
import { buildPermCtx, mountWorkstation } from '../src/usecases/index.js';
import { postThreadMessage, wsThreadOf } from '../src/usecases/threads.js';

const HUMAN = { type: 'human', id: 'local' } as const;

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let wsId: string;
let devId: string;
let stop: () => void;

const req = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function settle() {
  for (let quiet = 0; quiet < 3;) {
    await new Promise((r) => setTimeout(r, 20));
    await scheduler.idle();
    quiet = conversationIdle() ? quiet + 1 : 0;
  }
}

const agentOf = async (templateId: string, ws = wsId) => (await db.select().from(agent).where(and(eq(agent.workstationId, ws), eq(agent.templateId, templateId))))[0]!;

async function ctxOf(a: typeof agent.$inferSelect, t: typeof task.$inferSelect | null = null): Promise<RunCtx> {
  const actor = { type: 'agent', id: a.id } as const;
  return { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: t, run: { id: 'r' } as never };
}

interface ToolReply { id: string; commentId: string; html: string; status: string; designs: unknown[]; warnings: string[]; error?: string }

const call = async (name: string, args: Record<string, unknown>, template = 'designer') => (await executeTool(await ctxOf(await agentOf(template)), name, args)) as ToolReply;

const PAGE = '<!doctype html><html><head><style>h1{color:var(--color-text)}</style></head><body><h1>标题</h1></body></html>';

beforeEach(async () => {
  process.env.AW_ENABLE_MOCK = '1';
  process.env.AW_DEFAULT_MODEL = 'mock:scripted';
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  migrateDb(r.sqlite);
  await seed(db);
  app = createApp(db).app;
  const root = (await db.select().from(workstation).where(eq(workstation.pluginId, 'pm')))[0]!;
  devId = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!.id;
  const m = await mountWorkstation(HUMAN, db, { projectId: 'proj-aw', parentId: root.id, pluginId: 'design', name: '设计' });
  if (m.kind !== 'ok') throw new Error(m.error);
  wsId = m.id;
  await loadModels();
  stop = startScheduler(db);
});

afterEach(() => stop());

describe('设计稿工具', () => {
  it('write_design 建稿留版本，edit_design 局部修改产生新版本', async () => {
    const created = await call('write_design', { title: '首页', html: PAGE, reason: '初稿' });
    expect(created).toMatchObject({ version: 1, warnings: [] });
    const edited = await call('edit_design', { id: created.id, edits: [{ oldText: '<h1>标题</h1>', newText: '<h1>新标题</h1>' }], reason: '改标题' });
    expect(edited).toMatchObject({ version: 2 });
    const read = await call('read_design', { id: created.id });
    expect(read.html).toContain('新标题');
    expect((await call('read_design', { id: created.id, version: 1 })).html).toContain('<h1>标题</h1>');
    const versions = await db.select().from(entityVersion).where(eq(entityVersion.entityId, created.id));
    expect(versions.map((v) => v.reason).sort()).toEqual(['初稿', '改标题']);
  });

  it('自检结果回给模型；原文不唯一时不写入', async () => {
    const r = await call('write_design', { title: 'x', html: '<style>a{color:var(--nope)}</style><p>a</p><p>a</p>' });
    expect(String(r.warnings)).toContain('--nope');
    expect((await call('edit_design', { id: r.id, edits: [{ oldText: '<p>a</p>', newText: 'b' }] })).error).toContain('不唯一');
    expect((await db.select().from(entity).where(eq(entity.id, r.id)))[0]!.version).toBe(1);
  });

  it('改过的定稿回到草稿', async () => {
    const r = await call('write_design', { title: 'x', html: PAGE });
    const row = (await db.select().from(entity).where(eq(entity.id, r.id)))[0]!;
    await req('PATCH', `/api/entities/${r.id}`, { data: { ...JSON.parse(row.dataJson!), status: 'approved' }, baseVersion: 1 });
    await call('edit_design', { id: r.id, edits: [{ oldText: '标题', newText: '题' }] });
    expect((await call('read_design', { id: r.id })).status).toBe('draft');
  });

  it('稿子、评论都隔离在本台', async () => {
    const r = await call('write_design', { title: 'x', html: PAGE });
    const dev = await ctxOf(await agentOf('architect', devId));
    expect(await executeTool(dev, 'read_design', { id: r.id })).toEqual({ error: '设计稿不存在' });
    expect(await executeTool(dev, 'edit_design', { id: r.id, edits: [] })).toEqual({ error: '设计稿不存在' });
  });

  it('评审钉评论，设计师解决', async () => {
    const r = await call('write_design', { title: 'x', html: PAGE });
    const c = await call('comment_design', { designId: r.id, selector: 'body > h1:nth-child(1)', body: '对比度不够' }, 'design-critic');
    expect((await call('list_designs', {})).designs).toMatchObject([{ id: r.id, openComments: 1 }]);
    expect(await call('resolve_design_comments', { ids: [c.commentId], note: '已加深' })).toEqual({ resolved: 1 });
    expect((await call('list_designs', {})).designs).toMatchObject([{ openComments: 0 }]);
  });

  it('整份稿子不被默认的工具结果上限截断', async () => {
    const big = `<!doctype html><html><head></head><body>${'<p>内容</p>'.repeat(3000)}</body></html>`;
    const r = await call('write_design', { title: 'big', html: big });
    const { allTools } = await import('../src/runtime/tools/index.js');
    expect(JSON.stringify(await call('read_design', { id: r.id })).length).toBeLessThan(allTools().read_design!.resultLimit!);
  });
});

describe('设计系统', () => {
  const tokensOf = async () => (await (await req('GET', `/api/workstations/${wsId}/design-system`)).json()) as { id: string | null; version: number; tokens: { name: string; value: string }[] };

  it('没保存过时给默认令牌，保存后可回滚', async () => {
    const cur = await tokensOf();
    expect(cur.id).toBeNull();
    expect(cur.tokens.length).toBeGreaterThan(10);
    expect((await req('PUT', `/api/workstations/${wsId}/design-system`, { tokens: [{ name: '--a', value: '1px' }] })).status).toBe(200);
    const saved = await tokensOf();
    expect(saved.tokens).toEqual([{ name: '--a', value: '1px' }]);
    expect((await req('PUT', `/api/workstations/${wsId}/design-system`, { tokens: [{ name: '--a', value: '2px' }], baseVersion: saved.version })).status).toBe(200);
    expect((await req('POST', `/api/entities/${saved.id}/rollback`, { version: 1 })).status).toBe(200);
    expect((await tokensOf()).tokens[0]!.value).toBe('1px');
  });

  it('并发保存被拒，不互相覆盖', async () => {
    await req('PUT', `/api/workstations/${wsId}/design-system`, { guidelines: 'a' });
    await req('PUT', `/api/workstations/${wsId}/design-system`, { guidelines: 'b' });
    expect((await req('PUT', `/api/workstations/${wsId}/design-system`, { guidelines: 'c', baseVersion: 1 })).status).toBe(409);
  });

  it('从 CSS 导入时替换默认令牌，之后的导入按名合并', async () => {
    expect(await (await req('POST', `/api/workstations/${wsId}/design-system/import`, { css: ':root{--brand:#123456;}' })).json()).toEqual({ count: 1 });
    expect((await tokensOf()).tokens).toEqual([{ name: '--brand', value: '#123456' }]);
    await req('POST', `/api/workstations/${wsId}/design-system/import`, { css: ':root{--brand:#000000;--radius:4px}' });
    expect((await tokensOf()).tokens.map((t) => t.value).sort()).toEqual(['#000000', '4px']);
  });

  it('没有变量时报错；不能跨项目读仓库', async () => {
    expect((await req('POST', `/api/workstations/${wsId}/design-system/import`, { css: 'a{color:red}' })).status).toBe(400);
    expect((await req('POST', `/api/workstations/${wsId}/design-system/import`, { sourceWorkstationId: 'nope', path: 'a.css' })).status).toBe(400);
  });

  it('update_design_system 增改删令牌', async () => {
    await call('update_design_system', { set: [{ name: '--color-text', value: '#000000' }, { name: '--extra', value: '1' }], remove: ['--radius-sm'] });
    const names = (await tokensOf()).tokens;
    expect(names.find((t) => t.name === '--color-text')!.value).toBe('#000000');
    expect(names.some((t) => t.name === '--extra')).toBe(true);
    expect(names.some((t) => t.name === '--radius-sm')).toBe(false);
  });
});

describe('交接给开发台', () => {
  const handoff = (id: string, body: Record<string, unknown> = {}) => req('POST', `/api/designs/${id}/handoff`, { targetWorkstationId: devId, module: 'src/board', priority: 'p1', ...body });

  it('冻结快照、起草开发任务，实现者和子任务都读得到', async () => {
    const d = await call('write_design', { title: '首页', html: PAGE, brief: '要大气' });
    const res = await handoff(d.id);
    expect(res.status).toBe(201);
    const { taskId } = (await res.json()) as { taskId: string };
    const t = (await db.select().from(task).where(eq(task.id, taskId)))[0]!;
    expect(t).toMatchObject({ workstationId: devId, status: 'draft', typeId: 'dev.issue' });
    expect(t.intent).toContain('v1');

    await call('edit_design', { id: d.id, edits: [{ oldText: '标题', newText: '之后的改动' }] });
    const dev = await agentOf('frontend-dev', devId);
    const read = (await executeTool(await ctxOf(dev, t), 'read_design_handoff', {})) as { html: string; brief: string; tokens: unknown[] };
    expect(read.html).toContain('<h1>标题</h1>');
    expect(read.html).toContain('--color-text');
    expect(read.brief).toBe('要大气');

    const child = { ...t, id: 'child', parentId: t.id, inputJson: '{}' };
    await db.insert(task).values(child);
    expect(await executeTool(await ctxOf(dev, child), 'read_design_handoff', {})).toMatchObject({ title: '首页' });
  });

  it('没有交接件的任务读不到；目标不是开发台时拒绝', async () => {
    const d = await call('write_design', { title: '首页', html: PAGE });
    const dev = await agentOf('frontend-dev', devId);
    const t = { id: 'plain', projectId: 'proj-aw', workstationId: devId, title: 't', inputJson: '{}', status: 'in_progress', createdAt: new Date().toISOString() };
    await db.insert(task).values(t);
    const row = (await db.select().from(task).where(eq(task.id, 'plain')))[0]!;
    expect(await executeTool(await ctxOf(dev, row), 'read_design_handoff', {})).toEqual({ error: '这个任务没有交接的设计稿' });
    expect((await handoff(d.id, { targetWorkstationId: wsId })).status).toBe(400);
    expect((await handoff(d.id, { module: '../etc' })).status).toBe(400);
  });
});

describe('设计对话', () => {
  it('人说需求 → 设计师出稿；发评论 → 改稿并关闭评论；消息带上正在看的稿子', async () => {
    const th = await wsThreadOf(db, wsId);
    expect(th.mode).toBe('moderated');
    await postThreadMessage(HUMAN, db, th.id, '做一个落地页');
    await settle();
    const list = (await (await req('GET', `/api/workstations/${wsId}/designs`)).json()) as { id: string; version: number; title: string }[];
    expect(list).toMatchObject([{ title: 'Mock 落地页', version: 1 }]);

    const id = list[0]!.id;
    const created = (await (await req('POST', `/api/workstations/${wsId}/entities`, { entityType: 'DesignComment', data: { design: id, version: 1, selector: 'body', body: '改大', status: 'open' } })).json()) as { id: string };
    const res = await req('POST', `/api/threads/${th.id}/messages`, { content: `请处理（design: ${id}）\n1. comment id: ${created.id} · 改大`, meta: { design: { id, title: 'Mock', version: 1 } } });
    expect(res.status).toBe(201);
    await settle();

    const after = (await (await req('GET', `/api/workstations/${wsId}/designs`)).json()) as { version: number; openComments: number }[];
    expect(after).toMatchObject([{ version: 2, openComments: 0 }]);
    const msgs = await db.select().from(message).where(eq(message.threadId, th.id));
    expect(msgs.some((m) => m.metaJson?.includes('"design"'))).toBe(true);
    expect(msgs.some((m) => m.senderType === 'agent' && m.content === '设计稿已更新（mock）。')).toBe(true);
  });
});
