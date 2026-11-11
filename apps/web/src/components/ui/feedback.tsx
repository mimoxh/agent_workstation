import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export function Empty({ title, children, className }: { title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex h-full min-h-40 flex-col items-center justify-center gap-2 p-6 text-center', className)}>
      <p className="text-title font-medium text-ink-2">{title}</p>
      {children && <div className="max-w-[46ch] text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Loading({ label = '加载中…', className }: { label?: string; className?: string }) {
  return <div className={cn('animate-pulse-soft p-6 text-sm text-muted', className)}>{label}</div>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Empty title="加载失败">
      <p>{error instanceof Error ? error.message : String(error)}</p>
      {onRetry && <Button className="mt-3" onClick={onRetry}>重试</Button>}
    </Empty>
  );
}

// 轻量弹层：点外面或按 Esc 关闭
export function Popover({ trigger, children, align = 'right', className }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen((v) => !v))}
      {open && (
        <div className={cn('absolute top-[calc(100%+6px)] z-30 animate-pop rounded-card bg-paper p-1.5 shadow-[var(--shadow-pop)]', align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left', className)}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ danger, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      type="button"
      className={cn('block w-full whitespace-nowrap rounded-chip px-2.5 py-1.5 text-left text-sm hover:bg-hover', danger ? 'text-bad' : 'text-ink-2', className)}
      {...props}
    />
  );
}

interface Toast { id: number; text: string; tone: 'bad' | 'ok' }
let toasts: Toast[] = [];
let seq = 0;
const subs = new Set<() => void>();
const publish = (next: Toast[]) => {
  toasts = next;
  for (const s of subs) s();
};

export function toast(text: string, tone: Toast['tone'] = 'bad') {
  const id = ++seq;
  publish([...toasts, { id, text, tone }]);
  setTimeout(() => publish(toasts.filter((t) => t.id !== id)), 6000);
}

export function Toaster() {
  const items = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => toasts,
  );
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} data-testid="toast" className={cn('max-w-[32rem] animate-rise rounded-pill px-3 py-2 text-sm shadow-[var(--shadow-pop)]', t.tone === 'bad' ? 'bg-bad-soft text-bad' : 'bg-ok-soft text-ok')}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
