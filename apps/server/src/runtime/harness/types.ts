// 外部 harness 适配层：每种 CLI 一个适配器，平台只关心「怎么启动、怎么续跑、回合结束时报了什么」
export interface HarnessSpec {
  runId: string;
  title: string;
  // 任务 worktree；没有 worktree 的会话回合用 run 目录
  cwd: string;
  runDir: string;
  contextFile: string;
  // 单行首条消息：完整说明放在 contextFile，命令行装不下也不该带换行
  prompt: string;
  systemHint: string;
  mcpUrl: string;
  token: string;
  hook: { node: string; script: string; url: string };
  sessionId: string | null;
  resume: boolean;
  // 指定给外部 CLI 的模型名（如 sonnet / gpt-6.1-sol）；为空时走工具自己的默认配置
  model?: string | null | undefined;
  // 只有任务 assignee（或测试阶段的测试工程师）能写 worktree
  writer: boolean;
  // worktree 的 git 公共目录在主仓库里：不放进可写目录就提交不了
  extraWritable: string[];
}

export interface HarnessLaunch { file: string; args: string[]; env?: Record<string, string> }
export interface HarnessModel { id: string; label?: string | undefined }
export interface HarnessModelsInfo { defaultModel: string | null; models: HarnessModel[] }

export interface TurnReport {
  sessionId?: string | undefined;
  lastMessage?: string | undefined;
  // 本 run 开始以来的累计用量；读不到就留空，平台按估算处理
  usage?: { inputTokens: number; outputTokens: number } | undefined;
}

export interface HarnessAdapter {
  id: string;
  label: string;
  // Claude Code 可以预先指定会话 id；Codex 的会话 id 由回合结束通知带回
  presetSession: boolean;
  resolveBin(): string | null;
  versionArgs: string[];
  models?(): HarnessModelsInfo;
  launch(bin: string, spec: HarnessSpec): HarnessLaunch;
  parseTurn(payload: Record<string, unknown>, since: string): Promise<TurnReport>;
}

// 平台已有的读写 / 命令工具由 harness 自己的工具替代，不经 MCP 暴露
export const NATIVE_TOOLS = new Set(['read_file', 'list_files', 'search_code', 'git_diff', 'apply_patch', 'run_command']);

export const slash = (p: string) => p.replace(/\\/g, '/');
