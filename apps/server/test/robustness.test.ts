import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { MockLanguageModelV4 } from 'ai/test';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, artifact, entity, inboxItem, message, proposal, reviewComment, run, task, thread, workstation } from '../src/db/schema.js';
import { events } from '../src/events.js';
import { loadPlugins } from '../src/plugins.js';
import { afterReview, sendBack } from '../src/runtime/dev_workflow.js';
import { loadModels, modelRegistry } from '../src/runtime/models.js';
import { buildRunContext, scheduler } from '../src/runtime/scheduler.js';
import type { ToolCtx } from '../src/runtime/tools/index.js';
import { manifestOf } from '../src/usecases/index.js';
import { createFixtureRepo } from './fixtures.js';

const HUMAN = { type: 'human', id: 'local' } as const;
const PROMPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../packages/plugins/dev/prompts');
const now = () => new Date().toISOString();

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let dev: typeof workstation.$inferSelect;
let root: typeof workstation.$inferSelect;

const agentOf = async (templateId: string) =>
  (await db.select().from(agent).where(and(eq(agent.workstationId, dev.id), eq(agent.templateId, templateId))))[0]!;

async function addTask(values: Partial<typeof task.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  await db.insert(task).values({ id, projectId: 'proj-aw', workstationId: dev.id, title: 'T', inputJson: '{}', status: 'in_progress', createdAt: now(), ...values });
  return (await db.select().from(task).where(eq(task.id, id)))[0]!;
}

const setSettings = (settings: Record<string, unknown>) =>
  db.update(workstation).set({ settingsJson: JSON.stringify({ targetBranch: 'develop', baseBranch: 'main', commands: {}, ...settings }) }).where(eq(workstation.id, dev.id));

// 跑一次指派给实现者的 run，返回结果与期间的 run_finished
async function runAssigned(values: Partial<typeof task.$inferInsert> = {}) {
  const a = await agentOf('frontend-dev');
  const t = await addTask({ status: 'dispatched', assigneeType: 'agent', assigneeId: a.id, ...values });
  const finished: unknown[] = [];
  const off = events.on('run_finished', (p) => { if (p.taskId === t.id) finished.push(p); });
  const r = await scheduler.trigger(db, a.id, t.id, 'task_assigned');
  await scheduler.idle();
  off();
  return {
    finished,
    run: (await db.select().from(run).where(eq(run.id, r.runId!)))[0]!,
    task: (await db.select().from(task).where(eq(task.id, t.id)))[0]!,
    inbox: await db.select().from(inboxItem),
  };
}

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

