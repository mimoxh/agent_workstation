import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, inboxItem, message, proposal, run, task, thread, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { conversationIdle } from '../src/runtime/conversation.js';
import { loadModels } from '../src/runtime/models.js';
import { scheduler, startScheduler } from '../src/runtime/scheduler.js';
import { executeTool, type RunCtx } from '../src/runtime/tools/index.js';
import { buildPermCtx, createTaskUc } from '../src/usecases/index.js';
import { postThreadMessage, taskThreadOf, wsThreadOf } from '../src/usecases/threads.js';

const HUMAN = { type: 'human', id: 'local' } as const;
const now = () => new Date().toISOString();

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

async function addTask(values: Partial<typeof task.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  await db.insert(task).values({ id, projectId: 'proj-aw', workstationId: dev.id, title: 'T', inputJson: '{}', status: 'in_progress', createdAt: now(), ...values });
  return (await db.select().from(task).where(eq(task.id, id)))[0]!;
}

const reload = async (id: string) => (await db.select().from(task).where(eq(task.id, id)))[0]!;
const messagesOf = (threadId: string) => db.select().from(message).where(eq(message.threadId, threadId));

async function ctxOf(a: typeof agent.$inferSelect, t: typeof task.$inferSelect | null): Promise<RunCtx> {
  const actor = { type: 'agent', id: a.id } as const;
  return { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: t, run: { id: 'r' } as never };
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
  stop = startScheduler(db);
});

afterEach(() => stop());

