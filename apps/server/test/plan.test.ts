import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { agent, eventLog, message, project, task, taskDependency, workstation } from '../src/db/schema.js';
import { loadPlugins } from '../src/plugins.js';
import { conversationIdle } from '../src/runtime/conversation.js';
import { loadModels } from '../src/runtime/models.js';
import { scheduler, startScheduler } from '../src/runtime/scheduler.js';
import { executeTool, type RunCtx } from '../src/runtime/tools/index.js';
import { createEntity } from '../src/usecases/entities.js';
import { buildPermCtx, createTaskUc, transitionTaskUc } from '../src/usecases/index.js';
import { planTask } from '../src/usecases/plan.js';
import { wsThreadOf } from '../src/usecases/threads.js';

const HUMAN = { type: 'human', id: 'local' } as const;
const now = () => new Date().toISOString();

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let dev: typeof workstation.$inferSelect;
let root: typeof workstation.$inferSelect;
let stop: () => void;

const post = (path: string, body?: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const patch = (path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const agentOf = async (templateId: string, wsId = dev.id) =>
  (await db.select().from(agent).where(and(eq(agent.workstationId, wsId), eq(agent.templateId, templateId))))[0]!;

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

async function ctxOf(a: typeof agent.$inferSelect, t: typeof task.$inferSelect | null): Promise<RunCtx> {
  const actor = { type: 'agent', id: a.id } as const;
  return { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: t, run: { id: 'r' } as never };
}

const devIssue = (title: string) => ({ targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title, kind: 'feature', priority: 'p1', module: 'src/board' } });

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

describe('排期与依赖', () => {
  it('planTask 写日期/里程碑/前置，拒绝坏输入', async () => {
    const dep = await addTask({ title: '前置A' });
    const ms = (await createEntity(HUMAN, db, root.id, { entityType: 'Milestone', data: { name: 'v1', due: '2026-03-01' } }));
    const t = await addTask({ title: '目标', status: 'draft' });

    const ok = await planTask(HUMAN, db, t.id, { startAt: '2026-02-01', dueAt: '2026-02-10', milestoneId: ms.kind === 'ok' ? ms.id : 'x', dependsOn: [dep.id] });
    expect(ok.kind).toBe('ok');
    const cur = await reload(t.id);
    expect([cur.startAt, cur.dueAt, cur.milestoneId]).toEqual(['2026-02-01', '2026-02-10', ms.kind === 'ok' ? ms.id : 'x']);
    expect(await db.select().from(taskDependency).where(eq(taskDependency.taskId, t.id))).toHaveLength(1);

    const errOf = async (taskId: string, input: Parameters<typeof planTask>[3]) => ((await planTask(HUMAN, db, taskId, input)) as { error?: string }).error;
    expect(await errOf(t.id, { dependsOn: [t.id] })).toContain('自己');
    expect(await errOf(dep.id, { dependsOn: [t.id] })).toContain('循环');
    expect(await errOf(t.id, { startAt: '2026-02-10', dueAt: '2026-02-01' })).toContain('开始日期');
    expect(await errOf(t.id, { dueAt: '2026/02/01' })).toContain('YYYY-MM-DD');
    const risk = await createEntity(HUMAN, db, root.id, { entityType: 'Risk', data: { title: '风险', level: '高' } });
    expect(await errOf(t.id, { milestoneId: risk.kind === 'ok' ? risk.id : 'x' })).toContain('里程碑');
    await db.insert(project).values({ id: 'p-other', workspaceId: 'default', name: '别的项目', createdAt: now() });
    const other = await addTask({ title: '别的项目', projectId: 'p-other' });
    expect(await errOf(t.id, { dependsOn: [other.id] })).toContain('前置任务不存在');
    const done = await addTask({ status: 'done' });
    expect(await errOf(done.id, { dueAt: '2026-03-01' })).toContain('已结束的任务不能再排期');
    expect((await planTask(HUMAN, db, 'nope', { dueAt: '2026-03-01' })).kind).toBe('not_found');

    const res = await patch(`/api/tasks/${t.id}/plan`, { dueAt: '2026-03-05', dependsOn: [] });
    expect(res.status).toBe(200);
    expect((await reload(t.id)).dueAt).toBe('2026-03-05');
  });

  it('前置没完成时派发与指派都 409，完成后放行', async () => {
    const dep = await addTask({ title: '前置任务' });
    const t = (await createTaskUc(HUMAN, db, root.id, { title: '等前置', dependsOn: [dep.id] })).task!;
    const res = await post(`/api/tasks/${t.id}/dispatch`, devIssue('等前置'));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('「前置任务」');

    const t2 = (await createTaskUc(HUMAN, db, dev.id, { title: '等前置2', input: { kind: 'feature', priority: 'p1', module: 'src/board' }, dependsOn: [dep.id] })).task!;
    const fe = await agentOf('frontend-dev');
    expect((await post(`/api/tasks/${t2.id}/assign`, { agentId: fe.id })).status).toBe(409);

    await db.update(task).set({ status: 'done' }).where(eq(task.id, dep.id));
    expect((await post(`/api/tasks/${t.id}/dispatch`, devIssue('等前置'))).status).toBe(200);
    expect((await post(`/api/tasks/${t2.id}/assign`, { agentId: fe.id })).status).toBe(200);
    await settle();
  });

  it('指派了 Agent 的子任务等前置：draft + pendingAssigneeId，前置完成后自动开工', async () => {
    const architect = await agentOf('architect');
    const fe = await agentOf('frontend-dev');
    const dep = await addTask({ title: '先做我', status: 'reviewing' });

    const out = (await executeTool(await ctxOf(architect, null), 'create_task', { title: '后做', input: { kind: 'feature', priority: 'p1', module: 'src/board' }, assigneeAgentId: fe.id, dependsOn: [dep.id] })) as { taskId?: string; waitingOn?: string[]; error?: string };
    expect(out.waitingOn).toEqual(['先做我']);
    let cur = await reload(out.taskId!);
    expect([cur.status, cur.pendingAssigneeId, cur.assigneeId]).toEqual(['draft', fe.id, null]);

    const r = await transitionTaskUc(HUMAN, db, dep.id, 'approve');
    expect(r.kind).toBe('ok');
    await settle();

    cur = await reload(out.taskId!);
    expect(cur.pendingAssigneeId).toBeNull();
    expect([cur.assigneeType, cur.assigneeId]).toEqual(['agent', fe.id]);
    expect(cur.status).not.toBe('draft');
    const events = await db.select().from(eventLog).where(and(eq(eventLog.targetId, cur.id), eq(eventLog.action, 'task_assigned')));
    expect(events.length).toBeGreaterThan(0);
  });

  it('没指派 Agent 的等待任务，前置完成后在大群提醒', async () => {
    const dep = await addTask({ title: '再做', status: 'reviewing' });
    const t = (await createTaskUc(HUMAN, db, dev.id, { title: '等消息的', input: { kind: 'feature', priority: 'p1', module: 'src/board' }, dependsOn: [dep.id] })).task!;

    await transitionTaskUc(HUMAN, db, dep.id, 'approve');
    await settle();

    expect((await reload(t.id)).status).toBe('draft');
    const th = await wsThreadOf(db, dev.id);
    const msgs = await db.select().from(message).where(eq(message.threadId, th.id));
    expect(msgs.some((m) => m.kind === 'status' && m.content?.includes('前置任务都已完成') && m.content.includes('等消息的'))).toBe(true);
  });

  it('前置被取消时，依赖它的任务在大群收到提醒', async () => {
    const dep = await addTask({ title: '要取消的' });
    const t = await addTask({ title: '等取消的' });
    const other = await addTask({ title: '已完成的', status: 'done' });
    await db.insert(taskDependency).values([
      { taskId: t.id, dependsOnId: dep.id, createdAt: now() },
      { taskId: other.id, dependsOnId: dep.id, createdAt: now() },
    ]);

    await transitionTaskUc(HUMAN, db, dep.id, 'cancel');
    await settle();

    const th = await wsThreadOf(db, dev.id);
    const msgs = await db.select().from(message).where(eq(message.threadId, th.id));
    const note = msgs.filter((m) => m.kind === 'status' && m.content?.includes('已取消'));
    expect(note.some((m) => m.content?.includes('要取消的') && m.content.includes('等取消的'))).toBe(true);
    expect(note.some((m) => m.content?.includes('已完成的'))).toBe(false);
  });
});

describe('项目进展', () => {
  it('project_status 汇总逾期、里程碑进度和未关闭风险', async () => {
    const pm = await agentOf('pm', root.id);
    const ms = await createEntity(HUMAN, db, root.id, { entityType: 'Milestone', data: { name: 'v1', due: '2026-12-31' } });
    const msId = ms.kind === 'ok' ? ms.id : 'x';
    await addTask({ title: '逾期任务', dueAt: '2020-01-01', status: 'in_progress' });
    await addTask({ title: 'ms-完成', milestoneId: msId, status: 'done' });
    await addTask({ title: 'ms-在做', milestoneId: msId, status: 'in_progress' });
    await createEntity(HUMAN, db, root.id, { entityType: 'Risk', data: { title: '开放风险', level: '高', status: '未处理' } });
    await createEntity(HUMAN, db, root.id, { entityType: 'Risk', data: { title: '关掉的风险', level: '低', status: '已关闭' } });

    const r = (await executeTool(await ctxOf(pm, null), 'project_status', {})) as {
      overdue: { title: string }[];
      milestones: { name: string; total: number; done: number }[];
      risks: { title: string }[];
      tasks: { total: number };
      workstations: { pluginId: string }[];
    };
    expect(r.overdue.map((o) => o.title)).toContain('逾期任务');
    const m = r.milestones.find((x) => x.name === 'v1')!;
    expect([m.total, m.done]).toEqual([2, 1]);
    expect(r.risks.map((x) => x.title)).toContain('开放风险');
    expect(r.risks.map((x) => x.title)).not.toContain('关掉的风险');
    expect(r.workstations.map((w) => w.pluginId)).toEqual(expect.arrayContaining(['pm', 'dev']));

    const api = (await (await app.request('/api/projects/proj-aw/status')).json()) as { tasks: { total: number } };
    expect(api.tasks.total).toBe(r.tasks.total);
  });
});
