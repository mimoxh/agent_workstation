import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, proposal, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { resolveInside } from '../src/runtime/folder.js';
import { executeTool, type RunCtx } from '../src/runtime/tools/index.js';
import { buildPermCtx } from '../src/usecases/index.js';

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let root: typeof workstation.$inferSelect;
let dev: typeof workstation.$inferSelect;
let dir: string;
const tmps: string[] = [];

const post = (path: string, body?: unknown, method = 'POST') =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-folder-test-'));
  tmps.push(d);
  return d;
};

const setFolder = async (p: string | null) => post('/api/projects/proj-aw', { folder: p }, 'PATCH');

const pmAgent = async () => (await db.select().from(agent).where(and(eq(agent.workstationId, root.id), eq(agent.templateId, 'pm'))))[0]!;

const agentCtx = async (): Promise<RunCtx> => {
  const a = await pmAgent();
  const actor = { type: 'agent', id: a.id } as const;
  return { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: null, run: { id: 'r' } as never };
};

beforeEach(async () => {
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  migrateDb(r.sqlite);
  await seed(db);
  app = createApp(db).app;
  root = (await db.select().from(workstation).where(eq(workstation.pluginId, 'pm')))[0]!;
  dev = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!;
  dir = tmp();
});

afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('项目文件夹绑定', () => {
  it('POST /projects 带 folder 绑定，非法路径报 400，PATCH null 解绑', async () => {
    const ok = await post('/api/projects', { name: '写作', folder: dir });
    expect(ok.status).toBe(201);
    const { id } = (await ok.json()) as { id: string };
    const detail = (await (await app.request(`/api/projects/${id}`)).json()) as { folderPath: string };
    expect(detail.folderPath).toBe(path.resolve(dir));

    expect(((await post('/api/projects', { name: 'x', folder: path.join(dir, 'nope') })).status)).toBe(400);
    const rel = await post('/api/projects', { name: 'x', folder: 'relative/dir' });
    expect(rel.status).toBe(400);
    expect(((await rel.json()) as { error: string }).error).toBe('文件夹路径必须是绝对路径');
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'x');
    expect(((await post('/api/projects', { name: 'x', folder: file })).status)).toBe(400);

    expect((await post('/api/projects', { name: 'x' })).status).toBe(201);
    expect((await setFolder(dir)).status).toBe(200);
    const patched = (await (await app.request('/api/projects/proj-aw')).json()) as { folderPath: string };
    expect(patched.folderPath).toBe(path.resolve(dir));
    expect((await setFolder(null)).status).toBe(200);
    expect(((await (await app.request('/api/projects/proj-aw')).json()) as { folderPath: string | null }).folderPath).toBeNull();
  });
});

describe('resolveInside', () => {
  it('拒绝越界、绝对路径和 .git 写入路径', () => {
    expect(resolveInside(dir, '../x').ok).toBe(false);
    expect(resolveInside(dir, 'a/../../x').ok).toBe(false);
    expect(resolveInside(dir, '/etc/passwd').ok).toBe(false);
    expect(resolveInside(dir, 'a/b.txt', { forFile: true }).ok).toBe(true);
    expect(resolveInside(dir, '', { forFile: true }).ok).toBe(false);
    expect(resolveInside(dir, '').ok).toBe(true);
  });

  it('符号链接逃逸被拒绝', () => {
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    const link = path.join(dir, 'link');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      return; // Windows 无权限建符号链接时跳过
    }
    expect(resolveInside(dir, 'link/secret.txt').ok).toBe(false);
    expect(resolveInside(dir, 'link').ok).toBe(false);
  });
});

