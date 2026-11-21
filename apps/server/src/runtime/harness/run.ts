import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { artifact, run } from '../../db/schema.js';
import { events } from '../../events.js';
import { pushInbox, pushRunFailure } from '../../usecases/inbox.js';
import { postMessage, taskThreadOf } from '../../usecases/threads.js';
import { budgetBreach, describeBreach } from '../budget.js';
import { addUsage, appendTrace, budgetOf, minutesOf, trackRun, type StopReason } from '../loop.js';
import { sanitizeError } from '../models.js';
import { killTerminalsWhere, onTerminalExit, startTerminal, terminalBuffer, type TerminalInfo } from '../terminal.js';
import { toolSchemasFor, type RunCtx } from '../tools/index.js';
import type { AgentRow, TaskRow } from '../types.js';
import { HOOK_SOURCE } from './scripts.js';
import { NATIVE_TOOLS, type HarnessAdapter, type HarnessSpec, type TurnReport } from './types.js';

interface ActiveHarness {
  token: string;
  runId: string;
  adapter: HarnessAdapter;
  ctx: RunCtx;
  startedAt: string;
  sessionId: string | null;
  counted: { in: number; out: number };
  // 第一回合结束前由 runHarness 接管；之后的回合（人在终端里继续）只记账和留痕
  onFirstTurn: ((r: TurnReport) => Promise<void>) | null;
}

const byToken = new Map<string, ActiveHarness>();
export const harnessByToken = (token: string) => byToken.get(token) ?? null;

const now = () => new Date().toISOString();

export const internalUrl = () => process.env.AW_INTERNAL_URL ?? `http://127.0.0.1:${process.env.AW_PORT ?? 8787}`;
const harnessRoot = () => process.env.AW_HARNESS_DIR ?? path.join(os.tmpdir(), 'aw-harness');

export function bridgedTools(a: AgentRow) {
  return toolSchemasFor(JSON.parse(a.toolsJson ?? '[]') as string[]).filter((t) => !NATIVE_TOOLS.has(t.name));
}

// 平台进程的环境里有 AW_* 配置和 pnpm 注入的变量，不能漏给 harness；harness 自己的登录凭据（ANTHROPIC_API_KEY 等）照常透传
function harnessEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || (k.startsWith('AW_') && k !== 'AW_FAKE_MODE')) continue;
    if (/^npm_|^pnpm_|^PNPM_/i.test(k) || k === 'INIT_CWD' || k.startsWith('GIT_CONFIG')) continue;
    out[k] = v;
  }
  return { ...out, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...extra };
}

function gitCommonDir(worktree: string): string | null {
  try {
    const dir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: worktree, encoding: 'utf8', windowsHide: true }).trim();
    return dir ? path.resolve(worktree, dir) : null;
  } catch {
    return null;
  }
}

function briefing(o: { agent: AgentRow; label: string; tools: string[]; writer: boolean; worktree: string | null; system: string; userContent: string }) {
  const has = (n: string) => o.tools.includes(n);
  const lines = [
    '# 你在 Agent Workstation 里工作',
    `你是「${o.agent.name}」，由平台通过 ${o.label} 启动。平台的协作工具在 MCP 服务「aw」上：${o.tools.join('、') || '（无）'}。`,
    o.worktree
      ? o.writer
        ? '当前目录是这个任务的 git worktree，分支已经建好。用你自己的工具读写代码、跑命令，只改任务范围内的文件。'
        : '当前目录是这个任务的 git worktree。这次你只读不写，不要修改任何文件。'
      : '这次没有代码目录，只需要在会话里回应。',
    has('git_commit') ? '提交用 aw 的 git_commit（平台会做范围检查并记录你的身份），不要直接 git commit，也不要 git push。' : '',
    has('submit_change') ? '实现并提交后调用 submit_change 送审；不送审，任务不会往下走。' : '',
    has('review_change') ? '审查结论用 review_change 提交。' : '',
    has('report_blocked') ? '缺信息或卡住时调用 report_blocked，说清缺什么、试过什么，不要猜。' : '',
    has('request_human') ? '需要人拍板时调用 request_human。' : '',
    has('send_message') ? '在会话里回话用 send_message。' : '',
    '做完后用一两句话总结，然后停下等待下一条消息，不要退出会话。',
    '',
    '# 角色与规则',
    o.system,
    '',
    '# 本次输入',
    o.userContent,
  ];
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n');
}

// 同一 Agent 在同一任务 / 会话上的上一次 harness 会话：再次被唤醒时接着这个会话继续
export async function lastSessionOf(db: DB, agentId: string, engine: string, scope: { taskId?: string | undefined; threadId?: string | undefined }) {
  const where = and(eq(run.agentId, agentId), eq(run.engine, engine), isNotNull(run.sessionId), scope.taskId ? eq(run.taskId, scope.taskId) : eq(run.threadId, scope.threadId ?? ''));
  const r = (await db.select({ sessionId: run.sessionId }).from(run).where(where).orderBy(desc(run.startedAt)).limit(1))[0];
  return r?.sessionId ?? null;
}

