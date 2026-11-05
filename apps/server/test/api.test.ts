import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, migrateDb } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';

let app: ReturnType<typeof createApp>['app'];

beforeAll(async () => {
  const { db, sqlite } = createDb(':memory:');
  migrateDb(sqlite);
  await seed(db);
  app = createApp(db).app;
});

describe('api', () => {
  it('GET /api/health', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /api/projects 返回种子项目', async () => {
    const res = await app.request('/api/projects');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string }>;
    expect(body.some((p) => p.name === 'Agent Workstation')).toBe(true);
  });

  it('GET /api/projects/:id 返回工作台树', async () => {
    const res = await app.request('/api/projects/proj-aw');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workstations: Array<{ parentId: string | null }> };
    expect(body.workstations.some((w) => w.parentId === null)).toBe(true);
    expect(body.workstations.some((w) => w.parentId === 'ws-root')).toBe(true);
  });

  it('POST 创建任务 → 合法转移 → 非法转移 409 → 校验失败 400', async () => {
    const created = await app.request('/api/workstations/ws-dev/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '测试任务', module: 'apps/web/src/components/board/' }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string; status: string };
    expect(task.status).toBe('draft');

    const ok = await app.request(`/api/tasks/${task.id}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'dispatch' }),
    });
    expect(ok.status).toBe(200);

    const bad = await app.request(`/api/tasks/${task.id}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'dispatch' }),
    });
    expect(bad.status).toBe(409);

    const invalid = await app.request('/api/workstations/ws-dev/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(invalid.status).toBe(400);
  });

  it('并发：转移成功后，用旧状态发同一事件被拒绝', async () => {
    const created = await app.request('/api/workstations/ws-dev/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '并发任务' }),
    });
    const task = (await created.json()) as { id: string };

    // 两个「并发」转移：第一个胜出，第二个基于旧状态应被拒
    const [a, b] = await Promise.all([
      app.request(`/api/tasks/${task.id}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'dispatch' }),
      }),
      app.request(`/api/tasks/${task.id}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'cancel' }),
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    if (a.status === 409 && b.status === 409) throw new Error('不应双输');
    // 失败方若是非法转移也是 409；若是已合法转移后的重复事件同样是 409
    expect((await loser.json()) as { error: string }).toHaveProperty('error');
  });
});
