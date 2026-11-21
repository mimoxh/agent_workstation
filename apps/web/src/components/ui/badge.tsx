import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const tones = {
  neutral: 'text-tag-ink bg-tag',
  amber: 'text-accent-tag-ink bg-accent-tag',
  cool: 'text-cool-tag-ink bg-cool-tag',
  ok: 'text-ok-tag-ink bg-ok-tag',
  bad: 'text-bad-tag-ink bg-bad-tag',
  line: 'text-ink-2 bg-transparent shadow-[inset_0_0_0_1px_var(--color-rule-2)]',
} as const;

export type BadgeTone = keyof typeof tones;

export function Badge({ tone = 'neutral', className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn('inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-btn px-2.5 text-xs font-semibold [&_svg]:size-3', tones[tone], className)}
      {...props}
    />
  );
}

const countTones = {
  accent: 'bg-accent-tag text-accent-tag-ink',
  quiet: 'bg-tag text-tag-ink',
  cool: 'bg-cool-tag text-cool-tag-ink',
} as const;

export function Count({ tone = 'accent', className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof countTones }) {
  return (
    <span
      className={cn('inline-grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-btn px-[5px] text-[11px] font-semibold tabular-nums leading-none', countTones[tone], className)}
      {...props}
    />
  );
}
