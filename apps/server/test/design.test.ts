import { and, eq, inArray } from 'drizzle-orm';
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, artifact, entity, entityVersion, eventLog, message, project, task, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { conversationIdle } from '../src/runtime/conversation.js';
import { renderDesign } from '../src/runtime/design_render.js';
import { extractImages, toolOutputFor } from '../src/runtime/loop.js';
import { loadModels } from '../src/runtime/models.js';
import { scheduler, startScheduler } from '../src/runtime/scheduler.js';
import { executeTool, type RunCtx } from '../src/runtime/tools/index.js';
import { buildPermCtx } from '../src/usecases/index.js';
import { dmThreadOf, postThreadMessage, wsThreadOf } from '../src/usecases/threads.js';

const HUMAN = { type: 'human', id: 'local' } as const;

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let wsId: string;
let devId: string;
let rootId: string;
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

const PAGE = '<!doctype html><html><head><style>:root{--color-text:#1c1b19}h1{color:var(--color-text)}</style></head><body><h1>标题</h1></body></html>';

// 收集阶段探测一次：本机没装 Chromium 时渲染类用例整组跳过
const HAS_CHROMIUM = await chromium.launch().then(async (b) => { await b.close(); return true; }).catch(() => false);
if (!HAS_CHROMIUM) console.log('[design.test] Chromium 不可用，渲染类用例跳过');

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
  rootId = root.id;
  // D29 之后设计能力在开发台里：设计稿、评论都挂在 dev 工作台上
  devId = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!.id;
  wsId = devId;
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
    const pm = await ctxOf(await agentOf('pm', rootId));
    expect(await executeTool(pm, 'read_design', { id: r.id })).toEqual({ error: '设计稿不存在' });
    expect(await executeTool(pm, 'edit_design', { id: r.id, edits: [] })).toEqual({ error: '设计稿不存在' });
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
    expect((await handoff(d.id, { targetWorkstationId: rootId })).status).toBe(400);
    expect((await handoff(d.id, { module: '../etc' })).status).toBe(400);
  });
});

