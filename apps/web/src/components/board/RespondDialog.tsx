import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// 拒绝 / 反提案对话框：理由必填；反提案可改 module 与验收命令
export function RespondDialog({
  action,
  taskTitle,
  module: initialModule,
  submitting,
  error,
  onSubmit,
  onClose,
}: {
  action: 'reject' | 'counter';
  taskTitle: string;
  module?: string | undefined;
  submitting: boolean;
  error: string | null;
  onSubmit: (body: { action: 'reject' | 'counter'; reason: string; counter?: { input?: Record<string, unknown>; acceptance?: { kind: string; run: string; expect: { exitCode: number } }[] } }) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [module, setModule] = useState(initialModule ?? '');
  const [acceptance, setAcceptance] = useState('');
  const isCounter = action === 'counter';

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30" data-testid="respond-dialog">
      <div className="w-96 rounded bg-white p-4 shadow-lg">
        <div className="pb-2 text-sm font-semibold">
          {isCounter ? '反提案' : '拒绝'}「{taskTitle}」
        </div>
        <label className="block pb-2 text-xs">
          理由（必填）
          <Input className="mt-1" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="respond-reason" placeholder="为什么" />
        </label>
        {isCounter && (
          <>
            <label className="block pb-2 text-xs">
              module（可选，覆盖原值）
              <Input className="mt-1" value={module} onChange={(e) => setModule(e.target.value)} />
            </label>
            <label className="block pb-2 text-xs">
              验收命令（每行一条，留空则不修改）
              <textarea
                className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm"
                rows={2}
                value={acceptance}
                onChange={(e) => setAcceptance(e.target.value)}
              />
            </label>
          </>
        )}
        {error && <div className="pb-2 text-xs text-red-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            disabled={submitting || !reason.trim()}
            onClick={() =>
              onSubmit({
                action,
                reason: reason.trim(),
                ...(isCounter
                  ? {
                      counter: {
                        ...(module.trim() ? { input: { module: module.trim() } } : {}),
                        ...(acceptance.trim()
                          ? { acceptance: acceptance.split('\n').filter(Boolean).map((run) => ({ kind: 'command' as const, run: run.trim(), expect: { exitCode: 0 } })) }
                          : {}),
                      },
                    }
                  : {}),
              })
            }
          >
            {submitting ? '提交中…' : '提交'}
          </Button>
        </div>
      </div>
    </div>
  );
}
