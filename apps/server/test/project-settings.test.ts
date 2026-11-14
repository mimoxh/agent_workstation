import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { createDb, migrateDb } from '../src/db/client.js';
import { agent, artifact, entity, inboxItem, knowledgeChunk, knowledgeSource, message, project, run, task, thread, workstation } from '../src/db/schema.js';
import { seed } from '../src/db/seed.js';
import { loadPlugins } from '../src/plugins.js';
import { listInbox, listProjects } from '../src/repositories/index.js';
import { triggerRun } from '../src/runtime/scheduler.js';

let app: ReturnType<typeof createApp>['app'];
let db: ReturnType<typeof createDb>['db'];
let sqlite: ReturnType<typeof createDb>['sqlite'];
const HUMAN = { type: 'human' as const, id: 'local' };

beforeEach(async () => {
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  sqlite = r.sqlite;
  migrateDb(r.sqlite);
  await seed(db);
  app = createApp(db).app;
});

const send = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function devWs() {
  return (await db.select().from(workstation).where(eq(workstation.projectId, 'proj-aw'))).find((w) => w.pluginId === 'dev')!;
}

describe('项目设置', () => {
  it('改名与目标；空名 400；目标留空清除', async () => {
    expect((await send('PATCH', '/api/projects/proj-aw', { name: '新名字', goal: '  做完 M1  ' })).status).toBe(200);
    let p = (await db.select().from(project).where(eq(project.id, 'proj-aw')))[0]!;
    expect(p).toMatchObject({ name: '新名字', goal: '做完 M1' });
    expect((await send('PATCH', '/api/projects/proj-aw', { name: '   ' })).status).toBe(400);
    await send('PATCH', '/api/projects/proj-aw', { goal: '' });
    p = (await db.select().from(project).where(eq(project.id, 'proj-aw')))[0]!;
    expect(p).toMatchObject({ name: '新名字', goal: null });
    expect((await send('PATCH', '/api/projects/nope', { name: 'x' })).status).toBe(404);
  });

  it('归档：Agent 不再起 run，跨项目收件箱隐去；恢复后照常', async () => {
    const dev = await devWs();
    const t = (await (await send('POST', `/api/workstations/${dev.id}/tasks`, { title: 'T', input: { kind: 'feature', priority: 'p1', module: 'm' } })).json()) as { id: string };
    const a = (await db.select().from(agent).where(eq(agent.workstationId, dev.id)))[0]!;
    await db.insert(inboxItem).values({ id: 'ib-1', workspaceId: 'default', projectId: 'proj-aw', kind: 'human_request', status: 'open', createdAt: new Date().toISOString() });

    expect((await send('POST', '/api/projects/proj-aw/archive')).status).toBe(200);
    expect((await listProjects(HUMAN, db)).find((p) => p.id === 'proj-aw')?.status).toBe('archived');
    expect(await triggerRun(db, a.id, t.id, 'manual')).toMatchObject({ ok: false, error: '项目已归档' });
    expect((await listInbox(HUMAN, db)).some((i) => i.id === 'ib-1')).toBe(false);
    expect((await listInbox(HUMAN, db, 'open', 'proj-aw')).some((i) => i.id === 'ib-1')).toBe(true);

    expect((await send('POST', '/api/projects/proj-aw/restore')).status).toBe(200);
    expect((await listProjects(HUMAN, db)).find((p) => p.id === 'proj-aw')?.status).toBe('active');
    expect((await listInbox(HUMAN, db)).some((i) => i.id === 'ib-1')).toBe(true);
  });

  it('删除：未归档 409；归档后连同全部数据删掉，别的项目不受影响', async () => {
    const other = (await (await send('POST', '/api/projects', { name: '别的项目' })).json()) as { id: string; rootWorkstationId: string };
    await send('POST', `/api/workstations/${other.rootWorkstationId}/tasks`, { title: '别的任务' });

    const dev = await devWs();
    const parent = (await (await send('POST', `/api/workstations/${dev.id}/tasks`, { title: 'P', input: { kind: 'feature', priority: 'p1', module: 'm' } })).json()) as { id: string };
    expect((await send('POST', `/api/workstations/${dev.id}/tasks`, { title: 'C', parentId: parent.id, input: { kind: 'feature', priority: 'p1', module: 'm' } })).status).toBe(201);
    const a = (await db.select().from(agent).where(eq(agent.workstationId, dev.id)))[0]!;
    const now = new Date().toISOString();
    await db.insert(run).values({ id: 'run-1', agentId: a.id, taskId: parent.id, status: 'completed', startedAt: now });
    await db.insert(artifact).values({ id: 'art-1', workstationId: dev.id, taskId: parent.id, type: 'log', createdAt: now });
    await db.insert(inboxItem).values({ id: 'ib-2', workspaceId: 'default', projectId: 'proj-aw', kind: 'blocked', refType: 'task', refId: parent.id, createdAt: now });
    expect((await send('POST', '/api/projects/proj-aw/knowledge', { name: '规范', content: '# 标题\n正文内容足够长', kind: 'note' })).status).toBe(201);
    expect((await send('POST', `/api/workstations/${dev.id}/conversations`, { agentIds: [a.id], title: '讨论' })).status).toBe(201);
    expect((await db.select().from(thread)).length).toBeGreaterThan(0);
    expect((await db.select().from(knowledgeChunk)).length).toBeGreaterThan(0);

    expect((await send('DELETE', '/api/projects/proj-aw')).status).toBe(409);
    await send('POST', '/api/projects/proj-aw/archive');
    const del = await send('DELETE', '/api/projects/proj-aw');
    expect(del.status).toBe(200);

    expect(await db.select().from(project).where(eq(project.id, 'proj-aw'))).toHaveLength(0);
    expect(await db.select().from(workstation).where(eq(workstation.projectId, 'proj-aw'))).toHaveLength(0);
    expect(await db.select().from(task).where(eq(task.projectId, 'proj-aw'))).toHaveLength(0);
    expect(await db.select().from(run)).toHaveLength(0);
    expect(await db.select().from(artifact)).toHaveLength(0);
    expect(await db.select().from(knowledgeSource)).toHaveLength(0);
    expect(await db.select().from(knowledgeChunk)).toHaveLength(0);
    expect(sqlite.prepare('SELECT count(*) AS n FROM knowledge_fts').get()).toEqual({ n: 0 });
    expect(await db.select().from(inboxItem).where(eq(inboxItem.projectId, 'proj-aw'))).toHaveLength(0);
    const wsIds = new Set((await db.select().from(workstation)).map((w) => w.id));
    expect((await db.select().from(agent)).every((x) => wsIds.has(x.workstationId))).toBe(true);
    expect((await db.select().from(entity)).every((x) => wsIds.has(x.workstationId))).toBe(true);
    const threads = await db.select().from(thread);
    expect((await db.select().from(message)).every((m) => threads.some((th) => th.id === m.threadId))).toBe(true);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // 别的项目原样
    expect((await (await app.request(`/api/projects/${other.id}`)).json()) as { name: string }).toMatchObject({ name: '别的项目' });
    expect(await db.select().from(task).where(eq(task.projectId, other.id))).toHaveLength(1);
    expect((await send('DELETE', '/api/projects/proj-aw')).status).toBe(404);
  });
});
