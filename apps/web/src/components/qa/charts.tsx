import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { cn } from '@/lib/utils';

export interface TrendPoint { value: number; failing?: boolean; title: string; detail: string; onClick?: () => void }

const HEIGHT = 168;
const PAD = { top: 12, right: 44, bottom: 10, left: 38 };

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

// 单序列折线：纵轴固定 0–100，通过率和覆盖率的高低才有可比性；失败的点用红色并在悬浮里说明
export function TrendChart({ points, label, testId }: { points: TrendPoint[]; label: string; testId?: string }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  const y = (v: number) => PAD.top + (1 - v / 100) * plotH;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const last = points.at(-1);
  const active = hover === null ? null : points[hover];

  const move = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = box.width > 0 ? (e.clientX - box.left) / box.width : 0;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
  };

  return (
    <div ref={ref} className="relative" style={{ height: HEIGHT }} data-testid={testId}>
      {width > 0 && points.length > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={`${label}，共 ${points.length} 个数据点，最新 ${last?.value.toFixed(1)}%`} className="block">
          {[0, 50, 100].map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--color-rule)" />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--color-muted)">{t}</text>
            </g>
          ))}
          <path d={path} fill="none" stroke="var(--color-cool)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {points.map((p, i) => p.failing && <circle key={i} cx={x(i)} cy={y(p.value)} r={4} fill="var(--color-bad)" stroke="var(--color-paper)" strokeWidth={2} />)}
          {last && (
            <>
              {!last.failing && <circle cx={x(points.length - 1)} cy={y(last.value)} r={4} fill="var(--color-cool)" stroke="var(--color-paper)" strokeWidth={2} />}
              <text x={x(points.length - 1) + 9} y={y(last.value) + 4} fontSize="12" fontWeight={600} fill="var(--color-ink)">{Math.round(last.value)}%</text>
            </>
          )}
          {active && hover !== null && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="var(--color-rule-2)" />
              <circle cx={x(hover)} cy={y(active.value)} r={5} fill={active.failing ? 'var(--color-bad)' : 'var(--color-cool)'} stroke="var(--color-paper)" strokeWidth={2} />
            </>
          )}
          <rect
            x={PAD.left} y={0} width={plotW} height={HEIGHT} fill="transparent"
            className={active?.onClick ? 'cursor-pointer' : undefined}
            onPointerMove={move} onPointerLeave={() => setHover(null)} onClick={() => active?.onClick?.()}
          />
        </svg>
      )}
      {active && hover !== null && (
        <div
          className="pointer-events-none absolute z-10 w-max max-w-64 rounded-pill bg-paper px-2.5 py-1.5 text-xs shadow-[var(--shadow-pop)]"
          style={{ top: 4, ...(x(hover) > width / 2 ? { right: width - x(hover) + 12 } : { left: x(hover) + 12 }) }}
        >
          <p className="font-medium text-ink">{active.title}</p>
          <p className="text-muted">{active.detail}</p>
        </div>
      )}
    </div>
  );
}

const CELL: Record<string, string> = { passed: 'bg-ok', failed: 'bg-bad', error: 'bg-bad', skipped: 'bg-rule-2' };
const CELL_TEXT: Record<string, string> = { passed: '通过', failed: '失败', error: '错误', skipped: '跳过' };

// 历史条带：从旧到新，一格一次运行
export function StatusStrip({ items, onPick }: { items: { status: string; runId?: string; title?: string }[]; onPick?: (runId: string) => void }) {
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`最近 ${items.length} 次：${items.map((i) => CELL_TEXT[i.status] ?? i.status).join('、')}`}>
      {items.map((it, i) => (
        <button
          key={i} type="button" title={it.title ?? CELL_TEXT[it.status] ?? it.status} disabled={!onPick || !it.runId}
          onClick={(e) => { e.stopPropagation(); if (it.runId) onPick?.(it.runId); }}
          className={cn('h-4 w-2 rounded-[2px] transition-opacity duration-150 hover:opacity-70 disabled:hover:opacity-100', CELL[it.status] ?? 'bg-rule-2')}
        />
      ))}
    </span>
  );
}

// 通过 / 失败 / 跳过的占比条，颜色之外有文字计数并排显示
export function PassBar({ passed, failed, skipped }: { passed: number; failed: number; skipped: number }) {
  const total = passed + failed + skipped;
  if (total === 0) return <span className="block h-1.5 w-24 rounded-full bg-paper-3" />;
  const part = (n: number) => `${(n / total) * 100}%`;
  return (
    <span className="flex h-1.5 w-24 gap-px overflow-hidden rounded-full" aria-hidden>
      {passed > 0 && <i className="bg-ok" style={{ width: part(passed) }} />}
      {failed > 0 && <i className="bg-bad" style={{ width: part(failed) }} />}
      {skipped > 0 && <i className="bg-rule-2" style={{ width: part(skipped) }} />}
    </span>
  );
}

export function CoverageBar({ value, threshold }: { value: number | null; threshold: number }) {
  return (
    <span className="block h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-paper-3" aria-hidden>
      {value !== null && <i className={cn('block h-full rounded-full', value < threshold ? 'bg-bad' : 'bg-cool')} style={{ width: `${Math.max(1, value)}%` }} />}
    </span>
  );
}
