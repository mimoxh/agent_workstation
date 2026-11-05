import { cn } from '@/lib/utils';
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'default' | 'outline' | 'ghost';
type Size = 'default' | 'sm';

const variants: Record<Variant, string> = {
  default: 'bg-neutral-900 text-neutral-50 hover:bg-neutral-800',
  outline: 'border border-neutral-200 bg-white hover:bg-neutral-100',
  ghost: 'hover:bg-neutral-100',
};
const sizes: Record<Size, string> = {
  default: 'h-9 px-4 text-sm',
  sm: 'h-7 px-2 text-xs',
};

export function Button({
  variant = 'default',
  size = 'default',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
