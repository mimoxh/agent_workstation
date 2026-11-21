import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType, type WebSocketServerLike } from '@hono/node-server';
import { and, eq } from 'drizzle-orm';
import { WebSocket as WsClient, WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb, migrateDb, type DB } from '../src/db/client.js';
import { agent, artifact, inboxItem, message, run, task, workstation } from '../src/db/schema.js';
import { seed } from '../src/db/seed.js';
import { loadPlugins } from '../src/plugins.js';
import { claudeCode } from '../src/runtime/harness/claude_code.js';
import { codex } from '../src/runtime/harness/codex.js';
import type { HarnessSpec } from '../src/runtime/harness/types.js';
import { triggerThreadRun } from '../src/runtime/scheduler.js';
import { killAllTerminals, terminalBuffer, terminalInfo } from '../src/runtime/terminal.js';
import { executeTool, type ToolCtx } from '../src/runtime/tools/index.js';
import { buildPermCtx } from '../src/usecases/index.js';
import { dmThreadOf } from '../src/usecases/threads.js';
import { createFixtureRepo } from './fixtures.js';

let db: DB;
let app: ReturnType<typeof createApp>['app'];
let server: ServerType;
let base = '';
let agentId = '';
let threadId = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor 超时');
    await sleep(100);
  }
}
const runRow = async (id: string) => (await db.select().from(run).where(eq(run.id, id)))[0]!;
// run 行在入队执行时才插入：还没有这行也算没结束
const finished = (id: string) => waitFor(async () => { const r = (await db.select().from(run).where(eq(run.id, id)))[0]; return r && r.status !== 'running' ? r : null; });
const traceOf = (r: { traceJson: string | null }) => JSON.parse(r.traceJson ?? '[]') as { type: string; name?: string; text?: string; error?: string }[];

async function startRun() {
  const r = await triggerThreadRun(db, agentId, threadId, 'mentioned');
  expect(r.ok, r.error).toBe(true);
  return r.runId!;
}

beforeAll(async () => {
  process.env.AW_HARNESS_DIR = mkdtempSync(path.join(tmpdir(), 'aw-harness-test-'));
  loadPlugins();
  const r = createDb(':memory:');
  db = r.db;
  migrateDb(r.sqlite);
  await seed(db);
  app = createApp(db).app;
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1', websocket: { server: new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike } }, (info: AddressInfo) => resolve(info.port));
  });
  base = `http://127.0.0.1:${port}`;
  process.env.AW_INTERNAL_URL = base;
  const dev = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!;
  agentId = (await db.select().from(agent).where(and(eq(agent.workstationId, dev.id), eq(agent.isSteward, 1))))[0]!.id;
  threadId = (await dmThreadOf(db, agentId))!.id;
});

afterAll(() => {
  killAllTerminals();
  server?.close();
});

