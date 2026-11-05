import { beforeEach, describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { loadPlugins } from '../src/plugins.js';
import { loadModels, sanitizeError } from '../src/runtime/models.js';
import { runAgent } from '../src/runtime/loop.js';
import { executeTool, type ToolCtx } from '../src/runtime/tools/index.js';
import { decideProposal } from '../src/usecases/proposals.js';
import { buildPermCtx, createTaskUc } from '../src/usecases/index.js';
const HUMAN = { type: 'human', id: 'local' } as const;
import { buildContext } from '../src/runtime/context.js';
import { scheduler } from '../src/runtime/scheduler.js';
import { agent, entity, inboxItem, run, task, workstation, entityVersion } from '../src/db/schema.js';
import { and, eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let ctx: ToolCtx;

const post = (url: string, body: unknown) =>
  app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function mockModel(seq: { calls?: [string, unknown][]; text?: string }[]) {
  let i = 0;
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'test',
    doGenerate: async () => {
      const step = seq[Math.min(i++, seq.length - 1)]!;
      if (step.calls) {
        return {
          content: step.calls.map(([n, a], j) => ({ type: 'tool-call', toolCallId: `c${i}_${j}`, toolName: n, input: JSON.stringify(a) })),
          finishReason: 'tool-calls' as never,
          usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } } as never,
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text', text: step.text ?? 'done' }],
        finishReason: 'stop' as never,
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } } as never,
        warnings: [],
      };
    },
  });
}

async function setupRun(model: MockLanguageModelV4, taskTitle = 'T') {
  const dev = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!;
  const a = (await db.select().from(agent).where(and(eq(agent.workstationId, dev.id), eq(agent.isSteward, 1))))[0]!;
  const taskId = crypto.randomUUID();
  await db.insert(task).values({
    id: taskId, projectId: 'proj-aw', workstationId: dev.id, typeId: 'dev.issue',
    title: taskTitle, inputJson: '{}', status: 'dispatched', assigneeType: 'workstation', assigneeId: dev.id, createdAt: new Date().toISOString(),
  });
  const taskRow = (await db.select().from(task).where(eq(task.id, taskId)))[0]!;
  const runId = crypto.randomUUID();
  await db.insert(run).values({ id: runId, agentId: a.id, taskId, status: 'running', provider: 'mock', model: 'test', startedAt: new Date().toISOString(), tokensIn: 0, tokensOut: 0, traceJson: '[]' });
  const runRow = (await db.select().from(run).where(eq(run.id, runId)))[0]!;
  const actor = { type: 'agent' as const, id: a.id };
  ctx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: taskRow, run: runRow };
  return { runId, route: { id: 'mock:test', model: model as never, supportsParallelTools: true }, agentRow: a, taskRow };
}

const runOpts = (s: Awaited<ReturnType<typeof setupRun>>, extra: Record<string, unknown> = {}) => ({
  db, ctx, route: s.route, system: 's', messages: [{ role: 'user' as const, content: 'hi' }], agentRow: s.agentRow, taskRow: s.taskRow, ...extra,
});

beforeEach(async () => {
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  migrateDb(r.sqlite);
  await seed(db);
  app = createApp(db).app;
});

