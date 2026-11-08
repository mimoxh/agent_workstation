import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { parseFrameEvent, type CanvasMode, type FrameEvent, type Pin } from './model';

export type Device = 'fit' | 'desktop' | 'tablet' | 'mobile';

export const DEVICES: { id: Device; label: string; width: number | null }[] = [
  { id: 'fit', label: '自适应', width: null },
  { id: 'desktop', label: '桌面', width: 1280 },
  { id: 'tablet', label: '平板', width: 820 },
  { id: 'mobile', label: '手机', width: 390 },
];

const STAGE_GAP = 32;

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ob = new ResizeObserver(([e]) => e && setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    ob.observe(el);
    return () => ob.disconnect();
  }, []);
  return [ref, size] as const;
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const NO_PINS: Pin[] = [];
const NO_VARS: Record<string, string> = {};

// sandbox 不给 allow-same-origin：稿子拿不到平台的 cookie、接口和页面
export function DesignFrame({ doc, title, device, mode = 'view', pins = NO_PINS, vars = NO_VARS, onEvent, caption, testId }: { doc: string; title: string; device: Device; mode?: CanvasMode; pins?: Pin[]; vars?: Record<string, string>; onEvent?: (e: FrameEvent) => void; caption?: ReactNode; testId?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [stage, size] = useSize<HTMLDivElement>();
  const [loaded, setLoaded] = useState(0);
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const parsed = parseFrameEvent(e.data);
      if (parsed) handler.current?.(parsed);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);

  useEffect(() => {
    if (loaded === 0) return;
    frame.current?.contentWindow?.postMessage({
      aw: 'design', type: 'state', mode, pins, vars,
      colors: { '--aw-hover': cssVar('--color-cool'), '--aw-pin': cssVar('--color-accent'), '--aw-pin-ink': cssVar('--color-accent-ink') },
    }, '*');
  }, [loaded, mode, pins, vars]);

  const width = DEVICES.find((d) => d.id === device)?.width ?? null;
  const availW = Math.max(0, size.width - STAGE_GAP);
  const availH = Math.max(0, size.height - STAGE_GAP);
  const scale = width ? Math.min(1, availW / width) : 1;
  const frameW = width ?? availW;
  const frameH = scale > 0 ? availH / scale : availH;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {caption && <p className="shrink-0 border-b border-rule px-3 py-1 text-xs text-muted">{caption}</p>}
      <div ref={stage} className="min-h-0 flex-1 overflow-hidden bg-paper-3">
        <div className="mx-auto mt-4 overflow-hidden rounded-card bg-paper shadow-[var(--shadow-card)]" style={{ width: frameW * scale, height: frameH * scale }}>
          <iframe
            ref={frame}
            title={title}
            sandbox="allow-scripts"
            srcDoc={doc}
            onLoad={() => setLoaded((n) => n + 1)}
            data-testid={testId}
            className={cn('block origin-top-left border-0 bg-paper')}
            style={{ width: frameW, height: frameH, transform: scale === 1 ? undefined : `scale(${scale})` }}
          />
        </div>
      </div>
    </div>
  );
}

const THUMB_WIDTH = 1280;

export function DesignThumb({ doc, title }: { doc: string; title: string }) {
  const [box, size] = useSize<HTMLDivElement>();
  const scale = size.width / THUMB_WIDTH;
  return (
    <div ref={box} className="aspect-[16/10] overflow-hidden bg-paper">
      {size.width > 0 && (
        <iframe title={`${title} 缩略图`} sandbox="allow-scripts" srcDoc={doc} loading="lazy" tabIndex={-1} className="pointer-events-none origin-top-left border-0" style={{ width: THUMB_WIDTH, height: size.height / scale, transform: `scale(${scale})` }} />
      )}
    </div>
  );
}
