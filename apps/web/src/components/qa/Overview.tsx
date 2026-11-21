import { useMutation } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { api, unwrap } from '@/lib/api';
import { when } from '@/lib/format';
import { useQaOverview, type QaOverview } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { TrendChart } from './charts';
import { RUN_LABEL, RUN_TONE, VERDICT_LABEL, isActive, pct } from './model';
import { IconBlock, LIST_ROW, Scroll, SectionHead, STATS, Stat, type QaProps, type Tone } from './shared';

const VERDICT_STYLE: Record<string, { head: string; icon: 'check' | 'flag' | 'bell' | 'info' }> = {
  ready: { head: 'bg-ok text-ok-ink', icon: 'check' },
  risk: { head: 'bg-accent text-accent-ink', icon: 'flag' },
  blocked: { head: 'bg-bad text-bad-ink', icon: 'bell' },
  unknown: { head: 'bg-paper-3 text-ink-2', icon: 'info' },
};

const RUN_BLOCK: Record<string, Tone> = { ok: 'ok', bad: 'bad', cool: 'cool', amber: 'accent' };

function Attention({ items, go }: { items: QaOverview['attention']; go: QaProps['go'] }) {
  if (items.length === 0) return <p className="px-4 py-3.5 text-sm text-muted">没有待处理的事。</p>;
  const open = (i: QaOverview['attention'][number]) => {
    if (i.kind === 'run') go('runs', i.id);
    else if (i.kind === 'bug') go('bugs', i.id);
    else if (i.kind === 'plan') go('plans', i.id);
    else go(i.kind);
  };
  return (
    <ul>
      {items.map((i, n) => (
        <li key={n} className="border-b border-rule last:border-b-0">
          <button type="button" onClick={() => open(i)} className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left text-sm text-ink transition-colors duration-150 hover:bg-hover focus-visible:-outline-offset-2" data-testid="qa-attention">
            <IconBlock icon={i.tone === 'bad' ? 'alert' : 'hand'} tone={i.tone === 'bad' ? 'bad' : 'accent'} small />
            <span className="min-w-0 truncate">{i.text}</span>
            <Icon name="chev" className="size-3.5 -rotate-90 text-muted" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function SuiteRow({ s, wsId, go }: { s: QaOverview['suites'][number]; wsId: string; go: QaProps['go'] }) {
  const start = useMutation({ mutationFn: async () => unwrap(await api.workstations[':id'].qa.runs.$post({ param: { id: wsId }, json: { suiteId: s.id } })) });
  const busy = s.last ? isActive(s.last.status) : false;
  const tone = s.last ? RUN_TONE[s.last.status] : undefined;
  return (
    <li className={LIST_ROW}>
      <IconBlock icon="flask" tone={tone ? RUN_BLOCK[tone] : undefined} />
      <button type="button" disabled={!s.last} onClick={() => s.last && go('runs', s.last.id)} className="grid min-w-0 gap-0.5 text-left">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-ink">{s.name}</span>
          {s.last && <Badge tone={tone ?? 'neutral'} className={busy ? 'animate-pulse-soft' : undefined}>{RUN_LABEL[s.last.status] ?? s.last.status}</Badge>}
        </span>
        <span className="measured block truncate text-xs text-muted">{s.last ? `${s.last.ref} @ ${s.last.commitSha.slice(0, 7)} · ${when(s.last.finishedAt ?? s.last.createdAt)}` : '还没运行过'}</span>
      </button>
      <Button size="sm" disabled={busy || start.isPending} aria-busy={start.isPending || undefined} onClick={() => start.mutate()} data-testid="qa-suite-run"><Icon name="play" />运行</Button>
    </li>
  );
}

export function Overview({ ws, go }: QaProps) {
  const q = useQaOverview(ws.id);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const o = q.data;
  if (!o.source.ok) return <Empty title="还不能运行测试" icon="alert">{o.source.error}</Empty>;
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
        <div className="mx-auto mt-12 grid max-w-md justify-items-start gap-2" data-testid="qa-empty">
          <IconBlock icon="flask" />
          <p className="mt-1 text-title font-semibold text-ink">先配置一个测试套件</p>
          <p className="text-sm text-muted">套件是一条会生成 JUnit 报告的命令。配好后平台在本台仓库的目标分支 <code className="measured rounded-chip bg-paper-3 px-1.5 text-xs text-ink-2">{o.source.targetBranch}</code> 上执行，逐用例记录结果；也能在开发任务的验收里引用。</p>
          <Button variant="primary" className="mt-2" onClick={() => go('runs', 'suites')} data-testid="qa-go-suites">配置套件</Button>
        </div>
      ) : (
        <>
          <section className="overflow-hidden rounded-card bg-paper shadow-[var(--shadow-card)]" data-testid="qa-verdict" data-level={o.verdict.level}>
            <p className={cn('flex items-center gap-2 px-4 py-2 text-xs font-bold', v.head)}><Icon name={v.icon} className="size-3.5" />{VERDICT_LABEL[o.verdict.level]}</p>
            <div className="grid gap-2.5 px-4 pb-4 pt-3">
              <p className="text-sm text-ink-2">依据各套件的最新结果（优先目标分支 <code className="measured rounded-chip bg-paper-3 px-1.5 text-xs">{o.source.targetBranch}</code>），发布由人在测试计划里签字</p>
              {o.verdict.reasons.length > 0 && (
                <ul className="grid gap-1 text-sm text-ink-2">
                  {o.verdict.reasons.map((r) => <li key={r.text} className="flex gap-2"><b className={cn('shrink-0 font-semibold', r.level === 'block' ? 'text-bad' : 'text-accent')}>{r.level === 'block' ? '阻断' : '风险'}</b>{r.text}</li>)}
                </ul>
              )}
            </div>
          </section>

          <section className={cn(STATS, 'mt-4')} aria-label="关键指标">
            <Stat icon="pulse" label="通过率" value={o.verdict.passRate === null ? '—' : pct(o.verdict.passRate * 100)} onClick={() => go('runs')} />
            <Stat icon="bug" label="未关闭缺陷" value={String(o.openBugs.total)} note={o.openBugs.blocking ? `${o.openBugs.blocking} 个 P0/P1` : undefined} tone={o.openBugs.blocking ? 'bad' : undefined} onClick={() => go('bugs')} />
            <Stat icon="wave" label="不稳定用例" value={String(o.flaky)} tone={o.flaky ? 'accent' : undefined} onClick={() => go('flaky')} />
            <Stat icon="shield" label="行覆盖率" value={pct(o.coverage)} note={o.coverage === null ? '套件未配置覆盖率报告' : '各套件最低值'} onClick={() => go('coverage')} />
          </section>

          {o.running.length > 0 && (
            <p className="mt-4 flex items-center gap-2.5 rounded-ctl bg-cool-soft px-3.5 py-2.5 text-sm text-ink-2" data-testid="qa-running">
              <i aria-hidden className="size-[7px] shrink-0 animate-pulse-soft rounded-full bg-cool" />正在运行：{o.running.map((r) => r.suiteName).join('、')}
            </p>
          )}

          <section className="mt-8">
            <SectionHead title="通过率趋势"><span className="ml-auto text-xs text-muted">最近 {points.length} 次完成的运行，红点是有失败的运行，点击查看</span></SectionHead>
            <Card className="p-4">
              {points.length ? <TrendChart points={points} label="通过率趋势" testId="qa-trend" /> : <p className="py-6 text-center text-sm text-muted">跑完第一次就有趋势了。</p>}
            </Card>
          </section>

          <div className="mt-8 grid gap-x-6 gap-y-8 lg:grid-cols-2">
            <section>
              <SectionHead title="现在要处理的事" />
              <Card className="overflow-hidden"><Attention items={o.attention} go={go} /></Card>
            </section>
            <section>
              <SectionHead title="套件" />
              <Card className="overflow-hidden"><ul>{o.suites.map((s) => <SuiteRow key={s.id} s={s} wsId={ws.id} go={go} />)}</ul></Card>
            </section>
          </div>
        </>
      )}
    </Scroll>
  );
}