describe('工作台讨论', () => {
  it('人发话 → steward 主持 → 点名成员 → 成员回话 → 收束成结论', async () => {
    const th = await wsThreadOf(db, dev.id);
    expect(th.mode).toBe('moderated');
    await postThreadMessage(HUMAN, db, th.id, '看板筛选该放 URL 还是本地状态？');
    await settle();

    const msgs = (await messagesOf(th.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const architect = await agentOf('architect');
    expect(msgs.some((m) => m.senderId === architect.id && m.kind === 'chat' && m.content?.includes('@'))).toBe(true);
    expect(msgs.some((m) => m.kind === 'chat' && m.senderType === 'agent' && m.senderId !== architect.id)).toBe(true);
    expect(msgs.some((m) => m.kind === 'decision')).toBe(true);
    const runs = await db.select().from(run).where(eq(run.threadId, th.id));
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs.every((r) => r.taskId === null)).toBe(true);
  });

  it('达到发言上限：收束后静默，人再说话才恢复', async () => {
    const th = await wsThreadOf(db, dev.id);
    const fe = await agentOf('frontend-dev');
    await db.update(thread).set({ turnCount: 11 }).where(eq(thread.id, th.id));
    await postThreadMessage(HUMAN, db, th.id, '@前端开发 再补一句');
    await db.update(thread).set({ turnCount: 11 }).where(eq(thread.id, th.id));
    await settle();
    void fe;

    let cur = (await db.select().from(thread).where(eq(thread.id, th.id)))[0]!;
    expect(cur.state).toBe('silenced');
    expect((await messagesOf(th.id)).some((m) => m.kind === 'decision')).toBe(true);

    await postThreadMessage(HUMAN, db, th.id, '继续');
    cur = (await db.select().from(thread).where(eq(thread.id, th.id)))[0]!;
    expect(cur.state).toBe('active');
    await settle();
  });

  it('人可以静默线程，静默期间 Agent 发言不再接力', async () => {
    const th = await wsThreadOf(db, dev.id);
    const fe = await agentOf('frontend-dev');
    expect((await post(`/api/threads/${th.id}/silence`, { silenced: true })).status).toBe(200);
    await executeTool({ ...(await ctxOf(fe, null)), thread: { ...th, state: 'silenced' } }, 'send_message', { content: '@架构师 在吗' });
    await settle();
    expect(await db.select().from(run).where(eq(run.threadId, th.id))).toHaveLength(0);
  });
});

describe('任务会话', () => {
  it('Agent 可以 @ 另一个 Agent，对方真的会被唤醒', async () => {
    const fe = await agentOf('frontend-dev');
    const architect = await agentOf('architect');
    const t = await addTask({ assigneeType: 'agent', assigneeId: fe.id });
    const th = (await taskThreadOf(db, t.id))!;
    expect(th.mode).toBe('moderated');
    await postThreadMessage(HUMAN, db, th.id, '@前端开发 转问架构师');
    await settle();

    const msgs = await messagesOf(th.id);
    expect(msgs.some((m) => m.senderId === fe.id && m.content?.includes('@架构师'))).toBe(true);
    expect(msgs.some((m) => m.senderId === architect.id && m.kind === 'chat')).toBe(true);
    const runs = await db.select().from(run).where(eq(run.taskId, t.id));
    expect(runs.map((r) => r.trigger).sort()).toEqual(['mentioned', 'mentioned']);
  });

  it('工作 run 里的消息不计入发言轮次，但点名仍然有效', async () => {
    const fe = await agentOf('frontend-dev');
    const architect = await agentOf('architect');
    const t = await addTask({ assigneeType: 'agent', assigneeId: fe.id });
    const th = (await taskThreadOf(db, t.id))!;
    await executeTool({ ...(await ctxOf(fe, t)), thread: th }, 'send_message', { content: '进度：改完一半' });
    await settle();
    expect((await db.select().from(thread).where(eq(thread.id, th.id)))[0]!.turnCount).toBe(0);
    expect(await db.select().from(run).where(eq(run.taskId, t.id))).toHaveLength(0);

    await executeTool({ ...(await ctxOf(fe, t)), thread: th }, 'send_message', { content: '@架构师 接口怎么定' });
    await settle();
    expect((await db.select().from(run).where(eq(run.taskId, t.id))).map((r) => r.agentId)).toEqual([architect.id]);
  });

  it('人没点名时默认找 assignee', async () => {
    const fe = await agentOf('frontend-dev');
    const t = await addTask({ assigneeType: 'agent', assigneeId: fe.id });
    const th = (await taskThreadOf(db, t.id))!;
    await postThreadMessage(HUMAN, db, th.id, '进度怎么样');
    await settle();
    const runs = await db.select().from(run).where(eq(run.taskId, t.id));
    expect(runs.map((r) => [r.agentId, r.trigger])).toEqual([[fe.id, 'human_reply']]);
  });

  it('被 @ 来帮忙的成员不能写 assignee 的 worktree', async () => {
    const fe = await agentOf('frontend-dev');
    const be = await agentOf('backend-dev');
    const t = await addTask({ assigneeType: 'agent', assigneeId: fe.id, codeRefJson: JSON.stringify({ worktree: 'C:/wt', branch: 'b', base_sha: 'x' }) });
    const r = (await executeTool({ ...(await ctxOf(be, t)), run: { id: 'r', trigger: 'mentioned' } as never }, 'apply_patch', { creates: [] })) as { error?: string };
    expect(r.error).toContain('assignee');
  });

  it('依赖任务的工具在讨论线程里被拦下', async () => {
    const be = await agentOf('backend-dev');
    const r = (await executeTool(await ctxOf(be, null), 'read_file', { path: 'x' })) as { error?: string };
    expect(r.error).toContain('任务上下文');
  });
});

describe('根台项目经理', () => {
  it('人说需求 → 项目经理起草任务草稿，等人确认派发', async () => {
    const th = await wsThreadOf(db, root.id);
    await postThreadMessage(HUMAN, db, th.id, '给任务看板加状态筛选');
    await settle();
    const drafts = await db.select().from(task).where(and(eq(task.workstationId, root.id), eq(task.status, 'draft')));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.title).toContain('状态筛选');
    expect((await messagesOf(th.id)).some((m) => m.metaJson?.includes(drafts[0]!.id))).toBe(true);
  });

  it('可以把任务派发到子工作台，不能派给兄弟或祖先', async () => {
    const pm = await agentOf('pm', root.id);
    const t = (await createTaskUc(HUMAN, db, root.id, { title: '派发测试' })).task!;
    const ok = (await executeTool(await ctxOf(pm, null), 'dispatch_task', { taskId: t.id, targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title: '派发测试', kind: 'feature', priority: 'p1', module: 'src/board' } })) as { status?: string; error?: string };
    expect(ok.status).toBe('dispatched');
    const architect = await agentOf('architect');
    const child = (await createTaskUc(HUMAN, db, dev.id, { title: '子台任务', input: { kind: 'feature', priority: 'p1', module: 'src/board' } })).task!;
    const bad = (await executeTool(await ctxOf(architect, null), 'dispatch_task', { taskId: child.id, targetWorkstationId: root.id, typeId: 'dev.issue', input: {} })) as { error?: string };
    expect(bad.error).toBeTruthy();
    await settle();
  });
});

