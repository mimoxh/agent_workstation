import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-card bg-paper text-ink-2 shadow-[var(--shadow-card)] transition-[box-shadow,background-color] duration-150', className)} {...props} />;
}
