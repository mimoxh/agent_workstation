import type { ReactNode } from 'react';

// 每列等宽，空列也保持宽度，列多时看板横向滚动
export function BoardColumn({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="grid max-h-full min-h-30 w-[17rem] shrink-0 content-start gap-2 self-start overflow-y-auto rounded-card bg-paper-2 p-2" data-testid={`board-column-${title}`} aria-label={title}>
      <header className="flex items-center gap-2 px-1.5 py-1">
        <h3 className="text-sm font-bold text-ink">{title}</h3>
        <span className="text-sm font-medium tabular-nums text-muted">{count}</span>
      </header>
      {count === 0 ? <p className="rounded-xl border border-dashed border-rule-2 px-2 py-4 text-center text-xs text-faint">暂无任务</p> : children}
    </section>
  );
}
