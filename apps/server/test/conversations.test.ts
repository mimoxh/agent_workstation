import { MockLanguageModelV4 } from 'ai/test';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, message, run, thread, threadMember, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { conversationIdle, threadQueueLength } from '../src/runtime/conversation.js';
import { loadModels, modelRegistry } from '../src/runtime/models.js';
import { scheduler, startScheduler } from '../src/runtime/scheduler.js';
import { dmThreadOf, postThreadMessage } from '../src/usecases/threads.js';

const HUMAN = { type: 'human', id: 'local' } as const;

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let dev: typeof workstation.$inferSelect;
let root: typeof workstation.$inferSelect;
let stop: () => void;

const post = (path: string, body?: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const agentOf = async (templateId: string, wsId = dev.id) =>
  (await db.select().from(agent).where(and(eq(agent.workstationId, wsId), eq(agent.templateId, templateId))))[0]!;

// 发言是事件接力：调度队列和发言队列连续几轮都空才算真的停了
async function settle() {
  for (let quiet = 0; quiet < 3;) {
    await new Promise((r) => setTimeout(r, 20));
    await scheduler.idle();
    quiet = conversationIdle() ? quiet + 1 : 0;
  }
}

const create = async (wsId: string, agentIds: string[], title?: string) => {
  const res = await post(`/api/workstations/${wsId}/conversations`, { agentIds, ...(title ? { title } : {}) });
  return { status: res.status, thread: ((await res.json()) as { thread?: typeof thread.$inferSelect }).thread };
};

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
  stop = startScheduler(db);
});

afterEach(() => stop());

describe('私聊', () => {
  it('同一 Agent 可以有多条私聊，/agents/:id/thread 取最近活跃的那条', async () => {
    const fe = await agentOf('frontend-dev');
    const t1 = (await create(dev.id, [fe.id])).thread!;
    const t2 = (await create(dev.id, [fe.id])).thread!;
    expect(t1.id).not.toBe(t2.id);

    // 两条都没消息时按 createdAt：把 t2 拨得更新一些，它成为默认会话
    await db.update(thread).set({ createdAt: '2020-01-01T00:00:00.000Z' }).where(eq(thread.id, t1.id));
    await db.update(thread).set({ createdAt: '2020-01-02T00:00:00.000Z' }).where(eq(thread.id, t2.id));
    const cur = (await (await app.request(`/api/agents/${fe.id}/thread`)).json()) as { thread: typeof thread.$inferSelect };
    expect(cur.thread.id).toBe(t2.id);

    // t1 有新消息后换成 t1
    await postThreadMessage(HUMAN, db, t1.id, '回到旧会话');
    const after = (await (await app.request(`/api/agents/${fe.id}/thread`)).json()) as { thread: typeof thread.$inferSelect };
    expect(after.thread.id).toBe(t1.id);
    await settle();
  });

  it('私聊里人发话，对方 Agent 回话', async () => {
    const fe = await agentOf('frontend-dev');
    const th = (await dmThreadOf(db, fe.id))!;
    await postThreadMessage(HUMAN, db, th.id, '在吗');
    await settle();
    const runs = await db.select().from(run).where(eq(run.threadId, th.id));
    expect(runs.some((r) => r.agentId === fe.id && r.trigger === 'human_reply')).toBe(true);
  });
});

describe('建会话', () => {
  it('成员不属于本台或名单为空 → 400', async () => {
    const fe = await agentOf('frontend-dev');
    const pm = await agentOf('pm', root.id);
    expect((await create(dev.id, [fe.id, pm.id])).status).toBe(400);
    expect((await post(`/api/workstations/${dev.id}/conversations`, { agentIds: [] })).status).toBe(400);
    expect((await post(`/api/workstations/nonexistent/conversations`, { agentIds: [fe.id] })).status).toBe(404);
  });

  it('含 steward 时群主是 steward，否则是第一个成员；members 只回群成员', async () => {
    const architect = await agentOf('architect');
    const fe = await agentOf('frontend-dev');
    const be = await agentOf('backend-dev');

    const withSteward = (await create(dev.id, [fe.id, architect.id])).thread!;
    expect(withSteward.kind).toBe('group');
    expect(withSteward.mode).toBe('moderated');
    const host1 = await db.select().from(threadMember).where(and(eq(threadMember.threadId, withSteward.id), eq(threadMember.role, 'host')));
    expect(host1[0]?.participantId).toBe(architect.id);

    const without = (await create(dev.id, [fe.id, be.id])).thread!;
    const host2 = await db.select().from(threadMember).where(and(eq(threadMember.threadId, without.id), eq(threadMember.role, 'host')));
    expect(host2[0]?.participantId).toBe(fe.id);

    const members = (await (await app.request(`/api/threads/${without.id}/members`)).json()) as { id: string }[];
    expect(members.map((m) => m.id).sort()).toEqual([be.id, fe.id].sort());
  });
});

