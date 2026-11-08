import { and, eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { agent, artifact, entity, inboxItem, proposal, task, workstation } from '../src/db/schema.js';
import { seed } from '../src/db/seed.js';
import { loadPlugins, pluginRegistry } from '../src/plugins.js';
import { afterTestRun, enqueueMerge, recoverMergeQueue, runAcceptance, submitChange } from '../src/runtime/dev_workflow.js';
import { isDependencyChange, isEnvError, portEnv } from '../src/runtime/exec.js';
import { chromium } from 'playwright-core';
import { captureScreenshot, withServer } from '../src/runtime/visual.js';
import { createTaskWorktree, devSettings, ensureIntegration, ensureRepo, ensureTargetBranch } from '../src/runtime/git.js';
import { acknowledgeDrift, checkRepos, repoDrift } from '../src/runtime/repo_watch.js';
import { inScope, parseScope } from '../src/runtime/scope.js';
import { executeTool, type ToolCtx } from '../src/runtime/tools/index.js';
import { buildRunContext } from '../src/runtime/scheduler.js';
import { buildPermCtx, createTaskUc, manifestOf } from '../src/usecases/index.js';
import { createFixtureRepo } from './fixtures.js';

const HUMAN = { type: 'human', id: 'local' } as const;
const hasBrowser = await chromium.launch().then((b) => b.close()).then(() => true, () => false);
const g = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', ...args], { cwd, stdio: 'pipe', windowsHide: true }).toString().trim();

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let repo: string;
let devId: string;

const post = (url: string, body: unknown = {}) => app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const settings = () => devSettings(JSON.stringify({ repoPath: repo, targetBranch: 'develop', baseBranch: 'main', commands: {} }));
// Windows 上 git 检出可能转成 CRLF
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const reload = async (id: string) => (await db.select().from(task).where(eq(task.id, id)))[0]!;

beforeEach(async () => {
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  migrateDb(r.sqlite);
  await seed(db);
  app = createApp(db).app;
  repo = createFixtureRepo();
  devId = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!.id;
  await db.update(workstation).set({ settingsJson: JSON.stringify({ repoPath: repo, targetBranch: 'develop', baseBranch: 'main', commands: {} }) }).where(eq(workstation.id, devId));
  const ok = await ensureTargetBranch(settings());
  expect(ok.ok).toBe(true);
});

// 一个指派给前端开发、带 worktree 的进行中任务
async function codeTask(input: Record<string, unknown> = { kind: 'feature', priority: 'p1', module: 'src/board' }, stage = 'implement') {
  const a = (await db.select().from(agent).where(and(eq(agent.workstationId, devId), eq(agent.templateId, 'frontend-dev'))))[0]!;
  const created = await createTaskUc(HUMAN, db, devId, { title: 'T', typeId: 'dev.issue', input });
  const id = created.task!.id;
  const ref = await createTaskWorktree(settings(), devId, id);
  await db.update(task).set({ codeRefJson: JSON.stringify(ref), status: 'in_progress', stage, assigneeType: 'agent', assigneeId: a.id }).where(eq(task.id, id));
  const row = await reload(id);
  const actor = { type: 'agent' as const, id: a.id };
  const ctx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: row, run: { id: 'r', trigger: 'task_assigned' } } as unknown as ToolCtx;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    (ctx as { task: unknown }).task = await reload(id);
    return (await executeTool(ctx, name, args)) as Record<string, unknown> & { error?: string };
  };
  return { id, wt: ref.worktree, branch: ref.branch, tool };
}

describe('任务范围', () => {
  it('逗号分隔多个 module、. 表示整个仓库、deps 允许锁文件', () => {
    const multi = parseScope(JSON.stringify({ module: 'apps/web, packages/domain' }));
    expect(inScope('apps/web/src/a.ts', multi)).toBe(true);
    expect(inScope('packages/domain/x.ts', multi)).toBe(true);
    expect(inScope('apps/webby/a.ts', multi)).toBe(false);
    expect(inScope('README.md', parseScope(JSON.stringify({ module: '.' })))).toBe(true);
    const deps = parseScope(JSON.stringify({ module: 'apps/web', kind: 'deps' }));
    expect(inScope('pnpm-lock.yaml', deps)).toBe(true);
    expect(inScope('apps/server/package.json', deps)).toBe(true);
    expect(inScope('apps/server/src/a.ts', deps)).toBe(false);
    expect(isDependencyChange(['pnpm', 'add', 'zod@4'])).toBe(true);
    expect(isDependencyChange(['pnpm', 'publish'])).toBe(false);
  });
});

