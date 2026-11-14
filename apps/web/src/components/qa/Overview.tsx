import { useMutation } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import { useQaOverview, type QaOverview } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { TrendChart } from './charts';
import { RUN_LABEL, RUN_TONE, VERDICT_LABEL, isActive, pct } from './model';
import { Scroll, type QaProps } from './shared';

const VERDICT_STYLE: Record<string, { band: string; text: string; icon: 'check' | 'flag' | 'bell' | 'info' }> = {
  ready: { band: 'bg-ok-soft', text: 'text-ok', icon: 'check' },
  risk: { band: 'bg-accent-soft', text: 'text-accent', icon: 'flag' },
  blocked: { band: 'bg-bad-soft', text: 'text-bad', icon: 'bell' },
  unknown: { band: 'bg-paper-2', text: 'text-muted', icon: 'info' },
};

function Stat({ label, value, note, tone, onClick }: { label: string; value: string; note?: string | undefined; tone?: 'bad' | 'accent' | undefined; onClick?: (() => void) | undefined }) {
  const body = (
    <>
      <span className="block text-xs text-muted">{label}</span>
      <span className={cn('measured mt-0.5 block text-display font-semibold', tone === 'bad' ? 'text-bad' : tone === 'accent' ? 'text-accent' : 'text-ink')}>{value}</span>
      {note && <span className="block text-xs text-muted">{note}</span>}
    </>
  );
  const cls = 'min-w-32 flex-1 px-4 py-3 text-left';
  return onClick ? <button type="button" onClick={onClick} className={cn(cls, 'transition-colors duration-150 hover:bg-hover')}>{body}</button> : <div className={cls}>{body}</div>;
}

