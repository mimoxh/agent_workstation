import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { speechSeconds } from '@aw/domain';
import { readModelConfig, type MediaProviderConfig } from '../config.js';
import { isRetryable, registerSecret, sanitizeError } from '../models.js';
import { probeDuration, runFfmpeg } from './ffmpeg.js';
import { concatWav, toneWav, wavDuration } from './wav.js';

export type AudioFormat = 'mp3' | 'wav';

// off = 这支视频（或本台风格）不配音：门禁不再要求配音，成片不铺旁白音轨
export interface VoicePref { provider?: string | undefined; voice?: string | undefined; speed?: number | undefined; off?: boolean | undefined }
export interface ResolvedVoice { provider: MediaProviderConfig; voice: string; speed: number }

const mockEnabled = () => process.env.NODE_ENV === 'test' || process.env.AW_ENABLE_MOCK === '1';

export const MOCK_TTS: MediaProviderConfig = { name: 'mock', kind: 'tts', protocol: 'mock', voice: 'mock', format: 'wav' };

function envTts(): MediaProviderConfig | null {
  const baseUrl = process.env.AW_TTS_BASE_URL;
  if (!baseUrl) return null;
  const price = Number(process.env.AW_TTS_PRICE);
  return {
    name: process.env.AW_TTS_NAME || 'tts', kind: 'tts', protocol: 'openai-speech', baseUrl, apiKey: process.env.AW_TTS_API_KEY || undefined,
    model: process.env.AW_TTS_MODEL || 'tts-1', voice: process.env.AW_TTS_VOICE || 'alloy', format: process.env.AW_TTS_FORMAT === 'wav' ? 'wav' : 'mp3',
    ...(Number.isFinite(price) && price > 0 ? { price: { perMillionChars: price } } : {}),
  };
}

// 环境变量优先于设置页（同名以环境变量为准）；测试 / mock 模式下补一个本地 mock 配音
export function mediaProviders(): MediaProviderConfig[] {
  const env = envTts();
  const saved = readModelConfig().media.filter((p) => p.name !== env?.name);
  const out = [...saved, ...(env ? [env] : [])];
  if (mockEnabled() && !out.some((p) => p.name === MOCK_TTS.name)) out.push(MOCK_TTS);
  for (const p of out) registerSecret(p.apiKey);
  return out;
}

export const ttsProviders = () => mediaProviders().filter((p) => p.kind === 'tts');

// 选 provider：视频指定的 → 设置里的默认 → 环境变量 → 第一个真实 provider → mock
export function resolveVoice(pref: VoicePref | null | undefined): ResolvedVoice | { error: string } {
  const list = ttsProviders();
  let provider: MediaProviderConfig | undefined;
  if (pref?.provider) {
    provider = list.find((p) => p.name === pref.provider);
    if (!provider) return { error: `配音服务 ${pref.provider} 不存在或没配置` };
  }
  const def = readModelConfig().defaultTts;
  provider ??= (def ? list.find((p) => p.name === def) : undefined) ?? list.find((p) => p.name === envTts()?.name) ?? list.find((p) => p.protocol !== 'mock') ?? list[0];
  if (!provider) return { error: '还没有配音服务：先在「模型与设置 → 媒体」里加一个 TTS provider' };
  const speed = typeof pref?.speed === 'number' && pref.speed >= 0.25 && pref.speed <= 4 ? pref.speed : 1;
  return { provider, voice: pref?.voice?.trim() || provider.voice || (provider.protocol === 'mock' ? 'mock' : 'alloy'), speed };
}

export const normalizeNarration = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

// 配音是否还算数：旁白（规整空白后）+ provider + 音色 + 语速 任一变了，旧配音就过期
export function voiceHash(narration: string | null | undefined, v: { provider: string; voice: string; speed: number }): string {
  return createHash('sha256').update(JSON.stringify([normalizeNarration(narration), v.provider, v.voice, v.speed])).digest('hex');
}

export const ttsCostMicros = (p: MediaProviderConfig, chars: number) => Math.round(chars * (p.price?.perMillionChars ?? 0));

const CHUNK_CHARS = 3000;

// 超长旁白按句切成不超过 3000 字的几段，分别合成再拼起来
export function chunkText(text: string, max = CHUNK_CHARS): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const piece of text.split(/(?<=[。！？!?；;\n.])/)) {
    for (let p = piece; p.length > 0;) {
      const room = max - cur.length;
      if (p.length <= room) { cur += p; break; }
      if (cur) { out.push(cur); cur = ''; continue; }
      out.push(p.slice(0, max));
      p = p.slice(max);
    }
  }
  if (cur) out.push(cur);
  return out;
}

const REQUEST_TIMEOUT_MS = 60_000;
const RETRIES = 2;

