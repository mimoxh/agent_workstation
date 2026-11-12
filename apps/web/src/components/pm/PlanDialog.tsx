import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson } from '@/lib/format';
import { useProject, useProjectTasks, useWsEntities } from '@/lib/queries';
import { cn } from '@/lib/utils';

export interface PlanTask {
  id: string;
  title: string;
  startAt: string | null;
  dueAt: string | null;
  milestoneId?: string | null | undefined;
  dependsOn?: string[] | undefined;
}

// 排期与依赖：日期、里程碑、前置任务（整组替换）；错误留在对话框里
export function PlanDialog({ projectId, task, onClose }: { projectId: string; task: PlanTask; onClose: () => void }) {
  const [startAt, setStartAt] = useState(task.startAt ?? '');
  const [dueAt, setDueAt] = useState(task.dueAt ?? '');
  const [milestoneId, setMilestoneId] = useState(task.milestoneId ?? '');
  const [deps, setDeps] = useState<string[]>(task.dependsOn ?? []);
  const [q, setQ] = useState('');

  const project = useProject(projectId).data;
  const root = project?.workstations.find((w) => w.parentId === null);
  const entities = useWsEntities(root?.id).data?.entities ?? [];
  const milestones = entities.filter((e) => e.entityType === 'Milestone');
  const tasks = (useProjectTasks(projectId).data ?? []).filter((t) => t.id !== task.id && t.status !== 'cancelled');
  const shown = tasks.filter((t) => !q || t.title.toLowerCase().includes(q.toLowerCase()));

  const save = useMutation({
    meta: { silent: true },
    mutationFn: async () =>
      unwrap(
        await api.tasks[':id'].plan.$patch({
          param: { id: task.id },
          json: { startAt: startAt || null, dueAt: dueAt || null, milestoneId: milestoneId || null, dependsOn: deps },
        }),
      ),
    onSuccess: onClose,
  });

  const toggle = (id: string) => setDeps(deps.includes(id) ? deps.filter((d) => d !== id) : [...deps, id]);

  return (
    <Dialog title={`排期与依赖：${task.title}`} onClose={onClose} testId="plan-dialog">
      <DialogForm error={save.error?.message} submitting={save.isPending} submitLabel="保存" canSubmit onSubmit={() => save.mutate()} onCancel={onClose}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="开始日期">
            <Input type="date" value={startAt} onChange={(e) => setStartAt(e.target.value)} data-testid="plan-start" />
          </Field>
          <Field label="截止日期">
            <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} data-testid="plan-due" />
          </Field>
        </div>
        <Field label="里程碑">
          <Select value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)} data-testid="plan-milestone">
            <option value="">无</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>{String(parseJson<{ name?: string }>(m.dataJson, {}).name ?? '未命名')}</option>
            ))}
          </Select>
        </Field>
        <Field label="前置任务" hint="这些任务完成后本任务才能派发">
          <Input placeholder="搜索任务" value={q} onChange={(e) => setQ(e.target.value)} data-testid="plan-dep-search" />
          <ul className="mt-1.5 max-h-44 overflow-y-auto rounded-card border border-rule" role="group" aria-label="前置任务">
            {shown.length === 0 && <li className="px-2.5 py-2 text-xs text-muted">没有可选任务</li>}
            {shown.map((t) => (
              <li key={t.id}>
                <label className={cn('flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-hover', deps.includes(t.id) && 'bg-paper-2')} >
                  <input type="checkbox" checked={deps.includes(t.id)} onChange={() => toggle(t.id)} data-testid={`plan-dep-${t.id}`} />
                  <span className="min-w-0 flex-1 truncate text-ink-2">{t.title}</span>
                  <span className="measured shrink-0 text-xs text-muted">{t.status}</span>
                </label>
              </li>
            ))}
          </ul>
        </Field>
      </DialogForm>
    </Dialog>
  );
}
