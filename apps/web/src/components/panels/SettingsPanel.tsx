import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson } from '@/lib/format';
import { usePlugins, useRemoteStatus, useRepoStatus, type ProjectDetail, type WorkstationDetail } from '@/lib/queries';

interface Settings {
  repoPath?: string;
  targetBranch?: string;
  baseBranch?: string;
  commands?: Record<string, string>;
  commandTimeoutSec?: number;
  requireHumanFor?: string[];
  sandbox?: { image?: string } | null;
  preset?: string;
  budget?: { tokens?: number } | null;
  remote?: { name: string; autoPush: boolean } | null;
}

const COMMANDS: [key: string, label: string][] = [['setup', '安装'], ['build', '构建'], ['test', '测试'], ['lint', '检查'], ['serve', '视觉验收服务']];

function RepoStatus({ wsId, baseBranch }: { wsId: string; baseBranch: string }) {
  const q = useRepoStatus(wsId);
  const sync = useMutation({
    mutationFn: async () => unwrap(await api.workstations[':id'].repo['sync-base'].$post({ param: { id: wsId } })),
    onSuccess: (r) => toast(r.status === 'up_to_date' ? '目标分支已包含基线分支' : '已把基线分支合进目标分支', 'ok'),
  });
  const init = useMutation({
    mutationFn: async () => unwrap(await api.workstations[':id'].repo.init.$post({ param: { id: wsId } })),
    onSuccess: (r) => {
      toast(`已初始化，提交了 ${r.files} 个文件`, 'ok');
      void q.refetch();
    },
  });
  const ack = useMutation({ mutationFn: async () => unwrap(await api.workstations[':id'].repo['ack-drift'].$post({ param: { id: wsId } })) });
  if (!q.data) return null;
  const d = q.data;
  const notGit = 'notGit' in d && d.notGit;
  const drift = 'drift' in d ? d.drift : null;
  if (notGit) {
    return (
      <div className="space-y-2" data-testid="repo-status">
        <p className="flex items-center gap-2 text-sm">
          <Badge tone="amber">不是 git 仓库</Badge>
        </p>
        <p className="text-sm text-ink-2">这个文件夹还不是 git 仓库。初始化会在这里 git init，并把现有文件做成初始提交（自动加 .gitignore 忽略 node_modules）。</p>
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={init.isPending}
          data-testid="repo-init"
          onClick={() => {
            if (window.confirm('确认在这个文件夹里初始化 git 仓库，并把现有文件做成初始提交？')) init.mutate();
          }}
        >
          初始化为 git 仓库
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="repo-status">
      <p className="flex items-center gap-2 text-sm">
        <Badge tone={d.ok ? 'ok' : 'bad'}>{d.ok ? '仓库可用' : '不可用'}</Badge>
        <span className="text-muted">{d.error ?? ('empty' in d && d.empty ? '空仓库：第一次运行任务时平台会初始化并建一个初始提交，可以用 scaffold 任务从零搭项目' : `当前检出 ${d.branch}`)}</span>
      </p>
      {drift?.external && (
        <div className="space-y-1.5 rounded-chip bg-accent-soft px-3 py-2 text-sm text-ink-2" data-testid="repo-drift">
          <p>目标分支在工作台之外有新提交（{drift.external.commits.length} 个），进行中的任务分支可能需要同步。</p>
          <ul className="measured space-y-0.5 text-xs text-muted">{drift.external.commits.map((c) => <li key={c}>{c}</li>)}</ul>
          <Button type="button" size="sm" variant="quiet" disabled={ack.isPending} onClick={() => ack.mutate()}>知道了</Button>
        </div>
      )}
      {drift && drift.baseAhead > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2" data-testid="repo-base-ahead">
          <span>基线分支 <code>{baseBranch}</code> 有 <span className="measured">{drift.baseAhead}</span> 个提交不在目标分支里</span>
          <Button type="button" size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? '同步中…' : '合进目标分支'}</Button>
        </p>
      )}
    </div>
  );
}