// 续跑前先停掉还开着的旧终端：同一个会话不能被两个进程同时写
async function closePrevious(agentId: string, scope: { taskId?: string | undefined; threadId?: string | undefined }) {
  const match = (t: TerminalInfo) => t.agentId === agentId && (scope.taskId ? t.taskId === scope.taskId : t.threadId === scope.threadId);
  const waits: Promise<void>[] = [];
  killTerminalsWhere((t) => {
    if (!match(t)) return false;
    waits.push(new Promise((resolve) => { onTerminalExit(t.id, () => resolve()); }));
    return true;
  });
  await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 3000))]);
}

async function saveLog(db: DB, h: { runId: string; ctx: RunCtx; title: string }) {
  const log = terminalBuffer(h.runId);
  if (!log) return;
  await db.insert(artifact).values({
    id: crypto.randomUUID(), workstationId: h.ctx.agent.workstationId, taskId: h.ctx.task?.id ?? null, type: 'terminal_log',
    name: h.title, ref: log, metaJson: JSON.stringify({ runId: h.runId }), createdAt: now(),
  });
}

export async function runHarness(o: {
  db: DB;
  ctx: RunCtx;
  adapter: HarnessAdapter;
  system: string;
  userContent: string;
  agentRow: AgentRow;
  taskRow: TaskRow | null;
  projectId?: string | undefined;
  worktree?: string | null | undefined;
  pluginDefaultTokens?: number | undefined;
  pluginDefaultMinutes?: number | undefined;
}): Promise<{ stopReason: StopReason; runId: string }> {
  const { db, ctx, adapter, agentRow: a, taskRow: t } = o;
  const runId = ctx.run.id;
  const taskId = t?.id ?? null;
  const threadId = ctx.thread?.id ?? null;
  const projectId = t?.projectId ?? o.projectId ?? null;
  const title = `${a.name} · ${adapter.label}`;
  let scopeBreach = false;
  let stopReason: StopReason = 'error';
  let finished = false;

  events.emit('run_started', { runId, agentId: a.id, taskId });

  const finish = async (reason: StopReason, err?: string) => {
    if (finished) return;
    finished = true;
    stopReason = reason;
    const status = reason === 'completed' ? 'completed' : reason === 'timeout' ? 'interrupted' : reason === 'cancelled' ? 'cancelled' : 'error';
    await db.update(run).set({ status, stopReason: reason, endedAt: now(), error: err ? sanitizeError(err) : null }).where(eq(run.id, runId));
    events.emit('run_finished', { runId, agentId: a.id, taskId, stopReason: reason });
    if (reason !== 'completed' && reason !== 'cancelled' && projectId && !scopeBreach) {
      await pushRunFailure(db, projectId, runId, `${a.id}:${taskId ?? threadId ?? ''}`, err ? { reason: sanitizeError(err) } : undefined);
    }
  };

  const bin = adapter.resolveBin();
  if (!bin) {
    await finish('error', `${adapter.label} 没有安装或不在 PATH 上`);
    return { stopReason, runId };
  }

  const scope = { taskId: taskId ?? undefined, threadId: threadId ?? undefined };
  const resumeId = await lastSessionOf(db, a.id, adapter.id, scope);
  await closePrevious(a.id, scope);

  const worktree = o.worktree ?? null;
  const writer = !!worktree && !!t && (!t.assigneeId || t.assigneeId === a.id || ctx.run.trigger === 'stage_enter');
  const runDir = path.join(harnessRoot(), runId);
  mkdirSync(runDir, { recursive: true });
  const tools = bridgedTools(a).map((x) => x.name);
  const contextFile = path.join(runDir, 'context.md');
  writeFileSync(contextFile, briefing({ agent: a, label: adapter.label, tools, writer, worktree, system: o.system, userContent: o.userContent }));
  const hookScript = path.join(runDir, 'hook.mjs');
  writeFileSync(hookScript, HOOK_SOURCE);
  const common = writer && worktree ? gitCommonDir(worktree) : null;

  const token = crypto.randomUUID();
  const sessionId = resumeId ?? (adapter.presetSession ? crypto.randomUUID() : null);
  const model = (() => {
    if (!a.modelJson) return null;
    try {
      const m = JSON.parse(a.modelJson) as { provider?: string; name?: string };
      return m.provider === adapter.id && typeof m.name === 'string' && m.name.trim() ? m.name.trim() : null;
    } catch { return null; }
  })();
  const spec: HarnessSpec = {
    runId, title, cwd: worktree ?? runDir, runDir, contextFile,
    prompt: `先完整阅读任务说明 ${contextFile.replace(/\\/g, '/')}，再按其中的要求开始工作。`,
    systemHint: `你是 Agent Workstation 平台里的「${a.name}」。任务说明在 ${contextFile.replace(/\\/g, '/')}，平台工具在 MCP 服务 aw 上。`,
    mcpUrl: `${internalUrl()}/api/mcp`, token,
    hook: { node: process.execPath, script: hookScript, url: `${internalUrl()}/api/harness/turn` },
    sessionId, resume: !!resumeId, model, writer,
    extraWritable: common && !common.startsWith(worktree!) ? [common] : [],
  };
  await db.update(run).set({ engine: adapter.id, sessionId }).where(eq(run.id, runId));

  const tracked = trackRun(runId, taskId);
  const budget = budgetOf(a, t, o.pluginDefaultTokens);
  const minutes = minutesOf(a, t, o.pluginDefaultMinutes);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; tracked.entry.abort.abort(); }, minutes * 60_000);
  timer.unref?.();

  let settle: (r: { reason: StopReason; err?: string }) => void = () => {};
  const outcome = new Promise<{ reason: StopReason; err?: string }>((resolve) => { settle = resolve; });

  const active: ActiveHarness = {
    token, runId, adapter, ctx, startedAt: ctx.run.startedAt ?? now(), sessionId, counted: { in: 0, out: 0 },
    onFirstTurn: async (report) => {
      if (projectId) {
        const breach = await budgetBreach(db, { projectId, workstationId: a.workstationId, taskId });
        if (breach) {
          scopeBreach = true;
          const why = describeBreach(breach);
          await pushInbox(db, projectId, { kind: 'budget', refType: taskId ? 'task' : 'run', refId: taskId ?? runId, payload: { reason: why, ...breach } });
          settle({ reason: 'budget', err: why });
          return;
        }
      }
      if (active.counted.in + active.counted.out > budget) {
        settle({ reason: 'budget' });
        return;
      }
      if (report.lastMessage) {
        const th = ctx.thread ?? (taskId ? await taskThreadOf(db, taskId) : null);
        if (th) await postMessage(db, th.id, { type: 'agent', id: a.id }, report.lastMessage, ctx.run.threadId ? 'chat' : 'status');
      }
      settle({ reason: 'completed' });
    },
  };
  byToken.set(token, active);

  try {
    const launch = adapter.launch(bin, spec);
    startTerminal({ id: runId, runId, agentId: a.id, taskId, threadId, title, file: launch.file, args: launch.args, cwd: spec.cwd, env: harnessEnv({ AW_RUN_TOKEN: token, ...launch.env }) });
  } catch (e) {
    byToken.delete(token);
    clearTimeout(timer);
    tracked.release();
    await finish('error', `${adapter.label} 启动失败：${e instanceof Error ? e.message : String(e)}`);
    return { stopReason, runId };
  }

  // 终端关掉之后 token 作废：harness 进程已经不在，不该再有人拿它调平台工具
  onTerminalExit(runId, (code) => {
    byToken.delete(token);
    settle({ reason: 'error', err: `${adapter.label} 进程在回合结束前退出（退出码 ${code ?? '—'}）` });
    void saveLog(db, { runId, ctx, title }).catch(() => {});
  });
  tracked.entry.abort.signal.addEventListener('abort', () => settle({ reason: timedOut ? 'timeout' : 'cancelled' }), { once: true });

  const r = await outcome;
  active.onFirstTurn = null;
  clearTimeout(timer);
  tracked.release();
  if (r.reason !== 'completed') killTerminalsWhere((x) => x.id === runId);
  await finish(r.reason, r.err);
  return { stopReason, runId };
}

