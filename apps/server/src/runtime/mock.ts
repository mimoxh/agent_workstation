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

function runTrigger(system: string | undefined): string {
  const line = (system ?? '').split('\n').find((l) => l.startsWith('RUN_TRIGGER:'));
  return line ? line.slice('RUN_TRIGGER:'.length).trim() : '';
}

const CONVERSATION_TRIGGERS = new Set(['mentioned', 'moderated', 'conclude', 'block_triage', 'human_reply']);

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

const lastToolOutput = (prompt: Options['prompt']) => JSON.stringify(prompt.filter((m) => m.role === 'tool').at(-1) ?? '').replaceAll('\\"', '"');

function toolCall(name: string, args: unknown, id: string): Result['content'][number] {
  return { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(args) };
}

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
};

const MOCK_DESIGN = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>mock</title><style>
:root{--font-sans:system-ui,sans-serif;--font-display:Georgia,"Songti SC",serif;--color-bg:#faf9f6;--color-text:#1c1b19;--color-primary:#1f4d3f;--color-on-primary:#fff;--radius-md:8px;--space-3:16px;--space-6:64px}
body{margin:0;font-family:var(--font-sans);background:var(--color-bg);color:var(--color-text)}
main{padding:var(--space-6);display:grid;gap:var(--space-3)}
h1{font-family:var(--font-display);font-size:48px;margin:0}
button{justify-self:start;padding:var(--pad) calc(var(--pad)*2);border:0;border-radius:var(--radius-md);background:var(--color-primary);color:var(--color-on-primary)}
</style></head><body><main><h1>Mock 落地页</h1><p>一句说明文字</p><button>开始使用</button></main></body></html>`;

// 设计师的回合：消息带选中的元素就改那个元素，带评论就处理评论，否则出一份新稿
function designerTurn<T>(user: string, calls: (items: [string, unknown][]) => T): T {
  if (user.includes('人选中了这些元素')) {
    const elDesign = user.match(/id: ([\w-]+) v\d+/)?.[1];
    const anchor = user.match(/<\w+>「([^」]*)」 selector:/)?.[1];
    if (elDesign && anchor) return calls([['edit_design', { id: elDesign, edits: [{ oldText: anchor, newText: `${anchor}（已修订）` }], reason: '按选中元素修改（mock）' }]]);
  }
  const designId = user.match(/design: ([\w-]+)/)?.[1];
  if (designId) {
    const ids = [...user.matchAll(/comment id: ([\w-]+)/g)].map((m) => m[1]);
    return calls([
      ['edit_design', { id: designId, edits: [{ oldText: 'Mock 落地页</h1>', newText: 'Mock 落地页（已修订）</h1>' }], reason: '处理评论（mock）' }],
      ['resolve_design_comments', { ids, note: '已按评论修改（mock）' }],
    ]);
  }
  return calls([['write_design', { title: 'Mock 落地页', html: MOCK_DESIGN, brief: '由对话生成（mock）', tweaks: [{ id: 'pad', label: '按钮内边距', cssVar: '--pad', type: 'range', value: '12', min: 4, max: 24, step: 2, unit: 'px' }], reason: '初稿（mock）' }]]);
}

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
        finishReason: { unified: 'stop', raw: 'stop' } as never,
        usage: USAGE as never,
        warnings: [],
      });
      const calls = (items: [string, unknown][]): Result => ({
        content: items.map(([n, a], i) => toolCall(n, a, `call_${toolRounds}_${i}`)),
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' } as never,
        usage: USAGE as never,
        warnings: [],
      });

      // 会话回合：确定性地覆盖点名、主持、收束、分诊
      const trigger = runTrigger(sys);
      if (CONVERSATION_TRIGGERS.has(trigger)) {
        const user = userText(options.prompt);
        const lastLine = user.split('\n').filter(Boolean).at(-1) ?? '';
        if (tpl === 'failure-analyst' && toolRounds === 1) {
          const runId = userText(options.prompt).match(/分析测试运行 ([0-9a-f-]{36})/)?.[1];
          const fingerprint = lastToolOutput(options.prompt).match(/"fingerprint":"([0-9a-f]+)"/)?.[1];
          if (runId && fingerprint) return calls([['save_triage', { runId, groups: [{ fingerprint, category: 'product_bug', confidence: 'medium', summary: '断言失败，疑似产品缺陷（mock）', evidence: '报错原文（mock）' }] }]]);
        }
        if (toolRounds > 0) return done(trigger === 'moderated' && tpl === 'pm' ? '已起草任务，确认后派发（mock）。' : tpl === 'designer' ? '设计稿已更新（mock）。' : tpl === 'failure-analyst' ? '已完成失败分析（mock）。' : tpl === 'case-designer' ? '用例草稿已保存（mock）。' : tpl === 'qa-lead' ? '质量现状已汇总（mock）。' : '');
        if (trigger === 'conclude') return calls([['record_decision', { summary: '结论：按当前方案推进（mock）。' }]]);
        if (trigger === 'block_triage') {
          if (user.includes('需人决策')) return calls([['escalate_block', { reason: '需要人来决定（mock）' }]]);
          return calls([['resolve_block', { note: '按默认方案继续（mock）' }]]);
        }
        if (tpl === 'failure-analyst') {
          const runId = user.match(/分析测试运行 ([0-9a-f-]{36})/)?.[1];
          return runId ? calls([['get_test_run', { runId }]]) : done('需要运行 id（mock）。');
        }
        if (tpl === 'case-designer') return calls([['save_test_cases', { cases: [{ title: '空输入时提示必填（mock）', priority: 'p1', steps: [{ action: '提交空表单', expected: '显示必填提示' }] }] }]]);
        if (tpl === 'qa-lead') return calls([['qa_overview', {}]]);
        if (tpl === 'designer' && (trigger === 'moderated' || trigger === 'human_reply')) return designerTurn(user, calls);
        if (trigger === 'moderated') {
          if (tpl === 'pm') return calls([['create_task', { title: lastLine.split('] ').at(-1)?.slice(0, 30) || '新任务（mock）', intent: '由对话起草（mock）' }]]);
          const others = agents.filter((a) => a.templateId !== tpl);
          const spoke = /agent:[^\n]*\[chat\]/.test(user);
          if (!spoke && others[0]) return done(`@${others[0].name} 你怎么看（mock）`);
          return calls([['record_decision', { summary: '结论：采纳成员意见（mock）。' }]]);
        }
        if (trigger === 'mentioned' && lastLine.includes('转问架构师')) return done('@架构师 这里需要你确认（mock）');
        return done('收到（mock）。');
      }

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
        // 文件名取任务分支：任务间唯一、同一任务的修订轮次不变，否则会撞名造成合并冲突
        const branch = userText(options.prompt).match(/分支：aw\/([^\s]+)/)?.[1] ?? 'none';
        const file = `${mod || 'src/'}/feature-${branch}.txt`;
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
