import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, artifact, entity, eventLog, inboxItem, message, project, proposal, task, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { loadModels } from '../src/runtime/models.js';
import { startScheduler } from '../src/runtime/scheduler.js';
import { executeTool, type RunCtx } from '../src/runtime/tools/index.js';
import { buildPermCtx, checkDocDrift, createTaskUc, mountWorkstation, noteMergeImpact, reconcileDocHandoffs } from '../src/usecases/index.js';
import { deleteSource, importSource } from '../src/usecases/knowledge.js';
import { wsThreadOf } from '../src/usecases/threads.js';
import { createFixtureRepo } from './fixtures.js';

const HUMAN = { type: 'human', id: 'local' } as const;

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let wsId: string;
let devId: string;
let repo: string;
let stop: () => void;

const req = (method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T = Record<string, never>>(r: Response | Promise<Response>) => (await (await r).json()) as T & { error?: string };
const g = (...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-c', 'user.name=f', '-c', 'user.email=f@f.local', ...args], { cwd: repo, windowsHide: true, stdio: 'pipe' });

const DOC = 'alpha 行\nbeta 行\ngamma 行\ndelta 行\n';

// 收集阶段探测一次：本机没装 Chromium 时 PDF 用例跳过（和 design.test 同一个做法）
const HAS_CHROMIUM = await chromium.launch().then(async (b) => { await b.close(); return true; }).catch(() => false);

const agentOf = async (templateId: string, ws = wsId) => (await db.select().from(agent).where(and(eq(agent.workstationId, ws), eq(agent.templateId, templateId))))[0]!;
async function call(name: string, args: Record<string, unknown>, template = 'docs-writer', ws = wsId) {
  const a = await agentOf(template, ws);
  const actor = { type: 'agent', id: a.id } as const;
  const ctx: RunCtx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: null, run: { id: 'r' } as never };
  return (await executeTool(ctx, name, args)) as Record<string, unknown> & { error?: string };
}
// 任务上下文工具（read_doc_handoff / read_design_handoff）要真实的 task 行
async function callTask(name: string, args: Record<string, unknown>, taskRow: typeof task.$inferSelect, template = 'backend-dev', ws = devId) {
  const a = await agentOf(template, ws);
  const actor = { type: 'agent', id: a.id } as const;
  const ctx: RunCtx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: taskRow, run: { id: 'r' } as never };
  return (await executeTool(ctx, name, args)) as Record<string, unknown> & { error?: string };
}

interface DocOut { id?: string; version?: number; status?: string; lint?: { level: string; rule: string }[]; citations?: { id: string; kind: string; commit?: string; blob?: string; snippetHash?: string; chunkId?: string }[]; error?: string }
interface DocRead { id: string; version: number; title: string; content: string; status: string; contentHash: string; review?: { contentHash: string; verdict: string } | null; openComments: { id: string; severity: string }[]; gate: { ok: boolean; reasons: string[] }; handoff?: { taskId?: string; artifactId?: string; publishedCommit?: string; publishedBlob?: string | null; cancelled?: boolean; override?: string | null } | null }
const readDoc = (id: string) => json<DocRead>(req('GET', `/api/docs/${id}`));
const hashOf = async (id: string) => (await readDoc(id)).contentHash;

beforeEach(async () => {
  process.env.AW_ENABLE_MOCK = '1';
  process.env.AW_DEFAULT_MODEL = 'mock:scripted';
  repo = createFixtureRepo();
  g('checkout', '-b', 'develop');
  writeFileSync(path.join(repo, 'spec.md'), DOC);
  g('add', '-A');
  g('commit', '-m', 'spec');
  process.env.AW_SEED_REPO_PATH = repo;
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  migrateDb(r.sqlite);
  await seed(db);
  app = createApp(db).app;
  const root = (await db.select().from(workstation).where(eq(workstation.pluginId, 'pm')))[0]!;
  devId = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!.id;
  const m = await mountWorkstation(HUMAN, db, { projectId: 'proj-aw', parentId: root.id, pluginId: 'docs', name: '文档' });
  if (m.kind !== 'ok') throw new Error(m.error);
  wsId = m.id;
  await loadModels();
  stop = startScheduler(db);
});

afterEach(() => {
  stop();
  delete process.env.AW_SEED_REPO_PATH;
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch { /* Windows 句柄未释放时留给系统清理 */ }
});

const mountDev = async (name: string) => {
  const root = (await db.select().from(workstation).where(eq(workstation.pluginId, 'pm')))[0]!;
  const m = await mountWorkstation(HUMAN, db, { projectId: 'proj-aw', parentId: root.id, pluginId: 'dev', name, settings: { repoPath: repo, targetBranch: 'develop' } });
  if (m.kind !== 'ok') throw new Error(m.error);
  return m.id;
};

describe('文档台挂载', () => {
  it('singleton：同一项目再挂一个文档台被拒', async () => {
    const root = (await db.select().from(workstation).where(eq(workstation.pluginId, 'pm')))[0]!;
    const m = await mountWorkstation(HUMAN, db, { projectId: 'proj-aw', parentId: root.id, pluginId: 'docs', name: '文档二' });
    expect(m).toMatchObject({ kind: 'error' });
    expect((m as { error: string }).error).toContain('一个项目只能有一个');
  });

  it('manifest 校验通过且 agents 都在', async () => {
    expect(await agentOf('docs-writer')).toBeTruthy();
    expect(await agentOf('fact-checker')).toBeTruthy();
    expect(await agentOf('doc-editor')).toBeTruthy();
  });
});