describe('文件工具', () => {
  it('list_files 列目录，apply_patch 支持重命名和删除，提交后生效', async () => {
    const t = await codeTask();
    const listed = await t.tool('list_files');
    expect(listed.entries).toEqual(['index.txt']);
    expect((await t.tool('apply_patch', { creates: [{ path: 'src/board/a/b.txt', content: 'b\n' }] })).error).toBeUndefined();
    expect((await t.tool('list_files')).entries).toEqual(['a/', 'index.txt']);
    expect((await t.tool('list_files', { recursive: true })).files).toEqual(['src/board/a/b.txt', 'src/board/index.txt']);

    expect((await t.tool('apply_patch', { renames: [{ from: 'src/board/index.txt', to: 'outside.txt' }] })).error).toContain('Module');
    expect((await t.tool('apply_patch', { renames: [{ from: 'src/board/nope.txt', to: 'src/board/x.txt' }] })).error).toContain('不存在');
    const r = await t.tool('apply_patch', {
      edits: [{ path: 'src/board/index.txt', oldText: 'placeholder', newText: 'main' }],
      renames: [{ from: 'src/board/index.txt', to: 'src/board/main.txt' }],
      deletes: ['src/board/a'],
    });
    expect(r).toMatchObject({ edited: 1, renamed: 1, deleted: 1 });
    expect((await t.tool('list_files')).entries).toEqual(['main.txt']);
    expect((await t.tool('git_commit', { message: 'rename' })).sha).toBeTruthy();
    expect(g(t.wt, ['ls-files', 'src/board'])).toBe('src/board/main.txt');
    expect(lf(readFileSync(path.join(t.wt, 'src/board/main.txt'), 'utf8'))).toBe('board main\n');
  });

  it('跨 Module 与脚手架范围', async () => {
    const t = await codeTask({ kind: 'scaffold', priority: 'p1', module: '.' });
    expect((await t.tool('apply_patch', { creates: [{ path: 'apps/new/index.ts', content: 'export {};\n' }, { path: 'README.md', content: '# x\n' }] })).error).toBeUndefined();
    expect((await t.tool('git_commit', { message: 'scaffold' })).sha).toBeTruthy();
    const r = await codeTask({ kind: 'refactor', priority: 'p1', module: 'src/board,docs' });
    expect((await r.tool('apply_patch', { creates: [{ path: 'docs/a.md', content: 'a\n' }] })).error).toBeUndefined();
    expect((await r.tool('apply_patch', { creates: [{ path: 'lib/a.md', content: 'a\n' }] })).error).toContain('Module');
  });
});

