import { MockLanguageModelV4 } from 'ai/test';

type Options = Parameters<MockLanguageModelV4['doGenerate']>[0];
type Result = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

// 脚本化 mock：按模板 id 与对话轮次给出确定性工具调用（覆盖剧本 A 全流程）
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

// user 消息的原始文本：按行匹配必须用它，JSON 序列化后换行被转义，[^\n]+ 会一路吃到结尾
function userText(prompt: Options['prompt']): string {
  return prompt.flatMap((m) => (m.role === 'user' ? m.content : [])).map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

// 当前任务 id / module：从 user 消息 task 层提取（buildContext 写入）
function taskInfo(prompt: Options['prompt']): { module: string; seed: number } {
  const user = userText(prompt);
  const mod = user.match(/module：([^\n]+)/)?.[1]?.trim() ?? '';
  // 让两个实现者走不同文件：用任务标题里的字符做种子
  const seed = user.length % 1000;
  return { module: mod, seed };
}

function toolCall(name: string, args: unknown, id: string): Result['content'][number] {
  return { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(args) };
}

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
};

// reviewer 按任务计数（同一任务首审 request_changes、再审 approve），不能按模型实例（每 run 都是新会话）
const reviewCounts = new Map<string, number>();

export function createScriptedMock() {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'scripted',
    doGenerate: async (options: Options): Promise<Result> => {
      const system = options.prompt.find((m) => m.role === 'system');
      const sys = system && system.role === 'system' ? system.content : '';
      const tpl = selfTemplateId(sys);
      const agents = agentList(sys);
      const { module: mod, seed } = taskInfo(options.prompt);
      const toolRounds = options.prompt.filter((m) => m.role === 'tool').length;
      const isFeedback = JSON.stringify(options.prompt).includes('feedback') || JSON.stringify(options.prompt).includes('回退');

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
        const fes = agents.filter((a) => a.templateId === 'frontend-dev');
        switch (toolRounds) {
          case 0:
            return calls([['respond_task', { action: 'accept' }]]);
          case 1:
            return calls([['create_task', {
              title: `实现 A（mock）`,
              input: { title: `实现 A（mock）`, kind: 'feature', priority: 'p1', module: mod || 'src/' },
              stage: 'implement',
              assigneeAgentId: fes[0]?.id ?? 'unknown',
            }]]);
          case 2:
            return calls([['create_task', {
              title: `实现 B（mock）`,
              input: { title: `实现 B（mock）`, kind: 'feature', priority: 'p1', module: mod || 'src/' },
              stage: 'implement',
              assigneeAgentId: (fes[1] ?? fes[0])?.id ?? 'unknown',
            }]]);
          case 3:
            return calls([['send_message', { content: '已拆分为两个实现子任务（mock）。' }]]);
          default:
            return done('任务已拆分完成（mock 总结）。');
        }
      }

      if (tpl === 'frontend-dev' || tpl === 'backend-dev') {
        // 文件名按 agent 名区分，避免两个实现者建同名文件造成合并冲突
        const selfName = sys.match(/你是 ([^（\s]+)/)?.[1] ?? 'x';
        // 用整条 user 上下文哈希保证任务间唯一（同名任务也不能撞文件）
        const allUser = options.prompt.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content)).join('\n');
        let h = 0;
        for (const ch of selfName + allUser) h = (h * 31 + ch.charCodeAt(0)) % 997;
        const file = `${mod || 'src/'}/feature-${h % 100}.txt`;
        void seed;
        switch (toolRounds) {
          case 0:
            return calls([['read_file', { path: 'package.json' }]]);
          case 1:
            return calls([['apply_patch', { creates: [{ path: file, content: `feature impl ${seed}${isFeedback ? ' fixed' : ''}\n` }] }]]);
          case 2:
            return calls([['run_command', { command: 'node check.js' }]]);
          case 3:
            return calls([['git_commit', { message: `feat: ${file}` }]]);
          case 4:
            return calls([['submit_change', { summary: `实现 ${file}${isFeedback ? '（feedback 修订）' : ''}` }]]);
          default:
            return done('实现完成（mock 总结）。');
        }
      }

      if (tpl === 'test-engineer') {
        switch (toolRounds) {
          case 0: return calls([['git_diff', {}]]);
          case 1: return calls([['run_command', { command: 'node check.js' }]]);
          case 2: return calls([['send_message', { content: '测试就绪（mock）。' }]]);
          default: return done('测试完成（mock 总结）。');
        }
      }

      if (tpl === 'reviewer') {
        const user = userText(options.prompt);
        const taskKey = `${user.match(/任务：([^\n]+)/)?.[1] ?? 'unknown'}|${user.match(/分支：([^\n]+)/)?.[1] ?? ''}`;
        const n = reviewCounts.get(taskKey) ?? 0;
        reviewCounts.set(taskKey, n + 1);
        if (n === 0) {
          if (toolRounds === 0) return calls([['review_change', { decision: 'request_changes', summary: '需补充说明（mock）', comments: [{ path: 'x.txt', body: '请补充说明' }] }]]);
          return done('已退回修改（mock）。');
        }
        if (toolRounds === 0) return calls([['review_change', { decision: 'approve', summary: 'LGTM（mock）' }]]);
        return done('审查通过（mock）。');
      }

      return done('mock 总结。');
    },
  });
}