// harness 回合结束上报：Claude 的 Stop hook / Codex 的 notify / 测试 harness
export async function handleTurn(db: DB, token: string, payload: Record<string, unknown>): Promise<boolean> {
  const h = byToken.get(token);
  if (!h) return false;
  const report = await h.adapter.parseTurn(payload, h.startedAt).catch((): TurnReport => ({}));
  if (report.sessionId && report.sessionId !== h.sessionId) {
    h.sessionId = report.sessionId;
    await db.update(run).set({ sessionId: report.sessionId }).where(eq(run.id, h.runId));
  }
  let estimated = false;
  let dIn = 0;
  let dOut: number;
  if (report.usage) {
    dIn = Math.max(0, report.usage.inputTokens - h.counted.in);
    dOut = Math.max(0, report.usage.outputTokens - h.counted.out);
    h.counted = { in: Math.max(h.counted.in, report.usage.inputTokens), out: Math.max(h.counted.out, report.usage.outputTokens) };
  } else {
    // 读不到 harness 的用量记录：按回复长度粗估输出，标记为估算
    estimated = true;
    dOut = Math.ceil((report.lastMessage ?? '').length / 3);
    h.counted.out += dOut;
  }
  await addUsage(db, h.runId, h.ctx.task?.id ?? null, `${h.adapter.id}:${h.ctx.run.model || 'harness'}`, dIn, dOut);
  await appendTrace(db, h.runId, { t: now(), type: 'model', text: report.lastMessage ?? '', toolCalls: [], usage: { inputTokens: dIn, outputTokens: dOut }, usageEstimated: estimated });
  const first = h.onFirstTurn;
  h.onFirstTurn = null;
  if (first) await first(report);
  return true;
}
