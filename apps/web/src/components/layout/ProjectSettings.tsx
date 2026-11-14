import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { toast } from '@/components/ui/feedback';
import { Field, Input, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson } from '@/lib/format';
import type { ProjectDetail } from '@/lib/queries';
import { Page, PageHeader, SectionTitle } from './Page';

type Budget = { tokens?: number; costMicros?: number } | null;

function DeleteDialog({ project, onClose }: { project: ProjectDetail; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const del = useMutation({
    meta: { silent: true },
    mutationFn: async () => unwrap(await api.projects[':id'].$delete({ param: { id: project.id } })),
    onSuccess: () => {
      toast(`已删除项目「${project.name}」`, 'ok');
      void navigate({ to: '/' });
      qc.removeQueries({ queryKey: ['project', project.id] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  return (
    <Dialog title="永久删除项目" onClose={onClose} testId="project-delete-dialog">
      <DialogForm error={del.error?.message} submitting={del.isPending} submitLabel="永久删除" canSubmit={typed.trim() === project.name} onSubmit={() => del.mutate()} onCancel={onClose}>
        <p className="text-sm text-ink-2">项目下的工作台、任务、会话、运行记录、实体和知识库会全部删除，无法恢复。仓库里的代码和未合并的任务分支不会动。删除前可以先导出备份。</p>
        <Field label={`输入项目名「${project.name}」确认`}>
          <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="project-delete-confirm" />
        </Field>
      </DialogForm>
    </Dialog>
  );
}

function Lifecycle({ project }: { project: ProjectDetail }) {
  const archived = project.status === 'archived';
  const [deleting, setDeleting] = useState(false);
  const toggle = useMutation({
    mutationFn: async () =>
      unwrap(archived ? await api.projects[':id'].restore.$post({ param: { id: project.id } }) : await api.projects[':id'].archive.$post({ param: { id: project.id } })),
    onSuccess: (r) => toast(archived ? '项目已恢复' : r.cancelled ? `项目已归档，取消了 ${r.cancelled} 个进行中的运行` : '项目已归档', 'ok'),
  });
  return (
    <section aria-label="归档与删除" className="space-y-4 border-t border-rule pt-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium text-ink">{archived ? '恢复项目' : '归档项目'}{archived && <Badge tone="amber">已归档</Badge>}</p>
          <p className="mt-0.5 text-sm text-muted">
            {archived ? '恢复后项目回到控制台列表，Agent 可以继续接任务。' : '归档后项目从控制台列表和跨项目收件箱里隐去，Agent 不再开始新的运行，正在跑的会被取消。数据都保留，随时可以恢复。'}
          </p>
        </div>
        <Button
          disabled={toggle.isPending}
          data-testid="project-archive"
          onClick={() => {
            if (archived || window.confirm(`确认归档「${project.name}」？进行中的 Agent 运行会被取消。`)) toggle.mutate();
          }}
        >
          {archived ? '恢复项目' : '归档项目'}
        </Button>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">删除项目</p>
          <p className="mt-0.5 text-sm text-muted">{archived ? '永久删除项目和它的全部数据，无法恢复。' : '只能删除已归档的项目：先归档，确认没有 Agent 在跑，再删除。'}</p>
        </div>
        <Button variant="danger" disabled={!archived} onClick={() => setDeleting(true)} data-testid="project-delete">删除项目</Button>
      </div>
      {deleting && <DeleteDialog project={project} onClose={() => setDeleting(false)} />}
    </section>
  );
}

export function ProjectSettings({ project }: { project: ProjectDetail }) {
  const budget = parseJson<Budget>(project.budgetJson, null);
  const [name, setName] = useState(project.name);
  const [goal, setGoal] = useState(project.goal ?? '');
  const [folder, setFolder] = useState(project.folderPath ?? '');
  const [tokens, setTokens] = useState(String(budget?.tokens ?? ''));

  const save = useMutation({
    mutationFn: async () => {
      const n = Number(tokens);
      const nextBudget: Budget = n > 0 ? { ...budget, tokens: n } : budget?.costMicros ? { costMicros: budget.costMicros } : null;
      // 文件夹没改就不提交，免得已失效的旧路径挡住改名之类的保存
      const nextFolder = folder.trim() ? folder.trim() : null;
      return unwrap(
        await api.projects[':id'].$patch({
          param: { id: project.id },
          json: {
            name: name.trim(),
            goal: goal.trim() ? goal.trim() : null,
            budget: nextBudget,
            ...(nextFolder !== (project.folderPath ?? null) ? { folder: nextFolder } : {}),
          },
        }),
      );
    },
    onSuccess: () => toast('项目设置已保存', 'ok'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) save.mutate();
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="project-settings">
      <Page>
        <PageHeader icon="gear" title="项目设置" desc={project.name} />
        <form onSubmit={submit} className="mt-6 max-w-xl space-y-4">
          <Field label="项目名" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="project-name-setting" />
          </Field>
          <Field label="目标" hint="项目经理和各台 Agent 会看到它">
            <Textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} data-testid="project-goal-setting" />
          </Field>
          <Field label="项目文件夹" hint="本地文件夹的绝对路径，不需要是 git 仓库；Agent 可读，改文件要你审批。留空则解绑">
            <Input className="measured" value={folder} onChange={(e) => setFolder(e.target.value)} data-testid="project-folder-setting" />
          </Field>
          <Field label="项目预算（tokens）" hint="超限后所有 Agent 停止，留空不限" className="w-64">
            <Input className="measured" type="number" min={1} value={tokens} onChange={(e) => setTokens(e.target.value)} data-testid="project-budget" />
          </Field>
          <Button type="submit" variant="primary" disabled={save.isPending || !name.trim()} data-testid="project-settings-save">{save.isPending ? '保存中…' : '保存设置'}</Button>
        </form>

        <SectionTitle>导出</SectionTitle>
        <p className="flex gap-3 border-t border-rule pt-3 text-sm">
          <a href={`/api/projects/${project.id}/export`} className="text-cool hover:underline" download>导出全量 JSON</a>
          <a href={`/api/projects/${project.id}/export?format=md`} className="text-cool hover:underline" download>导出 Markdown</a>
        </p>

        <SectionTitle>归档与删除</SectionTitle>
        <Lifecycle project={project} />
      </Page>
    </div>
  );
}
