import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';

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
      <span className="measured min-w-0 flex-1 truncate text-xs text-ink-2">{s.label}</span>
      {!s.done ? (
        <Badge tone="cool" className="animate-pulse-soft">运行中</Badge>
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
      className="measured max-h-80 overflow-auto whitespace-pre-wrap break-all px-3 pb-3 text-xs leading-relaxed text-ink-2"
      data-testid="live-stream-text"
    >
      {s.text || '（暂无输出）'}
    </pre>
  );
  if (!open) {
    return (
      <details className="rounded-chip bg-paper-2 px-3 py-2" data-testid="live-stream">
        <summary className="cursor-pointer">{header}</summary>
        {body}
      </details>
    );
  }
  return (
    <div className="rounded-chip bg-paper-2 px-3 py-2" data-testid="live-stream">
      {header}
      {body}
    </div>
  );
}

export function StreamBlocks({ streams }: { streams: LiveStream[] }) {
  if (streams.length === 0) return <p className="px-1 py-6 text-center text-sm text-muted" data-testid="live-empty">这个任务还没有跑过命令</p>;
  const last = streams[streams.length - 1];
  return (
    <div className="flex flex-col gap-2" data-testid="live-output">
      {streams.map((s) => (
        <StreamBlock key={s.id} s={s} open={!s.done || s.id === last?.id} />
      ))}
    </div>
  );
}

export function LiveOutput({ channel }: { channel: string }) {
  return <StreamBlocks streams={useLiveOutput(channel)} />;
}