class SpeechError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

async function openaiSpeech(p: MediaProviderConfig, text: string, voice: string, speed: number, format: AudioFormat, signal?: AbortSignal): Promise<Buffer> {
  if (!p.baseUrl) throw new SpeechError(`配音服务 ${p.name} 没填地址`);
  const url = `${p.baseUrl.replace(/\/+$/, '')}/audio/speech`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}) },
        body: JSON.stringify({ model: p.model || 'tts-1', input: text, voice, response_format: format, speed }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new SpeechError(`HTTP ${res.status}：${sanitizeError((await res.text().catch(() => '')).slice(0, 300))}`, res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new SpeechError('返回的音频是空的');
      return buf;
    } catch (e) {
      if (signal?.aborted) throw new SpeechError('已取消');
      const timeout = e instanceof Error && e.name === 'TimeoutError';
      if (attempt >= RETRIES || !(timeout || isRetryable(e))) throw new SpeechError(timeout ? `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）` : sanitizeError(e instanceof Error ? e.message : String(e)), (e as SpeechError).status);
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

async function concatAudio(parts: Buffer[], format: AudioFormat, file: string) {
  if (format === 'wav') {
    const joined = concatWav(parts);
    if (joined) return fs.writeFileSync(file, joined);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-tts-'));
  try {
    const names = parts.map((b, i) => {
      const f = path.join(dir, `${i}.${format}`);
      fs.writeFileSync(f, b);
      return f;
    });
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, names.map((n) => `file '${n.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface Synthesis { file: string; format: AudioFormat; duration: number; chars: number; costMicros: number; bytes: number }

// 合成一段配音写到 file（不带扩展名，按格式补上）；时长是实测的：WAV 读文件头，其他格式用 ffprobe
export async function synthesize(v: ResolvedVoice, text: string, fileBase: string, signal?: AbortSignal): Promise<Synthesis> {
  const p = v.provider;
  const input = text.trim();
  if (!input) throw new SpeechError('没有要念的旁白');
  const format: AudioFormat = p.protocol === 'mock' ? 'wav' : (p.format ?? 'mp3');
  const file = `${fileBase}.${format}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const parts: Buffer[] = [];
  for (const chunk of chunkText(input)) {
    if (p.protocol === 'mock') parts.push(toneWav(Math.max(0.5, Math.round((speechSeconds(chunk) / v.speed) * 100) / 100)));
    else parts.push(await openaiSpeech(p, chunk, v.voice, v.speed, format, signal));
  }
  if (parts.length === 1) fs.writeFileSync(file, parts[0]!);
  else await concatAudio(parts, format, file);
  const buf = format === 'wav' ? fs.readFileSync(file) : null;
  const duration = (buf ? wavDuration(buf) : null) ?? (await probeDuration(file));
  return { file, format, duration: Math.round(duration * 1000) / 1000, chars: input.length, costMicros: ttsCostMicros(p, input.length), bytes: fs.statSync(file).size };
}

const SAMPLE = '你好，这是配音试听。Hello from Agent Workstation.';

// 设置页「试听」：用表单当前值合成一句样例，不写配置、不记花费
export async function probeTts(p: MediaProviderConfig, voice?: string | undefined) {
  registerSecret(p.apiKey);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-tts-probe-'));
  const started = Date.now();
  try {
    const syn = await synthesize({ provider: p, voice: voice?.trim() || p.voice || (p.protocol === 'mock' ? 'mock' : 'alloy'), speed: 1 }, SAMPLE, path.join(dir, 'probe'));
    return { audio: fs.readFileSync(syn.file), format: syn.format, duration: syn.duration, ms: Date.now() - started };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 风格面板「试听」：按配音偏好解析出服务和音色，合成同一句样例
export async function sampleVoice(pref: VoicePref | null | undefined) {
  const v = resolveVoice(pref);
  if ('error' in v) return v;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-tts-probe-'));
  try {
    const syn = await synthesize(v, SAMPLE, path.join(dir, 'probe'));
    return { audio: fs.readFileSync(syn.file), format: syn.format, duration: syn.duration, provider: v.provider.name, voice: v.voice };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 给前端选音色用：密钥只给「有没有」，标出来源（环境变量 / 设置页 / mock）
export function publicTtsProviders() {
  const envName = envTts()?.name;
  const saved = new Set(readModelConfig().media.map((p) => p.name));
  const list = ttsProviders().map(({ apiKey, ...p }) => ({ ...p, hasKey: !!apiKey, source: p.name === envName ? ('env' as const) : saved.has(p.name) ? ('settings' as const) : ('mock' as const) }));
  const def = resolveVoice(null);
  return { providers: list, default: 'error' in def ? null : def.provider.name };
}
