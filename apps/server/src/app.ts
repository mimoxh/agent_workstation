import type { Actor } from '@aw/domain';
import { renderForRepo, TASK_EVENTS } from '@aw/domain';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { z } from 'zod';
import type { DB } from './db/client.js';
import { agent, artifact, run, task, thread } from './db/schema.js';
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
import { getProjectStatus } from './repositories/plan.js';
import { mergeProviders, publicModelConfig, readModelConfig, writeModelConfig } from './runtime/config.js';
import { listFolder, projectFolderRoot, readFolderFile } from './runtime/folder.js';
import { liveSnapshot } from './runtime/live_output.js';
import { upgradeWebSocket } from '@hono/node-server';
import { detectHarnesses } from './runtime/harness/index.js';
import { bearerOf, handleMcp } from './runtime/harness/mcp.js';
import { handleTurn } from './runtime/harness/run.js';
import { cancelRun } from './runtime/loop.js';
import { listTerminals, resizeTerminal, subscribeTerminal, terminalBuffer, terminalInfo, writeTerminal } from './runtime/terminal.js';
import { buildRoute, defaultModelRef, loadModels, modelRegistry, reloadModels, sanitizeError } from './runtime/models.js';
import { probeModel } from './runtime/probe.js';
import { scheduler, triggerRun } from './runtime/scheduler.js';
import { exportMarkdown, exportProject } from './usecases/backup.js';
import { createEntity, entityHistory, rollbackEntity, updateEntity } from './usecases/entities.js';
import {
  addAgentInstance,
  assignTask,
  createTaskUc,
  dispatchTask,
  interruptTask,
  planTask,
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
import { createProject, deleteProject, mountChildWorkstation, setPluginEnabled, setProjectArchived, takeScreenshot, updateAgent, updateProject, updateWorkstation } from './usecases/projects.js';
import { SANDBOX_IMAGE } from './runtime/sandbox.js';
import { decideProposal, mergeProposal, reviewProposal } from './usecases/proposals.js';
import {
  ackDrift,
  createPullRequest,
  importIssues,
  initRepo,
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
import { previewStatus, startPreview, stopPreview } from './runtime/preview.js';
import { deleteDesign, handoffDesign, listDesigns, readHandoffFor, renderableDesign, saveDesign } from './usecases/designs.js';
import { ackDocReverse, addDocComment, citationLabelsOf, docGate, docHealth, docRow, docsSettingsOf, draftReleaseNotes, editDoc, handoffDoc, importDocReverse, listDocComments, listDocs, readDoc, repointDocDrift, requestReview, resolveDocComments, saveDoc, saveDocsSettings, saveStyleGuide, styleGuideOf } from './usecases/docs.js';
import { listRepoSources } from './usecases/repo_source.js';
import { askVideoAgent, createVideo, deleteVideo, entityRowOf, getVideo, listShotComments, listVideos, renderableShot, reorderShots, replaceStoryboard, saveScript, saveShotIssues, shotRow, updateShot, updateVideo, videoRow, videoStyleOf } from './usecases/videos.js';
import { addShotComment, requestVideoReview, resolveShotComments } from './usecases/video_review.js';
import { BGM_MAX_BYTES, listVideoMedia, saveVideoStyle, uploadBgm } from './usecases/video_style.js';
import { renderShotFrames } from './runtime/video_frame.js';
import { insideMedia, MEDIA_TYPES, mimeOf, parseRange, safeFileName } from './runtime/media/storage.js';
import { probeTts, publicTtsProviders, sampleVoice } from './runtime/media/tts.js';
import { voiceShots } from './usecases/video_voice.js';
import { cancelVideoRender, compareVideoRenders, createVideoRender, getVideoRender, listVideoRenders } from './usecases/video_renders.js';
import { ASSET_VIDEO_MAX, deleteAsset, getAsset, listAssets, updateAsset, uploadAsset } from './usecases/video_assets.js';
import { decideClipRequest, listClipRequests, readClipRequest, requestClip } from './usecases/video_clips.js';
import { docToHtml } from './runtime/doc_render.js';
import { BROWSER_MISSING, renderDesign, VIEWPORTS, type ViewportName } from './runtime/design_render.js';
import { cancelQaRun, handoffBug, handoffCase, recordManualResult, requestTriage, retryRun, saveSuite, signPlan, startPlan, startRun, taskQuality, transitionBug } from './usecases/qa.js';
import { bugTaskStatuses, getAutomatedCases, getCaseHistory, getQaCoverage, getQaFlaky, getQaOverview, getQaPlanDetail, getQaRunDetail, listQaRuns, qaGateSuites } from './repositories/qa.js';
import { archiveThread, createConversation, decisionToProposal, dmThreadOf, listConversations, listMessages, postThreadMessage, silenceThread, stopThread, taskThreadOf, threadActivity, threadAgents, wsThreadOf } from './usecases/threads.js';

type Env = { Variables: { actor: Actor; db: DB } };

const jsonRecord = z.record(z.string(), z.unknown());

const providerBody = z.object({
  name: z.string().trim().min(1, 'provider 名称不能为空'),
  kind: z.enum(['anthropic', 'openai-compatible', 'ollama']),
  model: z.string().trim().min(1, '模型名不能为空'),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  vision: z.boolean().optional(),
  contextWindow: z.number().int().min(1024).optional(),
  maxOutputTokens: z.number().int().min(256).optional(),
}).refine((p) => !(p.contextWindow && p.maxOutputTokens) || p.maxOutputTokens < p.contextWindow, { message: '最大输出要小于上下文窗口', path: ['maxOutputTokens'] });

const mediaProviderBody = z.object({
  name: z.string().trim().min(1, 'provider 名称不能为空'),
  kind: z.enum(['tts', 'video']),
  protocol: z.enum(['openai-speech', 'mock']),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  voice: z.string().optional(),
  format: z.enum(['mp3', 'wav']).optional(),
  price: z.object({ perMillionChars: z.number().min(0).optional(), perSecond: z.number().min(0).optional() }).optional(),
});

const modelConfigBody = z.object({
  providers: z.array(providerBody),
  defaultModel: z.string().optional(),
  chain: z.array(z.string()),
  prices: z.record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) })),
  media: z.array(mediaProviderBody).optional(),
  defaultTts: z.string().optional(),
  defaultVideo: z.string().optional(),
});

const voiceBody = z.object({ provider: z.string().optional(), voice: z.string().max(100).optional(), speed: z.number().min(0.25, '语速要在 0.25 到 4 之间').max(4, '语速要在 0.25 到 4 之间').optional(), off: z.boolean().optional() });