describe('冲突与同步', () => {
  it('sync_branch 留下冲突标记，未解决不能提交，解决后完成合并且 base 前移', async () => {
    const t = await codeTask();
    await t.tool('apply_patch', { edits: [{ path: 'src/board/index.txt', oldText: 'board placeholder', newText: 'from task' }] });
    await t.tool('git_commit', { message: 'task change' });
    const integ = await ensureIntegration(settings(), devId);
    writeFileSync(path.join(integ, 'src/board/index.txt'), 'from develop\n');
    g(integ, ['commit', '-am', 'develop change']);
    const developHead = g(integ, ['rev-parse', 'HEAD']);

    const synced = await t.tool('sync_branch');
    expect(synced).toMatchObject({ status: 'conflicts', files: ['src/board/index.txt'] });
    expect(JSON.parse((await reload(t.id)).codeRefJson!).base_sha).toBe(developHead);
    expect((await t.tool('sync_branch')).error).toContain('合并中');
    expect((await t.tool('git_commit', { message: 'resolve' })).error).toContain('冲突标记');

    await t.tool('apply_patch', { creates: [{ path: 'src/board/index.txt', content: 'from develop and task\n' }] });
    expect((await t.tool('git_commit', { message: 'resolve' })).sha).toBeTruthy();
    expect(g(t.wt, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3);
    expect((await t.tool('sync_branch')).status).toBe('up_to_date');
    const diff = (await t.tool('git_diff')).diff as string;
    expect(diff).toContain('+from develop and task');
    expect(diff).not.toContain('develop change');
  });

  it('提交提案后分支又被改：合并拒绝并取代提案', async () => {
    const t = await codeTask();
    await t.tool('apply_patch', { edits: [{ path: 'src/board/index.txt', oldText: 'placeholder', newText: 'v1' }] });
    await t.tool('git_commit', { message: 'v1' });
    const sub = await submitChange({ db, actor: HUMAN, task: await reload(t.id) }, 'v1');
    expect('proposalId' in sub).toBe(true);
    const pid = (sub as { proposalId: string }).proposalId;
    writeFileSync(path.join(t.wt, 'src/board/index.txt'), 'sneaky\n');
    g(t.wt, ['commit', '-am', 'manual']);
    await db.update(proposal).set({ status: 'approved' }).where(eq(proposal.id, pid));
    enqueueMerge(db, HUMAN, t.id);
    for (let i = 0; i < 50 && (await db.select().from(proposal).where(eq(proposal.id, pid)))[0]!.status === 'approved'; i++) await new Promise((r) => setTimeout(r, 100));
    expect((await db.select().from(proposal).where(eq(proposal.id, pid)))[0]!.status).toBe('superseded');
    expect(g(await ensureIntegration(settings(), devId), ['show', 'HEAD:src/board/index.txt'])).toBe('board placeholder');
  });
});

describe('回滚', () => {
  it('回滚合并提交，提案标为已回滚，不能回滚两次', async () => {
    const t = await codeTask();
    await t.tool('apply_patch', { edits: [{ path: 'src/board/index.txt', oldText: 'placeholder', newText: 'merged' }] });
    await t.tool('git_commit', { message: 'change' });
    const integ = await ensureIntegration(settings(), devId);
    g(integ, ['merge', '--no-ff', '-m', 'merge', t.branch]);
    const mergeSha = g(integ, ['rev-parse', 'HEAD']);
    const ref = JSON.parse((await reload(t.id)).codeRefJson!) as Record<string, unknown>;
    await db.update(task).set({ status: 'done', codeRefJson: JSON.stringify({ ...ref, merge_sha: mergeSha }) }).where(eq(task.id, t.id));
    const pid = crypto.randomUUID();
    await db.insert(proposal).values({ id: pid, taskId: t.id, workstationId: devId, targetType: 'code', baseVersion: 0, patchJson: '', authorType: 'agent', authorId: 'a', status: 'merged', createdAt: new Date().toISOString() });

    const res = await post(`/api/tasks/${t.id}/revert`, { reason: '线上回归' });
    expect(res.status).toBe(200);
    expect(lf(readFileSync(path.join(integ, 'src/board/index.txt'), 'utf8'))).toBe('board placeholder\n');
    expect((await db.select().from(proposal).where(eq(proposal.id, pid)))[0]!.status).toBe('reverted');
    const again = await post(`/api/tasks/${t.id}/revert`, {});
    expect(again.status).toBe(409);
    const branch = (await (await app.request(`/api/tasks/${t.id}/branch`)).json()) as { branch: { revertSha: string } };
    expect(branch.branch.revertSha).toBeTruthy();
  });
});

describe('阶段门禁', () => {
  it('Agent 推进卡在人工检查项 → 收件箱确认后推进', async () => {
    pluginRegistry.get('dev')!.stages!.find((x) => x.id === 'design')!.requirements = [{ kind: 'manual', text: '人工确认项' }];
    const t = await codeTask(undefined, 'design');
    const detail = (await (await app.request(`/api/tasks/${t.id}`)).json()) as { flow: { gates: { kind: string; met: boolean }[] } };
    expect(detail.flow.gates).toEqual([expect.objectContaining({ kind: 'manual', met: false })]);
    const architect = (await db.select().from(agent).where(and(eq(agent.workstationId, devId), eq(agent.isSteward, 1))))[0]!;
    const actor = { type: 'agent' as const, id: architect.id };
    const ctx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: architect, task: await reload(t.id), run: { id: 'r' } } as unknown as ToolCtx;
    const r = (await executeTool(ctx, 'advance_stage', { stage: 'implement' })) as { error?: string };
    expect(r.error).toContain('未满足阶段门禁');
    expect((await reload(t.id)).stage).toBe('design');
    const item = (await db.select().from(inboxItem).where(and(eq(inboxItem.kind, 'gate_confirm'), eq(inboxItem.refId, t.id))))[0]!;
    await executeTool(ctx, 'advance_stage', { stage: 'implement' });
    expect(await db.select().from(inboxItem).where(and(eq(inboxItem.kind, 'gate_confirm'), eq(inboxItem.refId, t.id)))).toHaveLength(1);
    expect((await post(`/api/inbox/${item.id}/resolve`, { decision: 'approve' })).status).toBe(200);
    expect((await reload(t.id)).stage).toBe('implement');
  });

  it('人推进时验收门禁要满足或显式越过，回退不检查', async () => {
    const t = await codeTask(undefined, 'test');
    const blocked = await post(`/api/tasks/${t.id}/stage`, { stage: 'review' });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toContain('验收');
    expect((await post(`/api/tasks/${t.id}/stage`, { stage: 'implement' })).status).toBe(200);
    expect((await post(`/api/tasks/${t.id}/stage`, { stage: 'test' })).status).toBe(200);
    await db.update(task).set({ resultJson: JSON.stringify({ acceptance: { passed: true } }) }).where(eq(task.id, t.id));
    expect((await post(`/api/tasks/${t.id}/stage`, { stage: 'review' })).status).toBe(200);
  });
});

