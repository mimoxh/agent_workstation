import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Empty } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

export interface LiveStream {
  id: string;
  label: string;
  startedAt: string;
  text: string;
  done: boolean;
  exitCode: number | null;
}

const CAP = 200 * 1024;

// 订阅 /api/live/:channel：先合入快照，再逐条拼 start / chunk / end
export function useLiveOutput(channel: string | null): LiveStream[] {
  const [streams, setStreams] = useState<LiveStream[]>([]);
  useEffect(() => {
    if (!channel) return;
    setStreams([]);
    const es = new EventSource(`/api/live/${channel}`);
    const data = (e: MessageEvent) => JSON.parse(e.data as string) as Record<string, unknown>;
    const patch = (id: string, fn: (s: LiveStream) => LiveStream) =>
      setStreams((ss) => ss.map((s) => (s.id === id ? fn(s) : s)));
    es.addEventListener('snapshot', (e) => {
      const p = data(e);
      setStreams((p.streams as LiveStream[]) ?? []);
    });
    es.addEventListener('start', (e) => {
      const s = data(e) as unknown as LiveStream;
      setStreams((ss) => (ss.some((x) => x.id === s.id) ? ss : [...ss.slice(-4), s]));
    });
    es.addEventListener('chunk', (e) => {
      const p = data(e);
      patch(String(p.streamId), (s) => ({ ...s, text: (s.text + String(p.chunk ?? '')).slice(-CAP) }));
    });
    es.addEventListener('end', (e) => {
      const p = data(e);
      patch(String(p.streamId), (s) => ({ ...s, done: true, exitCode: p.exitCode as number | null }));
    });
    return () => es.close();
  }, [channel]);
  return streams;
}

function StreamBlock({ s, open }: { s: LiveStream; open: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [s.text]);
  const header = (
    <div className="flex items-center gap-2">
      <Icon name="terminal" className="size-3.5 text-muted" />
      <span className="measured min-w-0 flex-1 truncate text-xs font-medium text-ink">{s.label}</span>
      {!s.done ? (
        <Badge tone="cool"><span aria-hidden className="size-1.5 animate-pulse-soft rounded-full bg-current" />运行中</Badge>
      ) : (
        <Badge tone={s.exitCode === 0 ? 'ok' : 'bad'}>退出码 {s.exitCode ?? '—'}</Badge>
      )}
    </div>
  );
  const body = (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className={cn('max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-ctl bg-code px-3.5 py-3 font-mono text-xs leading-[1.65]', s.text ? 'text-code-ink' : 'text-code-dim')}
      data-testid="live-stream-text"
    >
      {s.text || '（暂无输出）'}
    </pre>
  );
  if (!open) {
    return (
      <details className="group rounded-card bg-paper-2 px-3.5 py-2.5" data-testid="live-stream">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-ctl [&::-webkit-details-marker]:hidden">
          <Icon name="chev" className="size-3.5 -rotate-90 text-muted transition-transform duration-150 group-open:rotate-0" />
          <div className="min-w-0 flex-1">{header}</div>
        </summary>
        <div className="mt-2.5">{body}</div>
      </details>
    );
  }
  return (
    <div className="grid gap-2.5 rounded-card bg-paper-2 px-3.5 py-3" data-testid="live-stream">
      {header}
      {body}
    </div>
  );
}

export function StreamBlocks({ streams }: { streams: LiveStream[] }) {
  if (streams.length === 0) {
    return (
      <div data-testid="live-empty">
        <Empty title="这个任务还没有跑过命令" icon="terminal" />
      </div>
    );
  }
  const last = streams[streams.length - 1];
  return (
    <div className="flex flex-col gap-3" data-testid="live-output">
      {streams.map((s) => (
        <StreamBlock key={s.id} s={s} open={!s.done || s.id === last?.id} />
      ))}
    </div>
  );
}

export function LiveOutput({ channel }: { channel: string }) {
  return <StreamBlocks streams={useLiveOutput(channel)} />;
}
