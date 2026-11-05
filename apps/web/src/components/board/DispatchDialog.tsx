import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { enumOf as enumOfShared } from './schemaForm';

export interface DispatchTarget {
  id: string;
  name: string;
  taskTypes: { id: string; name: string; inputSchema: Record<string, unknown> }[];
}

// 派发对话框：目标工作台 + 任务类型 + inputSchema 的 enum 字段
export function DispatchDialog({
  task,
  targets,
  submitting,
  error,
  onSubmit,
  onClose,
}: {
  task: { id: string; title: string; module?: string | undefined };
  targets: DispatchTarget[];
  submitting: boolean;
  error: string | null;
  onSubmit: (body: { targetWorkstationId: string; typeId: string; input: Record<string, unknown> }) => void;
  onClose: () => void;
}) {
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const target = targets.find((t) => t.id === targetId);
  const [typeId, setTypeId] = useState(target?.taskTypes[0]?.id ?? '');
  const [kind, setKind] = useState('feature');
  const [priority, setPriority] = useState('p1');

  const schema = target?.taskTypes.find((t) => t.id === typeId)?.inputSchema;
  const enumOf = (prop: string): string[] => enumOfShared(schema, prop);

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30" data-testid="dispatch-dialog">
      <div className="w-96 rounded bg-white p-4 shadow-lg">
        <div className="pb-2 text-sm font-semibold">派发「{task.title}」</div>
        <label className="block pb-2 text-xs">
          目标工作台
          <select className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm" value={targetId} data-testid="dispatch-target"
            onChange={(e) => { setTargetId(e.target.value); const t = targets.find((x) => x.id === e.target.value); setTypeId(t?.taskTypes[0]?.id ?? ''); }}>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="block pb-2 text-xs">
          任务类型
          <select className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm" value={typeId} data-testid="dispatch-type" onChange={(e) => setTypeId(e.target.value)}>
            {(target?.taskTypes ?? []).map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
          </select>
        </label>
        {enumOf('kind').length > 0 && (
          <label className="block pb-2 text-xs">kind
            <select className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm" value={kind} onChange={(e) => setKind(e.target.value)}>
              {enumOf('kind').map((v) => <option key={v}>{v}</option>)}
            </select>
          </label>
        )}
        {enumOf('priority').length > 0 && (
          <label className="block pb-2 text-xs">priority
            <select className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {enumOf('priority').map((v) => <option key={v}>{v}</option>)}
            </select>
          </label>
        )}
        <div className="pb-2 text-xs text-neutral-500">module：{task.module ?? '（未填）'}</div>
        {error && <div className="pb-2 text-xs text-red-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            disabled={submitting || !targetId || !typeId}
            onClick={() =>
              onSubmit({
                targetWorkstationId: targetId,
                typeId,
                input: { title: task.title, kind, priority, module: task.module ?? '' },
              })
            }
          >
            {submitting ? '派发中…' : '派发'}
          </Button>
        </div>
      </div>
    </div>
  );
}
