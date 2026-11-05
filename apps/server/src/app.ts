import type { Actor } from '@aw/domain';
import { TASK_EVENTS } from '@aw/domain';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { DB } from './db/client.js';
import {
  createTask,
  getProjectDetail,
  listProjects,
  listTasks,
  transitionTask,
} from './repositories/index.js';

type Env = { Variables: { actor: Actor; db: DB } };

const createTaskSchema = z.object({
  title: z.string().min(1),
  intent: z.string().optional(),
  module: z.string().optional(),
});

const transitionSchema = z.object({
  event: z.enum(TASK_EVENTS),
});

export function createApp(db: DB) {
  const app = new Hono<Env>();
  const api = app.basePath('/api');

  api.use('*', async (c, next) => {
    // M0.1 actor 固定为本地用户；M0.2 改为从会话/令牌解析
    c.set('actor', { type: 'human', id: 'local' });
    c.set('db', db);
    await next();
  });

  const routes = api
    .get('/health', (c) => c.json({ ok: true }))
    .get('/projects', async (c) => {
      const projects = await listProjects(c.get('actor'), c.get('db'));
      return c.json(projects);
    })
    .get('/projects/:id', async (c) => {
      const detail = await getProjectDetail(c.get('actor'), c.get('db'), c.req.param('id'));
      if (!detail) return c.json({ error: '项目不存在' }, 404);
      return c.json(detail);
    })
    .get('/workstations/:id/tasks', async (c) => {
      const tasks = await listTasks(c.get('actor'), c.get('db'), c.req.param('id'));
      return c.json(tasks);
    })
    .post('/workstations/:id/tasks', zValidator('json', createTaskSchema), async (c) => {
      const body = c.req.valid('json');
      const created = await createTask(c.get('actor'), c.get('db'), c.req.param('id'), body);
      if (!created) return c.json({ error: '工作台不存在' }, 404);
      return c.json(created, 201);
    })
    .post('/tasks/:id/transition', zValidator('json', transitionSchema), async (c) => {
      const { event } = c.req.valid('json');
      const result = await transitionTask(c.get('actor'), c.get('db'), c.req.param('id'), event);
      if (result.kind === 'not_found') return c.json({ error: '任务不存在' }, 404);
      if (result.kind === 'invalid') return c.json({ error: result.error }, 409);
      if (result.kind === 'conflict') {
        return c.json({ error: '任务状态已变化，请刷新后重试' }, 409);
      }
      return c.json(result.task);
    });

  return { app, routes };
}

export type AppType = ReturnType<typeof createApp>['routes'];