describe('loop 熔断', () => {
  it('completed：无工具调用即完成', async () => {
    const s = await setupRun(mockModel([{ text: '总结' }]));
    const r = await runAgent(runOpts(s));
    expect(r.stopReason).toBe('completed');
  });

  it('no_progress：连续两轮相同工具+参数', async () => {
    const s = await setupRun(mockModel([{ calls: [['send_message', { content: 'x' }]] }, { calls: [['send_message', { content: 'x' }]] }]));
    const r = await runAgent(runOpts(s));
    expect(r.stopReason).toBe('no_progress');
    const inbox = await db.select().from(inboxItem).where(eq(inboxItem.kind, 'run_failed'));
    expect(inbox.length).toBeGreaterThan(0);
  });

  it('budget: token over limit', async () => {
    const s = await setupRun(mockModel([{ calls: [['send_message', { content: 'x' }]] }, { text: 'y' }]));
    const r = await runAgent(runOpts(s, { agentRow: { ...s.agentRow, budgetJson: '{"tokens":10}' } }));
    expect(r.stopReason).toBe('budget');
  });

  it('timeout：极小预算分钟数', async () => {
    const m = new MockLanguageModelV4({
      provider: 'x',
      modelId: 'e',
      doGenerate: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return {
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'send_message', input: '{"content":"x"}' }],
          finishReason: 'tool-calls' as never,
          usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } } as never,
          warnings: [],
        };
      },
    });
    const s = await setupRun(m);
    const r = await runAgent(runOpts(s, { agentRow: { ...s.agentRow, budgetJson: '{"minutes":0.0001}' } }));
    expect(r.stopReason).toBe('timeout');
  });

  it('error：provider 抛错且 key 被脱敏', async () => {
    process.env.AW_ANTHROPIC_API_KEY = 'sk-secret-12345';
    const m = new MockLanguageModelV4({ provider: 'x', modelId: 'e', doGenerate: async () => { throw new Error('bad key sk-secret-12345'); } });
    const s = await setupRun(m);
    const r = await runAgent(runOpts(s));
    expect(r.stopReason).toBe('error');
    const row = (await db.select().from(run).where(eq(run.id, s.runId)))[0]!;
    expect(row.error).toContain('***');
    expect(row.error).not.toContain('sk-secret-12345');
    delete process.env.AW_ANTHROPIC_API_KEY;
  });

  it('max_turns：轮次耗尽', async () => {
    const s = await setupRun(mockModel(
      Array.from({ length: 9 }, (_, i) => ({ calls: [['send_message', { content: `m${i}` }]] as [string, unknown][] })),
    ));
    const r = await runAgent(runOpts(s));
    expect(r.stopReason).toBe('max_turns');
  });

  it('sanitizeError 兜底', () => {
    process.env.AW_OPENAI_COMPAT_API_KEY = 'token-abc';
    expect(sanitizeError('auth failed token-abc')).toBe('auth failed ***');
    delete process.env.AW_OPENAI_COMPAT_API_KEY;
  });
});

describe('工具权限与提案', () => {
  const makeTask = async (devId: string) => {
    const id = crypto.randomUUID();
    await db.insert(task).values({ id, projectId: 'proj-aw', workstationId: devId, typeId: 'dev.issue', title: 'T', status: 'dispatched', assigneeType: 'workstation', assigneeId: devId, createdAt: new Date().toISOString() });
    return (await db.select().from(task).where(eq(task.id, id)))[0]!;
  };

  it('非 steward 调 respond_task 被拒', async () => {
    const dev = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!;
    const nonSteward = (await db.select().from(agent).where(and(eq(agent.workstationId, dev.id), eq(agent.isSteward, 0))))[0]!;
    const t = await makeTask(dev.id);
    const actor = { type: 'agent' as const, id: nonSteward.id };
    const tc: ToolCtx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: nonSteward, task: t, run: {} as never };
    const r = await executeTool(tc, 'respond_task', { action: 'accept' });
    expect((r as { error: string }).error).toContain('steward');
  });

  it('propose → approve → entity_version；重复 approve 409', async () => {
    const dev = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!;
    const steward = (await db.select().from(agent).where(and(eq(agent.workstationId, dev.id), eq(agent.isSteward, 1))))[0]!;
    const t = await makeTask(dev.id);
    const actor = { type: 'agent' as const, id: steward.id };
    const tc: ToolCtx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: steward, task: t, run: {} as never };
    const pr = await executeTool(tc, 'propose_entity', { entityType: 'Module', data: { name: 'web', path: 'apps/web/', responsibility: 'r' }, reason: 'x' }) as { proposalId: string };
    expect(pr.proposalId).toBeTruthy();
    const human = { type: 'human' as const, id: 'local' };
    expect((await decideProposal(human, db, pr.proposalId, 'approve')).kind).toBe('ok');
    expect((await db.select().from(entityVersion)).length).toBe(1);
    expect((await decideProposal(human, db, pr.proposalId, 'approve')).kind).toBe('invalid');
  });
});

