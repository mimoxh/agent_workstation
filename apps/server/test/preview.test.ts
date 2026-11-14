import { and, eq } from 'drizzle-orm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, artifact, entity, project, task, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { runAcceptance } from '../src/runtime/dev_workflow.js';
import { createTaskWorktree, devSettings, ensureTargetBranch } from '../src/runtime/git.js';
import { previewStatus, startPreview, stopAllPreviews } from '../src/runtime/preview.js';
import { executeTool, type RunCtx } from '../src/runtime/tools/index.js';
import { diffImage } from '../src/runtime/visual.js';
import { buildPermCtx, createTaskUc } from '../src/usecases/index.js';
import { createFixtureRepo } from './fixtures.js';

const HUMAN = { type: 'human', id: 'local' } as const;
const HAS_CHROMIUM = await chromium.launch().then(async (b) => { await b.close(); return true; }).catch(() => false);

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let repo: string;
let devId: string;
let projectId: string;

const post = (url: string, body: unknown = {}) => app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const settings = (serve?: string) => devSettings(JSON.stringify({ repoPath: repo, targetBranch: 'develop', baseBranch: 'main', commands: serve ? { serve } : {} }));
const setServe = async (serve?: string) => {
  await db.update(workstation).set({ settingsJson: JSON.stringify({ repoPath: repo, targetBranch: 'develop', baseBranch: 'main', commands: serve ? { serve } : {} }) }).where(eq(workstation.id, devId));
};
const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor 超时');
};

const SERVE_JS = (html: string) => `require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end(${JSON.stringify(html)})}).listen(Number(process.env.PORT));\n`;

