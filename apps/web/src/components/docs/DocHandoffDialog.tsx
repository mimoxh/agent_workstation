import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonClass } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { toast } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import type { DocDetail, DocRepo, ProjectDetail } from '@/lib/queries';

// 交接对话框：展示目标与门禁结果；缺目标时只能去补文档信息，
// 其它未满足的门禁项可以勾选人工放行并填理由强行走
export function DocHandoffDialog({ doc, repos, project, onClose, onEditMeta }: { doc: DocDetail; repos: DocRepo[]; project: ProjectDetail; onClose: () => void; onEditMeta: () => void }) {
  const gate = doc.gate;
  const targetRepo = repos.find((r) => r.repo === doc.target_repo);
  const targetOk = !!doc.target_repo && !!doc.target_path;
  const [module, setModule] = useState(doc.target_path ?? '');
  const [priority, setPriority] = useState<'p0' | 'p1' | 'p2'>('p1');
  const [note, setNote] = useState('');
  const [citations, setCitations] = useState<'strip' | 'footnotes'>('strip');
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const send = useMutation({
    meta: { silent: true },
    mutationFn: async () =>
      unwrap(
        await api.docs[':id'].handoff.$post({
          param: { id: doc.id },
          json: {
            module: module.trim(),
            priority,
            citations,
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(gate && !gate.ok ? { overrideReason: reason.trim() } : {}),
          },
        }),
      ),
    onSuccess: (r) => {
      setTaskId(r.taskId);
      toast('已交接给开发台', 'ok');
    },
    onError: (e) => setError(e.message),
  });
  const needOverride = !!gate && !gate.ok && targetOk;
  const canSubmit = targetOk && !!module.trim() && (!needOverride || (override && !!reason.trim()));

  return (
    <Dialog title="交给开发" onClose={onClose} testId="doc-handoff-dialog">
      {taskId ? (
        <div className="grid gap-4">
          <p className="flex items-start gap-2.5 rounded-ctl bg-ok-soft px-3.5 py-2.5 text-sm text-ink-2"><Icon name="check" className="mt-0.5 text-ok" />已在开发台起草任务，确认派发后实现者会按成品逐字写入。</p>
          <div className="flex justify-end gap-2">
            <Button variant="quiet" onClick={onClose}>完成</Button>
            <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId: project.id, taskId }} data-testid="doc-handoff-task-link" className={buttonClass('primary')}>
              查看开发任务
            </Link>
          </div>
        </div>
      ) : (
        <DialogForm error={error} submitting={send.isPending} submitLabel="创建开发任务" canSubmit={canSubmit} onSubmit={() => send.mutate()} onCancel={onClose}>
          <p className="text-sm text-muted">冻结「{doc.title}」v{doc.version} 的成品文本，在开发台起草一个写入任务。</p>
          {targetOk ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card bg-paper-2 px-3.5 py-3 text-sm">
              <span className="text-ink-2">写入 {targetRepo?.name ?? doc.target_repo}</span>
              <span className="measured text-xs text-muted">{doc.target_path}</span>
              {!targetRepo?.bound ? <Badge tone="amber">仓库未绑定</Badge> : null}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-ctl bg-accent-soft px-3.5 py-2.5 text-sm" data-testid="doc-handoff-missing-target">
              <Icon name="alert" className="text-accent" />
              <span className="text-ink-2">还没有设置目标仓库或目标路径</span>
              <Button size="sm" className="ml-auto" onClick={onEditMeta} data-testid="doc-handoff-edit-meta">去填文档信息</Button>
            </div>
          )}
          {gate && !gate.ok && targetOk ? (
            <div className="grid gap-2.5 rounded-card bg-bad-soft px-3.5 py-3">
              <p className="flex items-center gap-2 text-sm font-semibold text-ink"><Icon name="alert" className="text-bad" />交接条件未满足</p>
              <ul className="grid gap-1">
                {gate.reasons.map((r, i) => (
                  <li key={i} className="flex gap-2 text-sm text-ink-2" data-testid="doc-handoff-gate-reason"><span className="text-bad">•</span><span>{r}</span></li>
                ))}
              </ul>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" className="size-4 accent-primary" checked={override} onChange={(e) => setOverride(e.target.checked)} data-testid="doc-handoff-override" />
                人工放行（理由会记录在交接里）
              </label>
              {override ? <Textarea rows={2} className="bg-paper" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="为什么现在放行" data-testid="doc-handoff-reason" /> : null}
            </div>
          ) : null}
          <Field label="改动范围" required hint="仓库内路径，多个用逗号分隔">
            <Input className="measured" value={module} placeholder="docs/" onChange={(e) => setModule(e.target.value)} data-testid="doc-handoff-module" />
          </Field>
          <Field label="优先级">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as 'p0' | 'p1' | 'p2')} data-testid="doc-handoff-priority">
              <option value="p0">p0</option>
              <option value="p1">p1</option>
              <option value="p2">p2</option>
            </Select>
          </Field>
          <Field label="引用标记">
            <Select value={citations} onChange={(e) => setCitations(e.target.value as 'strip' | 'footnotes')} data-testid="doc-handoff-citations">
              <option value="strip">去掉引用标记</option>
              <option value="footnotes">保留为脚注</option>
            </Select>
          </Field>
          <Field label="给开发的备注">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-testid="doc-handoff-note" />
          </Field>
        </DialogForm>
      )}
    </Dialog>
  );
}