describe('脚本化链路', () => {
  it('dispatch → architect run → 子任务创建并指派', async () => {
    process.env.AW_ENABLE_MOCK = '1';
    process.env.AW_DEFAULT_MODEL = 'mock:scripted';
    await loadModels();
    const { startScheduler } = await import('../src/runtime/scheduler.js');
    startScheduler(db);
    const dev = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!;
    const root = (await db.select().from(workstation).where(eq(workstation.pluginId, 'pm')))[0]!;
    const t = (await (await post(`/api/workstations/${root.id}/tasks`, { title: '链路任务', input: { module: 'm' } })).json()) as { id: string };
    await post(`/api/tasks/${t.id}/dispatch`, { targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title: 'x', kind: 'feature', priority: 'p1', module: 'm' } });
    await scheduler.idle();
    await new Promise((r) => setTimeout(r, 300));
    await scheduler.idle();
    const runs = await db.select().from(run);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    const children = await db.select().from(task).where(eq(task.parentId, t.id));
    expect(children.length).toBeGreaterThanOrEqual(1);
    expect(children[0]!.assigneeType).toBe('agent');
    const parent = (await db.select().from(task).where(eq(task.id, t.id)))[0]!;
    expect(parent.status).toBe('in_progress');
    expect(children[0]!.status).toBe('in_progress');
    expect(children[0]!.stage).toBe('implement');
    const archRun = runs.find((r) => r.taskId === t.id)!;
    expect(archRun.tokensIn).toBe(500);
    expect(archRun.tokensOut).toBe(250);
    expect(archRun.trigger).toBe('task_assigned');
  });

  it('启动恢复：running 标 interrupted + inbox', async () => {
    const dev = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!;
    const a = (await db.select().from(agent).where(eq(agent.workstationId, dev.id)))[0]!;
    const t = (await db.select().from(task).limit(1))[0];
    await db.insert(run).values({ id: 'stale', agentId: a.id, taskId: t?.id ?? null, status: 'running', provider: 'mock', model: 'x', startedAt: new Date().toISOString(), tokensIn: 0, tokensOut: 0, traceJson: '[]' });
    const stale = await db.select().from(run).where(eq(run.status, 'running'));
    for (const r of stale) {
      await db.update(run).set({ status: 'interrupted', stopReason: 'interrupted', endedAt: new Date().toISOString() }).where(eq(run.id, r.id));
      await db.insert(inboxItem).values({ id: crypto.randomUUID(), workspaceId: 'default', projectId: null, kind: 'run_failed', refType: 'run', refId: r.id, status: 'open', createdAt: new Date().toISOString() });
    }
    const row = (await db.select().from(run).where(eq(run.id, 'stale')))[0]!;
    expect(row.status).toBe('interrupted');
    expect((await db.select().from(inboxItem).where(eq(inboxItem.refId, 'stale'))).length).toBe(1);
  });
});

describe('context 截断', () => {
  it('超长内容按预算截断', () => {
    const { system, messages } = buildContext({
      pluginDescription: 'd', agentName: 'a', agentRole: 'r', isSteward: false, stage: null, templateId: 'x',
      agents: [], task: { title: 't', intent: null, inputJson: 'x'.repeat(100000), acceptanceJson: null, typeId: null },
      parentTask: null, siblingTasks: [], threadMessages: [], budgetTokens: 1000,
    });
    expect(system.length + messages[0]!.content.length).toBeLessThan(100000);
    expect(messages[0]!.content).toContain('[truncated]');
  });
});

