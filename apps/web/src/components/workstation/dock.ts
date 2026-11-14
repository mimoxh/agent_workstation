import { useSyncExternalStore } from 'react';

// 右侧栏打开的板块（panelId）：跨页面、跨工作台保持，刷新后记住
const KEY = 'aw.dock';
const listeners = new Set<() => void>();

const read = () => {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
};

let current = read();

export function setDock(panelId: string | null) {
  current = panelId;
  try {
    if (panelId) localStorage.setItem(KEY, panelId);
    else localStorage.removeItem(KEY);
  } catch {
    /* 存储不可用时只影响本次会话 */
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useDock = () => useSyncExternalStore(subscribe, () => current);