const renderBody = z.object({
  fps: z.number().int().optional(),
  subtitles: z.enum(['burn', 'srt', 'off']).optional(),
  allowPlaceholders: z.boolean().optional(),
  override: z.string().trim().max(500).optional(),
});

const styleBody = z.object({
  name: z.string().trim().max(40).optional(),
  palette: z.record(z.string(), z.string().max(80)).optional(),
  fonts: z.object({ heading: z.string().max(200).optional(), body: z.string().max(200).optional() }).optional(),
  voice: voiceBody.nullable().optional(),
  bgm: z.string().nullable().optional(),
  bgmVolume: z.number().min(0).max(1).optional(),
  ducking: z.boolean().optional(),
  rules: z.string().max(20000).optional(),
  subtitle: z.object({ size: z.enum(['s', 'm', 'l']).optional(), position: z.enum(['bottom', 'top']).optional(), background: z.enum(['box', 'shadow', 'none']).optional() }).optional(),
  baseVersion: z.number().int().optional(),
  reason: z.string().optional(),
});

const commentBody = z.object({
  shot: z.string().min(1),
  time: z.number().min(0).max(3600).optional(),
  selector: z.string().max(500).optional(),
  anchor: z.string().max(80).optional(),
  body: z.string().trim().min(1, '评论内容不能为空').max(4000),
  severity: z.enum(['block', 'note']).optional(),
});
const videoBody = z.object({
  title: z.string().trim().min(1, '标题不能为空').optional(),
  brief: z.string().optional(),
  audience: z.string().optional(),
  aspect: z.enum(['16:9', '9:16', '1:1']).optional(),
  resolution: z.enum(['720p', '1080p']).optional(),
  fps: z.number().int().min(12).max(60).optional(),
  script: z.string().optional(),
  notes: z.string().optional(),
  voice: voiceBody.optional(),
  subtitles: z.enum(['burn', 'srt', 'off']).optional(),
});

const shotBody = z.object({
  title: z.string().optional(),
  narration: z.string().optional(),
  visual: z.enum(['html', 'generated', 'asset']).optional(),
  prompt: z.string().optional(),
  asset: z.string().optional(),
  duration: z.number().positive().max(120).nullable().optional(),
  transition: z.enum(['cut', 'fade', 'slide']).optional(),
  motion: z.enum(['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right']).nullable().optional(),
  keepAudio: z.boolean().optional(),
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

// 终端 WebSocket 能往 Agent 的 shell 里打字：只接受本机页面发起的连接，挡住别的网站借浏览器连过来
const localOrigin = (origin: string | undefined) => !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

const terminalMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(64 * 1024) }),
  z.object({ type: z.literal('resize'), cols: z.number().int(), rows: z.number().int() }),
]);