describe('阻塞分诊', () => {
  const report = async (reason: string) => {
    const fe = await agentOf('frontend-dev');
    // 已有 worktree：恢复后的 run 不走 worktree 准备，这里只验证分诊
    const t = await addTask({ assigneeType: 'agent', assigneeId: fe.id, codeRefJson: JSON.stringify({ worktree: 'C:/none', branch: 'b', base_sha: 'x' }) });
    await executeTool(await ctxOf(fe, t), 'report_blocked', { reason, missing: 'TestRun 字段', tried: '读了 schema' });
    return t;
  };

  it('本台能解决：steward 解除，执行者继续，不打扰人', async () => {
    const t = await report('接口命名不确定');
    await settle();
    expect((await reload(t.id)).status).toBe('in_progress');
    expect(await db.select().from(inboxItem).where(eq(inboxItem.refId, t.id))).toHaveLength(0);
    const runs = await db.select().from(run).where(eq(run.taskId, t.id));
    expect(runs.map((r) => r.trigger)).toContain('block_triage');
    expect(runs.map((r) => r.trigger)).toContain('feedback');
  });

  it('超出本台决策权：steward 上送，结构化信息进收件箱', async () => {
    const t = await report('需人决策：要不要改表');
    await settle();
    expect((await reload(t.id)).status).toBe('escalated');
    const items = await db.select().from(inboxItem).where(eq(inboxItem.refId, t.id));
    expect(items.map((i) => i.kind)).toEqual(['blocked']);
    expect(JSON.parse(items[0]!.payloadJson!).reason).toContain('缺：TestRun 字段');
  });

  it('上报者要人决策时不经 steward', async () => {
    const fe = await agentOf('frontend-dev');
    const t = await addTask({ assigneeType: 'agent', assigneeId: fe.id });
    await executeTool(await ctxOf(fe, t), 'report_blocked', { reason: '选型', decider: 'human' });
    await settle();
    expect((await reload(t.id)).status).toBe('escalated');
    expect((await db.select().from(run).where(eq(run.taskId, t.id))).map((r) => r.trigger)).not.toContain('block_triage');
  });

  it('没有调度器时阻塞直接进收件箱，不会悬着', async () => {
    stop();
    const t = await report('无人值守');
    expect((await reload(t.id)).status).toBe('escalated');
    expect(await db.select().from(inboxItem).where(eq(inboxItem.refId, t.id))).toHaveLength(1);
    stop = startScheduler(db);
  });
});