describe('文件夹路由与工具', () => {
  beforeEach(async () => {
    fs.mkdirSync(path.join(dir, 'sub', 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.md'), 'hello folder\n第二行 keyword 命中\n');
    fs.writeFileSync(path.join(dir, 'sub', 'inner.txt'), 'inner keyword\n');
    fs.writeFileSync(path.join(dir, 'sub', 'node_modules', 'dep.js'), 'keyword\n');
    fs.writeFileSync(path.join(dir, '.git', 'config'), 'keyword\n');
    await setFolder(dir);
  });

  it('列出与读取文件，忽略 node_modules 与 .git', async () => {
    const list = (await (await app.request('/api/projects/proj-aw/folder/files')).json()) as { entries: { name: string; type: string }[] };
    expect(list.entries.map((e) => e.name)).toEqual(['sub', 'notes.md']);
    const file = (await (await app.request('/api/projects/proj-aw/folder/file?path=notes.md')).json()) as { content: string };
    expect(file.content).toContain('hello folder');
    const sub = (await (await app.request('/api/projects/proj-aw/folder/files?path=sub')).json()) as { entries: { name: string }[] };
    expect(sub.entries.map((e) => e.name)).toEqual(['inner.txt']);
    expect((await app.request('/api/projects/proj-aw/folder/file?path=../x')).status).toBe(400);
  });

  it('未绑定文件夹时路由报错', async () => {
    await setFolder(null);
    expect((await app.request('/api/projects/proj-aw/folder/files')).status).toBe(404);
  });

  it('read_folder_file / search_folder 走 Agent 工具', async () => {
    const ctx = await agentCtx();
    const read = (await executeTool(ctx, 'read_folder_file', { path: 'notes.md', numbered: true })) as { content: string };
    expect(read.content).toContain('1| hello folder');
    const search = (await executeTool(ctx, 'search_folder', { query: 'keyword' })) as { matches: string[] };
    expect(search.matches).toHaveLength(2);
    expect(search.matches[0]).toContain('notes.md:2');
    await setFolder(null);
    expect(((await executeTool(ctx, 'list_folder', {})) as { error: string }).error).toBe('项目还没有绑定文件夹');
  });
});

describe('propose_file_change', () => {
  beforeEach(async () => {
    fs.writeFileSync(path.join(dir, 'notes.md'), 'alpha\nbeta\ngamma\n');
    await setFolder(dir);
  });

  it('edits 生成带 diff 的提案，审批后落盘；基线被改过则 superseded', async () => {
    const ctx = await agentCtx();
    const r = (await executeTool(ctx, 'propose_file_change', {
      path: 'notes.md',
      edits: [{ oldText: 'beta', newText: 'BETA2' }],
      reason: '改一行',
    })) as { proposalId?: string; error?: string };
    expect(r.proposalId).toBeTruthy();
    const p = (await db.select().from(proposal).where(eq(proposal.id, r.proposalId!)))[0]!;
    expect(p.targetType).toBe('file');
    const patch = JSON.parse(p.patchJson!) as { path: string; before: string; after: string; baseHash: string; diff: string };
    expect(patch.diff).toContain(`--- a/notes.md`);
    expect(patch.diff).toContain('-beta');
    expect(patch.diff).toContain('+BETA2');

    expect((await post(`/api/proposals/${r.proposalId}/approve`)).status).toBe(200);
    expect(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8')).toBe('alpha\nBETA2\ngamma\n');

    // 同一基线再提案 → 磁盘被人改过 → 审批返回 409 并标 superseded
    const r2 = (await executeTool(ctx, 'propose_file_change', { path: 'notes.md', edits: [{ oldText: 'alpha', newText: 'A' }], reason: 'x' })) as { proposalId: string };
    fs.writeFileSync(path.join(dir, 'notes.md'), 'human edit\n');
    const res = await post(`/api/proposals/${r2.proposalId}/approve`);
    expect(res.status).toBe(409);
    expect((await db.select().from(proposal).where(eq(proposal.id, r2.proposalId)))[0]!.status).toBe('superseded');
    expect(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8')).toBe('human edit\n');
  });

  it('新文件提案审批后创建嵌套目录；歧义 oldText 报错；.git 不可写', async () => {
    const ctx = await agentCtx();
    const made = (await executeTool(ctx, 'propose_file_change', { path: 'a/b/c.md', content: '# new\n', reason: '新文档' })) as { proposalId?: string };
    expect(made.proposalId).toBeTruthy();
    expect((await post(`/api/proposals/${made.proposalId}/approve`)).status).toBe(200);
    expect(fs.readFileSync(path.join(dir, 'a', 'b', 'c.md'), 'utf8')).toBe('# new\n');

    fs.writeFileSync(path.join(dir, 'dup.md'), 'same\nsame\n');
    const ambiguous = (await executeTool(ctx, 'propose_file_change', { path: 'dup.md', edits: [{ oldText: 'same', newText: 'x' }], reason: 'x' })) as { error: string };
    expect(ambiguous.error).toContain('出现多次');
    const missing = (await executeTool(ctx, 'propose_file_change', { path: 'dup.md', edits: [{ oldText: 'nope', newText: 'x' }], reason: 'x' })) as { error: string };
    expect(missing.error).toContain('未找到');
    expect(((await executeTool(ctx, 'propose_file_change', { path: '.git/config', content: 'x', reason: 'x' })) as { error: string }).error).toBe('路径不合法');
    expect(((await executeTool(ctx, 'propose_file_change', { path: 'notes.md', content: 'alpha\nbeta\ngamma\n', reason: 'x' })) as { error: string }).error).toBe('内容没有变化');
  });
});

describe('开发台非 git 文件夹初始化', () => {
  it('repo 状态报 notGit，repo/init 初始化并可重复拒绝', async () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, 'readme.md'), 'hi\n');
    const ws = (await db.select().from(workstation).where(eq(workstation.id, dev.id)))[0]!;
    const settings = JSON.parse(ws.settingsJson ?? '{}') as Record<string, unknown>;
    await post(`/api/workstations/${dev.id}`, { settings: { ...settings, repoPath: repo } }, 'PATCH');

    const st = (await (await app.request(`/api/workstations/${dev.id}/repo`)).json()) as { ok: boolean; notGit?: boolean };
    expect(st.ok).toBe(false);
    expect(st.notGit).toBe(true);

    const init = await post(`/api/workstations/${dev.id}/repo/init`);
    expect(init.status).toBe(200);
    expect(((await init.json()) as { files: number }).files).toBeGreaterThanOrEqual(2);
    const log = execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
    expect(log).toHaveLength(1);
    const st2 = (await (await app.request(`/api/workstations/${dev.id}/repo`)).json()) as { ok: boolean; notGit?: boolean };
    expect(st2.notGit).toBe(false);
    expect((await post(`/api/workstations/${dev.id}/repo/init`)).status).toBe(409);
  });
});
