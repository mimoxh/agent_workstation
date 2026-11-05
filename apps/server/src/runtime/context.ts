// ARCHITECTURE §7 M0 简化版上下文装配：纯函数，便于测试
export interface ContextInput {
  pluginDescription: string;
  agentName: string;
  agentRole: string | null;
  isSteward: boolean;
  stage: string | null;
  templateId: string | null;
  agents: { id: string; name: string; templateId: string | null }[];
  task: { title: string; intent: string | null; inputJson: string | null; acceptanceJson: string | null; typeId: string | null };
  parentTask: { title: string; status: string; intent: string | null } | null;
  siblingTasks: { title: string; status: string }[];
  threadMessages: { senderId: string | null; senderType: string | null; content: string | null; kind: string | null }[];
  budgetTokens?: number;
  promptContent?: string;
  isReviewer?: boolean;
  module?: string;
  branch?: string;
  moduleFiles?: string;
  lastTestRun?: string;
  openComments?: string;
}

const tokensToChars = (t: number) => t * 3;

function clip(s: string, maxTokens: number): string {
  const max = tokensToChars(maxTokens);
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

export function buildContext(input: ContextInput): { system: string; messages: { role: 'user'; content: string }[] } {
  const total = input.budgetTokens ?? 24000;
  const systemBudget = Math.floor(total * 0.4);
  const taskBudget = Math.floor(total * 0.4);
  const threadBudget = Math.floor(total * 0.2);

  const rules = [
    '- 交接一律用工具完成，不要在文本里口头交接',
    '- 完成后给出简短总结，不再调用工具',
    '- 不确定时用 request_human 请示',
    `- 本台 Agent 名单（create_task 指派用）：${input.agents.map((a) => `${a.name}(${a.id})`).join('、')}`,
    `AGENTS_JSON:${JSON.stringify(input.agents)}`,
    `SELF_TEMPLATE:${input.templateId ?? ''}`,
  ].join('\n');

  const system = clip(
    [
      `插件：${input.pluginDescription}`,
      input.promptContent ? `提示词：\n${input.promptContent}` : '',
      `你是 ${input.agentName}（${input.agentRole ?? ''}）${input.isSteward ? '【steward】' : ''}，当前 stage：${input.stage ?? '—'}`,
      '规则：',
      rules,
    ].join('\n\n'),
    systemBudget,
  );

  const taskText = clip(
    [
      `任务：${input.task.title}`,
      input.task.intent ? `intent：${input.task.intent}` : '',
      input.task.typeId ? `type：${input.task.typeId}` : '',
      input.task.inputJson ? `input：${input.task.inputJson}` : '',
      input.task.acceptanceJson ? `验收：${input.task.acceptanceJson}` : '',
      input.parentTask ? `父任务：${input.parentTask.title}（${input.parentTask.status}）${input.parentTask.intent ?? ''}` : '',
      input.siblingTasks.length > 0
        ? `兄弟子任务：${input.siblingTasks.map((s) => `${s.title}(${s.status})`).join('、')}`
        : '',
      input.module ? `module：${input.module}` : '',
      input.branch ? `分支：${input.branch}` : '',
      input.moduleFiles ? `module 文件：\n${input.moduleFiles}` : '',
      input.lastTestRun ? `最近验收：\n${input.lastTestRun}` : '',
      input.openComments ? `未解决审查意见：\n${input.openComments}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    taskBudget,
  );

  // reviewer 隔离：上下文不含线程消息
  const threadLines = input.isReviewer ? [] : input.threadMessages.map((m) => `${m.senderType ?? '?'}:${m.senderId ?? '?'} [${m.kind ?? 'chat'}] ${m.content ?? ''}`);
  const threadText = input.isReviewer ? '' : clip(threadLines.join('\n'), threadBudget);

  return {
    system,
    messages: [{ role: 'user', content: [taskText, threadText].filter(Boolean).join('\n\n---\n\n') }],
  };
}
