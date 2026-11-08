import { generateText, jsonSchema, tool, type ToolSet } from 'ai';
import type { LanguageModel } from 'ai';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { run, task } from '../db/schema.js';
import { events } from '../events.js';
import { budgetBreach, describeBreach } from './budget.js';
import type { ModelRoute } from './models.js';
import { isRetryable, runCost, sanitizeError } from './models.js';
import { pushInbox, pushRunFailure } from '../usecases/inbox.js';
import { postMessage, taskThreadOf } from '../usecases/threads.js';
import { allTools, executeTool, toolSchemasFor, type RunCtx } from './tools/index.js';
import type { AgentRow, TaskRow } from './types.js';

export type StopReason = 'completed' | 'max_turns' | 'no_progress' | 'budget' | 'timeout' | 'error' | 'cancelled';

// 进行中的 run：人工取消时中止模型调用，并在下一轮开始前退出
const activeRuns = new Map<string, { taskId: string | null; abort: AbortController; cancelled: boolean }>();

export function cancelRun(runId: string): boolean {
  const r = activeRuns.get(runId);
  if (!r) return false;
  r.cancelled = true;
  r.abort.abort();
  return true;
}

export function cancelRunsOfTask(taskId: string) {
  let stopped = 0;
  for (const [id, r] of activeRuns) {
    if (r.taskId === taskId && cancelRun(id)) stopped += 1;
  }
  return stopped;
}

export interface TraceStep {
  t: string;
  type: 'model' | 'tool' | 'fallback';
  from?: string;
  to?: string;
  text?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  usage?: { inputTokens?: number; outputTokens?: number };
  usageEstimated?: boolean;
  name?: string;
  args?: unknown;
  result?: unknown;
  truncated?: boolean;
  ms?: number;
  error?: string;
}

// generateText v7：res.totalUsage/res.usage 为扁平 { inputTokens, outputTokens, totalTokens, *Details }
export function readUsage(res: unknown): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  const r = res as { totalUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } };
  const u = r.totalUsage ?? r.usage;
  if (!u) return undefined;
  if (typeof u.inputTokens !== 'number' && typeof u.outputTokens !== 'number') return undefined;
  return u;
}

const MAX_TURNS = 8;
const TOOL_RESULT_LIMIT = 8 * 1024;
// 一次工具调用就要写整份设计稿：不少 provider 的默认输出上限放不下，半截 JSON 等于这一轮白跑
const LARGE_OUTPUT_TOKENS = Number(process.env.AW_LARGE_OUTPUT_TOKENS ?? 16000);

const now = () => new Date().toISOString();

async function appendTrace(db: DB, runId: string, step: TraceStep) {
  const rows = await db.select().from(run).where(eq(run.id, runId));
  const trace = JSON.parse(rows[0]?.traceJson ?? '[]') as TraceStep[];
  trace.push(step);
  await db.update(run).set({ traceJson: JSON.stringify(trace) }).where(eq(run.id, runId));
  events.emit('run_step', { runId, step });
}

async function addUsage(db: DB, runId: string, taskId: string | null, routeId: string, tin: number, tout: number) {
  const rows = await db.select().from(run).where(eq(run.id, runId));
  const r = rows[0];
  await db.update(run).set({ tokensIn: (r?.tokensIn ?? 0) + tin, tokensOut: (r?.tokensOut ?? 0) + tout, cost: (r?.cost ?? 0) + runCost(routeId, tin, tout) }).where(eq(run.id, runId));
  if (!taskId) return;
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  const usage = JSON.parse(t?.usageJson ?? '{}') as { tokensIn?: number; tokensOut?: number };
  await db.update(task).set({ usageJson: JSON.stringify({ tokensIn: (usage.tokensIn ?? 0) + tin, tokensOut: (usage.tokensOut ?? 0) + tout }) }).where(eq(task.id, taskId));
}

