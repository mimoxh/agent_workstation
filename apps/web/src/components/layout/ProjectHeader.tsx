import type { ReactNode } from 'react';
import type { IconName } from '@/components/ui/icons';
import { Page, PageHeader } from './Page';

// 控制台下的全局页（模板、插件、设置）：外壳由 _console 布局提供
export function GlobalPage({ title, icon, desc, testId, children }: { title: string; icon: IconName; desc?: string; testId: string; children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid={testId}>
      <Page>
        <PageHeader icon={icon} title={title} {...(desc ? { desc } : {})} />
        <div className="mt-6 space-y-6">{children}</div>
      </Page>
    </div>
  );
}
