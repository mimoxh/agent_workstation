import { createRootRoute, Link, Outlet } from '@tanstack/react-router';
import { buttonClass } from '@/components/ui/button';
import { Empty, Toaster } from '@/components/ui/feedback';
import { useLiveSync } from '@/lib/live';

function Root() {
  useLiveSync();
  return (
    <>
      <Outlet />
      <Toaster />
    </>
  );
}

export const Route = createRootRoute({
  component: Root,
  notFoundComponent: () => (
    <Empty title="页面不存在" icon="alert" className="h-dvh">
      <Link to="/" className={buttonClass('default', 'sm', 'mt-2')}>回到项目列表</Link>
    </Empty>
  ),
});
