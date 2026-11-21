import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { task } from '../../db/schema.js';
import { appendTrace, extractImages, zodToJson } from '../loop.js';
import { allTools, executeTool } from '../tools/index.js';
import { bridgedTools, harnessByToken } from './run.js';

const TOOL_RESULT_LIMIT = 8 * 1024;

export const bearerOf = (req: Request) => /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]?.trim() ?? '';

// 无状态 Streamable HTTP：每个请求一套 server + transport，身份只认 run token
export async function handleMcp(db: DB, req: Request): Promise<Response> {
  const h = harnessByToken(bearerOf(req));
  if (!h) return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'run token 无效或会话已结束' }, id: null }, { status: 401 });
  const tools = bridgedTools(h.ctx.agent);
  const allowed = new Set(tools.map((t) => t.name));

  const server = new Server({ name: 'agent-workstation', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object' as const, ...zodToJson(t.parameters) } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    const name = r.params.name;
    const args = (r.params.arguments ?? {}) as Record<string, unknown>;
    if (!allowed.has(name)) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `工具 ${name} 不在你的工具清单里` }) }], isError: true };
    // harness 会话可能持续很久：每次调用都按最新的任务行执行（worktree、stage、head 都可能已变）
    const fresh = h.ctx.task ? (await db.select().from(task).where(eq(task.id, h.ctx.task.id)))[0] ?? h.ctx.task : null;
    const ctx = { ...h.ctx, task: fresh };
    const t0 = Date.now();
    const raw = await executeTool(ctx, name, args);
    const { images, rest } = extractImages(raw);
    let result = rest;
    const ser = JSON.stringify(result) ?? 'null';
    const limit = allTools()[name]?.resultLimit ?? TOOL_RESULT_LIMIT;
    const truncated = ser.length > limit;
    if (truncated) result = { truncated_preview: ser.slice(0, limit) };
    const err = result && typeof result === 'object' && 'error' in result ? String((result as { error: unknown }).error) : undefined;
    await appendTrace(db, h.runId, { t: new Date().toISOString(), type: 'tool', name, args, result, truncated, ms: Date.now() - t0, ...(err ? { error: err } : {}) });
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(result) },
        ...images.map((i) => ({ type: 'image' as const, data: i.base64, mimeType: i.mediaType })),
      ],
      ...(err ? { isError: true } : {}),
    };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}
