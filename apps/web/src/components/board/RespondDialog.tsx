import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { parseJson } from '@/lib/format';
import type { BoardTask } from '@/lib/queries';
import { toChecks } from './schemaForm';

// 拒绝 / 反提案：理由必填；反提案可改 module 与验收命令，重新派发时生效
export function RespondDialog({ action, task, onClose }: { action: 'reject' | 'counter'; task: BoardTask; onClose: () => void }) {
  const current = parseJson<{ module?: string }>(task.inputJson, {}).module ?? '';
  const [reason, setReason] = useState('');
  const [module, setModule] = useState(current);
  const [acceptance, setAcceptance] = useState('');
  const isCounter = action === 'counter';

  const respond = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const checks = toChecks(acceptance);
      return unwrap(
        await api.tasks[':id'].respond.$post({
          param: { id: task.id },
          json: {
            action,
            reason: reason.trim(),
            ...(isCounter
              ? {
                  counter: {
                    ...(module.trim() && module.trim() !== current ? { input: { module: module.trim() } } : {}),
                    ...(checks.length > 0 ? { acceptance: checks } : {}),
                  },
                }
              : {}),
          },
        }),
      );
    },
    onSuccess: onClose,
  });

  return (
    <Dialog title={`${isCounter ? '反提案' : '拒绝'}「${task.title}」`} onClose={onClose} testId="respond-dialog">
      <DialogForm error={respond.error?.message} submitting={respond.isPending} submitLabel="提交" canSubmit={!!reason.trim()} onSubmit={() => respond.mutate()} onCancel={onClose}>
        <Field label="理由" required>
          <Textarea autoFocus rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="respond-reason" />
        </Field>
        {isCounter && (
          <>
            <Field label="模块路径">
              <Input className="measured" value={module} onChange={(e) => setModule(e.target.value)} />
            </Field>
            <Field label="验收命令" hint="每行一条，留空则不修改">
              <Textarea className="measured" rows={2} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
            </Field>
          </>
        )}
      </DialogForm>
    </Dialog>
  );
}
