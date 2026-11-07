import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'primary' | 'quiet' | 'danger';
type Size = 'default' | 'sm';

const variants: Record<Variant, string> = {
  default: 'bg-paper border-rule-2 text-ink hover:bg-hover active:bg-paper-3',
  primary: 'bg-primary border-primary text-primary-ink hover:bg-primary-hover hover:border-primary-hover',
  quiet: 'border-transparent text-muted hover:bg-hover hover:text-ink',
  danger: 'bg-paper border-rule-2 text-bad hover:bg-bad-soft hover:border-transparent',
};
const sizes: Record<Size, string> = {
  default: 'min-h-7 px-2.5 text-sm',
  sm: 'min-h-6 px-2 text-xs',
};

export function buttonClass(variant: Variant = 'default', size: Size = 'default', className?: string) {
  return cn(
    'inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-pill border font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    sizes[size],
    className,
  );
}

export function Button({
  variant = 'default',
  size = 'default',
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}