function RemoteActions({ wsId }: { wsId: string }) {
  const q = useRemoteStatus(wsId);
  const push = useMutation({
    mutationFn: async () => unwrap(await api.workstations[':id'].remote.push.$post({ param: { id: wsId } })),
    onSuccess: () => toast('已推送目标分支', 'ok'),
  });
  const pr = useMutation({
    mutationFn: async () => unwrap(await api.workstations[':id'].remote['pull-request'].$post({ param: { id: wsId } })),
    onSuccess: (r) => {
      toast(r.created ? '已创建 PR' : '已有开着的 PR', 'ok');
      window.open(r.url, '_blank', 'noopener');
    },
  });
  const issues = useMutation({
    mutationFn: async () => unwrap(await api.workstations[':id'].remote['import-issues'].$post({ param: { id: wsId } })),
    onSuccess: (r) => toast(`导入 ${r.created} 个 Issue 为草稿任务${r.skipped ? `，跳过 ${r.skipped} 个已导入的` : ''}`, 'ok'),
  });
  const d = q.data;
  if (!d) return null;
  if (!d.url) return <p className="text-sm text-muted" data-testid="remote-status">仓库没有这个远端，合并只留在本地。</p>;
  const busy = push.isPending || pr.isPending || issues.isPending;
  return (
    <div className="space-y-2" data-testid="remote-status">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <code className="min-w-0 truncate text-ink-2">{d.url}</code>
        {d.unpushed ? <Badge tone="amber">{d.unpushed} 个提交未推送</Badge> : null}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => push.mutate()}>推送目标分支</Button>
        {d.github && (
          <>
            <Button type="button" size="sm" disabled={busy || !d.ghReady} onClick={() => pr.mutate()}>开 PR 到基线分支</Button>
            <Button type="button" size="sm" disabled={busy || !d.ghReady} onClick={() => issues.mutate()}>导入 Issue</Button>
          </>
        )}
      </div>
      {d.github && !d.ghReady && <p className="text-xs text-muted">PR 与 Issue 需要本机 gh 已登录：{d.ghError}</p>}
    </div>
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
  const [remoteName, setRemoteName] = useState(s.remote?.name ?? '');
  const [autoPush, setAutoPush] = useState(s.remote?.autoPush ?? false);
  const [sandboxImage, setSandboxImage] = useState(s.sandbox?.image ?? '');
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
                    remote: remoteName.trim() ? { name: remoteName.trim(), autoPush } : null,
                    sandbox: sandboxImage.trim() ? { image: sandboxImage.trim() } : null,
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
              <RepoStatus wsId={ws.id} baseBranch={baseBranch} />
            </section>
            <section className="space-y-3" aria-label="远端">
              <h3 className="text-sm text-ink-2">远端</h3>
              <Field label="远端名" hint="留空则只在本地合并；凭据用你本机 git 的配置" className="w-64">
                <Input className="measured" value={remoteName} placeholder="origin" onChange={(e) => setRemoteName(e.target.value)} data-testid="settings-remote" />
              </Field>
              <label className="flex items-start gap-2 text-sm text-ink-2">
                <input type="checkbox" className="mt-1 accent-[var(--color-accent)]" checked={autoPush} disabled={!remoteName.trim()} onChange={(e) => setAutoPush(e.target.checked)} data-testid="settings-autopush" />
                <span>
                  合并或回滚后自动推送目标分支
                  <span className="block text-xs text-muted">推送失败不影响本地合并，会在任务会话里提示。</span>
                </span>
              </label>
              {s.remote?.name && <RemoteActions wsId={ws.id} />}
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
              <p className="text-xs text-muted">视觉验收服务：跑 visual 验收前平台在任务 worktree 里启动它，端口从环境变量 PORT 取，验收 url 里写 {'{port}'}。</p>
              <Field label="容器沙箱镜像" hint="留空则在本机直接执行。填了以后命令都在一次性容器里跑、默认断网；镜像要预装 pnpm。Docker 不可用时命令会被拒绝，不会退回本机" className="w-96">
                <Input className="measured" value={sandboxImage} placeholder="aw-runner:latest" onChange={(e) => setSandboxImage(e.target.value)} data-testid="settings-sandbox" />
              </Field>
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
        {root && (
          <p className="border-t border-rule pt-4 text-sm text-muted">
            项目名、目标、文件夹、预算、导出和归档在<Link to="/projects/$projectId/settings" params={{ projectId: project.id }} className="ml-0.5 text-cool hover:underline" data-testid="project-settings-link">项目设置</Link>里改。
          </p>
        )}
      </div>
    </form>
  );
}
