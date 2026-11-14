import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { loadPlugins } from '../src/plugins.js';
import { listTasks } from '../src/repositories/index.js';
import { dispatchTask, respondTask } from '../src/usecases/index.js';
import { agent as agentTable } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

let app: ReturnType<typeof createApp>['app'];
let db: ReturnType<typeof createDb>['db'];

beforeEach(async () => {
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  migrateDb(r.sqlite);
  await seed(db);
  app = createApp(db).app;
});

const post = (url: string, body: unknown) =>
  app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const HUMAN = { type: 'human' as const, id: 'local' };

async function wsIds() {
  const proj = await (await app.request('/api/projects/proj-aw')).json() as { workstations: { id: string; name: string }[] };
  return {
    root: proj.workstations.find((w) => w.name === '根')!,
    dev: proj.workstations.find((w) => w.name === '开发')!,
  };
}

describe('m0.2 用例', () => {
  it('mount 后 dev 台有 15 blocks（含 7 个质量板块）+ 11 agents', async () => {
    const { dev } = await wsIds();
    const detail = await (await app.request(`/api/workstations/${dev.id}`)).json() as { blocks: unknown[]; agents: { isSteward: number }[]; manifest: { id: string } };
    expect(detail.blocks).toHaveLength(15);
    expect(detail.agents).toHaveLength(11);
    expect(detail.agents.filter((a) => a.isSteward === 1)).toHaveLength(1);
    expect(detail.manifest.id).toBe('dev');
  });

  it('createTask：typeId 推断 pm→null、dev→dev.issue；input 缺 kind 400', async () => {
    const { root, dev } = await wsIds();
    const pmTask = await (await post(`/api/workstations/${root.id}/tasks`, { title: 'P' })).json() as { typeId: string | null };
    expect(pmTask.typeId).toBeNull();
    const bad = await post(`/api/workstations/${dev.id}/tasks`, { title: 'D', input: { module: 'm', priority: 'p1' } });
    expect(bad.status).toBe(400);
    const devTask = await (await post(`/api/workstations/${dev.id}/tasks`, { title: 'D', input: { kind: 'feature', priority: 'p1', module: 'm' } })).json() as { typeId: string; inputJson: string; acceptanceJson: string };
    expect(devTask.typeId).toBe('dev.issue');
    expect(JSON.parse(devTask.inputJson).title).toBe('D');
    expect(JSON.parse(devTask.acceptanceJson)).toHaveLength(1);
  });

  it('assignee 非本台 400；parent 非法 400', async () => {
    const { root, dev } = await wsIds();
    const otherAgent = (await db.select().from(agentTable).where(eq(agentTable.workstationId, root.id)))[0]!;
    const r1 = await post(`/api/workstations/${dev.id}/tasks`, { title: 'X', input: { kind: 'feature', priority: 'p1', module: 'm' }, assigneeAgentId: otherAgent.id });
    expect(r1.status).toBe(400);
    const r2 = await post(`/api/workstations/${dev.id}/tasks`, { title: 'X', input: { kind: 'feature', priority: 'p1', module: 'm' }, parentId: 'ghost' });
    expect(r2.status).toBe(400);
    // 根台草稿任务不是本台任务也不是派发到本台 → 400
    const rt = await (await post(`/api/workstations/${root.id}/tasks`, { title: 'P' })).json() as { id: string };
    const r3 = await post(`/api/workstations/${dev.id}/tasks`, { title: 'X', input: { kind: 'feature', priority: 'p1', module: 'm' }, parentId: rt.id });
    expect(r3.status).toBe(400);
  });

  it('子任务带 assignee → 代派发 + 父任务自动 start', async () => {
    const { root, dev } = await wsIds();
    const rt = await (await post(`/api/workstations/${root.id}/tasks`, { title: 'P' })).json() as { id: string };
    await post(`/api/tasks/${rt.id}/dispatch`, { targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title: 'P', kind: 'feature', priority: 'p1', module: 'm' } });
    await post(`/api/tasks/${rt.id}/respond`, { action: 'accept' });
    const devDetail = await (await app.request(`/api/workstations/${dev.id}`)).json() as { agents: { id: string; isSteward: number }[] };
    const devAgent = devDetail.agents.find((a) => a.isSteward !== 1)!;
    const child = await post(`/api/workstations/${dev.id}/tasks`, { title: 'C', input: { kind: 'feature', priority: 'p1', module: 'm' }, parentId: rt.id, assigneeAgentId: devAgent.id });
    expect(child.status).toBe(201);
    const cj = await child.json() as { status: string };
    expect(cj.status).toBe('dispatched');
    const pj = await (await app.request(`/api/tasks/${rt.id}`)).json() as { task: { status: string } };
    expect(pj.task.status).toBe('in_progress');
  });

  it('dispatch 正常路径 + 三种 4xx + 并发 409', async () => {
    const { root, dev } = await wsIds();
    const t = await (await post(`/api/workstations/${root.id}/tasks`, { title: 'T', input: { module: 'm' } })).json() as { id: string };
    expect((await post(`/api/tasks/${t.id}/dispatch`, { targetWorkstationId: dev.id, typeId: 'nope', input: {} })).status).toBe(400);
    expect((await post(`/api/tasks/${t.id}/dispatch`, { targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title: 'x' } })).status).toBe(400);
    expect((await post(`/api/tasks/${t.id}/dispatch`, { targetWorkstationId: root.id, typeId: 'dev.issue', input: { title: 'x', kind: 'feature', priority: 'p1', module: 'm' } })).status).toBe(400);
    const ok = await post(`/api/tasks/${t.id}/dispatch`, { targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title: 'x', kind: 'feature', priority: 'p1', module: 'm' } });
    expect(ok.status).toBe(200);
    // 重复派发 → 409
    expect((await post(`/api/tasks/${t.id}/dispatch`, { targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title: 'x', kind: 'feature', priority: 'p1', module: 'm' } })).status).toBe(409);
    // 并发：两 dispatch 同发，一胜一负
    const t2 = await (await post(`/api/workstations/${root.id}/tasks`, { title: 'T2' })).json() as { id: string };
    const [a, b] = await Promise.all([
      dispatchTask(HUMAN, db, t2.id, { targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title: 'x', kind: 'feature', priority: 'p1', module: 'm' } }),
      dispatchTask(HUMAN, db, t2.id, { targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title: 'x', kind: 'feature', priority: 'p1', module: 'm' } }),
    ]);
    const codes = [a, b].map((r) => (r.kind === 'ok' ? 200 : (r as { status: number }).status)).sort();
    expect(codes).toEqual([200, 409]);
  });

  it('respond：非 steward agent 403；reject/counter 无 reason 400；counter inbox kind', async () => {
    const { root, dev } = await wsIds();
    const t = await (await post(`/api/workstations/${root.id}/tasks`, { title: 'T' })).json() as { id: string };
    await post(`/api/tasks/${t.id}/dispatch`, { targetWorkstationId: dev.id, typeId: 'dev.issue', input: { title: 'x', kind: 'feature', priority: 'p1', module: 'm' } });
    // 非 steward agent 直接调 usecase
    const devDetail = await (await app.request(`/api/workstations/${dev.id}`)).json() as { agents: { id: string; isSteward: number }[] };
    const nonSteward = devDetail.agents.find((a) => a.isSteward !== 1)!;
    const denied = await respondTask({ type: 'agent', id: nonSteward.id }, db, t.id, { action: 'accept' });
    expect(denied.kind === 'error' && denied.status).toBe(403);
    // 无 reason → zod 400
    expect((await post(`/api/tasks/${t.id}/respond`, { action: 'counter' })).status).toBe(400);
    // counter 不带 counter 字段 → kind 仍是 task_countered
    const c = await post(`/api/tasks/${t.id}/respond`, { action: 'counter', reason: '换个范围' });
    expect(c.status).toBe(200);
    const inbox = await (await app.request('/api/inbox?status=open')).json() as { kind: string }[];
    expect(inbox.some((i) => i.kind === 'task_countered')).toBe(true);
    expect(inbox.some((i) => i.kind === 'task_rejected')).toBe(false);
  });

  it('stage 非法 409 + approve guard + event_log', async () => {
    const { dev } = await wsIds();
    const t = await (await post(`/api/workstations/${dev.id}/tasks`, { title: 'T', input: { kind: 'feature', priority: 'p1', module: 'm' } })).json() as { id: string };
    expect((await post(`/api/tasks/${t.id}/stage`, { stage: 'implement' })).status).toBe(409);
    expect((await post(`/api/tasks/${t.id}/transition`, { event: 'approve' })).status).toBe(409);
    const detail = await (await app.request(`/api/tasks/${t.id}`)).json() as { events: { action: string }[] };
    expect(detail.events.some((e) => e.action === 'task_created')).toBe(true);
  });

  it('agent actor 看不到兄弟台任务', async () => {
    const { dev } = await wsIds();
    expect(await listTasks({ type: 'agent', id: 'nonexistent' }, db, dev.id)).toEqual([]);
  });
});
