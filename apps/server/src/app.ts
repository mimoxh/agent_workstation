import type { Actor } from '@aw/domain';
import { TASK_EVENTS } from '@aw/domain';
import fs from 'node:fs';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { z } from 'zod';
import type { DB } from './db/client.js';
import { agent, run, thread } from './db/schema.js';
import { events } from './events.js';
import {
  agentStatus,
  getArtifact,
  getLedger,
  getProjectDetail,
  getProjectOverview,
  getRun,
  getTaskDetail,
  getTaskTimeline,
  getTeamPulse,
  getWorkstationDetail,
  listEntities,
  listInbox,
  listPlugins,
  listProjects,
  listProjectTasks,
  listProposals,
  listRuns,
  listTaskProposals,
  listTasks,
  listTestRuns,
} from './repositories/index.js';
import { mergeProviders, publicModelConfig, readModelConfig, writeModelConfig } from './runtime/config.js';
import { cancelRun } from './runtime/loop.js';
import { defaultModelRef, loadModels, modelRegistry, reloadModels, sanitizeError } from './runtime/models.js';
import { scheduler, triggerRun } from './runtime/scheduler.js';
import { exportMarkdown, exportProject } from './usecases/backup.js';
import { createEntity, entityHistory, rollbackEntity, updateEntity } from './usecases/entities.js';
import {
  addAgentInstance,
  assignTask,
  createTaskUc,
  dispatchTask,
  interruptTask,
  releaseTask,
  respondTask,
  setStage,
  submitHumanChange,
  takeoverTask,
  transitionTaskUc,
  updateTask,
} from './usecases/index.js';
import { actOnInbox } from './usecases/inbox.js';
import { deleteSource, getChunk, importSource, listSources, searchKnowledge } from './usecases/knowledge.js';
import { createProject, mountChildWorkstation, setPluginEnabled, takeScreenshot, updateAgent, updateProject, updateWorkstation } from './usecases/projects.js';
import { SANDBOX_IMAGE } from './runtime/sandbox.js';
import { decideProposal, mergeProposal, reviewProposal } from './usecases/proposals.js';
import {
  ackDrift,
  createPullRequest,
  importIssues,
  listBrowseRefs,
  listRepoFiles,
  pushWorkstation,
  readRepoFile,
  remoteStatus,
  repoStatus,
  revertTask,
  syncBase,
  syncTask,
  taskBranchStatus,
} from './usecases/repo.js';
import { confirmGates } from './usecases/gates.js';
import { designSystemOf, handoffDesign, importDesignTokens, listDesigns, saveDesign, saveDesignSystem } from './usecases/designs.js';
import { cancelQaRun, handoffBug, handoffCase, recordManualResult, requestTriage, retryRun, saveSuite, signPlan, startPlan, startRun, transitionBug } from './usecases/qa.js';
import { bugTaskStatuses, getAutomatedCases, getCaseHistory, getQaCoverage, getQaFlaky, getQaOverview, getQaPlanDetail, getQaRunDetail, listQaRuns, listQaSources } from './repositories/qa.js';
import { decisionToProposal, dmThreadOf, listMessages, postThreadMessage, silenceThread, taskThreadOf, threadAgents, wsThreadOf } from './usecases/threads.js';

type Env = { Variables: { actor: Actor; db: DB } };

const jsonRecord = z.record(z.string(), z.unknown());

const modelConfigBody = z.object({
  providers: z.array(z.object({
    name: z.string().trim().min(1, 'provider 名称不能为空'),
    kind: z.enum(['anthropic', 'openai-compatible', 'ollama']),
    model: z.string().trim().min(1, '模型名不能为空'),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
  })),
  defaultModel: z.string().optional(),
  chain: z.array(z.string()),
  prices: z.record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) })),
});

const qaHandoffBody = z.object({ targetWorkstationId: z.string().optional(), module: z.string().trim().min(1, '请填改动范围'), priority: z.enum(['p0', 'p1', 'p2']), note: z.string().optional() });

// 校验失败也返回 { error: string }，前端只需要处理一种错误形状
const body = <T extends z.ZodType>(schema: T) =>
  zValidator('json', schema, (r, c) => {
    if (!r.success) return c.json({ error: r.error.issues[0]?.message ?? '请求参数不合法' }, 400);
    return undefined;
  });

const pathQuery = zValidator('query', z.object({ path: z.string().optional(), branch: z.string().optional() }), (r, c) => {
  if (!r.success) return c.json({ error: '路径参数不合法' }, 400);
  return undefined;
});

