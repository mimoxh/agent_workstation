import type { TaskEvent, TaskStatus } from '@aw/domain';
import type { BadgeTone } from '@/components/ui/badge';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: '草稿',
  dispatched: '已派发',
  accepted: '已接单',
  rejected: '已拒绝',
  countered: '反提案',
  in_progress: '进行中',
  blocked: '阻塞',
  escalated: '已上报',
  submitted: '已提交',
  reviewing: '评审中',
  done: '完成',
  cancelled: '已取消',
};

// amber = 等人，cool = 机器在动，bad = 出问题，ok = 收口
export const STATUS_TONE: Record<TaskStatus, BadgeTone> = {
  draft: 'neutral',
  dispatched: 'cool',
  accepted: 'cool',
  rejected: 'bad',
  countered: 'amber',
  in_progress: 'cool',
  blocked: 'amber',
  escalated: 'amber',
  submitted: 'cool',
  reviewing: 'amber',
  done: 'ok',
  cancelled: 'neutral',
};

export const EVENT_LABEL: Record<TaskEvent, string> = {
  dispatch: '派发',
  accept: '接单',
  reject: '拒绝',
  counter: '反提案',
  redispatch: '重新派发',
  revise: '修改后重派',
  start: '开始',
  submit: '提交验收',
  block: '标记阻塞',
  unblock: '解除阻塞',
  escalate: '上报',
  resolve: '决策后恢复',
  begin_review: '开始评审',
  approve: '通过',
  send_back: '退回',
  cancel: '取消任务',
};

// 固定列；其余状态归入语义最接近的列（卡片上仍标真实 status）
export const COLUMNS: Array<{ id: string; title: string; statuses: TaskStatus[] }> = [
  { id: 'draft', title: '草稿', statuses: ['draft', 'rejected', 'countered'] },
  { id: 'dispatched', title: '已派发', statuses: ['dispatched', 'accepted'] },
  { id: 'in_progress', title: '进行中', statuses: ['in_progress'] },
  { id: 'blocked', title: '阻塞', statuses: ['blocked', 'escalated'] },
  { id: 'reviewing', title: '评审中', statuses: ['submitted', 'reviewing'] },
  { id: 'done', title: '完成', statuses: ['done', 'cancelled'] },
];

export const PROPOSAL_LABEL: Record<string, string> = {
  pending: '待审',
  approved: '已通过',
  changes_requested: '要求修改',
  merged: '已合并',
  rejected: '已驳回',
  superseded: '已被取代',
  conflicted: '合并冲突',
  reverted: '已回滚',
};

export const PROPOSAL_TONE: Record<string, BadgeTone> = {
  pending: 'amber',
  approved: 'cool',
  changes_requested: 'amber',
  merged: 'ok',
  rejected: 'neutral',
  superseded: 'neutral',
  conflicted: 'bad',
  reverted: 'neutral',
};

export const RUN_LABEL: Record<string, string> = {
  running: '运行中',
  completed: '完成',
  error: '失败',
  interrupted: '已中断',
  cancelled: '已取消',
};

export const RUN_TONE: Record<string, BadgeTone> = {
  running: 'cool',
  completed: 'ok',
  error: 'bad',
  interrupted: 'amber',
  cancelled: 'neutral',
};

export const TEST_LABEL: Record<string, string> = { passed: '通过', failed: '失败', error: '错误' };
export const TEST_TONE: Record<string, BadgeTone> = { passed: 'ok', failed: 'bad', error: 'bad' };

export const INBOX_LABEL: Record<string, string> = {
  task_rejected: '任务被拒绝',
  task_countered: '反提案',
  blocked: '阻塞升级',
  proposal_review: '提案待合并',
  run_failed: '运行失败',
  command_confirm: '命令确认',
  human_request: '请求决策',
  budget: '预算超限',
  gate_confirm: '阶段确认',
  qa_regression: '回归失败',
};

export const TRIGGER_LABEL: Record<string, string> = {
  task_assigned: '派发',
  stage_enter: '阶段进入',
  mentioned: '@提及',
  manual: '手动',
  feedback: '反馈',
  retry: '重试',
  human_reply: '人工回复',
  moderated: '主持',
  conclude: '收束',
  block_triage: '阻塞分诊',
};

export const TOOL_LABEL: Record<string, string> = {
  read_file: '读文件',
  list_files: '列目录',
  sync_branch: '同步分支',
  search_code: '查代码',
  git_diff: '看改动',
  apply_patch: '改文件',
  git_commit: '提交 commit',
  submit_change: '提交提案',
  review_change: '审查',
  run_command: '跑命令',
  send_message: '发消息',
  create_task: '拆任务',
  respond_task: '回复派发',
  record_decision: '写结论',
  propose_entity: '写提案',
};

export const EVENT_LOG_LABEL: Record<string, string> = {
  task_created: '创建任务',
  task_updated: '编辑任务',
  task_assigned: '指派',
  task_status_changed: '状态变更',
  task_stage_changed: '阶段推进',
  task_resumed: '恢复执行',
  command_executed: '执行命令',
};
