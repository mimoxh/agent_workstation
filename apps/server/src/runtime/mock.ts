import { MockLanguageModelV4 } from 'ai/test';
type Options = Parameters<MockLanguageModelV4['doGenerate']>[0];
type Result = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

// 脚本化 mock：按模板 id 与对话轮次给出确定性工具调用
// 从 system prompt 中提取本台 Agent 名单（由 context.ts 写入 "AGENTS_JSON:" 行）
function agentList(system: string | undefined): { id: string; name: string; templateId: string }[] {
  const line = (system ?? '').split('\n').find((l) => l.startsWith('AGENTS_JSON:'));
  if (!line) return [];
  try {
    return JSON.parse(line.slice('AGENTS_JSON:'.length)) as { id: string; name: string; templateId: string }[];
  } catch {
    return [];
  }
}

function selfTemplateId(system: string | undefined): string {
  const line = (system ?? '').split('\n').find((l) => l.startsWith('SELF_TEMPLATE:'));
  return line ? line.slice('SELF_TEMPLATE:'.length).trim() : '';
}

function toolCall(name: string, args: unknown, id: string): Result['content'][number] {
  return { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(args) };
}

const USAGE = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 50, text: 50, reasoning: 0 } };

export function createScriptedMock() {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'scripted',
    doGenerate: async (options: Options): Promise<Result> => {
      const system = options.prompt.find((m) => m.role === 'system');
      const sys = system && system.role === 'system' ? system.content : '';
      const tpl = selfTemplateId(sys);
      const agents = agentList(sys);
      // 已完成的工具轮次 = prompt 中 tool role 消息数
      const toolRounds = options.prompt.filter((m) => m.role === 'tool').length;

      const done = (text: string): Result => ({
        content: [{ type: 'text', text }],
        finishReason: 'stop' as never,
        usage: USAGE as never,
        warnings: [],
      });
      const calls = (items: [string, unknown][]): Result => ({
        content: items.map(([n, a], i) => toolCall(n, a, `call_${toolRounds}_${i}`)),
        finishReason: 'tool-calls' as never,
        usage: USAGE as never,
        warnings: [],
      });

      if (tpl === 'architect') {
        const fe = agents.find((a) => a.templateId === 'frontend-dev');
        switch (toolRounds) {
          case 0:
            return calls([['respond_task', { action: 'accept' }]]);
          case 1:
            return calls([['create_task', {
              title: '实现（mock 子任务）',
              intent: '按父任务拆分',
              input: { title: '实现（mock 子任务）', kind: 'feature', priority: 'p1', module: 'apps/web/src/components/board/' },
              stage: 'implement',
              assigneeAgentId: fe?.id ?? 'unknown',
            }]]);
          case 2:
            return calls([['send_message', { content: '已接单并拆分给前端开发（mock）。' }]]);
          default:
            return done('任务已拆分完成（mock 总结）。');
        }
      }
      if (tpl === 'frontend-dev') {
        if (toolRounds === 0) return calls([['send_message', { content: '收到，阶段 3 才有代码工具' }]]);
        return done('等待阶段 3 的代码工具（mock 总结）。');
      }
      return done('mock 总结。');
    },
  });
}
