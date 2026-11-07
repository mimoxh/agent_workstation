import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const control =
  'w-full rounded-pill border border-rule-2 bg-paper text-sm text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-faint hover:border-muted focus-visible:border-cool focus-visible:shadow-[0_0_0_3px_var(--color-focus)] focus-visible:outline-none disabled:opacity-55';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, 'h-8 px-2.5', className)} {...props} />;
}

export function Textarea({ className, ref, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={cn(control, 'block min-h-16 resize-y px-3 py-2', className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(control, 'h-8 px-2', className)} {...props} />;
}

export function Field({ label, hint, required, className, children }: { label: string; hint?: string | undefined; required?: boolean | undefined; className?: string | undefined; children: ReactNode }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-xs text-muted">
        {label}
        {required && <span className="ml-0.5 text-accent">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}