describe('群聊调度', () => {
  it('人没点名时群主被调度回话，@ 成员时该成员回话', async () => {
    const architect = await agentOf('architect');
    const fe = await agentOf('frontend-dev');

    const th = (await create(dev.id, [architect.id, fe.id])).thread!;
    await postThreadMessage(HUMAN, db, th.id, '这个方向行不行');
    await settle();
    const runs = await db.select().from(run).where(eq(run.threadId, th.id));
    expect(runs.some((r) => r.agentId === architect.id && r.trigger === 'moderated')).toBe(true);

    const th2 = (await create(dev.id, [architect.id, fe.id])).thread!;
    await postThreadMessage(HUMAN, db, th2.id, '@前端开发 看一下');
    await settle();
    const runs2 = await db.select().from(run).where(eq(run.threadId, th2.id));
    expect(runs2.some((r) => r.agentId === fe.id && r.trigger === 'mentioned')).toBe(true);
  });
});

// 等到条件成立；事件接力是异步的，直接断言会抢跑
async function waitFor(cond: () => Promise<boolean>, label: string) {
  for (let i = 0; i < 150; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等待超时：${label}`);
}

const runningIn = (threadId: string) => db.select().from(run).where(and(eq(run.threadId, threadId), eq(run.status, 'running')));

describe('停止会话', () => {
  // doGenerate 挂到 abort 才返回：run 会停在 running，stop 才能观察到中止
  const hangingRoute = () => ({
    id: 'mock:scripted',
    model: new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'scripted',
      doGenerate: ({ abortSignal }) => new Promise<never>((_, reject) => { abortSignal?.addEventListener('abort', () => reject(new Error('aborted'))); }),
    }) as never,
    supportsParallelTools: true,
  });

  const withHanging = async (fn: () => Promise<void>) => {
    const orig = modelRegistry.get('mock');
    modelRegistry.set('mock', hangingRoute());
    try {
      await fn();
    } finally {
      if (orig) modelRegistry.set('mock', orig);
    }
  };

  it('停掉进行中的回复与排队回合，状态消息一次，别的线程不受影响', async () => {
    await withHanging(async () => {
      const fe = await agentOf('frontend-dev');
      const be = await agentOf('backend-dev');
      const th1 = (await dmThreadOf(db, fe.id))!;
      const th2 = (await dmThreadOf(db, be.id))!;

      await postThreadMessage(HUMAN, db, th1.id, '第一条');
      await postThreadMessage(HUMAN, db, th2.id, '别的线程');
      await waitFor(async () => (await runningIn(th1.id)).length === 1, 'th1 run 启动');
      await waitFor(async () => (await runningIn(th2.id)).length === 1, 'th2 run 启动');

      // 第一条还在生成，再发一条 → 回合排队
      await postThreadMessage(HUMAN, db, th1.id, '排队的第二条');
      await waitFor(async () => threadQueueLength(th1.id) === 1, 'th1 排队回合');
      const act = (await (await app.request(`/api/threads/${th1.id}/active`)).json()) as { running: boolean; runIds: string[]; queued: number };
      expect(act).toMatchObject({ running: true, queued: 1 });
      expect(act.runIds).toHaveLength(1);

      const res = await post(`/api/threads/${th1.id}/stop`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { stopped: number }).stopped).toBe(2);
      await waitFor(async () => (await runningIn(th1.id)).length === 0, 'th1 run 取消');

      const act2 = (await (await app.request(`/api/threads/${th1.id}/active`)).json()) as { running: boolean; queued: number };
      expect(act2).toMatchObject({ running: false, queued: 0 });
      const runs1 = await db.select().from(run).where(eq(run.threadId, th1.id));
      expect(runs1.every((r) => r.status === 'cancelled')).toBe(true);
      const stops = (await db.select().from(message).where(and(eq(message.threadId, th1.id), eq(message.kind, 'status')))).filter((m) => m.content === '已停止，发新消息会继续。');
      expect(stops).toHaveLength(1);
      // 截断的部分输出不会进会话
      expect((await db.select().from(message).where(eq(message.threadId, th1.id))).every((m) => m.senderId !== fe.id)).toBe(true);
      // 别的线程的 run 还在跑
      expect((await runningIn(th2.id)).length).toBe(1);

      await post(`/api/threads/${th2.id}/stop`);
      await waitFor(async () => (await runningIn(th2.id)).length === 0, 'th2 run 取消');
      await settle();
    });
  });

  it('没有正在进行的回复 → stopped 0，不发状态消息', async () => {
    const fe = await agentOf('frontend-dev');
    const th = (await dmThreadOf(db, fe.id))!;
    const res = await post(`/api/threads/${th.id}/stop`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stopped: number }).stopped).toBe(0);
    expect(await db.select().from(message).where(eq(message.threadId, th.id))).toHaveLength(0);
    expect((await post('/api/threads/ghost/stop')).status).toBe(404);
    expect(((await (await app.request(`/api/threads/${th.id}/active`)).json()) as { running: boolean; queued: number })).toMatchObject({ running: false, queued: 0 });
    expect((await app.request('/api/threads/ghost/active')).status).toBe(404);
  });
});

describe('归档', () => {
  type Row = { id: string; archivedAt: string | null };
  const list = async () => ((await (await app.request(`/api/workstations/${dev.id}/conversations`)).json()) as { conversations: Row[] }).conversations;
  const archive = (id: string, archived: boolean) => post(`/api/threads/${id}/archive`, { archived });

  it('归档后列表带 archivedAt、默认私聊换新的；人再发话自动取消归档', async () => {
    const fe = await agentOf('frontend-dev');
    const dm = (await dmThreadOf(db, fe.id))!;
    const res = await archive(dm.id, true);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { archivedAt: string | null }).archivedAt).toBeTruthy();
    expect((await list()).find((c) => c.id === dm.id)?.archivedAt).toBeTruthy();

    // 默认私聊跳过已归档的，没有就新建一条
    const fresh = (await (await app.request(`/api/agents/${fe.id}/thread`)).json()) as { thread: { id: string } };
    expect(fresh.thread.id).not.toBe(dm.id);

    // 重复归档不报错；取消归档后 archivedAt 清空
    expect((await archive(dm.id, true)).status).toBe(200);
    expect((await archive(dm.id, false)).status).toBe(200);
    expect((await list()).find((c) => c.id === dm.id)?.archivedAt).toBeNull();

    await archive(dm.id, true);
    await postThreadMessage(HUMAN, db, dm.id, '接着聊');
    expect((await db.select().from(thread).where(eq(thread.id, dm.id)))[0]!.archivedAt).toBeNull();
    await settle();
    const runs = await db.select().from(run).where(eq(run.threadId, dm.id));
    expect(runs.some((r) => r.agentId === fe.id && r.trigger === 'human_reply')).toBe(true);
  });

  it('只有私聊和群聊能归档；不存在 404', async () => {
    const ws = (await (await app.request(`/api/workstations/${dev.id}/thread`)).json()) as { thread: { id: string } };
    expect((await archive(ws.thread.id, true)).status).toBe(400);
    expect((await archive('ghost', true)).status).toBe(404);
  });
});

describe('会话列表', () => {
  it('按最近活跃倒序，带成员、群主与预览；人的首条消息给未命名会话起题', async () => {
    const fe = await agentOf('frontend-dev');
    const be = await agentOf('backend-dev');
    const dm = (await create(dev.id, [fe.id])).thread!;
    const grp = (await create(dev.id, [fe.id, be.id])).thread!;

    const list = ((await (await app.request(`/api/workstations/${dev.id}/conversations`)).json()) as { conversations: { id: string; kind: string; title: string | null; agentIds: string[]; hostId: string | null; lastPreview: string | null }[] }).conversations;
    const dmRow = list.find((x) => x.id === dm.id)!;
    expect([dmRow.kind, dmRow.agentIds, dmRow.lastPreview]).toEqual(['dm', [fe.id], null]);
    const grpRow = list.find((x) => x.id === grp.id)!;
    expect([grpRow.kind, grpRow.title, grpRow.hostId]).toEqual(['group', null, fe.id]);
    expect(grpRow.agentIds.sort()).toEqual([be.id, fe.id].sort());

    // 私聊没有消息，把它的创建时间拨到很前面；群聊发一条后应该排到最前
    await db.update(thread).set({ createdAt: '2020-01-01T00:00:00.000Z' }).where(eq(thread.id, dm.id));
    await postThreadMessage(HUMAN, db, grp.id, '今天对齐\n接口边界');
    const after = ((await (await app.request(`/api/workstations/${dev.id}/conversations`)).json()) as { conversations: { id: string; lastPreview: string | null }[] }).conversations;
    expect(after[0]!.id).toBe(grp.id);
    expect(after[0]!.lastPreview).toBe('今天对齐\n接口边界');
    const titled = (await db.select().from(thread).where(eq(thread.id, grp.id)))[0]!;
    expect(titled.title).toBe('今天对齐 接口边界');
    await settle();
  });
});