describe('受控执行器', () => {
  it('白名单/元字符拒绝/输出截断/env 剥离', async () => {
    const { runCommand, splitCommand, isDangerous } = await import('../src/runtime/exec.js');
    expect(splitCommand('a | b')).toBeNull();
    expect(splitCommand('node check.js')).toEqual(['node', 'check.js']);
    expect(splitCommand('node "a b".js')).toEqual(['node', 'a b.js']);
    expect(isDangerous(['npx', 'tsx'])).toBe(true);
    expect(isDangerous(['git', 'push'])).toBe(true);
    expect(isDangerous(['pnpm', 'install', 'foo'])).toBe(true);
    expect(isDangerous(['pnpm', 'install'])).toBe(false);
    expect(isDangerous(['node', '-e', 'x'])).toBe(true);
    const bad = await runCommand({ cwd: process.cwd(), command: 'echo hi | more', timeoutSec: 5 });
    expect(bad.output).toContain('不支持');
    const nw = await runCommand({ cwd: process.cwd(), command: 'rm -rf /', timeoutSec: 5 });
    expect(nw.output).toContain('白名单');
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'aw-exec-'));
    writeFileSync(join(dir, 'env.js'), 'console.log(process.env.AW_ANTHROPIC_API_KEY ?? "absent")');
    writeFileSync(join(dir, 'big.js'), 'console.log("x".repeat(40000))');
    writeFileSync(join(dir, 'sleep.js'), 'setTimeout(() => {}, 30000)');
    process.env.AW_ANTHROPIC_API_KEY = 'sk-test-should-strip';
    const envOut = await runCommand({ cwd: dir, command: 'node env.js', timeoutSec: 5 });
    delete process.env.AW_ANTHROPIC_API_KEY;
    expect(envOut.output).toContain('absent');
    // pnpm/npm 注入变量同样被剥离（否则子进程 pnpm 会读到 npm_config_filter 之类导致假阳性）
    writeFileSync(join(dir, 'envp.js'), 'console.log(Object.keys(process.env).filter(k=>/npm_|pnpm|INIT|GIT_CONFIG/i.test(k)).join(",") || "CLEAN")');
    process.env.npm_config_filter = '@aw/server';
    process.env.PNPM_SCRIPT_SRC_DIR = 'x';
    process.env.INIT_CWD = 'x';
    process.env.GIT_CONFIG_COUNT = '1';
    const envp = await runCommand({ cwd: dir, command: 'node envp.js', timeoutSec: 5 });
    delete process.env.npm_config_filter;
    delete process.env.PNPM_SCRIPT_SRC_DIR;
    delete process.env.INIT_CWD;
    delete process.env.GIT_CONFIG_COUNT;
    expect(envp.output).toContain('CLEAN');
    const big = await runCommand({ cwd: dir, command: 'node big.js', timeoutSec: 10 });
    expect(big.truncated).toBe(true);
    const to = await runCommand({ cwd: dir, command: 'node sleep.js', timeoutSec: 1 });
    expect(to.timedOut).toBe(true);
  });
});

