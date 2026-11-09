import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Empty, ErrorState, Loading } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { useQaCoverage, type QaCoverageSuite } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { when } from '@/lib/format';
import { CoverageBar, TrendChart } from './charts';
import { pct } from './model';
import { Scroll, TABLE, TD, TH, Toolbar, type QaProps } from './shared';

const FILE_LIMIT = 300;

function Metric({ label, value }: { label: string; value: number | null }) {
  return <div className="min-w-24 flex-1 px-3 py-2"><span className="block text-xs text-muted">{label}</span><span className="measured text-title font-semibold text-ink">{pct(value)}</span></div>;
}

const Delta = ({ v }: { v: number | null }) => {
  if (v === null || Math.abs(v) < 0.05) return <span className="text-faint">—</span>;
  return <span className={v < 0 ? 'text-bad' : 'text-ok'}>{v > 0 ? '+' : ''}{v.toFixed(1)}</span>;
};

function Suite({ s }: { s: QaCoverageSuite }) {
  const [q, setQ] = useState('');
  const files = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return s.files.filter((f) => !needle || f.path.toLowerCase().includes(needle)).sort((a, b) => (a.lines ?? 101) - (b.lines ?? 101));
  }, [s.files, q]);
  const points = s.trend.filter((t) => t.lines !== null).map((t) => ({ value: t.lines!, title: pct(t.lines), detail: when(t.at) }));
  return (
    <section className="mb-8" data-testid="qa-coverage-suite">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-title font-semibold text-ink">{s.suiteName}</h2>
        <code className="measured text-xs text-muted">{s.commitSha.slice(0, 7)}</code>
        {s.delta !== null && <span className="measured text-sm">相对上次 <Delta v={s.delta} /></span>}
      </div>
      <div className="mt-2 flex flex-wrap divide-x divide-rule border-y border-rule">
        <Metric label="行" value={s.lines} /><Metric label="分支" value={s.branches} /><Metric label="函数" value={s.functions} /><Metric label="语句" value={s.statements} />
      </div>
      {points.length > 1 && <div className="mt-3"><p className="mb-1 text-xs text-muted">行覆盖率趋势</p><TrendChart points={points} label="行覆盖率趋势" /></div>}
      {s.changedLow.length > 0 && (
        <div className="mt-4 rounded-pill bg-accent-soft p-3" data-testid="qa-coverage-low">
          <p className="text-sm font-medium text-accent">本次改动的文件里，{s.changedLow.length} 个覆盖率低于 {s.threshold}%</p>
          <ul className="mt-1 space-y-0.5">{s.changedLow.slice(0, 10).map((f) => <li key={f.path} className="measured flex justify-between gap-3 text-xs text-ink-2"><span className="truncate">{f.path}</span><span>{pct(f.lines)}</span></li>)}</ul>
        </div>
      )}
      <Toolbar className="mt-4">
        <h3 className="text-sm font-medium text-ink">文件 <span className="text-xs font-normal text-faint">{s.files.length}，从低到高</span></h3>
        <Input className="ml-auto w-56" placeholder="搜索路径" aria-label="搜索文件" value={q} onChange={(e) => setQ(e.target.value)} />
      </Toolbar>
      <div className="max-h-[28rem] overflow-auto">
        <table className={TABLE}>
          <thead className="sticky top-0 bg-paper"><tr className="border-b border-rule"><th className={TH}>文件</th><th className={TH}>行</th><th className={cn(TH, 'text-right')}>行%</th><th className={cn(TH, 'text-right')}>变化</th><th className={cn(TH, 'text-right')}>分支%</th><th className={cn(TH, 'text-right')}>函数%</th></tr></thead>
          <tbody>
            {files.slice(0, FILE_LIMIT).map((f) => (
              <tr key={f.path} className="border-b border-rule">
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
      {files.length > FILE_LIMIT && <p className="mt-2 text-xs text-muted"><Badge>提示</Badge> 只显示覆盖率最低的 {FILE_LIMIT} 个，用搜索查看其余文件。</p>}
    </section>
  );
}

export function Coverage({ ws, go }: QaProps) {
  const q = useQaCoverage(ws.id);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.data.suites.length === 0) {
    return (
      <Empty title="还没有覆盖率数据">
        给套件加上覆盖率报告路径（coverage-summary.json 或 lcov.info）。<button type="button" className="ml-1 text-cool hover:underline" onClick={() => go('runs', 'suites')}>去配置</button>
      </Empty>
    );
  }
  return <Scroll testId="qa-coverage">{q.data.suites.map((s) => <Suite key={s.suiteId} s={s} />)}</Scroll>;
}
