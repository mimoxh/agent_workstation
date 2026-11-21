import { claudeCode } from './claude_code.js';
import { codex } from './codex.js';
import { fakeHarness } from './fake.js';
import { versionOf } from './resolve.js';
import type { HarnessAdapter, HarnessModel } from './types.js';

export const BUILTIN_ENGINE = 'builtin';

const registry = new Map<string, HarnessAdapter>([claudeCode, codex].map((a) => [a.id, a]));
if (process.env.NODE_ENV === 'test' || process.env.AW_ENABLE_MOCK === '1') registry.set(fakeHarness.id, fakeHarness);

export const isHarnessEngine = (engine: string | null | undefined) => !!engine && engine !== BUILTIN_ENGINE && registry.has(engine);
export const harnessOf = (engine: string | null | undefined) => (engine && engine !== BUILTIN_ENGINE ? registry.get(engine) ?? null : null);
export const knownEngine = (engine: string) => engine === BUILTIN_ENGINE || registry.has(engine);

// 外部引擎的模型也存在 agent.model_json 里（provider = 引擎 id）；切换回内置或换别的引擎时互不串用
export function harnessModelOf(modelJson: string | null | undefined, engine: string | null | undefined): string | null {
  if (!modelJson || !engine || engine === BUILTIN_ENGINE) return null;
  try {
    const m = JSON.parse(modelJson) as { provider?: string; name?: string };
    return m.provider === engine && typeof m.name === 'string' && m.name.trim() ? m.name.trim() : null;
  } catch {
    return null;
  }
}

export interface HarnessStatus {
  id: string;
  label: string;
  installed: boolean;
  version: string | null;
  bin: string | null;
  defaultModel: string | null;
  models: HarnessModel[];
}

// --version 要起一次进程：结果缓存一分钟，设置页反复打开不用每次都探测
const TTL = 60_000;
let cache: { at: number; list: HarnessStatus[] } | null = null;

export async function detectHarnesses(force = false): Promise<HarnessStatus[]> {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.list;
  const list = await Promise.all(
    [...registry.values()].map(async (a) => {
      const bin = a.resolveBin();
      const version = bin ? await versionOf(bin, a.versionArgs) : null;
      const info = a.models?.() ?? { defaultModel: null, models: [] };
      return { id: a.id, label: a.label, installed: !!bin && !!version, version, bin, defaultModel: info.defaultModel, models: info.models };
    }),
  );
  cache = { at: Date.now(), list };
  return list;
}

export type { HarnessAdapter, HarnessModel } from './types.js';
