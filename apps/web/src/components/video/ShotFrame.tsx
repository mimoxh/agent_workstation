import { clockCommand, markCommand, parsePlayerEvent, pickCommand, type PlayerEvent } from '@aw/domain';
import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { cn } from '@/lib/utils';

export interface ShotFrameHandle {
  seek: (t: number) => void;
  play: (t?: number) => void;
  pause: (t?: number) => void;
  pick: (on: boolean) => void;
  mark: (selector: string | null) => void;
}

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
const overlayColors = () => ({ hover: cssVar('--color-cool'), mark: cssVar('--color-accent') });

// 画布固定为成片分辨率，整体按容器等比缩放：叠在里面的多层画面和字幕都用成片像素坐标
export function ShotCanvas({ width, height, className, children }: { width: number; height: number; className?: string | undefined; children: ReactNode }) {
  const [box, size] = useSize<HTMLDivElement>();
  const scale = size.width > 0 && size.height > 0 ? Math.min(size.width / width, size.height / height) : 0;
  return (
    <div ref={box} className={cn('grid min-h-0 min-w-0 place-items-center overflow-hidden', className)}>
      <div className="relative overflow-hidden bg-ink" style={{ width: width * scale, height: height * scale }}>
        <div className="absolute left-0 top-0 origin-top-left" style={{ width, height, transform: `scale(${scale})`, visibility: scale > 0 ? 'visible' : 'hidden' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// 镜头画面是模型写的代码：sandbox 只给 allow-scripts，不给 allow-same-origin；消息只认 parsePlayerEvent 过得了的
export function ShotLayer({ doc, title, onEvent, testId, interactive, style, ref }: { doc: string; title: string; onEvent?: ((e: PlayerEvent) => void) | undefined; testId?: string | undefined; interactive?: boolean | undefined; style?: CSSProperties | undefined; ref?: Ref<ShotFrameHandle> | undefined }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const parsed = parsePlayerEvent(e.data);
      if (parsed) handler.current?.(parsed);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);

  useImperativeHandle(ref, () => {
    const post = (m: unknown) => frame.current?.contentWindow?.postMessage(m, '*');
    return {
      seek: (t) => post(clockCommand('seek', t)),
      play: (t) => post(clockCommand('play', t)),
      pause: (t) => post(clockCommand('pause', t)),
      pick: (on) => post(pickCommand(on, overlayColors())),
      mark: (selector) => post(markCommand(selector, overlayColors())),
    };
  }, []);

  return (
    <iframe
      ref={frame}
      title={title}
      sandbox="allow-scripts"
      srcDoc={doc}
      tabIndex={-1}
      data-testid={testId}
      className={cn('absolute inset-0 block size-full border-0', !interactive && 'pointer-events-none')}
      style={style}
    />
  );
}

export function ShotFrame({ doc, width, height, title, onEvent, className, testId, ref, children }: { doc: string; width: number; height: number; title: string; onEvent?: (e: PlayerEvent) => void; className?: string; testId?: string; ref?: Ref<ShotFrameHandle>; children?: ReactNode }) {
  return (
    <ShotCanvas width={width} height={height} className={className}>
      <ShotLayer ref={ref} doc={doc} title={title} onEvent={onEvent} testId={testId} />
      {children}
    </ShotCanvas>
  );
}
