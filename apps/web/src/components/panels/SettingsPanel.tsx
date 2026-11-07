import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson } from '@/lib/format';
import { usePlugins, useRepoStatus, type ProjectDetail, type WorkstationDetail } from '@/lib/queries';

interface Settings {
  repoPath?: string;
  targetBranch?: string;
  baseBranch?: string;
  commands?: Record<string, string>;
  commandTimeoutSec?: number;
  requireHumanFor?: string[];
  preset?: string;
  budget?: { tokens?: number } | null;
}

const COMMANDS: [key: string, label: string][] = [['setup', '安装'], ['build', '构建'], ['test', '测试'], ['lint', '检查']];

function RepoStatus({ wsId }: { wsId: string }) {
  const q = useRepoStatus(wsId);
  if (!q.data) return null;
  return (
    <p className="flex items-center gap-2 text-sm" data-testid="repo-status">
      <Badge tone={q.data.ok ? 'ok' : 'bad'}>{q.data.ok ? '仓库可用' : '不可用'}</Badge>
      <span className="text-muted">{q.data.error ?? `当前检出 ${q.data.branch}`}</span>
    </p>
  );
}

function ProjectSection({ project }: { project: ProjectDetail }) {
  const current = parseJson<{ tokens?: number } | null>(project.budgetJson, null);
  const [tokens, setTokens] = useState(String(current?.tokens ?? ''));
  const save = useMutation({
    mutationFn: async () => unwrap(await api.projects[':id'].$patch({ param: { id: project.id }, json: { budget: Number(tokens) > 0 ? { tokens: Number(tokens) } : null } })),
    onSuccess: () => toast('项目预算已保存', 'ok'),
  });
  return (
    <section className="space-y-3 border-t border-rule pt-4" aria-label="项目">
      <h3 className="text-sm text-ink-2">项目</h3>
      <div className="flex items-end gap-2">
        <Field label="项目预算（tokens）" hint="超限后所有 Agent 停止，留空不限" className="w-64">
          <Input className="measured" type="number" min={1} value={tokens} onChange={(e) => setTokens(e.target.value)} data-testid="project-budget" />
        </Field>
        <Button disabled={save.isPending} onClick={() => save.mutate()} data-testid="project-budget-save">保存预算</Button>
      </div>
      <p className="flex gap-3 text-sm">
        <a href={`/api/projects/${project.id}/export`} className="text-cool hover:underline" download>导出全量 JSON</a>
        <a href={`/api/projects/${project.id}/export?format=md`} className="text-cool hover:underline" download>导出 Markdown</a>
      </p>
    </section>
  );
}

export function SettingsPanel({ ws, project }: { ws: WorkstationDetail; project: ProjectDetail }) {
  const s = parseJson<Settings>(ws.settingsJson, {});
  const isDev = ws.manifest?.id === 'dev';
  const [name, setName] = useState(ws.name);
  const [repoPath, setRepoPath] = useState(s.repoPath ?? '');
  const [targetBranch, setTarget] = useState(s.targetBranch ?? 'develop');
  const [baseBranch, setBase] = useState(s.baseBranch ?? 'main');
  const [commands, setCommands] = useState<Record<string, string>>(s.commands ?? {});
  const [timeout, setTimeoutSec] = useState(String(s.commandTimeoutSec ?? 120));
  const [humanMerge, setHumanMerge] = useState(s.requireHumanFor?.includes('merge') ?? false);
  const [preset, setPreset] = useState(s.preset ?? '');
  const [budget, setBudget] = useState(String(s.budget?.tokens ?? ''));
  const presets = usePlugins().data?.find((p) => p.id === ws.manifest?.id)?.presets ?? [];
  const root = ws.parentId === null;

  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.workstations[':id'].$patch({
          param: { id: ws.id },
          json: {
            name: name.trim(),
            ...(isDev
              ? {
                  settings: {
                    repoPath: repoPath.trim(),
                    targetBranch: targetBranch.trim(),
                    baseBranch: baseBranch.trim(),
                    commands: Object.fromEntries(Object.entries(commands).filter(([, v]) => v.trim())),
                    commandTimeoutSec: Number(timeout) || 120,
                    requireHumanFor: humanMerge ? ['merge'] : [],
                    preset,
                    budget: Number(budget) > 0 ? { tokens: Number(budget) } : null,
                  },
                }
              : {}),
          },
        }),
      ),
    onSuccess: () => toast('设置已保存', 'ok'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={submit} className="h-full overflow-y-auto" data-testid="settings-panel">
      <div className="max-w-xl space-y-5 p-6">
        <Field label="工作台名称" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {isDev && (
          <>
            <section className="space-y-3">
              <h3 className="text-sm text-ink-2">代码仓库</h3>
              <Field label="仓库路径" hint="本地 git 仓库的绝对路径，worktree 与合并都在这里进行">
                <Input className="measured" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} data-testid="settings-repo" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="目标分支" hint="Agent 改动合并到这里">
                  <Input className="measured" value={targetBranch} onChange={(e) => setTarget(e.target.value)} />
                </Field>
                <Field label="基线分支" hint="目标分支不存在时从这里创建">
                  <Input className="measured" value={baseBranch} onChange={(e) => setBase(e.target.value)} />
                </Field>
              </div>
              <RepoStatus wsId={ws.id} />
            </section>
            <section className="space-y-3">
              <h3 className="text-sm text-ink-2">命令</h3>
              <div className="grid grid-cols-2 gap-3">
                {COMMANDS.map(([k, label]) => (
                  <Field key={k} label={label}>
                    <Input className="measured" value={commands[k] ?? ''} onChange={(e) => setCommands({ ...commands, [k]: e.target.value })} />
                  </Field>
                ))}
              </div>
              <Field label="命令超时（秒）" className="w-40">
                <Input className="measured" type="number" min={1} value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} />
              </Field>
            </section>
            <section className="space-y-3">
              <h3 className="text-sm text-ink-2">协作方式</h3>
              {presets.length > 0 && (
                <Field label="预设" hint={presets.find((p) => p.id === preset)?.description ?? '成员怎样讨论和交接；只影响之后新建的任务会话'}>
                  <Select value={preset} onChange={(e) => setPreset(e.target.value)} data-testid="settings-preset">
                    <option value="">默认</option>
                    {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="工作台预算（tokens）" hint="超限后本台 Agent 停止，留空不限" className="w-64">
                <Input className="measured" type="number" min={1} value={budget} onChange={(e) => setBudget(e.target.value)} data-testid="ws-budget" />
              </Field>
            </section>
            <label className="flex items-start gap-2 text-sm text-ink-2">
              <input type="checkbox" className="mt-1 accent-[var(--color-accent)]" checked={humanMerge} onChange={(e) => setHumanMerge(e.target.checked)} data-testid="settings-human-merge" />
              <span>
                合并前需要人工确认
                <span className="block text-xs text-muted">审查通过后进收件箱等你点「入队合并」，否则自动进入串行合并队列。</span>
              </span>
            </label>
          </>
        )}
        <Button type="submit" variant="primary" disabled={save.isPending || !name.trim()}>{save.isPending ? '保存中…' : '保存设置'}</Button>
        {root && <ProjectSection project={project} />}
      </div>
    </form>
  );
}