describe('run 上下文装配', () => {
  async function codeTask() {
    const repo = createFixtureRepo();
    const t = await addTask({
      inputJson: JSON.stringify({ module: 'src/board' }),
      codeRefJson: JSON.stringify({ worktree: repo, branch: 'aw/abcd1234', base_sha: 'x' }),
      resultJson: JSON.stringify({ acceptance: { batchId: 'b1', passed: false } }),
    });
    await db.insert(artifact).values({ id: 'out1', workstationId: dev.id, taskId: t.id, type: 'test_output', name: 'o', ref: 'AssertionError: 看板列缺失', createdAt: now() });
    await db.insert(entity).values({ id: 'tr1', workstationId: dev.id, entityType: 'TestRun', version: 1, dataJson: JSON.stringify({ command: 'pnpm test', status: 'failed', output_ref: 'out1', batch_id: 'b1' }), createdAt: now(), updatedAt: now() });
    await db.insert(entity).values({ id: 'tr0', workstationId: dev.id, entityType: 'TestRun', version: 1, dataJson: JSON.stringify({ command: 'pnpm old', status: 'failed', batch_id: 'b0' }), createdAt: now(), updatedAt: now() });
    await db.insert(proposal).values({ id: 'p1', taskId: t.id, targetType: 'code', status: 'changes_requested', createdAt: now() });
    await db.insert(reviewComment).values({ id: 'c1', proposalId: 'p1', path: 'src/board/a.tsx', line: 3, body: '请处理空列表', resolved: 0, createdAt: now() });
    await db.insert(reviewComment).values({ id: 'c2', proposalId: 'p1', path: 'src/board/b.tsx', body: '已解决的意见', resolved: 1, createdAt: now() });
    await db.insert(thread).values({ id: 'th1', scopeType: 'task', scopeId: t.id, kind: 'task', createdAt: now() });
    await db.insert(message).values({ id: 'm1', threadId: 'th1', senderType: 'agent', senderId: 'x', kind: 'chat', content: '实现者的过程讨论', createdAt: now() });
    return t;
  }

  it('实现者：角色提示词、Module、分支、文件、验收失败输出、未解决意见都进上下文', async () => {
    const t = await codeTask();
    const { system, messages } = await buildRunContext(db, await agentOf('frontend-dev'), t, manifestOf(dev));
    const user = messages[0]!.content;
    expect(system).toContain(readFileSync(path.join(PROMPTS, 'implementer.md'), 'utf8').trim().slice(0, 200));
    expect(user).toContain('module：src/board');
    expect(user).toContain('分支：aw/abcd1234');
    expect(user).toContain('src/board/index.txt');
    expect(user).toContain('pnpm test: failed');
    expect(user).toContain('AssertionError: 看板列缺失');
    expect(user).not.toContain('pnpm old');
    expect(user).toContain('src/board/a.tsx:3 请处理空列表');
    expect(user).not.toContain('已解决的意见');
    expect(user).toContain('实现者的过程讨论');
  });

  it('reviewer：用自己的提示词，看验收结果，不看线程', async () => {
    const t = await codeTask();
    const { system, messages } = await buildRunContext(db, await agentOf('reviewer'), t, manifestOf(dev));
    expect(system).toContain(readFileSync(path.join(PROMPTS, 'reviewer.md'), 'utf8').trim().slice(0, 200));
    expect(messages[0]!.content).toContain('pnpm test: failed');
    expect(messages[0]!.content).not.toContain('实现者的过程讨论');
  });

  it('全部 dev 模板都带上各自的提示词', async () => {
    for (const tpl of manifestOf(dev)!.agents) {
      const a = await agentOf(tpl.id);
      const { system } = await buildRunContext(db, a, await addTask(), manifestOf(dev));
      expect(system).toContain('提示词：');
    }
  });

  it('经 scheduler → loop 真正发给模型的请求里带提示词和任务上下文', async () => {
    const prompts: unknown[] = [];
    const saved = modelRegistry.get('mock')!;
    modelRegistry.set('mock', {
      ...saved,
      model: new MockLanguageModelV4({
        provider: 'mock',
        modelId: 'capture',
        doGenerate: async (options) => {
          prompts.push(options.prompt);
          return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop' as never, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } as never, warnings: [] };
        },
      }),
    });
    try {
      const repo = createFixtureRepo();
      await setSettings({ repoPath: repo });
      const r = await runAssigned({ inputJson: JSON.stringify({ module: 'src/board' }) });
      expect(r.run.status).toBe('completed');
      const sent = JSON.stringify(prompts[0]);
      const implementer = readFileSync(path.join(PROMPTS, 'implementer.md'), 'utf8').trim().split('\n')[0]!;
      expect(sent).toContain(JSON.stringify(implementer).slice(1, -1));
      expect(sent).toContain('module：src/board');
      expect(sent).toContain(`分支：aw/${r.task.id.slice(0, 8)}`);
      expect(sent).toContain('src/board/index.txt');
    } finally {
      modelRegistry.set('mock', saved);
    }
  });

  it('审查通过后意见标记为已解决', async () => {
    const t = await codeTask();
    await setSettings({ repoPath: '.', requireHumanFor: ['merge'] });
    const a = await agentOf('reviewer');
    await afterReview({ db, actor: { type: 'agent', id: a.id }, permCtx: {} as never, agent: a, task: t, run: {} as never } as ToolCtx, 'p1', 'approve');
    const rows = await db.select().from(reviewComment).where(eq(reviewComment.id, 'c1'));
    expect(rows[0]!.resolved).toBe(1);
  });
});

