import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { usePlugins, type ProjectDetail } from '@/lib/queries';

function CommandFields({ build, test, onBuild, onTest }: { build: string; test: string; onBuild: (v: string) => void; onTest: (v: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="构建命令">
        <Input className="measured" value={build} onChange={(e) => onBuild(e.target.value)} data-testid="command-build" />
      </Field>
      <Field label="测试命令">
        <Input className="measured" value={test} onChange={(e) => onTest(e.target.value)} data-testid="command-test" />
      </Field>
    </div>
  );
}

const devCommands = (build: string, test: string) => ({ ...(build.trim() ? { build: build.trim() } : {}), ...(test.trim() ? { test: test.trim() } : {}) });

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [template, setTemplate] = useState<'dev' | 'blank'>('dev');
  const [repoPath, setRepoPath] = useState('');
  const [build, setBuild] = useState('pnpm build');
  const [test, setTest] = useState('pnpm test');
  const navigate = useNavigate();
  const dev = template === 'dev';
  const create = useMutation({
    meta: { silent: true },
    mutationFn: async () =>
      unwrap(
        await api.projects.$post({
          json: {
            name: name.trim(),
            ...(goal.trim() ? { goal: goal.trim() } : {}),
            ...(dev ? { template: { repoPath: repoPath.trim(), commands: devCommands(build, test) } } : {}),
          },
        }),
      ),
    onSuccess: (r) => void navigate({ to: '/projects/$projectId', params: { projectId: r.id } }),
  });
  return (
    <Dialog title="新建项目" onClose={onClose} testId="project-dialog">
      <DialogForm error={create.error?.message} submitting={create.isPending} submitLabel="创建" canSubmit={!!name.trim() && (!dev || !!repoPath.trim())} onSubmit={() => create.mutate()} onCancel={onClose}>
        <Field label="项目名" required>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="project-name" />
        </Field>
        <Field label="目标">
          <Textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>
        <Field label="模板" hint={dev ? '根工作台 + 开发工作台，架构师、前端 ×2、后端、测试、审查都就位' : '只有根工作台，之后按需挂载'}>
          <Select value={template} onChange={(e) => setTemplate(e.target.value as 'dev' | 'blank')} data-testid="project-template">
            <option value="dev">开发项目</option>
            <option value="blank">空白项目</option>
          </Select>
        </Field>
        {dev && (
          <>
            <Field label="仓库路径" required hint="本地 git 仓库的绝对路径">
              <Input className="measured" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} data-testid="project-repo" />
            </Field>
            <CommandFields build={build} test={test} onBuild={setBuild} onTest={setTest} />
          </>
        )}
      </DialogForm>
    </Dialog>
  );
}

export function MountDialog({ project, onClose }: { project: ProjectDetail; onClose: () => void }) {
  const plugins = usePlugins();
  const navigate = useNavigate();
  const options = (plugins.data ?? []).filter((p) => p.id !== 'pm' && p.enabled);
  const [pluginId, setPluginId] = useState('');
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [build, setBuild] = useState('pnpm build');
  const [test, setTest] = useState('pnpm test');
  const chosen = pluginId || options[0]?.id || '';
  const plugin = options.find((p) => p.id === chosen);
  const devStations = project.workstations.filter((w) => w.pluginId === 'dev');
  const [qaSourcePick, setQaSource] = useState('');
  const qaSource = qaSourcePick || devStations[0]?.id || '';

  const mount = useMutation({
    meta: { silent: true },
    mutationFn: async () =>
      unwrap(
        await api.projects[':id'].workstations.$post({
          param: { id: project.id },
          json: {
            pluginId: chosen,
            name: name.trim(),
            ...(chosen === 'dev' ? { settings: { repoPath: repoPath.trim(), targetBranch: 'develop', baseBranch: 'main', commands: devCommands(build, test) } } : {}),
            ...(chosen === 'qa' && qaSource ? { settings: { sourceWorkstationId: qaSource } } : {}),
          },
        }),
      ),
    onSuccess: (r) => {
      onClose();
      void navigate({ to: '/projects/$projectId/ws/$wsId', params: { projectId: project.id, wsId: r.id } });
    },
  });

  return (
    <Dialog title="挂载工作台" onClose={onClose} testId="mount-dialog">
      <DialogForm error={mount.error?.message} submitting={mount.isPending} submitLabel="挂载" canSubmit={!!name.trim() && !!chosen} onSubmit={() => mount.mutate()} onCancel={onClose}>
        <Field label="插件" hint={plugin?.description}>
          <Select value={chosen} onChange={(e) => setPluginId(e.target.value)} data-testid="mount-plugin">
            {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="工作台名称" required>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="mount-name" />
        </Field>
        {chosen === 'dev' && (
          <>
            <Field label="仓库路径" hint="本地 git 仓库的绝对路径，挂载后可在「设置」里改">
              <Input className="measured" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
            </Field>
            <CommandFields build={build} test={test} onBuild={setBuild} onTest={setTest} />
          </>
        )}
        {chosen === 'qa' && (
          <Field label="被测的开发台" hint={devStations.length ? '测试台读它的仓库、目标分支和安装命令，缺陷也派给它' : '这个项目还没有开发工作台，挂载后要先挂一个才能运行测试'}>
            <Select value={qaSource} onChange={(e) => setQaSource(e.target.value)} data-testid="mount-qa-source">
              {devStations.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
        )}
      </DialogForm>
    </Dialog>
  );
}
