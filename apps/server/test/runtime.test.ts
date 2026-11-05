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
import { buildPermCtx } from '../src/usecases/index.js';
import { buildContext } from '../src/runtime/context.js';
import { scheduler } from '../src/runtime/scheduler.js';
import { agent, inboxItem, run, task, workstation, entityVersion } from '../src/db/schema.js';
import { and, eq } from 'drizzle-orm';

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
    expect(archRun.tokensIn).toBe(400);
    expect(archRun.tokensOut).toBe(200);
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
