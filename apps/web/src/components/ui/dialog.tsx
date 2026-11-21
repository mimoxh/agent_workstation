import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button, Spinner } from './button';
import { Icon } from './icons';

// 原生 <dialog>：焦点陷阱、Esc、顶层渲染都由浏览器负责
export function Dialog({
  title,
  description,
  onClose,
  children,
  className,
  testId,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      data-testid={testId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn('m-auto max-h-[88dvh] w-[32.5rem] max-w-[calc(100vw-2rem)] animate-pop overflow-y-auto rounded-pop border-0 bg-paper p-0 text-ink shadow-[var(--shadow-pop)]', className)}
    >
      <div className="grid gap-1 px-[22px] pr-14 pt-[22px]">
        <h2 className="text-title font-semibold text-ink">{title}</h2>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      <div className="px-[22px] pb-[22px] pt-[18px]">{children}</div>
      {/* 放在内容之后：showModal 的默认焦点仍落在第一个字段上 */}
      <Button variant="quiet" size="icon-sm" aria-label="关闭对话框" className="absolute right-4 top-[18px]" onClick={onClose}>
        <Icon name="x" />
      </Button>
    </dialog>
  );
}

export function DialogForm({
  error,
  submitting,
  submitLabel,
  canSubmit = true,
  onSubmit,
  onCancel,
  children,
}: {
  error?: string | null | undefined;
  submitting?: boolean | undefined;
  submitLabel: string;
  canSubmit?: boolean | undefined;
  onSubmit: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSubmit && !submitting) onSubmit();
  };
  return (
    <form onSubmit={submit} className="grid gap-3.5">
      {children}
      {error && <p role="alert" className="rounded-ctl bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <Button variant="quiet" onClick={onCancel}>取消</Button>
        <Button type="submit" variant="primary" disabled={!canSubmit || submitting} aria-busy={submitting || undefined}>
          {submitting && <Spinner />}
          {submitting ? '提交中…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
