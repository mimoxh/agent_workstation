import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type ButtonVariant = 'default' | 'primary' | 'accent' | 'quiet' | 'danger' | 'danger-solid';
export type ButtonSize = 'default' | 'sm' | 'icon' | 'icon-sm';

const variants: Record<ButtonVariant, string> = {
  default: 'bg-paper border-rule-2 text-ink hover:bg-paper-2 active:bg-paper-3',
  primary: 'bg-primary border-primary text-primary-ink hover:bg-primary-hover hover:border-primary-hover',
  accent: 'bg-accent border-accent text-accent-ink hover:bg-[color-mix(in_oklab,var(--color-accent)_88%,var(--color-ink))]',
  quiet: 'border-transparent text-ink-2 hover:bg-hover hover:text-ink active:bg-press',
  danger: 'bg-paper border-rule-2 text-bad hover:bg-bad-soft hover:border-bad',
  'danger-solid': 'bg-bad border-bad text-bad-ink hover:bg-[color-mix(in_oklab,var(--color-bad)_88%,var(--color-ink))]',
};
const sizes: Record<ButtonSize, string> = {
  default: 'h-9 px-4 text-sm gap-1.5 [&_svg]:size-4',
  sm: 'h-7 px-3 text-xs gap-1 [&_svg]:size-3.5',
  icon: 'size-9 px-0 [&_svg]:size-4',
  'icon-sm': 'size-7 px-0 [&_svg]:size-3.5',
};

export function buttonClass(variant: ButtonVariant = 'default', size: ButtonSize = 'default', className?: string) {
  return cn(
    'relative inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-btn border font-semibold leading-none no-underline transition-[color,background-color,border-color,translate] duration-150 ease-out active:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress',
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
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cn('inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent', className)} />;
}
