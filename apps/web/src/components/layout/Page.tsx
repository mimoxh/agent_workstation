import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

// 文档页：居中正文列；看板、表格这类宽内容用 wide 撑满
export function Page({ wide, className, testId, children }: { wide?: boolean; className?: string; testId?: string; children: ReactNode }) {
  return (
    <div className={cn('animate-fade px-5 pb-16 md:px-10 lg:px-14', className)} data-testid={testId}>
      <div className={cn('mx-auto w-full', wide ? 'max-w-none' : 'max-w-[54rem]')}>{children}</div>
    </div>
  );
}

export function PageIcon({ icon, children }: { icon?: IconName; children?: ReactNode }) {
  return (
    <div aria-hidden className="grid size-12 place-items-center rounded-card border border-rule bg-paper-2 text-base font-semibold text-muted">
      {icon ? <Icon name={icon} className="size-6 stroke-[1.5]" /> : children}
    </div>
  );
}

// 页面头：图标、大标题、说明、右侧动作；children 放属性行
export function PageHeader({ icon, mark, title, desc, actions, compact, children }: { icon?: IconName; mark?: ReactNode; title: ReactNode; desc?: ReactNode; actions?: ReactNode; compact?: boolean; children?: ReactNode }) {
  return (
    <header className={compact ? 'pt-6' : 'pt-10'}>
      {!compact && (icon || mark) && <PageIcon {...(icon ? { icon } : {})}>{mark}</PageIcon>}
      <div className={cn('flex flex-wrap items-end gap-x-3 gap-y-2', !compact && 'mt-3')}>
        {compact && icon && <Icon name={icon} className="mb-1.5 size-6 text-muted" />}
        <div className="min-w-0 flex-1">
          <h1 className={cn('break-words font-bold tracking-tight text-ink', compact ? 'text-[1.75rem] leading-tight' : 'text-page')}>{title}</h1>
          {desc && <p className="mt-1 text-sm text-muted">{desc}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-1.5 pb-1">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function SectionTitle({ children, aside, className }: { children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-1.5 mt-8 flex items-baseline justify-between gap-3', className)}>
      <h2 className="text-h2 font-semibold text-ink">{children}</h2>
      {aside}
    </div>
  );
}

// 属性行：左边灰色键，右边值
export function Prop({ icon, label, children, testId }: { icon: IconName; label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="grid min-h-8 grid-cols-[8.5rem_minmax(0,1fr)] items-center gap-2 max-md:grid-cols-[6rem_minmax(0,1fr)]" data-testid={testId}>
      <span className="flex items-center gap-2 text-sm text-muted"><Icon name={icon} className="size-[15px]" />{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-1.5 py-1 text-sm text-ink">{children}</div>
    </div>
  );
}

export function Callout({ icon = 'doc', tone, children, className, testId }: { icon?: IconName; tone?: 'amber' | 'cool' | 'ok' | 'bad'; children: ReactNode; className?: string; testId?: string }) {
  const bg = { amber: 'bg-accent-soft', cool: 'bg-cool-soft', ok: 'bg-ok-soft', bad: 'bg-bad-soft' }[tone ?? 'amber'];
  const fg = { amber: 'text-accent', cool: 'text-cool', ok: 'text-ok', bad: 'text-bad' }[tone ?? 'amber'];
  return (
    <div className={cn('grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2.5 rounded-chip px-4 py-3 text-sm text-ink-2', tone ? bg : 'bg-paper-2', className)} data-testid={testId}>
      <Icon name={icon} className={cn('mt-0.5 size-[18px]', tone ? fg : 'text-muted')} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
