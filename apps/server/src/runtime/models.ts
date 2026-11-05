import type { LanguageModel } from 'ai';

// ARCHITECTURE §6.4：平台只包一层路由与能力声明
export interface ModelRoute {
  id: string;
  model: LanguageModel;
  supportsParallelTools: boolean;
}

// provider 注册表：只放配置齐全的 provider；密钥绝不进日志/trace/DB
export const modelRegistry = new Map<string, ModelRoute>();

export function parseModelRef(ref: string): { provider: string; model: string } | null {
  const i = ref.indexOf(':');
  if (i <= 0) return null;
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

async function registerBuiltin() {
  modelRegistry.clear();

  if (process.env.AW_ANTHROPIC_API_KEY && process.env.AW_ANTHROPIC_MODEL) {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const anthropic = createAnthropic({
      apiKey: process.env.AW_ANTHROPIC_API_KEY,
      ...(process.env.AW_ANTHROPIC_BASE_URL ? { baseURL: process.env.AW_ANTHROPIC_BASE_URL } : {}),
    });
    modelRegistry.set('anthropic', {
      id: `anthropic:${process.env.AW_ANTHROPIC_MODEL}`,
      model: anthropic(process.env.AW_ANTHROPIC_MODEL),
      supportsParallelTools: true,
    });
  }

  if (process.env.AW_OPENAI_COMPAT_BASE_URL && process.env.AW_OPENAI_COMPAT_API_KEY && process.env.AW_OPENAI_COMPAT_MODEL) {
    const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
    const name = process.env.AW_OPENAI_COMPAT_NAME ?? 'openai-compat';
    const oc = createOpenAICompatible({
      name,
      baseURL: process.env.AW_OPENAI_COMPAT_BASE_URL,
      apiKey: process.env.AW_OPENAI_COMPAT_API_KEY,
    });
    modelRegistry.set(name, {
      id: `${name}:${process.env.AW_OPENAI_COMPAT_MODEL}`,
      model: oc(process.env.AW_OPENAI_COMPAT_MODEL),
      supportsParallelTools: true,
    });
  }

  if (process.env.NODE_ENV === 'test' || process.env.AW_ENABLE_MOCK === '1') {
    const { createScriptedMock } = await import('./mock.js');
    modelRegistry.set('mock', {
      id: 'mock:scripted',
      model: createScriptedMock(),
      supportsParallelTools: true,
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
  const def = process.env.AW_DEFAULT_MODEL ?? 'mock:scripted';
  candidates.push(def.includes(':') ? def : `${def}`);

  for (const c of candidates) {
    const ref = parseModelRef(c);
    if (!ref) continue;
    const route = modelRegistry.get(ref.provider);
    if (route) return route;
  }
  // 兜底：第一个已注册 provider
  return [...modelRegistry.values()][0] ?? null;
}

// 错误信息脱敏：把已知 key 值替换为 ***
export function sanitizeError(msg: string): string {
  let out = msg;
  for (const key of [process.env.AW_ANTHROPIC_API_KEY, process.env.AW_OPENAI_COMPAT_API_KEY]) {
    if (key && key.length > 3) out = out.split(key).join('***');
  }
  out = out.replace(/(api[_-]?key|token|authorization|bearer)[=: ]\s*[^\s"']+/gi, '$1=***');
  return out;
}
