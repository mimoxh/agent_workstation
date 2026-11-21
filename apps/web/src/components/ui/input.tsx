import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const control =
  'w-full rounded-ctl border border-field-line bg-paper-2 text-sm text-ink outline-none transition-[border-color,background-color,box-shadow] duration-150 placeholder:text-faint hover:border-muted focus-visible:border-focus focus-visible:bg-paper focus-visible:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-focus)_26%,transparent)] focus-visible:outline-none aria-invalid:border-bad aria-invalid:bg-bad-soft disabled:cursor-not-allowed disabled:opacity-55';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, 'h-9 px-3', className)} {...props} />;
}

export function Textarea({ className, ref, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={cn(control, 'block min-h-20 resize-y px-3 py-2 leading-relaxed', className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(control, 'h-9 cursor-pointer appearance-none bg-[image:var(--select-chev)] bg-[length:14px] bg-[position:right_10px_center] bg-no-repeat pl-3 pr-8', className)}
      {...props}
    />
  );
}

export function Field({ label, hint, required, className, children }: { label: string; hint?: string | undefined; required?: boolean | undefined; className?: string | undefined; children: ReactNode }) {
  return (
    <label className={cn('grid min-w-0 content-start gap-1.5', className)}>
      <span className="text-sm font-medium text-ink-2">
        {label}
        {required && <span className="ml-0.5 font-semibold text-accent">*</span>}
      </span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

// 开关：role=switch，开 = 墨色
export function Switch({ checked, onChange, className, ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex h-6 w-[42px] shrink-0 items-center rounded-btn p-[3px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-field-line hover:bg-muted',
        className,
      )}
      {...props}
    >
      <span className={cn('size-[18px] rounded-full bg-paper shadow-[var(--shadow-knob)] transition-transform duration-150', checked && 'translate-x-[18px]')} />
    </button>
  );
}

// 分段选择：选中 = 墨色胶囊
export function Seg<T extends string>({ value, options, onChange, size = 'default', label, className }: { value: T; options: readonly { value: T; label: ReactNode }[]; onChange: (v: T) => void; size?: 'default' | 'sm'; label?: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex max-w-full shrink-0 gap-0.5 overflow-x-auto rounded-btn bg-paper-3 p-[3px] [scrollbar-width:none]', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex items-center gap-1.5 whitespace-nowrap rounded-btn transition-colors duration-150 [&_svg]:size-3.5',
            size === 'sm' ? 'h-[22px] px-2.5 text-xs' : 'h-[30px] px-3.5 text-sm',
            o.value === value ? 'bg-primary font-semibold text-primary-ink' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// 筛选片：按下 = 墨色
export function chipClass(pressed: boolean, className?: string) {
  return cn(
    'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-btn border px-3 text-xs font-medium transition-colors duration-150 [&_svg]:size-3.5',
    pressed ? 'border-primary bg-primary text-primary-ink' : 'border-rule-2 bg-paper text-ink-2 hover:border-muted hover:bg-paper-2',
    className,
  );
}