describe('Agent 运行引擎设置', () => {
  it('PATCH 只接受已登记的引擎，builtin 存为空', async () => {
    const patch = (engine: string | null) => app.request(`/api/agents/${agentId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine }) });
    expect((await patch('nope')).status).toBe(400);
    expect((await patch('builtin')).status).toBe(200);
    expect((await db.select().from(agent).where(eq(agent.id, agentId)))[0]!.engine).toBeNull();
    expect((await patch('fake')).status).toBe(200);
    expect((await db.select().from(agent).where(eq(agent.id, agentId)))[0]!.engine).toBe('fake');
  });

  it('/api/harnesses 列出适配器和安装状态', async () => {
    const list = (await (await app.request('/api/harnesses')).json()) as { id: string; installed: boolean }[];
    expect(list.map((h) => h.id)).toEqual(expect.arrayContaining(['claude-code', 'codex', 'fake']));
    expect(list.find((h) => h.id === 'fake')!.installed).toBe(true);
  });
});

describe('外部 harness 运行', () => {
  let firstRun = '';
  let firstSession = '';

  it('一回合：经 MCP 调平台工具、回合结束上报、记账留痕，终端保持打开', async () => {
    firstRun = await startRun();
    const r = await finished(firstRun);
    expect(r.status).toBe('completed');
    expect(r.engine).toBe('fake');
    expect(r.provider).toBe('fake');
    expect(r.sessionId).toBeTruthy();
    firstSession = r.sessionId!;
    expect(r.tokensIn).toBe(120);
    expect(r.tokensOut).toBe(30);
    const steps = traceOf(r);
    expect(steps.find((s) => s.type === 'tool' && s.name === 'send_message')?.error).toBeUndefined();
    expect(steps.some((s) => s.type === 'model' && s.text === 'fake harness 完成')).toBe(true);
    const msgs = (await db.select().from(message).where(eq(message.threadId, threadId))).map((m) => m.content);
    expect(msgs).toEqual(expect.arrayContaining(['fake harness 收到任务', 'fake harness 完成']));
    expect(terminalInfo(firstRun)?.alive).toBe(true);
    const listed = (await (await app.request(`/api/terminals?threadId=${threadId}`)).json()) as { id: string }[];
    expect(listed.map((t) => t.id)).toContain(firstRun);
  });

  it('再次唤醒：按会话 id 续跑，旧终端先关掉', async () => {
    const second = await startRun();
    const r = await finished(second);
    expect(r.status).toBe('completed');
    expect(r.sessionId).toBe(firstSession);
    await waitFor(() => terminalInfo(firstRun)?.alive === false);
    expect(terminalInfo(second)?.alive).toBe(true);

    // 人在终端里继续：输入转给 PTY，后续回合只记账，退出后终端记录落盘
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/terminals/${second}/ws`);
    const got: { type: string; data?: string }[] = [];
    ws.addEventListener('message', (e) => got.push(JSON.parse(String(e.data)) as { type: string; data?: string }));
    await waitFor(() => got.find((m) => m.type === 'snapshot'));
    expect(got[0]!.data).toContain('fake harness');
    ws.send(JSON.stringify({ type: 'input', data: 'again\r' }));
    await waitFor(async () => traceOf(await runRow(second)).filter((s) => s.type === 'model').length >= 2);
    ws.send(JSON.stringify({ type: 'input', data: 'quit\r' }));
    await waitFor(() => got.find((m) => m.type === 'exit'));
    ws.close();
    expect((await runRow(second)).status).toBe('completed');
    await waitFor(async () => (await db.select().from(artifact).where(eq(artifact.type, 'terminal_log'))).find((a) => a.metaJson?.includes(second)));
    const body = (await (await app.request(`/api/terminals/${second}`)).json()) as { log: string };
    expect(body.log).toContain('echo');
  });

  it('回合结束前进程退出：run 记为失败并进收件箱', async () => {
    process.env.AW_FAKE_MODE = 'exit';
    try {
      const id = await startRun();
      const r = await finished(id);
      expect(r.status).toBe('error');
      expect(r.error).toContain('退出码 3');
      const inbox = await db.select().from(inboxItem).where(and(eq(inboxItem.kind, 'run_failed'), eq(inboxItem.refId, id)));
      expect(inbox.length).toBe(1);
    } finally {
      delete process.env.AW_FAKE_MODE;
    }
  });

  it('人工取消：杀掉终端，run 记为 cancelled', async () => {
    process.env.AW_FAKE_MODE = 'hang';
    try {
      const id = await startRun();
      await waitFor(() => terminalInfo(id)?.alive);
      await waitFor(async () => traceOf(await runRow(id)).some((s) => s.name === 'send_message'));
      await waitFor(() => terminalBuffer(id)?.includes('child: '));
      const res = await app.request(`/api/runs/${id}/cancel`, { method: 'POST' });
      expect(res.status).toBe(200);
      const r = await finished(id);
      expect(r.status).toBe('cancelled');
      await waitFor(() => terminalInfo(id)?.alive === false);
      const child = Number(/child: (\d+)/.exec(terminalBuffer(id) ?? '')?.[1]);
      expect(child).toBeGreaterThan(0);
      const gone = () => { try { process.kill(child, 0); return false; } catch { return true; } };
      await waitFor(gone);
    } finally {
      delete process.env.AW_FAKE_MODE;
    }
  });

  it('时间预算用完：run 记为 interrupted / timeout', async () => {
    process.env.AW_FAKE_MODE = 'hang';
    await db.update(agent).set({ budgetJson: JSON.stringify({ minutes: 0.02 }) }).where(eq(agent.id, agentId));
    try {
      const id = await startRun();
      const r = await finished(id);
      expect(r.status).toBe('interrupted');
      expect(r.stopReason).toBe('timeout');
      await waitFor(() => terminalInfo(id)?.alive === false);
    } finally {
      delete process.env.AW_FAKE_MODE;
      await db.update(agent).set({ budgetJson: null }).where(eq(agent.id, agentId));
    }
  });

  it('MCP 与回合上报只认 run token', async () => {
    const mcp = await app.request('/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    expect(mcp.status).toBe(401);
    const turn = await app.request('/api/harness/turn', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: JSON.stringify({ source: 'fake', payload: {} }) });
    expect(turn.status).toBe(401);
  });

  it('终端 WebSocket 拒绝外站来源', async () => {
    const status = await new Promise<number>((resolve) => {
      const ws = new WsClient(`${base.replace('http', 'ws')}/api/terminals/x/ws`, { origin: 'https://evil.example' });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => { ws.close(); resolve(101); });
      ws.on('error', () => {});
    });
    expect(status).toBe(403);
  });
});

