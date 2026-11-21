import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { useQaCoverage, type QaCoverageSuite } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { when } from '@/lib/format';
import { CoverageBar, TrendChart } from './charts';
import { pct } from './model';
import { HOVER_ROW, Scroll, STATS, Stat, TABLE, TD, TH, Toolbar, type QaProps } from './shared';

const FILE_LIMIT = 300;

const Delta = ({ v }: { v: number | null }) => {
  if (v === null || Math.abs(v) < 0.05) return <span className="text-muted">—</span>;
  return <span className={cn('tabular-nums', v < 0 ? 'text-bad' : 'text-ok')}>{v > 0 ? '+' : ''}{v.toFixed(1)}</span>;
};

function Suite({ s }: { s: QaCoverageSuite }) {
  const [q, setQ] = useState('');
  const files = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return s.files.filter((f) => !needle || f.path.toLowerCase().includes(needle)).sort((a, b) => (a.lines ?? 101) - (b.lines ?? 101));
  }, [s.files, q]);
  const points = s.trend.filter((t) => t.lines !== null).map((t) => ({ value: t.lines!, title: pct(t.lines), detail: when(t.at) }));
  return (
    <section className="mb-10" data-testid="qa-coverage-suite">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-title font-bold text-ink">{s.suiteName}</h2>
        <code className="measured rounded-chip bg-paper-3 px-1.5 text-xs text-ink-2">{s.commitSha.slice(0, 7)}</code>
        {s.delta !== null && <span className="text-sm text-muted">相对上次 <Delta v={s.delta} /></span>}
      </div>
      <div className={STATS}>
        <Stat label="行" value={pct(s.lines)} /><Stat label="分支" value={pct(s.branches)} /><Stat label="函数" value={pct(s.functions)} /><Stat label="语句" value={pct(s.statements)} />
      </div>
      {points.length > 1 && (
        <Card className="mt-4 p-4">
          <p className="mb-2 text-sm font-bold text-ink">行覆盖率趋势</p>
          <TrendChart points={points} label="行覆盖率趋势" />
        </Card>
      )}
      {s.changedLow.length > 0 && (
        <div className="mt-4 grid grid-cols-[1rem_minmax(0,1fr)] gap-2.5 rounded-ctl bg-accent-soft px-3.5 py-3" data-testid="qa-coverage-low">
          <Icon name="alert" className="mt-0.5 text-accent" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">本次改动的文件里，{s.changedLow.length} 个覆盖率低于 {s.threshold}%</p>
            <ul className="mt-1.5 grid gap-0.5">{s.changedLow.slice(0, 10).map((f) => <li key={f.path} className="measured flex justify-between gap-3 text-xs text-ink-2"><span className="truncate">{f.path}</span><span>{pct(f.lines)}</span></li>)}</ul>
          </div>
        </div>
      )}
      <Toolbar className="mb-3 mt-6">
        <h3 className="text-sm font-bold text-ink">文件 <span className="text-xs font-medium text-muted">{s.files.length}，从低到高</span></h3>
        <Input className="ml-auto w-56" placeholder="搜索路径" aria-label="搜索文件" value={q} onChange={(e) => setQ(e.target.value)} />
      </Toolbar>
      <div className="max-h-[28rem] overflow-auto rounded-card bg-paper shadow-[var(--shadow-card)]">
        <table className={TABLE}>
          <thead className="sticky top-0 z-[1]"><tr><th className={TH}>文件</th><th className={TH}>行</th><th className={cn(TH, 'text-right')}>行%</th><th className={cn(TH, 'text-right')}>变化</th><th className={cn(TH, 'text-right')}>分支%</th><th className={cn(TH, 'text-right')}>函数%</th></tr></thead>
          <tbody>
            {files.slice(0, FILE_LIMIT).map((f) => (
              <tr key={f.path} className={HOVER_ROW}>
                <td className={cn(TD, 'max-w-96 truncate')}><code className="measured text-xs">{f.path}</code></td>
                <td className={cn(TD, 'w-44')}><CoverageBar value={f.lines} threshold={s.threshold} /></td>
                <td className={cn(TD, 'measured text-right text-xs')}>{pct(f.lines)}</td>
                <td className={cn(TD, 'measured text-right text-xs')}><Delta v={f.lines !== null && f.prev !== null ? f.lines - f.prev : null} /></td>
                <td className={cn(TD, 'measured text-right text-xs')}>{pct(f.branches)}</td>
                <td className={cn(TD, 'measured text-right text-xs')}>{pct(f.functions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {files.length > FILE_LIMIT && <p className="mt-2 flex items-center gap-2 text-xs text-muted"><Badge>提示</Badge> 只显示覆盖率最低的 {FILE_LIMIT} 个，用搜索查看其余文件。</p>}
    </section>
  );
}

export function Coverage({ ws, go }: QaProps) {
  const q = useQaCoverage(ws.id);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.data.suites.length === 0) {
    return (
      <Empty title="还没有覆盖率数据" icon="shield">
        给套件加上覆盖率报告路径（coverage-summary.json 或 lcov.info）。<button type="button" className="ml-1 font-medium text-cool underline-offset-2 hover:underline" onClick={() => go('runs', 'suites')}>去配置</button>
      </Empty>
    );
  }
  return <Scroll testId="qa-coverage">{q.data.suites.map((s) => <Suite key={s.suiteId} s={s} />)}</Scroll>;
}