describe('worktree 准备失败不启动 Agent', () => {
  const expectBlocked = (r: Awaited<ReturnType<typeof runAssigned>>, reason: RegExp) => {
    expect(r.run.status).toBe('error');
    expect(r.run.error).toMatch(reason);
    expect(JSON.parse(r.run.traceJson ?? '[]')).toEqual([]);
    expect(r.run.tokensIn).toBe(0);
    expect(r.task.status).toBe('blocked');
    expect(r.task.blockedReason).toMatch(reason);
    expect(r.task.codeRefJson).toBeNull();
    const item = r.inbox.find((i) => i.kind === 'blocked' && i.refId === r.task.id)!;
    expect(JSON.parse(item.payloadJson!).reason).toMatch(reason);
    expect(r.finished).toHaveLength(1);
  };

  it('mock 保护', async () => {
    expectBlocked(await runAssigned(), /mock 模式不得作用于本仓库/);
  });

  it('目标分支被主工作区检出', async () => {
    await setSettings({ repoPath: createFixtureRepo(), targetBranch: 'main' });
    expectBlocked(await runAssigned(), /被主工作区检出/);
  });

  it('setup 失败，修好后重跑能重新准备', async () => {
    const repo = createFixtureRepo();
    await setSettings({ repoPath: repo, commands: { setup: 'node missing-setup.js' }, setupTimeoutSec: 30 });
    const r = await runAssigned();
    expectBlocked(r, /setup 失败/);

    await setSettings({ repoPath: repo });
    await db.update(task).set({ status: 'in_progress' }).where(eq(task.id, r.task.id));
    const retry = await scheduler.trigger(db, r.task.assigneeId!, r.task.id, 'manual');
    await scheduler.idle();
    expect((await db.select().from(run).where(eq(run.id, retry.runId!)))[0]!.tokensIn).toBeGreaterThan(0);
    expect((await db.select().from(task).where(eq(task.id, r.task.id)))[0]!.codeRefJson).toContain('worktree');
  });

  it('仓库不存在：git 抛错也收敛到 blocked', async () => {
    await setSettings({ repoPath: path.join(createFixtureRepo(), 'nope') });
    expectBlocked(await runAssigned(), /worktree 准备失败/);
  });
});

describe('没有可用模型', () => {
  it('run 落 error、进收件箱、发 run_finished、任务转 blocked', async () => {
    const saved = [...modelRegistry.entries()];
    modelRegistry.clear();
    try {
      await setSettings({ repoPath: createFixtureRepo() });
      const r = await runAssigned();
      expect(r.run.status).toBe('error');
      expect(r.run.error).toBe('没有可用的模型 provider');
      expect(r.task.status).toBe('blocked');
      expect(r.inbox.filter((i) => i.kind === 'run_failed' && i.refId === r.run.id)).toHaveLength(1);
      expect(r.finished).toHaveLength(1);
      expect(r.task.codeRefJson).toBeNull();
    } finally {
      for (const [k, v] of saved) modelRegistry.set(k, v);
    }
  });
});

describe('异步异常隔离', () => {
  it('executeRun 抛错：run 收尾且不产生未处理 rejection', async () => {
    const rejections: unknown[] = [];
    const onReject = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onReject);
    try {
      const a = await agentOf('frontend-dev');
      await db.update(agent).set({ toolsJson: '{broken' }).where(eq(agent.id, a.id));
      await setSettings({ repoPath: createFixtureRepo() });
      const r = await runAssigned();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(r.run.status).toBe('error');
      expect(r.inbox.filter((i) => i.kind === 'run_failed' && i.refId === r.run.id)).toHaveLength(1);
      expect(r.finished).toHaveLength(1);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onReject);
    }
  });

  it('事件处理器同步抛错、异步 rejection 都不影响发布方和其他处理器', async () => {
    const rejections: unknown[] = [];
    const onReject = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onReject);
    const seen: string[] = [];
    const offs = [
      events.on('t_iso', () => { throw new Error('sync'); }),
      events.on('t_iso', async () => { throw new Error('async'); }),
      events.on('t_iso', () => { seen.push('ok'); }),
    ];
    try {
      expect(() => events.emit('t_iso', {})).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen).toEqual(['ok']);
      expect(rejections).toEqual([]);
    } finally {
      for (const off of offs) off();
      process.off('unhandledRejection', onReject);
    }
  });
});

