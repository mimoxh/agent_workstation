import { and, eq } from 'drizzle-orm';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { agent, entity, inboxItem, proposal, reviewComment, run, task, workstation } from '../src/db/schema.js';
import { seed } from '../src/db/seed.js';
import { events } from '../src/events.js';
import { loadPlugins } from '../src/plugins.js';
import { cancelRun, runAgent } from '../src/runtime/loop.js';
import { loadModels } from '../src/runtime/models.js';
import { scheduler } from '../src/runtime/scheduler.js';
import { executeTool, type ToolCtx } from '../src/runtime/tools/index.js';
import { buildPermCtx } from '../src/usecases/index.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { enqueueMerge, mergeQueues } from '../src/runtime/dev_workflow.js';
import { createFixtureRepo } from './fixtures.js';

const now = () => new Date().toISOString();
const INPUT = { kind: 'feature', priority: 'p1', module: 'src/board' };

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let dev: typeof workstation.$inferSelect;
let root: typeof workstation.$inferSelect;

const send = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const post = (url: string, body: unknown = {}) => send('POST', url, body);
const patch = (url: string, body: unknown) => send('PATCH', url, body);
const get = async <T>(url: string) => (await (await app.request(url)).json()) as T;

const agentOf = async (templateId: string) =>
  (await db.select().from(agent).where(and(eq(agent.workstationId, dev.id), eq(agent.templateId, templateId))))[0]!;

async function addTask(values: Partial<typeof task.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  await db.insert(task).values({ id, projectId: 'proj-aw', workstationId: dev.id, title: 'T', inputJson: '{}', status: 'in_progress', createdAt: now(), ...values });
  return (await db.select().from(task).where(eq(task.id, id)))[0]!;
}
const reload = async (id: string) => (await db.select().from(task).where(eq(task.id, id)))[0]!;

