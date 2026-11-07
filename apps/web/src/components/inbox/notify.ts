import { useEffect, useRef } from 'react';
import type { InboxRow } from '@/lib/queries';

export const notifySupported = () => typeof Notification !== 'undefined';
export const notifyPermission = () => (notifySupported() ? Notification.permission : 'denied');
export const requestNotify = () => Notification.requestPermission();

// 只在页面不在前台时提醒：人正看着就不用打断
export function useInboxNotify(items: InboxRow[] | undefined) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!items) return;
    const known = seen.current;
    seen.current = new Set(items.map((i) => i.id));
    if (!known || notifyPermission() !== 'granted' || !document.hidden) return;
    const fresh = items.filter((i) => !known.has(i.id) && i.severity !== 'normal');
    if (fresh.length > 0) new Notification('Agent Workstation', { body: `${fresh.length} 条待处理：${fresh[0]!.taskTitle ?? fresh[0]!.detail ?? ''}` });
  }, [items]);
}