function budgetOf(agentRow: AgentRow, taskRow: TaskRow | null, pluginDefault?: number): number {
  const parse = (j: string | null) => { try { return (JSON.parse(j ?? '{}') as { tokens?: number }).tokens; } catch { return undefined; } };
  return parse(agentRow.budgetJson) ?? parse(taskRow?.budgetJson ?? null) ?? pluginDefault ?? 200000;
}
function minutesOf(agentRow: AgentRow, taskRow: TaskRow | null, pluginDefault?: number): number {
  const parse = (j: string | null) => { try { return (JSON.parse(j ?? '{}') as { minutes?: number }).minutes; } catch { return undefined; } };
  return parse(agentRow.budgetJson) ?? parse(taskRow?.budgetJson ?? null) ?? pluginDefault ?? 10;
}

// 自己写循环：每轮一次 generateText，工具只传 schema，由我们执行后回填
export async function runAgent(opts: {
  db: DB;
  ctx: RunCtx;
  route: ModelRoute;
  fallbacks?: ModelRoute[] | undefined;
  system: string;
  messages: { role: 'user' | 'assistant' | 'tool'; content: unknown }[];
  agentRow: AgentRow;
  taskRow: TaskRow | null;
  projectId?: string | undefined;
  pluginDefaultTokens?: number | undefined;
  pluginDefaultMinutes?: number | undefined;
}): Promise<{ stopReason: StopReason; runId: string }> {
  const { db, ctx } = opts;
  let route = opts.route;
  const fallbacks = [...(opts.fallbacks ?? [])];
  const runId = ctx.run.id;
  const budget = budgetOf(opts.agentRow, opts.taskRow, opts.pluginDefaultTokens);
  const minutes = minutesOf(opts.agentRow, opts.taskRow, opts.pluginDefaultMinutes);
  const deadline = Date.now() + minutes * 60_000;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), minutes * 60_000);
  timer.unref?.();
  const taskId = opts.taskRow?.id ?? null;
  const projectId = opts.taskRow?.projectId ?? opts.projectId ?? null;
  const active = { taskId, abort, cancelled: false };
  activeRuns.set(runId, active);

  const toolDefs = toolSchemasFor(JSON.parse(opts.agentRow.toolsJson ?? '[]') as string[]);
  const maxOutputTokens = LARGE_OUTPUT_TOKENS > 0 && toolDefs.some((t) => t.largeOutput) ? LARGE_OUTPUT_TOKENS : undefined;
  const aiTools = Object.fromEntries(
    toolDefs.map((t) => [t.name, tool({ description: t.description, inputSchema: jsonSchema(zodToJson(t.parameters)) })]),
  );

  const messages: { role: string; content: unknown }[] = [...opts.messages];
  let totalTokens = 0;
  let lastCallKey = '';
  let repeatCount = 0;
  let stopReason: StopReason = 'error';
  let scopeBreach = false;

  events.emit('run_started', { runId, agentId: opts.agentRow.id, taskId });

  const finish = async (reason: StopReason, err?: string) => {
    stopReason = reason;
    const status = reason === 'completed' ? 'completed' : reason === 'timeout' ? 'interrupted' : reason === 'cancelled' ? 'cancelled' : 'error';
    await db.update(run).set({ status, stopReason: reason, endedAt: now(), error: err ?? null }).where(eq(run.id, runId));
    events.emit('run_finished', { runId, agentId: opts.agentRow.id, taskId, stopReason: reason });
    if (reason !== 'completed' && reason !== 'cancelled' && projectId && !scopeBreach) {
      await pushRunFailure(db, projectId, runId, `${opts.agentRow.id}:${taskId ?? ctx.thread?.id ?? ''}`);
    }
  };

  try {
    outer: for (let round = 0; round < MAX_TURNS; round++) {
      if (active.cancelled) { await finish('cancelled'); break outer; }
      if (Date.now() > deadline) { await finish('timeout'); break outer; }
      let res;
      try {
        res = await generateText({
          model: route.model as LanguageModel,
          system: opts.system,
          messages: messages as never,
          tools: aiTools as unknown as ToolSet,
          abortSignal: abort.signal,
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (active.cancelled) { await finish('cancelled'); break outer; }
        if (abort.signal.aborted || Date.now() > deadline) { await finish('timeout'); break outer; }
        const next = isRetryable(e) ? fallbacks.shift() : undefined;
        if (next) {
          // 降级要留痕：输出风格和工具能力可能变，人要看得到这次是备用模型完成的
          await appendTrace(db, runId, { t: now(), type: 'fallback', from: route.id, to: next.id, error: sanitizeError(msg) });
          await db.update(run).set({ fallbackFrom: route.id, provider: next.id.split(':')[0] ?? null, model: next.id.split(':').slice(1).join(':') }).where(eq(run.id, runId));
          route = next;
          round -= 1;
          continue;
        }
        await finish('error', sanitizeError(msg));
        break outer;
      }

      const usage = readUsage(res);
      const tin = usage?.inputTokens ?? Math.ceil(((res.text ?? '').length + JSON.stringify(res.toolCalls ?? []).length) / 3) + 10;
      const tout = usage?.outputTokens ?? 0;
      totalTokens += tin + tout;
      await addUsage(db, runId, taskId, route.id, tin, tout);
      await appendTrace(db, runId, {
        t: now(), type: 'model', text: res.text,
        toolCalls: (res.toolCalls ?? []).map((c) => ({ id: c.toolCallId, name: c.toolName, args: c.input })),
        usage: { inputTokens: tin, outputTokens: tout },
        usageEstimated: usage === undefined,
      });

      if (projectId) {
        const breach = await budgetBreach(db, { projectId, workstationId: opts.agentRow.workstationId, taskId });
        if (breach) {
          const why = describeBreach(breach);
          scopeBreach = true;
          await finish('budget', why);
          await pushInbox(db, projectId, { kind: 'budget', refType: taskId ? 'task' : 'run', refId: taskId ?? runId, payload: { reason: why, ...breach } });
          break outer;
        }
      }
      if (totalTokens > budget) { await finish('budget'); break outer; }

      const calls = res.toolCalls ?? [];
      if (calls.length === 0) {
        // 无工具调用 → completed；会话里的回合是发言，工作 run 的收尾只是进度
        if (res.text) {
          const th = ctx.thread ?? (taskId ? await taskThreadOf(db, taskId) : null);
          if (th) await postMessage(db, th.id, { type: 'agent', id: opts.agentRow.id }, res.text, ctx.run.threadId ? 'chat' : 'status');
        }
        await finish('completed');
        break outer;
      }

      // no_progress 熔断：连续两次相同工具+参数
      const key = JSON.stringify(calls.map((c) => [c.toolName, norm(c.input)]));
      if (key === lastCallKey) {
        repeatCount++;
        if (repeatCount >= 1) { await finish('no_progress'); break outer; }
      } else {
        repeatCount = 0;
      }
      lastCallKey = key;

      messages.push({ role: 'assistant', content: calls.map((c) => ({ type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: c.input })) });
      const results: unknown[] = [];
      for (const c of calls) {
        const t0 = Date.now();
        let result = await executeTool(ctx, c.toolName, (c.input ?? {}) as Record<string, unknown>);
        let truncated = false;
        let err: string | undefined;
        const ser = JSON.stringify(result);
        const limit = allTools()[c.toolName]?.resultLimit ?? TOOL_RESULT_LIMIT;
        if (ser && ser.length > limit) {
          result = { truncated_preview: ser.slice(0, limit) };
          truncated = true;
        }
        if (typeof result === 'object' && result !== null && 'error' in result) {
          err = String((result as { error: unknown }).error);
        }
        await appendTrace(db, runId, { t: now(), type: 'tool', name: c.toolName, args: c.input, result, truncated, ms: Date.now() - t0, ...(err ? { error: err } : {}) });
        results.push({ type: 'tool-result', toolCallId: c.toolCallId, toolName: c.toolName, output: { type: 'json', value: result } });
      }
      messages.push({ role: 'tool', content: results });
      if (round === MAX_TURNS - 1) { await finish('max_turns'); break outer; }
    }
  } finally {
    clearTimeout(timer);
    activeRuns.delete(runId);
  }
  return { stopReason, runId };
}

function norm(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(norm).join(',')}]`;
  return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${norm((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

// io=input：带默认值的字段对模型是可选的
export function zodToJson(schema: z.ZodType): Record<string, unknown> {
  const json: Record<string, unknown> = { ...z.toJSONSchema(schema, { io: 'input' }) };
  delete json.$schema;
  return json;
}

export { and, eq };
