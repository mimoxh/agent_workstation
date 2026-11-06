import type { Actor } from '@aw/domain';
import { TASK_EVENTS } from '@aw/domain';
import { zValidator } from '@hono/zod-validator';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { eq } from 'drizzle-orm';
import { agent, entity, message, proposal, reviewComment, run, task, workstation } from './db/schema.js';
import { listProposals } from './repositories/index.js';
import { events } from './events.js';
import { devSettings } from './runtime/git.js';
import { decideProposal } from './usecases/proposals.js';
import { postThreadMessage, taskThreadOf, wsThreadOf } from './usecases/threads.js';
import { Hono } from 'hono';
import { z } from 'zod';
import type { DB } from './db/client.js';
import {
  getProjectDetail,
  getTaskDetail,
  getWorkstationDetail,
  listInbox,
  listProjects,
  listTasks,
} from './repositories/index.js';
import {
  addAgentInstance,
  createTaskUc,
  dispatchTask,
  respondTask,
  resolveInbox,
  setStage,
  transitionTaskUc,
} from './usecases/index.js';

type Env = { Variables: { actor: Actor; db: DB } };

const jsonRecord = z.record(z.string(), z.unknown());

// 挂住 SSE 连接直到客户端断开或主动 close，退出时摘掉本连接的全部监听器
async function holdSSE(stream: SSEStreamingApi, subscribe: (close: () => void) => (() => void)[]) {
  let close = () => {};
  const closed = new Promise<void>((resolve) => { close = resolve; });
  const offs = subscribe(close);
  stream.onAbort(close);
  if (stream.aborted) close();
  await closed;
  for (const off of offs) off();
}