describe('dev 工具', () => {
  let repo: string, devId: string, wt: string, t: { id: string; codeRefJson: string | null; inputJson: string | null; projectId: string | null; workstationId: string | null }, ctx: { db: typeof db; actor: { type: 'agent'; id: string }; agent: { id: string; name: string; workstationId: string }; task: typeof t; run: { id: string } };
  it('fixture 仓库 + worktree', async () => {
    const { createFixtureRepo } = await import('./fixtures.js');
    const { createTaskWorktree, devSettings } = await import('../src/runtime/git.js');
    repo = createFixtureRepo();
    devId = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!.id;
    const s = { ...devSettings('{}'), repoPath: repo, targetBranch: 'main', commands: {} };
    const taskRow = await createTaskUc(HUMAN, db, devId, { title: 'dev工具测试', typeId: 'dev.issue', input: { title: 'dev工具测试', kind: 'feature', priority: 'p1', module: 'src/board' } });
    const ref = await createTaskWorktree(s, devId, taskRow.task!.id);
    await db.update(task).set({ codeRefJson: JSON.stringify(ref) }).where(eq(task.id, taskRow.task!.id));
    wt = ref.worktree;
    t = (await db.select().from(task).where(eq(task.id, taskRow.task!.id)))[0]! as typeof t;
    const a = (await db.select().from(agent).where(and(eq(agent.workstationId, devId), eq(agent.templateId, 'frontend-dev'))))[0]!;
    ctx = { db, actor: { type: 'agent', id: a.id }, agent: { id: a.id, name: a.name, workstationId: devId }, task: t, run: { id: 'r1' } } as never;
    expect(wt).toBeTruthy();
  });
  it('路径逃逸被拒', async () => {
    const { devTools } = await import('../src/runtime/tools/dev.js');
    const r = await devTools.read_file!.execute(ctx as never, { path: '../evil.txt' });
    expect((r as { error?: string }).error).toBeTruthy();
    const r2 = await devTools.read_file!.execute(ctx as never, { path: '.git/config' });
    expect((r2 as { error?: string }).error).toBeTruthy();
  });
  it('越出 Module 被拒', async () => {
    const { devTools } = await import('../src/runtime/tools/dev.js');
    const r = await devTools.apply_patch!.execute(ctx as never, { creates: [{ path: 'outside.txt', content: 'x' }] });
    expect((r as { error?: string }).error).toContain('Module');
  });
  it('apply_patch 原子性 + oldText 计数', async () => {
    const { devTools } = await import('../src/runtime/tools/dev.js');
    const p = 'src/board/index.txt';
    const bad = await devTools.apply_patch!.execute(ctx as never, { edits: [{ path: p, oldText: 'x', newText: 'y' }] });
    expect((bad as { error?: string }).error).toContain('0 次');
    const multi = await devTools.apply_patch!.execute(ctx as never, { edits: [{ path: p, oldText: 'o', newText: 'x' }] });
    expect((multi as { error?: string }).error).toContain('次');
    const atomic = await devTools.apply_patch!.execute(ctx as never, { edits: [{ path: p, oldText: 'placeholder', newText: 'EDITED' }], creates: [{ path: '../bad.txt', content: 'x' }] });
    expect((atomic as { error?: string }).error).toBeTruthy();
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(wt + '/' + p, 'utf8')).not.toContain('EDITED');
  });
  it('无 code_ref 时工具直接报错且不写文件', async () => {
    const { devTools } = await import('../src/runtime/tools/dev.js');
    const cwdFiles = await import('node:fs').then((m) => m.readdirSync(process.cwd()));
    const bare = { db, actor: { type: 'agent', id: 'x' }, agent: { id: 'x', name: 'x', workstationId: devId }, task: { id: 't-no-code', codeRefJson: null, inputJson: '{}', projectId: null, workstationId: devId }, run: { id: 'r' } } as never;
    for (const [n, a] of [['read_file', { path: 'a.txt' }], ['apply_patch', { creates: [{ path: 'a.txt', content: 'x' }] }], ['run_command', { command: 'node check.js' }], ['git_commit', { message: 'x' }], ['submit_change', { summary: 'x' }]] as const) {
      const r = await devTools[n]!.execute(bare, a as never);
      expect((r as { error?: string }).error).toBeTruthy();
    }
    const cwdFiles2 = await import('node:fs').then((m) => m.readdirSync(process.cwd()));
    expect(cwdFiles2).toEqual(cwdFiles);
    expect((await import('node:fs')).existsSync('undefined')).toBe(false);
  });

  it('git_commit 拒绝 module 外 + submit_change 前置', async () => {
    const { devTools } = await import('../src/runtime/tools/dev.js');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    expect(wt).toBeTruthy();
    mkdirSync(wt + '/src/board', { recursive: true });
    writeFileSync(wt + '/src/board/new.txt', 'new\n');
    writeFileSync(wt + '/outside.txt', 'out\n');
    const c = await devTools.git_commit!.execute(ctx as never, { message: 'x' });
    expect((c as { error?: string }).error).toContain('Module');
    const noUncommit = await devTools.submit_change!.execute(ctx as never, { summary: 's' });
    expect((noUncommit as { error?: string }).error).toBeTruthy();
  });
});
describe('危险命令确认', () => {
  it('批准执行 / 拒绝返回错误', async () => {
    const { devTools } = await import('../src/runtime/tools/dev.js');
    const { createFixtureRepo } = await import('./fixtures.js');
    const { createTaskWorktree, devSettings } = await import('../src/runtime/git.js');
    const repo = createFixtureRepo();
    const devId = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!.id;
    const s = { ...devSettings('{}'), repoPath: repo, targetBranch: 'main', commands: {} };
    const tr = await createTaskUc(HUMAN, db, devId, { title: 'confirm测试', typeId: 'dev.issue', input: { title: 'confirm测试', kind: 'feature', priority: 'p1', module: 'src/board' } });
    const ref = await createTaskWorktree(s, devId, tr.task!.id);
    await db.update(task).set({ codeRefJson: JSON.stringify(ref) }).where(eq(task.id, tr.task!.id));
    const t2 = (await db.select().from(task).where(eq(task.id, tr.task!.id)))[0]!;
    const a = (await db.select().from(agent).where(and(eq(agent.workstationId, devId), eq(agent.templateId, 'frontend-dev'))))[0]!;
    const ctx = { db, actor: { type: 'agent', id: a.id }, agent: { id: a.id, name: a.name, workstationId: devId }, task: t2, run: { id: 'r' } } as never;
    // 批准路径
    const p1 = devTools.run_command!.execute(ctx, { command: 'git push --force origin main' });
    await new Promise((r) => setTimeout(r, 500));
    const items1 = (await db.select().from(inboxItem).where(eq(inboxItem.kind, 'command_confirm'))).slice(-1);
    await db.update(inboxItem).set({ status: 'resolved', resolutionJson: JSON.stringify({ decision: 'approve' }) }).where(eq(inboxItem.id, items1[0]!.id));
    const r1 = await p1;
    expect((r1 as { error?: string }).error).toBeUndefined();
    // 拒绝路径
    const p2 = devTools.run_command!.execute(ctx, { command: 'git clean -fd' });
    await new Promise((r) => setTimeout(r, 500));
    const items2 = (await db.select().from(inboxItem).where(eq(inboxItem.kind, 'command_confirm'))).slice(-1);
    await db.update(inboxItem).set({ status: 'resolved', resolutionJson: JSON.stringify({ decision: 'deny' }) }).where(eq(inboxItem.id, items2[0]!.id));
    const r2 = await p2;
    expect((r2 as { error?: string }).error).toContain('拒绝');
  }, 20000);
});