// 不建 git worktree 的轻量任务：codeRef 指到一个临时目录即可触发预览
async function fakeTask(withServe = true) {
  const dir = path.join(tmpdir(), `aw-preview-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
  mkdirSync(dir, { recursive: true });
  if (withServe) writeFileSync(path.join(dir, 'serve.js'), SERVE_JS('<body>ok</body>'));
  const id = crypto.randomUUID();
  await db.insert(task).values({ id, projectId, workstationId: devId, title: 't', inputJson: '{}', status: 'in_progress', codeRefJson: JSON.stringify({ worktree: dir }), createdAt: new Date().toISOString() });
  return { id, dir };
}

async function ctxOf(a: typeof agent.$inferSelect, t: typeof task.$inferSelect | null = null): Promise<RunCtx> {
  const actor = { type: 'agent', id: a.id } as const;
  return { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: t, run: { id: 'r' } as never };
}
const designer = async () => (await db.select().from(agent).where(and(eq(agent.workstationId, devId), eq(agent.templateId, 'designer'))))[0]!;

beforeEach(async () => {
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  migrateDb(r.sqlite);
  await seed(db);
  app = createApp(db).app;
  repo = createFixtureRepo();
  const ws = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!;
  devId = ws.id;
  projectId = ws.projectId;
  await setServe();
  const ok = await ensureTargetBranch(settings());
  expect(ok.ok).toBe(true);
});

afterEach(() => stopAllPreviews());

describe('diffImage', () => {
  const png = (w: number, h: number, rgb: [number, number, number]) => {
    const p = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h * 4; i += 4) { p.data[i] = rgb[0]; p.data[i + 1] = rgb[1]; p.data[i + 2] = rgb[2]; p.data[i + 3] = 255; }
    return PNG.sync.write(p);
  };

  it('相同图片差异为 0 且有差异图，尺寸不同视为完全不同且没有差异图', () => {
    const same = diffImage(png(10, 10, [255, 255, 255]), png(10, 10, [255, 255, 255]));
    expect(same.ratio).toBe(0);
    expect(same.png).not.toBeNull();
    expect(diffImage(png(10, 10, [255, 255, 255]), png(8, 10, [255, 255, 255]))).toEqual({ ratio: 1, png: null });
    const flipped = diffImage(png(10, 10, [0, 0, 0]), png(10, 10, [255, 255, 255]));
    expect(flipped.ratio).toBe(1);
    expect(flipped.png).not.toBeNull();
  });
});

describe('任务预览', () => {
  it('没有工作区 → 409；没配 serve → 400', async () => {
    const plain = crypto.randomUUID();
    await db.insert(task).values({ id: plain, projectId, workstationId: devId, title: 't', inputJson: '{}', status: 'in_progress', createdAt: new Date().toISOString() });
    const noWt = await post(`/api/tasks/${plain}/preview`);
    expect(noWt.status).toBe(409);
    expect(((await noWt.json()) as { error: string }).error).toContain('任务还没有工作区');

    const t = await fakeTask();
    const noServe = await post(`/api/tasks/${t.id}/preview`);
    expect(noServe.status).toBe(400);
    expect(((await noServe.json()) as { error: string }).error).toContain('视觉验收服务');
  });

  it('serve 起好后转 running，DELETE 停掉，再起是新一轮', async () => {
    await setServe('node serve.js');
    const t = await fakeTask();
    const started = await post(`/api/tasks/${t.id}/preview`);
    expect(started.status).toBe(200);
    expect(((await started.json()) as { status: string }).status).toBe('starting');
    await waitFor(async () => (await (await app.request(`/api/tasks/${t.id}/preview`)).json() as { status: string }).status === 'running');
    const st = (await (await app.request(`/api/tasks/${t.id}/preview`)).json()) as { status: string; url: string };
    expect(st.url).toMatch(/^http:\/\/localhost:\d+\/$/);
    expect((await fetch(st.url)).status).toBe(200);

    expect((await app.request(`/api/tasks/${t.id}/preview`, { method: 'DELETE' })).status).toBe(200);
    expect(((await (await app.request(`/api/tasks/${t.id}/preview`)).json()) as { status: string }).status).toBe('stopped');
    await waitFor(async () => { try { await fetch(st.url, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } });
  }, 30000);

  it('serve 进程提前退出 → failed，带上进程输出', async () => {
    await setServe('node crash.js');
    const t = await fakeTask();
    writeFileSync(path.join(t.dir, 'crash.js'), "console.error('boom'); process.exit(3);\n");
    expect((await post(`/api/tasks/${t.id}/preview`)).status).toBe(200);
    await waitFor(() => previewStatus(t.id).status === 'failed');
    const st = previewStatus(t.id);
    expect('error' in st && st.error).toContain('提前退出');
  });

  it('最多 3 个预览，第 4 个 409', async () => {
    await setServe('node serve.js');
    const tasks = await Promise.all([fakeTask(), fakeTask(), fakeTask()]);
    for (const t of tasks) expect((await startPreview(db, t.id)).kind).toBe('ok');
    const fourth = await fakeTask();
    const r = await post(`/api/tasks/${fourth.id}/preview`);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toContain('最多 3 个预览');
  });

  it('验收要用同一个 worktree 起服务时先停掉预览', async () => {
    await setServe('node serve.js');
    const created = await createTaskUc(HUMAN, db, devId, { title: 'T', typeId: 'dev.issue', input: { kind: 'feature', priority: 'p1', module: 'src/board' } });
    const id = created.task!.id;
    const ref = await createTaskWorktree(settings(), devId, id);
    await db.update(task).set({ codeRefJson: JSON.stringify(ref), status: 'in_progress' }).where(eq(task.id, id));
    writeFileSync(path.join(ref.worktree, 'serve.js'), SERVE_JS('<body>ok</body>'));
    const started = await startPreview(db, id);
    expect(started.kind).toBe('ok');
    await waitFor(() => previewStatus(id).status === 'running');

    const checks = [{ kind: 'design_match', url: 'http://127.0.0.1:{port}/', artifact: 'nonexistent' }];
    const r = await runAcceptance(db, devId, ref.worktree, checks, 60, id, { serve: 'node serve.js' });
    expect(previewStatus(id)).toEqual({ status: 'stopped' });
    expect(r.results[0]).toMatchObject({ status: 'error', env: false });
    expect(r.results[0]!.output).toContain('设计交接件不存在或不属于本项目');
  }, 30000);
});

describe('design_match 验收', () => {
  const handoffArtifact = async (html: string, ws = devId) => {
    const id = crypto.randomUUID();
    await db.insert(artifact).values({ id, workstationId: ws, type: 'design_handoff', name: '稿', ref: html, createdAt: new Date().toISOString() });
    return id;
  };
  const wt = async () => {
    const created = await createTaskUc(HUMAN, db, devId, { title: 'T', typeId: 'dev.issue', input: { kind: 'feature', priority: 'p1', module: 'src/board' } });
    const ref = await createTaskWorktree(settings(), devId, created.task!.id);
    await db.update(task).set({ codeRefJson: JSON.stringify(ref), status: 'in_progress' }).where(eq(task.id, created.task!.id));
    return { id: created.task!.id, worktree: ref.worktree };
  };

  it('交接件不存在、类型不对或跨项目都报同一个错', async () => {
    const t = await wt();
    const checks = (artifactId: string) => [{ kind: 'design_match', url: 'http://127.0.0.1:{port}/', artifact: artifactId }];
    expect((await runAcceptance(db, devId, t.worktree, checks('nope'), 60, t.id)).results[0]!.output).toContain('设计交接件不存在或不属于本项目');

    const now = new Date().toISOString();
    await db.insert(artifact).values({ id: 'shot', workstationId: devId, type: 'screenshot', name: 'x', ref: 'x', createdAt: now });
    expect((await runAcceptance(db, devId, t.worktree, checks('shot'), 60, t.id)).results[0]!.output).toContain('设计交接件不存在或不属于本项目');

    await db.insert(project).values({ id: 'proj-x', workspaceId: 'default', name: 'x', createdAt: now });
    await db.insert(workstation).values({ id: 'ws-x', projectId: 'proj-x', name: 'x', createdAt: now });
    await db.insert(artifact).values({ id: 'art-x', workstationId: 'ws-x', type: 'design_handoff', name: 'x', ref: '<html/>', createdAt: now });
    expect((await runAcceptance(db, devId, t.worktree, checks('art-x'), 60, t.id)).results[0]!.output).toContain('设计交接件不存在或不属于本项目');
  });

  it('serve 起不来算环境错误', async () => {
    const t = await wt();
    const art = await handoffArtifact('<html><body>x</body></html>');
    const checks = [{ kind: 'design_match', url: 'http://127.0.0.1:{port}/', artifact: art }];
    const r = await runAcceptance(db, devId, t.worktree, checks, 60, t.id, { serve: 'node missing-server.js' });
    expect(r.results[0]).toMatchObject({ status: 'error', env: true });
    const run = (await db.select().from(entity).where(eq(entity.entityType, 'TestRun')))[0]!;
    expect(JSON.parse(run.dataJson!)).toMatchObject({ command: `design_match http://127.0.0.1:{port}/`, status: 'error', env_error: true });
  }, 30000);

  it.skipIf(!HAS_CHROMIUM)('1280×800 对比：一致通过、产三张截图 artifact 和带 meta 的 test_output', async () => {
    const html = '<!doctype html><html><body style="margin:0;background:#fff"><h1>hi</h1></body></html>';
    const t = await wt();
    writeFileSync(path.join(t.worktree, 'serve.js'), SERVE_JS(html));
    const art = await handoffArtifact(html);
    const checks = [{ kind: 'design_match', url: 'http://127.0.0.1:{port}/', artifact: art }];
    const r = await runAcceptance(db, devId, t.worktree, checks, 60, t.id, { serve: 'node serve.js' });
    expect(r).toMatchObject({ allPassed: true, envError: false });
    expect(r.results[0]!.status).toBe('passed');

    const out = (await db.select().from(artifact).where(eq(artifact.type, 'test_output')))[0]!;
    const meta = JSON.parse(out.metaJson!) as { kind: string; ratio: number; maxDiff: number; designShot: string; actualShot: string; diffShot: string | null; artifact: string };
    expect(meta).toMatchObject({ kind: 'design_match', maxDiff: 0.25, artifact: art });
    expect(meta.ratio).toBeLessThanOrEqual(0.25);
    const shots = await db.select().from(artifact).where(eq(artifact.type, 'screenshot'));
    expect([meta.designShot, meta.actualShot, meta.diffShot].sort()).toEqual(shots.map((s) => s.id).sort());
    for (const s of shots) expect((await app.request(`/api/artifacts/${s.id}/image`)).headers.get('content-type')).toBe('image/png');
  }, 120000);

  it.skipIf(!HAS_CHROMIUM)('差异超过上限判失败', async () => {
    const t = await wt();
    writeFileSync(path.join(t.worktree, 'serve.js'), SERVE_JS('<body style="margin:0;background:#000"></body>'));
    const art = await handoffArtifact('<!doctype html><html><body style="margin:0;background:#fff"></body></html>');
    const checks = [{ kind: 'design_match', url: 'http://127.0.0.1:{port}/', artifact: art }];
    const r = await runAcceptance(db, devId, t.worktree, checks, 60, t.id, { serve: 'node serve.js' });
    expect(r.results[0]!.status).toBe('failed');
  }, 120000);
});