function Attention({ items, go }: { items: QaOverview['attention']; go: QaProps['go'] }) {
  if (items.length === 0) return <p className="py-3 text-sm text-muted">没有待处理的事。</p>;
  const open = (i: QaOverview['attention'][number]) => {
    if (i.kind === 'run') go('runs', i.id);
    else if (i.kind === 'bug') go('bugs', i.id);
    else if (i.kind === 'plan') go('plans', i.id);
    else go(i.kind);
  };
  return (
    <ul>
      {items.map((i, n) => (
        <li key={n} className="border-b border-rule last:border-0">
          <button type="button" onClick={() => open(i)} className="flex w-full items-center gap-2.5 py-2 text-left text-sm text-ink-2 transition-colors duration-150 hover:text-ink" data-testid="qa-attention">
            <i aria-hidden className={cn('size-1.5 shrink-0 rounded-full', i.tone === 'bad' ? 'bg-bad' : 'bg-accent')} />
            <span className="min-w-0 flex-1 truncate">{i.text}</span>
            <Icon name="chev" className="size-3.5 -rotate-90 text-faint" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function SuiteRow({ s, wsId, go }: { s: QaOverview['suites'][number]; wsId: string; go: QaProps['go'] }) {
  const start = useMutation({ mutationFn: async () => unwrap(await api.workstations[':id'].qa.runs.$post({ param: { id: wsId }, json: { suiteId: s.id } })) });
  const busy = s.last ? isActive(s.last.status) : false;
  return (
    <li className="flex items-center gap-2 border-b border-rule py-2 last:border-0">
      <button type="button" disabled={!s.last} onClick={() => s.last && go('runs', s.last.id)} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm text-ink">{s.name}</span>
        <span className="measured block truncate text-xs text-muted">{s.last ? `${s.last.ref} @ ${s.last.commitSha.slice(0, 7)} · ${when(s.last.finishedAt ?? s.last.createdAt)}` : '还没运行过'}</span>
      </button>
      {s.last && <Badge tone={RUN_TONE[s.last.status] ?? 'neutral'}>{RUN_LABEL[s.last.status] ?? s.last.status}</Badge>}
      <Button size="sm" disabled={busy || start.isPending} onClick={() => start.mutate()} data-testid="qa-suite-run">运行</Button>
    </li>
  );
}

export function Overview({ ws, go }: QaProps) {
  const q = useQaOverview(ws.id);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const o = q.data;
  if (!o.source.ok) return <Empty title="还不能运行测试">{o.source.error}</Empty>;
  const v = VERDICT_STYLE[o.verdict.level] ?? VERDICT_STYLE.unknown!;
  const points = o.trend.map((t) => ({
    value: t.rate * 100, failing: t.status === 'failed',
    title: `${(t.rate * 100).toFixed(1)}% · ${RUN_LABEL[t.status] ?? t.status}`,
    detail: `${t.suite} · ${t.commit.slice(0, 7)} · ${when(t.at)}`,
    onClick: () => go('runs', t.id),
  }));

  return (
    <Scroll testId="qa-overview">
      {o.suites.length === 0 ? (
        <div className="mx-auto mt-12 max-w-md" data-testid="qa-empty">
          <p className="text-title font-medium text-ink-2">先配置一个测试套件</p>
          <p className="mt-1 text-sm text-muted">套件是一条会生成 JUnit 报告的命令。配好后平台在本台仓库的目标分支 <code className="measured">{o.source.targetBranch}</code> 上执行，逐用例记录结果；也能在开发任务的验收里引用。</p>
          <Button variant="primary" className="mt-3" onClick={() => go('runs', 'suites')} data-testid="qa-go-suites">配置套件</Button>
        </div>
      ) : (
        <>
          <section className={cn('rounded-card p-4', v.band)} data-testid="qa-verdict" data-level={o.verdict.level}>
            <p className={cn('flex items-center gap-2 text-h2 font-bold tracking-tight', v.text)}><Icon name={v.icon} className="size-5" />{VERDICT_LABEL[o.verdict.level]}</p>
            <p className="mt-0.5 text-xs text-muted">依据各套件的最新结果（优先目标分支 <code className="measured">{o.source.targetBranch}</code>），发布由人在测试计划里签字</p>
            {o.verdict.reasons.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-sm text-ink-2">
                {o.verdict.reasons.map((r) => <li key={r.text} className="flex gap-2"><span className={r.level === 'block' ? 'text-bad' : 'text-accent'}>{r.level === 'block' ? '阻断' : '风险'}</span>{r.text}</li>)}
              </ul>
            )}
          </section>

          <section className="mt-3 flex flex-wrap divide-x divide-rule border-y border-rule" aria-label="关键指标">
            <Stat label="通过率" value={o.verdict.passRate === null ? '—' : pct(o.verdict.passRate * 100)} onClick={() => go('runs')} />
            <Stat label="未关闭缺陷" value={String(o.openBugs.total)} note={o.openBugs.blocking ? `${o.openBugs.blocking} 个 P0/P1` : undefined} tone={o.openBugs.blocking ? 'bad' : undefined} onClick={() => go('bugs')} />
            <Stat label="不稳定用例" value={String(o.flaky)} tone={o.flaky ? 'accent' : undefined} onClick={() => go('flaky')} />
            <Stat label="行覆盖率" value={pct(o.coverage)} note={o.coverage === null ? '套件未配置覆盖率报告' : '各套件最低值'} onClick={() => go('coverage')} />
          </section>

          {o.running.length > 0 && (
            <p className="mt-3 animate-pulse-soft text-sm text-cool" data-testid="qa-running">正在运行：{o.running.map((r) => r.suiteName).join('、')}</p>
          )}

          <section className="mt-5">
            <h2 className="text-sm font-medium text-ink">通过率趋势</h2>
            <p className="mb-1 text-xs text-muted">最近 {points.length} 次完成的运行，红点是有失败的运行，点击查看</p>
            {points.length ? <TrendChart points={points} label="通过率趋势" testId="qa-trend" /> : <p className="py-6 text-sm text-muted">跑完第一次就有趋势了。</p>}
          </section>

          <div className="mt-5 grid gap-x-8 gap-y-5 lg:grid-cols-2">
            <section>
              <h2 className="text-sm font-medium text-ink">现在要处理的事</h2>
              <Attention items={o.attention} go={go} />
            </section>
            <section>
              <h2 className="text-sm font-medium text-ink">套件</h2>
              <ul>{o.suites.map((s) => <SuiteRow key={s.id} s={s} wsId={ws.id} go={go} />)}</ul>
            </section>
          </div>
        </>
      )}
    </Scroll>
  );
}
