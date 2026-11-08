// ARCHITECTURE §7 M0 简化版上下文装配：纯函数，便于测试
export interface ContextInput {
  pluginDescription: string;
  agentName: string;
  agentRole: string | null;
  isSteward: boolean;
  stage: string | null;
  templateId: string | null;
  agents: { id: string; name: string; templateId: string | null }[];
  task: { title: string; intent: string | null; inputJson: string | null; acceptanceJson: string | null; typeId: string | null; blockedReason?: string | null } | null;
  threadTitle?: string | undefined;
  trigger?: string | undefined;
  dispatchTargets?: string | undefined;
  parentTask: { title: string; status: string; intent: string | null } | null;
  siblingTasks: { title: string; status: string }[];
  threadMessages: { senderId: string | null; senderType: string | null; content: string | null; kind: string | null; note?: string | undefined }[];
  budgetTokens?: number;
  promptContent?: string | undefined;
  isReviewer?: boolean;
  module?: string | undefined;
  branch?: string | undefined;
  moduleFiles?: string | undefined;
  moduleInfo?: string | undefined;
  lastTestRun?: string | undefined;
  openComments?: string | undefined;
  designs?: string | undefined;
}

const tokensToChars = (t: number) => t * 3;

// 不同的唤醒原因要做不同的事：被 @ 是回话，不是重新开工
const TRIGGER_RULES: Record<string, string> = {
  mentioned: '你在会话里被 @ 到：针对最新消息简短回应，直接说结论；需要别人时 @ 对方名字；不要复述别人说过的话，不要开始实现工作',
  moderated: '你是这场讨论的主持人：能答就答，需要专业意见时 @ 对应成员；已经有结论时调用 record_decision 收束',
  conclude: '请调用 record_decision，把到目前为止的讨论压缩成结论，然后结束',
  block_triage: '任务上报了阻塞：能在本台决定就调用 resolve_block 并说明怎么做；超出本台决策权就调用 escalate_block 交给人',
  human_reply: '人刚发了消息：先读最新一条，按它调整后继续；只需回话时简短回复即可',
};

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
    `RUN_TRIGGER:${input.trigger ?? ''}`,
    ...(input.trigger && TRIGGER_RULES[input.trigger] ? [`- 本次：${TRIGGER_RULES[input.trigger]}`] : []),
    ...(input.dispatchTargets ? [`- 可派发的工作台：\n${input.dispatchTargets}`] : []),
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
      input.task ? `任务：${input.task.title}` : `会话：${input.threadTitle ?? ''}`,
      input.task?.intent ? `intent：${input.task.intent}` : '',
      input.task?.typeId ? `type：${input.task.typeId}` : '',
      input.task?.inputJson ? `input：${input.task.inputJson}` : '',
      input.task?.acceptanceJson ? `验收：${input.task.acceptanceJson}` : '',
      input.task?.blockedReason ? `阻塞：${input.task.blockedReason}` : '',
      input.parentTask ? `父任务：${input.parentTask.title}（${input.parentTask.status}）${input.parentTask.intent ?? ''}` : '',
      input.siblingTasks.length > 0
        ? `兄弟子任务：${input.siblingTasks.map((s) => `${s.title}(${s.status})`).join('、')}`
        : '',
      input.module ? `module：${input.module}` : '',
      input.moduleInfo ? `相关 Module（职责边界，别把别的 Module 的事做进来）：\n${input.moduleInfo}` : '',
      input.branch ? `分支：${input.branch}` : '',
      input.moduleFiles ? `module 文件：\n${input.moduleFiles}` : '',
      input.lastTestRun ? `最近验收：\n${input.lastTestRun}` : '',
      input.openComments ? `未解决审查意见：\n${input.openComments}` : '',
      input.designs ? `设计稿清单：\n${input.designs}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    taskBudget,
  );

  // reviewer 隔离：审查时不看实现过程，只有被人 @ 才读会话
  const hideThread = input.isReviewer && input.trigger !== 'mentioned';
  const threadLines = hideThread ? [] : input.threadMessages.map((m) => `${m.senderType ?? '?'}:${m.senderId ?? '?'} [${m.kind ?? 'chat'}] ${m.note ? `（${m.note}）` : ''}${m.content ?? ''}`);
  const threadText = hideThread ? '' : clip(threadLines.join('\n'), threadBudget);

  return {
    system,
    messages: [{ role: 'user', content: [taskText, threadText].filter(Boolean).join('\n\n---\n\n') }],
  };
}