const LIVE_PREFIXES = ['qa_', 'task_', 'proposal_', 'inbox_', 'run_started', 'run_finished', 'run_step', 'message_', 'thread_', 'entity_', 'agent_', 'workstation_', 'project_', 'terminal_', 'video_'];

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

    // ---- 命令实时输出：先给快照，再推本 channel 的 start / chunk / end ----
    .get('/live/:channel', (c) => {
      const channel = c.req.param('channel');
      if (!/^(task|qa|video):[\w-]+$/.test(channel)) return c.json({ error: 'channel 不合法' }, 400);
      return streamSSE(c, async (stream) => {
        // 先挂监听再发快照，中间的 start/chunk/end 不会漏
        const match = (p: Record<string, unknown>) => p.channel === channel;
        const offs = [
          events.on('live_start', async (p) => {
            if (match(p)) await stream.writeSSE({ event: 'start', data: JSON.stringify(p.stream) });
          }),
          events.on('live_output', async (p) => {
            if (match(p)) await stream.writeSSE({ event: 'chunk', data: JSON.stringify({ streamId: p.streamId, chunk: p.chunk }) });
          }),
          events.on('live_end', async (p) => {
            if (match(p)) await stream.writeSSE({ event: 'end', data: JSON.stringify({ streamId: p.streamId, exitCode: p.exitCode }) });
          }),
        ];
        await stream.writeSSE({ event: 'snapshot', data: JSON.stringify({ streams: liveSnapshot(channel) }) });
        await holdSSE(stream, () => offs);
      });
    })

    // ---- 项目 ----
    .get('/plugins', async (c) => c.json(await listPlugins(c.get('actor'), c.get('db'))))
    .patch('/plugins/:id', body(z.object({ enabled: z.boolean() })), async (c) => {
      const r = await setPluginEnabled(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').enabled);
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .get('/settings/models', (c) => c.json(publicModelConfig(readModelConfig())))
    .put('/settings/models', body(modelConfigBody), async (c) => {
      const { media, defaultTts, defaultVideo, ...next } = c.req.valid('json');
      const prev = readModelConfig();
      const nextMedia = media ? mergeProviders(media, prev.media) : prev.media;
      const tts = defaultTts === undefined ? prev.defaultTts : defaultTts.trim() || undefined;
      const video = defaultVideo === undefined ? prev.defaultVideo : defaultVideo.trim() || undefined;
      writeModelConfig({ ...next, providers: mergeProviders(next.providers, prev.providers), media: nextMedia, ...(tts ? { defaultTts: tts } : {}), ...(video ? { defaultVideo: video } : {}) });
      await reloadModels();
      return c.json({ ok: true });
    })
    .get('/settings/media', (c) => c.json(publicTtsProviders()))
    // 设置页「试听」：用表单里的当前值合成一句样例，直接回音频
    .post('/settings/media/test', body(mediaProviderBody.extend({ sampleVoice: z.string().optional() })), async (c) => {
      const { sampleVoice, ...input } = c.req.valid('json');
      const p = mergeProviders([input], readModelConfig().media)[0]!;
      if (p.kind !== 'tts') return fail(c, { error: '目前只能试听配音（tts）' });
      if (p.protocol === 'openai-speech' && !p.baseUrl) return fail(c, { error: '请填地址' });
      try {
        const r = await probeTts(p, sampleVoice);
        return c.body(new Uint8Array(r.audio), 200, { 'content-type': r.format === 'wav' ? 'audio/wav' : 'audio/mpeg', 'x-aw-duration': String(r.duration), 'x-aw-ms': String(r.ms), 'cache-control': 'no-store' });
      } catch (e) {
        return fail(c, { status: 502, error: `试听失败：${sanitizeError(e instanceof Error ? e.message : String(e))}` });
      }
    })    // 设置页「测试」：用表单里的当前值（可未保存）探测模型，不写配置、不进注册表
    .post('/settings/models/test', body(providerBody), async (c) => {
      const p = mergeProviders([c.req.valid('json')], readModelConfig().providers)[0]!;
      if (p.kind === 'openai-compatible' && !p.baseUrl) return fail(c, { error: '请填地址' });
      if (p.kind !== 'ollama' && !p.apiKey) return fail(c, { error: '请填 API Key' });
      const route = await buildRoute(p);
      return c.json(await probeModel(route));
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
      folder: z.string().trim().min(1).optional(),
      template: z.object({ repoPath: z.string().trim().min(1, '仓库路径不能为空'), targetBranch: z.string().optional(), baseBranch: z.string().optional(), commands: z.record(z.string(), z.string()).optional() }).optional(),
    })), async (c) => {
      const r = await createProject(c.get('actor'), c.get('db'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ id: r.id, rootWorkstationId: r.rootWorkstationId }, 201) : fail(c, r);
    })
    .get('/projects/:id', async (c) => {
      const d = await getProjectDetail(c.get('actor'), c.get('db'), c.req.param('id'));
      return d ? c.json(d) : fail(c, { status: 404, error: '项目不存在' });
    })
    .patch('/projects/:id', body(z.object({
      name: z.string().trim().min(1, '项目名不能为空').optional(),
      goal: z.string().nullable().optional(),
      budget: z.object({ tokens: z.number().int().positive().optional(), costMicros: z.number().int().positive().optional() }).nullable().optional(),
      folder: z.string().trim().min(1).nullable().optional(),
    })), async (c) => {
      const r = await updateProject(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/projects/:id/archive', async (c) => {
      const r = await setProjectArchived(c.get('actor'), c.get('db'), c.req.param('id'), true);
      return r.kind === 'ok' ? c.json({ ok: true, cancelled: r.cancelled }) : fail(c, r);
    })
    .post('/projects/:id/restore', async (c) => {
      const r = await setProjectArchived(c.get('actor'), c.get('db'), c.req.param('id'), false);
      return r.kind === 'ok' ? c.json({ ok: true, cancelled: r.cancelled }) : fail(c, r);
    })
    .delete('/projects/:id', async (c) => {
      const r = await deleteProject(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    // 项目文件夹：面板只读浏览；写文件走提案审批
    .get('/projects/:id/folder/files', pathQuery, async (c) => {
      const f = await projectFolderRoot(c.get('db'), c.req.param('id'));
      if (!f.ok) return fail(c, { status: f.error === '项目还没有绑定文件夹' ? 404 : 400, error: f.error });
      const r = listFolder(f.root, c.req.valid('query').path ?? '');
      return r.ok ? c.json({ entries: r.entries, truncated: r.truncated }) : fail(c, { error: r.error });
    })
    .get('/projects/:id/folder/file', pathQuery, async (c) => {
      const f = await projectFolderRoot(c.get('db'), c.req.param('id'));
      if (!f.ok) return fail(c, { status: f.error === '项目还没有绑定文件夹' ? 404 : 400, error: f.error });
      const r = readFolderFile(f.root, c.req.valid('query').path ?? '');
      return r.ok ? c.json(r) : fail(c, { error: r.error });
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
    .get('/projects/:id/status', async (c) => {
      const d = await getProjectStatus(c.get('actor'), c.get('db'), c.req.param('id'));
      return d ? c.json(d) : fail(c, { status: 404, error: '项目不存在' });
    })
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
    .post('/workstations/:id/repo/init', async (c) => {
      const r = await initRepo(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ ok: true, files: r.files }) : fail(c, r);
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
          startAt: z.string().nullable().optional(),
          dueAt: z.string().nullable().optional(),
          milestoneId: z.string().nullable().optional(),
          dependsOn: z.array(z.string()).optional(),
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
    .get('/workstations/:id/conversations', async (c) => c.json({ conversations: await listConversations(c.get('db'), c.req.param('id')) }))
    .post('/workstations/:id/conversations', body(z.object({ agentIds: z.array(z.string()).min(1), title: z.string().trim().max(60).optional() })), async (c) => {
      const r = await createConversation(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ thread: r.thread }, 201) : fail(c, r);
    })

    // ---- 设计台 ----
    .get('/workstations/:id/designs', async (c) => c.json(await listDesigns(c.get('db'), c.req.param('id'))))
    .post('/workstations/:id/designs', body(z.object({ title: z.string().trim().min(1, '标题不能为空'), html: z.string().trim().min(1, 'HTML 不能为空'), brief: z.string().optional() })), async (c) => {
      const r = await saveDesign(c.get('actor'), c.get('db'), c.req.param('id'), { ...c.req.valid('json'), reason: '导入 HTML' });
      return r.kind === 'ok' ? c.json({ id: r.id, warnings: r.warnings }, 201) : fail(c, r);
    })
    .delete('/designs/:id', async (c) => {
      const r = await deleteDesign(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .get('/designs/:id/export', async (c) => {
      const format = c.req.query('format') === 'pdf' ? 'pdf' : 'png';
      const viewport = (Object.keys(VIEWPORTS) as ViewportName[]).includes(c.req.query('viewport') as ViewportName) ? (c.req.query('viewport') as ViewportName) : 'desktop';
      const v = c.req.query('version');
      const doc = await renderableDesign(c.get('db'), c.req.param('id'), v ? Number(v) : undefined);
      if (!doc) return fail(c, { status: 404, error: '设计稿不存在' });
      let buf: Buffer;
      try {
        buf = await renderDesign(doc.html, { width: VIEWPORTS[viewport], format });
      } catch (e) {
        const msg = e instanceof Error ? e.message.split('\n')[0]! : String(e);
        return fail(c, BROWSER_MISSING.test(msg) ? { status: 409, error: '本机没有可用的 Chromium，运行 pnpm exec playwright install chromium 后重试' } : { status: 502, error: `渲染失败：${msg}` });
      }
      const name = encodeURIComponent(`${doc.title}-v${doc.version}`);
      return c.body(new Uint8Array(buf), 200, { 'content-type': format === 'pdf' ? 'application/pdf' : 'image/png', 'content-disposition': `attachment; filename*=UTF-8''${name}.${format}` });
    })
    .post('/designs/:id/handoff', body(z.object({ targetWorkstationId: z.string().min(1), module: z.string().trim().min(1, '请填改动范围'), priority: z.enum(['p0', 'p1', 'p2']), note: z.string().optional(), qaCases: z.boolean().optional(), pageUrl: z.string().trim().min(1).optional() })), async (c) => {
      const r = await handoffDesign(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ taskId: r.taskId }, 201) : fail(c, r);
    })

    // ---- 视频台 ----
    .get('/workstations/:id/videos', async (c) => c.json({ videos: await listVideos(c.get('db'), c.req.param('id')) }))
    .post('/workstations/:id/videos', body(videoBody.extend({ title: z.string().trim().min(1, '标题不能为空'), reason: z.string().optional() })), async (c) => {
      const r = await createVideo(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ id: r.id, version: r.version }, 201) : fail(c, r);
    })
    .get('/videos/:id', async (c) => {
      const v = c.req.query('version');
      const row = await videoRow(c.get('db'), c.req.param('id'));
      const d = row ? await getVideo(c.get('db'), row.workstationId, row.id, { version: v ? Number(v) : undefined }) : null;
      return d ? c.json(d) : fail(c, { status: 404, error: '视频不存在' });
    })
    .patch('/videos/:id', body(videoBody.extend({ baseVersion: z.number().int(), reason: z.string().optional() })), async (c) => {
      const row = await videoRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '视频不存在' });
      const r = await updateVideo(c.get('actor'), c.get('db'), row.workstationId, row.id, c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ id: r.id, version: r.version }) : fail(c, r);
    })
    .delete('/videos/:id', async (c) => {
      const r = await deleteVideo(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .put('/videos/:id/script', body(z.object({ script: z.string(), baseVersion: z.number().int(), reason: z.string().optional() })), async (c) => {
      const row = await videoRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '视频不存在' });
      const r = await saveScript(c.get('actor'), c.get('db'), row.workstationId, row.id, c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ id: r.id, version: r.version, lint: r.lint }) : fail(c, r);
    })
    .put('/videos/:id/storyboard', body(z.object({ shots: z.array(shotBody.extend({ id: z.string().optional(), html: z.string().optional() })).max(200), reason: z.string().optional() })), async (c) => {
      const row = await videoRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '视频不存在' });
      const r = await replaceStoryboard(c.get('actor'), c.get('db'), row.workstationId, row.id, c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ shots: r.shots, removed: r.removed, total: r.total, lint: r.lint }) : fail(c, r);
    })
    .post('/videos/:id/reorder', body(z.object({ ids: z.array(z.string()).min(1) })), async (c) => {
      const row = await videoRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '视频不存在' });
      const r = await reorderShots(c.get('actor'), c.get('db'), row.workstationId, row.id, c.req.valid('json').ids);
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/videos/:id/ask', body(z.object({ who: z.enum(['director', 'motion']), shotIds: z.array(z.string()).optional(), note: z.string().max(2000).optional() })), async (c) => {
      const r = await askVideoAgent(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ threadId: r.threadId }) : fail(c, r);
    })
    .post('/videos/:id/voice', body(z.object({ shotIds: z.array(z.string()).max(200).optional(), force: z.boolean().optional() })), async (c) => {
      const row = await videoRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '视频不存在' });
      const r = await voiceShots(c.get('actor'), c.get('db'), row.workstationId, row.id, c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ voiced: r.voiced, skipped: r.skipped, costMicros: r.costMicros, provider: r.provider, voice: r.voice, speed: r.speed }) : fail(c, r);
    })
    .get('/videos/:id/renders', async (c) => {
      const row = await videoRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '视频不存在' });
      return c.json({ renders: await listVideoRenders(c.get('db'), row.workstationId, row.id) });
    })
    .post('/videos/:id/renders', body(renderBody), async (c) => {
      const row = await videoRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '视频不存在' });
      const r = await createVideoRender(c.get('actor'), c.get('db'), row.workstationId, row.id, c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ id: r.id, status: r.status, total: r.total, width: r.width, height: r.height, fps: r.fps, subtitles: r.subtitles, warnings: r.warnings, channel: r.channel, gate: r.gate, override: r.override }, 201) : fail(c, r);
    })
    .get('/workstations/:id/video-renders', async (c) => c.json({ renders: await listVideoRenders(c.get('db'), c.req.param('id')) }))
    .get('/videos/:id/comments', async (c) => {
      const row = await videoRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '视频不存在' });
      return c.json({ comments: await listShotComments(c.get('db'), row.workstationId, row.id) });
    })
    .post('/videos/:id/comments', body(commentBody), async (c) => {
      const row = await videoRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '视频不存在' });
      const input = c.req.valid('json');
      const shot = await shotRow(c.get('db'), input.shot);
      if (!shot || shot.workstationId !== row.workstationId || (JSON.parse(shot.dataJson ?? '{}') as { video?: string }).video !== row.id) return fail(c, { status: 404, error: '镜头不属于这支视频' });
      const r = await addShotComment(c.get('actor'), c.get('db'), row.workstationId, input);
      return r.kind === 'ok' ? c.json({ id: r.id, shot: r.shot, version: r.version, time: r.time, severity: r.severity }, 201) : fail(c, r);
    })
    .post('/workstations/:id/video-comments/resolve', body(z.object({ ids: z.array(z.string()).min(1).max(100), note: z.string().max(2000).optional() })), async (c) => {
      const { ids, note } = c.req.valid('json');
      return c.json({ resolved: await resolveShotComments(c.get('actor'), c.get('db'), c.req.param('id'), ids, note) });
    })
    .post('/videos/:id/request-review', body(z.object({ note: z.string().max(2000).optional() })), async (c) => {
      const r = await requestVideoReview(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').note);
      return r.kind === 'ok' ? c.json({ threadId: r.threadId, status: r.status, contentHash: r.contentHash }) : fail(c, r);
    })
    .get('/workstations/:id/video-style', async (c) => c.json(await videoStyleOf(c.get('db'), c.req.param('id'))))
    .put('/workstations/:id/video-style', body(styleBody), async (c) => {
      const r = await saveVideoStyle(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      if (r.kind !== 'ok') return fail(c, r);
      const { id, version, name, palette, fonts, voice, bgm, bgmVolume, ducking, rules, subtitle } = r;
      return c.json({ id, version, name, palette, fonts, voice, bgm, bgmVolume, ducking, rules, subtitle });
    })
    .post('/workstations/:id/video-style/voice-test', body(voiceBody), async (c) => {
      try {
        const r = await sampleVoice(c.req.valid('json'));
        if ('error' in r) return fail(c, { status: 400, error: r.error });
        return c.body(new Uint8Array(r.audio), 200, { 'content-type': r.format === 'wav' ? 'audio/wav' : 'audio/mpeg', 'x-aw-duration': String(r.duration), 'cache-control': 'no-store' });
      } catch (e) {
        return fail(c, { status: 502, error: `试听失败：${sanitizeError(e instanceof Error ? e.message : String(e))}` });
      }
    })
    .get('/workstations/:id/media', async (c) => c.json({ media: await listVideoMedia(c.get('db'), c.req.param('id'), c.req.query('kind') || undefined) }))
    // 背景音乐上传：multipart 的 file 字段；大小先看 content-length 挡掉明显超限的，再按实际字节数校验
    .post('/workstations/:id/media', async (c) => {
      const len = Number(c.req.header('content-length') ?? 0);
      if (len > BGM_MAX_BYTES + 1024 * 1024) return fail(c, { status: 413, error: '背景音乐最大 30MB' });
      let form: Record<string, unknown>;
      try {
        form = await c.req.parseBody();
      } catch {
        return fail(c, { status: 400, error: '要用 multipart/form-data 上传，字段名 file' });
      }
      const file = form.file;
      if (!(file instanceof File)) return fail(c, { status: 400, error: '没有收到文件（字段名 file）' });
      if (file.size > BGM_MAX_BYTES) return fail(c, { status: 413, error: '背景音乐最大 30MB' });
      const r = await uploadBgm(c.get('actor'), c.get('db'), c.req.param('id'), { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      return r.kind === 'ok' ? c.json({ id: r.id, name: r.name, duration: r.duration, format: r.format, size: r.size }, 201) : fail(c, r);
    })
    // 素材：上传走 multipart（字段名 file），元数据可在同一次请求里带 license / tags
    .get('/workstations/:id/assets', async (c) => c.json({ assets: await listAssets(c.get('db'), c.req.param('id'), { kind: c.req.query('kind') || undefined }) }))
    .post('/workstations/:id/assets', async (c) => {
      const len = Number(c.req.header('content-length') ?? 0);
      if (len > ASSET_VIDEO_MAX + 1024 * 1024) return fail(c, { status: 413, error: '单个素材最大 200MB' });
      let form: Record<string, unknown>;
      try {
        form = await c.req.parseBody();
      } catch {
        return fail(c, { status: 400, error: '要用 multipart/form-data 上传，字段名 file' });
      }
      const file = form.file;
      if (!(file instanceof File)) return fail(c, { status: 400, error: '没有收到文件（字段名 file）' });
      if (file.size > ASSET_VIDEO_MAX) return fail(c, { status: 413, error: '单个素材最大 200MB' });
      const tags = typeof form.tags === 'string' && form.tags.trim() ? form.tags.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20) : undefined;
      const r = await uploadAsset(c.get('actor'), c.get('db'), c.req.param('id'), {
        name: file.name, bytes: new Uint8Array(await file.arrayBuffer()),
        license: typeof form.license === 'string' ? form.license : undefined, tags,
        notes: typeof form.notes === 'string' ? form.notes : undefined,
      });
      return r.kind === 'ok' ? c.json({ id: r.id, kind: r.assetKind, width: r.width ?? null, height: r.height ?? null, duration: r.duration ?? null, poster: r.poster ?? null }, 201) : fail(c, r);
    })
    .get('/assets/:id', async (c) => {
      const row = await entityRowOf(c.get('db'), c.req.param('id'));
      const a = row ? await getAsset(c.get('db'), row.workstationId, row.id) : null;
      return a ? c.json(a) : fail(c, { status: 404, error: '素材不存在' });
    })
    .patch('/assets/:id', body(z.object({ name: z.string().trim().max(60).optional(), license: z.string().max(500).optional(), tags: z.array(z.string().max(30)).max(20).optional(), notes: z.string().max(2000).optional(), baseVersion: z.number().int().optional() })), async (c) => {
      const row = await entityRowOf(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '素材不存在' });
      const r = await updateAsset(c.get('actor'), c.get('db'), row.workstationId, row.id, c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ id: r.id, version: r.version }) : fail(c, r);
    })
    .delete('/assets/:id', async (c) => {
      const row = await entityRowOf(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '素材不存在' });
      const r = await deleteAsset(c.get('actor'), c.get('db'), row.workstationId, row.id);
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    // 片段申请：Agent 只写申请，人在这里批 / 拒（批准会记账、提交生成）
    .get('/workstations/:id/clip-requests', async (c) => c.json({ requests: await listClipRequests(c.get('db'), c.req.param('id'), { videoId: c.req.query('videoId') || undefined, status: c.req.query('status') || undefined }) }))
    .get('/clip-requests/:id', async (c) => {
      const row = await entityRowOf(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '片段申请不存在' });
      const r = await readClipRequest(c.get('db'), row.workstationId, row.id);
      return r ? c.json(r) : fail(c, { status: 404, error: '片段申请不存在' });
    })
    .post('/clip-requests/:id/decide', body(z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().max(500).optional() })), async (c) => {
      const row = await entityRowOf(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '片段申请不存在' });
      const r = await decideClipRequest(c.get('actor'), c.get('db'), row.workstationId, row.id, c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ status: r.status }) : fail(c, r);
    })
    .post('/videos/:id/clip-requests', body(z.object({ shotId: z.string().min(1), prompt: z.string().trim().min(1, '提示词不能为空').max(4000), negativePrompt: z.string().max(2000).optional(), duration: z.number().positive().max(20).optional(), image: z.string().optional() })), async (c) => {
      const row = await videoRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '视频不存在' });
      const input = c.req.valid('json');
      const shot = await shotRow(c.get('db'), input.shotId);
      if (!shot || shot.workstationId !== row.workstationId) return fail(c, { status: 404, error: '镜头不存在' });
      const r = await requestClip(c.get('actor'), c.get('db'), row.workstationId, input);
      return r.kind === 'ok' ? c.json({ id: r.id, status: r.status, estimatedCostMicros: r.estimatedCostMicros, duration: r.duration, provider: r.provider }, 201) : fail(c, r);
    })
    .get('/video-renders/compare', async (c) => {
      const a = c.req.query('a');
      const b = c.req.query('b');
      if (!a || !b) return fail(c, { status: 400, error: '要给 a 和 b 两次出片的 id' });
      const ra = await getVideoRender(c.get('db'), a);
      if (!ra) return fail(c, { status: 404, error: '出片记录不存在' });
      const r = await compareVideoRenders(c.get('db'), ra.workstationId, a, b);
      return r.kind === 'ok' ? c.json(r.compare) : fail(c, r);
    })
    .get('/video-renders/:id', async (c) => {
      const r = await getVideoRender(c.get('db'), c.req.param('id'));
      return r ? c.json(r) : fail(c, { status: 404, error: '出片记录不存在' });
    })
    .post('/video-renders/:id/cancel', async (c) => {
      const r = await cancelVideoRender(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ status: r.status }) : fail(c, r);
    })
    // 媒体文件（配音 / 成片 / 字幕）：只认登记过的媒体产物，路径必须在媒体目录里；支持 Range 拖进度条
    .get('/media/:artifactId', async (c) => {
      const db = c.get('db');
      const a = await getArtifact(c.get('actor'), db, c.req.param('artifactId'));
      if (!a?.ref || !(MEDIA_TYPES as readonly string[]).includes(a.type ?? '') || !insideMedia(db, a.ref) || !fs.existsSync(a.ref)) return fail(c, { status: 404, error: '媒体文件不存在' });
      const size = fs.statSync(a.ref).size;
      const headers: Record<string, string> = { 'content-type': mimeOf(a.ref), 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' };
      if (c.req.query('download') === '1') {
        const meta = JSON.parse(a.metaJson ?? '{}') as { downloadName?: string };
        const ext = path.extname(a.ref);
        let name = safeFileName(meta.downloadName ?? a.name ?? 'media');
        if (!name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
        headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
      }
      const range = parseRange(c.req.header('range'), size);
      if (range === 'invalid') {
        c.header('content-range', `bytes */${size}`);
        return fail(c, { status: 416, error: '请求的范围不合法' });
      }
      if (size === 0) return c.body(new Uint8Array(), 200, headers);
      const [start, end] = range ?? [0, size - 1];
      headers['content-length'] = String(end - start + 1);
      if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
      const stream = Readable.toWeb(fs.createReadStream(a.ref, { start, end })) as ReadableStream<Uint8Array>;
      return c.body(stream, range ? 206 : 200, headers);
    })
    .patch('/shots/:id', body(shotBody.extend({ html: z.string().optional(), status: z.enum(['draft', 'ready']).optional(), baseVersion: z.number().int(), reason: z.string().optional() })), async (c) => {
      const row = await shotRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '镜头不存在' });
      const r = await updateShot(c.get('actor'), c.get('db'), row.workstationId, row.id, c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ id: r.id, version: r.version, duration: r.duration, lint: r.lint }) : fail(c, r);
    })
    // 前端播放器报上来的画面问题：来自沙箱里的代码，只当纯文本存
    .post('/shots/:id/issues', body(z.object({ version: z.number().int().min(1), items: z.array(z.string().max(300)).max(20) })), async (c) => {
      const row = await shotRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '镜头不存在' });
      const { version, items } = c.req.valid('json');
      if (version > row.version) return fail(c, { status: 400, error: '镜头版本不存在' });
      return c.json({ saved: await saveShotIssues(c.get('db'), row.id, version, items) });
    })
    .get('/shots/:id/frame', async (c) => {
      const v = c.req.query('version');
      const shot = await renderableShot(c.get('db'), c.req.param('id'), v ? Number(v) : undefined);
      if (!shot) return fail(c, { status: 404, error: '镜头不存在' });
      const t = Math.min(Math.max(0, Number(c.req.query('t') ?? 0) || 0), shot.duration);
      let png: Buffer;
      try {
        png = (await renderShotFrames(shot.doc, { width: shot.width, height: shot.height, times: [t] })).frames[0]!.png;
      } catch (e) {
        const msg = e instanceof Error ? e.message.split('\n')[0]! : String(e);
        return fail(c, BROWSER_MISSING.test(msg) ? { status: 409, error: '本机没有可用的 Chromium，运行 pnpm exec playwright install chromium 后重试' } : { status: 502, error: `渲染失败：${msg}` });
      }
      return c.body(new Uint8Array(png), 200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    })

    // ---- 文档台 ----
    .get('/workstations/:id/docs', async (c) => c.json({ docs: await listDocs(c.get('db'), c.req.param('id')) }))
    .get('/workstations/:id/doc-repos', async (c) => c.json({ repos: await listRepoSources(c.get('db'), c.req.param('id')) }))
    .post(
      '/workstations/:id/docs',
      body(z.object({
        title: z.string().trim().min(1, '标题不能为空'),
        kind: z.enum(['readme', 'api', 'guide', 'architecture', 'adr', 'release_notes', 'general']).optional(),
        brief: z.string().optional(),
        target_repo: z.string().optional(),
        target_path: z.string().optional(),
        content: z.string(),
        citations: z.array(jsonRecord).optional(),
        reason: z.string().optional(),
      })),
      async (c) => {
        const r = await saveDoc(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json') as never);
        return r.kind === 'ok' ? c.json({ id: r.id, version: r.version, status: r.status, lint: r.lint, citations: r.citations }, 201) : fail(c, r);
      },
    )
    .get('/docs/:id', async (c) => {
      const v = c.req.query('version');
      const row = await docRow(c.get('db'), c.req.param('id'));
      const d = row ? await readDoc(c.get('db'), row.workstationId, row.id, v ? Number(v) : undefined) : null;
      return d ? c.json(d) : fail(c, { status: 404, error: '文档不存在' });
    })
    .patch(
      '/docs/:id',
      body(z.object({
        title: z.string().trim().min(1).optional(),
        kind: z.enum(['readme', 'api', 'guide', 'architecture', 'adr', 'release_notes', 'general']).optional(),
        brief: z.string().optional(),
        target_repo: z.string().nullable().optional(),
        target_path: z.string().nullable().optional(),
        content: z.string().optional(),
        citations: z.array(jsonRecord).optional(),
        baseVersion: z.number().int(),
        reason: z.string().optional(),
      })),
      async (c) => {
        const { baseVersion, ...fields } = c.req.valid('json');
        const row = await docRow(c.get('db'), c.req.param('id'));
        if (!row) return fail(c, { status: 404, error: '文档不存在' });
        const r = await saveDoc(c.get('actor'), c.get('db'), row.workstationId, { id: row.id, ...fields, baseVersion } as never);
        return r.kind === 'ok' ? c.json({ id: r.id, version: r.version, status: r.status, lint: r.lint, citations: r.citations }) : fail(c, r);
      },
    )
    .post('/docs/:id/edit', body(z.object({ edits: z.array(z.object({ oldText: z.string(), newText: z.string() })).min(1), citations: z.array(jsonRecord).optional(), removeCitations: z.array(z.string()).optional(), reason: z.string().optional() })), async (c) => {
      const row = await docRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '文档不存在' });
      const r = await editDoc(c.get('actor'), c.get('db'), row.workstationId, row.id, c.req.valid('json') as never);
      return r.kind === 'ok' ? c.json({ id: r.id, version: r.version, status: r.status, lint: r.lint, citations: r.citations }) : fail(c, r);
    })
    .get('/docs/:id/comments', async (c) => {
      const row = await docRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '文档不存在' });
      return c.json({ comments: await listDocComments(c.get('db'), row.workstationId, row.id) });
    })
    .post('/docs/:id/comments', body(z.object({ quote: z.string().optional(), heading: z.string().optional(), body: z.string().trim().min(1, '评论不能为空'), severity: z.enum(['block', 'note']).optional() })), async (c) => {
      const row = await docRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '文档不存在' });
      const r = await addDocComment(c.get('actor'), c.get('db'), row.workstationId, { doc: row.id, ...c.req.valid('json') });
      return r.kind === 'ok' ? c.json({ id: r.id }, 201) : fail(c, r);
    })
    .post('/docs/:id/comments/resolve', body(z.object({ ids: z.array(z.string()).min(1), note: z.string().optional() })), async (c) => {
      const row = await docRow(c.get('db'), c.req.param('id'));
      if (!row) return fail(c, { status: 404, error: '文档不存在' });
      return c.json({ resolved: await resolveDocComments(c.get('actor'), c.get('db'), row.workstationId, c.req.valid('json').ids, c.req.valid('json').note) });
    })
    .get('/docs/:id/gate', async (c) => {
      const g = await docGate(c.get('db'), c.req.param('id'));
      return g ? c.json(g) : fail(c, { status: 404, error: '文档不存在' });
    })
    .post('/docs/:id/request-review', body(z.object({ who: z.enum(['fact-checker', 'doc-editor']) })), async (c) => {
      const r = await requestReview(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').who);
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/docs/:id/handoff', body(z.object({ module: z.string().trim().min(1, '请填改动范围'), priority: z.enum(['p0', 'p1', 'p2']), note: z.string().optional(), citations: z.enum(['strip', 'footnotes']).default('footnotes'), overrideReason: z.string().optional() })), async (c) => {
      const r = await handoffDoc(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ taskId: r.taskId, artifactId: r.artifactId }, 201) : fail(c, r);
    })
    .get('/docs/:id/export', async (c) => {
      const format = (['md', 'html', 'pdf'] as const).find((f) => f === c.req.query('format')) ?? 'md';
      const citations = c.req.query('citations') === 'strip' ? 'strip' : 'footnotes';
      const v = c.req.query('version');
      const row = await docRow(c.get('db'), c.req.param('id'));
      const doc = row ? await readDoc(c.get('db'), row.workstationId, row.id, v ? Number(v) : undefined) : null;
      if (!doc) return fail(c, { status: 404, error: '文档不存在' });
      const labels = await citationLabelsOf(c.get('db'), row!.workstationId, doc);
      const md = renderForRepo(doc.content ?? '', labels, citations);
      const name = encodeURIComponent(`${doc.title}-v${doc.version}`);
      if (format === 'md') {
        return c.body(md, 200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename*=UTF-8''${name}.md` });
      }
      const html = await docToHtml(md, `${doc.title} v${doc.version}`);
      if (format === 'html') {
        return c.body(html, 200, { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `attachment; filename*=UTF-8''${name}.html` });
      }
      let buf: Buffer;
      try {
        buf = await renderDesign(html, { width: 1024, format: 'pdf' });
      } catch (e) {
        const msg = e instanceof Error ? e.message.split('\n')[0]! : String(e);
        return fail(c, BROWSER_MISSING.test(msg) ? { status: 409, error: '本机没有可用的 Chromium，运行 pnpm exec playwright install chromium 后重试' } : { status: 502, error: `渲染失败：${msg}` });
      }
      return c.body(new Uint8Array(buf), 200, { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename*=UTF-8''${name}.pdf` });
    })
    .post('/docs/:id/drift/repoint', async (c) => {
      const r = await repointDocDrift(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ updated: r.updated }) : fail(c, r);
    })
    .post('/docs/:id/reverse/ack', async (c) => {
      const r = await ackDocReverse(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/docs/:id/reverse/import', async (c) => {
      const r = await importDocReverse(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ version: r.version, status: r.status, lint: r.lint }) : fail(c, r);
    })
    .get('/workstations/:id/doc-health', async (c) => c.json(await docHealth(c.get('db'), c.req.param('id'))))
    .get('/workstations/:id/docs-settings', async (c) => {
      const s = await docsSettingsOf(c.get('db'), c.req.param('id'));
      return s ? c.json(s) : fail(c, { status: 404, error: '文档工作台不存在' });
    })
    .put('/workstations/:id/docs-settings', body(z.object({ autoDraft: z.enum(['off', 'affected']) })), async (c) => {
      const r = await saveDocsSettings(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
    })
    .post('/workstations/:id/release-notes', body(z.object({ milestoneId: z.string().optional(), since: z.string().optional(), until: z.string().optional() })), async (c) => {
      const r = await draftReleaseNotes(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
      return r.kind === 'ok' ? c.json({ count: r.count }, 201) : fail(c, r);
    })
    .get('/workstations/:id/style-guide', async (c) => c.json(await styleGuideOf(c.get('db'), c.req.param('id'))))
    .put(
      '/workstations/:id/style-guide',
      body(z.object({
        name: z.string().trim().min(1).optional(),
        terms: z.array(z.object({ term: z.string().trim().min(1, '术语不能为空'), preferred: z.string(), avoid: z.array(z.string()) })).optional(),
        rules: z.string().optional(),
        lint: z.object({ maxHeadingDepth: z.number().int().positive().optional(), maxSentenceChars: z.number().int().positive().optional(), bannedWords: z.array(z.string()).optional(), requiredSections: z.array(z.string()).optional() }).optional(),
        baseVersion: z.number().int().optional(),
      })),
      async (c) => {
        const r = await saveStyleGuide(c.get('actor'), c.get('db'), c.req.param('id'), { ...c.req.valid('json'), reason: '人工修改' } as never);
        return r.kind === 'ok' ? c.json({ ok: true }) : fail(c, r);
      },
    )

    // ---- 质量（开发台的测试运行、用例、计划、缺陷） ----
    .get('/workstations/:id/qa/overview', async (c) => c.json(await getQaOverview(c.get('actor'), c.get('db'), c.req.param('id'))))
    .get('/workstations/:id/qa/runs', async (c) => c.json(await listQaRuns(c.get('actor'), c.get('db'), c.req.param('id'))))
    .post('/workstations/:id/qa/runs', body(z.object({ suiteId: z.string().min(1), ref: z.string().optional() })), async (c) => {
      const r = await startRun(c.get('actor'), c.get('db'), c.req.param('id'), { ...c.req.valid('json'), trigger: 'human' });
      return r.kind === 'ok' ? c.json({ id: r.id }, 201) : fail(c, r);
    })
    .get('/workstations/:id/qa-gate-suites', async (c) => c.json(await qaGateSuites(c.get('actor'), c.get('db'), c.req.param('id'))))
    .post('/workstations/:id/qa/suites', body(z.object({ id: z.string().optional(), baseVersion: z.number().int().optional(), data: z.object({ name: z.string().trim().min(1, '请填名称'), command: z.string().trim().min(1, '请填命令'), report_path: z.string().trim().min(1, '请填报告路径'), coverage_path: z.string().trim().optional(), timeout_sec: z.number().int().positive().optional(), auto_run: z.boolean().optional(), schedule: z.enum(['off', 'hourly', 'every6h', 'daily']).optional(), schedule_at: z.string().regex(/^\d{2}:\d{2}$/).optional(), description: z.string().optional() }) })), async (c) => {
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
    .patch(
      '/tasks/:id/plan',
      body(
        z.object({
          startAt: z.string().nullable().optional(),
          dueAt: z.string().nullable().optional(),
          milestoneId: z.string().nullable().optional(),
          dependsOn: z.array(z.string()).optional(),
        }),
      ),
      async (c) => {
        const r = await planTask(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json'));
        return r.kind === 'ok' ? c.json(r.task) : fail(c, r);
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
    .get('/tasks/:id/quality', async (c) => {
      const q = await taskQuality(c.get('db'), c.req.param('id'));
      return q ? c.json(q) : c.json({ error: '任务不存在' }, 404);
    })
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
    .post('/tasks/:id/preview', async (c) => {
      const r = await startPreview(c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json(r) : fail(c, r);
    })
    .get('/tasks/:id/preview', async (c) => c.json(previewStatus(c.req.param('id'))))
    .delete('/tasks/:id/preview', async (c) => {
      stopPreview(c.req.param('id'));
      return c.json({ status: 'stopped' });
    })
    .get('/tasks/:id/design-handoff', async (c) => {
      const t = (await c.get('db').select().from(task).where(eq(task.id, c.req.param('id'))))[0];
      const h = t ? await readHandoffFor(c.get('db'), t) : null;
      return h ? c.json({ title: h.title, version: h.version, html: h.html }) : fail(c, { status: 404, error: '这个任务没有交接的设计稿' });
    })

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
    .post('/threads/:id/archive', body(z.object({ archived: z.boolean() })), async (c) => {
      const r = await archiveThread(c.get('actor'), c.get('db'), c.req.param('id'), c.req.valid('json').archived);
      return r.kind === 'ok' ? c.json({ archivedAt: r.archivedAt }) : fail(c, r);
    })
    .get('/threads/:id/active', async (c) => {
      const th = (await c.get('db').select().from(thread).where(eq(thread.id, c.req.param('id'))))[0];
      if (!th) return fail(c, { status: 404, error: '会话不存在' });
      return c.json(await threadActivity(c.get('db'), th.id));
    })
    .post('/threads/:id/stop', async (c) => {
      const r = await stopThread(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ stopped: r.stopped }) : fail(c, r);
    })
    .post('/messages/:id/propose-adr', async (c) => {
      const r = await decisionToProposal(c.get('actor'), c.get('db'), c.req.param('id'));
      return r.kind === 'ok' ? c.json({ proposalId: r.proposalId }, 201) : fail(c, r);
    })
    .post('/threads/:id/messages', body(z.object({
      content: z.string().trim().min(1, '消息不能为空'),
      meta: z.object({
        design: z.object({ id: z.string(), title: z.string(), version: z.number().int() }),
        // 画布里选中的元素：客户端给的也要再截一遍，超长的截断不拒绝
        elements: z.array(z.object({
          selector: z.string().transform((s) => s.slice(0, 2000)),
          anchor: z.string().transform((s) => s.slice(0, 60)),
          tag: z.string().transform((s) => s.slice(0, 40)),
          html: z.string().transform((s) => s.slice(0, 1500)),
        })).transform((a) => a.slice(0, 8)).optional(),
      }).optional(),
    })), async (c) => {
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
          engine: z.string().min(1).nullable().optional(),
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
      return a ? c.json({ id: a.id, type: a.type, name: a.name, content: a.ref, meta: a.metaJson ? JSON.parse(a.metaJson) : null, createdAt: a.createdAt }) : fail(c, { status: 404, error: '产物不存在' });
    })

    // ---- 外部 harness：引擎探测、MCP 工具桥、回合结束上报、终端 ----
    .get('/harnesses', async (c) => c.json(await detectHarnesses(c.req.query('refresh') === '1')))
    .all('/mcp', async (c) => handleMcp(c.get('db'), c.req.raw))
    .post('/harness/turn', body(z.object({ source: z.string(), payload: jsonRecord })), async (c) => {
      const ok = await handleTurn(c.get('db'), bearerOf(c.req.raw), c.req.valid('json').payload);
      return ok ? c.json({ ok: true }) : fail(c, { status: 401, error: 'run token 无效或会话已结束' });
    })
    .get('/terminals', (c) => c.json(listTerminals({ taskId: c.req.query('taskId'), threadId: c.req.query('threadId'), agentId: c.req.query('agentId') })))
    .get('/terminals/:id', async (c) => {
      const id = c.req.param('id');
      const info = terminalInfo(id);
      if (info) return c.json({ info, log: info.alive ? null : terminalBuffer(id) });
      // 服务重启后内存里的会话没了，回放落盘的终端记录
      const rows = await c.get('db').select().from(artifact).where(eq(artifact.type, 'terminal_log'));
      const saved = rows.find((a) => (JSON.parse(a.metaJson ?? '{}') as { runId?: string }).runId === id);
      return saved ? c.json({ info: null, log: saved.ref }) : fail(c, { status: 404, error: '终端不存在' });
    })
    .get(
      '/terminals/:id/ws',
      async (c, next) => (localOrigin(c.req.header('origin')) ? next() : c.json({ error: '只接受本机页面的连接' }, 403)),
      upgradeWebSocket((c) => {
        const id = c.req.param('id') ?? '';
        let off = () => {};
        return {
          onOpen(_e, ws) {
            const info = terminalInfo(id);
            ws.send(JSON.stringify({ type: 'snapshot', data: terminalBuffer(id) ?? '', alive: info?.alive ?? false, exitCode: info?.exitCode ?? null }));
            off = subscribeTerminal(id, (e) => ws.send(JSON.stringify(e)));
          },
          onMessage(e) {
            let parsed: unknown;
            try { parsed = JSON.parse(String(e.data)); } catch { return; }
            const m = terminalMessage.safeParse(parsed);
            if (!m.success) return;
            if (m.data.type === 'input') writeTerminal(id, m.data.data);
            else resizeTerminal(id, m.data.cols, m.data.rows);
          },
          onClose() { off(); },
        };
      }),
    );

  return { app, routes };
}

export type AppType = ReturnType<typeof createApp>['routes'];