describe('适配器启动参数与用量解析', () => {
  const spec = (over: Partial<HarnessSpec> = {}): HarnessSpec => {
    const runDir = mkdtempSync(path.join(tmpdir(), 'aw-spec-'));
    return {
      runId: 'r1', title: 't', cwd: 'C:/wt', runDir, contextFile: path.join(runDir, 'context.md'), prompt: '先读说明', systemHint: 'hint',
      mcpUrl: 'http://127.0.0.1:1/api/mcp', token: 'tok', hook: { node: 'C:\\node.exe', script: 'C:\\h.mjs', url: 'http://127.0.0.1:1/api/harness/turn' },
      sessionId: 'sid', resume: false, writer: true, extraWritable: ['C:/repo/.git'], ...over,
    };
  };

  it('Claude Code：首条消息在最前，不弹确认，禁直接提交和推送，指定模型传 --model', () => {
    const w = claudeCode.launch('claude.exe', spec({ model: 'sonnet' }));
    expect(w.args[0]).toBe('先读说明');
    expect(w.args).toEqual(expect.arrayContaining(['--session-id', 'sid', '--model', 'sonnet', '--strict-mcp-config', '--permission-mode', 'dontAsk', 'Bash', 'Edit', 'Bash(git push:*)', 'Bash(git commit:*)', 'C:/repo/.git']));
    const r = claudeCode.launch('claude.exe', spec({ writer: false, resume: true, model: null }));
    expect(r.args).toEqual(expect.arrayContaining(['--resume', 'sid', 'Bash(git diff:*)']));
    expect(r.args).not.toContain('--model');
    expect(r.args).not.toContain('Edit');
    expect(r.args).not.toContain('Bash');
  });

  it('Codex：写者 workspace-write，只读者 read-only，续跑用 resume 子命令，指定模型传 -m', () => {
    const s = spec({ sessionId: null, model: 'gpt-6.1-sol' });
    const w = codex.launch('codex.exe', s);
    expect(w.args.slice(0, 8)).toEqual(['-C', 'C:/wt', '-s', 'workspace-write', '-a', 'never', '-m', 'gpt-6.1-sol']);
    expect(w.args).toEqual(expect.arrayContaining([
      '--add-dir', s.runDir,
      '--add-dir', 'C:/repo/.git',
      'check_for_update_on_startup=false',
      'mcp_servers.aw.url="http://127.0.0.1:1/api/mcp"',
      'mcp_servers.aw.default_tools_approval_mode="approve"',
    ]));
    expect(w.args.find((a) => a.startsWith('projects='))).toContain('"C:/wt"={trust_level="trusted"}');
    expect(w.args.find((a) => a.startsWith('notify='))).toBe('notify=["C:/node.exe", "C:/h.mjs", "codex", "http://127.0.0.1:1/api/harness/turn", "tok"]');
    expect(w.args.at(-1)).toBe('先读说明');
    const r = codex.launch('codex.exe', spec({ writer: false, resume: true, sessionId: 'th-1', model: null }));
    expect(r.args.slice(0, 2)).toEqual(['resume', 'th-1']);
    expect(r.args).toContain('read-only');
    expect(r.args).not.toContain('-m');
    expect(r.args).not.toContain('--add-dir');
  });

  it('Codex 模型列表：读 config.toml 默认模型与 models_cache.json 可见项', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'aw-codex-models-'));
    writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6.1-sol"\n[desktop]\nmodel = "ignored"\n');
    writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: [
        { slug: 'm-hidden', display_name: 'Hidden', visibility: 'hide', priority: 0 },
        { slug: 'm-b', display_name: 'Model B', visibility: 'list', priority: 2 },
        { slug: 'm-a', display_name: 'Model A', visibility: 'list', priority: 1 },
      ],
    }));
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      expect(codex.models?.()).toEqual({
        defaultModel: 'gpt-6.1-sol',
        models: [
          { id: 'm-a', label: 'Model A (m-a)' },
          { id: 'm-b', label: 'Model B (m-b)' },
        ],
      });
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });

  it('Codex 用量：会话累计值减去 run 开始前的累计', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'aw-codex-home-'));
    const t = new Date();
    const dir = path.join(home, 'sessions', String(t.getFullYear()), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0'));
    mkdirSync(dir, { recursive: true });
    const tc = (ts: string, input: number, cached: number, output: number) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
    writeFileSync(path.join(dir, 'rollout-2026-th-9.jsonl'), [tc('2026-01-01T00:00:00Z', 1000, 200, 50), tc('2026-01-02T00:00:00Z', 3000, 700, 150)].join('\n'));
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const rep = await codex.parseTurn({ 'thread-id': 'th-9', 'last-assistant-message': 'done' }, '2026-01-01T12:00:00Z');
      expect(rep).toEqual({ sessionId: 'th-9', lastMessage: 'done', usage: { inputTokens: 1500, outputTokens: 100 } });
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });

  it('Claude 用量：transcript 按消息 id 去重，只算本 run 开始之后', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aw-claude-tr-'));
    const file = path.join(dir, 's.jsonl');
    const line = (id: string, ts: string, inT: number, out: number, text?: string) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, usage: { input_tokens: inT, cache_creation_input_tokens: 5, cache_read_input_tokens: 999, output_tokens: out }, content: text ? [{ type: 'text', text }] : [] } });
    writeFileSync(file, [line('old', '2026-01-01T00:00:00Z', 100, 10, 'old'), line('m1', '2026-01-02T00:00:00Z', 10, 1), line('m1', '2026-01-02T00:00:01Z', 10, 4, '答复'), line('m2', '2026-01-02T00:00:02Z', 20, 6)].join('\n'));
    const rep = await claudeCode.parseTurn({ session_id: 's', transcript_path: file }, '2026-01-01T12:00:00Z');
    expect(rep).toEqual({ sessionId: 's', lastMessage: '答复', usage: { inputTokens: 40, outputTokens: 10 } });
  });
});

