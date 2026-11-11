import type { ReactNode } from 'react';

// 每列等宽，空列也保持宽度，列多时看板横向滚动
export function BoardColumn({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto" data-testid={`board-column-${title}`} aria-label={title}>
      <header className="flex h-7 items-center gap-2 px-0.5">
        <h3 className="rounded-chip bg-tag px-1.5 text-sm text-tag-ink">{title}</h3>
        <span className="measured text-xs text-muted">{count}</span>
      </header>
      {count === 0 ? <p className="rounded-pill border border-dashed border-rule-2 px-3 py-4 text-center text-xs text-faint">暂无任务</p> : children}
    </section>
  );
}
