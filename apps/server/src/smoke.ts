// pnpm smoke:model — 对每个已配置 provider 发一次带单工具的请求（不打印 key）
import { loadModels, modelRegistry } from './runtime/models.js';
import { probeModel } from './runtime/probe.js';

await loadModels();

if (modelRegistry.size === 0) {
  console.log('没有已配置的 provider（检查 .env.local 或 AW_ENABLE_MOCK）');
  process.exit(0);
}

for (const route of modelRegistry.values()) {
  const r = await probeModel(route);
  if (r.ok) console.log(`${route.id}  tool_call=${r.toolCall}  latency=${r.latencyMs}ms${r.maxOutputChecked ? `  max_output=${r.maxOutputChecked}` : ''}`);
  else console.log(`${route.id}  ERROR ${r.error}`);
}
