import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { RUN_LABEL } from '@/components/board/labels';
import { Page, PageHeader } from '@/components/layout/Page';
import { RunTable } from '@/components/run/RunTable';
import { Card } from '@/components/ui/card';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon, type IconName } from '@/components/ui/icons';
import { Select } from '@/components/ui/input';
import { money, seconds, tokens } from '@/lib/format';
import { useLedger, useProjectRuns, type LedgerRow } from '@/lib/queries';

export const Route = createFileRoute('/projects/$projectId/runs/')({
  component: LedgerPage,
});

function Reading({ label, value, icon }: { label: string; value: string; icon: IconName }) {
  return (
    <div className="grid content-start gap-1 rounded-card bg-paper-2 p-4" data-testid={`ledger-${label}`}>
      <dt className="flex items-center gap-1.5 text-xs font-medium text-muted"><Icon name={icon} className="size-3.5" />{label}</dt>
      <dd className="measured break-words text-display font-bold leading-tight text-ink">{value}</dd>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: LedgerRow[] }) {
  return (
    <Card className="min-w-0 overflow-hidden p-0">
      <section aria-label={title}>
        <h2 className="border-b border-rule px-4 py-3 text-sm font-bold text-ink">{title}</h2>
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">暂无</p>
        ) : (
          <ul>
            {rows.slice(0, 6).map((r) => (
              <li key={r.key} className="flex items-baseline gap-2 border-b border-rule px-4 py-2.5 text-sm last:border-b-0">
                <span className="min-w-0 flex-1 truncate text-ink-2">{r.label}</span>
                <span className="measured shrink-0 text-xs text-muted">{tokens(r.tokens)}</span>
                <span className="measured w-14 shrink-0 text-right text-xs text-ink-2">{money(r.costMicros)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Card>
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
    <div className="h-full min-h-0 overflow-y-auto" data-testid="runs-page">
      <Page wide>
        <PageHeader icon="ledger" title="运行账本" desc="任务派发后，Agent 的每次运行都记在这里，可以回放。" />
        {l && (
          <>
            <dl className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
              <Reading icon="coin" label="总 tokens" value={tokens(l.total.tokens)} />
              <Reading icon="coin" label="预估成本" value={money(l.total.costMicros)} />
              <Reading icon="play" label="运行次数" value={String(l.total.runs)} />
              <Reading icon="clock" label="运行耗时" value={seconds(l.total.ms / 1000)} />
              {l.budget?.tokens && <Reading icon="flag" label="项目预算" value={`${tokens(l.total.tokens)} / ${tokens(l.budget.tokens)}`} />}
            </dl>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <Breakdown title="按工作台" rows={l.byWorkstation} />
              <Breakdown title="按成员" rows={l.byAgent} />
              <Breakdown title="按任务" rows={l.byTask} />
            </div>
          </>
        )}
        <div className="mb-3.5 mt-8 flex flex-wrap items-center gap-3">
          <h2 className="text-title font-bold text-ink">运行记录 <span className="font-medium tabular-nums text-muted">{shown.length}</span></h2>
          <span className="flex-1" />
          <Select className="h-8 w-32" aria-label="按状态筛选" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            {Object.entries(RUN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </div>
        {runs.isLoading && <Loading />}
        {runs.isError && <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />}
        {runs.data && shown.length === 0 && (
          <Card>
            <Empty title="没有运行记录" icon="ledger">任务派发后，Agent 的每次运行都会记录在这里，可回放。</Empty>
          </Card>
        )}
        {shown.length > 0 && <RunTable runs={shown} projectId={projectId} showTask />}
      </Page>
    </div>
  );
}
