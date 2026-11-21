import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Icon, type IconName } from './icons';

export function Empty({ title, icon, children, className }: { title: string; icon?: IconName; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex h-full min-h-40 flex-col items-center justify-center gap-2.5 px-4 py-10 text-center', className)}>
      {icon && <Icon name={icon} className="size-6 text-muted" />}
      <p className="text-title font-semibold text-ink">{title}</p>
      {children && <div className="max-w-[44ch] text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Loading({ label = '加载中…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn('grid gap-4 p-6', className)}>
      <span className="sr-only">{label}</span>
      <span aria-hidden className="block h-3 w-2/5 animate-pulse-soft rounded-md bg-paper-3" />
      <span aria-hidden className="block h-3 w-4/5 animate-pulse-soft rounded-md bg-paper-3" />
      <span aria-hidden className="block h-3 w-3/5 animate-pulse-soft rounded-md bg-paper-3" />
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Empty title="加载失败" icon="alert">
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
        <div className={cn('absolute top-[calc(100%+6px)] z-30 min-w-[13.75rem] animate-pop rounded-pop bg-paper p-1.5 text-sm text-ink shadow-[var(--shadow-pop)]', align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left', className)}>
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
      className={cn('flex min-h-[34px] w-full items-center gap-2.5 whitespace-nowrap rounded-ctl px-2.5 text-left text-sm hover:bg-hover focus-visible:-outline-offset-2 [&_svg]:size-[15px]', danger ? 'text-bad' : 'text-ink-2 hover:text-ink [&_svg]:text-muted', className)}
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
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} data-testid="toast" className={cn('flex min-h-[42px] max-w-[min(460px,calc(100vw-32px))] animate-rise items-center gap-2.5 rounded-btn px-4 py-2 text-sm shadow-[var(--shadow-pop)]', t.tone === 'bad' ? 'bg-bad text-bad-ink' : 'bg-primary text-primary-ink')}>
          <Icon name={t.tone === 'bad' ? 'alert' : 'check'} className="size-4" />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