describe('SSE 监听器回收', () => {
  async function withServer(fn: (base: string) => Promise<void>) {
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    try {
      await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    } finally {
      server.close();
    }
  }

  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(cond()).toBe(true);
  };

  // fetch 返回只代表响应头到了；订阅发生在写完历史之后，等计数上来再断开
  const open = async (url: string, action: string, base: number) => {
    const ctl = new AbortController();
    const res = await fetch(url, { signal: ctl.signal });
    await waitFor(() => events.listenerCount(action) > base);
    return { ctl, res };
  };

  it('thread：客户端断开后监听器被移除', async () => {
    const base = events.listenerCount('message_created');
    await withServer(async (url) => {
      const conns = [await open(`${url}/api/threads/th/stream`, 'message_created', base), await open(`${url}/api/threads/th/stream`, 'message_created', base + 1)];
      expect(events.listenerCount('message_created')).toBe(base + 2);
      for (const c of conns) c.ctl.abort();
      await waitFor(() => events.listenerCount('message_created') === base);
    });
  });

  it('run：客户端断开后两类监听器都被移除', async () => {
    await db.insert(run).values({ id: 'r-open', status: 'running', startedAt: now(), tokensIn: 0, tokensOut: 0, traceJson: '[]' });
    const step = events.listenerCount('run_step');
    const fin = events.listenerCount('run_finished');
    await withServer(async (url) => {
      const c = await open(`${url}/api/runs/r-open/stream`, 'run_finished', fin);
      expect(events.listenerCount('run_step')).toBe(step + 1);
      c.ctl.abort();
      await waitFor(() => events.listenerCount('run_step') === step && events.listenerCount('run_finished') === fin);
    });
  });

  it('run：run_finished 后服务端主动结束流', async () => {
    await db.insert(run).values({ id: 'r-end', status: 'running', startedAt: now(), tokensIn: 0, tokensOut: 0, traceJson: '[]' });
    const fin = events.listenerCount('run_finished');
    await withServer(async (url) => {
      const { res } = await open(`${url}/api/runs/r-end/stream`, 'run_finished', fin);
      events.emit('run_finished', { runId: 'r-end', stopReason: 'completed' });
      expect(await res.text()).toContain('event: finished');
      expect(events.listenerCount('run_finished')).toBe(fin);
    });
  });
});

describe('GET /workstations/:id/proposals', () => {
  it('只返回本台提案', async () => {
    const own = await addTask();
    const other = await addTask({ workstationId: root.id });
    const dispatched = await addTask({ workstationId: root.id, assigneeType: 'workstation', assigneeId: dev.id });
    await db.insert(entity).values({ id: 'e-dev', workstationId: dev.id, entityType: 'ADR', version: 1, dataJson: '{}', createdAt: now(), updatedAt: now() });
    await db.insert(proposal).values([
      { id: 'own', taskId: own.id, targetType: 'code', status: 'pending', createdAt: now() },
      { id: 'other', taskId: other.id, targetType: 'code', status: 'pending', createdAt: now() },
      { id: 'dispatched', taskId: dispatched.id, targetType: 'entity', status: 'pending', createdAt: now() },
      { id: 'by-entity', entityId: 'e-dev', targetType: 'entity', status: 'pending', createdAt: now() },
    ]);
    const ids = async (wsId: string) => ((await (await app.request(`/api/workstations/${wsId}/proposals`)).json()) as { id: string }[]).map((p) => p.id).sort();
    expect(await ids(dev.id)).toEqual(['by-entity', 'dispatched', 'own']);
    expect(await ids(root.id)).toEqual(['dispatched', 'other']);
  });
});

describe('退回计数', () => {
  const ctx = { actor: HUMAN };
  const reload = async (id: string) => (await db.select().from(task).where(eq(task.id, id)))[0]!;
  const review = (id: string) => db.update(task).set({ status: 'reviewing', stage: 'review' }).where(eq(task.id, id));

  it('计数落库，前 3 次回到实现阶段', async () => {
    const t = await addTask({ status: 'reviewing', stage: 'review' });
    for (let n = 1; n <= 3; n++) {
      await sendBack(db, ctx, t.id, `第 ${n} 次`);
      const cur = await reload(t.id);
      expect(cur.feedbackCount).toBe(n);
      expect(cur.status).toBe('in_progress');
      expect(cur.stage).toBe('implement');
      await review(t.id);
    }
    expect((await db.select().from(inboxItem).where(eq(inboxItem.refId, t.id)))).toHaveLength(0);
  });

  it('重启后计数延续，超限转 blocked 并进收件箱；解除后重新计', async () => {
    // 计数只在 DB 里：直接从 3 开始即等同进程重启后的状态
    const t = await addTask({ status: 'reviewing', stage: 'review', feedbackCount: 3 });
    await sendBack(db, ctx, t.id, '验收未通过');
    const cur = await reload(t.id);
    expect(cur.status).toBe('blocked');
    expect(cur.stage).toBe('implement');
    expect(cur.blockedReason).toContain('验收未通过');
    expect(cur.feedbackCount).toBe(0);
    const items = await db.select().from(inboxItem).where(eq(inboxItem.refId, t.id));
    expect(items.map((i) => i.kind)).toEqual(['blocked']);
    expect(JSON.parse(items[0]!.payloadJson!).reason).toContain('验收未通过');

    await review(t.id);
    await sendBack(db, ctx, t.id, '人工解除后再次退回');
    expect((await reload(t.id)).status).toBe('in_progress');
  });
});
