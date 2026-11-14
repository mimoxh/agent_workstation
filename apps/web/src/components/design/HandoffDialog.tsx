import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import type { ProjectDetail, WorkstationDetail } from '@/lib/queries';
import type { DesignDoc } from './model';

export function HandoffDialog({ design, ws, project, openComments, onClose }: { design: DesignDoc; ws: WorkstationDetail; project: ProjectDetail; openComments: number; onClose: () => void }) {
  const targets = project.workstations.filter((w) => w.pluginId === 'dev');
  const navigate = useNavigate();
  const [target, setTarget] = useState(targets.find((w) => w.id === ws.id)?.id ?? targets[0]?.id ?? '');
  const [module, setModule] = useState('');
  const [priority, setPriority] = useState<'p0' | 'p1' | 'p2'>('p1');
  const [note, setNote] = useState('');
  const [qaCases, setQaCases] = useState(false);
  const [pageUrl, setPageUrl] = useState('');
  const send = useMutation({
    meta: { silent: true },
    mutationFn: async () => unwrap(await api.designs[':id'].handoff.$post({ param: { id: design.id }, json: { targetWorkstationId: target, module: module.trim(), priority, ...(note.trim() ? { note: note.trim() } : {}), ...(pageUrl.trim() ? { pageUrl: pageUrl.trim() } : {}), ...(qaCases ? { qaCases } : {}) } })),
    onSuccess: (r) => {
      onClose();
      void navigate({ to: '/projects/$projectId/tasks/$taskId', params: { projectId: project.id, taskId: r.taskId } });
    },
  });
  return (
    <Dialog title="生成实现任务" onClose={onClose} testId="handoff-dialog">
      {targets.length === 0 ? (
        <p className="text-sm text-muted">这个项目还没有开发工作台。先用顶栏的 + 挂载一个，绑定代码仓库后再交接。</p>
      ) : (
        <DialogForm error={send.error?.message} submitting={send.isPending} submitLabel="创建开发任务" canSubmit={!!target && !!module.trim()} onSubmit={() => send.mutate()} onCancel={onClose}>
          <p className="text-sm text-muted">
            冻结「{design.data.title}」v{design.version} 的快照，在开发台起草一个任务，确认后由你派发。
            {openComments > 0 && <span className="text-accent"> 还有 {openComments} 条未解决的评论，它们不会带过去。</span>}
          </p>
          <Field label="开发工作台" hint={target === ws.id ? '默认本台，也可以交给项目里其他开发台' : undefined}>
            <Select value={target} onChange={(e) => setTarget(e.target.value)} data-testid="handoff-target">
              {targets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </Field>
          <Field label="改动范围" required hint="仓库内路径，多个用逗号分隔">
            <Input autoFocus className="measured" value={module} placeholder="apps/web/src/pages/landing" onChange={(e) => setModule(e.target.value)} data-testid="handoff-module" />
          </Field>
          <Field label="优先级">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as 'p0' | 'p1' | 'p2')}>
              <option value="p0">p0</option>
              <option value="p1">p1</option>
              <option value="p2">p2</option>
            </Select>
          </Field>
          <Field label="给开发的备注">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Field label="页面地址" hint="填了就在验收里加一条设计稿对比：平台起「视觉验收服务」后截图，与设计稿差异超过 25% 判失败">
            <Input className="measured" value={pageUrl} placeholder="http://localhost:{port}/" onChange={(e) => setPageUrl(e.target.value)} data-testid="handoff-page-url" />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" checked={qaCases} onChange={(e) => setQaCases(e.target.checked)} data-testid="handoff-qa-cases" />同时请目标台的用例设计起草验收用例
          </label>
        </DialogForm>
      )}
    </Dialog>
  );
}