async function addProposal(values: Partial<typeof proposal.$inferInsert> & { taskId: string }) {
  const id = crypto.randomUUID();
  await db.insert(proposal).values({ id, targetType: 'code', status: 'pending', patchJson: 'diff', createdAt: now(), ...values });
  return id;
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

describe('项目与工作台', () => {
  it('新建项目自带根工作台，可挂载 dev 台并收到全部板块', async () => {
    const res = await post('/api/projects', { name: '新项目', goal: 'g' });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const mounted = await post(`/api/projects/${id}/workstations`, { pluginId: 'dev', name: '开发二' });
    expect(mounted.status).toBe(201);
    const detail = await get<{ workstations: { name: string; parentId: string | null }[]; agents: unknown[] }>(`/api/projects/${id}`);
    expect(detail.workstations.map((w) => w.name).sort()).toEqual(['开发二', '根']);
    expect(detail.workstations.filter((w) => w.parentId === null)).toHaveLength(1);
    expect(detail.agents.length).toBe(6);
  });

  it('空名字、未知插件、跨项目父节点都被拒绝', async () => {
    expect((await post('/api/projects', { name: '  ' })).status).toBe(400);
    expect((await post('/api/projects/proj-aw/workstations', { pluginId: 'ghost', name: 'x' })).status).toBe(400);
    expect((await post('/api/projects/proj-aw/workstations', { pluginId: 'dev', name: 'x', parentId: 'ghost' })).status).toBe(400);
    expect((await post('/api/projects/ghost/workstations', { pluginId: 'dev', name: 'x' })).status).toBe(404);
  });

  it('设置合并写入，不丢未提交字段', async () => {
    expect((await patch(`/api/workstations/${dev.id}`, { settings: { targetBranch: 'integration', requireHumanFor: ['merge'] } })).status).toBe(200);
    const row = (await db.select().from(workstation).where(eq(workstation.id, dev.id)))[0]!;
    const s = JSON.parse(row.settingsJson!) as { targetBranch: string; requireHumanFor: string[]; commands: unknown };
    expect(s.targetBranch).toBe('integration');
    expect(s.requireHumanFor).toEqual(['merge']);
    expect(s.commands).toBeDefined();
  });

  it('项目概览按工作台汇总任务、运行与待审', async () => {
    const t = await addTask({ status: 'blocked' });
    await addProposal({ taskId: t.id });
    await db.insert(run).values({ id: 'r1', agentId: (await agentOf('frontend-dev')).id, taskId: t.id, status: 'running', tokensIn: 5, tokensOut: 7, startedAt: now() });
    const o = await get<{ tasks: { blocked: number }; tokens: number; pendingReviews: number; runs: { running: number }; workstations: { id: string; running: number; pendingReviews: number }[] }>('/api/projects/proj-aw/overview');
    expect(o.tasks.blocked).toBe(1);
    expect(o.tokens).toBe(12);
    expect(o.pendingReviews).toBe(1);
    expect(o.runs.running).toBe(1);
    const d = o.workstations.find((w) => w.id === dev.id)!;
    expect(d.running).toBe(1);
    expect(d.pendingReviews).toBe(1);
  });
});

describe('文件浏览', () => {
  it('能进入子目录（路径不带尾斜杠时 ls-tree 只返回目录自身）', async () => {
    const repo = createFixtureRepo();
    await patch(`/api/workstations/${dev.id}`, { settings: { repoPath: repo, targetBranch: 'develop' } });
    const top = await get<{ ref: string; entries: { name: string; type: string; path: string }[] }>(`/api/workstations/${dev.id}/files`);
    expect(top.ref).toBe('HEAD');
    expect(top.entries[0]!.type).toBe('tree');
    const src = await get<{ entries: { path: string }[] }>(`/api/workstations/${dev.id}/files?path=src`);
    expect(src.entries.map((e) => e.path)).toEqual(['src/board']);
    const board = await get<{ entries: { path: string; size: number }[] }>(`/api/workstations/${dev.id}/files?path=src/board`);
    expect(board.entries[0]!.path).toBe('src/board/index.txt');
    expect(board.entries[0]!.size).toBeGreaterThan(0);
    const file = await get<{ content: string; binary: boolean }>(`/api/workstations/${dev.id}/file?path=src/board/index.txt`);
    expect(file.content).toContain('board placeholder');
    expect(file.binary).toBe(false);
    expect((await app.request(`/api/workstations/${dev.id}/file?path=ghost.txt`)).status).toBe(404);
  });

  it('未绑定仓库的工作台给出原因而不是空列表', async () => {
    const r = await get<{ error: string; entries: unknown[] }>(`/api/workstations/${root.id}/files`);
    expect(r.entries).toEqual([]);
    expect(r.error).toContain('未绑定');
    expect((await get<{ ok: boolean }>(`/api/workstations/${root.id}/repo`)).ok).toBe(false);
  });

  it('目标分支被主工作区检出时，仓库状态提前报警', async () => {
    const repo = createFixtureRepo();
    await patch(`/api/workstations/${dev.id}`, { settings: { repoPath: repo, targetBranch: 'main', baseBranch: 'main' } });
    const s = await get<{ ok: boolean; error: string }>(`/api/workstations/${dev.id}/repo`);
    expect(s.ok).toBe(false);
    expect(s.error).toContain('主工作区');
  });
});

describe('实体', () => {
  const adr = { title: '状态过滤走 URL', status: 'accepted' };

  it('人工新建与修改都留版本，旧版本基线被拒绝', async () => {
    const res = await post(`/api/workstations/${dev.id}/entities`, { entityType: 'ADR', data: adr });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect((await patch(`/api/entities/${id}`, { data: { ...adr, decision: 'd' }, baseVersion: 1 })).status).toBe(200);
    expect((await patch(`/api/entities/${id}`, { data: adr, baseVersion: 1 })).status).toBe(409);
    const versions = await get<{ version: number }[]>(`/api/entities/${id}/versions`);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('必填、枚举、未知类型都被校验', async () => {
    expect((await post(`/api/workstations/${dev.id}/entities`, { entityType: 'ADR', data: { status: 'accepted' } })).status).toBe(400);
    expect((await post(`/api/workstations/${dev.id}/entities`, { entityType: 'ADR', data: { title: 't', status: 'nope' } })).status).toBe(400);
    expect((await post(`/api/workstations/${dev.id}/entities`, { entityType: 'Ghost', data: {} })).status).toBe(400);
  });

  it('Agent 的实体提案经人工审阅后落到正确的实体类型', async () => {
    const a = await agentOf('architect');
    const t = await addTask();
    const actor = { type: 'agent' as const, id: a.id };
    const ctx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: t, run: {} as never } as ToolCtx;
    const r = (await executeTool(ctx, 'propose_entity', { entityType: 'ADR', data: adr })) as { proposalId: string };
    expect((await post(`/api/proposals/${r.proposalId}/review`, { decision: 'approve', summary: 'ok' })).status).toBe(200);
    const rows = await db.select().from(entity).where(eq(entity.workstationId, dev.id));
    expect(rows.map((e) => e.entityType)).toEqual(['ADR']);
    expect((await db.select().from(proposal).where(eq(proposal.id, r.proposalId)))[0]!.status).toBe('approved');
  });

  it('实体提案被要求修改即驳回，不写入实体', async () => {
    const t = await addTask();
    const id = await addProposal({ taskId: t.id, targetType: 'ADR', patchJson: JSON.stringify(adr) });
    expect((await post(`/api/proposals/${id}/review`, { decision: 'request_changes', summary: '不同意' })).status).toBe(200);
    expect(await db.select().from(entity)).toHaveLength(0);
    expect((await db.select().from(proposal).where(eq(proposal.id, id)))[0]!.status).toBe('rejected');
  });
});

describe('提案审阅与合并', () => {
  it('验收没跑完不能审阅代码提案', async () => {
    const t = await addTask({ status: 'submitted', stage: 'test', codeRefJson: '{"worktree":"x"}' });
    const id = await addProposal({ taskId: t.id });
    const res = await post(`/api/proposals/${id}/review`, { decision: 'approve', summary: 'x' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('验收');
    expect((await db.select().from(proposal).where(eq(proposal.id, id)))[0]!.status).toBe('pending');
  });

  it('已合并的提案不能再审阅，未通过的提案不能合并', async () => {
    const t = await addTask({ status: 'reviewing', stage: 'review' });
    const merged = await addProposal({ taskId: t.id, status: 'merged' });
    expect((await post(`/api/proposals/${merged}/review`, { decision: 'approve', summary: 'x' })).status).toBe(409);
    const pending = await addProposal({ taskId: t.id });
    expect((await post(`/api/proposals/${pending}/merge`)).status).toBe(409);
    expect((await post('/api/proposals/ghost/merge')).status).toBe(404);
  });

  it('审阅意见落库并随提案返回，要求修改回到实现阶段', async () => {
    const t = await addTask({ status: 'reviewing', stage: 'review', codeRefJson: '{"worktree":"x"}' });
    const id = await addProposal({ taskId: t.id });
    const res = await post(`/api/proposals/${id}/review`, { decision: 'request_changes', summary: 's', comments: [{ path: 'a.ts', line: 3, body: '改这里' }] });
    expect(res.status).toBe(200);
    const list = await get<{ id: string; comments: { body: string; line: number }[] }[]>(`/api/tasks/${t.id}/proposals`);
    expect(list[0]!.comments[0]).toMatchObject({ body: '改这里', line: 3 });
    const cur = await reload(t.id);
    expect(cur.status).toBe('in_progress');
    expect(cur.stage).toBe('implement');
    expect(await db.select().from(reviewComment)).toHaveLength(1);
  });

  it('合并关闭对应的待审收件箱项', async () => {
    const t = await addTask({ status: 'reviewing', stage: 'merge', codeRefJson: null });
    const id = await addProposal({ taskId: t.id, status: 'approved' });
    await db.insert(inboxItem).values({ id: 'i1', workspaceId: 'default', projectId: 'proj-aw', kind: 'proposal_review', refType: 'proposal', refId: id, status: 'open', createdAt: now() });
    expect((await post(`/api/proposals/${id}/merge`)).status).toBe(200);
    expect((await db.select().from(inboxItem).where(eq(inboxItem.id, 'i1')))[0]!.status).toBe('resolved');
  });

  it('代码任务不能绕过提案直接通过', async () => {
    const t = await addTask({ status: 'reviewing', codeRefJson: '{"worktree":"x"}', acceptanceJson: '[]' });
    const res = await post(`/api/tasks/${t.id}/transition`, { event: 'approve' });
    expect(res.status).toBe(409);
    expect((await reload(t.id)).status).toBe('reviewing');
  });

  it('人工退回走完整流程：计数并回到实现阶段', async () => {
    const t = await addTask({ status: 'reviewing', stage: 'review', codeRefJson: '{"worktree":"x"}' });
    expect((await post(`/api/tasks/${t.id}/transition`, { event: 'send_back' })).status).toBe(200);
    const cur = await reload(t.id);
    expect(cur.status).toBe('in_progress');
    expect(cur.stage).toBe('implement');
    expect(cur.feedbackCount).toBe(1);
  });
});

describe('合并冲突', () => {
  it('告诉人冲突在哪个文件，提案标记为冲突，任务回到实现阶段', async () => {
    const repo = createFixtureRepo();
    const g = (args: string[]) => execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@f.local', ...args], { cwd: repo, stdio: 'pipe' });
    const edit = (text: string, msg: string) => {
      writeFileSync(path.join(repo, 'src/board/index.txt'), text);
      g(['commit', '-am', msg]);
    };
    g(['branch', 'develop']);
    g(['checkout', '-q', '-b', 'aw/conflict']);
    edit('from task\n', 'task');
    g(['checkout', '-q', 'develop']);
    edit('from develop\n', 'develop');
    g(['checkout', '-q', 'main']);
    await patch(`/api/workstations/${dev.id}`, { settings: { repoPath: repo, targetBranch: 'develop', baseBranch: 'main', commands: {} } });

    const t = await addTask({ status: 'reviewing', stage: 'merge', acceptanceJson: '[]', codeRefJson: JSON.stringify({ worktree: path.join(repo, 'wt'), branch: 'aw/conflict', base_sha: 'x' }) });
    const id = await addProposal({ taskId: t.id, status: 'approved' });
    enqueueMerge(db, { type: 'human', id: 'local' }, t.id);
    for (let i = 0; i < 100 && !mergeQueues.get(repo); i++) await new Promise((r) => setTimeout(r, 20));
    await mergeQueues.get(repo)!.onIdle();

    const { thread } = await get<{ thread: { id: string } }>(`/api/tasks/${t.id}/thread`);
    const { message } = await import('../src/db/schema.js');
    const note = (await db.select().from(message).where(eq(message.threadId, thread.id))).map((m) => m.content).join('\n');
    expect(note).toContain('冲突文件：src/board/index.txt');
    expect(note).toContain('CONFLICT');
    expect((await db.select().from(proposal).where(eq(proposal.id, id)))[0]!.status).toBe('conflicted');
    expect(await reload(t.id)).toMatchObject({ status: 'in_progress', stage: 'implement' });
  });
});

describe('任务流转', () => {
  it('派发到本台的上级任务出现在本台任务列表', async () => {
    const parent = await addTask({ workstationId: root.id, status: 'dispatched', assigneeType: 'workstation', assigneeId: dev.id });
    const list = await get<{ id: string }[]>(`/api/workstations/${dev.id}/tasks`);
    expect(list.map((t) => t.id)).toContain(parent.id);
  });

  it('派发时带上的验收命令不再被丢弃', async () => {
    const t = await addTask({ workstationId: root.id, status: 'draft' });
    const res = await post(`/api/tasks/${t.id}/dispatch`, { targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title: 'T', ...INPUT }, acceptance: [{ kind: 'command', run: 'node check.js' }] });
    expect(res.status).toBe(200);
    const runs = (JSON.parse((await reload(t.id)).acceptanceJson!) as { run: string }[]).map((c) => c.run);
    expect(runs).toEqual(['node check.js', 'pnpm build']);
  });

  it('草稿可编辑并重新校验，派发后不可编辑', async () => {
    const created = (await (await post(`/api/workstations/${dev.id}/tasks`, { title: 'A', input: INPUT })).json()) as { id: string };
    expect((await patch(`/api/tasks/${created.id}`, { title: 'B', input: { ...INPUT, module: 'src/x' } })).status).toBe(200);
    const cur = await reload(created.id);
    expect(cur.title).toBe('B');
    expect(JSON.parse(cur.inputJson!)).toMatchObject({ title: 'B', module: 'src/x' });
    expect((await patch(`/api/tasks/${created.id}`, { input: { title: 'B' } })).status).toBe(400);
    await db.update(task).set({ status: 'dispatched' }).where(eq(task.id, created.id));
    expect((await patch(`/api/tasks/${created.id}`, { title: 'C' })).status).toBe(409);
  });

  it('草稿可直接指派本台 Agent，外台 Agent 被拒绝', async () => {
    const t = await addTask({ status: 'draft' });
    const other = (await db.select().from(agent).where(eq(agent.workstationId, root.id)))[0]!;
    expect((await post(`/api/tasks/${t.id}/assign`, { agentId: other.id })).status).toBe(400);
    const a = await agentOf('frontend-dev');
    expect((await post(`/api/tasks/${t.id}/assign`, { agentId: a.id })).status).toBe(200);
    expect(await reload(t.id)).toMatchObject({ status: 'dispatched', assigneeType: 'agent', assigneeId: a.id });
  });

  it('重新派发把反提案落到任务并重新通知目标台', async () => {
    const t = await addTask({
      workstationId: root.id, status: 'countered', assigneeType: 'workstation', assigneeId: dev.id,
      inputJson: JSON.stringify({ title: 'T', module: 'a' }), acceptanceJson: '[]',
      resultJson: JSON.stringify({ reason: 'r', counter: { input: { module: 'b' }, acceptance: [{ kind: 'command', run: 'x' }] } }),
    });
    const assigned: unknown[] = [];
    const off = events.on('task_assigned', (p) => { if (p.targetId === t.id) assigned.push(p); });
    expect((await post(`/api/tasks/${t.id}/transition`, { event: 'redispatch' })).status).toBe(200);
    off();
    const cur = await reload(t.id);
    expect(cur.status).toBe('dispatched');
    expect(JSON.parse(cur.inputJson!)).toMatchObject({ title: 'T', module: 'b' });
    expect(JSON.parse(cur.acceptanceJson!)).toEqual([{ kind: 'command', run: 'x' }]);
    expect(assigned).toHaveLength(1);
  });

  it('被拒绝的任务修改后重派会清空指派', async () => {
    const t = await addTask({ workstationId: root.id, status: 'rejected', assigneeType: 'workstation', assigneeId: dev.id });
    await post(`/api/tasks/${t.id}/transition`, { event: 'revise' });
    expect(await reload(t.id)).toMatchObject({ status: 'draft', assigneeType: null, assigneeId: null });
  });

  it('解除阻塞清掉原因、关闭收件箱并发恢复事件', async () => {
    const t = await addTask({ status: 'blocked', blockedReason: '缺字段' });
    await db.insert(inboxItem).values({ id: 'i1', workspaceId: 'default', projectId: 'proj-aw', kind: 'blocked', refType: 'task', refId: t.id, status: 'open', createdAt: now() });
    const resumed: unknown[] = [];
    const off = events.on('task_resumed', (p) => { resumed.push(p); });
    expect((await post(`/api/tasks/${t.id}/transition`, { event: 'unblock' })).status).toBe(200);
    off();
    expect(await reload(t.id)).toMatchObject({ status: 'in_progress', blockedReason: null });
    expect((await db.select().from(inboxItem).where(eq(inboxItem.id, 'i1')))[0]!.status).toBe('resolved');
    expect(resumed).toHaveLength(1);
  });

  it('取消父任务级联取消未结束的子任务，已完成的不动', async () => {
    const parent = await addTask({ workstationId: root.id, status: 'in_progress' });
    const open = await addTask({ parentId: parent.id, status: 'in_progress' });
    const grand = await addTask({ parentId: open.id, status: 'blocked' });
    const done = await addTask({ parentId: parent.id, status: 'done' });
    await db.insert(inboxItem).values({ id: 'i1', workspaceId: 'default', projectId: 'proj-aw', kind: 'blocked', refType: 'task', refId: grand.id, status: 'open', createdAt: now() });
    expect((await post(`/api/tasks/${parent.id}/transition`, { event: 'cancel' })).status).toBe(200);
    expect((await reload(open.id)).status).toBe('cancelled');
    expect((await reload(grand.id)).status).toBe('cancelled');
    expect((await reload(done.id)).status).toBe('done');
    expect((await db.select().from(inboxItem).where(eq(inboxItem.id, 'i1')))[0]!.status).toBe('resolved');
  });
});

describe('收件箱', () => {
  const add = (values: Partial<typeof inboxItem.$inferInsert> & { kind: string }) =>
    db.insert(inboxItem).values({ id: crypto.randomUUID(), workspaceId: 'default', projectId: 'proj-aw', status: 'open', createdAt: now(), ...values });

  it('条目带任务标题和可读原因，并可按项目过滤', async () => {
    const t = await addTask({ title: '筛选', status: 'blocked', blockedReason: '缺字段' });
    await add({ kind: 'blocked', refType: 'task', refId: t.id });
    await add({ kind: 'command_confirm', refType: 'task', refId: t.id, payloadJson: JSON.stringify({ command: 'git push', cwd: '/w' }) });
    const items = await get<{ kind: string; taskTitle: string; detail: string; command: string }[]>('/api/inbox?projectId=proj-aw');
    expect(items.find((i) => i.kind === 'blocked')).toMatchObject({ taskTitle: '筛选', detail: '缺字段' });
    expect(items.find((i) => i.kind === 'command_confirm')!.command).toBe('git push');
    expect(await get<unknown[]>('/api/inbox?projectId=ghost')).toEqual([]);
  });

  it('项目缺失的旧条目通过任务归属到项目', async () => {
    const t = await addTask();
    await db.insert(run).values({ id: 'r1', taskId: t.id, status: 'interrupted', stopReason: 'interrupted', startedAt: now() });
    await add({ kind: 'run_failed', refType: 'run', refId: 'r1', projectId: null });
    const items = await get<{ taskId: string; runId: string }[]>('/api/inbox?projectId=proj-aw');
    expect(items[0]).toMatchObject({ taskId: t.id, runId: 'r1' });
  });

  it('在收件箱解除阻塞即流转任务', async () => {
    const t = await addTask({ status: 'blocked', blockedReason: 'x' });
    await add({ id: 'i1', kind: 'blocked', refType: 'task', refId: t.id });
    expect((await post('/api/inbox/i1/resolve', { action: 'unblock' })).status).toBe(200);
    expect((await reload(t.id)).status).toBe('in_progress');
    expect((await post('/api/inbox/i1/resolve', {})).status).toBe(404);
  });

  it('回复人工请求写入任务线程并让提问的 Agent 继续', async () => {
    const a = await agentOf('frontend-dev');
    const t = await addTask({ assigneeType: 'agent', assigneeId: a.id });
    await add({ id: 'i1', kind: 'human_request', refType: 'task', refId: t.id, payloadJson: JSON.stringify({ question: '用哪个？', agentId: a.id }) });
    expect((await post('/api/inbox/i1/resolve', { answer: '用 URL 参数' })).status).toBe(200);
    await scheduler.idle();
    const { thread } = await get<{ thread: { id: string } }>(`/api/tasks/${t.id}/thread`);
    const { message } = await import('../src/db/schema.js');
    const msgs = await db.select().from(message).where(eq(message.threadId, thread.id));
    expect(msgs.some((m) => m.content === '用 URL 参数' && m.senderType === 'human')).toBe(true);
    const runs = await db.select().from(run).where(eq(run.taskId, t.id));
    expect(runs.map((r) => r.trigger)).toContain('human_reply');
  });

  it('失败的 run 可以重试，阻塞的任务先解除', async () => {
    const a = await agentOf('reviewer');
    const t = await addTask({ status: 'blocked', blockedReason: 'x' });
    await db.insert(run).values({ id: 'r1', agentId: a.id, taskId: t.id, status: 'error', stopReason: 'error', startedAt: now() });
    await add({ id: 'i1', kind: 'run_failed', refType: 'run', refId: 'r1' });
    expect((await post('/api/inbox/i1/resolve', { action: 'retry' })).status).toBe(200);
    await scheduler.idle();
    const runs = await db.select().from(run).where(eq(run.taskId, t.id));
    expect(runs.map((r) => r.trigger)).toContain('retry');
    expect((await reload(t.id)).blockedReason).toBeNull();
  });
});

describe('Agent 编制', () => {
  it('工具只能在模板范围内收窄', async () => {
    const a = await agentOf('reviewer');
    expect((await patch(`/api/agents/${a.id}`, { tools: ['git_diff', 'run_command'] })).status).toBe(400);
    expect((await patch(`/api/agents/${a.id}`, { tools: ['git_diff'] })).status).toBe(200);
    expect(JSON.parse((await agentOf('reviewer')).toolsJson!)).toEqual(['git_diff']);
  });

  it('暂停的 Agent 不接受触发，恢复后可运行', async () => {
    const a = await agentOf('reviewer');
    const t = await addTask();
    await patch(`/api/agents/${a.id}`, { status: 'paused' });
    const res = await post(`/api/agents/${a.id}/run`, { taskId: t.id });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('暂停');
    await patch(`/api/agents/${a.id}`, { status: 'active' });
    expect((await post(`/api/agents/${a.id}/run`, { taskId: t.id })).status).toBe(201);
    await scheduler.idle();
  });

  it('提示词可覆盖，清空后回到模板', async () => {
    const a = await agentOf('architect');
    const file = a.prompt;
    await patch(`/api/agents/${a.id}`, { prompt: '自定义' });
    expect((await agentOf('architect')).prompt).toBe('自定义');
    await patch(`/api/agents/${a.id}`, { prompt: '' });
    expect((await agentOf('architect')).prompt).toBe(file);
  });

  it('模型列表不泄露密钥', async () => {
    const r = await get<{ models: Record<string, unknown>[] }>('/api/models');
    expect(r.models.some((m) => m.id === 'mock:scripted')).toBe(true);
    expect(Object.keys(r.models[0]!)).toEqual(['id', 'local']);
  });
});

describe('运行', () => {
  async function hangingRun() {
    const a = await agentOf('architect');
    const t = await addTask();
    await db.insert(run).values({ id: 'r1', agentId: a.id, taskId: t.id, status: 'running', provider: 'mock', model: 't', startedAt: now(), tokensIn: 0, tokensOut: 0, traceJson: '[]' });
    const runRow = (await db.select().from(run).where(eq(run.id, 'r1')))[0]!;
    const actor = { type: 'agent' as const, id: a.id };
    const ctx = { db, actor, permCtx: await buildPermCtx(actor, db), agent: a, task: t, run: runRow } as ToolCtx;
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 't',
      doGenerate: ({ abortSignal }) => new Promise((_, reject) => { abortSignal?.addEventListener('abort', () => reject(new Error('aborted'))); }),
    });
    const done = runAgent({ db, ctx, route: { id: 'mock:t', model: model as never, supportsParallelTools: true }, system: 's', messages: [{ role: 'user', content: 'hi' }], agentRow: a, taskRow: t });
    return { done, t };
  }

  it('取消中止模型调用，不进收件箱', async () => {
    const { done } = await hangingRun();
    await new Promise((r) => setTimeout(r, 20));
    expect((await post('/api/runs/r1/cancel')).status).toBe(200);
    expect((await done).stopReason).toBe('cancelled');
    expect((await db.select().from(run).where(eq(run.id, 'r1')))[0]).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
    expect(await db.select().from(inboxItem)).toHaveLength(0);
    expect(cancelRun('r1')).toBe(false);
  });

  it('取消任务时一并中止在跑的 run', async () => {
    const { done, t } = await hangingRun();
    await new Promise((r) => setTimeout(r, 20));
    await post(`/api/tasks/${t.id}/transition`, { event: 'cancel' });
    expect((await done).stopReason).toBe('cancelled');
  });

  it('已结束的 run 不能取消，孤儿 run 直接收尾', async () => {
    const t = await addTask();
    await db.insert(run).values([
      { id: 'done', taskId: t.id, status: 'completed', startedAt: now() },
      { id: 'orphan', taskId: t.id, status: 'running', startedAt: now() },
    ]);
    expect((await post('/api/runs/done/cancel')).status).toBe(409);
    expect((await post('/api/runs/orphan/cancel')).status).toBe(200);
    expect((await db.select().from(run).where(eq(run.id, 'orphan')))[0]!.status).toBe('cancelled');
    expect((await post('/api/runs/ghost/cancel')).status).toBe(404);
  });

  it('列表不带 trace，按时间倒序并附带名字', async () => {
    const a = await agentOf('architect');
    const t = await addTask({ title: '任务名' });
    await db.insert(run).values([
      { id: 'old', agentId: a.id, taskId: t.id, status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', traceJson: '[1]' },
      { id: 'new', agentId: a.id, taskId: t.id, status: 'completed', startedAt: '2026-02-01T00:00:00.000Z', traceJson: '[2]' },
    ]);
    const list = await get<{ id: string; agentName: string; taskTitle: string; traceJson?: string }[]>('/api/projects/proj-aw/runs');
    expect(list.map((r) => r.id)).toEqual(['new', 'old']);
    expect(list[0]).toMatchObject({ agentName: a.name, taskTitle: '任务名' });
    expect(list[0]!.traceJson).toBeUndefined();
  });
});

describe('实时变更流', () => {
  it('只推动作名，断开后摘掉监听器', async () => {
    const res = await app.request('/api/stream');
    const reader = res.body!.getReader();
    const decode = new TextDecoder();
    const t = await addTask({ status: 'blocked' });
    await reader.read();
    await post(`/api/tasks/${t.id}/transition`, { event: 'unblock' });
    let text = '';
    while (!text.includes('task_status_changed')) text += decode.decode((await reader.read()).value);
    expect(text).toContain(`"targetId":"${t.id}"`);
    await reader.cancel();
  });
});

describe('会话', () => {
  it('向不存在的线程发消息返回 404', async () => {
    expect((await post('/api/threads/ghost/messages', { content: 'x' })).status).toBe(404);
  });
  it('不存在的工作台没有讨论线程', async () => {
    expect((await app.request('/api/workstations/ghost/thread')).status).toBe(404);
  });
});
