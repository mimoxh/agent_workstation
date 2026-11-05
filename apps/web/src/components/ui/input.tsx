import { cn } from '@/lib/utils';
import type { InputHTMLAttributes } from 'react';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-9 rounded-md border border-neutral-200 bg-white px-3 text-sm outline-none focus:border-neutral-400',
        className,
      )}
      {...props}
    />
  );
}
