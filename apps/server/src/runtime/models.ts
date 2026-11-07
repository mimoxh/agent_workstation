import { costMicros } from '@aw/domain';
import type { LanguageModel } from 'ai';
import { readModelConfig, type ProviderConfig } from './config.js';

// ARCHITECTURE §6.4：平台只包一层路由与能力声明
export interface ModelRoute {
  id: string;
  model: LanguageModel;
  supportsParallelTools: boolean;
  local?: boolean | undefined;
  // 同一 provider 下换模型：Agent 指定了不同于默认的模型时用
  withModel?: ((name: string) => ModelRoute) | undefined;
}

// provider 注册表：只放配置齐全的 provider；密钥绝不进日志/trace/DB
export const modelRegistry = new Map<string, ModelRoute>();

export function parseModelRef(ref: string): { provider: string; model: string } | null {
  const i = ref.indexOf(':');
  if (i <= 0) return null;
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

const secrets = new Set<string>();

async function buildRoute(p: ProviderConfig): Promise<ModelRoute> {
  if (p.apiKey) secrets.add(p.apiKey);
  if (p.kind === 'anthropic') {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const client = createAnthropic({ apiKey: p.apiKey ?? '', ...(p.baseUrl ? { baseURL: p.baseUrl } : {}) });
    const route = (name: string): ModelRoute => ({ id: `${p.name}:${name}`, model: client(name), supportsParallelTools: true, withModel: route });
    return route(p.model);
  }
  const local = p.kind === 'ollama';
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
  const client = createOpenAICompatible({
    name: p.name,
    baseURL: p.baseUrl ?? (local ? 'http://localhost:11434/v1' : ''),
    ...(p.apiKey ? { apiKey: p.apiKey } : {}),
  });
  // Ollama 通常不支持并行 tool call：能力声明为 false，循环本身按序执行工具
  const route = (name: string): ModelRoute => ({ id: `${p.name}:${name}`, model: client(name), supportsParallelTools: !local, local, withModel: route });
  return route(p.model);
}

function envProviders(): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  if (process.env.AW_ANTHROPIC_API_KEY && process.env.AW_ANTHROPIC_MODEL) {
    out.push({ name: 'anthropic', kind: 'anthropic', model: process.env.AW_ANTHROPIC_MODEL, apiKey: process.env.AW_ANTHROPIC_API_KEY, baseUrl: process.env.AW_ANTHROPIC_BASE_URL || undefined });
  }
  if (process.env.AW_OPENAI_COMPAT_BASE_URL && process.env.AW_OPENAI_COMPAT_API_KEY && process.env.AW_OPENAI_COMPAT_MODEL) {
    out.push({ name: process.env.AW_OPENAI_COMPAT_NAME || 'openai-compat', kind: 'openai-compatible', model: process.env.AW_OPENAI_COMPAT_MODEL, apiKey: process.env.AW_OPENAI_COMPAT_API_KEY, baseUrl: process.env.AW_OPENAI_COMPAT_BASE_URL });
  }
  if (process.env.AW_OLLAMA_MODEL) {
    out.push({ name: 'ollama', kind: 'ollama', model: process.env.AW_OLLAMA_MODEL, baseUrl: process.env.AW_OLLAMA_BASE_URL || undefined });
  }
  return out;
}

async function registerBuiltin() {
  modelRegistry.clear();
  // 环境变量优先于设置页：同名 provider 以环境变量为准
  const fromEnv = envProviders();
  const saved = readModelConfig().providers.filter((p) => !fromEnv.some((e) => e.name === p.name));
  for (const p of [...saved, ...fromEnv]) modelRegistry.set(p.name, await buildRoute(p));

  if (process.env.NODE_ENV === 'test' || process.env.AW_ENABLE_MOCK === '1') {
    const { createScriptedMock } = await import('./mock.js');
    modelRegistry.set('mock', {
      id: 'mock:scripted',
      model: createScriptedMock(),
      supportsParallelTools: true,
      local: true,
    });
  }
}

let loaded = false;
export async function loadModels() {
  if (!loaded) {
    await registerBuiltin();
    loaded = true;
  }
}

export async function reloadModels() {
  await registerBuiltin();
  loaded = true;
}

export async function hasModels() {
  await loadModels();
  return modelRegistry.size > 0;
}

// 派发前拦下：否则任务要等到 run 启动才阻塞，人看到的只是一条失败记录
export async function modelGate(): Promise<string | null> {
  if (process.env.AW_AUTORUN === '0') return null;
  return (await hasModels()) ? null : '还没有可用的模型：先配置模型 provider，再派发任务';
}

export const defaultModelRef = () => process.env.AW_DEFAULT_MODEL || readModelConfig().defaultModel || null;

function routeOf(ref: string): ModelRoute | null {
  const parsed = parseModelRef(ref);
  const base = modelRegistry.get(parsed?.provider ?? ref);
  if (!base) return null;
  if (!parsed || base.id === ref || !base.withModel) return base;
  return base.withModel(parsed.model);
}

// 选择顺序：agent.model_json → 插件模板 model → 全局默认
export function resolveModel(agentModelJson: string | null, templateModel: { provider?: string | undefined; name?: string | undefined } | undefined | null): ModelRoute | null {
  const candidates: string[] = [];
  if (agentModelJson) {
    try {
      const m = JSON.parse(agentModelJson) as { provider?: string; name?: string };
      if (m.provider && m.name) candidates.push(`${m.provider}:${m.name}`);
      else if (m.provider) candidates.push(m.provider);
    } catch { /* ignore */ }
  }
  if (templateModel?.provider && templateModel.name) {
    candidates.push(`${templateModel.provider}:${templateModel.name}`);
  }
  const def = defaultModelRef();
  if (def) candidates.push(def);

  for (const c of candidates) {
    const route = routeOf(c);
    if (route) return route;
  }
  // 兜底：第一个已注册 provider
  return [...modelRegistry.values()][0] ?? null;
}

// 主模型之后的备选：配置的降级链里还可用、且不是主模型本身的
export function fallbackRoutes(primary: ModelRoute): ModelRoute[] {
  const seen = new Set([primary.id]);
  const out: ModelRoute[] = [];
  for (const ref of readModelConfig().chain) {
    const route = routeOf(ref);
    if (route && !seen.has(route.id)) {
      seen.add(route.id);
      out.push(route);
    }
  }
  return out;
}

// 限流、超时、服务不可用才降级；参数错误换模型也没用
export function isRetryable(e: unknown): boolean {
  const err = e as { statusCode?: number; status?: number; code?: string; message?: string };
  const status = err.statusCode ?? err.status;
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  return /rate.?limit|timeout|timed out|overloaded|unavailable|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message ?? '');
}

export const runCost = (routeId: string, tokensIn: number, tokensOut: number) => costMicros(tokensIn, tokensOut, readModelConfig().prices[routeId]);

// 错误信息脱敏：把已知 key 值替换为 ***
export function sanitizeError(msg: string): string {
  let out = msg;
  for (const key of [process.env.AW_ANTHROPIC_API_KEY, process.env.AW_OPENAI_COMPAT_API_KEY, ...secrets]) {
    if (key && key.length > 3) out = out.split(key).join('***');
  }
  out = out.replace(/(api[_-]?key|token|authorization|bearer)[=: ]\s*[^\s"']+/gi, '$1=***');
  return out;
}
