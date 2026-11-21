import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

// 页面：居中内容列（1200px）；表单、长文用 narrow 收窄，看板、表格这类宽内容用 wide 撑满
export function Page({ wide, narrow, className, testId, children }: { wide?: boolean; narrow?: boolean; className?: string; testId?: string; children: ReactNode }) {
  return (
    <div className={cn('animate-fade px-8 pb-14 pt-7 max-md:px-4 max-md:pb-10 max-md:pt-5', className)} data-testid={testId}>
      <div className={cn('mx-auto w-full', wide ? 'max-w-none' : narrow ? 'max-w-[54rem]' : 'max-w-[75rem]')}>{children}</div>
    </div>
  );
}

export function PageIcon({ icon, children }: { icon?: IconName; children?: ReactNode }) {
  return (
    <div aria-hidden className="grid size-10 shrink-0 place-items-center rounded-ctl bg-paper-2 text-sm font-bold text-ink-2">
      {icon ? <Icon name={icon} className="size-5" /> : children}
    </div>
  );
}

// 页面头：标题、说明、右侧动作；children 放属性行
export function PageHeader({ icon, mark, title, desc, actions, compact, children }: { icon?: IconName; mark?: ReactNode; title: ReactNode; desc?: ReactNode; actions?: ReactNode; compact?: boolean; children?: ReactNode }) {
  return (
    <header className={cn('mb-6', compact && 'mb-4')}>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-[1_1_320px] items-center gap-3">
          {(icon || mark) && <PageIcon {...(icon ? { icon } : {})}>{mark}</PageIcon>}
          <div className="grid min-w-0 gap-1.5">
            <h1 className="break-words text-h2 font-bold tracking-[-0.01em] text-ink">{title}</h1>
            {desc && <p className="max-w-[72ch] text-sm text-muted">{desc}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function SectionTitle({ children, aside, className }: { children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-3.5 mt-8 flex flex-wrap items-center justify-between gap-x-3 gap-y-2', className)}>
      <h2 className="text-title font-bold text-ink">{children}</h2>
      {aside}
    </div>
  );
}

// 属性行：左边灰色键，右边值
export function Prop({ icon, label, children, testId }: { icon: IconName; label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="grid min-h-9 grid-cols-[8.5rem_minmax(0,1fr)] items-center gap-2 max-md:grid-cols-[6rem_minmax(0,1fr)]" data-testid={testId}>
      <span className="flex items-center gap-2 text-sm text-muted"><Icon name={icon} className="size-[15px]" />{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 py-1 text-sm text-ink">{children}</div>
    </div>
  );
}

export function Callout({ icon = 'info', tone, children, className, testId }: { icon?: IconName; tone?: 'amber' | 'cool' | 'ok' | 'bad'; children: ReactNode; className?: string; testId?: string }) {
  const bg = { amber: 'bg-accent-soft', cool: 'bg-cool-soft', ok: 'bg-ok-soft', bad: 'bg-bad-soft' }[tone ?? 'amber'];
  const fg = { amber: 'text-accent', cool: 'text-cool', ok: 'text-ok', bad: 'text-bad' }[tone ?? 'amber'];
  return (
    <div className={cn('grid grid-cols-[1rem_minmax(0,1fr)] gap-2.5 rounded-ctl px-3.5 py-2.5 text-sm text-ink-2', tone ? bg : 'bg-paper-2', className)} data-testid={testId}>
      <Icon name={icon} className={cn('mt-0.5', tone ? fg : 'text-muted')} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