describe('人的介入', () => {
  it('接管后任务归人，交还后回到原 Agent 继续', async () => {
    const fe = await agentOf('frontend-dev');
    const t = await addTask({ assigneeType: 'agent', assigneeId: fe.id, status: 'blocked', blockedReason: 'x', codeRefJson: JSON.stringify({ worktree: 'C:/none', branch: 'b', base_sha: 'x' }) });
    await db.insert(inboxItem).values({ id: 'i1', workspaceId: 'default', projectId: 'proj-aw', kind: 'blocked', refType: 'task', refId: t.id, status: 'open', createdAt: now() });

    expect((await post(`/api/tasks/${t.id}/takeover`)).status).toBe(200);
    let cur = await reload(t.id);
    expect([cur.status, cur.assigneeType, cur.assigneeId, cur.takeoverFrom]).toEqual(['in_progress', 'human', 'local', fe.id]);
    expect((await db.select().from(inboxItem).where(eq(inboxItem.id, 'i1')))[0]!.status).toBe('resolved');

    expect((await post(`/api/tasks/${t.id}/release`, { note: '我改好了接口' })).status).toBe(200);
    await settle();
    cur = await reload(t.id);
    expect([cur.assigneeType, cur.assigneeId, cur.takeoverFrom]).toEqual(['agent', fe.id, null]);
    expect((await db.select().from(run).where(eq(run.taskId, t.id))).map((r) => r.trigger)).toEqual(['feedback']);
  });

  it('接管后人说话不再唤醒 Agent', async () => {
    const fe = await agentOf('frontend-dev');
    const t = await addTask({ assigneeType: 'agent', assigneeId: fe.id });
    await post(`/api/tasks/${t.id}/takeover`);
    await postThreadMessage(HUMAN, db, (await taskThreadOf(db, t.id))!.id, '我自己来');
    await settle();
    expect(await db.select().from(run).where(eq(run.taskId, t.id))).toHaveLength(0);
  });

  it('没有在跑的运行时打断返回 409', async () => {
    const t = await addTask();
    expect((await post(`/api/tasks/${t.id}/interrupt`)).status).toBe(409);
  });
});

describe('任务流', () => {
  it('派发时写入目标台的第一阶段，详情返回目标台的 stage', async () => {
    const t = (await createTaskUc(HUMAN, db, root.id, { title: '流' })).task!;
    await post(`/api/tasks/${t.id}/dispatch`, { targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title: '流', kind: 'feature', priority: 'p1', module: 'src/board' } });
    expect((await reload(t.id)).stage).toBe('requirement');
    const d = (await (await app.request(`/api/tasks/${t.id}`)).json()) as { flow: { workstationId: string; stages: { id: string }[]; stewardId: string } };
    expect(d.flow.workstationId).toBe(dev.id);
    expect(d.flow.stages.map((s) => s.id)).toEqual(['requirement', 'design', 'implement', 'test', 'review', 'merge']);
    expect(d.flow.stewardId).toBe((await agentOf('architect')).id);
    await settle();
  });

  it('父任务 stage 取子任务里最落后的阶段', async () => {
    const parent = await addTask({ workstationId: root.id, assigneeType: 'workstation', assigneeId: dev.id, typeId: 'dev.issue', stage: 'requirement' });
    const a = await addTask({ parentId: parent.id, typeId: 'dev.issue', stage: 'review' });
    const b = await addTask({ parentId: parent.id, typeId: 'dev.issue', stage: 'test' });
    expect((await post(`/api/tasks/${a.id}/stage`, { stage: 'merge' })).status).toBe(200);
    expect((await reload(parent.id)).stage).toBe('test');
    expect((await post(`/api/tasks/${b.id}/stage`, { stage: 'review' })).status).toBe(200);
    expect((await reload(parent.id)).stage).toBe('review');
    await settle();
  });
});

