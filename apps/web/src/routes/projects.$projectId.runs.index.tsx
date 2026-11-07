import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { RUN_LABEL } from '@/components/board/labels';
import { RunTable } from '@/components/run/RunTable';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Select } from '@/components/ui/input';
import { money, seconds, tokens } from '@/lib/format';
import { useLedger, useProjectRuns, type LedgerRow } from '@/lib/queries';

export const Route = createFileRoute('/projects/$projectId/runs/')({
  component: LedgerPage,
});

function Reading({ label, value }: { label: string; value: string }) {
  return (
    <div data-testid={`ledger-${label}`}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="measured mt-0.5 text-title text-ink">{value}</dd>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: LedgerRow[] }) {
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className="mb-1 text-sm text-muted">{title}</h2>
      <ul className="space-y-0.5">
        {rows.slice(0, 6).map((r) => (
          <li key={r.key} className="flex items-baseline gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-ink-2">{r.label}</span>
            <span className="measured shrink-0 text-xs text-muted">{tokens(r.tokens)}</span>
            <span className="measured w-14 shrink-0 text-right text-xs text-muted">{money(r.costMicros)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LedgerPage() {
  const { projectId } = Route.useParams();
  const runs = useProjectRuns(projectId);
  const ledger = useLedger(projectId);
  const [status, setStatus] = useState('');
  const shown = (runs.data ?? []).filter((r) => !status || r.status === status);
  const l = ledger.data;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="runs-page">
      <header className="space-y-4 border-b border-rule px-5 pb-4 pt-6 md:px-8">
        <h1 className="text-[1.75rem] font-bold leading-tight text-ink">运行账本</h1>
        {l && (
          <>
            <dl className="flex flex-wrap gap-8">
              <Reading label="总 tokens" value={tokens(l.total.tokens)} />
              <Reading label="预估成本" value={money(l.total.costMicros)} />
              <Reading label="运行次数" value={String(l.total.runs)} />
              <Reading label="运行耗时" value={seconds(l.total.ms / 1000)} />
              {l.budget?.tokens && <Reading label="项目预算" value={`${tokens(l.total.tokens)} / ${tokens(l.budget.tokens)}`} />}
            </dl>
            <div className="grid gap-5 md:grid-cols-3">
              <Breakdown title="按工作台" rows={l.byWorkstation} />
              <Breakdown title="按成员" rows={l.byAgent} />
              <Breakdown title="按任务" rows={l.byTask} />
            </div>
          </>
        )}
      </header>
      <div className="flex items-center gap-3 border-b border-rule px-5 py-2 md:px-8">
        <p className="text-sm text-muted">运行记录 <span className="measured">{shown.length}</span></p>
        <span className="flex-1" />
        <Select className="h-8 w-32" aria-label="按状态筛选" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          {Object.entries(RUN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {runs.isLoading && <Loading />}
        {runs.isError && <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />}
        {runs.data && shown.length === 0 && <Empty title="没有运行记录">任务派发后，Agent 的每次运行都会记录在这里，可回放。</Empty>}
        {shown.length > 0 && <RunTable runs={shown} projectId={projectId} showTask />}
      </div>
    </div>
  );
}
