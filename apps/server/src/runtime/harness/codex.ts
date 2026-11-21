import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { resolveOnPath } from './resolve.js';
import { slash, type HarnessAdapter, type HarnessModel, type HarnessSpec, type TurnReport } from './types.js';

// -c 的值按 TOML 解析：JSON 字符串字面量恰好也是合法的 TOML 基本字符串
const toml = (s: string) => JSON.stringify(s);

// 跳过新工作区（worktree / 仓库根）的信任弹窗：-c 按点号切键，只能整张内联表覆盖 projects
function trustedProjects(spec: HarnessSpec): string {
  const roots = new Set<string>();
  const add = (raw: string) => {
    let p = raw;
    try { p = realpathSync.native?.(raw) ?? raw; } catch { /* 单元测试路径不存在 */ }
    roots.add(p);
    if (process.platform === 'win32') {
      roots.add(p.toLowerCase());
      if (/^[a-zA-Z]:/.test(p)) {
        roots.add(`\\\\?\\${p}`);
        roots.add(`\\\\?\\${p.toLowerCase()}`);
      }
    }
  };
  add(spec.cwd);
  // worktree 里 Codex 会按主仓库根目录（.git 的父目录）查信任
  for (const d of spec.extraWritable) {
    add(d);
    if (path.basename(d) === '.git') add(path.dirname(d));
  }
  return `projects={${[...roots].map((p) => `${toml(p)}={trust_level="trusted"}`).join(', ')}}`;
}

function launch(bin: string, spec: HarnessSpec) {
  const notify = `notify=[${[spec.hook.node, spec.hook.script].map((p) => toml(slash(p))).join(', ')}, "codex", ${toml(spec.hook.url)}, ${toml(spec.token)}]`;
  const flags = [
    '-C', spec.cwd,
    '-s', spec.writer ? 'workspace-write' : 'read-only',
    '-a', 'never',
    ...(spec.model ? ['-m', spec.model] : []),
    ...(spec.writer ? [spec.runDir, ...spec.extraWritable].flatMap((d) => ['--add-dir', d]) : []),
    '-c', 'check_for_update_on_startup=false',
    '-c', trustedProjects(spec),
    '-c', `mcp_servers.aw.url=${toml(spec.mcpUrl)}`,
    '-c', 'mcp_servers.aw.bearer_token_env_var="AW_RUN_TOKEN"',
    '-c', 'mcp_servers.aw.default_tools_approval_mode="approve"',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-c', notify,
  ];
  const head = spec.resume && spec.sessionId ? ['resume', spec.sessionId] : [];
  return { file: bin, args: [...head, ...flags, spec.prompt] };
}

const codexHome = () => process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');

function readCodexModels() {
  const home = codexHome();
  let defaultModel: string | null = null;
  try {
    const cfgPath = path.join(home, 'config.toml');
    if (existsSync(cfgPath)) {
      for (const raw of readFileSync(cfgPath, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('[')) break;
        const m = /^model\s*=\s*["']([^"']+)["']/.exec(line);
        if (m?.[1]) { defaultModel = m[1]; break; }
      }
    }
  } catch { /* ignore */ }
  const models: HarnessModel[] = [];
  try {
    const cachePath = path.join(home, 'models_cache.json');
    if (existsSync(cachePath)) {
      const data = JSON.parse(readFileSync(cachePath, 'utf8')) as { models?: { slug?: string; display_name?: string; visibility?: string; priority?: number }[] };
      const all = (data.models ?? []).filter((m) => typeof m.slug === 'string' && m.slug.length > 0);
      const visible = all.filter((m) => m.visibility === 'list');
      const list = (visible.length > 0 ? visible : all).sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
      for (const m of list) {
        const id = m.slug!;
        const label = m.display_name && m.display_name !== id ? `${m.display_name} (${id})` : id;
        models.push(label !== id ? { id, label } : { id });
      }
    }
  } catch { /* ignore */ }
  return { defaultModel, models };
}

// 会话记录按日期分目录：只翻最近两天，找文件名里带会话 id 的那份
function rolloutOf(threadId: string): string | null {
  const root = path.join(codexHome(), 'sessions');
  const days = [0, 1].map((d) => {
    const t = new Date(Date.now() - d * 86_400_000);
    return path.join(root, String(t.getFullYear()), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0'));
  });
  for (const dir of days) {
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((f) => f.includes(threadId) && f.endsWith('.jsonl'));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

interface Usage { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }

// token_count 给的是会话累计值：本 run 用量 = 最后一次累计 − run 开始前最后一次累计
async function usageSince(file: string, since: string) {
  let before: Usage | undefined;
  let latest: Usage | undefined;
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw.includes('token_count')) continue;
    let line: { timestamp?: string; payload?: { type?: string; info?: { total_token_usage?: Usage } | null } };
    try { line = JSON.parse(raw) as typeof line; } catch { continue; }
    const total = line.payload?.type === 'token_count' ? line.payload.info?.total_token_usage : undefined;
    if (!total) continue;
    if (line.timestamp && line.timestamp < since) before = total;
    else latest = total;
  }
  if (!latest) return undefined;
  const net = (u: Usage | undefined) => ({ in: (u?.input_tokens ?? 0) - (u?.cached_input_tokens ?? 0), out: u?.output_tokens ?? 0 });
  const a = net(latest);
  const b = net(before);
  return { inputTokens: Math.max(0, a.in - b.in), outputTokens: Math.max(0, a.out - b.out) };
}

async function parseTurn(payload: Record<string, unknown>, since: string): Promise<TurnReport> {
  const threadId = typeof payload['thread-id'] === 'string' ? payload['thread-id'] : undefined;
  const file = threadId ? rolloutOf(threadId) : null;
  return {
    sessionId: threadId,
    lastMessage: typeof payload['last-assistant-message'] === 'string' ? payload['last-assistant-message'] : undefined,
    usage: file ? await usageSince(file, since).catch(() => undefined) : undefined,
  };
}

export const codex: HarnessAdapter = {
  id: 'codex',
  label: 'Codex',
  presetSession: false,
  resolveBin: () => resolveOnPath('codex', process.env.AW_CODEX_BIN),
  versionArgs: ['--version'],
  models: readCodexModels,
  launch,
  parseTurn,
};