describe('仓库只读工具', () => {
  it('list_repos 列出项目全部开发台；read_repo_file 用 repo 参数读指定仓库', async () => {
    const dev2 = await mountDev('开发二');
    const repos = (await call('list_repos', {})).repos as { repo: string; name: string; bound: boolean }[];
    expect(repos.map((r) => r.repo).sort()).toEqual([devId, dev2].sort());
    expect(repos.every((r) => r.bound)).toBe(true);
    const file = (await call('read_repo_file', { path: 'spec.md', repo: dev2 })) as { content?: string; error?: string };
    expect(file.error).toBeUndefined();
    expect(file.content).toContain('beta 行');
  });

  it('跨项目的 repo 参数被拒', async () => {
    const now = new Date().toISOString();
    await db.insert(project).values({ id: 'proj-x', workspaceId: 'default', name: 'x', createdAt: now });
    await db.insert(workstation).values({ id: 'ws-x', projectId: 'proj-x', pluginId: 'dev', name: 'x 开发', settingsJson: JSON.stringify({ repoPath: repo, targetBranch: 'develop' }), createdAt: now });
    const r = (await call('read_repo_file', { path: 'spec.md', repo: 'ws-x' })) as { error?: string };
    expect(r.error).toContain('不是同项目的开发工作台');
  });

  it('开发台的用例设计不带 repo 时读本台仓库', async () => {
    const r = (await call('read_repo_file', { path: 'spec.md' }, 'case-designer', devId)) as { content?: string; error?: string };
    expect(r.error).toBeUndefined();
    expect(r.content).toContain('gamma 行');
  });
});