describe('仓库初始化', () => {
  it('空目录 init 并建初始提交；路径不存在或非空非仓库都报错', async () => {
    const base = path.join(tmpdir(), `aw-empty-${Date.now()}`);
    mkdirSync(base);
    const s = devSettings(JSON.stringify({ repoPath: base, baseBranch: 'main', targetBranch: 'develop' }));
    expect(await ensureRepo(s)).toEqual({ ok: true, created: true });
    expect(g(base, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect((await ensureTargetBranch(s)).ok).toBe(true);
    expect((await ensureRepo({ ...s, repoPath: path.join(base, 'nope') })).ok).toBe(false);
    const junk = path.join(tmpdir(), `aw-junk-${Date.now()}`);
    mkdirSync(junk);
    writeFileSync(path.join(junk, 'a.txt'), 'x');
    expect(await ensureRepo({ ...s, repoPath: junk })).toMatchObject({ ok: false });
    expect(existsSync(path.join(junk, '.git'))).toBe(false);
  });
});

describe('漂移检测', () => {
  it('目标分支外部提交被发现；基线领先可一键合进目标分支', async () => {
    await checkRepos(db);
    acknowledgeDrift(devId);
    const integ = await ensureIntegration(settings(), devId);
    writeFileSync(path.join(integ, 'manual.txt'), 'm\n');
    g(integ, ['add', '-A']);
    g(integ, ['commit', '-m', 'manual on develop']);
    g(repo, ['commit', '--allow-empty', '-m', 'hotfix on main']);
    await checkRepos(db);
    const d = repoDrift(devId)!;
    expect(d.external?.commits[0]).toContain('manual on develop');
    expect(d.baseAhead).toBe(1);
    const status = (await (await app.request(`/api/workstations/${devId}/repo`)).json()) as { drift: { baseAhead: number } };
    expect(status.drift.baseAhead).toBe(1);

    expect((await post(`/api/workstations/${devId}/repo/sync-base`)).status).toBe(200);
    expect(repoDrift(devId)!.baseAhead).toBe(0);
    expect(repoDrift(devId)!.external).toBeNull();
    expect(g(integ, ['log', '--format=%s', '-n', '3'])).toContain('hotfix on main');
  });
});

describe('开发台补全', () => {
  const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('waitFor 超时');
  };
  const addEntity = (entityType: string, data: Record<string, unknown>) =>
    db.insert(entity).values({ id: crypto.randomUUID(), workstationId: devId, entityType, version: 1, dataJson: JSON.stringify(data), createdByType: 'human', createdById: 'local', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

  it('范围没声明或解析不了时拒绝写入，读仍可用', async () => {
    for (const json of ['{}', '{"module":""}', '{"module":" , "}', 'not json', '{"module":"../x"}']) {
      const s = parseScope(json);
      expect(s.invalid).toBe(true);
      expect(inScope('README.md', s)).toBe(false);
    }
    expect(inScope('package.json', parseScope('{"kind":"deps"}'))).toBe(false);
    const bad = await post(`/api/workstations/${devId}/tasks`, { title: 'X', input: { kind: 'feature', priority: 'p1', module: '  ' } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('module');
    const t = await codeTask();
    await db.update(task).set({ inputJson: '{"module":""}' }).where(eq(task.id, t.id));
    expect((await t.tool('apply_patch', { creates: [{ path: 'a.txt', content: 'a' }] })).error).toContain('没有声明');
    expect((await t.tool('search_code', { query: 'board placeholder' })).matches).toHaveLength(1);
  });

  it('环境错误只认平台 / shell 层的信号，构建自己的 not found 算失败', () => {
    const r = (exitCode: number, output: string) => ({ exitCode, output, durationMs: 0, truncated: false, timedOut: false });
    expect(isEnvError(r(1, "'pnpm' is not recognized as an internal or external command,\r\noperable program or batch file."))).toBe(true);
    expect(isEnvError(r(127, ''))).toBe(true);
    expect(isEnvError(r(-1, '命令 foo 不在白名单'))).toBe(true);
    expect(isEnvError(r(1, "Error: Module not found: Can't resolve './x'"))).toBe(false);
    expect(isEnvError({ ...r(-1, ''), timedOut: true })).toBe(false);
  });

  it('验收环境出错：转 blocked 进收件箱，不计退回次数', async () => {
    const t = await codeTask();
    await db.update(task).set({ status: 'submitted', stage: 'test', acceptanceJson: JSON.stringify([{ kind: 'command', run: 'no-such-tool --version' }]) }).where(eq(task.id, t.id));
    await afterTestRun(db, t.id);
    const row = await reload(t.id);
    expect(row.status).toBe('blocked');
    expect(row.stage).toBe('implement');
    expect(row.feedbackCount).toBe(0);
    expect(row.blockedReason).toContain('环境');
    const items = await db.select().from(inboxItem).where(and(eq(inboxItem.kind, 'blocked'), eq(inboxItem.refId, t.id)));
    expect(items).toHaveLength(1);
  });

  it('重启恢复：排队中的合并重新入队并完成，半截合并先清掉', async () => {
    const t = await codeTask();
    expect((await t.tool('apply_patch', { creates: [{ path: 'src/board/r.txt', content: 'r\n' }] })).error).toBeUndefined();
    expect((await t.tool('git_commit', { message: 'r' })).sha).toBeTruthy();
    const cur = await reload(t.id);
    const submitted = await submitChange({ db, actor: HUMAN, task: cur }, 'r');
    expect('proposalId' in submitted).toBe(true);
    await db.update(proposal).set({ status: 'approved' }).where(eq(proposal.taskId, t.id));
    await db.update(task).set({ status: 'reviewing', stage: 'merge', acceptanceJson: '[]', resultJson: JSON.stringify({ mergeQueued: 'x' }) }).where(eq(task.id, t.id));
    const integ = await ensureIntegration(settings(), devId);
    g(integ, ['merge', '--no-ff', '--no-commit', t.branch]);
    expect(await recoverMergeQueue(db)).toEqual([t.id]);
    await waitFor(async () => (await reload(t.id)).status === 'done' && JSON.parse((await reload(t.id)).resultJson ?? '{}').mergeQueued === undefined);
    expect(lf(g(repo, ['show', 'develop:src/board/r.txt'])).trim()).toBe('r');
  });

  it('重启恢复：没有排队标记或提案未通过的不入队，残留标记被清掉', async () => {
    const a = await codeTask();
    expect(await recoverMergeQueue(db)).toEqual([]);
    await db.update(task).set({ resultJson: JSON.stringify({ mergeQueued: 'x' }) }).where(eq(task.id, a.id));
    expect(await recoverMergeQueue(db)).toEqual([]);
    expect(JSON.parse((await reload(a.id)).resultJson ?? '{}').mergeQueued).toBeUndefined();
  });

  it('withServer：等到服务可访问才执行，结束后停掉；提前退出算失败', async () => {
    const ports = portEnv('abcd0001');
    writeFileSync(path.join(repo, 'serve.js'), "require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT));\n");
    const url = `http://127.0.0.1:${ports.AW_E2E_WEB_PORT}/`;
    const up = await withServer({ cwd: repo, command: 'node serve.js', env: ports, probeUrl: url }, async () => (await fetch(url)).status);
    expect(up).toEqual({ ok: true, value: 200 });
    await waitFor(async () => { try { await fetch(url, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } });
    writeFileSync(path.join(repo, 'crash.js'), "console.error('boom'); process.exit(3);\n");
    const crashed = await withServer({ cwd: repo, command: 'node crash.js', env: ports, probeUrl: url }, async () => 1);
    expect(crashed.ok).toBe(false);
    expect(crashed.ok === false && crashed.error).toContain('boom');
  }, 30000);

  it.skipIf(!hasBrowser)('visual 验收：平台起 worktree 的服务，{port} 换成分到的端口，worktree 不留脏文件', async () => {
    const t = await codeTask();
    const ports = portEnv(path.basename(t.wt));
    const page = (color: string) => `require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<body style="margin:0;background:${color}"></body>')}).listen(Number(process.env.PORT));\n`;
    writeFileSync(path.join(t.wt, 'serve.js'), page('#fff'));
    const url = `http://127.0.0.1:${ports.AW_E2E_WEB_PORT}/`;
    await withServer({ cwd: t.wt, command: 'node serve.js', env: ports, probeUrl: url }, () => captureScreenshot(url, path.join(t.wt, 'shots/home.png')));
    g(t.wt, ['add', '-A']);
    g(t.wt, ['commit', '-m', 'baseline']);
    const checks = [{ kind: 'visual', url: 'http://127.0.0.1:{port}/', baseline: 'shots/home.png', maxDiff: 0.02 }];
    const same = await runAcceptance(db, devId, t.wt, checks, 60, t.id, { serve: 'node serve.js' });
    expect(same).toMatchObject({ allPassed: true, envError: false });
    expect(g(t.wt, ['status', '--porcelain'])).toBe('');
    writeFileSync(path.join(t.wt, 'serve.js'), page('#000'));
    const changed = await runAcceptance(db, devId, t.wt, checks, 60, t.id, { serve: 'node serve.js' });
    expect(changed).toMatchObject({ allPassed: false, envError: false });
    expect(changed.results[0]!.status).toBe('failed');
    const noServer = await runAcceptance(db, devId, t.wt, checks, 60, t.id, { serve: 'node missing-server.js' });
    expect(noServer).toMatchObject({ allPassed: false, envError: true });
  }, 120000);

  it.skipIf(!hasBrowser)('预览：和仓库里的基线做像素对比，基线缺失时给出原因', async () => {
    const ports = portEnv('abcd0002');
    const url = `http://127.0.0.1:${ports.AW_E2E_WEB_PORT}/`;
    writeFileSync(path.join(repo, 'serve.js'), "require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<body style=\"background:#fff\"></body>')}).listen(Number(process.env.PORT));\n");
    const integ = await ensureIntegration(settings(), devId);
    await withServer({ cwd: repo, command: 'node serve.js', env: ports, probeUrl: url }, async () => {
      await captureScreenshot(url, path.join(integ, 'shots/home.png'));
      g(integ, ['add', '-A']);
      g(integ, ['commit', '-m', 'baseline']);
      const same = (await (await post(`/api/workstations/${devId}/screenshot`, { url, baseline: 'shots/home.png' })).json()) as { compare: { ratio: number; baselineId: string; ref: string } };
      expect(same.compare.ratio).toBe(0);
      expect(same.compare.ref).toBe('develop');
      expect((await app.request(`/api/artifacts/${same.compare.baselineId}/image`)).headers.get('content-type')).toBe('image/png');
      const missing = (await (await post(`/api/workstations/${devId}/screenshot`, { url, baseline: 'shots/none.png' })).json()) as { compare: { error: string } };
      expect(missing.compare.error).toContain('基线不存在');
    });
    const shots = await db.select().from(artifact).where(eq(artifact.type, 'screenshot'));
    expect(shots.length).toBeGreaterThan(0);
    rmSync(path.dirname(shots[0]!.ref!), { recursive: true, force: true });
  }, 60000);

  it('沙箱配置：非法镜像被拒，可保存可清除；docker 不可用时验收算环境错误', async () => {
    const patchWs = (sandbox: unknown) => app.request(`/api/workstations/${devId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { sandbox } }) });
    const stored = async () => devSettings((await db.select().from(workstation).where(eq(workstation.id, devId)))[0]!.settingsJson).sandbox;
    expect((await patchWs({ image: '--privileged' })).status).toBe(400);
    expect((await patchWs({ image: 'node:22-slim' })).status).toBe(200);
    expect(await stored()).toEqual({ image: 'node:22-slim' });
    expect((await patchWs(null)).status).toBe(200);
    expect(await stored()).toBeUndefined();
    const t = await codeTask();
    process.env.AW_DOCKER_BIN = 'aw-no-such-docker';
    try {
      const r = await runAcceptance(db, devId, t.wt, [{ kind: 'command', run: 'node check.js' }], 30, t.id, { sandbox: { image: 'node:22-slim' } });
      expect(r).toMatchObject({ allPassed: false, envError: true });
      expect(r.results[0]!.output).toContain('容器沙箱');
    } finally {
      delete process.env.AW_DOCKER_BIN;
    }
  });

  it('新 Module 门禁：范围没登记要 ADR，已登记或没有登记表时放行', async () => {
    const gates = async (id: string) => ((await (await app.request(`/api/tasks/${id}`)).json()) as { flow: { gates: { kind: string; met: boolean; text: string }[] } }).flow.gates;
    const t = await codeTask(undefined, 'design');
    expect((await gates(t.id))[0]).toMatchObject({ kind: 'new_scope_decision', met: true });
    await addEntity('Module', { name: '其他', path: 'src/other', responsibility: '别的' });
    const fresh = (await gates(t.id))[0]!;
    expect(fresh.met).toBe(false);
    expect(fresh.text).toContain('src/board');
    const stuck = await post(`/api/tasks/${t.id}/stage`, { stage: 'implement' });
    expect(stuck.status).toBe(409);
    await addEntity('ADR', { title: '新增 board' });
    expect((await gates(t.id))[0]!.met).toBe(true);
    expect((await post(`/api/tasks/${t.id}/stage`, { stage: 'implement' })).status).toBe(200);
    await addEntity('Module', { name: '看板', path: 'src/board', responsibility: '看板视图' });
    const covered = await codeTask({ kind: 'feature', priority: 'p1', module: 'src/board/sub' }, 'design');
    expect((await gates(covered.id))[0]!.met).toBe(true);
  });

  it('Module 职责进入运行上下文', async () => {
    await addEntity('Module', { name: '看板', path: 'src/board', responsibility: '看板视图', owner: '前端' });
    await addEntity('Module', { name: '无关', path: 'src/zzz', responsibility: '不相干' });
    const t = await codeTask();
    const row = await reload(t.id);
    const a = (await db.select().from(agent).where(eq(agent.id, row.assigneeId!)))[0]!;
    const ws = (await db.select().from(workstation).where(eq(workstation.id, devId)))[0]!;
    const c = await buildRunContext(db, a, row, manifestOf(ws));
    expect(c.messages[0]!.content).toContain('看板（src/board）：看板视图');
    expect(c.messages[0]!.content).not.toContain('不相干');
  });

  it('文件树可切到任务分支，分支之外的引用不接受', async () => {
    const t = await codeTask();
    await t.tool('apply_patch', { creates: [{ path: 'src/board/new.txt', content: 'n\n' }] });
    await t.tool('git_commit', { message: 'n' });
    const refs = (await (await app.request(`/api/workstations/${devId}/branches`)).json()) as { branches: { branch: string }[] };
    expect(refs.branches.map((b) => b.branch)).toContain(t.branch);
    const onBranch = (await (await app.request(`/api/workstations/${devId}/files?path=src/board&branch=${encodeURIComponent(t.branch)}`)).json()) as { entries: { name: string }[] };
    expect(onBranch.entries.map((e) => e.name)).toContain('new.txt');
    const onTarget = (await (await app.request(`/api/workstations/${devId}/files?path=src/board`)).json()) as { entries: { name: string }[] };
    expect(onTarget.entries.map((e) => e.name)).not.toContain('new.txt');
    expect(((await (await app.request(`/api/workstations/${devId}/file?path=src/board/new.txt&branch=${encodeURIComponent(t.branch)}`)).json()) as { content: string }).content.trim()).toBe('n');
    const denied = (await (await app.request(`/api/workstations/${devId}/files?branch=main`)).json()) as { entries: unknown[]; error: string };
    expect(denied.entries).toEqual([]);
    expect(denied.error).toBeTruthy();
  });

  it('命令确认：处理收件箱后立即唤醒', async () => {
    const t = await codeTask();
    const pending = t.tool('run_command', { command: 'git clean -n' });
    let id = '';
    await waitFor(async () => {
      const open = (await db.select().from(inboxItem).where(and(eq(inboxItem.kind, 'command_confirm'), eq(inboxItem.refId, t.id), eq(inboxItem.status, 'open'))))[0];
      id = open?.id ?? '';
      return !!id;
    });
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    expect((await post(`/api/inbox/${id}/resolve`, { decision: 'deny' })).status).toBe(200);
    expect((await pending).error).toContain('拒绝');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
