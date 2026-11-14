import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { cn } from '@/lib/utils';

export interface ResizeOpts { min: number; max: number; initial: number }

const DEFAULTS: ResizeOpts = { min: 280, max: 720, initial: 352 };

export interface ResizeHandleProps {
  width: number;
  min: number;
  max: number;
  onPointerDown: (e: RPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: RPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: RPointerEvent<HTMLElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
  dragging: boolean;
}

// 画廊和画布共用的侧栏宽度：同一个 localStorage key，两处拖任一边缘都改同一宽度
export function useResizableWidth(key: string, opts: Partial<ResizeOpts> = {}): [number, ResizeHandleProps] {
  const { min, max, initial } = { ...DEFAULTS, ...opts };
  const clamp = useCallback(
    (v: number) => Math.min(Math.max(min, v), max, typeof window === 'undefined' ? max : window.innerWidth * 0.6),
    [min, max],
  );
  const [width, setWidth] = useState(() => {
    const s = Number(localStorage.getItem(key));
    return Number.isFinite(s) && s > 0 ? clamp(s) : clamp(initial);
  });
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, w: 0 });

  const apply = useCallback(
    (v: number) => {
      const c = Math.round(clamp(v));
      setWidth(c);
      localStorage.setItem(key, String(c));
    },
    [clamp, key],
  );

  useEffect(() => {
    if (!dragging) return;
    const prev = document.documentElement.style.userSelect;
    document.documentElement.style.userSelect = 'none';
    return () => {
      document.documentElement.style.userSelect = prev;
    };
  }, [dragging]);

  return [
    width,
    {
      width, min, max, dragging,
      onPointerDown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width };
        setDragging(true);
      },
      onPointerMove: (e) => {
        if (dragging) apply(start.current.w + (e.clientX - start.current.x));
      },
      onPointerUp: (e) => {
        setDragging(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      },
      onKeyDown: (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          apply(width + (e.key === 'ArrowRight' ? 16 : -16));
        }
      },
      onDoubleClick: () => apply(initial),
    },
  ];
}

// 侧栏内缘的拖拽柄：pointer capture 让它不受设计稿 iframe 影响；拖动时盖一层透明罩双保险
export function ResizeHandle({ width, min, max, dragging, onPointerDown, onPointerMove, onPointerUp, onKeyDown, onDoubleClick }: ResizeHandleProps) {
  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        data-testid="design-chat-resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
        className={cn(
          'absolute -right-1 top-0 z-30 h-full w-2 cursor-col-resize touch-none',
          'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors',
          'hover:after:bg-[var(--color-rule-2)] focus-visible:after:bg-[var(--color-cool)]',
          dragging && 'after:bg-[var(--color-cool)]',
        )}
      />
      {dragging && <div className="fixed inset-0 z-40 cursor-col-resize" aria-hidden />}
    </>
  );
}