describe('提案进人的视野', () => {
  it('实体提案进收件箱和会话，决定后待处理项关闭', async () => {
    const architect = await agentOf('architect');
    const t = await addTask();
    const r = (await executeTool(await ctxOf(architect, t), 'propose_entity', { entityType: 'ADR', data: { title: '筛选走 URL' }, reason: '可分享' })) as { proposalId: string };
    const items = await db.select().from(inboxItem).where(eq(inboxItem.refId, r.proposalId));
    expect(items.map((i) => i.kind)).toEqual(['proposal_review']);
    expect((await messagesOf((await taskThreadOf(db, t.id))!.id)).some((m) => m.kind === 'proposal_notice')).toBe(true);

    expect((await post(`/api/proposals/${r.proposalId}/approve`)).status).toBe(200);
    expect((await db.select().from(inboxItem).where(eq(inboxItem.refId, r.proposalId)))[0]!.status).toBe('resolved');
  });

  it('讨论里没有任务时，提案也归到本台', async () => {
    const architect = await agentOf('architect');
    const r = (await executeTool(await ctxOf(architect, null), 'propose_entity', { entityType: 'ADR', data: { title: '无任务提案' } })) as { proposalId: string };
    const rows = (await (await app.request(`/api/workstations/${dev.id}/proposals`)).json()) as { id: string }[];
    expect(rows.map((p) => p.id)).toContain(r.proposalId);
  });

  it('结论可以沉淀为 ADR 提案', async () => {
    const th = await wsThreadOf(db, dev.id);
    const architect = await agentOf('architect');
    const m = (await executeTool({ ...(await ctxOf(architect, null)), thread: th }, 'record_decision', { summary: '筛选状态放 URL' })) as { messageId: string };
    const res = await post(`/api/messages/${m.messageId}/propose-adr`);
    expect(res.status).toBe(201);
    const { proposalId } = (await res.json()) as { proposalId: string };
    const p = (await db.select().from(proposal).where(eq(proposal.id, proposalId)))[0]!;
    expect([p.targetType, p.status, p.workstationId]).toEqual(['ADR', 'pending', dev.id]);
    expect(JSON.parse(p.patchJson!).decision).toContain('URL');
  });
});

describe('读模型', () => {
  it('主任务的提案和运行汇总子任务', async () => {
    const parent = await addTask({ title: '主任务' });
    const child = await addTask({ parentId: parent.id });
    await db.insert(proposal).values({ id: 'pc', taskId: child.id, targetType: 'code', status: 'pending', createdAt: now() });
    await db.insert(run).values({ id: 'rc', taskId: child.id, status: 'completed', startedAt: now() });
    const ids = async (path: string) => ((await (await app.request(path)).json()) as { id: string }[]).map((x) => x.id);
    expect(await ids(`/api/tasks/${parent.id}/proposals`)).toEqual(['pc']);
    expect(await ids(`/api/tasks/${parent.id}/runs`)).toEqual(['rc']);
  });

  it('时间线合并消息与子任务，子任务带泳道标签', async () => {
    const fe = await agentOf('frontend-dev');
    const parent = await addTask({ title: '主任务' });
    const child = await addTask({ title: '子任务', parentId: parent.id, assigneeType: 'agent', assigneeId: fe.id });
    await postThreadMessage(HUMAN, db, (await taskThreadOf(db, parent.id))!.id, '主线消息');
    stop();
    await postThreadMessage(HUMAN, db, (await taskThreadOf(db, child.id))!.id, '子线消息');
    stop = startScheduler(db);
    const items = (await (await app.request(`/api/tasks/${parent.id}/timeline`)).json()) as { type: string; lane: string | null; content?: string }[];
    expect(items.find((i) => i.content === '主线消息')?.lane).toBeNull();
    expect(items.find((i) => i.content === '子线消息')?.lane).toBe('子任务');
  });

  it('团队脉搏列出全部成员，空闲时 run 为空', async () => {
    const res = (await (await app.request('/api/projects/proj-aw/pulse')).json()) as { name: string; run: unknown }[];
    expect(res.map((a) => a.name)).toEqual(expect.arrayContaining(['架构师', '项目经理']));
    expect(res.every((a) => a.run === null)).toBe(true);
  });
});
