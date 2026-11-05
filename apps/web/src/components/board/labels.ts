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

export const STATUS_TONE: Record<TaskStatus, BadgeTone> = {
  draft: 'neutral',
  dispatched: 'blue',
  accepted: 'blue',
  rejected: 'red',
  countered: 'amber',
  in_progress: 'blue',
  blocked: 'red',
  escalated: 'amber',
  submitted: 'purple',
  reviewing: 'purple',
  done: 'green',
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
  cancel: '取消',
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