describe('删除设计稿', () => {
  it('历史版本和评论一起删，别的稿子不动；交接出去的任务仍读得到快照', async () => {
    const d = await call('write_design', { title: '首页', html: PAGE });
    await call('edit_design', { id: d.id, edits: [{ oldText: '标题', newText: '新标题' }] });
    const c = await call('comment_design', { designId: d.id, selector: 'body > h1:nth-child(1)', body: '再大点' }, 'design-critic');
    const other = await call('write_design', { title: '另一页', html: PAGE });
    await call('comment_design', { designId: other.id, selector: 'body > h1:nth-child(1)', body: '保留' }, 'design-critic');
    const handed = await req('POST', `/api/designs/${d.id}/handoff`, { targetWorkstationId: devId, module: 'src/board', priority: 'p1' });
    const { taskId } = (await handed.json()) as { taskId: string };

    expect((await req('DELETE', `/api/designs/${d.id}`)).status).toBe(200);
    expect(await db.select().from(entity).where(inArray(entity.id, [d.id, c.commentId]))).toEqual([]);
    expect(await db.select().from(entityVersion).where(inArray(entityVersion.entityId, [d.id, c.commentId]))).toEqual([]);
    expect((await call('list_designs', {})).designs).toMatchObject([{ id: other.id, openComments: 1 }]);
    expect((await db.select().from(eventLog).where(and(eq(eventLog.action, 'entity_deleted'), eq(eventLog.targetId, d.id)))).length).toBe(1);

    const t = (await db.select().from(task).where(eq(task.id, taskId)))[0]!;
    expect(await executeTool(await ctxOf(await agentOf('frontend-dev', devId), t), 'read_design_handoff', {})).toMatchObject({ title: '首页' });
    expect((await req('GET', `/api/tasks/${taskId}/design-handoff`)).status).toBe(200);

    expect((await req('DELETE', `/api/designs/${d.id}`)).status).toBe(404);
  });

  it('不是设计稿的实体删不了', async () => {
    const d = await call('write_design', { title: '首页', html: PAGE });
    const c = await call('comment_design', { designId: d.id, selector: 'body > h1:nth-child(1)', body: 'x' }, 'design-critic');
    const res = await req('DELETE', `/api/designs/${c.commentId}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: '设计稿不存在' });
    expect((await db.select().from(entity).where(eq(entity.id, c.commentId))).length).toBe(1);
  });
});

describe('设计对话', () => {
  it('人说需求 → 设计师私聊出稿；发评论 → 改稿并关闭评论；消息带上正在看的稿子', async () => {
    const designer = await agentOf('designer');
    const th = (await dmThreadOf(db, designer.id))!;
    expect(th).toBeTruthy();
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

describe('元素圈选', () => {
  it('带 elements 的消息进 meta，设计师按选中元素的锚文本改稿', async () => {
    const designer = await agentOf('designer');
    const th = (await dmThreadOf(db, designer.id))!;
    await postThreadMessage(HUMAN, db, th.id, '做一个落地页');
    await settle();
    const list = (await (await req('GET', `/api/workstations/${wsId}/designs`)).json()) as { id: string; version: number }[];
    const d = list[0]!;

    const res = await req('POST', `/api/threads/${th.id}/messages`, {
      content: '把标题改一下',
      meta: {
        design: { id: d.id, title: 'Mock 落地页', version: 1 },
        elements: [{ selector: 'body > main > h1:nth-child(1)', tag: 'h1', anchor: 'Mock 落地页', html: '<h1>Mock 落地页</h1>' }],
      },
    });
    expect(res.status).toBe(201);
    await settle();

    const row = (await db.select().from(entity).where(eq(entity.id, d.id)))[0]!;
    const data = JSON.parse(row.dataJson ?? '{}') as { html: string };
    expect(row.version).toBe(2);
    expect(data.html).toContain('Mock 落地页（已修订）');
    const msgs = await db.select().from(message).where(eq(message.threadId, th.id));
    const mine = msgs.find((m) => m.metaJson?.includes('"elements"'))!;
    expect(JSON.parse(mine.metaJson!).elements[0]).toMatchObject({ tag: 'h1', anchor: 'Mock 落地页' });
  });

  it('elements 服务端再校验：字段截断、超过 8 个只留前 8 个', async () => {
    const designer = await agentOf('designer');
    const th = (await dmThreadOf(db, designer.id))!;
    const els = Array.from({ length: 10 }, (_, i) => ({
      selector: `body > p:nth-child(${i})${'x'.repeat(3000)}`,
      tag: 'p',
      anchor: `a${i}${'y'.repeat(100)}`,
      html: 'z'.repeat(4000),
    }));
    const res = await req('POST', `/api/threads/${th.id}/messages`, { content: '看看这些', meta: { design: { id: 'd1', title: 'x', version: 1 }, elements: els } });
    expect(res.status).toBe(201);
    await settle();
    const msgs = await db.select().from(message).where(eq(message.threadId, th.id));
    const mine = msgs.find((m) => m.content === '看看这些')!;
    const stored = JSON.parse(mine.metaJson!).elements as { selector: string; tag: string; anchor: string; html: string }[];
    expect(stored).toHaveLength(8);
    expect(stored[0]!.selector.length).toBeLessThanOrEqual(2000);
    expect(stored[0]!.anchor.length).toBeLessThanOrEqual(60);
    expect(stored[0]!.html.length).toBeLessThanOrEqual(1500);
  });
});

describe('渲染与导出', () => {
  it.skipIf(!HAS_CHROMIUM)('PNG/PDF 输出正确的文件头，断网渲染不挂起', async () => {
    const png = await renderDesign(PAGE, { width: 390, format: 'png' });
    expect(png.subarray(0, 4).toString('latin1')).toBe('PNG');
    const pdf = await renderDesign(PAGE, { width: 1440, format: 'pdf' });
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
    const tricky = '<!doctype html><html><body><img src="https://example.com/x.png"><script>fetch("https://example.com").catch(() => {})</script><h1>ok</h1></body></html>';
    expect((await renderDesign(tricky, { width: 390, format: 'png' })).length).toBeGreaterThan(1000);
  }, 90_000);

  it.skipIf(!HAS_CHROMIUM)('导出路由：png/pdf 二进制、附件名，未知稿子 404', async () => {
    const d = await call('write_design', { title: '落地页', html: PAGE });
    const png = await req('GET', `/api/designs/${d.id}/export?format=png&viewport=mobile`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(decodeURIComponent(png.headers.get('content-disposition') ?? '')).toContain('落地页-v1.png');
    expect((await png.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    const pdf = await req('GET', `/api/designs/${d.id}/export?format=pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect((await req('GET', '/api/designs/nope/export?format=png')).status).toBe(404);
  }, 90_000);

  it.skipIf(!HAS_CHROMIUM)('view_design：截图进产物和 __images，跨台读不到', async () => {
    const d = await call('write_design', { title: '首页', html: PAGE });
    const r = (await call('view_design', { id: d.id, viewport: 'mobile' })) as unknown as { artifactId: string; viewport: string; width: number; height: number; __images: { mediaType: string; base64: string }[] };
    expect(r.viewport).toBe('mobile');
    expect(r.width).toBe(390);
    expect(r.height).toBeGreaterThan(0);
    expect(r.__images[0]!.mediaType).toBe('image/png');
    expect(Buffer.from(r.__images[0]!.base64, 'base64').subarray(0, 4).toString('latin1')).toBe('PNG');
    const a = (await db.select().from(artifact).where(eq(artifact.id, r.artifactId)))[0]!;
    expect(a.type).toBe('screenshot');
    expect((await req('GET', `/api/artifacts/${a.id}/image`)).status).toBe(200);
    const other = await ctxOf(await agentOf('pm', rootId));
    expect(await executeTool(other, 'view_design', { id: d.id })).toEqual({ error: '设计稿不存在' });
  }, 90_000);
});

describe('图片结果进出模型', () => {
  it('extractImages 把 __images 摘出去：trace 侧不留 base64', () => {
    const { images, rest } = extractImages({ artifactId: 'a1', width: 390, __images: [{ mediaType: 'image/png', base64: 'QUJD' }] });
    expect(images).toEqual([{ mediaType: 'image/png', base64: 'QUJD' }]);
    expect(JSON.stringify(rest)).not.toContain('__images');
    expect(JSON.stringify(rest)).not.toContain('QUJD');
    expect(extractImages('x')).toEqual({ images: [], rest: 'x' });
  });

  it('toolOutputFor：不开看图给 JSON 加提示，开看图给多段', () => {
    const imgs = [{ mediaType: 'image/png', base64: 'QUJD' }];
    const plain = toolOutputFor({ artifactId: 'a1' }, imgs, false);
    expect(plain.type).toBe('json');
    expect(JSON.stringify(plain)).toContain('当前模型未开启看图');
    expect(JSON.stringify(plain)).toContain('a1');
    const rich = toolOutputFor({ artifactId: 'a1' }, imgs, true);
    expect(rich.type).toBe('content');
    const parts = (rich as { value: Record<string, unknown>[] }).value;
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect(parts[1]).toMatchObject({ type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'QUJD' } });
    expect(toolOutputFor({ ok: 1 }, [], true)).toEqual({ type: 'json', value: { ok: 1 } });
  });
});

