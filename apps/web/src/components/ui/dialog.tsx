import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

// 原生 <dialog>：焦点陷阱、Esc、顶层渲染都由浏览器负责
export function Dialog({
  title,
  onClose,
  children,
  className,
  testId,
}: {
  title: ReactNode;
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
      className={cn('m-auto max-h-[85dvh] w-[30rem] max-w-[calc(100vw-2rem)] animate-pop overflow-y-auto rounded-pop border-0 bg-paper p-0 text-ink shadow-[var(--shadow-pop)]', className)}
    >
      <div className="p-5">
        <h2 className="mb-4 text-title font-semibold text-ink">{title}</h2>
        {children}
      </div>
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
    <form onSubmit={submit} className="space-y-3">
      {children}
      {error && <p className="rounded-pill bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="quiet" onClick={onCancel}>取消</Button>
        <Button type="submit" variant="primary" disabled={!canSubmit || submitting}>
          {submitting ? '提交中…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
