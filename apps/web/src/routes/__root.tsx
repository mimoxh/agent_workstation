import { createRootRoute, Link, Outlet } from '@tanstack/react-router';
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
    <Empty title="页面不存在" className="h-dvh">
      <Link to="/" className="text-cool hover:underline">回到项目列表</Link>
    </Empty>
  ),
});
