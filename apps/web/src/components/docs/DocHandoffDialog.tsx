import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { toast } from '@/components/ui/feedback';
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
        <div className="space-y-3">
          <p className="text-sm text-ink-2">已在开发台起草任务，确认派发后实现者会按成品逐字写入。</p>
          <div className="flex gap-2">
            <Link to="/projects/$projectId/tasks/$taskId" params={{ projectId: project.id, taskId }} data-testid="doc-handoff-task-link" className="text-sm text-primary underline">
              查看开发任务
            </Link>
            <Button variant="quiet" size="sm" className="ml-auto" onClick={onClose}>完成</Button>
          </div>
        </div>
      ) : (
        <DialogForm error={error} submitting={send.isPending} submitLabel="创建开发任务" canSubmit={canSubmit} onSubmit={() => send.mutate()} onCancel={onClose}>
          <p className="text-sm text-muted">冻结「{doc.title}」v{doc.version} 的成品文本，在开发台起草一个写入任务。</p>
          {targetOk ? (
            <div className="rounded-card border border-rule bg-canvas px-3 py-2 text-sm">
              <span className="text-ink-2">写入 {targetRepo?.name ?? doc.target_repo}</span>
              <span className="ml-1 font-mono text-xs text-muted">{doc.target_path}</span>
              {!targetRepo?.bound ? <Badge tone="amber" className="ml-2">仓库未绑定</Badge> : null}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-card border border-rule bg-canvas px-3 py-2 text-sm" data-testid="doc-handoff-missing-target">
              <span className="text-muted">还没有设置目标仓库或目标路径</span>
              <Button variant="quiet" size="sm" className="ml-auto" onClick={onEditMeta} data-testid="doc-handoff-edit-meta">去填文档信息</Button>
            </div>
          )}
          {gate && !gate.ok && targetOk ? (
            <div className="space-y-2 rounded-card border border-rule px-3 py-2">
              <p className="text-xs font-medium text-muted">交接条件未满足</p>
              <ul className="space-y-1">
                {gate.reasons.map((r, i) => (
                  <li key={i} className="text-sm text-bad" data-testid="doc-handoff-gate-reason">• {r}</li>
                ))}
              </ul>
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} data-testid="doc-handoff-override" />
                人工放行（理由会记录在交接里）
              </label>
              {override ? <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="为什么现在放行" data-testid="doc-handoff-reason" /> : null}
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
