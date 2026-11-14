import { generateText, jsonSchema, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { zodToJson } from './loop.js';
import { sanitizeError, type ModelRoute } from './models.js';

export interface ProbeResult {
  ok: boolean;
  toolCall: boolean;
  latencyMs: number;
  // provider 配了最大输出时，这次请求就带着它发：配置值不被接受也会在这里暴露
  maxOutputChecked: number | null;
  error?: string;
}

const tools = {
  echo: tool({ description: '回显文本', inputSchema: jsonSchema(zodToJson(z.object({ text: z.string() }))) }),
} as unknown as ToolSet;

// 设置页「测试」与 smoke:model 共用：发一次带单工具的请求，看模型能不能跑通并调用工具
export async function probeModel(route: ModelRoute, timeoutMs = 30_000): Promise<ProbeResult> {
  const start = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await generateText({
      model: route.model,
      prompt: '请调用 echo 工具，text 填 "ping"。',
      tools,
      abortSignal: signal,
      maxRetries: 0,
      ...(route.maxOutputTokens ? { maxOutputTokens: route.maxOutputTokens } : {}),
    });
    return { ok: true, toolCall: (res.toolCalls ?? []).length > 0, latencyMs: Date.now() - start, maxOutputChecked: route.maxOutputTokens ?? null };
  } catch (e) {
    const error = signal.aborted ? `超时（${Math.round(timeoutMs / 1000)} 秒无响应）` : sanitizeError(e instanceof Error ? e.message : String(e));
    return { ok: false, toolCall: false, latencyMs: Date.now() - start, maxOutputChecked: route.maxOutputTokens ?? null, error };
  }
}
