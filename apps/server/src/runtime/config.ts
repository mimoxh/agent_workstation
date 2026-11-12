import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'ollama';

export interface ProviderConfig {
  name: string;
  kind: ProviderKind;
  model: string;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  // 能看懂图片输入：view_design 这类工具才会把截图塞进工具结果
  vision?: boolean | undefined;
}

export interface ModelConfig {
  providers: ProviderConfig[];
  defaultModel?: string | undefined;
  // 降级链：provider:model，主模型不可用时按序尝试
  chain: string[];
  // 美元 / 百万 token
  prices: Record<string, { input: number; output: number }>;
}

const EMPTY: ModelConfig = { providers: [], chain: [], prices: {} };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const configPath = () => process.env.AW_MODEL_CONFIG ?? path.join(repoRoot, 'data', 'models.enc');
// 密钥不和数据放一起：导出或拷走 data 目录不会带走明文能力
const keyPath = () => process.env.AW_SECRET_KEY ?? path.join(os.homedir(), '.agent-workstation', 'secret.key');

function secretKey(): Buffer {
  const file = keyPath();
  if (fs.existsSync(file)) return fs.readFileSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

// 测试不碰磁盘，也不读开发者本机的真实配置
let memory: ModelConfig | null = null;
const inMemory = () => process.env.NODE_ENV === 'test';

export function readModelConfig(): ModelConfig {
  if (inMemory()) return memory ?? EMPTY;
  const file = configPath();
  if (!fs.existsSync(file)) return EMPTY;
  const raw = fs.readFileSync(file);
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  return { ...EMPTY, ...(JSON.parse(text) as Partial<ModelConfig>) };
}

export function writeModelConfig(config: ModelConfig) {
  if (inMemory()) {
    memory = config;
    return;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), Buffer.concat([iv, cipher.getAuthTag(), body]));
}

// 对外展示时密钥只给「有没有」
export function publicModelConfig(c: ModelConfig) {
  return { ...c, providers: c.providers.map(({ apiKey, ...p }) => ({ ...p, hasKey: !!apiKey })) };
}

// 保存时留空密钥表示沿用旧值
export function mergeProviders(next: ProviderConfig[], prev: ProviderConfig[]) {
  return next.map((p) => ({ ...p, apiKey: p.apiKey || prev.find((x) => x.name === p.name)?.apiKey }));
}
