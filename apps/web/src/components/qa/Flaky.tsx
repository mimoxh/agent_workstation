import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogForm } from '@/components/ui/dialog';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Field, Textarea } from '@/components/ui/input';
import { api, unwrap } from '@/lib/api';
import { useQaFlaky, type QaFlaky } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { StatusStrip } from './charts';
import { Scroll, TABLE, TD, TH, type QaProps } from './shared';

type Row = QaFlaky['flaky'][number];

function QuarantineDialog({ wsId, row, onClose }: { wsId: string; row: Row; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const save = useMutation({
    meta: { silent: true },
    mutationFn: async () => unwrap(await api.workstations[':id'].entities.$post({ param: { id: wsId }, json: { entityType: 'TestQuarantine', data: { name: row.name, case_key: row.caseKey, reason: reason.trim(), status: 'active' }, reason: '人工隔离' } })),
    onSuccess: onClose,
  });
  return (
    <Dialog title={`隔离：${row.name}`} onClose={onClose} testId="qa-quarantine-dialog">
      <DialogForm error={save.error?.message} submitting={save.isPending} submitLabel="隔离" canSubmit={!!reason.trim()} onSubmit={() => save.mutate()} onCancel={onClose}>
        <p className="text-sm text-ink-2">隔离后用例照常运行和展示，但不计入发布结论。隔离不是修复，修好后记得解除。</p>
        <Field label="原因" required><Textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="qa-quarantine-reason" /></Field>
      </DialogForm>
    </Dialog>
  );
}

function useRelease() {
  return useMutation({
    mutationFn: async (v: { id: string; version: number; name: string; caseKey: string; reason: string | null }) => unwrap(await api.entities[':id'].$patch({ param: { id: v.id }, json: { data: { name: v.name, case_key: v.caseKey, reason: v.reason ?? '', status: 'released' }, baseVersion: v.version, reason: '解除隔离' } })),
  });
}

export function Flaky({ ws, go }: QaProps) {
  const q = useQaFlaky(ws.id);
  const release = useRelease();
  const [target, setTarget] = useState<Row | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const { flaky, quarantined } = q.data;
  return (
    <Scroll testId="qa-flaky">
      <p className="mb-3 text-xs text-muted">同一提交结果不一致，或最近反复在通过和失败之间翻转的用例。用「重跑同一提交」可以验证。</p>
      {flaky.length === 0 && quarantined.length === 0 ? <Empty title="没有发现不稳定用例">结果会随着运行次数积累自动判断。</Empty> : (
        <>
          {flaky.length > 0 && (
            <div className="overflow-x-auto">
              <table className={TABLE} data-testid="qa-flaky-table">
                <thead><tr className="border-b border-rule"><th className={TH}>用例</th><th className={TH}>最近结果（旧 → 新）</th><th className={TH}>依据</th><th className={cn(TH, 'text-right')}>翻转率</th><th className={TH}><span className="sr-only">操作</span></th></tr></thead>
                <tbody>
                  {flaky.map((f) => (
                    <tr key={f.caseKey} className="border-b border-rule" data-testid="qa-flaky-row">
                      <td className={cn(TD, 'max-w-80')}>
                        <span className="block truncate text-ink">{f.name}</span>
                        <span className="measured block truncate text-xs text-muted">{f.classname}</span>
                      </td>
                      <td className={TD}><StatusStrip items={f.strip} onPick={(id) => go('runs', id)} /></td>
                      <td className={TD}>{f.sameCommit ? <Badge tone="amber">同提交不一致</Badge> : <Badge>反复翻转</Badge>}</td>
                      <td className={cn(TD, 'measured text-right text-xs')}>{Math.round(f.flipRate * 100)}%</td>
                      <td className={cn(TD, 'text-right')}>
                        {f.quarantineId
                          ? <Button size="sm" disabled={release.isPending} onClick={() => release.mutate({ id: f.quarantineId!, version: f.quarantineVersion!, name: f.name, caseKey: f.caseKey, reason: f.reason })}>解除隔离</Button>
                          : <Button size="sm" onClick={() => setTarget(f)} data-testid="qa-flaky-quarantine">隔离</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {quarantined.length > 0 && (
            <section className="mt-6">
              <h2 className="text-sm font-medium text-ink">已隔离（最近未见不稳定）</h2>
              <ul>
                {quarantined.map((x) => (
                  <li key={x.id} className="flex items-center gap-2 border-b border-rule py-2 last:border-0">
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm text-ink-2">{x.name}</span>{x.reason && <span className="block truncate text-xs text-muted">{x.reason}</span>}</span>
                    <Button size="sm" disabled={release.isPending} onClick={() => release.mutate({ id: x.id, version: x.version, name: x.name, caseKey: x.caseKey, reason: x.reason })}>解除隔离</Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {target && <QuarantineDialog wsId={ws.id} row={target} onClose={() => setTarget(null)} />}
    </Scroll>
  );
}
