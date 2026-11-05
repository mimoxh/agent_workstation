import { generateText, jsonSchema, tool, type ToolSet } from 'ai';
import type { LanguageModel } from 'ai';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { inboxItem, run, task } from '../db/schema.js';
import { events } from '../events.js';
import type { ModelRoute } from './models.js';
import { sanitizeError } from './models.js';
import { executeTool, taskThread, toolSchemasFor, type ToolCtx } from './tools/index.js';
import type { AgentRow, TaskRow } from './types.js';

export type StopReason = 'completed' | 'max_turns' | 'no_progress' | 'budget' | 'timeout' | 'error';

export interface TraceStep {
  t: string;
  type: 'model' | 'tool';
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

const now = () => new Date().toISOString();

async function appendTrace(db: DB, runId: string, step: TraceStep) {
  const rows = await db.select().from(run).where(eq(run.id, runId));
  const trace = JSON.parse(rows[0]?.traceJson ?? '[]') as TraceStep[];
  trace.push(step);
  await db.update(run).set({ traceJson: JSON.stringify(trace) }).where(eq(run.id, runId));
  events.emit('run_step', { runId, step });
}

async function addUsage(db: DB, runId: string, taskId: string, tin: number, tout: number) {
  const rows = await db.select().from(run).where(eq(run.id, runId));
  const r = rows[0];
  await db.update(run).set({ tokensIn: (r?.tokensIn ?? 0) + tin, tokensOut: (r?.tokensOut ?? 0) + tout }).where(eq(run.id, runId));
  const t = (await db.select().from(task).where(eq(task.id, taskId)))[0];
  const usage = JSON.parse(t?.usageJson ?? '{}') as { tokensIn?: number; tokensOut?: number };
  await db.update(task).set({ usageJson: JSON.stringify({ tokensIn: (usage.tokensIn ?? 0) + tin, tokensOut: (usage.tokensOut ?? 0) + tout }) }).where(eq(task.id, taskId));
}

function budgetOf(agentRow: AgentRow, taskRow: TaskRow, pluginDefault?: number): number {
  const parse = (j: string | null) => { try { return (JSON.parse(j ?? '{}') as { tokens?: number }).tokens; } catch { return undefined; } };
  return parse(agentRow.budgetJson) ?? parse(taskRow.budgetJson) ?? pluginDefault ?? 200000;
}
function minutesOf(agentRow: AgentRow, taskRow: TaskRow, pluginDefault?: number): number {
  const parse = (j: string | null) => { try { return (JSON.parse(j ?? '{}') as { minutes?: number }).minutes; } catch { return undefined; } };
  return parse(agentRow.budgetJson) ?? parse(taskRow.budgetJson) ?? pluginDefault ?? 10;
}

// 自己写循环：每轮一次 generateText，工具只传 schema，由我们执行后回填
export async function runAgent(opts: {
  db: DB;
  ctx: ToolCtx;
  route: ModelRoute;
  system: string;
  messages: { role: 'user' | 'assistant' | 'tool'; content: unknown }[];
  agentRow: AgentRow;
  taskRow: TaskRow;
  pluginDefaultTokens?: number | undefined;
  pluginDefaultMinutes?: number | undefined;
}): Promise<{ stopReason: StopReason; runId: string }> {
  const { db, ctx, route } = opts;
  const runId = ctx.run.id;
  const budget = budgetOf(opts.agentRow, opts.taskRow, opts.pluginDefaultTokens);
  const minutes = minutesOf(opts.agentRow, opts.taskRow, opts.pluginDefaultMinutes);
  const deadline = Date.now() + minutes * 60_000;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), minutes * 60_000);
  timer.unref?.();

  const toolDefs = toolSchemasFor(JSON.parse(opts.agentRow.toolsJson ?? '[]') as string[]);
  const aiTools = Object.fromEntries(
    toolDefs.map((t) => [t.name, tool({ description: t.description, inputSchema: jsonSchema(zodToJson(t.parameters)) })]),
  );

  const messages: { role: string; content: unknown }[] = [...opts.messages];
  let totalTokens = 0;
  let lastCallKey = '';
  let repeatCount = 0;
  let stopReason: StopReason = 'error';

  events.emit('run_started', { runId, agentId: opts.agentRow.id, taskId: opts.taskRow.id });

  const finish = async (reason: StopReason, err?: string) => {
    stopReason = reason;
    const status = reason === 'completed' ? 'completed' : reason === 'timeout' ? 'interrupted' : 'error';
    await db.update(run).set({ status, stopReason: reason, endedAt: now(), error: err ?? null }).where(eq(run.id, runId));
    events.emit('run_finished', { runId, agentId: opts.agentRow.id, taskId: opts.taskRow.id, stopReason: reason });
    if (reason !== 'completed') {
      const { project } = await import('../db/schema.js');
      const p = await db.select().from(project).where(eq(project.id, opts.taskRow.projectId));
      await db.insert(inboxItem).values({
        id: crypto.randomUUID(), workspaceId: p[0]?.workspaceId ?? 'default', projectId: opts.taskRow.projectId,
        kind: 'run_failed', refType: 'run', refId: runId, status: 'open', createdAt: now(),
      });
      events.emit('inbox_created', { kind: 'run_failed', refId: runId });
    }
  };

  try {
    outer: for (let round = 0; round < MAX_TURNS; round++) {
      if (Date.now() > deadline) { await finish('timeout'); break outer; }
      let res;
      try {
        res = await generateText({
          model: route.model as LanguageModel,
          system: opts.system,
          messages: messages as never,
          tools: aiTools as unknown as ToolSet,
          abortSignal: abort.signal,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (abort.signal.aborted || Date.now() > deadline) { await finish('timeout'); break outer; }
        await finish('error', sanitizeError(msg));
        break outer;
      }

      const usage = readUsage(res);
      const tin = usage?.inputTokens ?? Math.ceil(((res.text ?? '').length + JSON.stringify(res.toolCalls ?? []).length) / 3) + 10;
      const tout = usage?.outputTokens ?? 0;
      totalTokens += tin + tout;
      await addUsage(db, runId, opts.taskRow.id, tin, tout);
      await appendTrace(db, runId, {
        t: now(), type: 'model', text: res.text,
        toolCalls: (res.toolCalls ?? []).map((c) => ({ id: c.toolCallId, name: c.toolName, args: c.input })),
        usage: { inputTokens: tin, outputTokens: tout },
        usageEstimated: usage === undefined,
      });

      if (totalTokens > budget) { await finish('budget'); break outer; }

      const calls = res.toolCalls ?? [];
      if (calls.length === 0) {
        // 无工具调用 → completed，文本进任务线程
        if (res.text) {
          const th = await taskThread(db, opts.taskRow);
          const { message } = await import('../db/schema.js');
          const m = { id: crypto.randomUUID(), threadId: th.id, senderType: 'agent', senderId: opts.agentRow.id, kind: 'status', content: res.text, createdAt: now() };
          await db.insert(message).values(m);
          events.emit('message_created', m as unknown as Record<string, unknown>);
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
        if (ser && ser.length > TOOL_RESULT_LIMIT) {
          result = { truncated_preview: ser.slice(0, TOOL_RESULT_LIMIT) };
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
  }
  return { stopReason, runId };
}

function norm(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(norm).join(',')}]`;
  return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${norm((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

// zod → JSON schema 的极简转换（与 validateInput 子集一致）
export function zodToJson(schema: unknown): Record<string, unknown> {
  const def = (schema as { _def?: { typeName?: string; innerType?: unknown; shape?: () => Record<string, unknown>; values?: unknown[] } })._def;
  if (!def) return {};
  if (def.typeName === 'ZodObject') {
    const shape = def.shape!();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = zodToJson(v);
      const d = (v as { _def?: { typeName?: string } })._def;
      if (d?.typeName !== 'ZodOptional' && d?.typeName !== 'ZodDefault') required.push(k);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  }
  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault' || def.typeName === 'ZodNullable') return zodToJson(def.innerType);
  if (def.typeName === 'ZodString') return { type: 'string' };
  if (def.typeName === 'ZodNumber') return { type: 'number' };
  if (def.typeName === 'ZodBoolean') return { type: 'boolean' };
  if (def.typeName === 'ZodEnum') return { type: 'string', enum: def.values };
  if (def.typeName === 'ZodArray') return { type: 'array', items: zodToJson((def as { type?: unknown }).type) };
  if (def.typeName === 'ZodRecord') return { type: 'object' };
  return {};
}

export { and, eq };