describe('文档写入与引用', () => {
  it('仓库引用解析出 commit/blob/snippetHash', async () => {
    const sha = g('rev-parse', 'develop').toString().trim();
    const r = (await call('write_doc', {
      title: '规格', content: '# 规格\n\n按实现[^impl]。',
      citations: [{ id: 'impl', kind: 'repo', repo: devId, path: 'spec.md', lines: [1, 2] }],
    })) as DocOut;
    expect(r.error).toBeUndefined();
    expect(r.citations![0]).toMatchObject({ id: 'impl', kind: 'repo', commit: sha });
    expect(r.citations![0]!.blob).toBeTruthy();
    expect(r.citations![0]!.snippetHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('行号越界的引用让整次写入失败', async () => {
    const r = (await call('write_doc', {
      title: '规格', content: '# 规格\n\n按实现[^impl]。',
      citations: [{ id: 'impl', kind: 'repo', repo: devId, path: 'spec.md', lines: [1, 99] }],
    })) as DocOut;
    expect(r.error).toContain('越界');
    expect(((await call('list_docs', {})).docs as unknown[]).length).toBe(0);
  });

  it('知识库引用：引文落在片段里才收', async () => {
    const src = await importSource(HUMAN, db, { projectId: 'proj-aw', name: '词汇', content: '# 词汇\n\n本文统一写作「工作台」。\n', kind: 'md' });
    if (src.kind !== 'ok') throw new Error(src.error);
    const sourceId = src.id;
    const bad = (await call('write_doc', {
      title: '说明', content: '# 说明\n\n用词[^w]。',
      citations: [{ id: 'w', kind: 'knowledge', sourceId, quote: '原文里没有的话' }],
    })) as DocOut;
    expect(bad.error).toContain('找不到这段引文');
    const good = (await call('write_doc', {
      title: '说明', content: '# 说明\n\n用词[^w]。',
      citations: [{ id: 'w', kind: 'knowledge', sourceId, quote: '统一写作「工作台」' }],
    })) as DocOut;
    expect(good.error).toBeUndefined();
    expect(good.citations![0]).toMatchObject({ id: 'w', kind: 'knowledge' });
    expect(good.citations![0]!.chunkId).toBeTruthy();
  });
});

describe('核对与门禁', () => {
  const writeClean = () =>
    call('write_doc', { title: '接入指南', kind: 'guide', content: '# 接入指南\n\n三步接入。\n' }) as Promise<DocOut>;

  it('内容变化让 approved 回到 draft；元信息变化保留核对', async () => {
    const d = await writeClean();
    const pass = (await call('save_doc_review', { id: d.id, contentHash: await hashOf(d.id!), verdict: 'pass', summary: '都对', findings: [] }, 'fact-checker')) as { status?: string };
    expect(pass.status).toBe('approved');
    const edited = (await call('edit_doc', { id: d.id, edits: [{ oldText: '三步接入', newText: '四步接入' }] })) as DocOut;
    expect(edited.status).toBe('draft');

    const pass2 = (await call('save_doc_review', { id: d.id, contentHash: await hashOf(d.id!), verdict: 'pass', summary: '核过了', findings: [] }, 'fact-checker')) as { status?: string };
    expect(pass2.status).toBe('approved');
    const res = await req('PATCH', `/api/docs/${d.id}`, { title: '接入指南 v2', baseVersion: (await readDoc(d.id!)).version });
    expect(res.status).toBe(200);
    const after = await readDoc(d.id!);
    expect(after.status).toBe('approved');
    expect(after.review?.contentHash).toBe(after.contentHash);
  });

  it('save_doc_review 带旧 contentHash 被拒', async () => {
    const d = await writeClean();
    const r = (await call('save_doc_review', { id: d.id, contentHash: 'deadbeef', verdict: 'pass', summary: 's', findings: [] }, 'fact-checker')) as { error?: string };
    expect(r.error).toContain('已变更');
  });

  it('门禁：未核对、缺目标时给原因；补齐后可交接', async () => {
    const d = await writeClean();
    const before = await readDoc(d.id!);
    expect(before.gate.ok).toBe(false);
    expect(before.gate.reasons).toContain('还没有事实核对结论');
    expect(before.gate.reasons).toContain('还没有设置目标仓库或目标路径');
    await call('save_doc_review', { id: d.id, contentHash: await hashOf(d.id!), verdict: 'pass', summary: '都对', findings: [] }, 'fact-checker');
    await req('PATCH', `/api/docs/${d.id}`, { target_repo: devId, target_path: 'docs/guide.md', baseVersion: (await readDoc(d.id!)).version });
    const after = await readDoc(d.id!);
    expect(after.gate).toEqual({ ok: true, reasons: [] });
  });

  it('lint 错误出现在门禁原因里', async () => {
    const d = (await call('write_doc', { title: 'x', content: '# x\n\n正文引用[^missing]。\n' })) as DocOut;
    expect(d.lint!.some((l) => l.rule === 'citation_missing' && l.level === 'error')).toBe(true);
    await call('save_doc_review', { id: d.id, contentHash: await hashOf(d.id!), verdict: 'pass', summary: 's', findings: [] }, 'fact-checker');
    await req('PATCH', `/api/docs/${d.id}`, { target_repo: devId, target_path: 'docs/x.md', baseVersion: (await readDoc(d.id!)).version });
    const gate = (await readDoc(d.id!)).gate;
    expect(gate.ok).toBe(false);
    expect(gate.reasons.some((r) => r.includes('lint'))).toBe(true);
  });
});

describe('评论', () => {
  it('引文要能在正文里找到；解决后不再算 open', async () => {
    const d = (await call('write_doc', { title: 'x', content: '# x\n\n三步接入。\n' })) as DocOut;
    const bad = (await call('comment_doc', { doc: d.id, quote: '不在原文里', body: 'b' }, 'doc-editor')) as { error?: string };
    expect(bad.error).toContain('找不到');
    const c = (await call('comment_doc', { doc: d.id, quote: '三步接入', body: '改成四步', severity: 'block' }, 'doc-editor')) as { commentId?: string };
    expect(c.commentId).toBeTruthy();
    const read = await readDoc(d.id!);
    expect(read.openComments.map((x) => x.id)).toEqual([c.commentId]);
    expect((await call('resolve_doc_comments', { ids: [c.commentId], note: '已改' })).resolved).toBe(1);
    expect((await readDoc(d.id!)).openComments.length).toBe(0);
  });
});

describe('请求核对', () => {
  it('在文档台大群以人的身份 @事实核对，并把状态拨到 reviewing', async () => {
    const d = (await call('write_doc', { title: 'x', content: '# x\n\n内容。\n' })) as DocOut;
    const res = await req('POST', `/api/docs/${d.id}/request-review`, { who: 'fact-checker' });
    expect(res.status).toBe(200);
    expect((await readDoc(d.id!)).status).toBe('reviewing');
    const th = await wsThreadOf(db, wsId);
    const msgs = await db.select().from(message).where(eq(message.threadId, th.id));
    const hit = msgs.find((m) => m.senderType === 'human' && (m.content ?? '').includes('@事实核对'));
    expect(hit?.content).toContain(d.id);
  });

  it('请编辑看看发 @文字编辑 的结构文风消息，不拨状态', async () => {
    const d = (await call('write_doc', { title: 'x', content: '# x\n\n内容。\n' })) as DocOut;
    const res = await req('POST', `/api/docs/${d.id}/request-review`, { who: 'doc-editor' });
    expect(res.status).toBe(200);
    expect((await readDoc(d.id!)).status).toBe('draft');
    const th = await wsThreadOf(db, wsId);
    const msgs = await db.select().from(message).where(eq(message.threadId, th.id));
    const hit = msgs.find((m) => (m.content ?? '').includes('@文字编辑'));
    expect(hit?.content).toBe(`@文字编辑 请看看文档「x」（id: ${d.id}）的结构和文风`);
  });
});

describe('版本', () => {
  it('每次保存都是新版本，可按版本读历史', async () => {
    const d = (await call('write_doc', { title: 'x', content: '# x\n\nv1 内容。\n' })) as DocOut;
    await call('edit_doc', { id: d.id, edits: [{ oldText: 'v1 内容', newText: 'v2 内容' }] });
    const old = await json<DocRead>(req('GET', `/api/docs/${d.id}?version=1`));
    expect(old.content).toContain('v1 内容');
    expect((await readDoc(d.id!)).version).toBe(2);
  });
});


// 一篇过审、目标齐全的文档，可直接走交接
const readyDoc = async (targetPath = 'docs/guide.md') => {
  const d = (await call('write_doc', { title: '指南', kind: 'guide', content: '# 指南\n\n三步接入。\n' })) as DocOut;
  await call('save_doc_review', { id: d.id, contentHash: await hashOf(d.id!), verdict: 'pass', summary: '都对', findings: [] }, 'fact-checker');
  await req('PATCH', `/api/docs/${d.id}`, { target_repo: devId, target_path: targetPath, baseVersion: (await readDoc(d.id!)).version });
  return d.id!;
};

describe('目标校验与状态约束', () => {
  it('PATCH 里塞 status 被忽略：状态只能平台拨', async () => {
    const d = (await call('write_doc', { title: 'x', content: '# x\n\n内容。\n' })) as DocOut;
    const res = await req('PATCH', `/api/docs/${d.id}`, { status: 'approved', baseVersion: (await readDoc(d.id!)).version });
    expect(res.status).toBe(200);
    expect((await readDoc(d.id!)).status).toBe('draft');
  });

  it('目标路径逐项拦截非法值；反斜杠归一；null 清空目标', async () => {
    const d = (await call('write_doc', { title: 'x', content: '# x\n\n内容。\n' })) as DocOut;
    const badPaths = ['../x.md', 'a/../b.md', '/abs.md', 'C:\\x.md', '.git/config', '-x.md', '', 'x'.repeat(301), 'a\0b'];
    for (const p of badPaths) {
      const res = await req('PATCH', `/api/docs/${d.id}`, { target_path: p, baseVersion: (await readDoc(d.id!)).version });
      expect(res.status, `路径 ${JSON.stringify(p)} 应该 400`).toBe(400);
      expect((await json(res)).error).toBeTruthy();
    }
    const ok = await req('PATCH', `/api/docs/${d.id}`, { target_repo: devId, target_path: 'docs\\sub\\x.md', baseVersion: (await readDoc(d.id!)).version });
    expect(ok.status).toBe(200);
    const det = await readDoc(d.id!) as unknown as { target_path?: string };
    expect(det.target_path).toBe('docs/sub/x.md');
    const clr = await req('PATCH', `/api/docs/${d.id}`, { target_repo: null, target_path: null, baseVersion: (await readDoc(d.id!)).version });
    expect(clr.status).toBe(200);
    const after = await readDoc(d.id!) as unknown as { target_repo?: string | null; target_path?: string | null };
    expect(after.target_repo).toBeNull();
    expect(after.target_path).toBeNull();
  });

  it('target_repo 要同项目的开发台；未绑定仓库的开发台也是合法目标', async () => {
    const d = (await call('write_doc', { title: 'x', content: '# x\n\n内容。\n' })) as DocOut;
    const bad = await req('PATCH', `/api/docs/${d.id}`, { target_repo: wsId, baseVersion: (await readDoc(d.id!)).version });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toContain('开发工作台');
    const tool = (await call('write_doc', { title: 'y', content: '# y\n\n内容。\n', target_repo: wsId })) as { error?: string };
    expect(tool.error).toContain('开发工作台');
    const root = (await db.select().from(workstation).where(eq(workstation.pluginId, 'pm')))[0]!;
    const m = await mountWorkstation(HUMAN, db, { projectId: 'proj-aw', parentId: root.id, pluginId: 'dev', name: '未绑定' });
    if (m.kind !== 'ok') throw new Error(m.error);
    const res = await req('PATCH', `/api/docs/${d.id}`, { target_repo: m.id, baseVersion: (await readDoc(d.id!)).version });
    expect(res.status).toBe(200);
  });

  it('read_repo_file numbered 前缀真实行号；超过 FILE_LIMIT 标记 truncated', async () => {
    writeFileSync(path.join(repo, 'big.txt'), 'x\n'.repeat(40000));
    g('add', '-A');
    g('commit', '-m', 'big');
    const small = (await call('read_repo_file', { path: 'spec.md', repo: devId, numbered: true })) as { content?: string; truncated?: boolean };
    expect(small.content).toBe('1| alpha 行\n2| beta 行\n3| gamma 行\n4| delta 行\n5| ');
    expect(small.truncated).toBe(false);
    const plain = (await call('read_repo_file', { path: 'spec.md', repo: devId })) as { content?: string };
    expect(plain.content).toBe(DOC);
    const big = (await call('read_repo_file', { path: 'big.txt', repo: devId, numbered: true })) as { content?: string; truncated?: boolean };
    expect(big.truncated).toBe(true);
    expect(big.content!.startsWith('1| x\n2| x')).toBe(true);
    expect(big.content!.length).toBeLessThanOrEqual(60 * 1024);
  });
});

describe('交接开发台', () => {
  const handoff = (id: string, body: Record<string, unknown>) => req('POST', `/api/docs/${id}/handoff`, body);

  it('门禁不过不能空手交接；人工放行要理由；缺目标永远不可放行', async () => {
    const bare = (await call('write_doc', { title: 'x', content: '# x\n\n内容。\n' })) as DocOut;
    const noTarget = await handoff(bare.id!, { module: 'docs/', priority: 'p1', citations: 'strip' });
    expect(noTarget.status).toBe(400);
    const noTargetOvr = await handoff(bare.id!, { module: 'docs/', priority: 'p1', citations: 'strip', overrideReason: '紧急' });
    expect(noTargetOvr.status).toBe(400);
    expect((await json(noTargetOvr)).error).toContain('交接条件未满足');

    const withTarget = (await call('write_doc', { title: 'y', content: '# y\n\n内容。\n', target_repo: devId, target_path: 'docs/y.md' })) as DocOut;
    const noOvr = await handoff(withTarget.id!, { module: 'docs/', priority: 'p1', citations: 'strip' });
    expect(noOvr.status).toBe(400);
    expect((await json(noOvr)).error).toContain('人工放行要填写理由');
    const blank = await handoff(withTarget.id!, { module: 'docs/', priority: 'p1', citations: 'strip', overrideReason: '  ' });
    expect(blank.status).toBe(400);
    const ok = await handoff(withTarget.id!, { module: 'docs/', priority: 'p1', citations: 'strip', overrideReason: '先发版再补核对' });
    expect(ok.status).toBe(201);
    const doc = await readDoc(withTarget.id!);
    expect(doc.status).toBe('handed_off');
    expect(doc.handoff?.override).toBe('先发版再补核对');
  });

  it('交接产出 doc_handoff 工件 + dev.issue 任务（input.doc_artifact），文档拨 handed_off', async () => {
    const id = await readyDoc();
    const res = await handoff(id, { module: 'docs/', priority: 'p1', note: '注意措辞', citations: 'strip' });
    expect(res.status).toBe(201);
    const { taskId, artifactId } = await json<{ taskId: string; artifactId: string }>(res);
    const doc = await readDoc(id);
    expect(doc.status).toBe('handed_off');
    expect(doc.handoff).toMatchObject({ taskId, artifactId, path: 'docs/guide.md', repo: devId });

    const a = (await db.select().from(artifact).where(eq(artifact.id, artifactId)))[0]!;
    expect(a.type).toBe('doc_handoff');
    expect(a.ref).toContain('三步接入');
    const t = (await db.select().from(task).where(eq(task.id, taskId)))[0]!;
    expect(t.workstationId).toBe(devId);
    expect(t.typeId).toBe('dev.issue');
    const input = JSON.parse(t.inputJson ?? '{}') as { kind?: string; doc_artifact?: string; module?: string };
    expect(input.doc_artifact).toBe(artifactId);
    expect(input.kind).toBe('chore');
    expect(input.module).toBe('docs/');
    expect(JSON.parse(t.acceptanceJson ?? '[]')[0].text).toContain('docs/guide.md');
  });

  it('read_doc_handoff：未变回 false；目标文件被改回 true 并带 currentContent；子任务沿祖先找到', async () => {
    const id = await readyDoc();
    const res = await handoff(id, { module: 'docs/', priority: 'p1', citations: 'footnotes' });
    const { taskId } = await json<{ taskId: string }>(res);
    const t = (await db.select().from(task).where(eq(task.id, taskId)))[0]!;

    const fresh = (await callTask('read_doc_handoff', {}, t)) as { changedSinceHandoff?: boolean; instructions?: string; content?: string; currentContent?: string };
    expect(fresh.changedSinceHandoff).toBe(false);
    expect(fresh.instructions).toContain('逐字');
    expect(fresh.content).toContain('三步接入');

    mkdirSync(path.join(repo, 'docs'), { recursive: true });
    writeFileSync(path.join(repo, 'docs', 'guide.md'), '别人先写的版本\n');
    g('add', '-A');
    g('commit', '-m', 'touch target');
    const changed = (await callTask('read_doc_handoff', {}, t)) as { changedSinceHandoff?: boolean; instructions?: string; currentContent?: string };
    expect(changed.changedSinceHandoff).toBe(true);
    expect(changed.currentContent).toContain('别人先写的版本');
    expect(changed.instructions).toContain('合并');

    const child = await createTaskUc(HUMAN, db, devId, { title: '子任务', parentId: taskId, typeId: 'dev.issue', input: { kind: 'chore', priority: 'p2', module: 'docs/' } });
    if (child.kind !== 'ok') throw new Error(child.error);
    const childRow = (await db.select().from(task).where(eq(task.id, child.task!.id)))[0]!;
    const viaChild = (await callTask('read_doc_handoff', {}, childRow)) as { changedSinceHandoff?: boolean };
    expect(viaChild.changedSinceHandoff).toBe(true);
  });

  it('对账：任务合并 → published 记 merge sha；取消 → 按核对有效性退回', async () => {
    const id = await readyDoc();
    const { taskId } = await json<{ taskId: string }>(await handoff(id, { module: 'docs/', priority: 'p1', citations: 'strip' }));
    mkdirSync(path.join(repo, 'docs'), { recursive: true });
    writeFileSync(path.join(repo, 'docs', 'guide.md'), '# 指南\n\n三步接入。\n');
    g('add', '-A');
    g('commit', '-m', 'write doc');
    const mergeSha = g('rev-parse', 'develop').toString().trim();
    await db.update(task).set({ status: 'done', codeRefJson: JSON.stringify({ merge_sha: mergeSha }) }).where(eq(task.id, taskId));
    await reconcileDocHandoffs(db);
    const pub = await readDoc(id);
    expect(pub.status).toBe('published');
    expect(pub.handoff?.publishedCommit).toBe(mergeSha);
    expect(pub.handoff?.publishedBlob).toBeTruthy();

    // 有有效核对的取消 → approved；没有核对的取消 → draft；两次对账幂等
    const id2 = await readyDoc('docs/second.md');
    const { taskId: t2 } = await json<{ taskId: string }>(await handoff(id2, { module: 'docs/', priority: 'p1', citations: 'strip' }));
    await db.update(task).set({ status: 'cancelled' }).where(eq(task.id, t2));
    const id3 = (await call('write_doc', { title: '未审', content: '# 未审\n\n内容。\n', target_repo: devId, target_path: 'docs/third.md' })) as DocOut;
    const { taskId: t3 } = await json<{ taskId: string }>(await handoff(id3.id!, { module: 'docs/', priority: 'p1', citations: 'strip', overrideReason: '紧急' }));
    await db.update(task).set({ status: 'cancelled' }).where(eq(task.id, t3));
    await reconcileDocHandoffs(db);
    await reconcileDocHandoffs(db);
    expect((await readDoc(id2)).status).toBe('approved');
    expect((await readDoc(id2)).handoff?.cancelled).toBe(true);
    expect((await readDoc(id3.id!)).status).toBe('draft');
    expect((await readDoc(id)).status).toBe('published');
  });
});

describe('导出', () => {
  it('md strip 去掉引用标记；footnotes 追加脚注行；html 不带可执行 script', async () => {
    const d = (await call('write_doc', {
      title: '接入', kind: 'guide',
      content: '# 接入\n\n看代码[^r1]。\n\n<script>alert(1)</script>\n',
      target_repo: devId, target_path: 'docs/intro.md',
      citations: [{ id: 'r1', kind: 'repo', repo: devId, path: 'spec.md', lines: [1, 2] }],
    })) as DocOut;
    expect(d.error).toBeUndefined();

    const strip = await req('GET', `/api/docs/${d.id}/export?format=md&citations=strip`);
    expect(strip.status).toBe(200);
    const stripText = await strip.text();
    expect(stripText).toContain('看代码。');
    expect(stripText).not.toContain('[^r1]');
    expect(strip.headers.get('content-disposition')).toContain('v1.md');

    const foot = await req('GET', `/api/docs/${d.id}/export?format=md`);
    const footText = await foot.text();
    expect(footText).toContain('看代码[^r1]。');
    expect(footText).toContain('[^r1]: `spec.md` 第 1–2 行');

    const html = await req('GET', `/api/docs/${d.id}/export?format=html`);
    expect(html.status).toBe(200);
    const htmlText = await html.text();
    expect(htmlText).toContain('<h1>');
    expect(htmlText).not.toContain('<script>alert');
  });

  it.skipIf(!HAS_CHROMIUM)('pdf 输出 %PDF', async () => {
    const d = (await call('write_doc', { title: 'x', content: '# x\n\n内容。\n' })) as DocOut;
    const res = await req('GET', `/api/docs/${d.id}/export?format=pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });
});

// ===== P4：引用漂移 / 反向漂移 / 合并影响 / 发布说明 =====

// spec.md 前两行是 alpha/beta；文档把 [^impl] 钉在 1–2 行上
const citedDoc = async (title = '规格', approved = false) => {
  const d = (await call('write_doc', {
    title, content: `# ${title}\n\n按实现[^impl]。`,
    citations: [{ id: 'impl', kind: 'repo', repo: devId, path: 'spec.md', lines: [1, 2] }],
  })) as DocOut;
  if (!d.id) throw new Error(d.error);
  if (approved) await call('save_doc_review', { id: d.id, contentHash: await hashOf(d.id), verdict: 'pass', summary: '都对', findings: [] }, 'fact-checker');
  return d.id;
};
interface DriftView { items: { id: string; status: string; newLines?: [number, number] }[]; reverse?: { status: string; currentBlob: string | null } | null }
const driftOf = async (id: string) => ((await readDoc(id)) as unknown as { drift?: DriftView }).drift;
const commitAll = (msg: string) => {
  g('add', '-A');
  g('commit', '-m', msg);
  return g('rev-parse', 'develop').toString().trim();
};
const driftInbox = () => db.select().from(inboxItem).where(eq(inboxItem.kind, 'docs_drift'));
const threadTexts = async () => (await db.select().from(message).where(eq(message.threadId, (await wsThreadOf(db, wsId)).id))).map((m) => m.content ?? '');

describe('引用漂移', () => {
  it('无关文件和同文件别处的变化不算漂移；两轮巡检不写新版本', async () => {
    const id = await citedDoc();
    const v0 = (await readDoc(id)).version;
    writeFileSync(path.join(repo, 'other.md'), '别的\n');
    commitAll('other');
    writeFileSync(path.join(repo, 'spec.md'), `${DOC}zeta 行\n`);
    commitAll('tail');
    await checkDocDrift(db);
    await checkDocDrift(db);
    const after = await readDoc(id);
    expect(await driftOf(id)).toBeUndefined();
    expect(after.version).toBe(v0);
    expect(after.status).toBe('draft');
  });

  it('片段挪位 → moved 不拨 stale；repoint 重指行号且核对仍有效', async () => {
    const id = await citedDoc('规格', true);
    writeFileSync(path.join(repo, 'spec.md'), `新行一\n新行二\n${DOC}`);
    commitAll('move');
    await checkDocDrift(db);
    expect((await driftOf(id))?.items).toEqual([{ id: 'impl', status: 'moved', newLines: [3, 4], commit: expect.any(String) }]);
    expect((await readDoc(id)).status).toBe('approved');
    const res = await req('POST', `/api/docs/${id}/drift/repoint`);
    expect(res.status).toBe(200);
    expect((await json<{ updated: number }>(res)).updated).toBe(1);
    const after = await readDoc(id);
    expect(after.status).toBe('approved');
    expect(after.review?.contentHash).toBe(after.contentHash);
    expect((after as unknown as { citations: { lines: [number, number] }[] }).citations[0]!.lines).toEqual([3, 4]);
    expect((await driftOf(id))?.items ?? []).toEqual([]);
  });

  it('片段被改 → changed；已核过的拨 stale，发一次收件箱和群消息，下一轮不重复', async () => {
    const id = await citedDoc('规格', true);
    writeFileSync(path.join(repo, 'spec.md'), '改动一\n改动二\ngamma 行\ndelta 行\n');
    commitAll('edit');
    await checkDocDrift(db);
    expect((await readDoc(id)).status).toBe('stale');
    expect((await driftOf(id))?.items[0]).toMatchObject({ id: 'impl', status: 'changed' });
    expect(await driftInbox()).toHaveLength(1);
    expect((await threadTexts()).some((m) => m.includes('状态拨为过时') && m.includes('impl'))).toBe(true);
    await checkDocDrift(db);
    expect(await driftInbox()).toHaveLength(1);
  });

  it('引用文件删除 → deleted；已入库的也拨 stale', async () => {
    const id = await citedDoc('规格', true);
    g('rm', 'spec.md');
    g('commit', '-m', 'rm spec');
    await checkDocDrift(db);
    expect((await driftOf(id))?.items[0]).toMatchObject({ id: 'impl', status: 'deleted' });
    expect((await readDoc(id)).status).toBe('stale');
  });

  it('知识库来源没了 → changed；草稿文档只记漂移不拨 stale', async () => {
    const src = await importSource(HUMAN, db, { projectId: 'proj-aw', name: '词汇', content: '# 词汇\n\n本文统一写作「工作台」。\n', kind: 'md' });
    if (src.kind !== 'ok') throw new Error(src.error);
    const d = (await call('write_doc', {
      title: '说明', content: '# 说明\n\n用词[^w]。',
      citations: [{ id: 'w', kind: 'knowledge', sourceId: src.id, quote: '统一写作「工作台」' }],
    })) as DocOut;
    if (!d.id) throw new Error(d.error);
    await deleteSource(HUMAN, db, src.id);
    await checkDocDrift(db);
    expect((await driftOf(d.id))?.items).toEqual([{ id: 'w', status: 'changed' }]);
    expect((await readDoc(d.id)).status).toBe('draft');
  });

  it('updateEntity 撞车时扔缓存：下一轮巡检照样算出新漂移', async () => {
    const id = await citedDoc('规格', true);
    writeFileSync(path.join(repo, 'spec.md'), '改动一\n改动二\ngamma 行\ndelta 行\n');
    commitAll('edit');
    // 只在巡检这一轮让 updateEntity 撞车：save_doc_review 等前置写入走真实现
    const entitiesMod = await import('../src/usecases/entities.js');
    const spy = vi.spyOn(entitiesMod, 'updateEntity').mockImplementationOnce(async () => ({ kind: 'conflict', status: 409, error: '撞车' }));
    await checkDocDrift(db);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await readDoc(id)).status).toBe('approved');
    expect(await driftOf(id)).toBeUndefined();
    spy.mockRestore();
    // 缓存若不扔，这一轮会沿用「没有条目」的旧记录，漂移就再也算不出来
    await checkDocDrift(db);
    expect((await driftOf(id))?.items[0]).toMatchObject({ id: 'impl', status: 'changed' });
    expect((await readDoc(id)).status).toBe('stale');
  });
});

describe('反向漂移', () => {
  // 已入库的文档：交接 → 开发任务把成品写进 docs/spec-doc.md → 对账记 publishedBlob
  const publishDoc = async () => {
    const id = await citedDoc('规格', true);
    await req('PATCH', `/api/docs/${id}`, { target_repo: devId, target_path: 'docs/spec-doc.md', baseVersion: (await readDoc(id)).version });
    const { taskId } = await json<{ taskId: string }>(await req('POST', `/api/docs/${id}/handoff`, { module: 'docs/', priority: 'p1', citations: 'footnotes' }));
    mkdirSync(path.join(repo, 'docs'), { recursive: true });
    writeFileSync(path.join(repo, 'docs', 'spec-doc.md'), '# 规格\n\n按实现[^impl]。\n\n[^impl]: `spec.md` 第 1–2 行\n');
    const mergeSha = commitAll('write doc');
    await db.update(task).set({ status: 'done', codeRefJson: JSON.stringify({ merge_sha: mergeSha }) }).where(eq(task.id, taskId));
    await reconcileDocHandoffs(db);
    return id;
  };

  it('入库后被平台外改过 → 收件箱每个新 blob 一次；ack 摘掉；导回出新草稿并摘掉孤儿引用', async () => {
    const id = await publishDoc();
    expect((await readDoc(id)).status).toBe('published');
    writeFileSync(path.join(repo, 'docs', 'spec-doc.md'), '外部直接改的文本\n');
    commitAll('external');
    await checkDocDrift(db);
    expect((await driftOf(id))?.reverse?.status).toBe('diverged');
    expect(await driftInbox()).toHaveLength(1);
    await checkDocDrift(db);
    expect(await driftInbox()).toHaveLength(1);

    const ack = await req('POST', `/api/docs/${id}/reverse/ack`);
    expect(ack.status).toBe(200);
    expect((await driftOf(id))?.reverse ?? null).toBeNull();

    writeFileSync(path.join(repo, 'docs', 'spec-doc.md'), '第二次外部改动\n');
    commitAll('external 2');
    await checkDocDrift(db);
    expect((await driftOf(id))?.reverse?.status).toBe('diverged');
    expect(await driftInbox()).toHaveLength(2);
    const imp = await req('POST', `/api/docs/${id}/reverse/import`);
    expect(imp.status).toBe(200);
    const after = await readDoc(id);
    expect(after.status).toBe('draft');
    expect(after.content).toBe('第二次外部改动\n');
    expect((after as unknown as { citations: unknown[] }).citations).toEqual([]);
    expect((await driftOf(id))?.reverse ?? null).toBeNull();
  });
});

describe('合并影响', () => {
  const mergedTask = async (title: string, sha: string) => {
    const t = await createTaskUc(HUMAN, db, devId, { title, typeId: 'dev.issue', input: { kind: 'chore', priority: 'p1', module: 'core' } });
    if (t.kind !== 'ok') throw new Error(t.error);
    await db.update(task).set({ codeRefJson: JSON.stringify({ merge_sha: sha }) }).where(eq(task.id, t.task!.id));
    return t.task!.id;
  };

  it('off 发状态消息；affected 发 @主笔 起草消息；交接自己的任务不重复提醒', async () => {
    await citedDoc('规格');
    writeFileSync(path.join(repo, 'spec.md'), 'alpha2 行\nbeta 行\ngamma 行\ndelta 行\n');
    const t1 = await mergedTask('改实现', commitAll('merge work'));
    await noteMergeImpact(db, t1);
    expect((await threadTexts()).some((m) => m.includes('已合并，可能影响') && m.includes('规格'))).toBe(true);
    expect((await db.select().from(eventLog).where(eq(eventLog.action, 'doc_impact'))).length).toBe(1);

    const put = await req('PUT', `/api/workstations/${wsId}/docs-settings`, { autoDraft: 'affected' });
    expect(put.status).toBe(200);
    writeFileSync(path.join(repo, 'spec.md'), 'alpha3 行\nbeta 行\ngamma 行\ndelta 行\n');
    const t2 = await mergedTask('再改实现', commitAll('merge work 2'));
    await noteMergeImpact(db, t2);
    const texts = await threadTexts();
    expect(texts.some((m) => m.includes('@主笔') && m.includes('改动了这些文件') && m.includes('spec.md') && m.includes('不要交接'))).toBe(true);

    // 交接任务本身合并时只走 published 对账，不重复报"可能影响"
    const own = await citedDoc('独享', true);
    await req('PATCH', `/api/docs/${own}`, { target_repo: devId, target_path: 'docs/own.md', baseVersion: (await readDoc(own)).version });
    const { taskId: ownTask } = await json<{ taskId: string }>(await req('POST', `/api/docs/${own}/handoff`, { module: 'docs/', priority: 'p1', citations: 'strip' }));
    writeFileSync(path.join(repo, 'spec.md'), 'alpha4 行\nbeta 行\ngamma 行\ndelta 行\n');
    await db.update(task).set({ codeRefJson: JSON.stringify({ merge_sha: commitAll('merge own') }) }).where(eq(task.id, ownTask));
    await noteMergeImpact(db, ownTask);
    const texts2 = await threadTexts();
    const last = texts2.filter((m) => m.includes('可能影响') || m.includes('改动了这些文件')).at(-1)!;
    expect(last).toContain('《规格》');
    expect(last).not.toContain('《独享》');
  });
});

describe('发布说明', () => {
  const mkTask = async (title: string, createdAt: string, milestoneId?: string) => {
    const t = await createTaskUc(HUMAN, db, devId, { title, typeId: 'dev.issue', input: { kind: 'feature', priority: 'p1', module: 'auth' } });
    if (t.kind !== 'ok') throw new Error(t.error);
    await db.update(task).set({ codeRefJson: JSON.stringify({ merge_sha: 'a'.repeat(40) }), createdAt, ...(milestoneId ? { milestoneId } : {}) }).where(eq(task.id, t.task!.id));
    return t.task!.id;
  };
  // 合并时间走 proposal_merged 事件（proposal → task）
  const mergedEvent = async (taskId: string, at: string, suffix: string) => {
    await db.insert(proposal).values({ id: `prop-${suffix}`, taskId, workstationId: devId, status: 'merged', createdAt: at });
    await db.insert(eventLog).values({ id: `ev-${suffix}`, actorType: 'human', actorId: 'local', action: 'proposal_merged', targetType: 'proposal', targetId: `prop-${suffix}`, createdAt: at });
  };

  it('按合并时间过滤：since 前创建但范围内合并的收，范围内创建但 until 后合并的不收；空范围 400', async () => {
    const a = await mkTask('老任务', '2025-01-01T00:00:00Z');
    await mergedEvent(a, '2025-06-15T00:00:00Z', 'a');
    const b = await mkTask('晚合并', '2025-06-10T00:00:00Z');
    await mergedEvent(b, '2025-08-01T00:00:00Z', 'b');
    const c = await mkTask('正常合并', '2025-05-20T00:00:00Z');
    await mergedEvent(c, '2025-06-01T00:00:00Z', 'c');

    const res = await req('POST', `/api/workstations/${wsId}/release-notes`, { since: '2025-06-01T00:00:00Z', until: '2025-07-01T00:00:00Z' });
    expect(res.status).toBe(201);
    expect((await json<{ count: number }>(res)).count).toBe(2);
    const draft = (await threadTexts()).find((m) => m.includes('@主笔') && m.includes('release_notes'))!;
    expect(draft).toContain('老任务');
    expect(draft).toContain('正常合并');
    expect(draft).not.toContain('晚合并');

    const empty = await req('POST', `/api/workstations/${wsId}/release-notes`, { since: '2999-01-01T00:00:00Z' });
    expect(empty.status).toBe(400);
    expect((await json(empty)).error).toContain('没有已合并的任务');
  });

  it('按里程碑起草：只看任务是否已合并，不受合并时间影响', async () => {
    await mkTask('加了登录', '2025-01-01T00:00:00Z', 'ms-1');
    const root = (await db.select().from(workstation).where(eq(workstation.pluginId, 'pm')))[0]!;
    const at = new Date().toISOString();
    await db.insert(entity).values({ id: 'ms-1', workstationId: root.id, entityType: 'Milestone', dataJson: JSON.stringify({ name: 'v1.0' }), version: 1, createdAt: at, updatedAt: at });
    const res = await req('POST', `/api/workstations/${wsId}/release-notes`, { milestoneId: 'ms-1' });
    expect(res.status).toBe(201);
    expect((await threadTexts()).some((m) => m.includes('里程碑「v1.0」') && m.includes('加了登录'))).toBe(true);
  });
});
