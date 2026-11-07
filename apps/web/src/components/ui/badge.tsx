import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const tones = {
  neutral: 'text-tag-ink bg-tag',
  amber: 'text-accent-tag-ink bg-accent-tag',
  cool: 'text-cool-tag-ink bg-cool-tag',
  ok: 'text-ok-tag-ink bg-ok-tag',
  bad: 'text-bad-tag-ink bg-bad-tag',
} as const;

export type BadgeTone = keyof typeof tones;

export function Badge({ tone = 'neutral', className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn('inline-flex min-h-5 shrink-0 items-center whitespace-nowrap rounded-[3px] px-1.5 text-xs', tones[tone], className)}
      {...props}
    />
  );
}
