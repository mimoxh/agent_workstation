import { createFileRoute, Outlet } from '@tanstack/react-router';
import { ConsoleShell } from '@/components/layout/Shell';

// 控制台：打开应用的默认主界面，看全部项目
export const Route = createFileRoute('/_console')({
  component: () => (
    <ConsoleShell>
      <Outlet />
    </ConsoleShell>
  ),
});
