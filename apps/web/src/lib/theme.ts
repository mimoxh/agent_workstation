import { useSyncExternalStore } from 'react';

// 主题：跟随系统 / 浅 / 深。html[data-mode] 只会是 light 或 dark，index.html 在首帧前写一次，这里接管之后的切换
export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'aw.theme';
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const subs = new Set<() => void>();

const read = (): ThemePref => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
};

let pref = read();

const apply = () => {
  const dark = pref === 'dark' || (pref === 'system' && !!media?.matches);
  document.documentElement.dataset.mode = dark ? 'dark' : 'light';
};

media?.addEventListener('change', () => {
  if (pref === 'system') apply();
});

export function setTheme(next: ThemePref) {
  pref = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    /* 存储不可用时只影响本次会话 */
  }
  apply();
  for (const s of subs) s();
}

export function useTheme(): ThemePref {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => pref,
  );
}