describe('合并队列与验收守卫', () => {
  it('approve 守卫：无验收记录 → 409', async () => {
    const tr = await createTaskUc(HUMAN, db, (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!.id, { title: 'guard测试', typeId: 'dev.issue', input: { title: 'g', kind: 'feature', priority: 'p1', module: 'src/board' }, acceptance: [{ kind: 'command', run: 'node check.js' }] });
    const { transitionTaskUc } = await import('../src/usecases/index.js');
    for (const ev of ['dispatch', 'start', 'submit', 'begin_review'] as const) await transitionTaskUc(HUMAN, db, tr.task!.id, ev);
    const r = await transitionTaskUc(HUMAN, db, tr.task!.id, 'approve');
    expect(r.status).toBe(409);
  });
});
describe('剧本 A 全链路（fixture 仓库）', () => {
  it('派发→2 子任务→实现→测试→审查(退一次)→合并→父任务 done', async () => {
    const { createFixtureRepo } = await import('./fixtures.js');
    const { existsSync } = await import('node:fs');
    (await import('../src/runtime/scheduler.js')).startScheduler(db);
    const repo = createFixtureRepo();
    const dev = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!;
    await db.update(workstation).set({ settingsJson: JSON.stringify({ repoPath: repo, targetBranch: 'develop', baseBranch: 'main', commands: {}, commandTimeoutSec: 30, setupTimeoutSec: 60, requireHumanFor: [] }) }).where(eq(workstation.id, dev.id));
    const pmId = (await db.select().from(workstation).where(eq(workstation.pluginId, 'pm')))[0]!.id;
    const t = (await (await post(`/api/workstations/${pmId}/tasks`, { title: '剧本A', intent: 'x' })).json()) as { id: string };
    await post(`/api/tasks/${t.id}/dispatch`, { targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title: '剧本A', kind: 'feature', priority: 'p1', module: 'src/board' }, acceptance: [{ kind: 'command', run: 'node check.js' }] });
    // mock 循环依赖事件：多次 idle 直到稳定
    for (let i = 0; i < 240; i++) { await new Promise((r) => setTimeout(r, 500)); await scheduler.idle(); const p2 = (await db.select().from(task).where(eq(task.id, t.id)))[0]; if (p2?.status === 'done') break; }
    const parent = (await db.select().from(task).where(eq(task.id, t.id)))[0]!;
    const children = await db.select().from(task).where(eq(task.parentId, t.id));
    const runs2 = await db.select().from(run);
    const el = await db.select().from((await import('../src/db/schema.js')).eventLog);
    const ib = await db.select().from(inboxItem);
    console.log('P3-DBG', JSON.stringify({ el: el.map((e) => e.action), ib: ib.map((i) => i.kind), pstage: parent.stage, pa: parent.assigneeType + '/' + parent.assigneeId }));
    const proposals2 = await (await import('../src/db/schema.js')).proposal;
    const props = await db.select().from(proposals2);
    const entities2 = await db.select().from(entity).where(and(eq(entity.workstationId, dev.id), eq(entity.entityType, 'TestRun')));
    let mergeLog = ''; try { mergeLog = execFileSync('git', ['-C', repo, 'log', 'develop', '--merges', '--format=%s'], { encoding: 'utf8' }); } catch { /* develop 未建 */ }
    const done2 = runs2.filter((r) => r.status === 'completed').map((r) => JSON.parse(r.traceJson ?? '[]').filter((x: { type: string }) => x.type === 'tool').map((x: { name: string; result: unknown; error?: string }) => x.name + ':' + (x.error ?? JSON.stringify(x.result).slice(0, 60))));
    console.log('P3-TOOLS', JSON.stringify(done2).slice(0, 2500));
    const stuck = runs2.filter((r) => r.status === 'running').map((r) => ({ tr: JSON.parse(r.traceJson ?? '[]').slice(-3), e: r.error }));
    console.log('P3-STUCK', JSON.stringify(stuck).slice(0, 2000));
    const msgs = await db.select().from((await import('../src/db/schema.js')).message);
    console.log('P3-MSG', JSON.stringify(msgs.filter((m) => m.kind === 'status').map((m) => m.content?.slice(0, 150))).slice(0, 2000));
    console.log('P3-CHAIN', JSON.stringify({ parent: parent.status, children: children.map((c) => ({ s: c.status, st: c.stage })), runs: runs2.map((r) => `${r.agentId?.slice(0,4)}:${r.trigger}:${r.status}`), props: props.map((p) => p.status), testruns: entities2.length, merges: mergeLog.split('\n').filter(Boolean).length }));
    expect(children.length).toBe(2);
    expect(children.every((c) => c.status === 'done')).toBe(true);
    expect(parent.status).toBe('done');
    expect(props.filter((p) => p.status === 'merged').length).toBe(2);
    expect(props.filter((p) => p.status === 'superseded').length).toBeGreaterThanOrEqual(2);
    expect(entities2.length).toBeGreaterThanOrEqual(4);
    expect(mergeLog.split('\n').filter(Boolean).length).toBe(2);
    expect(runs2.some((r) => r.trigger === 'stage_enter')).toBe(true);
    for (const c of children) {
      const cr = JSON.parse(c.codeRefJson ?? '{}') as { worktree?: string };
      if (cr.worktree) expect(existsSync(cr.worktree)).toBe(false);
    }
  }, 180000);
});
