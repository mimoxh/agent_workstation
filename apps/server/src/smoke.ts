// pnpm smoke:model — 对每个已配置 provider 发一次带单工具的请求（不打印 key）
import { generateText, jsonSchema, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { zodToJson } from './runtime/loop.js';
import { loadModels, modelRegistry, sanitizeError } from './runtime/models.js';

await loadModels();

if (modelRegistry.size === 0) {
  console.log('没有已配置的 provider（检查 .env.local 或 AW_ENABLE_MOCK）');
  process.exit(0);
}

const tools = {
  echo: tool({ description: '回显文本', inputSchema: jsonSchema(zodToJson(z.object({ text: z.string() }))) }),
} as unknown as ToolSet;

for (const route of modelRegistry.values()) {
  try {
    const res = await generateText({
      model: route.model,
      prompt: '请调用 echo 工具，text 填 "ping"。',
      tools,
    });
    const called = (res.toolCalls ?? []).length > 0;
    console.log(`${route.id}  tool_call=${called}  usage=${JSON.stringify(res.usage)}`);
  } catch (e) {
    console.log(`${route.id}  ERROR ${sanitizeError(e instanceof Error ? e.message : String(e))}`);
  }
}