describe('交接请用例设计起草用例', () => {
  const asks = async (artifactId: string) => {
    const th = await wsThreadOf(db, devId);
    const msgs = await db.select().from(message).where(eq(message.threadId, th.id));
    return msgs.filter((m) => m.senderType === 'human' && (m.content ?? '').includes('@用例设计') && (m.content ?? '').includes(artifactId));
  };

  it('qaCases 会以人的身份在目标开发台会话 @用例设计，带上快照 id 和任务名；不勾不发', async () => {
    const d = await call('write_design', { title: '首页', html: PAGE });
    const res = await req('POST', `/api/designs/${d.id}/handoff`, { targetWorkstationId: devId, module: 'src/board', priority: 'p1', qaCases: true });
    expect(res.status).toBe(201);
    const art = (await db.select().from(artifact).where(eq(artifact.type, 'design_handoff')))[0]!;
    const hits = await asks(art.id);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toContain('实现设计稿：首页');
    expect(hits[0]!.content).toContain('设计交接：首页');

    const d2 = await call('write_design', { title: '详情', html: PAGE });
    await req('POST', `/api/designs/${d2.id}/handoff`, { targetWorkstationId: devId, module: 'src/board', priority: 'p1' });
    const art2 = (await db.select().from(artifact).where(eq(artifact.type, 'design_handoff'))).find((a) => a.name === '详情')!;
    expect(await asks(art2.id)).toHaveLength(0);
  });

  it('read_design_snapshot：同项目快照可读，其它类型和跨项目读不到', async () => {
    const d = await call('write_design', { title: '首页', html: PAGE });
    await req('POST', `/api/designs/${d.id}/handoff`, { targetWorkstationId: devId, module: 'src/board', priority: 'p1' });
    const art = (await db.select().from(artifact).where(eq(artifact.type, 'design_handoff')))[0]!;
    const caseDesigner = await agentOf('case-designer', devId);
    const snap = (await executeTool(await ctxOf(caseDesigner), 'read_design_snapshot', { artifactId: art.id })) as { title: string; html: string; designId: string; version: number };
    expect(snap).toMatchObject({ title: '首页', designId: d.id, version: 1 });
    expect(snap.html).toContain('--color-text');

    const now = new Date().toISOString();
    await db.insert(artifact).values({ id: 'art-shot', workstationId: wsId, type: 'screenshot', name: 'x', ref: 'x', createdAt: now });
    expect(await executeTool(await ctxOf(caseDesigner), 'read_design_snapshot', { artifactId: 'art-shot' })).toEqual({ error: '设计交接快照不存在' });
    expect(await executeTool(await ctxOf(caseDesigner), 'read_design_snapshot', { artifactId: 'nope' })).toEqual({ error: '设计交接快照不存在' });
    await db.insert(project).values({ id: 'proj-x', workspaceId: 'default', name: 'x', createdAt: now });
    await db.insert(workstation).values({ id: 'ws-x', projectId: 'proj-x', name: 'x', createdAt: now });
    await db.insert(artifact).values({ id: 'art-x', workstationId: 'ws-x', type: 'design_handoff', name: 't', ref: '<html/>', createdAt: now });
    expect(await executeTool(await ctxOf(caseDesigner), 'read_design_snapshot', { artifactId: 'art-x' })).toEqual({ error: '设计交接快照不存在' });
  });
});