describe('submit_change 送审前复查范围', () => {
  it('分支上有越界提交就拒绝送审，范围内的照常提交', async () => {
    const repo = createFixtureRepo();
    const g = (args: string[]) => execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@f.local', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
    const base = g(['rev-parse', 'HEAD']);
    g(['branch', 'develop']);
    const dev = (await db.select().from(workstation).where(eq(workstation.pluginId, 'dev')))[0]!;
    const fe = (await db.select().from(agent).where(and(eq(agent.workstationId, dev.id), eq(agent.templateId, 'frontend-dev'))))[0]!;
    const taskId = crypto.randomUUID();
    await db.insert(task).values({
      id: taskId, projectId: dev.projectId, workstationId: dev.id, typeId: 'dev.issue', title: 'scope', inputJson: JSON.stringify({ module: 'src/board' }),
      status: 'in_progress', assigneeType: 'agent', assigneeId: fe.id, createdAt: new Date().toISOString(),
      codeRefJson: JSON.stringify({ worktree: repo, branch: 'main', base_sha: base }),
    });
    const runId = crypto.randomUUID();
    await db.insert(run).values({ id: runId, agentId: fe.id, taskId, status: 'running', provider: 'fake', model: 'harness', startedAt: new Date().toISOString(), tokensIn: 0, tokensOut: 0, traceJson: '[]' });
    const actor = { type: 'agent' as const, id: fe.id };
    const ctx = async (): Promise<ToolCtx> => ({ db, actor, permCtx: await buildPermCtx(actor, db), agent: fe, task: (await db.select().from(task).where(eq(task.id, taskId)))[0]!, run: await runRow(runId) });

    writeFileSync(path.join(repo, 'outside.txt'), 'x\n');
    g(['add', '-A']);
    g(['commit', '-m', 'outside']);
    const bad = (await executeTool(await ctx(), 'submit_change', { summary: 's' })) as { error?: string };
    expect(bad.error).toContain('越出 Module 范围');
    expect(bad.error).toContain('outside.txt');

    g(['reset', '--hard', base]);
    writeFileSync(path.join(repo, 'src', 'board', 'index.txt'), 'changed\n');
    g(['add', '-A']);
    g(['commit', '-m', 'inside']);
    const ok = (await executeTool(await ctx(), 'submit_change', { summary: 's' })) as { proposalId?: string; error?: string };
    expect(ok.error).toBeUndefined();
    expect(ok.proposalId).toBeTruthy();
  });
});
