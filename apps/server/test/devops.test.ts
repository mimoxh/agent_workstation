import { and, eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { agent, inboxItem, proposal, task, workstation } from '../src/db/schema.js';
import { seed } from '../src/db/seed.js';
import { loadPlugins } from '../src/plugins.js';
import { enqueueMerge, submitChange } from '../src/runtime/dev_workflow.js';
import { isDependencyChange } from '../src/runtime/exec.js';
import { createTaskWorktree, devSettings, ensureIntegration, ensureRepo, ensureTargetBranch } from '../src/runtime/git.js';
import { acknowledgeDrift, checkRepos, repoDrift } from '../src/runtime/repo_watch.js';
import { inScope, parseScope } from '../src/runtime/scope.js';
import { executeTool, type ToolCtx } from '../src/runtime/tools/index.js';
import { buildPermCtx, createTaskUc } from '../src/usecases/index.js';
import { createFixtureRepo } from './fixtures.js';

const HUMAN = { type: 'human', id: 'local' } as const;
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