export function createApp(db: DB) {
  const app = new Hono<Env>();
  const api = app.basePath('/api');

  api.use('*', async (c, next) => {
    c.set('actor', { type: 'human', id: 'local' });
    c.set('db', db);
    await next();
  });

  const err = (c: { json: (o: unknown, s?: number) => Response }, status: number, error: string) =>
    c.json({ error }, status as never);

  const routes = api
    .get('/health', (c) => c.json({ ok: true }))
    .get('/projects', async (c) => c.json(await listProjects(c.get('actor'), c.get('db'))))
    .get('/projects/:id', async (c) => {
      const d = await getProjectDetail(c.get('actor'), c.get('db'), c.req.param('id'));
      return d ? c.json(d) : c.json({ error: '项目不存在' }, 404);
    })
    .get('/workstations/:id', async (c) => {
      const d = await getWorkstationDetail(c.get('actor'), c.get('db'), c.req.param('id'));
      return d ? c.json(d) : c.json({ error: '工作台不存在' }, 404);
    })
    .post(
      '/workstations/:id/agents',
      zValidator('json', z.object({ templateId: z.string().min(1) })),
      async (c) => {
        const r = await addAgentInstance(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').templateId);
        if (r.kind === 'not_found') return c.json({ error: '工作台不存在' }, 404);
        if (r.kind === 'error') return c.json({ error: r.error }, 400);
        return c.json({ ok: true }, 201);
      },
    )
    .get('/workstations/:id/tasks', async (c) =>
      c.json(await listTasks(c.get('actor'), c.get('db'), c.req.param('id'))),
    )
    .post(
      '/workstations/:id/tasks',
      zValidator(
        'json',
        z.object({
          title: z.string().min(1),
          intent: z.string().optional(),
          typeId: z.string().optional(),
          input: jsonRecord.optional(),
          acceptance: z.array(jsonRecord).optional(),
          parentId: z.string().optional(),
          assigneeAgentId: z.string().optional(),
        }),
      ),
      async (c) => {
        const r = await createTaskUc(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
        if (r.kind !== 'ok') {
          return c.json({ error: (r as { error?: string }).error ?? '失败' }, (((r as { status?: number }).status ?? 400) as never));
        }
        return c.json(r.task, 201);
      },
    )
    .get('/tasks/:id', async (c) => {
      const d = await getTaskDetail(c.get('actor'), c.get('db'), c.req.param('id'));
      return d ? c.json(d) : c.json({ error: '任务不存在' }, 404);
    })
    .post(
      '/tasks/:id/dispatch',
      zValidator(
        'json',
        z.object({
          targetWorkstationId: z.string().min(1),
          typeId: z.string().min(1),
          input: jsonRecord,
          reason: z.string().optional(),
        }),
      ),
      async (c) => {
        const r = await dispatchTask(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
        if (r.kind === 'ok') return c.json(r.task);
        return err(c, r.status, (r as { error?: string }).error ?? '失败');
      },
    )
    .post(
      '/tasks/:id/respond',
      zValidator(
        'json',
        z
          .object({
            action: z.enum(['accept', 'reject', 'counter']),
            reason: z.string().optional(),
            counter: z.object({ input: jsonRecord.optional(), acceptance: z.array(jsonRecord).optional() }).optional(),
          })
          .refine((b) => b.action === 'accept' || (b.reason !== undefined && b.reason.trim().length > 0), {
            message: 'reject / counter 必须给出 reason',
          }),
      ),
      async (c) => {
        const r = await respondTask(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
        if (r.kind === 'ok') return c.json(r.task);
        return err(c, r.status, (r as { error?: string }).error ?? '失败');
      },
    )
    .post(
      '/tasks/:id/stage',
      zValidator('json', z.object({ stage: z.string().min(1) })),
      async (c) => {
        const r = await setStage(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').stage);
        if (r.kind === 'ok') return c.json(r.task);
        return err(c, r.status, (r as { error?: string }).error ?? '失败');
      },
    )
    .post(
      '/tasks/:id/transition',
      zValidator('json', z.object({ event: z.enum(TASK_EVENTS) })),
      async (c) => {
        const r = await transitionTaskUc(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').event);
        if (r.kind === 'ok') return c.json(r.task);
        return err(
          c,
          r.status,
          r.kind === 'conflict' ? '任务状态已变化，请刷新后重试' : ((r as { error?: string }).error ?? '失败'),
        );
      },
    )
    .get('/inbox', async (c) => c.json(await listInbox(c.get('actor'), c.get('db'), c.req.query('status') ?? 'open')))
    .post(
      '/inbox/:id/resolve',
      zValidator('json', z.object({ resolution: z.string().optional(), decision: z.enum(['approve','deny']).optional() })),
      async (c) => {
        const r = await resolveInbox(c.get('actor'), c.get('db'), c.req.param('id'), JSON.stringify({ resolution: c.req.valid('json').resolution, decision: c.req.valid('json').decision }));
        if (r.kind === 'not_found') return c.json({ error: '条目不存在' }, 404);
        return c.json({ ok: true });
      },
    )

    .get('/workstations/:id/proposals', async (c) => c.json(await listProposals(c.get('actor'), c.get('db'), c.req.param('id'))))
    .post('/proposals/:id/approve', async (c) => { const r = await decideProposal(c.get('actor'), c.get('db'), c.req.param('id'), 'approve'); if (r.kind === 'ok') return c.json({ ok: true }); return c.json({ error: (r as { error?: string }).error ?? '失败' }, ((r as { status?: number }).status ?? 400) as never); })
    .post('/proposals/:id/reject', zValidator('json', z.object({ reason: z.string().optional() })), async (c) => { const r = await decideProposal(c.get('actor'), c.get('db'), c.req.param('id'), 'reject', c.req.valid('json').reason); if (r.kind === 'ok') return c.json({ ok: true }); return c.json({ error: (r as { error?: string }).error ?? '失败' }, ((r as { status?: number }).status ?? 400) as never); })
    .get('/tasks/:id/thread', async (c) => { const th = await taskThreadOf(c.get('db'), c.req.param('id')); if (!th) return c.json({ error: '任务不存在' }, 404); const msgs = await c.get('db').select().from(message).where(eq(message.threadId, th.id)); return c.json({ thread: th, messages: msgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }); })
    .get('/workstations/:id/thread', async (c) => { const th = await wsThreadOf(c.get('db'), c.req.param('id')); const msgs = await c.get('db').select().from(message).where(eq(message.threadId, th!.id)); return c.json({ thread: th, messages: msgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }); })
    .post('/threads/:id/messages', zValidator('json', z.object({ content: z.string().min(1) })), async (c) => c.json(await postThreadMessage(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').content), 201))
    .get('/threads/:id/stream', async (c) => { const threadId = c.req.param('id'); const existing = await c.get('db').select().from(message).where(eq(message.threadId, threadId)); return streamSSE(c, async (stream) => { for (const m of existing.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) await stream.writeSSE({ event: 'message', data: JSON.stringify(m) }); await holdSSE(stream, () => [events.on('message_created', async (p: Record<string, unknown>) => { if (p.threadId === threadId) await stream.writeSSE({ event: 'message', data: JSON.stringify(p) }); })]); }); })
    .get('/tasks/:id/runs', async (c) => c.json(await c.get('db').select().from(run).where(eq(run.taskId, c.req.param('id')))))
    .get('/agents/:id/runs', async (c) => c.json(await c.get('db').select().from(run).where(eq(run.agentId, c.req.param('id')))))
    .get('/runs/:id', async (c) => { const r = (await c.get('db').select().from(run).where(eq(run.id, c.req.param('id'))))[0]; return r ? c.json(r) : c.json({ error: 'run 不存在' }, 404); })
    .get('/runs/:id/stream', async (c) => { const runId = c.req.param('id'); return streamSSE(c, async (stream) => { const r = (await c.get('db').select().from(run).where(eq(run.id, runId)))[0]; for (const s of JSON.parse(r?.traceJson ?? '[]') as unknown[]) await stream.writeSSE({ event: 'step', data: JSON.stringify(s) }); if (r && r.status !== 'running') { await stream.writeSSE({ event: 'finished', data: JSON.stringify({ stopReason: r.stopReason }) }); return; } await holdSSE(stream, (close) => [events.on('run_step', async (p: Record<string, unknown>) => { if (p.runId === runId) await stream.writeSSE({ event: 'step', data: JSON.stringify(p.step) }); }), events.on('run_finished', async (p: Record<string, unknown>) => { if (p.runId !== runId) return; await stream.writeSSE({ event: 'finished', data: JSON.stringify({ stopReason: p.stopReason }) }); close(); })]); }); })
    .post('/agents/:id/run', zValidator('json', z.object({ taskId: z.string() })), async (c) => { const { scheduler } = await import('./runtime/scheduler.js'); const r = await scheduler.trigger(c.get('db'), c.req.param('id'), c.req.valid('json').taskId, 'manual'); return r.ok ? c.json({ runId: r.runId }, 201) : c.json({ error: r.error }, 400); })
    .get('/workstations/:id/agents/status', async (c) => { const db = c.get('db'); const running = await db.select().from(run).where(eq(run.status, 'running')); const agents = await db.select().from(agent).where(eq(agent.workstationId, c.req.param('id'))); const ids = new Set(agents.map((a) => a.id)); return c.json({ running: running.filter((r) => ids.has(r.agentId ?? '')).map((r) => r.agentId) }); })
    .get('/agents/:id', async (c) => { const a = (await c.get('db').select().from(agent).where(eq(agent.id, c.req.param('id'))))[0]; return a ? c.json(a) : c.json({ error: 'agent 不存在' }, 404); })
    .post('/proposals/:id/review', zValidator('json', z.object({ decision: z.enum(['approve','request_changes']), summary: z.string(), comments: z.array(z.object({ path: z.string(), line: z.number().optional(), body: z.string() })).optional() })), async (c) => {
      const db = c.get('db'); const b = c.req.valid('json');
      const p = (await db.select().from(proposal).where(eq(proposal.id, c.req.param('id'))))[0];
      if (!p) return c.json({ error: '提案不存在' }, 404);
      for (const cm of b.comments ?? []) await db.insert(reviewComment).values({ id: crypto.randomUUID(), proposalId: p.id, authorType: 'human', authorId: c.get('actor').id, path: cm.path, line: cm.line ?? null, body: cm.body, resolved: 0, createdAt: new Date().toISOString() });
      await db.update(proposal).set({ status: b.decision === 'approve' ? 'approved' : 'changes_requested' }).where(eq(proposal.id, p.id));
      if (p.taskId) { const t = (await db.select().from(task).where(eq(task.id, p.taskId)))[0]; if (t) { const { afterReview } = await import('./runtime/dev_workflow.js'); const wsAgents = await db.select().from(agent).where(eq(agent.workstationId, t.workstationId)); await afterReview({ db, actor: c.get('actor'), permCtx: {} as never, agent: wsAgents[0]!, task: t, run: {} as never }, p.id, b.decision); } }
      return c.json({ ok: true }); })
    .post('/proposals/:id/merge', async (c) => { const p = (await c.get('db').select().from(proposal).where(eq(proposal.id, c.req.param('id'))))[0]; if (!p?.taskId) return c.json({ error: '提案不存在' }, 404); const { enqueueMerge } = await import('./runtime/dev_workflow.js'); enqueueMerge(c.get('db'), c.get('actor'), p.taskId); return c.json({ ok: true }); })
    .get('/workstations/:id/entities', async (c) => { const rows = await c.get('db').select().from(entity).where(eq(entity.workstationId, c.req.param('id'))); return c.json({ entities: rows }); })
    .get('/workstations/:id/files', async (c) => { const ws = (await c.get('db').select().from(workstation).where(eq(workstation.id, c.req.param('id'))))[0]; if (!ws) return c.json({ error: '不存在' }, 404); const s = devSettings(ws.settingsJson); const { git } = await import('./runtime/git.js'); const path = c.req.query('path') ?? ''; const r = await git(s.repoPath, ['ls-tree', s.targetBranch, '--', path]); return c.json({ entries: r.stdout.split('\n').filter(Boolean) }); })
    .get('/workstations/:id/file', async (c) => { const ws = (await c.get('db').select().from(workstation).where(eq(workstation.id, c.req.param('id'))))[0]; if (!ws) return c.json({ error: '不存在' }, 404); const s = devSettings(ws.settingsJson); const { git } = await import('./runtime/git.js'); const p = c.req.query('path') ?? ''; const r = await git(s.repoPath, ['show', s.targetBranch + ':' + p]); return c.json({ content: r.stdout.slice(0, 200 * 1024) }); })
  return { app, routes };
}

export type AppType = ReturnType<typeof createApp>['routes'];