const knowledgeQuery = zValidator('query', z.object({ q: z.string().optional(), workstationId: z.string().optional() }), (r, c) => {
  if (!r.success) return c.json({ error: '查询参数不合法' }, 400);
  return undefined;
});

// status 收窄成字面量是为了让 RPC 客户端推导出 { error: string } 分支
const fail = (c: Context, r: { status?: number; error?: string }) => c.json({ error: r.error ?? '操作失败' }, (r.status ?? 400) as 400);

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

const LIVE_PREFIXES = ['qa_', 'task_', 'proposal_', 'inbox_', 'run_started', 'run_finished', 'run_step', 'message_', 'thread_', 'entity_', 'agent_', 'workstation_', 'project_'];

export function createApp(db: DB) {
  const app = new Hono<Env>();
  const api = app.basePath('/api');

  app.onError((e, c) => {
    console.error('[api]', sanitizeError(e instanceof Error ? (e.stack ?? e.message) : String(e)));
    return c.json({ error: '服务内部错误' }, 500);
  });

  api.use('*', async (c, next) => {
    c.set('actor', { type: 'human', id: 'local' });
    c.set('db', db);
    await next();
  });

  const routes = api
    .get('/health', (c) => c.json({ ok: true }))

    // ---- 实时变更：只推动作名，前端据此失效缓存 ----
    .get('/stream', (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: 'ready', data: '{}' });
        await holdSSE(stream, () => [
          events.onAny(async (action, p) => {
            if (!LIVE_PREFIXES.some((x) => action.startsWith(x))) return;
            await stream.writeSSE({ event: 'change', data: JSON.stringify({ action, targetId: p.targetId ?? p.runId ?? p.refId ?? null }) });
          }),
        ]);
      }),
    )

    // ---- 项目 ----
    .get('/plugins', async (c) => c.json(await listPlugins(c.get('actor'), c.get('db'))))
    .patch('/plugins/:id', body(z.object({ enabled: z.boolean() })), async (c) => {
      const r = await setPluginEnabled(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').enabled);
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .get('/settings/models', (c) => c.json(publicModelConfig(readModelConfig())))
    .put('/settings/models', body(modelConfigBody), async (c) => {
      const next = c.req.valid('json');
      const prev = readModelConfig();
      writeModelConfig({ ...next, providers: mergeProviders(next.providers, prev.providers) });
      await reloadModels();
      return c.json({ ok: true });
    })
    .get('/models', async (c) => {
      await loadModels();
      const models = [...modelRegistry.values()].map((m) => ({ id: m.id, local: m.local ?? false }));
      return c.json({ default: defaultModelRef() || models[0]?.id || null, ready: models.length > 0, models });
    })
    .get('/projects', async (c) => c.json(await listProjects(c.get('actor'), c.get('db'))))
    .post('/projects', body(z.object({
      name: z.string().trim().min(1, '项目名不能为空'),
      goal: z.string().optional(),
      template: z.object({ repoPath: z.string().trim().min(1, '仓库路径不能为空'), targetBranch: z.string().optional(), baseBranch: z.string().optional(), commands: z.record(z.string(), z.string()).optional() }).optional(),
    })), async (c) => {
      const r = await createProject(c.get('actor'), c.get('db'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ id: r.id, rootWorkstationId: r.rootWorkstationId }, 201) : fail(c, r);
    })
    .get('/projects/:id', async (c) => {
      const d = await getProjectDetail(c.get('actor'), c.get('db'), c.req.param('id'));
      return d ? c.json(d) : fail(c, { status: 404, error: '项目不存在' });
    })
    .patch('/projects/:id', body(z.object({ budget: z.object({ tokens: z.number().int().positive().optional(), costMicros: z.number().int().positive().optional() }).nullable().optional() })), async (c) => {
      const r = await updateProject(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .get('/projects/:id/ledger', async (c) => {
      const d = await getLedger(c.get('actor'), c.get('db'), c.req.param('id'));
      return d ? c.json(d) : fail(c, { status: 404, error: '项目不存在' });
    })
    .get('/projects/:id/export', async (c) => {
      const data = await exportProject(c.get('db'), c.req.param('id'));
      if (!data) return fail(c, { status: 404, error: '项目不存在' });
      if (c.req.query('format') === 'md') return c.text(exportMarkdown(data), 200, { 'content-disposition': 'attachment; filename="project.md"' });
      return c.json(data, 200, { 'content-disposition': 'attachment; filename="project.json"' });
    })
    .get('/projects/:id/knowledge', knowledgeQuery, async (c) => c.json(await listSources(c.get('db'), c.req.param('id'), c.req.valid('query').workstationId)))
    .post('/projects/:id/knowledge', body(z.object({ name: z.string().trim().min(1, '名称不能为空'), content: z.string(), kind: z.enum(['md', 'txt', 'note']), workstationId: z.string().optional() })), async (c) => {
      const r = await importSource(c.get('actor'), c.get('db'), { projectId: c.req.param('id'), ...c.req.valid('json') });
      return r.kind === 'ok' ? c.json({ id: r.id }, 201) : fail(c, r);
    })
    .get('/projects/:id/knowledge/search', knowledgeQuery, async (c) => {
      const { q, workstationId } = c.req.valid('query');
      return c.json(await searchKnowledge(c.get('db'), { projectId: c.req.param('id'), workstationId }, q ?? ''));
    })
    .delete('/knowledge/:id', async (c) => {
      const r = await deleteSource(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .get('/knowledge/chunks/:id', async (c) => {
      const d = await getChunk(c.get('db'), c.req.param('id'));
      return d ? c.json(d) : fail(c, { status: 404, error: '引用的片段不存在' });
    })
    .get('/projects/:id/overview', async (c) => {
      const d = await getProjectOverview(c.get('actor'), c.get('db'), c.req.param('id'));
      return d ? c.json(d) : fail(c, { status: 404, error: '项目不存在' });
    })
    .get('/projects/:id/pulse', async (c) => {
      const d = await getTeamPulse(c.get('actor'), c.get('db'), c.req.param('id'));
      return d ? c.json(d) : fail(c, { status: 404, error: '项目不存在' });
    })
    .get('/projects/:id/tasks', async (c) => c.json(await listProjectTasks(c.get('actor'), c.get('db'), c.req.param('id'))))
    .get('/projects/:id/runs', async (c) => c.json(await listRuns(c.get('actor'), c.get('db'), { projectId: c.req.param('id') })))
    .post(
      '/projects/:id/workstations',
      body(z.object({ parentId: z.string().optional(), pluginId: z.string().min(1), name: z.string().trim().min(1, '工作台名不能为空'), settings: jsonRecord.optional() })),
      async (c) => {
        const r = await mountChildWorkstation(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
        return r.kind === 'ok' ? c.json({ id: r.id }, 201) : fail(c, r);
      },
    )

    // ---- 工作台 ----
    .get('/workstations/:id', async (c) => {
      const d = await getWorkstationDetail(c.get('actor'), c.get('db'), c.req.param('id'));
      return d ? c.json(d) : fail(c, { status: 404, error: '工作台不存在' });
    })
    .patch(
      '/workstations/:id',
      body(
        z.object({
          name: z.string().trim().min(1).optional(),
          settings: z
            .object({
              repoPath: z.string().optional(),
              targetBranch: z.string().min(1).optional(),
              baseBranch: z.string().min(1).optional(),
              commands: z.record(z.string(), z.string()).optional(),
              commandTimeoutSec: z.number().int().positive().optional(),
              setupTimeoutSec: z.number().int().positive().optional(),
              requireHumanFor: z.array(z.string()).optional(),
              preset: z.string().optional(),
              remote: z.object({ name: z.string().trim().min(1), autoPush: z.boolean() }).nullable().optional(),
              sandbox: z.object({ image: z.string().trim().regex(SANDBOX_IMAGE, '镜像名不合法'), memory: z.string().regex(/^\d+[kmg]?$/i).optional(), cpus: z.number().positive().optional() }).nullable().optional(),
              budget: z.object({ tokens: z.number().int().positive().optional(), costMicros: z.number().int().positive().optional() }).nullable().optional(),
            })
            .optional(),
        }),
      ),
      async (c) => {
        const r = await updateWorkstation(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
        return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
      },
    )
    .get('/workstations/:id/repo', async (c) => c.json(await repoStatus(c.get('db'), c.req.param('id'))))
    .post('/workstations/:id/repo/sync-base', async (c) => {
      const r = await syncBase(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ status: r.status, sha: r.sha ?? null }) : fail(c, r);
    })
    .post('/workstations/:id/repo/ack-drift', async (c) => c.json(ackDrift(c.req.param('id'))))
    .get('/workstations/:id/remote', async (c) => c.json(await remoteStatus(c.get('db'), c.req.param('id'))))
    .post('/workstations/:id/remote/push', async (c) => {
      const r = await pushWorkstation(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/workstations/:id/remote/pull-request', async (c) => {
      const r = await createPullRequest(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ url: r.url, created: r.created }) : fail(c, r);
    })
    .post('/workstations/:id/remote/import-issues', async (c) => {
      const r = await importIssues(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ created: r.created, skipped: r.skipped }) : fail(c, r);
    })
    .post('/workstations/:id/agents', body(z.object({ templateId: z.string().min(1) })), async (c) => {
      const r = await addAgentInstance(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').templateId);
      if (r.kind === 'not_found') return fail(c, { status: 404, error: '工作台不存在' });
      if (r.kind === 'error') return fail(c, { status: 400, error: r.error });
      return c.json({ ok: true }, 201);
    })
    .get('/workstations/:id/agents/status', async (c) => c.json(await agentStatus(c.get('actor'), c.get('db'), c.req.param('id'))))
    .get('/workstations/:id/tasks', async (c) => c.json(await listTasks(c.get('actor'), c.get('db'), c.req.param('id'))))
    .post(
      '/workstations/:id/tasks',
      body(
        z.object({
          title: z.string().trim().min(1, '标题不能为空'),
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
        return r.kind === 'ok' ? c.json(r.task!, 201) : fail(c, r);
      },
    )
    .get('/workstations/:id/proposals', async (c) => c.json(await listProposals(c.get('actor'), c.get('db'), c.req.param('id'))))
    .get('/workstations/:id/testruns', async (c) => c.json(await listTestRuns(c.get('actor'), c.get('db'), { workstationId: c.req.param('id') })))
    .get('/workstations/:id/entities', async (c) => c.json({ entities: await listEntities(c.get('actor'), c.get('db'), c.req.param('id')) }))
    .post('/workstations/:id/entities', body(z.object({ entityType: z.string().min(1), data: jsonRecord, reason: z.string().optional() })), async (c) => {
      const r = await createEntity(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ id: r.id }, 201) : fail(c, r);
    })
    .get('/workstations/:id/files', pathQuery, async (c) => c.json(await listRepoFiles(c.get('db'), c.req.param('id'), c.req.valid('query').path ?? '', c.req.valid('query').branch || undefined)))
    .get('/workstations/:id/branches', async (c) => c.json(await listBrowseRefs(c.get('db'), c.req.param('id'))))
    .get('/workstations/:id/file', pathQuery, async (c) => {
      const r = await readRepoFile(c.get('db'), c.req.param('id'), c.req.valid('query').path ?? '', c.req.valid('query').branch || undefined);
      return r.kind === 'ok' ? c.json({ ref: r.ref, path: r.path, binary: r.binary, truncated: r.truncated, content: r.content }) : fail(c, r);
    })
    .get('/workstations/:id/thread', async (c) => {
      const d = await getWorkstationDetail(c.get('actor'), c.get('db'), c.req.param('id'));
      if (!d) return fail(c, { status: 404, error: '工作台不存在' });
      const th = await wsThreadOf(c.get('db'), c.req.param('id'));
      return c.json({ thread: th });
    })

    // ---- 设计台 ----
    .get('/workstations/:id/designs', async (c) => c.json(await listDesigns(c.get('db'), c.req.param('id'))))
    .post('/workstations/:id/designs', body(z.object({ title: z.string().trim().min(1, '标题不能为空'), html: z.string().trim().min(1, 'HTML 不能为空'), brief: z.string().optional() })), async (c) => {
      const r = await saveDesign(c.get('actor'), c.get('db'), c.req.param('id'), { ...c.req.valid('json'), reason: '导入 HTML' });
      return r.kind === 'ok' ? c.json({ id: r.id, warnings: r.warnings }, 201) : fail(c, r);
    })
    .get('/workstations/:id/design-system', async (c) => c.json(await designSystemOf(c.get('db'), c.req.param('id'))))
    .put('/workstations/:id/design-system', body(z.object({ name: z.string().trim().min(1).optional(), tokens: z.array(z.object({ name: z.string().regex(/^--[\w-]+$/, '令牌名要以 -- 开头'), value: z.string().trim().min(1, '令牌的值不能为空'), description: z.string().optional() })).optional(), guidelines: z.string().optional(), baseVersion: z.number().int().optional() })), async (c) => {
      const r = await saveDesignSystem(c.get('actor'), c.get('db'), c.req.param('id'), { ...c.req.valid('json'), reason: '人工修改' });
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/workstations/:id/design-system/import', body(z.object({ css: z.string().optional(), sourceWorkstationId: z.string().optional(), path: z.string().optional() })), async (c) => {
      const r = await importDesignTokens(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ count: r.count }) : fail(c, r);
    })
    .post('/designs/:id/handoff', body(z.object({ targetWorkstationId: z.string().min(1), module: z.string().trim().min(1, '请填改动范围'), priority: z.enum(['p0', 'p1', 'p2']), note: z.string().optional() })), async (c) => {
      const r = await handoffDesign(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ taskId: r.taskId }, 201) : fail(c, r);
    })

    // ---- 测试台 ----
    .get('/projects/:id/qa-sources', async (c) => c.json(await listQaSources(c.get('actor'), c.get('db'), c.req.param('id'))))
    .get('/workstations/:id/qa/overview', async (c) => c.json(await getQaOverview(c.get('actor'), c.get('db'), c.req.param('id'))))
    .get('/workstations/:id/qa/runs', async (c) => c.json(await listQaRuns(c.get('actor'), c.get('db'), c.req.param('id'))))
    .post('/workstations/:id/qa/runs', body(z.object({ suiteId: z.string().min(1), ref: z.string().optional() })), async (c) => {
      const r = await startRun(c.get('actor'), c.get('db'), c.req.param('id'), { ...c.req.valid('json'), trigger: 'human' });
      return r.kind === 'ok' ? c.json({ id: r.id }, 201) : fail(c, r);
    })
    .post('/workstations/:id/qa/suites', body(z.object({ id: z.string().optional(), baseVersion: z.number().int().optional(), data: z.object({ name: z.string().trim().min(1, '请填名称'), command: z.string().trim().min(1, '请填命令'), report_path: z.string().trim().min(1, '请填报告路径'), coverage_path: z.string().trim().optional(), timeout_sec: z.number().int().positive().optional(), auto_run: z.boolean().optional(), description: z.string().optional() }) })), async (c) => {
      const r = await saveSuite(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ id: r.id }, 201) : fail(c, r);
    })
    .get('/workstations/:id/qa/flaky', async (c) => c.json(await getQaFlaky(c.get('actor'), c.get('db'), c.req.param('id'))))
    .get('/workstations/:id/qa/coverage', async (c) => c.json(await getQaCoverage(c.get('actor'), c.get('db'), c.req.param('id'))))
    .get('/workstations/:id/qa/automated', async (c) => c.json(await getAutomatedCases(c.get('actor'), c.get('db'), c.req.param('id'))))
    .get('/workstations/:id/qa/handoffs', async (c) => c.json(await bugTaskStatuses(c.get('actor'), c.get('db'), c.req.param('id'))))
    .get('/workstations/:id/qa/cases/:key/history', async (c) => c.json(await getCaseHistory(c.get('actor'), c.get('db'), c.req.param('id'), c.req.param('key'))))
    .get('/workstations/:id/qa/plans/:planId', async (c) => {
      const r = await getQaPlanDetail(c.get('actor'), c.get('db'), c.req.param('id'), c.req.param('planId'));
      return r ? c.json(r) : fail(c, { status: 404, error: '测试计划不存在' });
    })
    .get('/qa-runs/:id', async (c) => {
      const r = await getQaRunDetail(c.get('actor'), c.get('db'), c.req.param('id'));
      return r ? c.json(r) : fail(c, { status: 404, error: '运行不存在' });
    })
    .post('/qa-runs/:id/retry', async (c) => {
      const r = await retryRun(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ id: r.id }, 201) : fail(c, r);
    })
    .post('/qa-runs/:id/cancel', async (c) => {
      const r = await cancelQaRun(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/qa-runs/:id/triage', async (c) => {
      const r = await requestTriage(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/qa-plans/:id/start', async (c) => {
      const r = await startPlan(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/qa-plans/:id/manual', body(z.object({ caseId: z.string().min(1), status: z.enum(['passed', 'failed', 'blocked', 'skipped']), note: z.string().optional() })), async (c) => {
      const { caseId, ...input } = c.req.valid('json');
      const r = await recordManualResult(c.get('actor'), c.get('db'), c.req.param('id'), caseId, input);
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/qa-plans/:id/sign', body(z.object({ note: z.string().optional(), override: z.boolean().optional() })), async (c) => {
      const r = await signPlan(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/qa-bugs/:id/transition', body(z.object({ event: z.enum(['confirm', 'dev_done', 'verify_pass', 'verify_fail', 'reject', 'reopen']), note: z.string().optional() })), async (c) => {
      const { event, note } = c.req.valid('json');
      const r = await transitionBug(c.get('actor'), c.get('db'), c.req.param('id'), event, note);
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/qa-bugs/:id/handoff', body(qaHandoffBody), async (c) => {
      const r = await handoffBug(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ taskId: r.taskId }, 201) : fail(c, r);
    })
    .post('/qa-cases/:id/handoff', body(qaHandoffBody), async (c) => {
      const r = await handoffCase(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ taskId: r.taskId }, 201) : fail(c, r);
    })

    // ---- 实体 ----
    .patch('/entities/:id', body(z.object({ data: jsonRecord, baseVersion: z.number().int(), reason: z.string().optional() })), async (c) => {
      const r = await updateEntity(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ id: r.id, version: r.version }) : fail(c, r);
    })
    .post('/entities/:id/rollback', body(z.object({ version: z.number().int().positive() })), async (c) => {
      const r = await rollbackEntity(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').version);
      return r.kind === 'ok' ? c.json({ version: r.version }) : fail(c, r);
    })
    .get('/entities/:id/versions', async (c) => c.json(await entityHistory(c.get('db'), c.req.param('id'))))

    // ---- 任务 ----
    .get('/tasks/:id', async (c) => {
      const d = await getTaskDetail(c.get('actor'), c.get('db'), c.req.param('id'));
      return d ? c.json(d) : fail(c, { status: 404, error: '任务不存在' });
    })
    .patch(
      '/tasks/:id',
      body(z.object({ title: z.string().trim().min(1).optional(), intent: z.string().nullable().optional(), input: jsonRecord.optional(), acceptance: z.array(jsonRecord).optional() })),
      async (c) => {
        const r = await updateTask(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
        return r.kind === 'ok' ? c.json(r.task) : fail(c, r);
      },
    )
    .post(
      '/tasks/:id/dispatch',
      body(
        z.object({
          targetWorkstationId: z.string().min(1),
          typeId: z.string().min(1),
          input: jsonRecord,
          acceptance: z.array(jsonRecord).optional(),
          reason: z.string().optional(),
          budget: z.object({ tokens: z.number().int().positive().optional() }).optional(),
        }),
      ),
      async (c) => {
        const r = await dispatchTask(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
        return r.kind === 'ok' ? c.json(r.task!) : fail(c, r);
      },
    )
    .post('/tasks/:id/assign', body(z.object({ agentId: z.string().min(1), reason: z.string().optional() })), async (c) => {
      const r = await assignTask(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json(r.task) : fail(c, r);
    })
    .post(
      '/tasks/:id/respond',
      body(
        z
          .object({
            action: z.enum(['accept', 'reject', 'counter']),
            reason: z.string().optional(),
            counter: z.object({ input: jsonRecord.optional(), acceptance: z.array(jsonRecord).optional() }).optional(),
          })
          .refine((b) => b.action === 'accept' || (b.reason !== undefined && b.reason.trim().length > 0), {
            message: '拒绝或反提案必须给出理由',
          }),
      ),
      async (c) => {
        const r = await respondTask(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
        return r.kind === 'ok' ? c.json(r.task!) : fail(c, r);
      },
    )
    .post('/tasks/:id/stage', body(z.object({ stage: z.string().min(1), force: z.boolean().optional() })), async (c) => {
      const { stage, force } = c.req.valid('json');
      const r = await setStage(c.get('actor'), c.get('db'), c.req.param('id'), stage, { force });
      return r.kind === 'ok' ? c.json(r.task!) : fail(c, r);
    })
    .post('/tasks/:id/gates/confirm', body(z.object({ stage: z.string().min(1), index: z.number().int().min(0) })), async (c) => {
      await confirmGates(c.get('actor'), c.get('db'), c.req.param('id'), [c.req.valid('json')]);
      return c.json({ ok: true });
    })
    .get('/tasks/:id/branch', async (c) => c.json({ branch: await taskBranchStatus(c.get('db'), c.req.param('id')) }))
    .post('/tasks/:id/sync', async (c) => {
      const r = await syncTask(c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ status: r.status, files: 'files' in r ? r.files : [] }) : fail(c, r);
    })
    .post('/tasks/:id/revert', body(z.object({ reason: z.string().optional() })), async (c) => {
      const r = await revertTask(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').reason);
      return r.kind === 'ok' ? c.json({ revertSha: r.revertSha }) : fail(c, r);
    })
    .post('/tasks/:id/transition', body(z.object({ event: z.enum(TASK_EVENTS) })), async (c) => {
      const r = await transitionTaskUc(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').event);
      return r.kind === 'ok' ? c.json(r.task!) : fail(c, r);
    })
    .get('/tasks/:id/timeline', async (c) => {
      const d = await getTaskTimeline(c.get('actor'), c.get('db'), c.req.param('id'));
      return d ? c.json(d) : fail(c, { status: 404, error: '任务不存在' });
    })
    .post('/tasks/:id/interrupt', async (c) => {
      const r = await interruptTask(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ stopped: r.stopped }) : fail(c, r);
    })
    .post('/tasks/:id/takeover', async (c) => {
      const r = await takeoverTask(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json(r.task) : fail(c, r);
    })
    .post('/tasks/:id/release', body(z.object({ note: z.string().optional() })), async (c) => {
      const r = await releaseTask(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').note);
      return r.kind === 'ok' ? c.json(r.task) : fail(c, r);
    })
    .post('/tasks/:id/submit-change', body(z.object({ summary: z.string().trim().min(1, '请写一句改动说明') })), async (c) => {
      const r = await submitHumanChange(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').summary);
      return r.kind === 'ok' ? c.json({ proposalId: r.proposalId }) : fail(c, r);
    })
    .get('/tasks/:id/thread', async (c) => {
      const th = await taskThreadOf(c.get('db'), c.req.param('id'));
      return th ? c.json({ thread: th }) : fail(c, { status: 404, error: '任务不存在' });
    })
    .get('/tasks/:id/runs', async (c) => c.json(await listRuns(c.get('actor'), c.get('db'), { taskId: c.req.param('id') })))
    .get('/tasks/:id/proposals', async (c) => c.json(await listTaskProposals(c.get('actor'), c.get('db'), c.req.param('id'))))
    .get('/tasks/:id/testruns', async (c) => c.json(await listTestRuns(c.get('actor'), c.get('db'), { taskId: c.req.param('id') })))

    // ---- 收件箱 ----
    .get('/inbox', async (c) => c.json(await listInbox(c.get('actor'), c.get('db'), c.req.query('status') ?? 'open', c.req.query('projectId'))))
    .post(
      '/inbox/:id/resolve',
      body(z.object({ resolution: z.string().optional(), decision: z.enum(['approve', 'deny']).optional(), action: z.enum(['retry', 'unblock']).optional(), answer: z.string().optional() })),
      async (c) => {
        const r = await actOnInbox(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
        return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
      },
    )

    // ---- 提案 ----
    .post('/proposals/:id/approve', async (c) => {
      const r = await decideProposal(c.get('actor'), c.get('db'), c.req.param('id'), 'approve');
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/proposals/:id/reject', body(z.object({ reason: z.string().optional() })), async (c) => {
      const r = await decideProposal(c.get('actor'), c.get('db'), c.req.param('id'), 'reject', c.req.valid('json').reason);
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post(
      '/proposals/:id/review',
      body(
        z.object({
          decision: z.enum(['approve', 'request_changes']),
          summary: z.string(),
          comments: z.array(z.object({ path: z.string(), line: z.number().optional(), body: z.string() })).optional(),
        }),
      ),
      async (c) => {
        const r = await reviewProposal(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
        return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
      },
    )
    .post('/proposals/:id/merge', async (c) => {
      const r = await mergeProposal(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })

    // ---- 会话 ----
    .get('/threads/:id/messages', async (c) => c.json(await listMessages(c.get('db'), c.req.param('id'))))
    .get('/threads/:id/members', async (c) => {
      const th = (await c.get('db').select().from(thread).where(eq(thread.id, c.req.param('id'))))[0];
      if (!th) return fail(c, { status: 404, error: '会话不存在' });
      return c.json((await threadAgents(c.get('db'), th)).map((a) => ({ id: a.id, name: a.name })));
    })
    .post('/threads/:id/silence', body(z.object({ silenced: z.boolean() })), async (c) => {
      const r = await silenceThread(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').silenced);
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/messages/:id/propose-adr', async (c) => {
      const r = await decisionToProposal(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ proposalId: r.proposalId }, 201) : fail(c, r);
    })
    .post('/threads/:id/messages', body(z.object({ content: z.string().trim().min(1, '消息不能为空'), meta: z.object({ design: z.object({ id: z.string(), title: z.string(), version: z.number().int() }) }).optional() })), async (c) => {
      const { content, meta } = c.req.valid('json');
      const m = await postThreadMessage(c.get('actor'), c.get('db'), c.req.param('id'), content, meta);
      return m ? c.json(m, 201) : fail(c, { status: 404, error: '会话不存在' });
    })

    // ---- 运行 ----
    .get('/agents/:id/thread', async (c) => {
      const th = await dmThreadOf(c.get('db'), c.req.param('id'));
      return th ? c.json({ thread: th }) : fail(c, { status: 404, error: 'Agent 不存在' });
    })
    .get('/agents/:id', async (c) => {
      const a = (await c.get('db').select().from(agent).where(eq(agent.id, c.req.param('id'))))[0];
      return a ? c.json(a) : fail(c, { status: 404, error: 'Agent 不存在' });
    })
    .patch(
      '/agents/:id',
      body(
        z.object({
          name: z.string().trim().min(1).optional(),
          status: z.enum(['active', 'paused']).optional(),
          model: z.object({ provider: z.string().min(1), name: z.string().min(1) }).nullable().optional(),
          prompt: z.string().nullable().optional(),
          tools: z.array(z.string()).optional(),
        }),
      ),
      async (c) => {
        const r = await updateAgent(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
        return r.kind === 'ok' ? c.json(r.agent) : fail(c, r);
      },
    )
    .get('/agents/:id/runs', async (c) => c.json(await listRuns(c.get('actor'), c.get('db'), { agentId: c.req.param('id') })))
    .post('/agents/:id/run', body(z.object({ taskId: z.string() })), async (c) => {
      const r = await scheduler.trigger(c.get('db'), c.req.param('id'), c.req.valid('json').taskId, 'manual');
      return r.ok ? c.json({ runId: r.runId }, 201) : fail(c, { status: 400, ...(r.error ? { error: r.error } : {}) });
    })
    .get('/runs/:id', async (c) => {
      const r = await getRun(c.get('actor'), c.get('db'), c.req.param('id'));
      return r ? c.json(r) : fail(c, { status: 404, error: 'run 不存在' });
    })
    .post('/runs/:id/retry', body(z.object({ step: z.number().int().min(0) })), async (c) => {
      const source = (await c.get('db').select().from(run).where(eq(run.id, c.req.param('id'))))[0];
      if (!source?.agentId || !source.taskId) return fail(c, { status: 400, error: '只有任务上的运行可以重试' });
      const r = await triggerRun(c.get('db'), source.agentId, source.taskId, 'retry', { resume: { runId: source.id, step: c.req.valid('json').step } });
      return r.ok ? c.json({ runId: r.runId }, 201) : fail(c, { status: 409, ...(r.error ? { error: r.error } : {}) });
    })
    .post('/workstations/:id/screenshot', body(z.object({ url: z.string().url('地址不合法'), baseline: z.string().optional(), branch: z.string().optional() })), async (c) => {
      const { url, baseline, branch } = c.req.valid('json');
      const r = await takeScreenshot(c.get('db'), c.req.param('id'), url, { baseline: baseline || undefined, branch: branch || undefined });
      return r.kind === 'ok' ? c.json({ artifactId: r.id, compare: r.compare ?? null }, 201) : fail(c, r);
    })
    .get('/artifacts/:id/image', async (c) => {
      const a = await getArtifact(c.get('actor'), c.get('db'), c.req.param('id'));
      if (!a?.ref || a.type !== 'screenshot') return fail(c, { status: 404, error: '截图不存在' });
      return c.body(new Uint8Array(fs.readFileSync(a.ref)), 200, { 'content-type': 'image/png' });
    })
    .post('/runs/:id/cancel', async (c) => {
      const r = (await c.get('db').select().from(run).where(eq(run.id, c.req.param('id'))))[0];
      if (!r) return fail(c, { status: 404, error: 'run 不存在' });
      if (r.status !== 'running') return fail(c, { status: 409, error: 'run 已结束' });
      if (!cancelRun(r.id)) {
        await c.get('db').update(run).set({ status: 'cancelled', stopReason: 'cancelled', endedAt: new Date().toISOString() }).where(eq(run.id, r.id));
        events.emit('run_finished', { runId: r.id, agentId: r.agentId, taskId: r.taskId, stopReason: 'cancelled' });
      }
      return c.json({ ok: true });
    })
    .get('/runs/:id/stream', async (c) => {
      const runId = c.req.param('id');
      return streamSSE(c, async (stream) => {
        const r = (await c.get('db').select().from(run).where(eq(run.id, runId)))[0];
        for (const s of JSON.parse(r?.traceJson ?? '[]') as unknown[]) await stream.writeSSE({ event: 'step', data: JSON.stringify(s) });
        if (r && r.status !== 'running') {
          await stream.writeSSE({ event: 'finished', data: JSON.stringify({ stopReason: r.stopReason }) });
          return;
        }
        await holdSSE(stream, (close) => [
          events.on('run_step', async (p: Record<string, unknown>) => {
            if (p.runId === runId) await stream.writeSSE({ event: 'step', data: JSON.stringify(p.step) });
          }),
          events.on('run_finished', async (p: Record<string, unknown>) => {
            if (p.runId !== runId) return;
            await stream.writeSSE({ event: 'finished', data: JSON.stringify({ stopReason: p.stopReason }) });
            close();
          }),
        ]);
      });
    })
    .get('/artifacts/:id', async (c) => {
      const a = await getArtifact(c.get('actor'), c.get('db'), c.req.param('id'));
      return a ? c.json({ id: a.id, type: a.type, name: a.name, content: a.ref, createdAt: a.createdAt }) : fail(c, { status: 404, error: '产物不存在' });
    });

  return { app, routes };
}

export type AppType = ReturnType<typeof createApp>['routes'];