describe('交接带页面地址', () => {
  const handoff = (id: string, body: Record<string, unknown>) =>
    app.request(`/api/designs/${id}/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetWorkstationId: devId, module: 'src/board', priority: 'p1', ...body }) });
  const writeDesign = async () => ((await executeTool(await ctxOf(await designer()), 'write_design', { title: '首页', html: '<h1>x</h1>' })) as { id: string }).id;

  it('pageUrl 追加 design_match 验收，非本机地址被拒', async () => {
    const d = await writeDesign();
    expect((await handoff(d, { pageUrl: 'http://evil.example.com/' })).status).toBe(400);
    expect((await handoff(d, { pageUrl: 'ftp://localhost/' })).status).toBe(400);
    expect((await handoff(d, { pageUrl: 'not a url' })).status).toBe(400);

    const res = await handoff(d, { pageUrl: 'http://localhost:{port}/' });
    expect(res.status).toBe(201);
    const { taskId } = (await res.json()) as { taskId: string };
    const t = (await db.select().from(task).where(eq(task.id, taskId)))[0]!;
    const acc = JSON.parse(t.acceptanceJson!) as { kind: string; url?: string; artifact?: string }[];
    const dm = acc.find((c) => c.kind === 'design_match');
    expect(dm).toMatchObject({ url: 'http://localhost:{port}/' });
    const art = (await db.select().from(artifact).where(eq(artifact.type, 'design_handoff')))[0]!;
    expect(dm!.artifact).toBe(art.id);
    expect(acc.some((c) => c.kind === 'manual')).toBe(true);
  });
});
