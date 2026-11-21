import { createReadStream, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { resolveOnPath } from './resolve.js';
import { slash, type HarnessAdapter, type HarnessSpec, type TurnReport } from './types.js';

// 回合内不弹任何权限询问（dontAsk）：未列入允许的工具直接拒绝，自动化不会卡在确认框上
const WRITER_TOOLS = ['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'WebFetch', 'WebSearch', 'mcp__aw'];
const READER_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite', 'WebFetch', 'WebSearch', 'mcp__aw', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)'];
// 提交走平台的 git_commit（范围检查 + Agent 身份）；推送和改写历史只归人
const DENIED = ['Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git reset --hard:*)', 'Bash(git clean:*)', 'Bash(git checkout -- :*)', 'Bash(git rebase:*)'];

const quote = (s: string) => `"${slash(s)}"`;

// 交互模式遇到未信任的新目录（如任务 worktree）会卡在确认框：若目录或其祖先尚未信任，预先写入用户配置
function ensureTrusted(dir: string) {
  if (process.env.NODE_ENV === 'test' || !existsSync(dir)) return;
  try {
    const resolved = slash(realpathSync.native?.(dir) ?? path.resolve(dir));
    const cfgPath = path.join(process.env.CLAUDE_CONFIG_DIR ?? os.homedir(), '.claude.json');
    const cfg = existsSync(cfgPath) ? (JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>) : {};
    const projects = ((cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {}) as Record<string, Record<string, unknown>>);
    const trusted = Object.entries(projects).some(([k, v]) => {
      if (!v?.hasTrustDialogAccepted) return false;
      const norm = slash(k).replace(/\/+$/, '');
      const cmp = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      const cmpK = process.platform === 'win32' ? norm.toLowerCase() : norm;
      return cmp === cmpK || cmp.startsWith(`${cmpK}/`);
    });
    if (trusted) return;
    projects[resolved] = { ...(projects[resolved] ?? {}), hasTrustDialogAccepted: true };
    cfg.projects = projects;
    const tmp = `${cfgPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    renameSync(tmp, cfgPath);
  } catch {
    // 写配置失败不阻断启动，用户仍可在应用内终端里手动确认
  }
}

function launch(bin: string, spec: HarnessSpec) {
  ensureTrusted(spec.cwd);
  const mcpFile = path.join(spec.runDir, 'claude-mcp.json');
  const settingsFile = path.join(spec.runDir, 'claude-settings.json');
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { aw: { type: 'http', url: spec.mcpUrl, headers: { Authorization: `Bearer ${spec.token}` } } } }));
  const hook = [quote(spec.hook.node), quote(spec.hook.script), 'claude', quote(spec.hook.url), quote(spec.token)].join(' ');
  writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: hook, timeout: 15 }] }] } }));
  const session = spec.sessionId ? (spec.resume ? ['--resume', spec.sessionId] : ['--session-id', spec.sessionId]) : [];
  const model = spec.model ? ['--model', spec.model] : [];
  // 首条消息放最前：后面的 --allowedTools 等是可变参数，会把跟在后面的位置参数吞掉
  return {
    file: bin,
    args: [
      spec.prompt,
      ...session,
      ...model,
      '--mcp-config', mcpFile, '--strict-mcp-config',
      '--settings', settingsFile,
      '--append-system-prompt', spec.systemHint,
      '--permission-mode', 'dontAsk',
      '--add-dir', spec.runDir, ...spec.extraWritable,
      '--allowedTools', ...(spec.writer ? WRITER_TOOLS : READER_TOOLS),
      '--disallowedTools', ...DENIED,
    ],
  };
}

const CLAUDE_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const;

function readClaudeModels() {
  const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'settings.json');
  let defaultModel: string | null = null;
  let env: Record<string, string> = {};
  try {
    if (existsSync(settingsPath)) {
      const cfg = JSON.parse(readFileSync(settingsPath, 'utf8')) as { model?: unknown; env?: Record<string, unknown> };
      if (cfg.env && typeof cfg.env === 'object') {
        env = Object.fromEntries(Object.entries(cfg.env).filter((kv): kv is [string, string] => typeof kv[1] === 'string'));
      }
      if (typeof cfg.model === 'string' && cfg.model.trim()) defaultModel = cfg.model.trim();
      else if (env.ANTHROPIC_MODEL?.trim()) defaultModel = env.ANTHROPIC_MODEL.trim();
    }
  } catch { /* ignore */ }
  const models: { id: string; label?: string }[] = [];
  const seen = new Set<string>();
  const add = (id: string, label?: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    models.push(label && label !== id ? { id, label } : { id });
  };
  if (defaultModel && !CLAUDE_ALIASES.includes(defaultModel as (typeof CLAUDE_ALIASES)[number])) add(defaultModel);
  for (const alias of CLAUDE_ALIASES) {
    const mapped = env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`];
    add(alias, mapped ? `${alias} (${mapped})` : alias);
  }
  return { defaultModel, models };
}

interface TranscriptLine { type?: string; timestamp?: string; message?: { id?: string; usage?: Record<string, number>; content?: unknown } }

// transcript 里同一条消息会随流式输出出现多次，按 message.id 去重；缓存读取不计入输入
async function readTranscript(file: string, since: string) {
  const seen = new Map<string, { in: number; out: number }>();
  let last: string | undefined;
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw.trim()) continue;
    let line: TranscriptLine;
    try { line = JSON.parse(raw) as TranscriptLine; } catch { continue; }
    if (line.type !== 'assistant' || !line.message || (line.timestamp && line.timestamp < since)) continue;
    const u = line.message.usage;
    if (u && line.message.id) seen.set(line.message.id, { in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), out: u.output_tokens ?? 0 });
    const text = Array.isArray(line.message.content)
      ? (line.message.content as { type?: string; text?: string }[]).filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n')
      : undefined;
    if (text) last = text;
  }
  let inputTokens = 0;
  let outputTokens = 0;
  for (const v of seen.values()) { inputTokens += v.in; outputTokens += v.out; }
  return { usage: seen.size > 0 ? { inputTokens, outputTokens } : undefined, last };
}

async function parseTurn(payload: Record<string, unknown>, since: string): Promise<TurnReport> {
  const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : undefined;
  const t = transcript && existsSync(transcript) ? await readTranscript(transcript, since).catch(() => undefined) : undefined;
  const direct = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : undefined;
  return {
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined,
    lastMessage: direct ?? t?.last,
    usage: t?.usage,
  };
}

export const claudeCode: HarnessAdapter = {
  id: 'claude-code',
  label: 'Claude Code',
  presetSession: true,
  resolveBin: () => resolveOnPath('claude', process.env.AW_CLAUDE_BIN),
  versionArgs: ['--version'],
  models: readClaudeModels,
  launch,
  parseTurn,
};
