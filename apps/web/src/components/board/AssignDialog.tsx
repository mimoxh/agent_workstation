import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import type { BoardTask, WsAgent } from '@/lib/queries';

export function AssignDialog({ task, agents, onClose }: { task: BoardTask; agents: WsAgent[]; onClose: () => void }) {
  const [agentId, setAgentId] = useState(agents.find((a) => a.isSteward !== 1)?.id ?? agents[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const assign = useMutation({
    meta: { silent: true },
    mutationFn: async () =>
      unwrap(await api.tasks[':id'].assign.$post({ param: { id: task.id }, json: { agentId, ...(reason.trim() ? { reason: reason.trim() } : {}) } })),
    onSuccess: onClose,
  });
  return (
    <Dialog title={`指派「${task.title}」`} onClose={onClose} testId="assign-dialog">
      <DialogForm error={assign.error?.message} submitting={assign.isPending} submitLabel="指派" canSubmit={!!agentId} onSubmit={() => assign.mutate()} onCancel={onClose}>
        <Field label="Agent" hint="指派后立即开始运行">
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} data-testid="assign-agent">
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="理由" hint="直接指派绕过 steward，建议写明原因">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </DialogForm>
    </Dialog>
  );
}
